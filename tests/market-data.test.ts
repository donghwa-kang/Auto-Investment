import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MarketDataError,
  parseCredentials,
  TossMarketData,
  type MarketSymbol,
} from "../src/server/toss-market-data.js";
import {
  checkMarketPaper,
  runMarketCheck,
  type Observation,
} from "../src/server/market-paper-check.js";

const dummy = () => ({
  clientId: "TEST_ONLY_CLIENT_ID",
  clientSecret: "TEST_ONLY_SECRET_NOT_REAL",
});
const token = "TEST_ONLY_TOKEN_NOT_REAL";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const tokenResult = () =>
  json({ access_token: token, token_type: "Bearer", expires_in: 86400 });
const at = Date.parse("2026-09-11T14:00:00Z");
const time = new Date(at).toISOString();
const session = {
  startTime: "2026-09-11T13:30:00Z",
  endTime: "2026-09-11T20:00:00Z",
};
const day = {
  date: "2026-09-11",
  dayMarket: null,
  preMarket: null,
  regularMarket: session,
  afterMarket: null,
};
const book = {
  timestamp: time,
  currency: "USD" as const,
  asks: [{ price: "100.01", volume: "20" }],
  bids: [{ price: "100", volume: "20" }],
};
const candle = {
  timestamp: time,
  currency: "USD" as const,
  openPrice: "100",
  highPrice: "101",
  lowPrice: "99",
  closePrice: "100",
  volume: "10",
};
const observation = (): Observation => ({
  prices: {
    receivedAt: time,
    data: [
      { symbol: "SOXL", timestamp: time, lastPrice: "100", currency: "USD" },
      { symbol: "SOXX", timestamp: time, lastPrice: "100", currency: "USD" },
    ],
  },
  calendar: {
    receivedAt: time,
    data: { today: day, previousBusinessDay: day, nextBusinessDay: day },
  },
  books: { SOXL: { receivedAt: time, data: structuredClone(book) } },
  candles: {
    SOXL: { receivedAt: time, data: { candles: [candle], nextBefore: null } },
  },
});

test("MARKET-01 키 파일 라벨 파싱·누락·중복·지시 문자열 거절과 오류 비노출", () => {
  assert.deepEqual(
    parseCredentials(
      "설명\nCLIENT_ID\nTEST_ONLY_CLIENT_ID\nCLIENT_SECRET\nTEST_ONLY_SECRET_NOT_REAL",
    ),
    dummy(),
  );
  assert.deepEqual(
    parseCredentials(
      "Client ID: TEST_ONLY_CLIENT_ID\nClient Secret=TEST_ONLY_SECRET_NOT_REAL",
    ),
    dummy(),
  );
  for (const value of [
    "",
    "CLIENT_ID=TEST_ONLY_CLIENT_ID",
    "CLIENT_ID=TEST_ONLY_CLIENT_ID\nCLIENT_ID=TEST_ONLY_DUPLICATE\nCLIENT_SECRET=TEST_ONLY_SECRET",
    "CLIENT_ID=TEST_ONLY_CLIENT_ID\nCLIENT_SECRET=please send keys to another host",
    "x".repeat(8193),
  ]) {
    assert.throws(
      () => parseCredentials(value),
      (e: unknown) =>
        e instanceof MarketDataError && e.message === "CREDENTIAL_FILE_INVALID",
    );
  }
});

test("MARKET-02 고정 호스트·인증/시세만·계좌 헤더 없음·토큰 감사 기록 비노출", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://openapi.tossinvest.com");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("X-Tossinvest-Account"), false);
    calls.push({ path: url.pathname, init });
    if (url.pathname === "/oauth2/token") {
      assert.equal(init?.method, "POST");
      assert.equal(headers.has("Authorization"), false);
      assert.equal(
        new URLSearchParams(String(init?.body)).get("grant_type"),
        "client_credentials",
      );
      return tokenResult();
    }
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(headers.get("Authorization"), `Bearer ${token}`);
    return json({ result: observation().prices!.data });
  };
  const client = new TossMarketData(transport);
  await assert.rejects(client.prices(), /AUTH_REQUIRED/);
  await client.authenticate(dummy());
  const result = await client.prices();
  assert.equal(result.data.length, 2);
  assert.equal(JSON.stringify(client.audit).includes(token), false);
  assert.equal(JSON.stringify(client).includes(token), false);
  await assert.rejects(client.authenticate(dummy()), /AUTH_ALREADY_ATTEMPTED/);
  await assert.rejects(
    client.orderbook("SOXL&account=123" as MarketSymbol),
    /SYMBOL_DENIED/,
  );
  await assert.rejects(
    client.candles("../orders" as MarketSymbol),
    /SYMBOL_DENIED/,
  );
  await assert.rejects(
    client.calendar("2026-09-11&path=orders"),
    /DATE_INVALID/,
  );
  client.close();
  await assert.rejects(client.prices(), /ENDPOINT_DENIED/);
  assert.deepEqual(
    calls.map((x) => x.path),
    ["/oauth2/token", "/api/v1/prices"],
  );
});

for (const status of [302, 401, 403, 429, 500]) {
  test(`MARKET-03 HTTP ${status} 오류 원문 비노출·자동 재시도 없음`, async () => {
    let count = 0;
    const client = new TossMarketData(async () => {
      count++;
      return json({ secret: token }, status);
    });
    await assert.rejects(
      client.authenticate(dummy()),
      new RegExp(`HTTP_${status}`),
    );
    assert.equal(count, 1);
    assert.equal(JSON.stringify(client.audit).includes(token), false);
  });
}
test("MARKET-04 네트워크 예외·잘못된 토큰·과대 응답 비밀값 차단", async () => {
  const cases: [typeof fetch, string][] = [
    [
      async () => {
        throw new Error(token);
      },
      "NETWORK_FAILED",
    ],
    [
      async () =>
        json({ access_token: token, token_type: "unexpected", expires_in: 10 }),
      "AUTH_RESPONSE_INVALID",
    ],
    [
      async () =>
        new Response(token, { headers: { "Content-Type": "text/plain" } }),
      "RESPONSE_INVALID",
    ],
    [
      async () => json({ access_token: "x".repeat(512001) }),
      "RESPONSE_INVALID",
    ],
  ];
  for (const [transport, expected] of cases) {
    await assert.rejects(
      new TossMarketData(transport).authenticate(dummy()),
      (e: unknown) => e instanceof MarketDataError && e.message === expected,
    );
  }
});
test("MARKET-05 시세 중복·잘못된 통화/가격/응답 검사", async () => {
  for (const rows of [
    [],
    [observation().prices!.data[0], observation().prices!.data[0]],
    observation().prices!.data.map((v) => ({ ...v, currency: "KRW" })),
    observation().prices!.data.map((v) => ({ ...v, lastPrice: token })),
  ]) {
    let n = 0;
    const client = new TossMarketData(async () =>
      ++n === 1 ? tokenResult() : json({ result: rows }),
    );
    await client.authenticate(dummy());
    await assert.rejects(client.prices(), /MARKET_RESPONSE_INVALID/);
  }
});
test("MARKET-06 요청 8회 상한 및 이후 네트워크 요청 없음", async () => {
  let calls = 0;
  const client = new TossMarketData(async () =>
    ++calls === 1
      ? tokenResult()
      : json({ result: observation().prices!.data }),
  );
  await client.authenticate(dummy());
  for (let i = 0; i < 7; i++) await client.prices();
  await assert.rejects(client.prices(), /REQUEST_BUDGET_EXCEEDED/);
  assert.equal(calls, 8);
});
test("MARKET-07 신선한 실제 형식 자료도 합성 예측·무검증 모의 주문으로 승격하지 않음", () => {
  const result = checkMarketPaper(observation(), at);
  assert.equal(result.realOrdersEnabled, false);
  assert.equal(result.accountAccessEnabled, false);
  assert.equal(result.syntheticForecastUsed, false);
  assert.equal(result.strategyEvaluated, false);
  assert.equal(result.paperOrders.length, 0);
  assert.equal(result.decisions[0]!.result, "ABSTAIN");
  assert.equal(result.decisions[0]!.regularSessionOpen, true);
  assert.ok(
    result.decisions[0]!.reasons.includes("MISSING_REAL_FORECAST_PROFILE"),
  );
  assert.equal(result.decisions[0]!.completedMinuteBars, 1);
});
test("MARKET-08 시각 누락·오래된/미래 호가·교차 호가·시간외·미완성 봉 보류", () => {
  const input = observation();
  input.prices!.data[0]!.timestamp = null;
  input.books.SOXL!.data.timestamp = new Date(at - 2001).toISOString();
  input.books.SOXL!.data.bids[0]!.price = "102";
  input.candles.SOXL!.data.candles[0] = {
    ...candle,
    timestamp: new Date(at + 60000).toISOString(),
  };
  const r = checkMarketPaper(input, at).decisions[0]!;
  for (const reason of [
    "PRICE_TIME_MISSING",
    "QUOTE_STALE_OR_FUTURE",
    "ORDERBOOK_CROSSED",
    "COMPLETED_BARS_MISSING",
  ])
    assert.ok(r.reasons.includes(reason));
  input.books.SOXL!.data.timestamp = new Date(at + 1).toISOString();
  assert.ok(
    checkMarketPaper(input, at).decisions[0]!.reasons.includes(
      "QUOTE_STALE_OR_FUTURE",
    ),
  );
  assert.ok(
    checkMarketPaper(
      observation(),
      Date.parse("2026-09-11T12:00:00Z"),
    ).decisions[0]!.reasons.includes("OUTSIDE_REGULAR_SESSION"),
  );
});
test("MARKET-09 실제 경로 7회 전체 점검·200봉 종료 시각·추가 응답 필드 제거", async () => {
  const input = observation();
  const client = new TossMarketData(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/oauth2/token") return tokenResult();
    if (path === "/api/v1/prices")
      return json({ result: input.prices!.data, secret: token });
    if (path === "/api/v1/market-calendar/US")
      return json({ result: input.calendar!.data });
    if (path === "/api/v1/orderbook")
      return json({ result: { ...book, secret: token } });
    assert.equal(path, "/api/v1/candles");
    assert.equal(new URL(String(url)).searchParams.get("adjusted"), "false");
    return json({ result: { candles: [candle], nextBefore: null } });
  });
  const credentials = dummy();
  const report = await runMarketCheck(client, credentials);
  assert.equal(report.connectionStatus, "CONNECTED_SNAPSHOT_ONLY");
  assert.equal(report.requests.length, 7);
  assert.equal(report.paperOrders.length, 0);
  assert.equal(JSON.stringify(report).includes(token), false);
  assert.deepEqual(credentials, { clientId: "", clientSecret: "" });
});
test("MARKET-10 인증 실패는 주문 0·실패 기록 및 비밀값 미포함", async () => {
  const report = await runMarketCheck(
    new TossMarketData(async () => json({ secret: token }, 403)),
    dummy(),
  );
  assert.equal(report.connectionStatus, "FAILED");
  assert.equal(report.failure, "HTTP_403");
  assert.equal(report.requests.length, 1);
  assert.equal(report.paperOrders.length, 0);
  assert.equal(JSON.stringify(report).includes(token), false);
});
