import { z } from "zod";
import { d, Decimal, sum } from "./math.js";
import { hash } from "./policy.js";

export const transactionCostContract = "SYNTHETIC_TRANSACTION_COST_V1";
// Bounds keep products/sums within the shared 40-digit Decimal precision.
export const costAmountSchema = z
  .string()
  .max(16)
  .regex(/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/);
export const positiveCostAmountSchema = costAmountSchema.pipe(
  z.string().refine((v) => d(v).gt(0)),
);
const positive = positiveCostAmountSchema;
const time = z.number().int().safe().min(0).max(8_640_000_000_000_000);
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const unit = z.enum(["ORDER", "FILL", "DAY", "FX"]);
const side = z.enum(["BUY", "SELL", "FX"]);
const scope = z
  .object({
    market: z.enum(["KR", "US"]),
    product: z.enum(["EQUITY", "ETF", "LEVERAGED_ETF"]),
    currency: z.enum(["KRW", "USD"]),
  })
  .strict()
  .refine((s) => (s.market === "KR") === (s.currency === "KRW"));
const rule = z
  .object({
    id,
    component: z.enum(["COMMISSION", "TAX", "EXCHANGE", "FX"]),
    side,
    unit,
    basis: z.enum(["NOTIONAL", "SHARES"]),
    tierMode: z.literal("MARGINAL"),
    tiers: z
      .array(
        z
          .object({ upTo: positive.nullable(), rate: costAmountSchema })
          .strict(),
      )
      .min(1)
      .max(16),
    fixed: costAmountSchema,
    minimum: costAmountSchema,
    quantum: positive,
    rounding: z.enum(["UP", "DOWN", "HALF_EVEN"]),
  })
  .strict();

export const costProfileSchema = z
  .object({
    contract: z.literal(transactionCostContract),
    purpose: z.literal("TEST_ONLY"),
    provenance: z.literal("SYNTHETIC_FIXTURE"),
    liveEnabled: z.literal(false),
    id,
    version: z.number().int().positive().max(1_000_000),
    scope,
    effectiveFrom: time,
    effectiveTo: time,
    availableAt: time,
    rules: z.array(rule).min(6).max(16),
  })
  .strict()
  .superRefine((p, ctx) => {
    const fail = () =>
      ctx.addIssue({ code: "custom", message: "INVALID_COST_CONTRACT" });
    if (
      p.effectiveTo <= p.effectiveFrom ||
      new Set(p.rules.map((r) => r.id)).size !== p.rules.length
    )
      fail();
    for (const s of ["BUY", "SELL"] as const)
      for (const c of ["COMMISSION", "TAX", "EXCHANGE"] as const)
        if (!p.rules.some((r) => r.side === s && r.component === c)) fail();
    for (const r of p.rules) {
      if (
        (r.side === "FX") !== (r.unit === "FX") ||
        (r.side === "FX") !== (r.component === "FX") ||
        (r.side === "FX" && r.basis !== "NOTIONAL")
      )
        fail();
      let last = d(0);
      for (const [i, t] of r.tiers.entries()) {
        if (
          !costAmountSchema.safeParse(t.rate).success ||
          (t.upTo !== null && !positive.safeParse(t.upTo).success)
        ) {
          fail();
          continue;
        }
        if ((t.upTo === null) !== (i === r.tiers.length - 1)) fail();
        if (t.upTo !== null) {
          if (
            d(t.upTo).lte(last) ||
            (r.basis === "SHARES" && !d(t.upTo).isInteger())
          )
            fail();
          last = d(t.upTo);
        }
        if (r.basis === "NOTIONAL" && d(t.rate).gt(10_000)) fail();
      }
    }
  });
export type CostProfile = z.infer<typeof costProfileSchema>;

const group = z
  .object({
    id,
    unit,
    side,
    notional: costAmountSchema,
    quantity: z.number().int().min(0).max(1_000_000),
    at: time,
  })
  .strict()
  .refine(
    (g) =>
      costAmountSchema.safeParse(g.notional).success &&
      (g.side === "FX"
        ? g.unit === "FX" && g.quantity === 0 && d(g.notional).gt(0)
        : g.unit !== "FX" &&
          ((g.quantity === 0 && d(g.notional).eq(0)) ||
            (g.quantity > 0 && d(g.notional).gt(0)))),
  );
export const costPlanSchema = z
  .object({
    purpose: z.literal("TEST_ONLY"),
    profileHash: z.string().regex(/^[a-f0-9]{64}$/),
    scope,
    asOf: time,
    // Groups describe a complete isolated synthetic scenario, not broker events.
    complete: z.literal(true),
    groups: z.array(group).max(2_000),
  })
  .strict();
export type CostPlan = z.infer<typeof costPlanSchema>;
export interface CostLine {
  ruleId: string;
  groupId: string;
  unit: CostPlan["groups"][number]["unit"];
  side: CostPlan["groups"][number]["side"];
  component: CostProfile["rules"][number]["component"];
  raw: string;
  amount: string;
}
export type CostResult =
  | {
      status: "OK";
      profileHash: string;
      planHash: string;
      currency: "KRW" | "USD";
      total: string;
      lines: CostLine[];
      liveEnabled: false;
    }
  | { status: "HOLD"; reasons: string[]; liveEnabled: false };

function charge(
  r: CostProfile["rules"][number],
  g: CostPlan["groups"][number],
) {
  if (d(g.notional).eq(0)) return { raw: "0", amount: "0" };
  const basis = d(r.basis === "NOTIONAL" ? g.notional : g.quantity);
  let left = basis,
    lower = d(0),
    value = d(r.fixed);
  for (const t of r.tiers) {
    const portion =
      t.upTo === null ? left : Decimal.min(left, d(t.upTo).minus(lower));
    value = value.plus(
      portion.mul(t.rate).div(r.basis === "NOTIONAL" ? 10_000 : 1),
    );
    left = left.minus(portion);
    if (left.eq(0)) break;
    lower = d(t.upTo!);
  }
  const raw = Decimal.max(value, r.minimum);
  const rounding = {
    UP: Decimal.ROUND_UP,
    DOWN: Decimal.ROUND_DOWN,
    HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  }[r.rounding];
  return {
    raw: raw.toString(),
    amount: raw
      .div(r.quantum)
      .toDecimalPlaces(0, rounding)
      .mul(r.quantum)
      .toString(),
  };
}

export function evaluateCostPlan(
  rawProfile: unknown,
  rawPlan: unknown,
): CostResult {
  const hold = (reason: string): CostResult => ({
    status: "HOLD",
    reasons: [reason],
    liveEnabled: false,
  });
  const pp = costProfileSchema.safeParse(rawProfile),
    rp = costPlanSchema.safeParse(rawPlan);
  if (!pp.success) return hold("INVALID_COST_PROFILE");
  if (!rp.success) return hold("INVALID_COST_PLAN");
  const p = pp.data,
    plan = rp.data;
  const profileHash = hash(p);
  if (plan.profileHash !== profileHash || hash(p.scope) !== hash(plan.scope))
    return hold("COST_BINDING_MISMATCH");
  if (p.availableAt > plan.asOf) return hold("COST_PROFILE_NOT_AVAILABLE");
  const groups = new Map<string, CostPlan["groups"][number]>();
  for (const g of plan.groups) {
    if (g.at < p.effectiveFrom || g.at >= p.effectiveTo || g.at > plan.asOf)
      return hold("COST_TIME_MISMATCH");
    const key = `${g.unit}:${g.side}:${g.id}`,
      previous = groups.get(key);
    if (previous && hash(previous) !== hash(g))
      return hold("CONFLICTING_COST_GROUP");
    groups.set(key, g);
    if (!p.rules.some((r) => r.side === g.side && r.unit === g.unit))
      return hold("UNSUPPORTED_COST_GROUP");
  }
  for (const s of new Set([...groups.values()].map((g) => g.side))) {
    const required = new Set(
      p.rules.filter((r) => r.side === s).map((r) => r.unit),
    );
    let totals: string | undefined;
    for (const u of required) {
      const selected = [...groups.values()].filter(
        (g) => g.side === s && g.unit === u,
      );
      if (!selected.length) return hold("MISSING_CHARGE_UNIT");
      const current = hash({
        quantity: sum(selected.map((g) => g.quantity)).toString(),
        notional: sum(selected.map((g) => g.notional)).toString(),
      });
      if (totals && totals !== current)
        return hold("INCONSISTENT_CHARGE_BASES");
      totals = current;
    }
  }
  const lines: CostLine[] = [];
  for (const g of [...groups.values()].sort((a, b) =>
    `${a.unit}:${a.side}:${a.id}`.localeCompare(`${b.unit}:${b.side}:${b.id}`),
  ))
    for (const r of p.rules.filter(
      (r) => r.side === g.side && r.unit === g.unit,
    ))
      lines.push({
        ruleId: r.id,
        groupId: g.id,
        unit: g.unit,
        side: g.side,
        component: r.component,
        ...charge(r, g),
      });
  return {
    status: "OK",
    profileHash,
    planHash: hash(plan),
    currency: p.scope.currency,
    total: sum(lines.map((l) => l.amount)).toString(),
    lines,
    liveEnabled: false,
  };
}
