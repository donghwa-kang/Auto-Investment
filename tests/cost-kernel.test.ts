import { test } from "node:test";
import assert from "node:assert/strict";
import { d } from "../src/core/math.js";
import { hash, policyHash } from "../src/core/policy.js";
import {
  costKernelContract,
  evaluateOrderCost,
} from "../src/core/cost-kernel.js";
import type { CostKernelRequest } from "../src/core/cost-kernel.js";
import type { CostProfile } from "../src/core/transaction-cost.js";
import { executionConfig } from "./cost-execution-helpers.js";

function fixture(
  unit: "ORDER" | "FILL" = "ORDER",
  market: "KR" | "US" = "KR",
  side: "BUY" | "SELL" = "BUY",
) {
  const c = executionConfig(unit, market),
    p = c.profile;
  const r: CostKernelRequest = {
    contract: costKernelContract,
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    policyHash,
    profileHash: hash(p),
    scope: p.scope,
    asOf: c.initialAt + 10,
    mode: "WITH_RESERVATION",
    order: {
      id: "order",
      side,
      quantity: 4,
      limit: "1000",
      at: c.initialAt + 1,
      terminal: false,
    },
    fills: [],
  };
  return { p, r };
}
function filled(r: CostKernelRequest, parts: number[], price = r.order.limit) {
  return {
    ...r,
    fills: parts.map((quantity, i) => ({
      id: `f-${i}`,
      orderId: r.order.id,
      quantity,
      price,
      occurredAt: r.order.at + 1,
      availableAt: r.asOf,
    })),
  };
}
function evaluate(p: unknown, r: unknown) {
  const before = hash({ p, r }),
    result = evaluateOrderCost(p, r);
  assert.equal(hash({ p, r }), before);
  assert.equal(result.orderSubmissionAllowed, false);
  assert.equal(result.learningAllowed, false);
  assert.equal(result.liveEnabled, false);
  return result;
}
function ok(p: CostProfile, r: CostKernelRequest) {
  const result = evaluate(p, r);
  assert.equal(result.status, "OK", JSON.stringify(result));
  if (result.status !== "OK") throw Error("EXPECTED_KERNEL_OK");
  return result;
}
function hold(p: unknown, r: unknown, reason: string) {
  assert.deepEqual(evaluate(p, r), {
    status: "HOLD",
    reasons: [reason],
    orderSubmissionAllowed: false,
    learningAllowed: false,
    liveEnabled: false,
  });
}

for (const market of ["KR", "US"] as const)
  for (const unit of ["ORDER", "FILL"] as const)
    test(`CK-01 ${market} ${unit} actual fees and remaining reserve are separate`, () => {
      const { p, r } = fixture(unit, market),
        empty = ok(p, r);
      assert.equal(empty.currency, market === "KR" ? "KRW" : "USD");
      assert.equal(empty.charges.total, "0");
      assert.deepEqual(empty.charges.lines, []);
      assert.equal(empty.reservedCash, unit === "ORDER" ? "4010" : "4040");
      const a = ok(p, filled(r, [1])),
        b = ok(p, filled(r, [1, 1]));
      assert.equal(a.charges.total, "10");
      assert.equal(b.charges.total, unit === "ORDER" ? "10" : "20");
      assert.equal(b.reservedCash, unit === "ORDER" ? "2000" : "2020");
      assert.equal(b.filled, 2);
      assert.equal(b.value, "2000");
      assert.equal(ok(p, filled(r, [4])).reservedCash, "0");
      assert.equal(
        ok(p, { ...filled(r, [1]), order: { ...r.order, terminal: true } })
          .reservedCash,
        "0",
      );
    });

test("CK-02 same-time distinct fills preserve FILL minimum and itemized mixed units", () => {
  const { p, r } = fixture();
  const exchange = p.rules.find(
    (x) => x.side === "BUY" && x.component === "EXCHANGE",
  )!;
  exchange.unit = "FILL";
  exchange.fixed = "1";
  r.profileHash = hash(p);
  const split = ok(p, filled(r, [1, 1])),
    bulk = ok(p, filled(r, [2]));
  assert.equal(split.value, bulk.value);
  assert.equal(split.charges.total, "12");
  assert.equal(bulk.charges.total, "11");
  assert.equal(split.charges.orderTotal, "10");
  assert.deepEqual(
    split.charges.lines
      .filter((l) => l.component === "EXCHANGE")
      .map((l) => [l.groupId, l.amount]),
    [
      ["f-0", "1"],
      ["f-1", "1"],
    ],
  );
});

test("CK-03 CHARGE_ONLY never certifies reserves or rejects an unbounded SELL reserve", () => {
  const { p, r } = fixture("ORDER", "KR", "SELL");
  p.rules
    .filter((x) => x.side === "SELL")
    .forEach((x) => {
      x.minimum = "0";
      x.tiers[0]!.rate = "4000";
    });
  r.profileHash = hash(p);
  const request = filled(r, [1]);
  hold(p, request, "SELL_COST_BOUND_UNSUPPORTED");
  const actual = ok(p, { ...request, mode: "CHARGE_ONLY" });
  assert.equal(actual.charges.total, "1200");
  assert.equal(actual.reservedCash, null);
  assert.equal(
    ok(p, { ...request, order: { ...r.order, terminal: true } }).reservedCash,
    "0",
  );
});

test("CK-04 identical amounts with different profile or request evidence cannot share binding", () => {
  const { p, r } = fixture(),
    request = filled(r, [1]),
    first = ok(p, request);
  const revised = structuredClone(p);
  revised.version++;
  hold(revised, request, "COST_BINDING_MISMATCH");
  const next = ok(revised, { ...request, profileHash: hash(revised) });
  assert.equal(next.charges.total, first.charges.total);
  assert.notEqual(next.costBasisHash, first.costBasisHash);
  for (const change of [
    { ...request, asOf: request.asOf + 1 },
    { ...request, mode: "CHARGE_ONLY" as const },
    { ...request, fills: request.fills.map((f) => ({ ...f, id: "other" })) },
  ]) {
    const other = ok(p, change);
    assert.equal(other.charges.total, first.charges.total);
    assert.notEqual(other.requestHash, first.requestHash);
    assert.notEqual(other.costBasisHash, first.costBasisHash);
  }
  assert.deepEqual(ok(p, request), first);
  first.charges.lines[0]!.amount = "999";
  assert.equal(ok(p, request).charges.total, "10");
});

const invalidRequests: [string, (r: CostKernelRequest) => unknown][] = [
  ["missing mode", (r) => ({ ...r, mode: undefined })],
  ["real provenance", (r) => ({ ...r, provenance: "REAL" })],
  ["unknown field", (r) => ({ ...r, liveEnabled: true })],
  ["wrong policy", (r) => ({ ...r, policyHash: "0".repeat(64) })],
  ["bad price", (r) => ({ ...r, order: { ...r.order, limit: "abc" } })],
  ["exponent", (r) => ({ ...r, order: { ...r.order, limit: "1e3" } })],
  ["negative", (r) => ({ ...r, order: { ...r.order, limit: "-1" } })],
  ["precision", (r) => ({ ...r, order: { ...r.order, limit: "1.1234567" } })],
  [
    "fractional shares",
    (r) => ({ ...r, order: { ...r.order, quantity: 1.5 } }),
  ],
  ["quantity cap", (r) => ({ ...r, order: { ...r.order, quantity: 1001 } })],
  ["unsafe ID", (r) => ({ ...r, order: { ...r.order, id: "KR:id" } })],
  [
    "no terminal state",
    (r) => ({ ...r, order: { ...r.order, terminal: undefined } }),
  ],
  ["cached filled count", (r) => ({ ...r, order: { ...r.order, filled: 1 } })],
  [
    "invalid fill price",
    (r) => ({
      ...filled(r, [1]),
      fills: [{ ...filled(r, [1]).fills[0]!, price: "NaN" }],
    }),
  ],
  [
    "too many fills",
    (r) => ({ ...r, fills: Array(1001).fill(filled(r, [1]).fills[0]) }),
  ],
];
for (const [name, change] of invalidRequests)
  test(`CK-05 rejects ${name} without throwing or mutation`, () => {
    const { p, r } = fixture();
    hold(p, change(r), "INVALID_COST_KERNEL_REQUEST");
  });

test("CK-06 profile and scope validation still runs for no executions", () => {
  const { p, r } = fixture();
  hold({ ...p, liveEnabled: true }, r, "INVALID_COST_PROFILE");
  hold(
    { ...p, rules: p.rules.map((x) => ({ ...x, quantum: "abc" })) },
    r,
    "INVALID_COST_PROFILE",
  );
  hold(p, { ...r, profileHash: "0".repeat(64) }, "COST_BINDING_MISMATCH");
  hold(
    p,
    { ...r, scope: { ...r.scope, product: "EQUITY" } },
    "COST_BINDING_MISMATCH",
  );
  for (const unit of ["DAY", "FX"] as const) {
    const other = structuredClone(p);
    if (unit === "DAY") other.rules[0]!.unit = unit;
    else
      other.rules.push({
        ...other.rules[0]!,
        id: "fx",
        side: "FX",
        component: "FX",
        unit,
      });
    hold(
      other,
      { ...r, profileHash: hash(other) },
      "EXECUTION_CHARGE_UNIT_UNSUPPORTED",
    );
  }
});

test("CK-07 validity window and available-at constraints apply even to empty terminal requests", () => {
  const { p, r } = fixture();
  const terminal = { ...r, order: { ...r.order, terminal: true } };
  for (const change of [
    { ...terminal, asOf: p.effectiveTo },
    { ...terminal, asOf: r.order.at - 1 },
    { ...terminal, order: { ...terminal.order, at: p.effectiveFrom - 1 } },
  ])
    hold(p, change, "COST_KERNEL_TIME");
  const later = { ...p, availableAt: r.order.at + 1 };
  hold(later, { ...terminal, profileHash: hash(later) }, "COST_KERNEL_TIME");
  const start = {
    ...r,
    asOf: p.effectiveFrom,
    order: { ...r.order, at: p.effectiveFrom },
  };
  assert.equal(ok(p, start).charges.total, "0");
});

test("CK-08 unique complete fill details, time ordering and price/quantity limits are required", () => {
  const { p, r } = fixture(),
    request = filled(r, [1]),
    f = request.fills[0]!;
  hold(p, { ...request, fills: [f, f] }, "DUPLICATE_KERNEL_FILL");
  hold(
    p,
    { ...request, fills: [f, { ...f, price: "999" }] },
    "CONFLICTING_KERNEL_FILL",
  );
  for (const change of [
    { ...f, orderId: "other-order" },
    { ...f, occurredAt: r.order.at - 1 },
    { ...f, availableAt: f.occurredAt - 1 },
    { ...f, availableAt: r.asOf + 1 },
  ])
    hold(p, { ...request, fills: [change] }, "COST_KERNEL_FILL_CONTEXT");
  hold(p, filled(r, [3, 2]), "OVERFILL");
  hold(p, filled(r, [1], "1001"), "FILL_LIMIT_VIOLATION");
  hold(
    p,
    filled({ ...r, order: { ...r.order, side: "SELL" } }, [1], "999"),
    "FILL_LIMIT_VIOLATION",
  );
  assert.equal(ok(p, filled(r, [1, 1])).filled, 2);
});

function partitions(n: number): number[][] {
  return n === 0
    ? [[]]
    : Array.from({ length: n }, (_, i) => i + 1).flatMap((k) =>
        partitions(n - k).map((rest) => [k, ...rest]),
      );
}
for (const side of ["BUY", "SELL"] as const)
  for (const rounding of ["UP", "DOWN", "HALF_EVEN"] as const)
    test(`CK-09 ${side} ${rounding} bound covers every four-share partition and prefix`, () => {
      const { p, r } = fixture("FILL", "KR", side);
      p.rules.forEach((x) => {
        x.rounding = rounding;
        x.quantum = "0.3";
        x.minimum = "0";
      });
      const commission = p.rules.find(
        (x) => x.side === side && x.component === "COMMISSION",
      )!;
      commission.basis = "SHARES";
      commission.minimum = side === "BUY" ? "0.5" : "1100.1";
      commission.fixed = "0.2";
      commission.tiers = [
        { upTo: "1", rate: "0" },
        { upTo: null, rate: "1500.15" },
      ];
      const tax = p.rules.find(
        (x) => x.side === side && x.component === "TAX",
      )!;
      tax.unit = "ORDER";
      tax.tiers = [
        { upTo: "1000", rate: "0" },
        { upTo: null, rate: "200" },
      ];
      r.profileHash = hash(p);
      for (const price of side === "BUY" ? ["999", "1000"] : ["1000", "1200"]) {
        for (const parts of partitions(4))
          for (let prefix = 0; prefix < parts.length; prefix++) {
            const a = ok(p, filled(r, parts.slice(0, prefix), price));
            for (let later = prefix + 1; later <= parts.length; later++) {
              const b = ok(p, {
                ...filled(r, parts.slice(0, later), price),
                mode: "CHARGE_ONLY",
              });
              const extraFee = d(b.charges.total).minus(a.charges.total),
                proceeds = d(b.value).minus(a.value);
              const need =
                side === "BUY"
                  ? proceeds.plus(extraFee)
                  : extraFee.minus(proceeds);
              assert.ok(
                d(a.reservedCash!).gte(need),
                JSON.stringify({
                  side,
                  rounding,
                  parts,
                  prefix,
                  later,
                  need,
                  reserve: a.reservedCash,
                }),
              );
            }
          }
      }
    });

test("CK-10 namespace collision with hypothetical fills never alters real charges", () => {
  const { p, r } = fixture("FILL"),
    request = filled(r, [1]);
  const first = ok(p, request);
  for (const id of ["reserve-0", "actual-0"]) {
    const renamed = ok(p, {
      ...request,
      fills: request.fills.map((f) => ({ ...f, id })),
    });
    assert.equal(renamed.charges.total, first.charges.total);
    assert.equal(renamed.reservedCash, first.reservedCash);
    assert.notEqual(renamed.costBasisHash, first.costBasisHash);
  }
});

for (const side of ["BUY", "SELL"] as const)
  for (const rounding of ["UP", "DOWN", "HALF_EVEN"] as const)
    test(`CK-11 ${side} ${rounding} historical and remaining fills may use different prices`, () => {
      const { p, r } = fixture("ORDER", "KR", side);
      p.rules.forEach((rule) => {
        rule.minimum = "0";
        rule.rounding = rounding;
        rule.quantum = "0.3";
      });
      const commission = p.rules.find(
        (rule) => rule.side === side && rule.component === "COMMISSION",
      )!;
      commission.minimum = side === "BUY" ? "1.1" : "1500.15";
      commission.fixed = "0.2";
      commission.tiers = [
        { upTo: "1000", rate: "0" },
        { upTo: null, rate: "5000" },
      ];
      const tax = p.rules.find(
        (rule) => rule.side === side && rule.component === "TAX",
      )!;
      tax.unit = "FILL";
      tax.basis = "SHARES";
      // Force a genuine cash shortfall after a prior SELL fill, not a vacuous bound.
      tax.fixed = side === "SELL" ? "1200" : "0";
      tax.tiers = [
        { upTo: "1", rate: "0.1" },
        { upTo: null, rate: "500" },
      ];
      r.profileHash = hash(p);
      let positiveRemainingShortfalls = 0;
      for (const parts of partitions(4)) {
        const all = filled(r, parts);
        all.fills.forEach((fill, index) => {
          // BUY becomes more expensive; SELL loses its earlier price improvement.
          fill.price =
            index % 2 === 0 ? (side === "BUY" ? "999" : "1200") : "1000";
        });
        for (let prefix = 0; prefix < all.fills.length; prefix++) {
          const a = ok(p, { ...all, fills: all.fills.slice(0, prefix) });
          for (let later = prefix + 1; later <= all.fills.length; later++) {
            const b = ok(p, {
              ...all,
              mode: "CHARGE_ONLY",
              fills: all.fills.slice(0, later),
            });
            const fee = d(b.charges.total).minus(a.charges.total),
              value = d(b.value).minus(a.value);
            const need = side === "BUY" ? value.plus(fee) : fee.minus(value);
            if (prefix > 0 && need.gt(0)) positiveRemainingShortfalls++;
            assert.ok(
              d(a.reservedCash!).gte(need),
              JSON.stringify({ side, rounding, parts, prefix, later }),
            );
          }
        }
      }
      assert.ok(positiveRemainingShortfalls > 0);
    });
