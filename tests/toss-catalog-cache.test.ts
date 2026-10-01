import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../src/core/policy.js";
import { TossCatalogClient } from "../src/server/toss-catalog-client.js";
import {
  CATALOG_CACHE_MAX_BYTES,
  catalogCacheDay,
  collectDailyCatalog,
  readDailyCatalogCache,
} from "../src/server/toss-catalog-cache.js";

const stock = {
  symbol: "SAMPLE",
  name: "모형 ETF",
  securityType: "ETF",
  isCommonShare: true,
  isinCode: "US0000000002",
};
function setup(rows: unknown[] = [stock], failure = false) {
  const root = mkdtempSync(join(tmpdir(), "toss-cache-test-"));
  let clock = Date.parse("2026-09-12T01:00:00.000Z"),
    calls = 0;
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const collect = () =>
    new TossCatalogClient({
      now,
      monotonic: now,
      sleep,
      transport: async (input) => {
        calls++;
        clock += 10;
        const auth = new URL(String(input)).pathname === "/oauth2/token";
        return new Response(
          JSON.stringify(
            auth
              ? {
                  access_token: "FAKE_TOKEN_TEST_ONLY",
                  token_type: "Bearer",
                  expires_in: 3600,
                }
              : { result: rows },
          ),
          {
            status: !auth && failure ? 429 : 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    }).collect({
      clientId: "FAKE_CLIENT_123456",
      clientSecret: "FAKE_SECRET_123456",
    });
  return {
    root,
    now,
    sleep,
    collect,
    calls: () => calls,
    advance: (ms: number) => {
      clock += ms;
    },
    run: () => collectDailyCatalog(collect, root, now, sleep),
    statePath: join(root, "data", "toss-catalogs", "daily-state.json"),
  };
}
function resealState(
  path: string,
  change: (state: Record<string, unknown>) => void,
) {
  const state = JSON.parse(readFileSync(path, "utf8"));
  delete state.checksum;
  change(state);
  writeFileSync(path, JSON.stringify({ ...state, checksum: hash(state) }));
}

test("CACHE-01 최초 8회 모형 요청·재실행 0회·같은 파일과 분류 재사용", async () => {
  const h = setup([stock, stock]);
  const first = await h.run(),
    second = await h.run();
  assert.equal(h.calls(), 8);
  assert.equal(second.result, "CATALOG_CACHE_REUSED");
  assert.equal(second.networkRequestsThisRun, 0);
  assert.equal(first.reportPath, second.reportPath);
  assert.deepEqual(second.counts, {
    inputRecords: 14,
    instruments: 7,
    duplicates: 7,
    quarantined: 0,
    candidates: 0,
    reviewRequired: 7,
  });
  assert.equal(second.ordersEnabled, false);
  assert.equal(second.freshForTrading, false);
  assert.equal(second.liveEnabled, false);
  assert.equal(readdirSync(join(h.root, "data", "toss-catalogs")).length, 2);
});
test("CACHE-02 당일 캐시는 collect/자격증명 콜백을 실행하지 않음", async () => {
  const h = setup();
  await h.run();
  const result = await collectDailyCatalog(
    async () => {
      throw new Error("must not read key");
    },
    h.root,
    h.now,
    h.sleep,
  );
  assert.equal(result.result, "CATALOG_CACHE_REUSED");
  assert.equal(h.calls(), 8);
});
test("CACHE-03 정상 빈 7개 목록도 빈 캐시로 재사용", async () => {
  const h = setup([]);
  await h.run();
  assert.equal((await h.run()).counts.instruments, 0);
  assert.equal(h.calls(), 8);
});
test("CACHE-04 HTTP 실패·품질 불완전은 캐시 발행/당일 재시도 금지", async () => {
  for (const h of [
    setup([stock], true),
    setup([{}]),
    setup([stock, { ...stock, isinCode: "US0000000010" }]),
  ]) {
    const result = await h.run(),
      count = h.calls();
    assert.equal(result.dataQualityComplete, false);
    await assert.rejects(h.run(), {
      code: "CATALOG_DAILY_ATTEMPT_ALREADY_USED",
    });
    assert.throws(() => readDailyCatalogCache(h.root, h.now()), {
      code: "CATALOG_DAILY_ATTEMPT_ALREADY_USED",
    });
    assert.equal(h.calls(), count);
    assert.equal(
      JSON.parse(readFileSync(h.statePath, "utf8")).status,
      "FAILED",
    );
  }
});
test("CACHE-05 인증 전 예외도 STARTED 영속 기록·비밀값 미저장", async () => {
  const h = setup();
  await assert.rejects(
    collectDailyCatalog(
      async () => {
        throw new Error("FAKE_PRIVATE_ERROR");
      },
      h.root,
      h.now,
      h.sleep,
    ),
  );
  assert.equal(JSON.parse(readFileSync(h.statePath, "utf8")).status, "STARTED");
  await assert.rejects(h.run(), { code: "CATALOG_DAILY_ATTEMPT_ALREADY_USED" });
  assert.ok(!readFileSync(h.statePath, "utf8").includes("FAKE_PRIVATE_ERROR"));
  assert.equal(h.calls(), 0);
});
test("CACHE-06 실행 중 두 번째 수집 거절·자신의 잠금만 해제", async () => {
  const h = setup();
  let release!: () => void;
  const first = collectDailyCatalog(
    h.collect,
    h.root,
    h.now,
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  await assert.rejects(h.run(), { code: "CATALOG_CACHE_LOCKED_OR_UNWRITABLE" });
  release();
  await first;
  assert.equal(h.calls(), 8);
  assert.ok(
    !readdirSync(join(h.root, "data", "toss-catalogs")).includes(
      "daily-fetch.lock",
    ),
  );
});
test("CACHE-07 KST 자정·이전 캐시 거절·다음 날 요청과 과거 파일 보존", async () => {
  assert.equal(
    catalogCacheDay(Date.parse("2026-09-12T14:59:59.999Z")),
    "2026-09-12",
  );
  assert.equal(
    catalogCacheDay(Date.parse("2026-09-12T15:00:00.000Z")),
    "2026-09-13",
  );
  const h = setup();
  const first = await h.run();
  const bytes = readFileSync(first.reportPath);
  h.advance(86400000);
  assert.throws(() => readDailyCatalogCache(h.root, h.now()), {
    code: "CATALOG_CACHE_STALE",
  });
  const second = await h.run();
  assert.equal(h.calls(), 16);
  assert.notEqual(first.reportPath, second.reportPath);
  assert.deepEqual(readFileSync(first.reportPath), bytes);
});
test("CACHE-08 자정을 넘긴 조회 결과는 다음 날 캐시로 승격하지 않음", async () => {
  const h = setup();
  h.advance(14 * 3600000 - 1000);
  const first = await h.run();
  assert.equal(first.cacheDay, "2026-09-12");
  assert.throws(() => readDailyCatalogCache(h.root, h.now()), {
    code: "CATALOG_CACHE_STALE",
  });
  assert.equal((await h.run()).cacheDay, "2026-09-13");
  assert.equal(h.calls(), 16);
});
test("CACHE-09 손상/UTF-8/초과 크기 보고서 거절·자동 재조회 없음", async () => {
  for (const mode of ["TRUNCATED", "UTF8", "LARGE"]) {
    const h = setup();
    const result = await h.run();
    if (mode === "TRUNCATED") writeFileSync(result.reportPath, '{"broken":');
    else if (mode === "UTF8")
      writeFileSync(result.reportPath, Buffer.from([0xff]));
    else truncateSync(result.reportPath, CATALOG_CACHE_MAX_BYTES + 1);
    await assert.rejects(h.run(), { code: "CATALOG_CACHE_INVALID" });
    assert.equal(h.calls(), 8);
  }
});
test("CACHE-10 상태 체크섬/경로 탈출/미래 날짜/계약 위반 거절", async () => {
  const changes = [
    (s: Record<string, unknown>) => {
      s.reportName = "../../secret.txt";
    },
    (s: Record<string, unknown>) => {
      s.startedAt = "2099-01-01T00:00:00.000Z";
    },
    (s: Record<string, unknown>) => {
      s.day = "2026-09-11";
    },
    (s: Record<string, unknown>) => {
      s.status = "STARTED";
    },
    (s: Record<string, unknown>) => {
      s.unapproved = true;
    },
  ];
  for (const change of changes) {
    const h = setup();
    await h.run();
    resealState(h.statePath, change);
    await assert.rejects(h.run(), { code: "CATALOG_CACHE_INVALID" });
    assert.equal(h.calls(), 8);
  }
  const h = setup();
  await h.run();
  const state = JSON.parse(readFileSync(h.statePath, "utf8"));
  state.day = "2026-09-11";
  writeFileSync(h.statePath, JSON.stringify(state));
  await assert.rejects(h.run(), { code: "CATALOG_CACHE_INVALID" });
});
test("CACHE-11 보고서/상태 해시를 다시 만들어도 조작된 분류·정책·수치 거절", async () => {
  for (const mutation of [
    "FACTS",
    "COUNTS",
    "POLICY",
    "MARKET",
    "APPROVAL",
    "TIME",
    "SOURCE",
  ]) {
    const h = setup();
    const result = await h.run();
    const report = JSON.parse(readFileSync(result.reportPath, "utf8"));
    if (mutation === "FACTS")
      report.scopes[0].batch.items[0].facts.leveraged = false;
    if (mutation === "COUNTS") report.counts.instruments++;
    if (mutation === "POLICY") report.policyHash = "0".repeat(64);
    if (mutation === "MARKET") report.scopes[0].market = "US_ETC";
    if (mutation === "APPROVAL") report.ordersEnabled = true;
    if (mutation === "TIME")
      report.requests[2].receivedAt = "2000-01-01T00:00:00.000Z";
    if (mutation === "SOURCE") report.source = "https://untrusted.invalid";
    delete report.reportHash;
    const { reasonDescriptions, ...body } = report;
    report.reportHash = hash(body);
    report.reasonDescriptions = reasonDescriptions;
    writeFileSync(result.reportPath, JSON.stringify(report));
    resealState(h.statePath, (s) => {
      s.reportHash = report.reportHash;
    });
    await assert.rejects(h.run(), { code: "CATALOG_CACHE_INVALID" });
    assert.equal(h.calls(), 8);
  }
});
test("CACHE-12 없는 캐시 점검은 파일/폴더/통신 생성 없음", () => {
  const h = setup();
  assert.throws(() => readDailyCatalogCache(h.root, h.now()), {
    code: "CATALOG_CACHE_MISSING",
  });
  assert.deepEqual(readdirSync(h.root), []);
  assert.equal(h.calls(), 0);
});
test("CACHE-13 시계 역행 및 남은 잠금은 다음 날에도 자동 해제하지 않음", async () => {
  const h = setup();
  await h.run();
  h.advance(-86400000);
  await assert.rejects(h.run(), { code: "CATALOG_CACHE_INVALID" });
  h.advance(2 * 86400000);
  const path = join(h.root, "data", "toss-catalogs", "daily-fetch.lock");
  writeFileSync(path, "abandoned-test-lock");
  await assert.rejects(h.run(), { code: "CATALOG_CACHE_LOCKED_OR_UNWRITABLE" });
  assert.equal(readFileSync(path, "utf8"), "abandoned-test-lock");
  assert.equal(h.calls(), 8);
  assert.throws(() => catalogCacheDay(NaN), {
    code: "CATALOG_CACHE_CLOCK_INVALID",
  });
});
test("CACHE-14 상태 저장 실패는 인증 콜백 실행 전에 중단", async () => {
  const h = setup();
  mkdirSync(h.statePath, { recursive: true });
  await assert.rejects(h.run(), { code: "CATALOG_CACHE_INVALID" });
  assert.equal(h.calls(), 0);
});
