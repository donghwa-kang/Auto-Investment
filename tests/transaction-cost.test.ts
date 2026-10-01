import { test } from "node:test";
import assert from "node:assert/strict";
import { hash } from "../src/core/policy.js";
import { evaluateCostPlan } from "../src/core/transaction-cost.js";
import type { CostPlan, CostProfile } from "../src/core/transaction-cost.js";
import { costAt, costPlan, costProfile } from "./transaction-cost-helpers.js";

for (const field of ["quantum", "tier-rate", "group-notional"] as const)
  test(`COST-REVIEW malformed decimal ${field} returns HOLD without throwing`, () => {
    const p = costProfile(),
      plan = costPlan(p);
    if (field === "quantum") p.rules[0]!.quantum = "abc";
    if (field === "tier-rate") p.rules[0]!.tiers[0]!.rate = "abc";
    if (field === "group-notional") plan.groups[0]!.notional = "abc";
    hold(
      p,
      plan,
      field === "group-notional" ? "INVALID_COST_PLAN" : "INVALID_COST_PROFILE",
    );
  });

function total(p: CostProfile, plan = costPlan(p)) {
  const before = hash({ p, plan });
  const r = evaluateCostPlan(p, plan);
  assert.equal(hash({ p, plan }), before);
  assert.equal(r.liveEnabled, false);
  assert.equal(r.status, "OK");
  if (r.status !== "OK") throw new Error("expected cost result");
  return r;
}
function hold(p: unknown, plan: unknown, reason: string) {
  assert.deepEqual(evaluateCostPlan(p, plan), {
    status: "HOLD",
    reasons: [reason],
    liveEnabled: false,
  });
}
test("COST-01 proportional, minimum, tax, exchange and itemized native amounts", () => {
  const p = costProfile();
  p.rules[1]!.tiers[0]!.rate = "2";
  p.rules[2]!.fixed = "3";
  const r = total(p);
  assert.equal(r.total, "33");
  assert.deepEqual(
    r.lines.map((l) => l.amount),
    ["10", "20", "3"],
  );
  assert.equal(r.profileHash, hash(p));
  const plan = costPlan(p);
  plan.groups[0]!.notional = "1000";
  assert.equal(total(p, plan).total, "14");
});
test("COST-02 progressive marginal tiers and fixed plus minimum", () => {
  const p = costProfile(),
    r = p.rules[0]!;
  r.tiers = [
    { upTo: "10000", rate: "10" },
    { upTo: "20000", rate: "5" },
    { upTo: null, rate: "1" },
  ];
  r.fixed = "2";
  r.minimum = "0";
  for (const [notional, expected] of [
    ["9999", "12"],
    ["10000", "12"],
    ["10001", "13"],
    ["20000", "17"],
    ["30000", "18"],
  ]) {
    const plan = costPlan(p);
    plan.groups[0]!.notional = notional!;
    assert.equal(total(p, plan).total, expected);
  }
});
for (const [rounding, raw, amount] of [
  ["UP", "2.5", "3"],
  ["DOWN", "2.5", "2"],
  ["HALF_EVEN", "2.5", "2"],
  ["HALF_EVEN", "3.5", "4"],
] as const) {
  test(`COST-03 ${rounding} ${raw} => ${amount}`, () => {
    const p = costProfile(),
      r = p.rules[0]!;
    r.tiers[0]!.rate = "0";
    r.minimum = raw;
    r.rounding = rounding;
    assert.equal(total(p).total, amount);
  });
}
test("COST-04 per-share tiers and USD quantum", () => {
  const p = costProfile("US"),
    r = p.rules[0]!;
  r.basis = "SHARES";
  r.tiers = [
    { upTo: "5", rate: "0.003" },
    { upTo: null, rate: "0.001" },
  ];
  assert.equal(total(p).total, "0.02");
});
test("COST-05 order vs fill vs day minimum is charged only per declared group", () => {
  for (const [unit, expected] of [
    ["ORDER", "20"],
    ["FILL", "40"],
    ["DAY", "10"],
  ] as const) {
    const p = costProfile();
    p.rules.forEach((r) => {
      r.unit = unit;
      r.tiers[0]!.rate = "0";
    });
    const count = unit === "ORDER" ? 2 : unit === "FILL" ? 4 : 1;
    const plan = costPlan(
      p,
      Array.from({ length: count }, (_, i) => ({
        id: `group-${i}`,
        unit,
        side: "BUY",
        quantity: 4 / count,
        notional: String(4000 / count),
        at: costAt,
      })),
    );
    assert.equal(total(p, plan).total, expected);
  }
});
test("COST-06 no executions/zero aggregate has no implicit minimum or cancellation charge", () => {
  const p = costProfile();
  assert.equal(total(p, costPlan(p, [])).total, "0");
  assert.equal(
    total(
      p,
      costPlan(p, [
        {
          id: "empty",
          unit: "ORDER",
          side: "BUY",
          quantity: 0,
          notional: "0",
          at: costAt,
        },
      ]),
    ).total,
    "0",
  );
});
test("COST-07 exact duplicate group is idempotent; altered duplicate is rejected", () => {
  const p = costProfile(),
    plan = costPlan(p);
  plan.groups.push(structuredClone(plan.groups[0]!));
  assert.equal(total(p, plan).total, "10");
  plan.groups[1]!.notional = "99999";
  hold(p, plan, "CONFLICTING_COST_GROUP");
});
test("COST-08 FX costs require an explicit conversion; USD cash trades do not auto-convert", () => {
  const p = costProfile("US");
  p.rules.push({
    ...p.rules[0]!,
    id: "fx-rule",
    component: "FX",
    unit: "FX",
    side: "FX",
    minimum: "1",
    tiers: [{ upTo: null, rate: "0" }],
  });
  const plan = costPlan(p);
  assert.equal(total(p, plan).total, "10");
  plan.groups.push({
    id: "fx-1",
    unit: "FX",
    side: "FX",
    quantity: 0,
    notional: "100",
    at: costAt,
  });
  assert.equal(total(p, plan).total, "11");
});
test("COST-09 mixed charge units must cover identical synthetic executions", () => {
  const p = costProfile(),
    plan = costPlan(p);
  p.rules[1]!.unit = "FILL";
  plan.profileHash = hash(p);
  hold(p, plan, "MISSING_CHARGE_UNIT");
  plan.groups.push({
    id: "fill-1",
    unit: "FILL",
    side: "BUY",
    quantity: 10,
    notional: "99999",
    at: costAt,
  });
  hold(p, plan, "INCONSISTENT_CHARGE_BASES");
  plan.groups[1]!.notional = "100000";
  assert.equal(total(p, plan).total, "10");
});
for (const offset of [-100001, 100000, 1])
  test(`COST-10 invalid effective/available event at ${offset}`, () => {
    const p = costProfile(),
      plan = costPlan(p);
    plan.groups[0]!.at += offset;
    hold(p, plan, "COST_TIME_MISMATCH");
  });
test("COST-11 inclusive start and exclusive end; future profile availability rejected", () => {
  const p = costProfile(),
    plan = costPlan(p);
  plan.groups[0]!.at = p.effectiveFrom;
  assert.equal(total(p, plan).total, "10");
  p.availableAt = costAt + 1;
  plan.profileHash = hash(p);
  hold(p, plan, "COST_PROFILE_NOT_AVAILABLE");
});
const invalidProfiles: [string, (p: CostProfile) => unknown][] = [
  ["real provenance", (p) => ({ ...p, provenance: "VERIFIED_REAL_RATE" })],
  ["live enabled", (p) => ({ ...p, liveEnabled: true })],
  ["unknown default", (p) => ({ ...p, provider: "Kiwoom" })],
  [
    "missing tax coverage",
    (p) => ({ ...p, rules: p.rules.filter((r) => r.component !== "TAX") }),
  ],
  ["duplicate rule", (p) => ({ ...p, rules: [...p.rules, p.rules[0]] })],
  [
    "bad tier order",
    (p) => {
      p.rules[0]!.tiers = [
        { upTo: "2", rate: "1" },
        { upTo: "1", rate: "1" },
        { upTo: null, rate: "1" },
      ];
      return p;
    },
  ],
  [
    "missing open final tier",
    (p) => {
      p.rules[0]!.tiers[0]!.upTo = "100";
      return p;
    },
  ],
  [
    "zero quantum",
    (p) => {
      p.rules[0]!.quantum = "0";
      return p;
    },
  ],
  [
    "NaN",
    (p) => {
      p.rules[0]!.minimum = "NaN";
      return p;
    },
  ],
  [
    "negative",
    (p) => {
      p.rules[0]!.minimum = "-1";
      return p;
    },
  ],
  [
    "overflow",
    (p) => {
      p.rules[0]!.minimum = "1000000000";
      return p;
    },
  ],
  [
    "fractional share tier",
    (p) => {
      p.rules[0]!.basis = "SHARES";
      p.rules[0]!.tiers = [
        { upTo: "1.5", rate: "1" },
        { upTo: null, rate: "1" },
      ];
      return p;
    },
  ],
  [
    "FX order",
    (p) => {
      p.rules[0]!.unit = "FX";
      return p;
    },
  ],
];
for (const [name, mutate] of invalidProfiles)
  test(`COST-12 reject ${name}`, () => {
    const p = costProfile(),
      bad = mutate(p);
    hold(bad, costPlan(p), "INVALID_COST_PROFILE");
  });
test("COST-13 profile revision, market, product and currency bindings", () => {
  const p = costProfile();
  for (const mutate of [
    (q: CostPlan) => {
      q.profileHash = "0".repeat(64);
    },
    (q: CostPlan) => {
      q.scope = { market: "US", currency: "USD", product: "ETF" };
    },
    (q: CostPlan) => {
      q.scope = { ...q.scope, product: "EQUITY" };
    },
  ]) {
    const plan = costPlan(p);
    mutate(plan);
    hold(p, plan, "COST_BINDING_MISMATCH");
  }
});
test("COST-14 strict incomplete/unknown/oversized/noninteger group input", () => {
  const p = costProfile(),
    plan = costPlan(p);
  for (const invalid of [
    { ...plan, complete: false },
    { ...plan, token: "dummy-not-a-key" },
    { ...plan, groups: Array(2001).fill(plan.groups[0]) },
    { ...plan, groups: [{ ...plan.groups[0], quantity: 0.5 }] },
  ])
    hold(p, invalid, "INVALID_COST_PLAN");
});
test("COST-15 zero-fee components are explicit and fixed charges round per group", () => {
  const p = costProfile();
  p.rules.forEach((r) => {
    r.unit = "FILL";
    r.minimum = "0";
    r.tiers[0]!.rate = "0";
  });
  p.rules[0]!.fixed = "0.1";
  const groups: CostPlan["groups"] = [1, 2, 3].map((i) => ({
    id: `fill-${i}`,
    unit: "FILL",
    side: "BUY",
    quantity: 1,
    notional: "100",
    at: costAt,
  }));
  assert.equal(total(p, costPlan(p, groups)).total, "3");
});
