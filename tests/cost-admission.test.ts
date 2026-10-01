import { test } from "node:test";
import assert from "node:assert/strict";
import { hash, policy } from "../src/core/policy.js";
import { d } from "../src/core/math.js";
import { equity } from "../src/core/ledger.js";
import {
  estimateFeeBound,
  costKernelContract,
  evaluateOrderCost,
} from "../src/core/cost-kernel.js";
import {
  buildCostExposure,
  assertCostExposure,
} from "../src/core/cost-risk-context.js";
import { evaluateCostSizing } from "../src/core/cost-aware-sizing.js";
import {
  issueCostAdmissionReview,
  recheckCostAdmission,
  reviewCostAdmission,
} from "../src/core/cost-admission.js";
import {
  remainingRisk,
  remainingRiskForExposure,
  openRisk,
  profile,
} from "../src/core/risk.js";
import { fixture, source, observe, request } from "./cost-admission-helpers.js";
import { costAt, costProfile } from "./transaction-cost-helpers.js";
import { journalEvents } from "./cost-journal-helpers.js";
import { replayCostJournal } from "../src/core/cost-journal.js";

function projected(f: ReturnType<typeof fixture>) {
  const before = hash(f);
  const result = buildCostExposure(f.seed, f.book);
  assert.equal(hash(f), before);
  if (result.status !== "OK") throw Error(result.reasons.join(","));
  return result.context;
}
function held(f: ReturnType<typeof fixture>, reason: string) {
  const r = buildCostExposure(f.seed, f.book);
  assert.equal(r.status, "HOLD");
  if (r.status === "HOLD")
    assert.ok(r.reasons.includes(reason), r.reasons.join(","));
}
test("CAD-01 empty explicit context preserves existing quantity/economics and policy headroom", () => {
  const f = fixture(),
    c = projected(f),
    r = request(f),
    old = evaluateCostSizing(f.seed, f.p, r),
    n = issueCostAdmissionReview(f.seed, f.book, f.p, r);
  assert.equal(n.status, "RESEARCH_CANDIDATE");
  assert.equal(n.sizing!.quantity, old.quantity);
  assert.equal(c.budgetKrw, remainingRisk(f.seed));
  assert.equal(n.sizing!.candidate!.operatingEstimateKrw, "0");
  assert.equal(n.orderSubmissionAllowed, false);
  assert.equal(n.learningAllowed, false);
  assert.equal(n.liveEnabled, false);
  assert.equal(
    recheckCostAdmission(n, f.seed, f.book, f.p, r).status,
    "RESEARCH_MATCH",
  );
  assert.equal(f.seed.orders.length, 0);
  assert.equal(f.seed.decisions.length, 0);
});
for (const market of ["KR", "US"] as const)
  test(`CAD-02 ${market} partial BUY counts charged cost once and pending cost separately`, () => {
    const f = fixture(market);
    f.book.sources = [source(f.seed, "FIRST", market, 2, 1)];
    observe(f.seed, f.book);
    const c = projected(f),
      v = replayCostJournal(
        f.book.sources[0]!.config,
        f.book.sources[0]!.events,
      ),
      FX = market === "KR" ? "1" : "1300",
      P = market === "KR" ? "10000" : "40",
      S = market === "KR" ? "9950" : "39.8";
    const future = estimateFeeBound(
      f.book.sources[0]!.config.execution.profile,
      "SELL",
      1,
      P,
      f.seed.clock,
    );
    const heldRisk = d(P)
      .minus(S)
      .plus(future)
      .plus(d(P).mul(profile.fees.exitAdverseBps).div(10000))
      .mul(FX);
    assert.equal(c.entries[0]!.heldRiskKrw, heldRisk.toString());
    const pending = d(P)
      .minus(S)
      .plus(d(v.reservedCash).minus(P))
      .plus(
        estimateFeeBound(
          f.book.sources[0]!.config.execution.profile,
          "SELL",
          1,
          S,
          f.seed.clock,
        ),
      )
      .plus(d(S).mul(profile.fees.exitAdverseBps).div(10000))
      .mul(FX);
    assert.equal(c.entries[0]!.pendingRiskKrw, pending.toString());
    assert.equal(c.openRiskKrw, heldRisk.plus(pending).toString());
    assert.equal(
      c.available[v.currency],
      d(f.seed.ledger.wallets[v.currency].cash)
        .minus(v.wallet.payable)
        .minus(v.reservedCash)
        .toString(),
    );
    assert.equal(c.budgetKrw, remainingRiskForExposure(c.state, c.openRiskKrw));
    assert.ok(equity(c.state).lt(equity(f.seed)));
    const review = issueCostAdmissionReview(f.seed, f.book, f.p, request(f));
    assert.equal(review.status, "RESEARCH_CANDIDATE", review.reasons.join(","));
  });
test("CAD-03 two journals do not double the common opening capital", () => {
  const f = fixture();
  f.book.sources = [source(f.seed, "FIRST"), source(f.seed, "SECOND")];
  observe(f.seed, f.book);
  const c = projected(f);
  assert.equal(c.state.ledger.wallets.KRW.cash, "5000000");
  assert.equal(c.state.ledger.wallets.KRW.payable, "20020");
  assert.equal(c.available.KRW, "4959980");
  assert.equal(c.state.orders.length, 2);
  assert.notEqual(c.state.orders[0]!.id, c.state.orders[1]!.id);
});
test("CAD-04 each journal is affordable but shared currency is overreserved", () => {
  const f = fixture();
  f.book.sources = [
    source(f.seed, "FIRST", "KR", 300, 0),
    source(f.seed, "SECOND", "KR", 300, 0),
  ];
  observe(f.seed, f.book);
  for (const v of f.book.sources)
    assert.ok(d(replayCostJournal(v.config, v.events).availableCash).gte(0));
  held(f, "SHARED_CASH_OVERRESERVED");
});
test("CAD-05 KRW and USD are not exchanged or summed as native cash", () => {
  const f = fixture("US");
  f.book.sources = [
    source(f.seed, "FIRST", "KR"),
    source(f.seed, "SECOND", "US"),
  ];
  observe(f.seed, f.book);
  const c = projected(f);
  assert.equal(
    c.available.KRW,
    d(f.seed.ledger.wallets.KRW.cash).minus(20010).toString(),
  );
  assert.equal(
    c.available.USD,
    d(f.seed.ledger.wallets.USD.cash).minus("80.01").toString(),
  );
  assert.equal(
    c.openRiskKrw,
    d(c.entries[0]!.heldRiskKrw)
      .plus(c.entries[0]!.pendingRiskKrw)
      .plus(c.entries[1]!.heldRiskKrw)
      .plus(c.entries[1]!.pendingRiskKrw)
      .toString(),
  );
});
test("CAD-06 unsettled SELL proceeds cannot fund a new entry", () => {
  const f = fixture();
  const a = source(f.seed);
  a.config.execution.profile.rules.forEach((v) => {
    v.tiers[0]!.rate = "0";
    v.minimum = v.component === "COMMISSION" ? "10" : "0";
  });
  a.events = journalEvents().slice(0, -1);
  a.observation.bid = "1100";
  a.observation.stop = "950";
  a.observation.protectedQuantity = 0;
  f.book.sources = [a];
  observe(f.seed, f.book);
  const c = projected(f),
    w = c.state.ledger.wallets.KRW;
  assert.ok(d(w.receivable).gt(0));
  assert.equal(c.available.KRW, w.cash);
  assert.ok(d(w.cash).plus(w.receivable).gt(c.available.KRW));
});
test("CAD-07 UNKNOWN preserves measured exposure and blocks candidate", () => {
  const f = fixture();
  const a = source(f.seed);
  a.events.push({
    kind: "UNKNOWN",
    id: "u",
    seq: 3,
    at: costAt + 3,
    orderId: "buy",
  });
  f.book.sources = [a];
  observe(f.seed, f.book);
  const c = projected(f);
  assert.ok(d(c.openRiskKrw).gt(0));
  assert.ok(d(c.entries[0]!.reservedCash).gt(0));
  const r = issueCostAdmissionReview(f.seed, f.book, f.p, request(f));
  assert.ok(r.reasons.includes("UNRESOLVED_EXECUTION"));
  assert.equal(r.status, "HOLD");
});
test("CAD-08 FX revalues both held and unfilled risk; native reservations unchanged", () => {
  const f = fixture("US");
  f.book.sources = [source(f.seed, "FIRST", "US")];
  observe(f.seed, f.book);
  const a = projected(f);
  f.seed.ledger.fx = "1400";
  f.book.seedHash = hash(f.seed);
  const b = projected(f);
  for (const key of ["heldRiskKrw", "pendingRiskKrw"] as const)
    assert.equal(
      d(a.entries[0]![key]).div(1300).mul(1400).toString(),
      b.entries[0]![key],
    );
  assert.deepEqual(a.available, b.available);
  assert.notEqual(a.sourceHash, b.sourceHash);
});
for (const change of [
  "profile-id",
  "rounding",
  "unit",
  "quote-time",
  "fx-time",
  "epoch",
  "status",
] as const)
  test(`CAD-09 same amounts or changed evidence require new review: ${change}`, () => {
    const f = fixture(),
      r = request(f),
      receipt = issueCostAdmissionReview(f.seed, f.book, f.p, r);
    assert.equal(receipt.status, "RESEARCH_CANDIDATE");
    if (change === "profile-id") f.p.id = "different-synthetic-profile";
    if (change === "rounding")
      f.p.rules.forEach((v) => (v.rounding = "HALF_EVEN"));
    if (change === "unit") f.p.rules.forEach((v) => (v.unit = "FILL"));
    if (change === "quote-time") r.quote.at--;
    if (change === "fx-time") f.seed.ledger.fxAt--;
    if (change === "epoch") f.seed.epoch++;
    if (change === "status") f.seed.status = "ENTRY_PAUSED";
    f.book.seedHash = hash(f.seed);
    r.profileHash = hash(f.p);
    r.stateHash = projected(f).stateHash;
    const checked = recheckCostAdmission(receipt, f.seed, f.book, f.p, r);
    assert.equal(checked.status, "REAPPROVAL_REQUIRED");
    assert.equal(checked.orderSubmissionAllowed, false);
  });
test("CAD-10 modified or serialized review is not an approval receipt", () => {
  const f = fixture(),
    r = request(f),
    n = issueCostAdmissionReview(f.seed, f.book, f.p, r);
  assert.equal(
    recheckCostAdmission(structuredClone(n), f.seed, f.book, f.p, r).status,
    "REAPPROVAL_REQUIRED",
  );
  n.sizing!.quantity++;
  assert.equal(
    recheckCostAdmission(n, f.seed, f.book, f.p, r).status,
    "REAPPROVAL_REQUIRED",
  );
});
test("CAD-11 cloned or mutated cost context cannot bypass existing-exposure hold", () => {
  const f = fixture();
  f.book.sources = [source(f.seed)];
  observe(f.seed, f.book);
  const c = projected(f),
    r = request(f);
  assert.throws(
    () => assertCostExposure(structuredClone(c), c.state),
    /UNVERIFIED/,
  );
  c.openRiskKrw = "0";
  assert.ok(
    evaluateCostSizing(c.state, f.p, r, undefined, c).reasons.includes(
      "UNVERIFIED_COST_EXPOSURE",
    ),
  );
  assert.ok(
    evaluateCostSizing(c.state, f.p, r).reasons.includes(
      "EXISTING_EXPOSURE_COST_UNRECONCILED",
    ),
  );
});
for (const failure of [
  "mark-stale",
  "mark-future",
  "future-event",
  "expired-source",
  "wrong-opening",
  "duplicate",
  "account",
  "counter",
  "seed-hash",
  "period",
  "fx-stale",
] as const)
  test(`CAD-12 malformed or incomplete risk source ${failure}`, () => {
    const f = fixture();
    f.book.sources = [source(f.seed)];
    observe(f.seed, f.book);
    const a = f.book.sources[0]!;
    let reason = "";
    if (failure === "mark-stale") {
      a.observation.at = f.seed.clock - 2001;
      reason = "RISK_MARK_STALE";
    }
    if (failure === "mark-future") {
      a.observation.at++;
      reason = "RISK_MARK_STALE";
    }
    if (failure === "future-event") {
      a.events[1]!.at = f.seed.clock + 1;
      reason = "RISK_SOURCE_TIME";
    }
    if (failure === "expired-source") {
      a.config.horizonEnd = f.seed.clock - 1;
      reason = "RISK_SOURCE_TIME";
    }
    if (failure === "wrong-opening") {
      a.config.execution.initialCash = "5000001";
      reason = "JOURNAL_OPENING_MISMATCH";
    }
    if (failure === "duplicate") {
      f.book.sources.push(structuredClone(a));
      reason = "DUPLICATE_RISK_SOURCE";
    }
    if (failure === "account") {
      const b = source(f.seed, "SECOND");
      b.config.sourceScope.account = "another";
      f.book.sources.push(b);
      reason = "ACCOUNT_SCOPE_MISMATCH";
    }
    if (failure === "counter") {
      f.seed.ledger.entries = 0;
      f.book.seedHash = hash(f.seed);
      reason = "RISK_COUNTER_EVIDENCE_INCOMPLETE";
    }
    if (failure === "seed-hash") {
      f.book.seedHash = "0".repeat(64);
      reason = "RISK_SEED_BINDING_MISMATCH";
    }
    if (failure === "period") {
      f.book.initialAt -= 86400000;
      reason = "RISK_PERIOD_HISTORY_REQUIRED";
    }
    if (failure === "fx-stale") {
      f.seed.ledger.fxAt = f.seed.clock - 60001;
      f.book.seedHash = hash(f.seed);
      reason = "RISK_ACCOUNT_OR_FX_STALE";
    }
    held(f, reason);
  });
for (const protection of [
  "REGISTERED_PENDING_VERIFY",
  "EXIT_WORKING",
  "PROTECTION_SUBMIT_UNKNOWN",
] as const)
  test(`CAD-13 protection ${protection} never becomes WATCHING implicitly`, () => {
    const f = fixture();
    f.book.sources = [source(f.seed)];
    f.book.sources[0]!.observation.protection = protection;
    observe(f.seed, f.book);
    const c = projected(f);
    assert.equal(c.state.positions[0]!.protection, protection);
    assert.ok(
      reviewCostAdmission(f.seed, f.book, f.p, request(f)).reasons.includes(
        "PROTECTION_OR_STOP_PENDING",
      ),
    );
  });
test("CAD-14 missing or insufficient protective quantity blocks new exposure", () => {
  const f = fixture();
  f.book.sources = [source(f.seed)];
  f.book.sources[0]!.observation.protectedQuantity = 0;
  observe(f.seed, f.book);
  assert.ok(
    reviewCostAdmission(f.seed, f.book, f.p, request(f)).reasons.includes(
      "PROTECTION_OR_STOP_PENDING",
    ),
  );
  const raw = structuredClone(f.book);
  Reflect.deleteProperty(raw.sources[0]!.observation, "protection");
  assert.equal(buildCostExposure(f.seed, raw).status, "HOLD");
});
test("CAD-15 source hashes bind a same-money fee profile change", () => {
  const f = fixture();
  f.book.sources = [source(f.seed)];
  observe(f.seed, f.book);
  const r = request(f),
    n = issueCostAdmissionReview(f.seed, f.book, f.p, r),
    a = projected(f);
  f.book.sources[0]!.config.execution.profile.id = "different";
  const b = projected(f);
  assert.equal(a.openRiskKrw, b.openRiskKrw);
  assert.deepEqual(a.available, b.available);
  assert.notEqual(a.sourceHash, b.sourceHash);
  r.stateHash = b.stateHash;
  assert.equal(
    recheckCostAdmission(n, f.seed, f.book, f.p, r).status,
    "REAPPROVAL_REQUIRED",
  );
});
test("CAD-16 policy headroom expression remains shared, including halts and exposure", () => {
  const f = fixture();
  assert.equal(
    remainingRisk(f.seed),
    remainingRiskForExposure(f.seed, openRisk(f.seed).toString()),
  );
  f.seed.ledger.halts = ["DAY_LOSS_HALT"];
  f.book.seedHash = hash(f.seed);
  assert.ok(
    reviewCostAdmission(f.seed, f.book, f.p, request(f)).reasons.includes(
      "DAY_LOSS_HALT",
    ),
  );
  assert.throws(() => remainingRiskForExposure(f.seed, "-1"), /INVALID/);
});
for (const rounding of ["UP", "DOWN", "HALF_EVEN"] as const)
  test(`CAD-17 ${rounding} fee bound covers all four-share partitions, unlike scenario estimate`, () => {
    const p = costProfile();
    p.rules.forEach((v) => {
      v.unit = "FILL";
      v.rounding = rounding;
      if (v.component === "COMMISSION") {
        v.minimum = "1";
        v.fixed = "0.3";
        v.tiers = [
          { upTo: "10000", rate: "0" },
          { upTo: null, rate: "3000" },
        ];
      }
    });
    for (let mask = 0; mask < 8; mask++)
      for (const side of ["BUY", "SELL"] as const) {
        const pieces: number[] = [];
        let size = 1;
        for (let i = 0; i < 3; i++) {
          if (mask & (1 << i)) {
            pieces.push(size);
            size = 1;
          } else size++;
        }
        pieces.push(size);
        const actual = evaluateOrderCost(p, {
          contract: costKernelContract,
          purpose: "TEST_ONLY",
          provenance: "SYNTHETIC_FIXTURE",
          policyHash: fxturePolicy(),
          profileHash: hash(p),
          scope: p.scope,
          asOf: costAt,
          mode: "CHARGE_ONLY",
          order: {
            id: "o",
            side,
            quantity: 4,
            limit: "10000",
            at: costAt,
            terminal: true,
          },
          fills: pieces.map((q, i) => ({
            id: `f${i}`,
            orderId: "o",
            quantity: q,
            price: "10000",
            occurredAt: costAt,
            availableAt: costAt,
          })),
        });
        assert.equal(actual.status, "OK");
        if (actual.status === "OK")
          assert.ok(
            d(estimateFeeBound(p, side, 4, "10000", costAt)).gte(
              actual.charges.total,
            ),
          );
      }
  });
function fxturePolicy() {
  return fixture().book.policyHash;
}
test("CAD-21 fee reservation must not manufacture a reduction in foreign assets", () => {
  const f = fixture("US");
  f.seed.config!.capital = 4875000;
  f.seed.config!.usdCapitalKrw = 1950000;
  f.seed.ledger.wallets.KRW.cash = "2925000";
  f.seed.ledger.wallets.USD.cash = "1500";
  f.seed.ledger.units = "4875000";
  for (const p of Object.values(f.seed.ledger.periods))
    p.startEquity = "4875000";
  f.seed.ledger.fx = "1300.002";
  f.book.seedHash = hash(f.seed);
  for (const rule of f.p.rules) {
    rule.minimum = "0";
    if (rule.side === "BUY" && rule.component === "COMMISSION") {
      rule.unit = "FILL";
      rule.tiers = [
        { upTo: "40", rate: "0" },
        { upTo: null, rate: "1000" },
      ];
    }
  }
  const r = request(f);
  r.forecast.expectedExit = "100";
  const result = reviewCostAdmission(f.seed, f.book, f.p, r);
  assert.equal(result.status, "HOLD");
  assert.ok(result.reasons.includes("FOREIGN_EXPOSURE"));
});
test("CAD-18 exhausted shared risk leaves zero candidate, not a negative or overwritten reservation", () => {
  const f = fixture();
  const a = source(f.seed, "FIRST", "KR", 500, 500);
  a.observation.stop = "9000";
  f.book.sources = [a];
  observe(f.seed, f.book);
  // 500 shares at 10000 exceeds capital after fees; a smaller explicit case
  // remains affordable but consumes the correlated risk budget.
  if (a.events[0]!.kind === "ORDER") a.events[0]!.quantity = 200;
  if (a.events[1]!.kind === "FILL") a.events[1]!.quantity = 200;
  a.observation.protectedQuantity = 200;
  const c = projected(f);
  assert.equal(c.budgetKrw, "0");
  const n = reviewCostAdmission(f.seed, f.book, f.p, request(f));
  assert.equal(n.status, "HOLD");
  assert.equal(n.sizing!.quantity, 0);
});
test("CAD-19 existing symbol cannot be silently treated as another entry chain", () => {
  const f = fixture();
  f.book.sources = [source(f.seed)];
  observe(f.seed, f.book);
  const r = request(f);
  r.symbol = "FIRST";
  assert.ok(
    reviewCostAdmission(f.seed, f.book, f.p, r).reasons.includes(
      "EXISTING_SYMBOL_REENTRY_UNSUPPORTED",
    ),
  );
});
test("CAD-20 R0 remains price risk, not fee-inclusive reservation risk", () => {
  const f = fixture();
  f.p.rules.forEach((v) => {
    v.minimum = "0";
    v.fixed = "0";
    v.quantum = "0.000001";
  });
  const r = request(f);
  r.quote.askSize = 10;
  r.forecast.expectedExit = "10013";
  r.forecast.q05Exit = "9950";
  assert.equal(
    reviewCostAdmission(f.seed, f.book, f.p, r).status,
    "RESEARCH_CANDIDATE",
  );
  r.forecast.expectedExit = "10012.9";
  assert.equal(reviewCostAdmission(f.seed, f.book, f.p, r).status, "HOLD");
  assert.equal(policy.economic_gate.minimum_expected_net_r, 0.2);
});
test("CAD-22 protection cannot exceed replayed holdings", () => {
  const f = fixture();
  f.book.sources = [source(f.seed)];
  observe(f.seed, f.book);
  f.book.sources[0]!.observation.protectedQuantity = 2;
  held(f, "PROTECTION_QUANTITY_MISMATCH");
});
test("CAD-23 SELL shortfall payable and remaining SELL reserve both reduce shared cash", () => {
  const f = fixture(),
    a = source(f.seed, "FIRST", "KR", 4, 4);
  for (const e of a.events) {
    if (e.kind === "ORDER") e.limit = "100";
    if (e.kind === "FILL") e.price = "100";
  }
  a.config.execution.profile.rules.forEach((r) => {
    r.tiers[0]!.rate = "0";
    if (r.side === "SELL" && r.component === "COMMISSION") {
      r.unit = "FILL";
      r.minimum = "150";
    }
  });
  a.events.push(
    { kind: "SETTLE", id: "settle", seq: 3, at: costAt + 3, fillIds: ["f1"] },
    {
      kind: "ORDER",
      id: "sell-e",
      seq: 4,
      at: costAt + 4,
      orderId: "sell",
      side: "SELL",
      quantity: 4,
      limit: "100",
      replaces: null,
    },
    {
      kind: "FILL",
      id: "sell-f",
      seq: 5,
      at: costAt + 5,
      orderId: "sell",
      fillId: "sf1",
      quantity: 1,
      price: "100",
      occurredAt: costAt + 5,
    },
  );
  a.observation = {
    at: f.seed.clock,
    bid: "100",
    stop: "95",
    protection: "WATCHING",
    protectedQuantity: 3,
  };
  f.book.sources = [a];
  observe(f.seed, f.book);
  const c = projected(f),
    j = replayCostJournal(a.config, a.events);
  assert.equal(j.wallet.payable, "50");
  assert.ok(d(j.reservedCash).gt(0));
  assert.equal(
    c.available.KRW,
    d(c.state.ledger.wallets.KRW.cash)
      .minus(50)
      .minus(j.reservedCash)
      .toString(),
  );
  const review = reviewCostAdmission(f.seed, f.book, f.p, request(f));
  assert.equal(review.exposure!.available.KRW, c.available.KRW);
  assert.equal(review.status, "HOLD");
  assert.ok(review.reasons.includes("EXIT_CHAIN_REQUIRES_RECONCILIATION"));
});
for (const unit of ["ORDER", "FILL"] as const)
  for (const rounding of ["UP", "DOWN", "HALF_EVEN"] as const)
    test(`CAD-24 ${unit} ${rounding} future exits cover up to three charged orders and partial fills`, () => {
      const p = costProfile();
      p.rules.forEach((r) => {
        r.unit = unit;
        r.rounding = rounding;
        if (r.component === "COMMISSION") {
          r.minimum = "10";
          r.fixed = "0.3";
          r.tiers = [
            { upTo: "15000", rate: "0" },
            { upTo: null, rate: "5" },
          ];
        }
      });
      const bound = estimateFeeBound(p, "SELL", 4, "10000", costAt, 3);
      assert.equal(estimateFeeBound(p, "SELL", 0, "10000", costAt, 3), "0");
      assert.equal(
        estimateFeeBound(p, "SELL", 1, "10000", costAt, 3),
        estimateFeeBound(p, "SELL", 1, "10000", costAt),
      );
      for (let mask = 0; mask < 8; mask++) {
        const quantities: number[] = [];
        let n = 1;
        for (let i = 0; i < 3; i++) {
          if (mask & (1 << i)) {
            quantities.push(n);
            n = 1;
          } else n++;
        }
        quantities.push(n);
        if (quantities.length > 3) continue;
        for (const partial of [false, true]) {
          let total = d(0);
          for (const [i, q] of quantities.entries()) {
            const groups = partial ? Array.from({ length: q }, () => 1) : [q];
            const actual = evaluateOrderCost(p, {
              contract: costKernelContract,
              purpose: "TEST_ONLY",
              provenance: "SYNTHETIC_FIXTURE",
              policyHash: fxturePolicy(),
              profileHash: hash(p),
              scope: p.scope,
              asOf: costAt,
              mode: "CHARGE_ONLY",
              order: {
                id: `o${i}`,
                side: "SELL",
                quantity: q,
                limit: "10000",
                at: costAt,
                terminal: true,
              },
              fills: groups.map((q, j) => ({
                id: `f${i}-${j}`,
                orderId: `o${i}`,
                quantity: q,
                price: "10000",
                occurredAt: costAt,
                availableAt: costAt,
              })),
            });
            assert.equal(actual.status, "OK");
            if (actual.status === "OK")
              total = total.plus(actual.charges.total);
          }
          assert.ok(
            d(bound).gte(total),
            `${quantities} partial=${partial}: ${bound}<${total}`,
          );
        }
      }
    });
test("CAD-25 risk includes repeat ORDER minimum costs after possible exit replacements", () => {
  const f = fixture(),
    a = source(f.seed, "FIRST", "KR", 3, 3);
  a.observation.protectedQuantity = 3;
  f.book.sources = [a];
  observe(f.seed, f.book);
  const c = projected(f),
    fees = estimateFeeBound(
      a.config.execution.profile,
      "SELL",
      3,
      "10000",
      f.seed.clock,
      3,
    );
  assert.ok(d(fees).gte(30));
  assert.equal(
    c.entries[0]!.heldRiskKrw,
    d(150)
      .plus(fees)
      .plus(d(30000).mul(profile.fees.exitAdverseBps).div(10000))
      .toString(),
  );
  const r = request(f),
    s = reviewCostAdmission(f.seed, f.book, f.p, r).sizing!;
  if (s.candidate)
    assert.ok(
      d(s.candidate.riskTradingCostUpperKrw!).gte(
        s.candidate.stopTradingCostKrw,
      ),
    );
});
test("CAD-26 current drawdown reduction is reused without resetting explicit history", () => {
  const f = fixture();
  f.seed.ledger.highNav = "1.03";
  f.book.seedHash = hash(f.seed);
  const c = projected(f);
  assert.equal(c.state.ledger.drawdownReduced, true);
  assert.equal(f.seed.ledger.drawdownReduced, false);
  assert.equal(c.state.ledger.highNav, "1.03");
  assert.ok(d(c.budgetKrw).lte(remainingRisk(f.seed)));
});
test("CAD-27 expiry and unsupported decimal are HOLD, not repaired", () => {
  const f = fixture(),
    r = request(f),
    n = issueCostAdmissionReview(f.seed, f.book, f.p, r);
  f.p.effectiveTo = f.seed.clock;
  r.profileHash = hash(f.p);
  const stale = recheckCostAdmission(n, f.seed, f.book, f.p, r);
  assert.equal(stale.status, "REAPPROVAL_REQUIRED");
  assert.ok(stale.current.reasons.includes("COST_TIME_MISMATCH"));
  const bad = fixture("US");
  bad.book.sources = [source(bad.seed, "FIRST", "US")];
  bad.book.sources[0]!.config.execution.initialCash = "300.123456789012345";
  observe(bad.seed, bad.book);
  held(bad, "INVALID_COST_RISK_BOOK");
});
