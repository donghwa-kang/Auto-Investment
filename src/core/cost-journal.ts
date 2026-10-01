import { z } from "zod";
import { d, max, sum } from "./math.js";
import { hash } from "./policy.js";
import {
  costExecutionConfigSchema,
  costExecutionEventSchema,
  replayCostExecutionFrames,
} from "./cost-execution.js";
import type {
  CostExecutionEvent,
  CostExecutionView,
} from "./cost-execution.js";
import { costKernelContract, evaluateOrderCost } from "./cost-kernel.js";
import type { CostLine } from "./transaction-cost.js";

export const costJournalKind = "SYNTHETIC_COST_JOURNAL_V1";
const id = costExecutionConfigSchema.shape.instrument;
const time = costExecutionConfigSchema.shape.initialAt;
export const costJournalConfigSchema = z
  .object({
    kind: z.literal(costJournalKind),
    runId: id,
    sourceScope: z
      .object({ provider: z.literal("SYNTHETIC"), account: id, namespace: id })
      .strict(),
    settlement: z.literal("SYNTHETIC_EXPLICIT_NEXT_EVENT"),
    operatingCosts: z.literal("EXPLICIT_ZERO_FIXTURE"),
    horizonEnd: time,
    execution: costExecutionConfigSchema,
  })
  .strict();
export type CostJournalConfig = z.infer<typeof costJournalConfigSchema>;
export const costJournalEventSchema = z.union([
  costExecutionEventSchema,
  z
    .object({
      kind: z.literal("SETTLE"),
      id,
      seq: z.number().int().min(1).max(500),
      at: time,
      fillIds: z.array(id).min(1).max(500),
    })
    .strict(),
]);
export type CostJournalEvent = z.infer<typeof costJournalEventSchema>;
type FillEvent = Extract<CostExecutionEvent, { kind: "FILL" }>;
export function journalFillKey(c: CostJournalConfig, fillId: string) {
  return hash({ runId: c.runId, sourceScope: c.sourceScope, fillId });
}
export function journalFillIdentity(e: FillEvent) {
  // Delivery ID, sequence and available-at may change on retransmission.
  return hash({
    fillId: e.fillId,
    orderId: e.orderId,
    quantity: e.quantity,
    price: e.price,
    occurredAt: e.occurredAt,
  });
}
export interface CostPosting {
  key: string;
  identityHash: string;
  eventSeq: number;
  fill: FillEvent;
  side: "BUY" | "SELL";
  currency: "KRW" | "USD";
  value: string;
  feeDelta: string;
  costBasisHash: string;
  lines: (CostLine & { amountDelta: string })[];
  receivable: string;
  payable: string;
  settledAt: number | null;
}
export interface CostJournalView {
  kind: typeof costJournalKind;
  configHash: string;
  journalHash: string;
  currency: "KRW" | "USD";
  wallet: {
    cash: string;
    receivable: string;
    payable: string;
    unpaidFees: "0";
  };
  availableCash: string;
  economicCash: string;
  reservedCash: string;
  quantity: number;
  reservedSellQuantity: number;
  orders: CostExecutionView["orders"];
  postings: CostPosting[];
  uniqueEvents: number;
  tradingFees: string;
  orderSubmissionAllowed: false;
  learningAllowed: false;
  liveEnabled: false;
}
const lineKey = (l: CostLine) =>
  hash({ ruleId: l.ruleId, groupId: l.groupId, unit: l.unit });

function deferredReserves(c: CostJournalConfig, view: CostExecutionView) {
  const orders = structuredClone(view.orders);
  for (const o of orders) {
    if (o.side !== "SELL" || o.status === "FILLED" || o.status === "CANCELLED")
      continue;
    let initial = d(0),
      perShare = d(0),
      proportional = d(0);
    for (const r of c.execution.profile.rules.filter(
      (r) => r.side === "SELL",
    )) {
      const rate = max(...r.tiers.map((t) => t.rate));
      if (r.basis === "NOTIONAL")
        proportional = proportional.plus(rate.div(10000));
      else perShare = perShare.plus(rate);
      // Bound every positive per-fill cash deficit independently: proceeds on
      // another fill remain receivable and cannot subsidize this deficit.
      perShare = perShare.plus(r.quantum);
      if (r.unit === "FILL") perShare = perShare.plus(max(r.minimum, r.fixed));
      else if (o.filled === 0) initial = initial.plus(max(r.minimum, r.fixed));
    }
    if (proportional.gt(1)) throw Error("SELL_COST_BOUND_UNSUPPORTED");
    o.reservedCash = initial
      .plus(
        max(0, perShare.plus(proportional.minus(1).mul(o.limit))).mul(
          o.quantity - o.filled,
        ),
      )
      .toString();
  }
  return {
    orders,
    reservedCash: sum(orders.map((o) => o.reservedCash)).toString(),
  };
}

// Reuse the existing lifecycle and kernel. Its immediate cash is ONLY an
// economic-value cross-check; it is never copied into the spendable wallet.
export function replayCostJournal(
  rawConfig: unknown,
  rawEvents: unknown,
): CostJournalView {
  return replayJournal(rawConfig, rawEvents, false).projection;
}
export function replayCostJournalTrace(rawConfig: unknown, rawEvents: unknown) {
  return replayJournal(rawConfig, rawEvents, true);
}
function replayJournal(rawConfig: unknown, rawEvents: unknown, trace: boolean) {
  const c = costJournalConfigSchema.parse(rawConfig),
    events = z.array(costJournalEventSchema).max(500).parse(rawEvents),
    ec = c.execution;
  if (c.horizonEnd < ec.initialAt || c.horizonEnd >= ec.profile.effectiveTo)
    throw Error("JOURNAL_PROFILE_HORIZON");
  const postings: CostPosting[] = [];
  const eventIds = new Set<string>();
  const paidLines = new Map<string, string>();
  let cash = d(ec.initialCash),
    at = ec.initialAt;
  const executions = events
    .filter((e): e is CostExecutionEvent => e.kind !== "SETTLE")
    .map((e, i) => ({ ...e, seq: i + 1 }));
  const { result, frames } = replayCostExecutionFrames(ec, executions);
  if (result.status !== "OK") throw Error(result.reasons[0]);
  let frameIndex = 0,
    current = frames[frameIndex]!;
  let reserved = deferredReserves(c, current);
  const wallet = () => {
    const pending = postings.filter((p) => p.settledAt === null);
    const receivable = sum(pending.map((p) => p.receivable)),
      payable = sum(pending.map((p) => p.payable));
    const available = cash.minus(payable).minus(reserved.reservedCash);
    if (cash.lt(0) || available.lt(0))
      throw Error("JOURNAL_INSUFFICIENT_SETTLED_CASH");
    const economic = cash.plus(receivable).minus(payable);
    if (!economic.eq(current.cash))
      throw Error("JOURNAL_ECONOMIC_CASH_MISMATCH");
    return {
      cash: cash.toString(),
      receivable: receivable.toString(),
      payable: payable.toString(),
      unpaidFees: "0" as const,
    };
  };
  const project = (): CostJournalView => {
    const w = wallet();
    if (!sum(postings.map((p) => p.feeDelta)).eq(current.report.tradingFees))
      throw Error("JOURNAL_FEES_MISMATCH");
    return {
      kind: costJournalKind,
      configHash: hash(c),
      journalHash: hash(events.slice(0, eventIds.size)),
      currency: current.currency,
      wallet: w,
      availableCash: d(w.cash)
        .minus(w.payable)
        .minus(reserved.reservedCash)
        .toString(),
      economicCash: d(w.cash).plus(w.receivable).minus(w.payable).toString(),
      reservedCash: reserved.reservedCash,
      quantity: current.quantity,
      reservedSellQuantity: current.reservedSellQuantity,
      orders: reserved.orders,
      postings,
      uniqueEvents: eventIds.size,
      tradingFees: current.report.tradingFees,
      orderSubmissionAllowed: false,
      learningAllowed: false,
      liveEnabled: false,
    };
  };
  const projectionHashes: string[] = trace ? [hash(project())] : [];
  for (const e of events) {
    if (eventIds.has(e.id)) throw Error("JOURNAL_DUPLICATE_EVENT");
    if (e.seq !== eventIds.size + 1) throw Error("JOURNAL_SEQUENCE_GAP");
    if (e.at < at || e.at > c.horizonEnd)
      throw Error("JOURNAL_TIME_OR_HORIZON");
    at = e.at;
    if (e.kind === "SETTLE") {
      if (new Set(e.fillIds).size !== e.fillIds.length)
        throw Error("JOURNAL_DUPLICATE_SETTLEMENT_FILL");
      for (const fillId of e.fillIds) {
        const p = postings.find((p) => p.fill.fillId === fillId);
        if (!p || p.settledAt !== null || e.at <= p.fill.at)
          throw Error("JOURNAL_INVALID_SETTLEMENT");
        cash = cash.plus(p.receivable).minus(p.payable);
        p.settledAt = e.at;
      }
    } else {
      // Preserve original event/sequence in the journal; the reused execution
      // stream has its own contiguous index after removing SETTLE events.
      current = frames[++frameIndex]!;
      reserved = deferredReserves(c, current);
      if (e.kind === "FILL") {
        if (postings.some((p) => p.key === journalFillKey(c, e.fillId)))
          throw Error("JOURNAL_DUPLICATE_FILL");
        const order = current.orders.find((o) => o.id === e.orderId)!;
        const fills = current.fills.filter((f) => f.orderId === e.orderId);
        const kernel = evaluateOrderCost(ec.profile, {
          contract: costKernelContract,
          purpose: ec.purpose,
          provenance: ec.provenance,
          policyHash: ec.policyHash,
          profileHash: hash(ec.profile),
          scope: ec.profile.scope,
          asOf: e.at,
          mode: "CHARGE_ONLY",
          order: {
            id: order.id,
            side: order.side,
            quantity: order.quantity,
            limit: order.limit,
            at: order.at,
            terminal: order.status === "FILLED" || order.status === "CANCELLED",
          },
          fills: fills.map(
            ({ id, orderId, quantity, price, occurredAt, availableAt }) => ({
              id,
              orderId,
              quantity,
              price,
              occurredAt,
              availableAt,
            }),
          ),
        });
        if (kernel.status !== "OK") throw Error(kernel.reasons[0]);
        const lines = kernel.charges.lines.flatMap((l) => {
          const key = lineKey(l),
            paid = paidLines.get(key);
          const delta = d(l.amount).minus(paid ?? "0");
          if (delta.lt(0)) throw Error("JOURNAL_NEGATIVE_COST_DELTA");
          paidLines.set(key, l.amount);
          // Retain new zero-cost evidence, but not repeated copies of every old
          // FILL line. ORDER entries hold cumulative charge plus its delta.
          return paid === undefined || !delta.isZero()
            ? [{ ...l, amountDelta: delta.toString() }]
            : [];
        });
        const fee = sum(lines.map((l) => l.amountDelta)),
          value = d(e.price).mul(e.quantity);
        const f = current.fills.find((f) => f.id === e.fillId)!;
        if (!fee.eq(f.feeDelta)) throw Error("JOURNAL_FEE_DELTA_MISMATCH");
        postings.push({
          key: journalFillKey(c, e.fillId),
          identityHash: journalFillIdentity(e),
          eventSeq: e.seq,
          fill: e,
          side: order.side,
          currency: current.currency,
          value: value.toString(),
          feeDelta: fee.toString(),
          costBasisHash: kernel.costBasisHash,
          lines,
          receivable:
            order.side === "SELL" ? max(0, value.minus(fee)).toString() : "0",
          payable:
            order.side === "BUY"
              ? value.plus(fee).toString()
              : max(0, fee.minus(value)).toString(),
          settledAt: null,
        });
      }
    }
    eventIds.add(e.id);
    wallet();
    if (trace) projectionHashes.push(hash(project()));
  }
  return { projection: project(), projectionHashes };
}
