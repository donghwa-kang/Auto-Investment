import { test } from "node:test";
import assert from "node:assert/strict";
import { d } from "../src/core/math.js";
import { hash } from "../src/core/policy.js";
import { profile, fee, economic } from "../src/core/risk.js";
import { evaluateCostSizing } from "../src/core/cost-aware-sizing.js";
import { applyOrderEvent } from "../src/core/simulator.js";
import { availableCash, settle } from "../src/core/ledger.js";
import {
  replayCostExecutions,
  costExecutionConfigSchema,
  costExecutionEventSchema,
} from "../src/core/cost-execution.js";
import type {
  CostExecutionConfig,
  CostExecutionEvent,
} from "../src/core/cost-execution.js";
import { recordedFillSchema } from "../src/core/paper-learning-schema.js";
import {
  enableLearningCapture,
  captureLearningTransition,
  learningJournal,
} from "../src/core/paper-learning-capture.js";
import { PortfolioProgram } from "../src/core/portfolio-program.js";
import { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import { checkPortfolioInvariants } from "../src/core/portfolio-invariants.js";
import { portfolioFixture, laterTick } from "../src/core/portfolio-fixture.js";
import { replayFixture } from "./signal-replay-helpers.js";
import { state } from "./helpers.js";
import { executionConfig, executionEvents } from "./cost-execution-helpers.js";
import { costProfile, costRequest } from "./transaction-cost-helpers.js";

// Characterization, not a production adapter: explicit synthetic events bypass
// signal approval. No unknown legacy fill is reinterpreted as a broker fill.
// Only the normal fixture sequences below are supported: cancellation totals
// are synthesized, and ambiguous late fills are not a reconciliation model.
function common(
  market: "KR" | "US",
  events: CostExecutionEvent[],
  capture = false,
) {
  const s = state({ market, usdCapitalKrw: market === "US" ? 1300000 : 0 });
  s.revision = 0;
  s.manifest = { runHash: hash("COST_BOUNDARY_TEST") };
  if (capture) enableLearningCapture(s);
  for (const e of events) {
    const before = structuredClone(s);
    s.clock = e.at;
    if (e.kind === "ORDER") {
      const stop = d(e.limit).mul("0.95").toString();
      s.orders.push({
        id: e.orderId,
        intentId: e.side === "BUY" ? e.orderId : "close-buy",
        positionId: "position-buy",
        side: e.side,
        quantity: e.quantity,
        filled: 0,
        value: "0",
        limit: e.limit,
        currency: market === "KR" ? "KRW" : "USD",
        status: "WORKING",
        version: 0,
        submittedAt: e.at,
        lastProgressAt: e.at,
        reservationRisk: "0",
        reservationCash:
          e.side === "BUY"
            ? d(e.limit)
                .mul(e.quantity)
                .plus(fee(d(e.limit).mul(e.quantity).toString(), "BUY"))
                .toString()
            : "0",
        snapshot: {
          instrument_id: `${market}:SYNTHETIC`,
          market,
          stop_price: stop,
          initial_budget: "1250",
        },
        epoch: s.epoch,
        eventIds: [],
        ...(e.replaces ? { replaces: e.replaces } : {}),
      });
    } else {
      const order = s.orders.find((o) => o.id === e.orderId)!;
      const q = order.filled + (e.kind === "FILL" ? e.quantity : 0);
      const status =
        e.kind === "FILL"
          ? q === order.quantity
            ? "FILLED"
            : "PARTIAL"
          : e.kind === "CANCEL_CONFIRMED"
            ? "CANCELLED"
            : e.kind === "CANCEL_REQUEST"
              ? "CANCEL_PENDING"
              : e.kind;
      applyOrderEvent(s, order, {
        id: e.kind === "FILL" ? e.fillId : e.id,
        version: order.version + 1,
        cumulativeFilled: q,
        cumulativeValue:
          e.kind === "FILL"
            ? d(order.value).plus(d(e.price).mul(e.quantity)).toString()
            : order.value,
        status,
      });
    }
    if (capture) captureLearningTransition(s, before, e.id);
  }
  return s;
}
function proportional(market: "KR" | "US" = "KR") {
  const c = executionConfig("ORDER", market);
  const s = state({ market, usdCapitalKrw: market === "US" ? 1300000 : 0 });
  c.initialCash = s.ledger.wallets[market === "KR" ? "KRW" : "USD"].cash;
  c.profile.rules.forEach((r) => {
    r.minimum = "0";
    r.quantum = "0.000001";
    r.tiers[0]!.rate =
      r.component === "COMMISSION"
        ? r.side === "BUY"
          ? profile.fees.entryBps
          : profile.fees.exitBps
        : "0";
  });
  return c;
}
function lab(c: CostExecutionConfig, e: CostExecutionEvent[]) {
  const before = hash({ c, e }),
    r = replayCostExecutions(c, e);
  assert.equal(hash({ c, e }), before);
  assert.equal(r.status, "OK", JSON.stringify(r));
  if (r.status !== "OK") throw Error("EXPECTED_OK");
  assert.equal(r.learningAllowed, false);
  assert.equal(r.orderSubmissionAllowed, false);
  assert.equal(r.liveEnabled, false);
  return r;
}
function marketEvents(market: "KR" | "US") {
  const e = executionEvents();
  if (market === "US")
    for (const event of e) {
      if (event.kind === "ORDER")
        event.limit = d(event.limit).mul("0.04").toString();
      if (event.kind === "FILL")
        event.price = d(event.price).mul("0.04").toString();
      if (event.kind === "CANCEL_CONFIRMED")
        event.cumulativeValue = d(event.cumulativeValue).mul("0.04").toString();
    }
  return e;
}
const netWallet = (s: ReturnType<typeof state>, c: "KRW" | "USD") => {
  const w = s.ledger.wallets[c];
  return d(w.cash)
    .plus(w.receivable)
    .minus(w.payable)
    .minus(w.unpaidFees)
    .toString();
};

for (const market of ["KR", "US"] as const) {
  test(`CINT-01 ${market} linear-equivalent profile agrees after cancel and replacement`, () => {
    const c = proportional(market),
      e = marketEvents(market),
      currency = c.profile.scope.currency;
    const s = common(market, e),
      r = lab(c, e),
      p = s.positions[0]!;
    assert.equal(netWallet(s, currency), r.cash);
    assert.equal(
      d(p.entryFees).plus(p.exitFees).toString(),
      r.report.tradingFees,
    );
    assert.equal(
      p.netPnl,
      d(r.report.tradingNetPnl!)
        .mul(market === "KR" ? 1 : 1300)
        .toString(),
    );
    assert.equal(r.report.costBasisHash, r.learningEvidence.costBasisHash);
    assert.equal(r.learningEvidence.status, "HOLD");
  });
  test(`CINT-02 ${market} immediate lab cash differs from common unsettled cash`, () => {
    const c = proportional(market),
      e = marketEvents(market).slice(0, 3),
      currency = c.profile.scope.currency;
    const s = common(market, e),
      r = lab(c, e);
    assert.notEqual(s.ledger.wallets[currency].cash, r.cash);
    assert.equal(netWallet(s, currency), r.cash);
    assert.equal(s.orders[0]!.reservationCash, r.reservedCash);
    assert.equal(availableCash(s, currency).toString(), r.availableCash);
    const economicBefore = netWallet(s, currency);
    settle(s, currency);
    assert.equal(s.ledger.wallets[currency].cash, r.cash);
    assert.equal(netWallet(s, currency), economicBefore);
  });
  test(`CINT-02S ${market} unsettled SELL proceeds are not reusable lab cash`, () => {
    const c = proportional(market),
      events = marketEvents(market),
      currency = c.profile.scope.currency;
    const s = common(market, events),
      r = lab(c, events),
      wallet = s.ledger.wallets[currency];
    assert.ok(d(wallet.receivable).gt(0));
    assert.equal(netWallet(s, currency), r.cash);
    assert.ok(availableCash(s, currency).lt(r.availableCash));
    assert.equal(
      d(r.availableCash).minus(availableCash(s, currency)).toString(),
      wallet.receivable,
    );
    const economicBefore = netWallet(s, currency);
    settle(s, currency);
    assert.equal(availableCash(s, currency).toString(), r.availableCash);
    assert.equal(wallet.cash, r.cash);
    assert.equal(netWallet(s, currency), economicBefore);
  });
}

test("CINT-03 identical cumulative totals do not identify FILL minimum charges", () => {
  const split = executionEvents().slice(0, 3),
    bulk = executionEvents().slice(0, 2);
  if (bulk[1]!.kind !== "FILL") throw Error();
  bulk[1]!.quantity = 2;
  const a = common("KR", split),
    b = common("KR", bulk);
  assert.equal(a.orders[0]!.filled, b.orders[0]!.filled);
  assert.equal(a.orders[0]!.value, b.orders[0]!.value);
  assert.equal(a.positions[0]!.entryFees, b.positions[0]!.entryFees);
  const c = executionConfig("FILL");
  assert.equal(lab(c, split).report.tradingFees, "20");
  assert.equal(lab(c, bulk).report.tradingFees, "10");
});

test("CINT-04 ORDER minimum is cumulative while common linear charge remains unchanged", () => {
  const e = executionEvents().slice(0, 3),
    r = lab(executionConfig(), e),
    s = common("KR", e);
  assert.deepEqual(
    r.fills.map((f) => f.feeDelta),
    ["10", "0"],
  );
  assert.equal(s.positions[0]!.entryFees, "0.2");
  assert.equal(r.report.tradingFees, "10");
});

test("CINT-05 residual minimum reservation cannot be copied from the linear engine", () => {
  const e = executionEvents().slice(0, 2),
    s = common("KR", e),
    r = lab(executionConfig("FILL"), e);
  assert.equal(s.orders[0]!.reservationCash, "3000.3");
  assert.equal(r.reservedCash, "3030");
});

test("CINT-06 existing learning capture recalculates linear fees, not position fee deltas", () => {
  const e = executionEvents().slice(0, 3),
    s = common("KR", e, true),
    j = learningJournal(s)!;
  assert.deepEqual(
    j.fills.map((f) => f.fee),
    ["0.1", "0.1"],
  );
  assert.deepEqual(
    lab(executionConfig(), e).fills.map((f) => f.feeDelta),
    ["10", "0"],
  );
  const recorded = structuredClone(j.fills[0]!);
  assert.equal(recordedFillSchema.safeParse(recorded).success, true);
  assert.equal(
    recordedFillSchema.safeParse({
      ...recorded,
      costProfileHash: hash(executionConfig().profile),
    }).success,
    false,
  );
});

test("CINT-07 a legacy cumulative delta cannot preserve multiple execution identities", () => {
  const e = executionEvents().slice(0, 2);
  if (e[1]!.kind !== "FILL") throw Error();
  e[1]!.quantity = 2;
  const s = common("KR", e, true),
    j = learningJournal(s)!;
  assert.equal(j.fills.length, 1);
  assert.equal(j.fills[0]!.quantity, 2);
  const split = lab(executionConfig("FILL"), executionEvents().slice(0, 3));
  assert.equal(split.fills.length, 2);
  assert.notEqual(j.fills.length, split.fills.length);
});

test("CINT-08 source IDs and precision require an explicit lossless bridge", () => {
  const c = executionConfig();
  assert.equal(
    costExecutionConfigSchema.safeParse({ ...c, instrument: "KR:SYNTHETIC" })
      .success,
    false,
  );
  const f = executionEvents()[1]!;
  if (f.kind !== "FILL") throw Error();
  assert.equal(
    costExecutionEventSchema.safeParse({ ...f, price: "1000.1234567" }).success,
    false,
  );
  const s = common("KR", executionEvents().slice(0, 2), true),
    old = learningJournal(s)!.fills[0]!;
  assert.equal(
    recordedFillSchema.safeParse({
      ...old,
      id: "KR:fill:1",
      value: "1000.1234567",
    }).success,
    true,
  );
});

const input = replayFixture(),
  fixture = portfolioFixture(input),
  program = new PortfolioProgram(input, fixture.settings);
function engineWithPartialFill() {
  const e = new PortfolioPaperEngine(program);
  e.command("start", { type: "start" });
  e.command("frame", fixture.ticks[0]!);
  e.command("one", laterTick(fixture.ticks[0]!, 1));
  e.command("two", laterTick(fixture.ticks[0]!, 2));
  return e;
}
test("CINT-09 common invariants reject fee-only replacement without ledger contract change", () => {
  const e = engineWithPartialFill();
  try {
    const s = e.state(),
      initial = program.initial(s.epoch);
    assert.ok(s.positions.length);
    checkPortfolioInvariants(s, initial);
    const copy = structuredClone(s),
      p = copy.positions[0]!;
    p.entryFees = d(p.entryFees).plus(10).toString();
    assert.throws(
      () => checkPortfolioInvariants(copy, initial),
      /PORTFOLIO_INVARIANT:POSITION_VALUE/,
    );
    assert.deepEqual(e.state(), s);
  } finally {
    e.close();
  }
});
test("CINT-10 common available cash and SELL invariant do not support SELL fee reserves", () => {
  const e = engineWithPartialFill();
  try {
    e.command("exit", { type: "liquidate", confirm: true });
    // The normal command may first cancel the unfinished BUY. Advance the
    // synthetic stream until a SELL exists; never fabricate a live order.
    for (
      let i = 3;
      i <= 8 && !e.state().orders.some((o) => o.side === "SELL");
      i++
    )
      e.command(`tick-${i}`, laterTick(fixture.ticks[0]!, i));
    const s = e.state(),
      sell = s.orders.find((o) => o.side === "SELL");
    assert.ok(sell);
    checkPortfolioInvariants(s, program.initial(s.epoch));
    const copy = structuredClone(s),
      changed = copy.orders.find((o) => o.id === sell.id)!;
    const before = availableCash(copy, changed.currency).toString();
    changed.reservationCash = "1";
    assert.equal(availableCash(copy, changed.currency).toString(), before);
    assert.throws(
      () => checkPortfolioInvariants(copy, program.initial(s.epoch)),
      /PORTFOLIO_INVARIANT:SELL_RESERVATION/,
    );
    assert.deepEqual(e.state(), s);
  } finally {
    e.close();
  }
});

test("CINT-11 economic gate preserves original price R0, separate from reserved risk", () => {
  const s = state(),
    p = costProfile();
  p.rules.forEach((rule) => {
    rule.minimum = "0";
  });
  const request = costRequest(s, p);
  request.quote.askSize = 10; // Existing participation rule permits one share.
  request.forecast.expectedExit = "10013";
  const before = hash({ s, p, request });
  // P=10000, S=9950: original R0=50. Rounded BUY/stop fees are 1+1,
  // so reservation risk is 52; expected-exit fees are 1+2, net profit=10.
  // The economic R denominator must not include the reserved trading costs.
  assert.equal(economic("13", "3", "50", "-52", "1250"), true);
  assert.equal(economic("13", "3", "52", "-52", "1250"), false);
  const result = evaluateCostSizing(s, p, request);
  assert.equal(result.status, "RESEARCH_CANDIDATE");
  assert.equal(result.quantity, 1);
  assert.equal(result.candidate!.riskKrw, "52");
  assert.equal(result.candidate!.economicCostKrw, "3");
  assert.equal(result.candidate!.expectedGrossKrw, "13");
  assert.equal(result.orderSubmissionAllowed, false);
  assert.equal(result.learningAllowed, false);
  assert.equal(result.liveEnabled, false);
  assert.equal(hash({ s, p, request }), before);
  const below = structuredClone(request);
  below.forecast.expectedExit = "10012.9";
  const rejected = evaluateCostSizing(s, p, below);
  assert.equal(rejected.status, "ABSTAIN");
  assert.deepEqual(rejected.reasons, ["NO_FEASIBLE_QUANTITY", "ECONOMIC_GATE"]);
});
