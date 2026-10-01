import { z } from "zod";
import { d, max, sum } from "./math.js";
import { hash, policyHash } from "./policy.js";
import {
  costProfileSchema,
  positiveCostAmountSchema,
  evaluateCostPlan,
} from "./transaction-cost.js";
import type { CostLine, CostPlan, CostProfile } from "./transaction-cost.js";

export const costKernelContract = "SYNTHETIC_ORDER_COST_KERNEL_V1";
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const time = z.number().int().safe().nonnegative().max(8_640_000_000_000_000);
const quantity = z.number().int().min(1).max(1000);
const requestSchema = z
  .object({
    contract: z.literal(costKernelContract),
    purpose: z.literal("TEST_ONLY"),
    provenance: z.literal("SYNTHETIC_FIXTURE"),
    policyHash: z.literal(policyHash),
    profileHash: z.string().regex(/^[a-f0-9]{64}$/),
    scope: costProfileSchema.shape.scope,
    asOf: time,
    mode: z.enum(["CHARGE_ONLY", "WITH_RESERVATION"]),
    order: z
      .object({
        id,
        side: z.enum(["BUY", "SELL"]),
        quantity,
        limit: positiveCostAmountSchema,
        at: time,
        // Supplied by a validated caller lifecycle, not cancellation evidence.
        terminal: z.boolean(),
      })
      .strict(),
    // Complete unique executions for this order, not a cumulative delta guess.
    fills: z
      .array(
        z
          .object({
            id,
            orderId: id,
            quantity,
            price: positiveCostAmountSchema,
            occurredAt: time,
            availableAt: time,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type CostKernelRequest = z.infer<typeof requestSchema>;
type Order = CostKernelRequest["order"];
type Fill = CostKernelRequest["fills"][number] & { value: string };
type Charges = { total: string; orderTotal: string; lines: CostLine[] };
const locked = {
  orderSubmissionAllowed: false,
  learningAllowed: false,
  liveEnabled: false,
} as const;

// Future fee upper bound for integer partitions at prices <= the stated price.
// An estimate, not a receipt, stop-price guarantee, or cash-shortfall reserve.
export function estimateFeeBound(
  rawProfile: unknown,
  side: "BUY" | "SELL",
  quantity: number,
  price: string,
  at: number,
  maximumOrders = 1,
): string {
  const p = costProfileSchema.parse(rawProfile);
  z.enum(["BUY", "SELL"]).parse(side);
  z.number().int().min(0).max(1000).parse(quantity);
  positiveCostAmountSchema.parse(price);
  time.parse(at);
  z.number().int().min(1).max(1000).parse(maximumOrders);
  if (at < p.availableAt || at < p.effectiveFrom || at >= p.effectiveTo)
    throw Error("FEE_BOUND_TIME");
  if (p.rules.some((r) => r.unit !== "ORDER" && r.unit !== "FILL"))
    throw Error("FEE_BOUND_UNIT");
  if (!quantity) return "0";
  return sum(
    p.rules
      .filter((r) => r.side === side)
      .map((r) => {
        const count = r.unit === "FILL" ? quantity : 1;
        const q = quantity / count;
        const rate = max(...r.tiers.map((t) => t.rate));
        const variable =
          r.basis === "NOTIONAL"
            ? d(price).mul(q).mul(rate).div(10000)
            : rate.mul(q);
        const groups = Math.min(quantity, maximumOrders);
        if (r.unit === "ORDER" && groups > 1) {
          const bound = variable.plus(max(r.minimum, r.fixed).mul(groups));
          return bound.eq(0)
            ? d(0)
            : bound
                .div(r.quantum)
                .ceil()
                .mul(r.quantum)
                .plus(d(r.quantum).mul(groups - 1));
        }
        return max(r.minimum, d(r.fixed).plus(variable))
          .div(r.quantum)
          .ceil()
          .mul(r.quantum)
          .mul(count);
      }),
  ).toString();
}
export type CostKernelResult =
  | (typeof locked & {
      status: "OK";
      contract: typeof costKernelContract;
      profileHash: string;
      requestHash: string;
      costBasisHash: string;
      currency: "KRW" | "USD";
      filled: number;
      value: string;
      charges: Charges;
      // null means NOT EVALUATED, never a certified zero reservation.
      reservedCash: string | null;
    })
  | (typeof locked & { status: "HOLD"; reasons: string[] });
class CostKernelError extends Error {}
function fail(reason: string): never {
  throw new CostKernelError(reason);
}

function charges(
  profile: CostProfile,
  order: Order,
  fills: Fill[],
  at: number,
): Charges {
  if (fills.length === 0) return { total: "0", orderTotal: "0", lines: [] };
  const groups: CostPlan["groups"] = [];
  for (const unit of new Set(
    profile.rules.filter((r) => r.side === order.side).map((r) => r.unit),
  )) {
    if (unit === "ORDER")
      groups.push({
        id: order.id,
        unit,
        side: order.side,
        quantity: fills.reduce((n, f) => n + f.quantity, 0),
        notional: sum(fills.map((f) => f.value)).toString(),
        at: Math.max(...fills.map((f) => f.occurredAt)),
      });
    else if (unit === "FILL")
      for (const f of fills)
        groups.push({
          id: f.id,
          unit,
          side: order.side,
          quantity: f.quantity,
          notional: f.value,
          at: f.occurredAt,
        });
    else fail("EXECUTION_CHARGE_UNIT_UNSUPPORTED");
  }
  const result = evaluateCostPlan(profile, {
    purpose: "TEST_ONLY",
    profileHash: hash(profile),
    scope: profile.scope,
    asOf: at,
    complete: true,
    groups,
  });
  if (result.status !== "OK") return fail("EXECUTION_COST_PLAN_REJECTED");
  return {
    total: result.total,
    orderTotal: sum(
      result.lines.filter((l) => l.unit === "ORDER").map((l) => l.amount),
    ).toString(),
    lines: result.lines,
  };
}

// Maximum marginal rates bound ANY integer partition of BUY fills at/below limit.
// This reservation is not an expense or an expected one-share fill scenario.
function fillFeeBound(profile: CostProfile, order: Order, remaining: number) {
  return sum(
    profile.rules
      .filter((r) => r.side === order.side && r.unit === "FILL")
      .map((r) => {
        const rate = max(...r.tiers.map((t) => t.rate));
        const variable =
          r.basis === "NOTIONAL" ? d(order.limit).mul(rate).div(10000) : rate;
        return max(r.minimum, d(r.fixed).plus(variable))
          .div(r.quantum)
          .ceil()
          .mul(r.quantum)
          .mul(remaining);
      }),
  );
}
function sellCashBound(
  profile: CostProfile,
  order: Order,
  fills: Fill[],
  lines: CostLine[],
) {
  let constant = d(0),
    perShare = d(0),
    proportional = d(0);
  const filled = fills.reduce((n, f) => n + f.quantity, 0),
    value = sum(fills.map((f) => f.value));
  for (const r of profile.rules.filter((r) => r.side === "SELL")) {
    const rate = max(...r.tiers.map((t) => t.rate));
    const fixedBound = max(r.minimum, r.fixed).plus(r.quantum);
    if (r.basis === "NOTIONAL")
      proportional = proportional.plus(rate.div(10000));
    else perShare = perShare.plus(rate);
    if (r.unit === "FILL") perShare = perShare.plus(fixedBound);
    else {
      const previousVariable =
        r.basis === "NOTIONAL" ? value.mul(rate).div(10000) : rate.mul(filled);
      const paid = sum(
        lines.filter((l) => l.ruleId === r.id).map((l) => l.amount),
      );
      constant = constant.plus(fixedBound).plus(previousVariable).minus(paid);
    }
  }
  // SELL prices are unbounded above. This linear bound cannot certify >100%.
  if (proportional.gt(1)) fail("SELL_COST_BOUND_UNSUPPORTED");
  const slope = perShare.plus(proportional.minus(1).mul(order.limit));
  const remaining = order.quantity - filled;
  // Cover every partial-fill prefix, not just the completed sale.
  return max(0, constant.plus(slope), constant.plus(slope.mul(remaining)));
}
function reserve(
  profile: CostProfile,
  order: Order,
  fills: Fill[],
  at: number,
  actual: Charges,
) {
  const remaining = order.quantity - fills.reduce((n, f) => n + f.quantity, 0);
  if (order.terminal || remaining === 0) return "0";
  if (order.side === "SELL")
    return sellCashBound(profile, order, fills, actual.lines).toString();
  const hypothetical = Array.from({ length: remaining }, (_, i): Fill => ({
    id: `reserve-${i}`,
    orderId: order.id,
    quantity: 1,
    price: order.limit,
    value: order.limit,
    occurredAt: at,
    availableAt: at,
  }));
  // Namespaces apply only inside the reservation calculation, never receipts.
  const future = charges(
    profile,
    order,
    [...fills.map((f, i) => ({ ...f, id: `actual-${i}` })), ...hypothetical],
    at,
  );
  return d(order.limit)
    .mul(remaining)
    .plus(max(0, d(future.orderTotal).minus(actual.orderTotal)))
    .plus(fillFeeBound(profile, order, remaining))
    .toString();
}

// Pure, bounded synthetic calculation. No journal mutation, lifecycle approval,
// settlement, R0 sizing, operating-cost allocation, IO, or broker submission.
export function evaluateOrderCost(
  rawProfile: unknown,
  rawRequest: unknown,
): CostKernelResult {
  const hold = (reason: string): CostKernelResult => ({
    status: "HOLD",
    reasons: [reason],
    ...locked,
  });
  const pp = costProfileSchema.safeParse(rawProfile),
    rp = requestSchema.safeParse(rawRequest);
  if (!pp.success) return hold("INVALID_COST_PROFILE");
  if (!rp.success) return hold("INVALID_COST_KERNEL_REQUEST");
  const p = pp.data,
    r = rp.data,
    o = r.order,
    profileHash = hash(p);
  if (r.profileHash !== profileHash || hash(r.scope) !== hash(p.scope))
    return hold("COST_BINDING_MISMATCH");
  if (p.rules.some((rule) => rule.unit !== "ORDER" && rule.unit !== "FILL"))
    return hold("EXECUTION_CHARGE_UNIT_UNSUPPORTED");
  if (
    o.at < p.effectiveFrom ||
    o.at >= p.effectiveTo ||
    p.availableAt > o.at ||
    r.asOf < o.at ||
    r.asOf >= p.effectiveTo
  )
    return hold("COST_KERNEL_TIME");
  const fills: Fill[] = [],
    ids = new Map<string, string>();
  let filled = 0;
  for (const f of r.fills) {
    const prior = ids.get(f.id);
    if (prior)
      return hold(
        prior === hash(f) ? "DUPLICATE_KERNEL_FILL" : "CONFLICTING_KERNEL_FILL",
      );
    ids.set(f.id, hash(f));
    if (
      f.orderId !== o.id ||
      f.occurredAt < o.at ||
      f.availableAt < f.occurredAt ||
      f.availableAt > r.asOf
    )
      return hold("COST_KERNEL_FILL_CONTEXT");
    if (
      (o.side === "BUY" && d(f.price).gt(o.limit)) ||
      (o.side === "SELL" && d(f.price).lt(o.limit))
    )
      return hold("FILL_LIMIT_VIOLATION");
    filled += f.quantity;
    if (filled > o.quantity) return hold("OVERFILL");
    fills.push({ ...f, value: d(f.price).mul(f.quantity).toString() });
  }
  try {
    const actual = charges(p, o, fills, r.asOf);
    const reservedCash =
      r.mode === "WITH_RESERVATION"
        ? reserve(p, o, fills, r.asOf, actual)
        : null;
    const requestHash = hash(r);
    return {
      status: "OK",
      contract: costKernelContract,
      profileHash,
      requestHash,
      costBasisHash: hash({
        contract: costKernelContract,
        profileHash,
        requestHash,
      }),
      currency: p.scope.currency,
      filled,
      value: sum(fills.map((f) => f.value)).toString(),
      charges: actual,
      reservedCash,
      ...locked,
    };
  } catch (error) {
    if (error instanceof CostKernelError) return hold(error.message);
    throw error;
  }
}
