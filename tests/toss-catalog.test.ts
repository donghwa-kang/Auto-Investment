import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyTossListing,
  parseTossListing,
  tossCatalogMarkets,
} from "../src/core/toss-catalog.js";
import { classifyCatalog, classifyCatalogFacts } from "../src/core/catalog.js";
import { hash } from "../src/core/policy.js";
import {
  TossCatalogClient,
  CATALOG_RESPONSE_LIMIT,
  CATALOG_REQUEST_INTERVAL_MS,
} from "../src/server/toss-catalog-client.js";
import {
  assertCatalogFetchAllowed,
  writeTossCatalogReport,
} from "../src/server/catalog-fetch.js";

const fakeSecret = "FAKE_SECRET_TEST_ONLY_123456";
const credentials = {
  clientId: "FAKE_CLIENT_123456",
  clientSecret: fakeSecret,
};
const token = {
  access_token: "FAKE_TOKEN_TEST_ONLY",
  token_type: "Bearer",
  expires_in: 3600,
};
const stock = {
  symbol: "SAMPLE",
  name: "시험 종목",
  securityType: "STOCK",
  isCommonShare: true,
  isinCode: "US0000000002",
};
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
function harness(
  responder: (url: URL, n: number) => Response | Promise<Response> = () =>
    json({ result: [stock] }),
  auth: Response = json(token),
) {
  let time = Date.parse("2026-09-12T00:00:00.000Z");
  const calls: { url: URL; init: RequestInit; time: number }[] = [];
  const waits: number[] = [];
  const client = new TossCatalogClient({
    now: () => time,
    monotonic: () => time,
    sleep: async (ms) => {
      waits.push(ms);
      time += ms;
    },
    transport: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init: init!, time });
      return url.pathname === "/oauth2/token"
        ? auth
        : responder(url, calls.length - 1);
    },
  });
  return { client, calls, waits };
}

test("TCAT-01 7개 시장·상품 매핑 및 누락 사실/원천 시점 확인 대기", () => {
  for (const market of tossCatalogMarkets) {
    const result = classifyTossListing({ result: [stock] }, market);
    const item = result.items[0]!;
    assert.equal(
      item.facts.market,
      ["KOSPI", "KOSDAQ", "KR_ETC"].includes(market) ? "KR" : "US",
    );
    assert.equal(item.facts.venue, null);
    assert.equal(item.facts.currency, "UNKNOWN");
    assert.equal(item.facts.listingStatus, "UNKNOWN");
    assert.equal(item.facts.leveraged, null);
    assert.equal(item.status, "REVIEW_REQUIRED");
    assert.ok(item.reasons.includes("SOURCE_TIME_UNKNOWN"));
    assert.ok(!item.reasons.includes("USER_EXCLUDED_SINGLE_STOCK_LEVERAGE"));
  }
  for (const symbol of ["SOXL", "SOXX"])
    assert.equal(
      classifyTossListing(
        { result: [{ ...stock, symbol, securityType: "ETF" }] },
        "AMEX",
      ).items[0]!.facts.kind,
      "ETF",
    );
});

test("TCAT-02 소스 종류를 유지하고 미정 상품을 임의로 주식에 편입하지 않음", () => {
  for (const [securityType, kind] of [
    ["FOREIGN_STOCK", "STOCK"],
    ["FOREIGN_ETF", "ETF"],
    ["ETN", "OTHER"],
    ["STOCK_WARRANTS", "OTHER"],
    ["REIT", "UNKNOWN"],
    ["DEPOSITARY_RECEIPT", "UNKNOWN"],
    ["INFRASTRUCTURE_FUND", "UNKNOWN"],
    ["NEW_PRODUCT", "UNKNOWN"],
  ]) {
    const item = classifyTossListing(
      { result: [{ ...stock, securityType }] },
      "NYSE",
    ).items[0]!;
    assert.equal(item.facts.kind, kind);
    assert.equal(item.record!.securityType, securityType);
    assert.equal(item.status, "REVIEW_REQUIRED");
  }
});

test("TCAT-03 잘못된 행 격리·원문 비노출·확장 필드 제거", () => {
  const result = parseTossListing({
    result: [
      { ...stock, extra: fakeSecret },
      { ...stock, isinCode: null },
      { ...stock, symbol: "../../orders" },
      { ...stock, isCommonShare: "true" },
      { ...stock, isinCode: "" },
      { ...stock, name: "bad\ntext" },
      fakeSecret,
    ],
    ignored: fakeSecret,
  });
  assert.equal(result.inputRecords, 7);
  assert.equal(result.records.length, 1);
  assert.deepEqual(
    result.quarantined.map((v) => v.index),
    [1, 2, 3, 4, 5, 6],
  );
  assert.ok(!JSON.stringify(result).includes(fakeSecret));
  assert.throws(
    () => parseTossListing({ error: fakeSecret }),
    /ENVELOPE_INVALID/,
  );
  assert.throws(
    () => parseTossListing({ result: Array(50001).fill(stock) }),
    /ENVELOPE_INVALID/,
  );
});

test("TCAT-04 중복·정규화·순서 독립·동일 ID 충돌과 심볼 충돌", () => {
  const input = {
    result: [
      stock,
      { ...stock, symbol: " sample " },
      { ...stock, name: "정정 충돌", symbol: "CHANGED" },
      { ...stock, isinCode: "US0000000010" },
    ],
  };
  const result = classifyTossListing(input, "NASDAQ");
  assert.equal(result.duplicates, 1);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]!.record, null);
  assert.ok(result.items[0]!.reasons.includes("RECORD_CONFLICT"));
  assert.ok(result.items.every((v) => v.reasons.includes("SYMBOL_COLLISION")));
  assert.equal(
    result.classificationHash,
    classifyTossListing({ result: [...input.result].reverse() }, "NASDAQ")
      .classificationHash,
  );
  assert.notEqual(
    classifyTossListing({ result: [stock] }, "NASDAQ").items[0]!.key,
    classifyTossListing({ result: [stock] }, "NYSE").items[0]!.key,
  );
});

test("TCAT-05 기존 오프라인 판단 해시·단일종목 레버리지 제외 계약 유지", () => {
  const input = JSON.parse(readFileSync("fixtures/catalog-v1.json", "utf8"));
  assert.equal(
    classifyCatalog(input).decisionHash,
    "3abf3c482207154a588c380f1e46e6842b37562aa91c13e3e1950125a650c256",
  );
  const facts = {
    market: "US",
    venue: "TEST",
    currency: "USD",
    kind: "ETF",
    underlying: "SINGLE_STOCK",
    leveraged: true,
    requiredDepositKrw: 30000000,
    listingStatus: "LISTED",
    brokerSupported: true,
  } as const;
  assert.equal(classifyCatalogFacts(facts).status, "EXCLUDED");
  assert.equal(
    classifyCatalogFacts({ ...facts, underlying: "INDEX" }).status,
    "REVIEW_CANDIDATE",
  );
});

test("TCAT-06 고정 호스트/8회/조회 경로/인증 본문/토큰 비저장·1.1초 간격", async () => {
  const { client, calls, waits } = harness();
  const report = await client.collect(credentials);
  assert.equal(calls.length, 8);
  assert.equal(report.allScopesReceived, true);
  assert.equal(report.dataQualityComplete, true);
  assert.equal(report.counts.instruments, 7);
  assert.equal(report.counts.candidates, 0);
  assert.deepEqual(waits, Array(6).fill(CATALOG_REQUEST_INTERVAL_MS));
  assert.equal(calls[0]!.init.method, "POST");
  const authBody = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(authBody.get("client_secret"), fakeSecret);
  assert.equal(authBody.get("grant_type"), "client_credentials");
  for (const [index, call] of calls.entries()) {
    assert.equal(call.url.origin, "https://openapi.tossinvest.com");
    assert.equal(call.init.redirect, "error");
    assert.ok(call.init.signal instanceof AbortSignal);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.has("X-Tossinvest-Account"), false);
    if (index > 0) {
      assert.equal(call.init.method, "GET");
      assert.equal(call.init.body, undefined);
      assert.equal(call.url.pathname, "/api/v1/stocks/all");
      assert.deepEqual([...call.url.searchParams.keys()], ["market", "status"]);
      assert.equal(
        call.url.searchParams.get("market"),
        tossCatalogMarkets[index - 1],
      );
      assert.equal(call.url.searchParams.get("status"), "ACTIVE");
      assert.equal(
        headers.get("authorization"),
        `Bearer ${token.access_token}`,
      );
    }
  }
  for (const sensitive of [
    fakeSecret,
    token.access_token,
    credentials.clientId,
  ])
    assert.ok(!JSON.stringify(report).includes(sensitive));
  assert.equal(report.requests[0]!.responseHash, null);
  assert.equal(report.requests[1]!.responseHash?.length, 64);
  const { reportHash, ...body } = report;
  assert.equal(reportHash, hash(body));
  assert.equal(report.sourceUpdatedAt, null);
  assert.equal(report.historicalUniverseReady, false);
  assert.equal(report.ordersEnabled, false);
  assert.equal(report.metadataReady, false);
  assert.throws(() => classifyCatalog(report), /CATALOG_INPUT_INVALID/);
  await assert.rejects(client.collect(credentials), /ALREADY_USED/);
  assert.equal(calls.length, 8);
});

test("TCAT-07 빈 목록은 실패가 아니며 실패 이후 미조회와 구분", async () => {
  const { client, calls } = harness((_url, n) =>
    n === 1 ? json({ result: [] }) : json({ error: fakeSecret }, 503),
  );
  const report = await client.collect(credentials);
  assert.deepEqual(
    report.scopes.map((v) => v.status),
    ["RECEIVED_EMPTY", "FAILED", ...Array(5).fill("NOT_ATTEMPTED")],
  );
  assert.equal(report.allScopesReceived, false);
  assert.equal(report.dataQualityComplete, false);
  assert.equal(calls.length, 3);
  assert.equal(report.failure, "CATALOG_HTTP_503");
  assert.ok(!JSON.stringify(report).includes(fakeSecret));
});

test("TCAT-08 401/403/429/5xx/리디렉션 자동 재시도·재인증 없음", async () => {
  for (const status of [301, 401, 403, 429, 500]) {
    const { client, calls } = harness(() =>
      json({ error: fakeSecret }, status, {
        "Retry-After": "3",
        "X-RateLimit-Limit": "1",
        "X-Secret": fakeSecret,
      }),
    );
    const report = await client.collect(credentials);
    assert.equal(calls.length, 2);
    assert.equal(report.failure, `CATALOG_HTTP_${status}`);
    assert.equal(report.requests[1]!.retryAfter, 3);
    assert.equal(report.requests[1]!.rateLimit, 1);
    assert.ok(!JSON.stringify(report).includes(fakeSecret));
  }
});

test("TCAT-09 인증 실패/오류 토큰/네트워크 실패 원문 차단", async () => {
  for (const auth of [
    json({ error: fakeSecret }, 403),
    json({ ...token, token_type: "Other" }),
    json({ ...token, expires_in: 0 }),
    json({ ...token, access_token: "bad\r\nheader" }),
  ]) {
    const h = harness(undefined, auth);
    const report = await h.client.collect(credentials);
    assert.equal(h.calls.length, 1);
    assert.ok(report.scopes.every((v) => v.status === "NOT_ATTEMPTED"));
    assert.ok(!JSON.stringify(report).includes(fakeSecret));
  }
  const h = harness(() => {
    throw new Error(fakeSecret);
  });
  assert.equal(
    (await h.client.collect(credentials)).failure,
    "CATALOG_RESPONSE_OR_NETWORK_INVALID",
  );
});

test("TCAT-10 응답 유형/JSON/UTF8/봉투 오류와 크기 제한", async () => {
  const cases: [() => Response, string][] = [
    [() => new Response("<html>bad</html>"), "CATALOG_CONTENT_TYPE_INVALID"],
    [
      () =>
        new Response(fakeSecret, {
          headers: { "Content-Type": "application/json" },
        }),
      "CATALOG_RESPONSE_OR_NETWORK_INVALID",
    ],
    [
      () =>
        new Response(new Uint8Array([0xff]), {
          headers: { "Content-Type": "application/json" },
        }),
      "CATALOG_RESPONSE_OR_NETWORK_INVALID",
    ],
    [() => json({ wrong: [] }), "TOSS_CATALOG_ENVELOPE_INVALID"],
    [
      () =>
        json({}, 200, { "Content-Length": String(CATALOG_RESPONSE_LIMIT + 1) }),
      "CATALOG_RESPONSE_TOO_LARGE",
    ],
    [
      () =>
        new Response(" ".repeat(CATALOG_RESPONSE_LIMIT + 1), {
          headers: { "Content-Type": "application/json" },
        }),
      "CATALOG_RESPONSE_TOO_LARGE",
    ],
  ];
  for (const [response, code] of cases) {
    const h = harness(response);
    assert.equal((await h.client.collect(credentials)).failure, code);
    assert.equal(h.calls.length, 2);
  }
});

test("TCAT-11 단일 실행 잠금과 호출 대기 중 토큰 만료", async () => {
  const h = harness(undefined, json({ ...token, expires_in: 1 }));
  const first = h.client.collect(credentials);
  await assert.rejects(h.client.collect(credentials), /ALREADY_USED/);
  const report = await first;
  assert.equal(report.failure, "CATALOG_TOKEN_EXPIRED");
  assert.equal(h.calls.length, 2);
  assert.equal(report.scopes[0]!.status, "RECEIVED");
  assert.equal(report.scopes[1]!.status, "FAILED");
});

test("TCAT-12 수신 완결과 행 품질/메타데이터 준비를 분리", async () => {
  const h = harness(() =>
    json({
      result: [stock, { ...stock, name: "conflict" }, { name: fakeSecret }],
    }),
  );
  const report = await h.client.collect(credentials);
  assert.equal(report.allScopesReceived, true);
  assert.equal(report.dataQualityComplete, false);
  assert.equal(report.metadataReady, false);
  assert.equal(report.counts.quarantined, 7);
  assert.ok(report.scopes.every((s) => s.batch!.items[0]!.record === null));
  assert.ok(!JSON.stringify(report).includes(fakeSecret));
});

test("TCAT-13 실제 출력 함수 신규 파일/이전 출력 보존·별도 시험 폴더", async () => {
  const directory = mkdtempSync(join(tmpdir(), "toss-catalog-test-"));
  const report = await harness().client.collect(credentials);
  const path = writeTossCatalogReport(report, directory);
  const saved = readFileSync(path, "utf8");
  const next = writeTossCatalogReport(report, directory);
  assert.notEqual(path, next);
  assert.equal(readFileSync(path, "utf8"), saved);
  assert.deepEqual(readdirSync(join(directory, "data")), ["toss-catalogs"]);
  assert.equal(JSON.parse(saved).reportHash, report.reportHash);
  assert.ok(!saved.includes(fakeSecret));
});

test("TCAT-14 명시적 확인·실거래 거절·로컬 키 경로 시작 조건", () => {
  const valid = {
    TRADING_MODE: "PAPER",
    LIVE_ENABLED: "false",
    TOSS_CATALOG_READ_ONLY: "true",
    TOSS_CATALOG_TERMS_CONFIRMED: "true",
    TOSS_CREDENTIAL_FILE: "dummy.txt",
  };
  assert.doesNotThrow(() => assertCatalogFetchAllowed(valid));
  for (const extra of [
    { TRADING_MODE: "LIVE" },
    { LIVE_ENABLED: "true" },
    { TOSS_CATALOG_READ_ONLY: "false" },
    { TOSS_CATALOG_TERMS_CONFIRMED: undefined },
    { TOSS_CREDENTIAL_FILE: undefined },
    { TOSS_CREDENTIAL_FILE: "https://example.com/key" },
    { TOSS_CREDENTIAL_FILE: "\\\\host\\key" },
  ])
    assert.throws(
      () => assertCatalogFetchAllowed({ ...valid, ...extra }),
      /CATALOG_/,
    );
});

test(
  "TCAT-15 실제 15초 abort 신호로 타임아웃·재시도 금지",
  { timeout: 20000 },
  async () => {
    let calls = 0;
    const client = new TossCatalogClient({
      now: Date.now,
      monotonic: () => performance.now(),
      sleep: async () => {},
      transport: async (_url, init) => {
        calls++;
        return new Promise<Response>((_resolve, reject) => {
          const keepAlive = setTimeout(
            () => reject(new Error("TEST_TIMEOUT")),
            18000,
          );
          init!.signal!.addEventListener(
            "abort",
            () => {
              clearTimeout(keepAlive);
              reject(new Error(fakeSecret));
            },
            { once: true },
          );
        });
      },
    });
    const report = await client.collect(credentials);
    assert.equal(report.failure, "CATALOG_TIMEOUT");
    assert.equal(calls, 1);
  },
);

test("TCAT-16 7개 시장 모두 빈 수신은 0건으로 명시하고 거래 준비 금지", async () => {
  const report = await harness(() => json({ result: [] })).client.collect(
    credentials,
  );
  assert.ok(report.scopes.every((s) => s.status === "RECEIVED_EMPTY"));
  assert.equal(report.allScopesReceived, true);
  assert.equal(report.counts.instruments, 0);
  assert.equal(report.metadataReady, false);
});

test("TCAT-17 실행 전체 5만 행 상한과 이전 시장 결과 보존", async () => {
  const h = harness(() => json({ result: Array(8000).fill(stock) }));
  const report = await h.client.collect(credentials);
  assert.equal(report.failure, "CATALOG_TOTAL_RECORD_LIMIT");
  assert.equal(report.counts.inputRecords, 48000);
  assert.equal(report.scopes[5]!.status, "RECEIVED");
  assert.equal(report.scopes[6]!.status, "FAILED");
  assert.equal(h.calls.length, 8);
});

test("TCAT-18 로컬 시계 역전은 최신 수신으로 승인하지 않음", async () => {
  let now = Date.parse("2026-09-12T00:00:00.000Z");
  const client = new TossCatalogClient({
    now: () => now,
    monotonic: () => 0,
    sleep: async () => {},
    transport: async () => {
      now -= 1000;
      return json(token);
    },
  });
  assert.equal(
    (await client.collect(credentials)).failure,
    "CATALOG_CLOCK_REGRESSED",
  );
});

test("TCAT-19 인증 응답 상한·숫자가 아닌 rate 헤더 비저장", async () => {
  const h = harness(undefined, json(token, 200, { "Content-Length": "65537" }));
  assert.equal(
    (await h.client.collect(credentials)).failure,
    "CATALOG_RESPONSE_TOO_LARGE",
  );
  const report = await harness(() =>
    json({ result: [] }, 200, {
      "Retry-After": fakeSecret,
      "X-RateLimit-Limit": fakeSecret,
    }),
  ).client.collect(credentials);
  assert.ok(
    report.requests.every((r) => r.retryAfter === null && r.rateLimit === null),
  );
  assert.ok(!JSON.stringify(report).includes(fakeSecret));
});
