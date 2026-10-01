import { test } from "node:test";
import assert from "node:assert/strict";
import { hash } from "../src/core/policy.js";
import { completedRiskWindow } from "../src/core/calendar.js";
import { evaluateCostSizing } from "../src/core/cost-aware-sizing.js";
import type { CostSizingRequest } from "../src/core/cost-aware-sizing.js";
import type { CostProfile } from "../src/core/transaction-cost.js";
import type { Order, State } from "../src/core/types.js";
import { costProfile, costRequest } from "./transaction-cost-helpers.js";
import { state } from "./helpers.js";

test("SIZE-REVIEW malformed quote decimal returns ABSTAIN without throwing", () => {
  const { s, p, r } = fixture();
  r.quote.ask = "abc";
  assert.deepEqual(evaluate(s, p, r).reasons, ["INVALID_COST_SIZING_REQUEST"]);
});

function evaluate(
  s: State,
  p: CostProfile,
  r: CostSizingRequest,
  history?: unknown,
) {
  const before = hash({ s, p, r, history: history ?? null });
  const result = evaluateCostSizing(s, p, r, history);
  assert.equal(
    hash({ s, p, r, history: history ?? null }),
    before,
    "calculation must not create orders/reservations/cash changes",
  );
  assert.equal(result.orderSubmissionAllowed, false);
  assert.equal(result.learningAllowed, false);
  assert.equal(result.liveEnabled, false);
  if (result.status === "ABSTAIN") {
    assert.equal(result.quantity, 0);
    assert.equal(result.candidate, null);
    assert.ok(result.reasons.length);
  } else {
    assert.ok(Number.isInteger(result.quantity) && result.quantity > 0);
    assert.equal(result.candidate?.quantity, result.quantity);
  }
  return result;
}
function fixture(market: "KR" | "US" = "KR") {
  const s = state({ market, usdCapitalKrw: market === "US" ? 400000 : 0 }),
    p = costProfile(market);
  return { s, p, r: costRequest(s, p) };
}
function minimum(p: CostProfile, value: string) {
  p.rules
    .filter((r) => r.component === "COMMISSION")
    .forEach((r) => {
      r.minimum = value;
    });
}
test("SIZE-01 largest feasible integer; itemized KRW costs and bound evidence", () => {
  const { s, p, r } = fixture(),
    result = evaluate(s, p, r);
  assert.equal(result.status, "RESEARCH_CANDIDATE");
  assert.equal(result.quantity, 12);
  assert.equal(result.evaluated, 1);
  assert.deepEqual(result.candidate, {
    quantity: 12,
    entry: "10000",
    stop: "9950",
    riskKrw: "624",
    budgetKrw: "1250",
    entryFeeNative: "12",
    stopTradingCostKrw: "24",
    roundTripTradingCostKrw: "25",
    operatingEstimateKrw: "0",
    economicCostKrw: "25",
    expectedGrossKrw: "1200",
    netQ05Krw: "-624",
    entryCashNative: "120012",
    tickCostNative: "60",
    tickRatioBps: "5",
    spreadEmbeddedNative: "60",
    adverseExitNative: "0",
  });
  assert.equal(result.binding?.stateHash, hash(s));
  assert.equal(result.binding?.profileHash, hash(p));
});
for (const [fee, quantity] of [
  ["600", 1],
  ["601", 0],
] as const)
  test(`SIZE-02 minimum fee ${fee}, minimum-unit risk boundary`, () => {
    const { s, p, r } = fixture();
    minimum(p, fee);
    r.profileHash = hash(p);
    r.forecast.expectedExit = "15000";
    const result = evaluate(s, p, r);
    assert.equal(result.quantity, quantity);
    if (quantity) assert.equal(result.candidate!.riskKrw, "1250");
    else assert.ok(result.reasons.includes("RISK_BUDGET"));
  });
for (const [exit, quantity] of [
  ["10160", 1],
  ["10159", 0],
] as const)
  test(`SIZE-03 minimum fee economic ratio at expected exit ${exit}`, () => {
    const { s, p, r } = fixture();
    minimum(p, "40");
    r.profileHash = hash(p);
    r.quote.askSize = 10;
    r.forecast.expectedExit = exit;
    assert.equal(evaluate(s, p, r).quantity, quantity);
  });
for (const [loss, quantity] of [
  ["7520", 1],
  ["7519", 0],
] as const)
  test(`SIZE-04 original q05/trade-budget ratio at ${loss}`, () => {
    const { s, p, r } = fixture();
    r.quote.askSize = 10;
    r.forecast.q05Exit = loss;
    assert.equal(evaluate(s, p, r).quantity, quantity);
  });
for (const [stop, allowed] of [
  ["9960", true],
  ["9965", false],
  ["9900", true],
  ["9895", false],
] as const)
  test(`SIZE-05 ATR stop distance ${stop}`, () => {
    const { s, p, r } = fixture();
    r.stop = stop;
    assert.equal(
      evaluate(s, p, r).status,
      allowed ? "RESEARCH_CANDIDATE" : "ABSTAIN",
    );
  });
for (const [ask, allowed] of [
  ["10000.1", true],
  ["10005.1", false],
] as const)
  test(`SIZE-06 tick-rounded entry premium ${ask}`, () => {
    const { s, p, r } = fixture();
    r.quote.ask = ask;
    r.quote.bid = "10000";
    const result = evaluate(s, p, r);
    assert.equal(result.status, allowed ? "RESEARCH_CANDIDATE" : "ABSTAIN");
    if (allowed) assert.equal(result.candidate!.entry, "10005");
  });
test("SIZE-07 spread threshold is unchanged and tick cost denominator is actual notional", () => {
  const { s, p, r } = fixture();
  r.quote.bid = "9990";
  assert.ok(evaluate(s, p, r).reasons.includes("SPREAD"));
  r.quote.bid = "9995";
  r.quote.askSize = 10;
  const one = evaluate(s, p, r);
  r.quote.askSize = 1000;
  const twelve = evaluate(s, p, r);
  assert.equal(one.candidate!.tickCostNative, "5");
  assert.equal(twelve.candidate!.tickCostNative, "60");
  assert.equal(one.candidate!.tickRatioBps, twelve.candidate!.tickRatioBps);
});
test("SIZE-08 zero integer quantity abstains; resource bound does not silently truncate", () => {
  const { s, p, r } = fixture();
  r.quote.askSize = 9;
  assert.deepEqual(evaluate(s, p, r).reasons, ["NO_INTEGER_QUANTITY"]);
  r.quote.askSize = 100000;
  r.quote.ask = "100";
  r.quote.bid = "100";
  r.stop = "99";
  r.tickSize = "1";
  r.atr = "1";
  r.signalClose = "100";
  assert.deepEqual(evaluate(s, p, r).reasons, ["SYNTHETIC_SEARCH_LIMIT"]);
});
test("SIZE-09 cash includes entry minimum; exposure includes fee at exact notional cap", () => {
  const { s, p, r } = fixture("US");
  s.ledger.wallets.USD.cash = "80";
  s.ledger.wallets.KRW.cash = "4896000";
  r.stateHash = hash(s);
  assert.equal(evaluate(s, p, r).quantity, 1);
  const kr = fixture();
  kr.r.quote.ask = "12500";
  kr.r.quote.bid = "12500";
  kr.r.signalClose = "12500";
  kr.r.stop = "12450";
  kr.r.forecast.expectedExit = "12600";
  kr.r.forecast.q05Exit = "12450";
  const result = evaluate(kr.s, kr.p, kr.r);
  assert.equal(result.quantity, 9);
  assert.equal(result.rejectedBy.EXPOSURE, 1);
});
test("SIZE-10 synthetic USD 1 minimum rejects small account; cheaper synthetic profile passes", () => {
  const { s, p, r } = fixture("US");
  assert.equal(evaluate(s, p, r).quantity, 2);
  minimum(p, "1");
  r.profileHash = hash(p);
  const result = evaluate(s, p, r);
  assert.equal(result.quantity, 0);
  assert.ok(result.reasons.includes("RISK_BUDGET"));
});
test("SIZE-11 existing USD uses FX for valuation, not automatic conversion fees", () => {
  const { s, p, r } = fixture("US");
  const base = evaluate(s, p, r);
  p.rules.push({
    ...p.rules[0]!,
    id: "explicit-fx-only",
    component: "FX",
    side: "FX",
    unit: "FX",
    minimum: "100",
  });
  r.profileHash = hash(p);
  const result = evaluate(s, p, r);
  assert.deepEqual(result.candidate, base.candidate);
  assert.equal(result.candidate!.tickCostNative, "0.02");
  assert.equal(result.candidate!.tickRatioBps, "2.5");
});
test("SIZE-12 one-share fills apply each fill minimum, not one order minimum", () => {
  const { s, p, r } = fixture();
  minimum(p, "50");
  r.profileHash = hash(p);
  assert.equal(evaluate(s, p, r).quantity, 12);
  p.rules.forEach((v) => {
    v.unit = "FILL";
  });
  r.profileHash = hash(p);
  assert.ok(evaluate(s, p, r).reasons.includes("ECONOMIC_GATE"));
  r.forecast.expectedExit = "10500";
  const result = evaluate(s, p, r);
  assert.equal(result.quantity, 8);
  assert.equal(result.candidate!.riskKrw, "1200");
});
test("SIZE-13 spread is embedded in executable price, adverse move and costs added only once", () => {
  const { s, p, r } = fixture();
  r.adverseExitTicks = 1;
  const result = evaluate(s, p, r);
  assert.equal(result.quantity, 12);
  assert.equal(result.candidate!.adverseExitNative, "60");
  assert.equal(result.candidate!.riskKrw, "684");
  assert.equal(result.candidate!.netQ05Krw, "-684");
  assert.equal(result.candidate!.roundTripTradingCostKrw, "85");
  assert.equal(result.candidate!.spreadEmbeddedNative, "60");
});
test("SIZE-14 operating estimate is economic only, no stop-risk/payment/allocation duplication", () => {
  const { s, p, r } = fixture();
  const window = completedRiskWindow(s.clock);
  const history = {
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
        amount: "10",
        occurredAt: window.startInclusive,
        availableAt: window.endExclusive,
      },
    ],
    closedIntents: [
      {
        entryIntentId: "intent-1",
        closedAt: window.startInclusive,
        availableAt: window.endExclusive,
        buyQuantity: 1,
        sellQuantity: 1,
        allOrdersTerminal: true,
      },
    ],
    dailyBudgetKrw: "0",
    futureIncreaseKrw: "0",
  };
  const result = evaluate(s, p, r, history);
  assert.equal(result.quantity, 12);
  assert.equal(result.candidate!.riskKrw, "624");
  assert.equal(result.candidate!.economicCostKrw, "35");
  assert.equal(result.candidate!.netQ05Krw, "-634");
  assert.equal(result.candidate!.operatingEstimateKrw, "10");
  history.futureIncreaseKrw = "1";
  assert.ok(
    evaluate(s, p, r, history).reasons.includes("OPERATING_COST_UNKNOWN"),
  );
});
const guards: [string, (s: State, r: CostSizingRequest) => void, string][] = [
  [
    "signal TTL",
    (_, r) => {
      r.signalAt -= 30001;
    },
    "SIGNAL_EXPIRED",
  ],
  [
    "quote TTL",
    (_, r) => {
      r.quote.at -= 2001;
    },
    "QUOTE_STALE",
  ],
  [
    "account TTL",
    (s) => {
      s.ledger.accountAt -= 5001;
    },
    "ACCOUNT_STALE",
  ],
  [
    "FX TTL",
    (s) => {
      s.ledger.fxAt -= 60001;
    },
    "FX_STALE",
  ],
  [
    "halt",
    (s) => {
      s.status = "RECONCILING";
    },
    "ENTRY_NOT_RUNNING",
  ],
  [
    "fault",
    (s) => {
      s.fault = "TEST_FAULT";
    },
    "TEST_FAULT",
  ],
  [
    "quote halted",
    (_, r) => {
      r.quote.halted = true;
    },
    "BAD_QUOTE",
  ],
  [
    "stale scenario",
    (s, r) => {
      r.forecast.validUntil = s.clock;
    },
    "SCENARIO_STALE",
  ],
];
for (const [name, mutate, reason] of guards)
  test(`SIZE-15 preserve ${name}`, () => {
    const { s, p, r } = fixture();
    mutate(s, r);
    r.stateHash = hash(s);
    assert.ok(evaluate(s, p, r).reasons.includes(reason));
  });
test("SIZE-16 active unresolved exposure and day history are not costed using old defaults", () => {
  const { s, p, r } = fixture();
  const order: Order = {
    id: "synthetic",
    intentId: "synthetic",
    positionId: "synthetic",
    side: "BUY",
    quantity: 1,
    filled: 0,
    value: "0",
    limit: "10000",
    currency: "KRW",
    status: "UNKNOWN",
    version: 1,
    submittedAt: s.clock,
    lastProgressAt: s.clock,
    reservationRisk: "52",
    reservationCash: "10010",
    epoch: 1,
    eventIds: [],
  };
  s.orders.push(order);
  r.stateHash = hash(s);
  assert.deepEqual(evaluate(s, p, r).reasons, [
    "EXISTING_EXPOSURE_COST_UNRECONCILED",
  ]);
  s.orders = [];
  r.stateHash = hash(s);
  p.rules[0]!.unit = "DAY";
  r.profileHash = hash(p);
  assert.deepEqual(evaluate(s, p, r).reasons, ["DAY_COST_CONTEXT_REQUIRED"]);
});
test("SIZE-17 policy/state/profile/scope changes cannot reuse a cost candidate", () => {
  const { s, p, r } = fixture();
  for (const mutate of [
    (v: CostSizingRequest) => {
      v.stateHash = "0".repeat(64);
    },
    (v: CostSizingRequest) => {
      v.profileHash = "0".repeat(64);
    },
    (v: CostSizingRequest) => {
      v.product = "EQUITY";
    },
  ]) {
    const request = structuredClone(r);
    mutate(request);
    assert.deepEqual(evaluate(s, p, request).reasons, [
      "COST_BINDING_MISMATCH",
    ]);
  }
  assert.deepEqual(
    evaluateCostSizing(s, p, { ...r, policyHash: "0".repeat(64) }).reasons,
    ["INVALID_COST_SIZING_REQUEST"],
  );
});
test("SIZE-18 leveraged ETF is not categorically banned; scenario is not eligibility approval", () => {
  const { s, p, r } = fixture("US");
  p.scope.product = "LEVERAGED_ETF";
  r.product = "LEVERAGED_ETF";
  r.profileHash = hash(p);
  assert.equal(evaluate(s, p, r).status, "RESEARCH_CANDIDATE");
});
test("SIZE-19 lower capital and risk levels remain proportional", () => {
  for (const capital of [50000, 500000, 1000000, 5000000])
    for (const level of ["LOW", "MEDIUM", "HIGH"] as const) {
      const s = state({ capital, level }),
        p = costProfile(),
        r = costRequest(s, p);
      const result = evaluate(s, p, r);
      if (capital === 50000) assert.equal(result.status, "ABSTAIN");
      if (capital === 5000000)
        assert.equal(result.status, "RESEARCH_CANDIDATE");
    }
});

test("SIZE-20 daily loss headroom is shared with existing policy, not reset to per-trade budget", () => {
  const { s, p, r } = fixture();
  s.ledger.wallets.KRW.cash = "4970500";
  r.stateHash = hash(s);
  const result = evaluate(s, p, r);
  assert.equal(result.quantity, 9);
  assert.equal(result.candidate!.budgetKrw, "500");
  assert.equal(result.candidate!.riskKrw, "470");
});
test("SIZE-21 expired/future fee and forecast evidence is rejected", () => {
  for (const mutate of [
    (p: CostProfile, s: State) => {
      p.effectiveTo = s.clock;
    },
    (p: CostProfile, s: State) => {
      p.availableAt = s.clock + 1;
    },
  ]) {
    const { s, p, r } = fixture();
    mutate(p, s);
    r.profileHash = hash(p);
    assert.deepEqual(evaluate(s, p, r).reasons, ["COST_TIME_MISMATCH"]);
  }
  const { s, p, r } = fixture();
  r.forecast.availableAt = s.clock + 1;
  assert.deepEqual(evaluate(s, p, r).reasons, ["SCENARIO_STALE"]);
});
test("SIZE-22 no implicit zero when operating history is unknown; no invalid exit prices", () => {
  const { s, p, r } = fixture();
  assert.ok(evaluate(s, p, r, {}).reasons.includes("OPERATING_COST_UNKNOWN"));
  r.forecast.q05Exit = "1";
  r.adverseExitTicks = 1;
  assert.deepEqual(evaluate(s, p, r).reasons, ["INVALID_EXIT_SCENARIO"]);
});
test("SIZE-23 gross/net scenario and fees bind together at the q05 boundary", () => {
  const { s, p, r } = fixture();
  r.quote.askSize = 10;
  r.forecast.q05Exit = "7520";
  assert.equal(evaluate(s, p, r).candidate!.netQ05Krw, "-2500");
  minimum(p, "11");
  r.profileHash = hash(p);
  assert.ok(evaluate(s, p, r).reasons.includes("ECONOMIC_GATE"));
});
