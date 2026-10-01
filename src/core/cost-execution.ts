import { z } from "zod";
import { d, sum } from "./math.js";
import { hash, policy, policyHash } from "./policy.js";
import {
  costAmountSchema,
  costProfileSchema,
  positiveCostAmountSchema,
} from "./transaction-cost.js";
import type { CostProfile } from "./transaction-cost.js";
import { costKernelContract, evaluateOrderCost } from "./cost-kernel.js";

export const costExecutionKind = "SYNTHETIC_COST_EXECUTION_V1";
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const time = z.number().int().safe().nonnegative().max(8_640_000_000_000_000);
const quantity = z.number().int().min(1).max(1000);
export const costExecutionConfigSchema = z
  .object({
    kind: z.literal(costExecutionKind),
    purpose: z.literal("TEST_ONLY"),
    provenance: z.literal("SYNTHETIC_FIXTURE"),
    liveEnabled: z.literal(false),
    policyHash: z.literal(policyHash),
    instrument: id,
    initialAt: time,
    initialCash: costAmountSchema,
    settlement: z.literal("SYNTHETIC_IMMEDIATE"),
    profile: costProfileSchema,
  })
  .strict();
export type CostExecutionConfig = z.infer<typeof costExecutionConfigSchema>;
const base = {
  id,
  seq: z.number().int().min(1).max(500),
  at: time,
  orderId: id,
};
export const costExecutionEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("ORDER"),
      side: z.enum(["BUY", "SELL"]),
      quantity,
      limit: positiveCostAmountSchema,
      replaces: id.nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("FILL"),
      fillId: id,
      quantity,
      price: positiveCostAmountSchema,
      occurredAt: time,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.enum(["CANCEL_REQUEST", "UNKNOWN", "CANCEL_UNKNOWN"]),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("CANCEL_CONFIRMED"),
      cumulativeQuantity: z.number().int().min(0).max(1000),
      cumulativeValue: costAmountSchema,
      evidenceAt: time,
    })
    .strict(),
]);
export type CostExecutionEvent = z.infer<typeof costExecutionEventSchema>;
type Status =
  | "WORKING"
  | "PARTIAL"
  | "UNKNOWN"
  | "CANCEL_PENDING"
  | "CANCEL_UNKNOWN"
  | "CANCELLED"
  | "FILLED";
export interface CostOrder {
  id: string;
  side: "BUY" | "SELL";
  quantity: number;
  filled: number;
  limit: string;
  value: string;
  charged: string;
  reservedCash: string;
  status: Status;
  at: number;
  lastAt: number;
  replaces: string | null;
  replacements: number;
}
export interface CostFill {
  id: string;
  orderId: string;
  quantity: number;
  price: string;
  value: string;
  occurredAt: number;
  availableAt: number;
  feeDelta: string;
}
export interface CostExecutionView {
  status: "OK";
  kind: typeof costExecutionKind;
  currency: "KRW" | "USD";
  configHash: string;
  journalHash: string;
  profileHash: string;
  cash: string;
  reservedCash: string;
  availableCash: string;
  quantity: number;
  reservedSellQuantity: number;
  orders: CostOrder[];
  fills: CostFill[];
  uniqueEvents: number;
  report: {
    costBasisHash: string;
    buyValue: string;
    sellValue: string;
    tradingFees: string;
    tradingNetPnl: string | null;
    allOrdersTerminal: boolean;
    operatingCosts: "UNRESOLVED";
  };
  learningEvidence: {
    costBasisHash: string;
    tradingFees: string;
    tradingNetPnl: string | null;
    status: "HOLD";
    reasons: string[];
  };
  orderSubmissionAllowed: false;
  learningAllowed: false;
  liveEnabled: false;
}
export type CostExecutionResult =
  | CostExecutionView
  | {
      status: "HOLD";
      reasons: string[];
      orderSubmissionAllowed: false;
      learningAllowed: false;
      liveEnabled: false;
    };
class CostReplayError extends Error {}
function fail(code: string): never {
  throw new CostReplayError(code);
}
const terminal = (o: CostOrder) =>
  o.status === "CANCELLED" || o.status === "FILLED";

function kernelOrder(
  profile: CostProfile,
  order: CostOrder,
  fills: CostFill[],
  at: number,
  mode: "CHARGE_ONLY" | "WITH_RESERVATION",
) {
  const result = evaluateOrderCost(profile, {
    contract: costKernelContract,
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    policyHash,
    profileHash: hash(profile),
    scope: profile.scope,
    asOf: at,
    mode,
    order: {
      id: order.id,
      side: order.side,
      quantity: order.quantity,
      limit: order.limit,
      at: order.at,
      terminal: terminal(order),
    },
    fills: fills.map((f) => ({
      id: f.id,
      orderId: f.orderId,
      quantity: f.quantity,
      price: f.price,
      occurredAt: f.occurredAt,
      availableAt: f.availableAt,
    })),
  });
  if (result.status !== "OK") return fail(result.reasons[0]!);
  return result;
}

function view(
  config: CostExecutionConfig,
  events: CostExecutionEvent[],
  orders: CostOrder[],
  fills: CostFill[],
  at: number,
): CostExecutionView {
  for (const o of orders) {
    const actual = kernelOrder(
      config.profile,
      o,
      fills.filter((f) => f.orderId === o.id),
      at,
      "WITH_RESERVATION",
    );
    if (o.charged !== actual.charges.total) fail("COST_POSTING_MISMATCH");
    if (actual.reservedCash === null) fail("COST_RESERVATION_NOT_EVALUATED");
    o.reservedCash = actual.reservedCash;
  }
  const buy = orders.filter((o) => o.side === "BUY"),
    sell = orders.filter((o) => o.side === "SELL");
  const buyValue = sum(buy.map((o) => o.value)),
    sellValue = sum(sell.map((o) => o.value)),
    tradingFees = sum(orders.map((o) => o.charged));
  const cash = d(config.initialCash)
    .minus(buyValue)
    .plus(sellValue)
    .minus(tradingFees);
  const reservedCash = sum(orders.map((o) => o.reservedCash));
  const quantity =
    buy.reduce((n, o) => n + o.filled, 0) -
    sell.reduce((n, o) => n + o.filled, 0);
  const reservedSellQuantity = sell
    .filter((o) => !terminal(o))
    .reduce((n, o) => n + o.quantity - o.filled, 0);
  if (cash.lt(0) || cash.lt(reservedCash)) fail("INSUFFICIENT_SYNTHETIC_CASH");
  if (quantity < 0 || reservedSellQuantity > quantity)
    fail("OVERSELL_OR_RESERVED_QUANTITY");
  if (!sum(fills.map((f) => f.feeDelta)).eq(tradingFees))
    fail("FEE_DELTA_MISMATCH");
  const allOrdersTerminal = orders.every(terminal);
  const closed = fills.length > 0 && quantity === 0 && allOrdersTerminal;
  const tradingNetPnl = closed
    ? sellValue.minus(buyValue).minus(tradingFees).toString()
    : null;
  const configHash = hash(config),
    journalHash = hash(events),
    profileHash = hash(config.profile);
  const costBasisHash = hash({
    configHash,
    journalHash,
    profileHash,
    orders,
    fills,
  });
  return {
    status: "OK",
    kind: costExecutionKind,
    currency: config.profile.scope.currency,
    configHash,
    journalHash,
    profileHash,
    cash: cash.toString(),
    reservedCash: reservedCash.toString(),
    availableCash: cash.minus(reservedCash).toString(),
    quantity,
    reservedSellQuantity,
    orders,
    fills,
    uniqueEvents: events.length,
    report: {
      costBasisHash,
      buyValue: buyValue.toString(),
      sellValue: sellValue.toString(),
      tradingFees: tradingFees.toString(),
      tradingNetPnl,
      allOrdersTerminal,
      operatingCosts: "UNRESOLVED",
    },
    learningEvidence: {
      costBasisHash,
      tradingFees: tradingFees.toString(),
      tradingNetPnl,
      status: "HOLD",
      reasons: [
        ...(!closed ? ["TRADE_NOT_CLOSED"] : []),
        "OPERATING_COST_ALLOCATION_UNSUPPORTED",
        "SYNTHETIC_COST_ENGINE_NOT_INTEGRATED",
      ],
    },
    orderSubmissionAllowed: false,
    learningAllowed: false,
    liveEnabled: false,
  };
}

export function replayCostExecutions(
  rawConfig: unknown,
  rawEvents: unknown,
): CostExecutionResult {
  return replay(rawConfig, rawEvents);
}

// Detached prefix views for journal validation. Reuse the same lifecycle once,
// rather than replaying the entire execution prefix for every audit record.
export function replayCostExecutionFrames(
  rawConfig: unknown,
  rawEvents: unknown,
) {
  const frames: CostExecutionView[] = [];
  const result = replay(rawConfig, rawEvents, (value) =>
    frames.push(structuredClone(value)),
  );
  return { result, frames };
}

function replay(
  rawConfig: unknown,
  rawEvents: unknown,
  observe?: (value: CostExecutionView) => void,
): CostExecutionResult {
  const hold = (reason: string): CostExecutionResult => ({
    status: "HOLD",
    reasons: [reason],
    orderSubmissionAllowed: false,
    learningAllowed: false,
    liveEnabled: false,
  });
  const cp = costExecutionConfigSchema.safeParse(rawConfig),
    ep = z.array(costExecutionEventSchema).max(500).safeParse(rawEvents);
  if (!cp.success) return hold("INVALID_EXECUTION_CONFIG");
  if (!ep.success) return hold("INVALID_EXECUTION_EVENTS");
  const c = cp.data;
  if (c.profile.rules.some((r) => r.unit !== "ORDER" && r.unit !== "FILL"))
    return hold("EXECUTION_CHARGE_UNIT_UNSUPPORTED");
  if (
    c.initialAt < c.profile.effectiveFrom ||
    c.initialAt >= c.profile.effectiveTo ||
    c.profile.availableAt > c.initialAt
  )
    return hold("EXECUTION_PROFILE_TIME");
  const events: CostExecutionEvent[] = [],
    orders: CostOrder[] = [],
    fills: CostFill[] = [];
  const eventIds = new Map<string, string>();
  let at = c.initialAt;
  try {
    let current = view(c, events, orders, fills, at);
    observe?.(current);
    for (const e of ep.data) {
      const prior = eventIds.get(e.id);
      if (prior) {
        if (prior !== hash(e)) fail("EXECUTION_EVENT_ID_CONFLICT");
        continue;
      }
      if (e.seq !== events.length + 1) fail("EXECUTION_SEQUENCE_GAP");
      if (e.at < at || e.at >= c.profile.effectiveTo)
        fail("EXECUTION_TIME_REGRESSION_OR_EXPIRY");
      at = e.at;
      if (e.kind === "ORDER") {
        if (orders.length >= 20 || orders.some((o) => o.id === e.orderId))
          fail("DUPLICATE_OR_EXCESS_ORDER");
        if (
          orders.some((o) => ["UNKNOWN", "CANCEL_UNKNOWN"].includes(o.status))
        )
          fail("UNRESOLVED_ORDER_NO_NEW_ORDER");
        if (
          e.side === "BUY" &&
          (orders.some((o) => o.side === "BUY") || e.replaces !== null)
        )
          fail("ONE_SYNTHETIC_ENTRY_ONLY");
        if (
          e.side === "SELL" &&
          orders.some((o) => o.side === "BUY" && !terminal(o))
        )
          fail("ENTRY_NOT_TERMINAL");
        if (
          e.side === "SELL" &&
          e.replaces === null &&
          orders.some((o) => o.side === "SELL")
        )
          fail("SELL_REPLACEMENT_LINK_REQUIRED");
        const held = orders.reduce(
          (n, o) => n + (o.side === "BUY" ? o.filled : -o.filled),
          0,
        );
        // One exit chain only: partial fills are supported, separate partial
        // liquidation orders would strand holdings once this chain terminates.
        if (e.side === "SELL" && e.quantity < held)
          fail("FULL_EXIT_QUANTITY_REQUIRED");
        let replacements = 0;
        if (e.replaces !== null) {
          const old = orders.find((o) => o.id === e.replaces);
          if (
            !old ||
            old.side !== "SELL" ||
            e.side !== "SELL" ||
            old.status !== "CANCELLED" ||
            orders.some((o) => o.replaces === old.id) ||
            e.quantity > old.quantity - old.filled
          )
            fail("REPLACEMENT_REQUIRES_CONFIRMED_REMAINDER");
          replacements = old.replacements + 1;
          if (
            replacements > policy.execution.emergency_exit.maximum_replacements
          )
            fail("REPLACEMENT_LIMIT");
        }
        orders.push({
          id: e.orderId,
          side: e.side,
          quantity: e.quantity,
          filled: 0,
          limit: e.limit,
          value: "0",
          charged: "0",
          reservedCash: "0",
          status: "WORKING",
          at,
          lastAt: at,
          replaces: e.replaces,
          replacements,
        });
      } else {
        const o = orders.find((o) => o.id === e.orderId);
        if (!o) fail("UNKNOWN_EXECUTION_ORDER");
        if (e.kind === "FILL") {
          const oldFill = fills.find((f) => f.id === e.fillId);
          const value = d(e.price).mul(e.quantity).toString();
          if (oldFill) {
            if (
              oldFill.orderId !== e.orderId ||
              oldFill.quantity !== e.quantity ||
              oldFill.price !== e.price ||
              oldFill.occurredAt !== e.occurredAt
            )
              fail("EXECUTION_FILL_ID_CONFLICT");
          } else {
            if (terminal(o)) fail("FILL_AFTER_CONFIRMED_TERMINAL");
            if (e.occurredAt < o.at || e.occurredAt > e.at)
              fail("FILL_TIME_INVALID");
            if (o.filled + e.quantity > o.quantity) fail("OVERFILL");
            if (
              (o.side === "BUY" && d(e.price).gt(o.limit)) ||
              (o.side === "SELL" && d(e.price).lt(o.limit))
            )
              fail("FILL_LIMIT_VIOLATION");
            const f: CostFill = {
              id: e.fillId,
              orderId: o.id,
              quantity: e.quantity,
              price: e.price,
              value,
              occurredAt: e.occurredAt,
              availableAt: e.at,
              feeDelta: "0",
            };
            const total = kernelOrder(
              c.profile,
              o,
              [...fills.filter((f) => f.orderId === o.id), f],
              at,
              "CHARGE_ONLY",
            );
            f.feeDelta = d(total.charges.total).minus(o.charged).toString();
            if (d(f.feeDelta).lt(0)) fail("NEGATIVE_FEE_DELTA_UNSUPPORTED");
            fills.push(f);
            o.charged = total.charges.total;
            o.value = d(o.value).plus(value).toString();
            o.filled += e.quantity;
            if (o.filled === o.quantity) o.status = "FILLED";
            else if (o.status === "WORKING" || o.status === "PARTIAL")
              o.status = "PARTIAL";
            o.lastAt = at;
          }
        } else {
          if (terminal(o)) fail("EVENT_AFTER_CONFIRMED_TERMINAL");
          if (e.kind === "CANCEL_CONFIRMED") {
            if (
              e.evidenceAt < o.lastAt ||
              e.evidenceAt > at ||
              e.cumulativeQuantity !== o.filled ||
              !d(e.cumulativeValue).eq(o.value)
            )
              fail("CANCEL_EVIDENCE_MISMATCH");
            o.status = "CANCELLED";
          } else if (e.kind === "CANCEL_REQUEST") {
            if (!["WORKING", "PARTIAL"].includes(o.status))
              fail("CANCEL_REQUEST_STATE");
            o.status = "CANCEL_PENDING";
          } else if (e.kind === "CANCEL_UNKNOWN") {
            if (
              !["CANCEL_PENDING", "UNKNOWN", "CANCEL_UNKNOWN"].includes(
                o.status,
              )
            )
              fail("CANCEL_UNKNOWN_STATE");
            o.status = "CANCEL_UNKNOWN";
          } else o.status = "UNKNOWN";
          o.lastAt = at;
        }
      }
      events.push(e);
      eventIds.set(e.id, hash(e));
      current = view(c, events, orders, fills, at);
      observe?.(current);
    }
    return current;
  } catch (error) {
    if (error instanceof CostReplayError) return hold(error.message);
    throw error;
  }
}
