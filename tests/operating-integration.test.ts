import { test } from "node:test";
import assert from "node:assert/strict";
import { state, configured, run } from "./helpers.js";
import { completedRiskWindow } from "../src/core/calendar.js";
import { hash } from "../src/core/policy.js";
import { d } from "../src/core/math.js";
import { costFor, economic, size, guards } from "../src/core/risk.js";
import { approveEvaluation } from "../src/core/approval.js";
import { submissionReasons } from "../src/core/submission.js";
import type { Evaluation } from "../src/core/strategy.js";
import type { State, Quote } from "../src/core/types.js";

function history(s: State, amount = "10", count = 3) {
  const window = completedRiskWindow(s.clock);
  return {
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    liveEnabled: false,
    configHash: hash(s.config),
    riskEpoch: s.epoch,
    coverage: {
      startInclusive: window.startInclusive,
      endExclusive: window.endExclusive,
      complete: true,
      availableAt: window.endExclusive,
    },
    costs: [
      {
        id: "cost-1",
        kind: "OPERATING",
        currency: "KRW",
        amount,
        occurredAt: window.startInclusive,
        availableAt: window.startInclusive,
      },
    ],
    closedIntents: Array.from({ length: count }, (_, i) => ({
      entryIntentId: `closed-${i}`,
      closedAt: window.startInclusive + 1000,
      availableAt: window.startInclusive + 1000,
      buyQuantity: 5,
      sellQuantity: 5,
      allOrdersTerminal: true,
    })),
    dailyBudgetKrw: "0",
    futureIncreaseKrw: "0",
  };
}
function quote(s: State): Quote {
  return {
    ask: "10000",
    bid: "9999",
    askSize: 10000,
    bidSize: 10000,
    lastMinuteVolume: 40000,
    at: s.clock,
    halted: false,
  };
}
// 승인 경계 시험용 이미 평가된 합성 신호. 차트 전략 검증은 기존 회귀가 담당한다.
function evaluate(s: State): Evaluation {
  return {
    at: s.clock,
    symbol: "TEST_COST",
    strategies: ["B"],
    stops: { B: "9900" },
    trace: [],
    dataVersion: "SYNTHETIC_COST_TEST",
    current: {
      session: "TEST",
      openAt: s.clock - 60000,
      closeAt: s.clock,
      availableAt: s.clock,
      revision: 0,
      o: "10000",
      h: "10000",
      l: "9999",
      c: "10000",
      v: "10000",
      slot: 1,
      atr: "100",
      ema: "9990",
      vwap: "9990",
      rvol: "2",
      orh: "9900",
      volCeiling: "1000",
    },
  };
}
function approve(s: State, operatingHistory?: unknown) {
  approveEvaluation(s, evaluate(s), {
    quote: quote(s),
    market: "KR",
    sessionClose: s.sessionClose,
    dataHash: hash("synthetic-cost"),
    decisionId: "cost-decision",
    operatingHistory,
  });
}

test("OP-INT-01 운영비는 경제성에 한 번만 포함하고 수량·손절 위험은 보존", () => {
  const s = state(),
    before = structuredClone(s),
    q = quote(s);
  const zero = size(s, "10000", "9900", q, "KRW", history(s, "0"));
  const two = size(s, "10000", "9900", q, "KRW", history(s, "6"));
  assert.ok(zero.quantity > 0);
  assert.equal(two.quantity, zero.quantity);
  assert.equal(two.risk, zero.risk);
  assert.equal(d(two.cost).minus(zero.cost).toString(), "2");
  assert.equal(zero.cost, costFor(zero.quantity, "10000", "9900", "1").total);
  assert.deepEqual(s, before);
  assert.equal(economic("25", "4", "100", "-10", "100"), true);
  assert.equal(economic("25", "6", "100", "-10", "100"), false);
});
test("OP-INT-02 승인 총비용·예측·근거 해시 결합, 예약/장부 미중복", () => {
  const a = state(),
    b = state();
  approve(a, history(a, "0"));
  approve(b, history(b, "6"));
  assert.equal(a.decisions[0]!.result, "APPROVED");
  assert.equal(b.decisions[0]!.result, "APPROVED");
  const x = a.orders[0]!,
    y = b.orders[0]!;
  assert.equal(x.quantity, y.quantity);
  assert.equal(x.reservationRisk, y.reservationRisk);
  assert.equal(x.reservationCash, y.reservationCash);
  assert.deepEqual(a.ledger, b.ledger);
  assert.equal(y.snapshot!.estimated_operating_cost_krw, "2");
  assert.equal(
    d(String(y.snapshot!.estimated_cost))
      .minus(String(x.snapshot!.estimated_cost))
      .toString(),
    "2",
  );
  assert.notEqual(x.snapshotHash, y.snapshotHash);
  assert.notEqual(
    (x.snapshot!.forecast_output as { inputHash: string }).inputHash,
    (y.snapshot!.forecast_output as { inputHash: string }).inputHash,
  );
});
test("OP-INT-03 운영비 증가만으로 경제성 탈락 시 주문·예약 없음", () => {
  const s = state(),
    before = structuredClone(s.ledger);
  approve(s, history(s, "3000"));
  assert.equal(s.decisions[0]!.result, "ABSTAIN");
  assert.ok(s.decisions[0]!.reasons.includes("ECONOMIC_GATE"));
  assert.equal(s.orders.length, 0);
  assert.deepEqual(s.ledger, before);
});
test("OP-INT-04 접수는 별도 현재 증거 필요·같은 위험일 재검사 허용", () => {
  const s = state(),
    h = history(s);
  approve(s, h);
  const o = s.orders[0]!;
  assert.deepEqual(submissionReasons(s, o, quote(s), h), []);
  assert.ok(
    submissionReasons(s, o, quote(s)).includes(
      "OPERATING_COST_EVIDENCE_CHANGED",
    ),
  );
  s.clock += 1000;
  s.ledger.accountAt = s.clock;
  s.ledger.fxAt = s.clock;
  assert.deepEqual(submissionReasons(s, o, quote(s), h), []);
});
test("OP-INT-05 같은 추정4원이라도 O10→11 근거 변경 거절", () => {
  const s = state(),
    h = history(s);
  approve(s, h);
  const next = history(s, "11");
  assert.equal(
    size(s, "10000", "9900", quote(s), "KRW", h).operating.amount,
    "4",
  );
  assert.equal(
    size(s, "10000", "9900", quote(s), "KRW", next).operating.amount,
    "4",
  );
  const reasons = submissionReasons(s, s.orders[0]!, quote(s), next);
  assert.ok(reasons.includes("OPERATING_COST_EVIDENCE_CHANGED"));
  assert.ok(!reasons.includes("SIZE_OR_COST_CHANGED"));
});
test("OP-INT-06 창 경계 변경과 불완전한 자료는 접수 보류", () => {
  const s = state(),
    h = history(s);
  approve(s, h);
  s.clock += 86400000;
  s.ledger.accountAt = s.clock;
  s.ledger.fxAt = s.clock;
  const reasons = submissionReasons(s, s.orders[0]!, quote(s), h);
  assert.ok(reasons.includes("OPERATING_COST_UNKNOWN"));
  assert.ok(reasons.includes("OPERATING_COST_EVIDENCE_CHANGED"));
});
for (const mode of ["nonzero-cost", "reservation", "malformed-cost"] as const)
  test(`OP-INT-07 ${mode}는 명시 합성 이력으로 우회 불가`, () => {
    const s = state(),
      h = history(s);
    if (mode === "reservation") s.ledger.operationsReserved = "1";
    else
      s.ledger.costs.push({
        id: "old",
        amount: mode === "nonzero-cost" ? "1" : "NaN",
        at: s.clock,
        paid: false,
      });
    assert.equal(size(s, "10000", "9900", quote(s), "KRW", h).quantity, 0);
    assert.ok(
      guards(s, quote(s), s.clock, "TEST_COST", h).includes(
        "OPERATING_COST_UNKNOWN",
      ),
    );
    approve(s, h);
    assert.equal(s.orders.length, 0);
    assert.equal(s.decisions[0]!.result, "ABSTAIN");
  });
test("OP-INT-08 기본 합성 무비용 승인 유지, 구형 승인 자동 승격 금지", () => {
  const s = state();
  approve(s);
  const o = s.orders[0]!;
  assert.deepEqual(submissionReasons(s, o, quote(s)), []);
  delete o.snapshot!.operating_cost_binding;
  delete o.snapshot!.estimated_operating_cost_krw;
  o.snapshotHash = hash(o.snapshot);
  assert.ok(
    submissionReasons(s, o, quote(s)).includes(
      "OPERATING_COST_EVIDENCE_CHANGED",
    ),
  );
});
test("OP-INT-09 일반 엔진은 저장된 명시 비용을 최신 증거로 재사용하지 않음", async () => {
  const e = await configured();
  try {
    await run(e, "start");
    e.repo.transact("cost-test-order", { test: true }, (raw) => {
      const s = raw!;
      s.orders = [];
      s.decisions = [];
      s.ledger.intents = 0;
      approve(s, history(s));
      assert.equal(s.orders[0]!.status, "INTENT_SAVED");
      return s;
    });
    await run(e, "step", { seconds: 1 });
    const s = e.state(),
      o = s.orders[0]!;
    assert.equal(o.status, "REJECTED");
    assert.equal(o.reservationRisk, "0");
    assert.equal(o.reservationCash, "0");
    assert.equal(s.positions.length, 0);
    assert.ok(
      s.notices.some((n) => n.includes("OPERATING_COST_EVIDENCE_CHANGED")),
    );
  } finally {
    e.close();
  }
});
