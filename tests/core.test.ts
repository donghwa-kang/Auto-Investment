import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configSchema,
  verifyPolicies,
  assertOffline,
  bindSnapshot,
  hash,
  policy,
} from "../src/core/policy.js";
import {
  effectiveCaps,
  equity,
  externalFlow,
  recognizeCost,
  payCost,
  settle,
  foreignNet,
  estimateOperating,
  allocateOperating,
  mark,
} from "../src/core/ledger.js";
import {
  economic,
  size,
  remainingRisk,
  guards,
  profile,
} from "../src/core/risk.js";
import { d, tick, median, percentile } from "../src/core/math.js";
import {
  riskKeys,
  session,
  localTimeToUtc,
  minute,
} from "../src/core/calendar.js";
import {
  MissingForecast,
  SyntheticForecast,
  validateForecast,
  researchState,
  researchSamples,
} from "../src/core/providers.js";
import { state, config } from "./helpers.js";
test("POLICY-01 원본 해시·실거래 비활성", () => {
  assert.equal(Object.keys(verifyPolicies()).length, 3);
  assert.equal(policy.live_enabled, false);
  assert.equal(policy.mode_contract.execution_adapter, "NONE");
});
for (const capital of [
  0,
  -1,
  5000001,
  1.5,
  null,
  NaN,
  Infinity,
  "5000000",
  undefined,
])
  test(`INPUT-01 잘못된 자금 ${String(capital)}`, () =>
    assert.equal(
      configSchema.safeParse({ ...config, capital }).success,
      false,
    ));
for (const extra of [
  { level: "EXTREME" },
  { mode: "LIVE" },
  { live_enabled: true },
  { forecast: "REAL_AI" },
  { usdCapitalKrw: 2000001 },
  { scenario: "EXECUTE_CODE" },
])
  test(`INPUT-02 설정 거절 ${JSON.stringify(extra)}`, () =>
    assert.equal(
      configSchema.safeParse({ ...config, ...extra }).success,
      false,
    ));
test("MODE-01 LIVE 및 활성 플래그 거절", () => {
  assert.throws(() => assertOffline("LIVE"));
  assert.throws(() => assertOffline("PAPER", true));
  assert.throws(() => assertOffline("PAPER", "true"));
  assert.doesNotThrow(() => assertOffline("BACKTEST"));
});
for (const A of [1000000, 3000000, 5000000])
  for (const level of ["LOW", "MEDIUM", "HIGH"] as const)
    for (const stage of ["PILOT", "STANDARD"] as const)
      for (const reduced of [false, true])
        test(`RISK-01 ${A}/${level}/${stage}/DD=${reduced}`, () => {
          const actual = effectiveCaps(String(A), { level, stage }, reduced);
          const denominator = BigInt(
            (level === "LOW" ? 4 : level === "MEDIUM" ? 2 : 1) *
              (stage === "PILOT" ? 2 : 1) *
              (reduced ? 2 : 1) *
              10000,
          );
          const ratios = {
            trade: 20,
            position: 2000,
            notional: 4000,
            risk: 40,
            group: 25,
          };
          for (const [name, bps] of Object.entries(ratios))
            assert.equal(
              actual[name as keyof typeof actual],
              String((BigInt(A) * BigInt(bps)) / denominator),
            );
          assert.equal(actual.foreign, String(A * 0.4));
        });
test("RISK-02 독립 500만원 LOW/PILOT 예시·내림", () => {
  assert.deepEqual(effectiveCaps("5000000", config, false), {
    K: "5000000",
    trade: "1250",
    position: "125000",
    notional: "250000",
    risk: "2500",
    group: "1562",
    foreign: "2000000",
  });
  assert.equal(effectiveCaps("999", config, false).trade, "0");
});
test("MONEY-01 이진 소수점 없이 비교·호가 반올림", () => {
  assert.equal(d(".1").plus(".2").toString(), ".3".replace(/^\./, "0."));
  assert.equal(tick("10.011", ".01", true), "10.02");
  assert.equal(tick("10.019", ".01"), "10.01");
  assert.equal(median(["1", "2", "3", "8"]).toString(), "2.5");
  assert.equal(
    percentile(
      Array.from({ length: 60 }, (_, i) => String(i + 1)),
      ".95",
    ).toString(),
    "57",
  );
});
test("SIZE-01 한 주 불가 및 고정 비용 문턱", () => {
  const s = state({ capital: 100 });
  const q = {
    ask: "50000",
    bid: "49999",
    askSize: 1000,
    bidSize: 1000,
    lastMinuteVolume: 10000,
    at: s.clock,
    halted: false,
  };
  assert.equal(size(s, "50000", "49000", q, "KRW").quantity, 0);
  assert.equal(economic("19", "0", "100", "-10", "100"), false);
  assert.equal(economic("20", "0", "100", "-200", "100"), true);
  assert.equal(economic("20", "0", "100", "-200.001", "100"), false);
  assert.equal(economic("20", "11", "10", "-10", "100"), false);
});
test("SIZE-02 외화 현금 없으면 KRW로 대신 사지 않음", () => {
  const s = state();
  const q = {
    ask: "100",
    bid: "99.99",
    askSize: 1000,
    bidSize: 1000,
    lastMinuteVolume: 10000,
    at: s.clock,
    halted: false,
  };
  assert.equal(size(s, "100", "99", q, "USD").quantity, 0);
});
test("DD-01 입출금으로 낙폭·중지 리셋 없음", () => {
  const s = state();
  recognizeCost(s, "loss", "100000");
  assert.equal(s.ledger.drawdownReduced, true);
  externalFlow(s, "KRW", "500000", "deposit-1");
  assert.equal(equity(s).toString(), "5400000");
  assert.equal(
    d(s.ledger.highNav).minus(equity(s).div(s.ledger.units)).toFixed(2),
    "0.02",
  );
  externalFlow(s, "KRW", "500000", "deposit-1");
  assert.equal(equity(s).toString(), "5400000");
  assert.ok(s.ledger.halts.includes("DAY_LOSS_HALT"));
  assert.equal(s.ledger.periods.day.startEquity, "5000000");
});
test("DD-02 낙폭 남은 여유가 신규 위험 제한", () => {
  const s = state();
  s.ledger.wallets.KRW.cash = "4751000";
  assert.equal(remainingRisk(s), "0"); /* 일 손실 한도가 먼저 소진됨 */
});
test("LEDGER-01 결제 전후 채권채무 중복 없음", () => {
  const s = state();
  s.ledger.wallets.USD = {
    cash: "1000",
    receivable: "200",
    payable: "400",
    unpaidFees: "5",
  };
  assert.equal(foreignNet(s).toString(), "1033500");
  const E = equity(s).toString();
  settle(s, "USD");
  assert.equal(s.ledger.wallets.USD.cash, "800");
  assert.equal(equity(s).toString(), E);
});
test("COST-01 발생/지급 한 번 인식·중복 ID", () => {
  const s = state();
  s.ledger.operationsReserved = "100";
  recognizeCost(s, "c1", "50");
  recognizeCost(s, "c1", "50");
  assert.equal(equity(s).toString(), "4999950");
  assert.equal(s.ledger.operationsReserved, "50");
  payCost(s, "c1");
  payCost(s, "c1");
  assert.equal(equity(s).toString(), "4999950");
  assert.equal(s.ledger.wallets.KRW.cash, "4999950");
  assert.equal(s.ledger.wallets.KRW.unpaidFees, "0");
});
test("COST-02 후보 올림·보고서 합계·0건 미배분", () => {
  assert.equal(estimateOperating("10", 3, null), "4");
  assert.equal(estimateOperating("0", 0, null), null);
  assert.equal(estimateOperating("10", 0, "25"), "25");
  assert.deepEqual(allocateOperating(10, ["c", "a", "b"]), {
    unallocated: 0,
    allocations: { a: 4, b: 3, c: 3 },
  });
  assert.equal(allocateOperating(10, []).unallocated, 10);
});
test("CAL-01 서울 09시·월요일·월 경계", () => {
  assert.deepEqual(riskKeys(Date.parse("2026-09-01T08:59:59+09:00")), {
    day: "2026-08-31",
    week: "2026-08-31",
    month: "2026-08",
  });
  assert.equal(
    riskKeys(Date.parse("2026-09-01T09:00:00+09:00")).month,
    "2026-09",
  );
  const s = state();
  s.ledger.halts = ["MANUAL_REVIEW"];
  s.clock += 7 * 86400000;
  mark(s);
  assert.deepEqual(s.ledger.halts, ["MANUAL_REVIEW"]);
});
test("CAL-02 미국 DST·휴장·조기 종료는 명시 달력", () => {
  assert.equal(
    new Date(
      localTimeToUtc("2026-01-05", "09:30", "America/New_York"),
    ).toISOString(),
    "2026-01-05T14:30:00.000Z",
  );
  assert.equal(
    new Date(
      localTimeToUtc("2026-07-06", "09:30", "America/New_York"),
    ).toISOString(),
    "2026-07-06T13:30:00.000Z",
  );
  assert.equal(session("2026-07-03", "US", false, true), null);
  const early = session("2026-11-27", "US", true)!;
  assert.equal((early.close - early.open) / minute, 210);
});
test("GUARD-01 신호/호가/환율 TTL 정확 경계", () => {
  const s = state();
  const q = {
    ask: "10000",
    bid: "9999",
    askSize: 1000,
    bidSize: 1000,
    lastMinuteVolume: 10000,
    at: s.clock - 2000,
    halted: false,
  };
  assert.equal(
    guards(s, q, s.clock - 30000, "DEMO").includes("SIGNAL_EXPIRED"),
    false,
  );
  assert.ok(
    guards(s, { ...q, at: q.at - 1 }, s.clock - 30001, "DEMO").includes(
      "QUOTE_STALE",
    ),
  );
  s.ledger.fxAt = s.clock - 60001;
  assert.ok(guards(s, q, s.clock, "DEMO").includes("FX_STALE"));
});
test("SNAP-01 全필드 결합·하나라도 변경하면 해시 무효", () => {
  const x = Object.fromEntries(
    policy.decision_snapshot.required_binding_fields.map((f) => [
      f,
      "TEST_ONLY",
    ]),
  );
  const original = bindSnapshot(x);
  for (const f of policy.decision_snapshot.required_binding_fields) {
    assert.notEqual(bindSnapshot({ ...x, [f]: "CHANGED" }), original);
    const absent = { ...x };
    delete absent[f];
    assert.throws(() => bindSnapshot(absent));
  }
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});
test("AI-01 기본 프로필 누락·명시 fixture·주입/기한/해시 차단", () => {
  const i = {
    quantity: 1,
    R0: "100",
    cost: "1",
    at: 10,
    deadline: 30,
    horizon: 90,
    inputHash: "fixed",
  };
  assert.equal(new MissingForecast().forecast(i), null);
  const f = new SyntheticForecast().forecast(i);
  assert.equal(validateForecast(f, i).gross, "70");
  assert.throws(() => validateForecast({ ...f, tool: "sell_all" }, i));
  assert.throws(() => validateForecast({ ...f, inputHash: "other" }, i));
  assert.throws(() => validateForecast({ ...f, validUntil: 31 }, i));
  assert.throws(() => validateForecast({ ...f, gross: "NaN" }, i));
  assert.equal(profile.liveForbidden, true);
});
test("THEME-01 조사 준비와 주문 허가 분리·자료 만료", () => {
  const sample = researchSamples(100)[0]!;
  assert.equal(researchState(sample, 100, 0), "DISCOVERED");
  const dossier = {
    ...sample,
    state: "RESEARCH_READY" as const,
    reviewedAt: 1,
    sourceCheckedAt: 1,
    evidence: [
      {
        id: "e1",
        kind: "FACT" as const,
        text: "<script>buy()</script>",
        source: "SYNTHETIC",
        publishedAt: 1,
        receivedAt: 1,
        availableAt: 1,
        revision: 1,
      },
    ],
  };
  assert.equal(researchState(dossier, 100, 1), "RESEARCH_READY");
  assert.equal(researchState(dossier, 31 * 86400000, 1), "STALE");
  assert.equal(
    researchState({ ...dossier, materialChange: true }, 100, 1),
    "STALE",
  );
  assert.equal(
    researchSamples(100).find((x) => x.id === "SOXL")!.state,
    "DISCOVERED",
  );
  assert.equal(
    researchSamples(100).find((x) => x.id === "SOXL")!.tradePermission,
    "UNVERIFIED",
  );
  assert.equal(
    researchSamples(100).find((x) => x.id === "SOXL")!.validationCandidate,
    "INCLUDED_FOR_VALIDATION",
  );
  assert.equal(
    researchSamples(100).find((x) => x.id === "SOXL")!.reviewedAt,
    null,
  );
});
