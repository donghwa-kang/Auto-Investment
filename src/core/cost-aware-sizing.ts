import { z } from "zod";
import { availableCash, caps, equity, foreignNet, fxFor } from "./ledger.js";
import { ceil, d, floor, max, min, tick } from "./math.js";
import { configSchema, hash, policy, policyHash, spec } from "./policy.js";
import { economic, guards, remainingRisk } from "./risk.js";
import { resolveOperatingCost } from "./operating-cost.js";
import {
  positiveCostAmountSchema,
  costProfileSchema,
  evaluateCostPlan,
} from "./transaction-cost.js";
import type { CostPlan, CostProfile } from "./transaction-cost.js";
import { terminal } from "./types.js";
import type { State } from "./types.js";
import { assertCostExposure } from "./cost-risk-context.js";
import type { CostExposure } from "./cost-risk-context.js";
import { estimateFeeBound } from "./cost-kernel.js";

const positive = positiveCostAmountSchema;
// ATR is an analytic indicator, not a posted monetary amount. Preserve the
// strategy engine's Decimal(40) result; never round it to the money scale.
const analyticPositive = z
  .string()
  .max(49)
  .regex(/^(0|[1-9]\d{0,8})(\.\d{1,39})?$/)
  .pipe(z.string().refine((v) => d(v).gt(0) && d(v).sd() <= 40));
const time = z.number().int().safe().min(0).max(8_640_000_000_000_000);
const requestSchema = z
  .object({
    purpose: z.literal("TEST_ONLY"),
    provenance: z.literal("SYNTHETIC_FIXTURE"),
    policyHash: z.literal(policyHash),
    stateHash: z.string().regex(/^[a-f0-9]{64}$/),
    profileHash: z.string().regex(/^[a-f0-9]{64}$/),
    product: z.enum(["EQUITY", "ETF", "LEVERAGED_ETF"]),
    strategy: z.enum(["B", "P"]),
    symbol: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    signalAt: time,
    quote: z
      .object({
        at: time,
        bid: positive,
        ask: positive,
        bidSize: z.number().int().nonnegative().max(1_000_000_000),
        askSize: z.number().int().nonnegative().max(1_000_000_000),
        lastMinuteVolume: z.number().int().nonnegative().max(1_000_000_000),
        halted: z.boolean(),
      })
      .strict(),
    tickSize: positive,
    stop: positive,
    atr: analyticPositive,
    signalClose: positive,
    // This is a bounded scenario, not a statistical forecast or order approval.
    forecast: z
      .object({
        model: z.literal("SYNTHETIC_POINT_SCENARIO"),
        expectedExit: positive,
        q05Exit: positive,
        availableAt: time,
        validUntil: time,
      })
      .strict(),
    executionModel: z.literal("ONE_ORDER_PER_SIDE_ONE_SHARE_FILLS"),
    adverseExitTicks: z.number().int().min(0).max(100),
  })
  .strict();
export type CostSizingRequest = z.infer<typeof requestSchema>;
export { requestSchema as costSizingRequestSchema };
export interface CostCandidate {
  quantity: number;
  entry: string;
  stop: string;
  riskKrw: string;
  budgetKrw: string;
  entryFeeNative: string;
  stopTradingCostKrw: string;
  roundTripTradingCostKrw: string;
  operatingEstimateKrw: string;
  economicCostKrw: string;
  expectedGrossKrw: string;
  netQ05Krw: string;
  entryCashNative: string;
  tickCostNative: string;
  tickRatioBps: string;
  spreadEmbeddedNative: string;
  adverseExitNative: string;
  reservationCashNative?: string;
  riskTradingCostUpperKrw?: string;
}
export type CostSizingResult = {
  status: "RESEARCH_CANDIDATE" | "ABSTAIN";
  quantity: number;
  reasons: string[];
  candidate: CostCandidate | null;
  evaluated: number;
  rejectedBy: Record<string, number>;
  binding: {
    requestHash: string;
    stateHash: string;
    profileHash: string;
    policyHash: string;
    operatingHash: string;
  } | null;
  orderSubmissionAllowed: false;
  learningAllowed: false;
  liveEnabled: false;
};

function feeFor(
  p: CostProfile,
  quantity: number,
  price: string,
  side: "BUY" | "SELL",
  at: number,
) {
  const groups: CostPlan["groups"] = [];
  for (const unit of new Set(
    p.rules.filter((r) => r.side === side).map((r) => r.unit),
  )) {
    const count = unit === "FILL" ? quantity : 1;
    for (let i = 0; i < count; i++)
      groups.push({
        id: `synthetic-${i}`,
        unit,
        side,
        at,
        quantity: quantity / count,
        notional: d(price)
          .mul(quantity / count)
          .toString(),
      });
  }
  return evaluateCostPlan(p, {
    purpose: "TEST_ONLY",
    profileHash: hash(p),
    scope: p.scope,
    asOf: at,
    complete: true,
    groups,
  });
}

// State is an internal engine snapshot. External payloads must first pass its
// existing state/repository boundary. This module never mutates that snapshot.
export function evaluateCostSizing(
  s: State,
  rawProfile: unknown,
  rawRequest: unknown,
  operatingHistory?: unknown,
  exposure?: CostExposure,
): CostSizingResult {
  const result: CostSizingResult = {
    status: "ABSTAIN",
    quantity: 0,
    reasons: [],
    candidate: null,
    evaluated: 0,
    rejectedBy: {},
    binding: null,
    orderSubmissionAllowed: false,
    learningAllowed: false,
    liveEnabled: false,
  };
  const hold = (...reasons: string[]) => ({ ...result, reasons });
  if (exposure) {
    try {
      assertCostExposure(exposure, s);
    } catch {
      return hold("UNVERIFIED_COST_EXPOSURE");
    }
    if (exposure.entryBlockReasons.length)
      return hold(...exposure.entryBlockReasons);
  }
  const pp = costProfileSchema.safeParse(rawProfile),
    rp = requestSchema.safeParse(rawRequest);
  if (!pp.success) return hold("INVALID_COST_PROFILE");
  if (!rp.success) return hold("INVALID_COST_SIZING_REQUEST");
  const p = pp.data,
    r = rp.data;
  if (
    !configSchema.safeParse(s.config).success ||
    !s.config ||
    s.config.forecast !== "TEST_ONLY"
  )
    return hold("SYNTHETIC_CONFIG_REQUIRED");
  if (
    r.stateHash !== hash(s) ||
    r.profileHash !== hash(p) ||
    p.scope.market !== s.config.market ||
    p.scope.product !== r.product
  )
    return hold("COST_BINDING_MISMATCH");
  if (
    s.clock < p.effectiveFrom ||
    s.clock >= p.effectiveTo ||
    s.clock < p.availableAt
  )
    return hold("COST_TIME_MISMATCH");
  if (r.forecast.availableAt > s.clock || r.forecast.validUntil <= s.clock)
    return hold("SCENARIO_STALE");
  // Existing exposure still uses the old cost model. Never mix that estimate
  // with this nonlinear model and imply a safe portfolio/order approval.
  if (
    !exposure &&
    (s.positions.some((v) => v.quantity > 0) ||
      s.orders.some((o) => !terminal(o)))
  )
    return hold("EXISTING_EXPOSURE_COST_UNRECONCILED");
  if (exposure?.entries.some((e) => e.symbol === r.symbol))
    return hold("EXISTING_SYMBOL_REENTRY_UNSUPPORTED");
  if (p.rules.some((v) => v.unit === "DAY"))
    return hold("DAY_COST_CONTEXT_REQUIRED");
  const reasons = guards(s, r.quote, r.signalAt, r.symbol, operatingHistory);
  if (reasons.length) return hold(...reasons);
  const operating = resolveOperatingCost(s, operatingHistory);
  if (operating.amount === null || !operating.binding)
    return hold("OPERATING_COST_UNKNOWN");
  const P = tick(r.quote.ask, r.tickSize, true),
    S = tick(r.stop, r.tickSize);
  const parameters = spec.strategies.find(
    (v) => v.id === r.strategy,
  )!.parameters;
  const distance = d(P).minus(S);
  if (
    d(S).lte(0) ||
    distance.lt(d(r.atr).mul(parameters.stop_distance_atr_min)) ||
    distance.gt(d(r.atr).mul(parameters.stop_distance_atr_max)) ||
    d(P).gt(
      d(r.signalClose).plus(
        d(r.atr).mul(policy.execution.maximum_entry_premium_atr),
      ),
    )
  )
    return hold("PROTECTION_DISTANCE_OR_ENTRY_PREMIUM");
  const adverse = d(r.tickSize).mul(r.adverseExitTicks);
  const stopExecution = d(S).minus(adverse),
    expectedExecution = d(r.forecast.expectedExit).minus(adverse),
    q05Execution = d(r.forecast.q05Exit).minus(adverse);
  if (stopExecution.lte(0) || expectedExecution.lte(0) || q05Execution.lte(0))
    return hold("INVALID_EXIT_SCENARIO");
  const FX = fxFor(s.ledger, p.scope.currency),
    cash = exposure
      ? d(exposure.available[p.scope.currency])
      : availableCash(s, p.scope.currency),
    c = caps(s),
    budget = exposure?.budgetKrw ?? remainingRisk(s),
    occupied = d(exposure?.notionalKrw ?? "0");
  const upper = max(
    0,
    min(
      d(c.position).div(d(P).mul(FX)),
      max(0, d(c.notional).minus(occupied)).div(d(P).mul(FX)),
      cash.div(P),
      d(r.quote.askSize)
        .mul(policy.execution.maximum_best_ask_size_participation_bps)
        .div(10_000),
      d(r.quote.lastMinuteVolume)
        .mul(policy.execution.maximum_last_minute_volume_participation_bps)
        .div(10_000),
    ).floor(),
  ).toNumber();
  if (upper === 0) return hold("NO_INTEGER_QUANTITY");
  // Resource limit, NOT a new trading limit: refuse rather than silently clip.
  if (upper > 1_000) return hold("SYNTHETIC_SEARCH_LIMIT");
  result.binding = {
    requestHash: hash(r),
    stateHash: hash(s),
    profileHash: hash(p),
    policyHash,
    operatingHash: hash(operating.binding),
  };
  for (let q = upper; q > 0; q--) {
    result.evaluated++;
    const entry = feeFor(p, q, P, "BUY", s.clock),
      stop = feeFor(p, q, stopExecution.toString(), "SELL", s.clock),
      expected = feeFor(p, q, expectedExecution.toString(), "SELL", s.clock),
      q05 = feeFor(p, q, q05Execution.toString(), "SELL", s.clock);
    if (
      entry.status !== "OK" ||
      stop.status !== "OK" ||
      expected.status !== "OK" ||
      q05.status !== "OK"
    )
      return hold("COST_PLAN_NOT_EVALUABLE");
    const stopCost = ceil(
      d(entry.total).plus(stop.total).plus(adverse.mul(q)).mul(FX),
    );
    const roundTrip = ceil(
      d(entry.total).plus(expected.total).plus(adverse.mul(q)).mul(FX),
    );
    const entryBound = exposure
      ? estimateFeeBound(p, "BUY", q, P, s.clock)
      : entry.total;
    const riskCost = exposure
      ? ceil(
          d(entryBound)
            .plus(
              estimateFeeBound(
                p,
                "SELL",
                q,
                stopExecution.toString(),
                s.clock,
                policy.execution.emergency_exit.maximum_replacements + 1,
              ),
            )
            .plus(adverse.mul(q))
            .mul(FX),
        )
      : stopCost;
    const risk = ceil(distance.mul(q).mul(FX).plus(riskCost));
    const paid = d(P).mul(q).plus(entryBound);
    const economicCost = d(roundTrip).plus(operating.amount);
    const gross = d(r.forecast.expectedExit).minus(P).mul(q).mul(FX);
    const netQ05 = d(r.forecast.q05Exit)
      .minus(P)
      .mul(q)
      .mul(FX)
      .minus(ceil(d(entry.total).plus(q05.total).plus(adverse.mul(q)).mul(FX)))
      .minus(operating.amount);
    const afterE = equity(s).minus(d(entryBound).mul(FX));
    const afterForeign =
      !exposure && p.scope.currency === "USD"
        ? foreignNet(s).minus(d(entryBound).mul(FX))
        : foreignNet(s);
    const foreignCap = floor(
      max(0, min(s.config.capital, afterE, s.ledger.periods.day.startEquity))
        .mul(policy.risk.foreign_currency_assets_bps)
        .div(10_000),
    );
    const rejected = [
      ...(d(risk).gt(budget) ? ["RISK_BUDGET"] : []),
      ...(paid.gt(cash) ? ["CASH"] : []),
      ...(paid.mul(FX).gt(c.position) ||
      paid.mul(FX).plus(occupied).gt(c.notional)
        ? ["EXPOSURE"]
        : []),
      ...(afterForeign.gt(foreignCap) ? ["FOREIGN_EXPOSURE"] : []),
      ...(!economic(
        gross.toString(),
        economicCost.toString(),
        // Policy R0 is price risk; stop costs belong to reservation risk only.
        distance.mul(q).mul(FX).toString(),
        netQ05.toString(),
        c.trade,
      )
        ? ["ECONOMIC_GATE"]
        : []),
    ];
    for (const key of rejected)
      result.rejectedBy[key] = (result.rejectedBy[key] ?? 0) + 1;
    if (rejected.length) continue;
    return {
      ...result,
      status: "RESEARCH_CANDIDATE",
      quantity: q,
      candidate: {
        quantity: q,
        entry: P,
        stop: S,
        riskKrw: risk,
        budgetKrw: budget,
        entryFeeNative: entry.total,
        stopTradingCostKrw: stopCost,
        roundTripTradingCostKrw: roundTrip,
        operatingEstimateKrw: operating.amount,
        economicCostKrw: economicCost.toString(),
        expectedGrossKrw: gross.toString(),
        netQ05Krw: netQ05.toString(),
        entryCashNative: paid.toString(),
        tickCostNative: d(r.tickSize).mul(q).toString(),
        tickRatioBps: d(r.tickSize).div(P).mul(10_000).toString(),
        spreadEmbeddedNative: d(r.quote.ask)
          .minus(r.quote.bid)
          .mul(q)
          .toString(),
        adverseExitNative: adverse.mul(q).toString(),
        ...(exposure
          ? {
              reservationCashNative: paid.toString(),
              riskTradingCostUpperKrw: riskCost,
            }
          : {}),
      },
    };
  }
  return hold("NO_FEASIBLE_QUANTITY", ...Object.keys(result.rejectedBy).sort());
}
