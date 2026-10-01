import { test } from "node:test";
import assert from "node:assert/strict";
import { hash } from "../src/core/policy.js";
import { d } from "../src/core/math.js";
import { replayCostExecutions } from "../src/core/cost-execution.js";
import type {
  CostExecutionConfig,
  CostExecutionEvent,
} from "../src/core/cost-execution.js";
import { executionConfig, executionEvents } from "./cost-execution-helpers.js";

function replay(config: unknown, events: unknown) {
  const before = hash({ config, events }),
    result = replayCostExecutions(config, events);
  assert.equal(hash({ config, events }), before);
  assert.equal(result.orderSubmissionAllowed, false);
  assert.equal(result.learningAllowed, false);
  assert.equal(result.liveEnabled, false);
  return result;
}
function ok(events = executionEvents(), config = executionConfig()) {
  const result = replay(config, events);
  assert.equal(result.status, "OK", JSON.stringify(result));
  if (result.status !== "OK") throw Error("expected OK");
  return result;
}
function hold(
  events: unknown,
  reason: string,
  config: unknown = executionConfig(),
) {
  assert.deepEqual(replay(config, events), {
    status: "HOLD",
    reasons: [reason],
    orderSubmissionAllowed: false,
    learningAllowed: false,
    liveEnabled: false,
  });
}
test("CEX-01 cumulative order minimum is posted once across partial fills", () => {
  const events = executionEvents();
  const expected = [
    ["100000", "4010", 0],
    ["98990", "3000", 1],
    ["97990", "2000", 2],
    ["97990", "2000", 2],
    ["97990", "2000", 2],
    ["97990", "0", 2],
  ] as const;
  for (const [i, [cash, reserve, quantity]] of expected.entries()) {
    const r = ok(events.slice(0, i + 1));
    assert.equal(r.cash, cash);
    assert.equal(r.reservedCash, reserve);
    assert.equal(r.quantity, quantity);
  }
  const r = ok(events.slice(0, 3));
  assert.deepEqual(
    r.fills.map((f) => f.feeDelta),
    ["10", "0"],
  );
});
for (const [unit, fees, pnl] of [
  ["ORDER", "30", "170"],
  ["FILL", "40", "160"],
] as const)
  test(`CEX-02 ${unit} whole sequence report and evidence use same native costs`, () => {
    const r = ok(executionEvents(), executionConfig(unit));
    assert.equal(r.report.tradingFees, fees);
    assert.equal(r.report.tradingNetPnl, pnl);
    assert.equal(r.cash, String(100000 + Number(pnl)));
    assert.equal(r.quantity, 0);
    assert.equal(r.reservedCash, "0");
    assert.equal(r.reservedSellQuantity, 0);
    assert.equal(r.report.costBasisHash, r.learningEvidence.costBasisHash);
    assert.equal(r.report.tradingFees, r.learningEvidence.tradingFees);
    assert.equal(r.report.tradingNetPnl, r.learningEvidence.tradingNetPnl);
    assert.equal(r.learningEvidence.status, "HOLD");
    assert.ok(
      r.learningEvidence.reasons.includes(
        "OPERATING_COST_ALLOCATION_UNSUPPORTED",
      ),
    );
  });
test("CEX-03 minimum to proportional transition charges incremental five, not fifteen", () => {
  const c = executionConfig();
  c.profile.rules
    .filter((r) => r.component === "COMMISSION")
    .forEach((r) => {
      r.minimum = "15";
      r.tiers[0]!.rate = "100";
    });
  const r = ok(executionEvents().slice(0, 3), c);
  assert.deepEqual(
    r.fills.map((f) => f.feeDelta),
    ["15", "5"],
  );
  assert.equal(r.reservedCash, "2020");
  assert.equal(r.cash, "97980");
});
test("CEX-04 exact event retries and duplicate execution receipts never charge again", () => {
  const e = executionEvents().slice(0, 3),
    r = ok(e);
  assert.deepEqual(ok([...e, e[1]!]), r);
  const duplicate = { ...e[1]!, id: "receipt-2", seq: 4, at: e[2]!.at + 1 };
  const after = ok([...e, duplicate]);
  assert.equal(after.cash, r.cash);
  assert.equal(after.fills.length, 2);
  assert.equal(after.report.tradingFees, r.report.tradingFees);
});
test("CEX-05 conflicting event/fill IDs hold without overwriting", () => {
  const e = executionEvents().slice(0, 3);
  hold([...e, { ...e[1]!, at: e[1]!.at + 1 }], "EXECUTION_EVENT_ID_CONFLICT");
  const changed = {
    ...e[1]!,
    id: "different-receipt",
    seq: 4,
    at: e[2]!.at + 1,
  };
  if (changed.kind !== "FILL") throw Error();
  changed.price = "999";
  hold([...e, changed], "EXECUTION_FILL_ID_CONFLICT");
});
test("CEX-06 per-fill minimum uses real fill quantity, not one-share scenario fiction", () => {
  const e = executionEvents().slice(0, 2);
  const f = e[1]!;
  if (f.kind !== "FILL") throw Error();
  f.quantity = 2;
  const r = ok(e, executionConfig("FILL"));
  assert.equal(r.report.tradingFees, "10");
  assert.equal(r.reservedCash, "2020");
  assert.equal(r.quantity, 2);
});
test("CEX-07 no-fill cancel releases reservation and creates no fee or completed trade", () => {
  const e = executionEvents();
  const cancel = e[5]!;
  if (cancel.kind !== "CANCEL_CONFIRMED") throw Error();
  const r = ok([
    e[0]!,
    {
      ...cancel,
      id: "cancel-empty",
      seq: 2,
      cumulativeQuantity: 0,
      cumulativeValue: "0",
    },
  ]);
  assert.equal(r.cash, "100000");
  assert.equal(r.reservedCash, "0");
  assert.equal(r.report.tradingFees, "0");
  assert.equal(r.report.tradingNetPnl, null);
});
for (const kind of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  test(`CEX-08 ${kind} keeps BUY reservation and blocks new orders`, () => {
    const e = executionEvents().slice(0, 5);
    e[4] = { ...e[4]!, kind };
    const r = ok(e);
    assert.equal(r.orders[0]!.status, kind);
    assert.equal(r.reservedCash, "2000");
    const later = {
      ...e[4]!,
      id: "still-unknown",
      seq: 6,
      at: e[4]!.at + 1000,
    };
    assert.equal(ok([...e, later]).reservedCash, "2000");
    const sell = executionEvents()[6]!;
    hold([...e, { ...sell, seq: 6 }], "UNRESOLVED_ORDER_NO_NEW_ORDER");
  });
test("CEX-09 delayed fill during cancel unknown adjusts actuals, not cancellation certainty", () => {
  const e = executionEvents().slice(0, 5),
    at = e[4]!.at + 1;
  const f: CostExecutionEvent = {
    kind: "FILL",
    id: "late",
    seq: 6,
    at,
    orderId: "buy",
    fillId: "late-fill",
    quantity: 1,
    price: "1000",
    occurredAt: e[3]!.at,
  };
  const r = ok([...e, f]);
  assert.equal(r.orders[0]!.status, "CANCEL_UNKNOWN");
  assert.equal(r.quantity, 3);
  assert.equal(r.reservedCash, "1000");
  assert.equal(r.cash, "96990");
  const cancel = executionEvents()[5]!;
  hold(
    [...e, f, { ...cancel, seq: 7, at: at + 1 }],
    "CANCEL_EVIDENCE_MISMATCH",
  );
});
test("CEX-10 terminal proof must match quantities, value and latest evidence time", () => {
  for (const change of [
    { cumulativeQuantity: 1 },
    { cumulativeValue: "1999" },
    { evidenceAt: 0 },
  ]) {
    const e = executionEvents().slice(0, 6);
    e[5] = { ...e[5]!, ...change };
    hold(e, "CANCEL_EVIDENCE_MISMATCH");
  }
});
test("CEX-11 SELL reservation survives unknown; replacement needs confirmed cancel", () => {
  const e = executionEvents().slice(0, 9),
    at = e[8]!.at + 1;
  const u: CostExecutionEvent = {
    id: "sell-unknown",
    seq: 10,
    at,
    kind: "CANCEL_UNKNOWN",
    orderId: "sell",
  };
  const r = ok([...e, u]);
  assert.equal(r.reservedSellQuantity, 1);
  assert.equal(r.quantity, 1);
  assert.equal(r.report.tradingNetPnl, null);
  hold(
    [...e, u, { ...executionEvents()[10]!, seq: 11, at: at + 1 }],
    "UNRESOLVED_ORDER_NO_NEW_ORDER",
  );
  hold(
    [...e, { ...executionEvents()[10]!, seq: 10, at }],
    "REPLACEMENT_REQUIRES_CONFIRMED_REMAINDER",
  );
});
test("CEX-12 replacement cannot exceed confirmed remainder or branch one cancel twice", () => {
  const e = executionEvents().slice(0, 11);
  const replace = e[10]!;
  if (replace.kind !== "ORDER") throw Error();
  replace.quantity = 2;
  hold(e, "REPLACEMENT_REQUIRES_CONFIRMED_REMAINDER");
  replace.quantity = 1;
  hold(
    [
      ...e,
      {
        ...replace,
        id: "branch",
        seq: 12,
        at: replace.at + 1,
        orderId: "branch-order",
      },
    ],
    "REPLACEMENT_REQUIRES_CONFIRMED_REMAINDER",
  );
});
test("CEX-13 no oversell, overfill, limit violation, or fill after final cancellation", () => {
  const e = executionEvents();
  const over = e[6]!;
  if (over.kind !== "ORDER") throw Error();
  over.quantity = 3;
  hold(e.slice(0, 7), "OVERSELL_OR_RESERVED_QUANTITY");
  for (const [quantity, price, reason] of [
    [5, "1000", "OVERFILL"],
    [1, "1001", "FILL_LIMIT_VIOLATION"],
  ] as const) {
    const v = executionEvents().slice(0, 2);
    const f = v[1]!;
    if (f.kind !== "FILL") throw Error();
    f.quantity = quantity;
    f.price = price;
    hold(v, reason);
  }
  const v = executionEvents().slice(0, 6),
    f = executionEvents()[2]!;
  if (f.kind !== "FILL") throw Error();
  hold(
    [
      ...v,
      {
        ...f,
        id: "after-cancel",
        seq: 7,
        at: v[5]!.at + 1,
        fillId: "new-late-fill",
      },
    ],
    "FILL_AFTER_CONFIRMED_TERMINAL",
  );
});
test("CEX-14 order cash includes pending fees; unavailable funds never create an order", () => {
  const c = executionConfig();
  c.initialCash = "4009";
  hold(executionEvents().slice(0, 1), "INSUFFICIENT_SYNTHETIC_CASH", c);
  c.initialCash = "4010";
  const r = ok(executionEvents().slice(0, 1), c);
  assert.equal(r.availableCash, "0");
});
test("CEX-15 received sequence and occurrence/availability time are checked separately", () => {
  const e = executionEvents().slice(0, 2);
  hold([e[1]!], "EXECUTION_SEQUENCE_GAP");
  hold(
    [e[0]!, { ...e[1]!, at: e[0]!.at - 1 }],
    "EXECUTION_TIME_REGRESSION_OR_EXPIRY",
  );
  const f = e[1]!;
  if (f.kind !== "FILL") throw Error();
  f.occurredAt = f.at + 1;
  hold(e, "FILL_TIME_INVALID");
});
test("CEX-16 strict malformed inputs do not throw decimal parsing errors", () => {
  const e = executionEvents();
  hold([{ ...e[0], limit: "abc" }], "INVALID_EXECUTION_EVENTS");
  const c = executionConfig();
  c.profile.rules[0]!.quantum = "abc";
  hold([], "INVALID_EXECUTION_CONFIG", c);
  hold([{ ...e[0], apiKey: "dummy" }], "INVALID_EXECUTION_EVENTS");
  hold(Array(501).fill(e[0]), "INVALID_EXECUTION_EVENTS");
});
test("CEX-17 unsupported DAY/FX and real profiles stay held", () => {
  for (const unit of ["DAY", "FX"] as const) {
    const c = executionConfig();
    if (unit === "DAY") c.profile.rules[0]!.unit = unit;
    else
      c.profile.rules.push({
        ...c.profile.rules[0]!,
        id: "fx",
        unit,
        side: "FX",
        component: "FX",
      });
    hold([], "EXECUTION_CHARGE_UNIT_UNSUPPORTED", c);
  }
  hold([], "INVALID_EXECUTION_CONFIG", {
    ...executionConfig(),
    provenance: "REAL",
  });
});
test("CEX-18 US native cash keeps cents and never auto-converts to KRW", () => {
  const c = executionConfig("ORDER", "US");
  c.profile.rules
    .filter((r) => r.component === "COMMISSION")
    .forEach((r) => {
      r.minimum = "0.01";
    });
  const r = ok(executionEvents(), c);
  assert.equal(r.currency, "USD");
  assert.equal(r.report.tradingFees, "0.03");
  assert.equal(r.cash, "100199.97");
  assert.equal(r.report.tradingNetPnl, "199.97");
});
test("CEX-19 repeated replay is deterministic and unclosed outcomes are not labels", () => {
  const e = executionEvents();
  assert.deepEqual(ok(e), ok(structuredClone(e)));
  for (let n = 0; n < e.length; n++) {
    const r = ok(e.slice(0, n));
    assert.equal(r.report.tradingNetPnl, null);
    assert.ok(r.learningEvidence.reasons.includes("TRADE_NOT_CLOSED"));
  }
});
test("CEX-20 expired fee profile never falls back to old rates", () => {
  const c = executionConfig();
  c.profile.effectiveTo = c.initialAt;
  hold([], "EXECUTION_PROFILE_TIME", c);
  const c2 = executionConfig();
  c2.profile.effectiveTo = c2.initialAt + 2;
  hold(
    executionEvents().slice(0, 2),
    "EXECUTION_TIME_REGRESSION_OR_EXPIRY",
    c2,
  );
});

test("CEX-REVIEW increasing per-fill tiers cannot under-reserve using one-share fills", () => {
  const c = executionConfig("FILL");
  c.initialCash = "5000";
  c.profile.rules[0]!.minimum = "0";
  c.profile.rules[0]!.tiers = [
    { upTo: "1000", rate: "0" },
    { upTo: null, rate: "10000" },
  ];
  hold(executionEvents().slice(0, 1), "INSUFFICIENT_SYNTHETIC_CASH", c);
});
test("CEX-REVIEW a fresh SELL root cannot bypass replacement ancestry", () => {
  const e = executionEvents().slice(0, 11),
    next = e[10]!;
  if (next.kind !== "ORDER") throw Error();
  next.replaces = null;
  hold(e, "SELL_REPLACEMENT_LINK_REQUIRED");
});

test("CEX-REVIEW SELL fees exceeding proceeds require cash before order acceptance", () => {
  const c = executionConfig();
  c.initialCash = "4000";
  c.profile.rules.forEach((r) => {
    r.minimum =
      r.side === "SELL" && r.component === "COMMISSION" ? "4100" : "0";
  });
  const e = executionEvents().slice(0, 2),
    buy = e[1]!;
  if (buy.kind !== "FILL") throw Error();
  buy.quantity = 4;
  const sell = executionEvents()[6]!;
  if (sell.kind !== "ORDER") throw Error();
  hold(
    [...e, { ...sell, seq: 3, quantity: 4, limit: "1000" }],
    "INSUFFICIENT_SYNTHETIC_CASH",
    c,
  );
});

function partitions(n: number): number[][] {
  if (n === 0) return [[]];
  return Array.from({ length: n }, (_, i) => i + 1).flatMap((k) =>
    partitions(n - k).map((rest) => [k, ...rest]),
  );
}
function filledRoundTrip(
  buyParts: number[],
  sellParts: number[],
  sellPrice = "1000",
): CostExecutionEvent[] {
  const events: CostExecutionEvent[] = [],
    at = executionConfig().initialAt;
  for (const [side, parts] of [
    ["BUY", buyParts],
    ["SELL", sellParts],
  ] as const) {
    if (!parts.length) continue;
    let seq = events.length + 1;
    events.push({
      id: `event-${seq}`,
      seq,
      at: at + seq,
      kind: "ORDER",
      orderId: side,
      side,
      quantity: 4,
      limit: "1000",
      replaces: null,
    });
    for (const q of parts) {
      seq = events.length + 1;
      events.push({
        id: `event-${seq}`,
        seq,
        at: at + seq,
        kind: "FILL",
        orderId: side,
        fillId: `fill-${seq}`,
        quantity: q,
        price: side === "BUY" ? "1000" : sellPrice,
        occurredAt: at + seq,
      });
    }
  }
  return events;
}

for (const rounding of ["UP", "DOWN", "HALF_EVEN"] as const) {
  test(`CEX-21 BUY reservation covers all eight four-share partitions with ${rounding}`, () => {
    const c = executionConfig("FILL");
    c.profile.rules.forEach((r) => {
      r.rounding = rounding;
      r.quantum = "0.3";
    });
    const commission = c.profile.rules[0]!;
    commission.basis = "SHARES";
    commission.minimum = "0.5";
    commission.fixed = "0.1";
    commission.tiers = [
      { upTo: "1", rate: "0" },
      { upTo: null, rate: "100.15" },
    ];
    const tax = c.profile.rules[1]!;
    tax.unit = "ORDER";
    tax.minimum = "1.1";
    tax.tiers = [
      { upTo: "1000", rate: "10" },
      { upTo: null, rate: "30" },
    ];
    const order = filledRoundTrip([4], []).slice(0, 1);
    c.initialCash = ok(order, c).reservedCash;
    for (const p of partitions(4)) {
      const r = ok(filledRoundTrip(p, []), c);
      assert.equal(r.reservedCash, "0");
      assert.ok(d(r.cash).gte(0));
      assert.equal(r.quantity, 4);
    }
  });
  test(`CEX-22 SELL prefix cash covers ORDER shares and FILL rounding with ${rounding}`, () => {
    for (const unit of ["ORDER", "FILL"] as const) {
      const c = executionConfig();
      c.profile.rules.forEach((r) => {
        r.minimum = "0";
        r.rounding = rounding;
        r.quantum = "0.3";
      });
      const commission = c.profile.rules.find(
        (r) => r.side === "SELL" && r.component === "COMMISSION",
      )!;
      commission.unit = unit;
      commission.basis = "SHARES";
      commission.minimum = "1100.1";
      commission.fixed = "0.2";
      commission.tiers = [
        { upTo: "1", rate: "0" },
        { upTo: null, rate: "1500.15" },
      ];
      const tax = c.profile.rules.find(
        (r) => r.side === "SELL" && r.component === "TAX",
      )!;
      tax.tiers[0]!.rate = "5000";
      const exchange = c.profile.rules.find(
        (r) => r.side === "SELL" && r.component === "EXCHANGE",
      )!;
      exchange.unit = "FILL";
      exchange.fixed = "0.1";
      exchange.minimum = "2.2";
      exchange.tiers = [
        { upTo: "1000", rate: "100" },
        { upTo: null, rate: "200" },
      ];
      const order = filledRoundTrip([4], [4]).slice(0, 3);
      c.initialCash = d(4000).plus(ok(order, c).reservedCash).toString();
      for (const p of partitions(4))
        for (const price of ["1000", "1200"]) {
          const r = ok(filledRoundTrip([4], p, price), c);
          assert.equal(r.quantity, 0);
          assert.equal(r.reservedCash, "0");
          assert.ok(d(r.cash).gte(0));
        }
    }
  });
}

test("CEX-23 SELL rejects unbounded notional cost exposure before recording an order", () => {
  const c = executionConfig();
  c.profile.rules
    .filter((r) => r.side === "SELL")
    .forEach((r) => {
      r.tiers[0]!.rate = "4000";
    });
  hold(filledRoundTrip([4], [4]).slice(0, 3), "SELL_COST_BOUND_UNSUPPORTED", c);
});

test("CEX-REVIEW single exit chain cannot strand holdings through undersized SELL orders", () => {
  const e = filledRoundTrip([4], [4]).slice(0, 3),
    sell = e[2]!;
  if (sell.kind !== "ORDER") throw Error();
  sell.quantity = 2;
  hold(e, "FULL_EXIT_QUANTITY_REQUIRED");
  const prefix = executionEvents().slice(0, 7),
    original = prefix[6]!;
  if (original.kind !== "ORDER") throw Error();
  prefix.push({
    id: "cancel-whole",
    seq: 8,
    at: original.at + 1,
    kind: "CANCEL_CONFIRMED",
    orderId: "sell",
    cumulativeQuantity: 0,
    cumulativeValue: "0",
    evidenceAt: original.at + 1,
  });
  prefix.push({
    ...original,
    id: "undersized-replace",
    seq: 9,
    at: original.at + 2,
    orderId: "under",
    quantity: 1,
    replaces: "sell",
  });
  hold(prefix, "FULL_EXIT_QUANTITY_REQUIRED");
});

test("CEX-24 third SELL replacement is rejected without changing the original limit", () => {
  const e = executionEvents().slice(0, 11),
    origin = e[10]!;
  if (origin.kind !== "ORDER") throw Error();
  for (let replacement = 2; replacement <= 3; replacement++) {
    const previous = replacement === 2 ? "sell-replace" : "replace-2";
    let seq = e.length + 1,
      at = e.at(-1)!.at + 1;
    e.push({
      id: `cancel-${replacement}`,
      seq,
      at,
      kind: "CANCEL_CONFIRMED",
      orderId: previous,
      cumulativeQuantity: 0,
      cumulativeValue: "0",
      evidenceAt: at,
    });
    seq = e.length + 1;
    at++;
    e.push({
      ...origin,
      id: `replacement-${replacement}`,
      seq,
      at,
      orderId: `replace-${replacement}`,
      replaces: previous,
    });
    if (replacement === 2) assert.equal(ok(e).orders.at(-1)!.replacements, 2);
    else hold(e, "REPLACEMENT_LIMIT");
  }
});
// This static type ensures fixture configurations remain contract-compatible.
const fixtureType: CostExecutionConfig = executionConfig();
assert.equal(fixtureType.purpose, "TEST_ONLY");
