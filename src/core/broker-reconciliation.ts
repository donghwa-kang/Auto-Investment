import { z } from "zod";
import { d, sum } from "./math.js";
import { hash, policy } from "./policy.js";
import { applyOrderEvent } from "./simulator.js";
import {
  controlTime,
  evidenceActions,
  mockId,
  routeFor,
  warn,
  type ControlState,
} from "./broker-control.js";
import type { State } from "./types.js";

const localId = z.string().min(1).max(200);
const quantity = z.number().int().min(0).max(1_000_000);
const money = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/);
export const openCaseSchema = z
  .object({
    id: mockId,
    orderId: localId,
    routeId: mockId,
    requestIds: z.array(mockId).max(4).default([]),
  })
  .strict();
export const reconciliationCaseSchema = z
  .object({
    id: mockId,
    orderId: localId,
    routeId: mockId,
    requestIds: z.array(mockId).max(4),
    confirmedFills: z
      .array(z.object({ id: mockId, hash: z.string() }).strict())
      .max(100),
    lastAsOf: controlTime.nullable(),
    lastHash: z.string().nullable(),
    status: z.enum(["UNRESOLVED", "TERMINAL_CONFIRMED"]),
    reason: z.string().max(100),
  })
  .strict();
export type ReconciliationCase = z.infer<typeof reconciliationCaseSchema>;
const receipt = z
  .object({
    requestId: mockId,
    asOf: controlTime,
    availableAt: controlTime,
    coverageFrom: controlTime,
    complete: z.boolean(),
  })
  .strict();
export const reconciliationSchema = z
  .object({
    schemaVersion: z.literal("OFFLINE_RECONCILIATION_V1"),
    purpose: z.literal("TEST_ONLY"),
    caseId: mockId,
    orderId: localId,
    positionId: localId,
    symbol: localId,
    routeId: mockId,
    asOf: controlTime,
    order: receipt
      .extend({
        status: z.enum(["WORKING", "PARTIAL", "CANCELLED", "FILLED"]),
        filled: quantity,
        value: money,
      })
      .strict(),
    fills: receipt
      .extend({
        items: z
          .array(
            z
              .object({
                id: mockId,
                at: controlTime,
                quantity: quantity.refine((n) => n > 0),
                value: money,
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
    position: receipt.extend({ quantity }).strict(),
  })
  .strict();
export type ReconciliationEvidence = z.infer<typeof reconciliationSchema>;

export function openReconciliationCase(
  s: State,
  control: ControlState,
  raw: unknown,
): ReconciliationCase {
  const c = openCaseSchema.parse(raw);
  const order = s.orders.find((o) => o.id === c.orderId);
  const position = s.positions.find((p) => p.id === order?.positionId);
  const route = routeFor(control, c.routeId);
  const market = position?.market ?? order?.snapshot?.market;
  const symbol = position?.symbol ?? order?.snapshot?.instrument_id;
  if (
    !order ||
    !["UNKNOWN", "CANCEL_UNKNOWN"].includes(order.status) ||
    (order.side === "SELL" && !position) ||
    (position && position.owner !== "BOT") ||
    !symbol ||
    market !== route.market ||
    s.positions.some(
      (p) => p.id !== order.positionId && p.symbol === symbol && p.quantity > 0,
    ) ||
    s.orders.some(
      (o) =>
        o.id !== order.id &&
        o.positionId === order.positionId &&
        !["FILLED", "CANCELLED", "REJECTED"].includes(o.status),
    )
  )
    throw Error("RECONCILIATION_ISOLATED_UNKNOWN_ORDER_REQUIRED");
  if (new Set(c.requestIds).size !== c.requestIds.length)
    throw Error("RECONCILIATION_REQUEST_DUPLICATE");
  for (const id of c.requestIds) {
    const record = control.records.find((r) => r.request.id === id);
    const r = record && routeFor(control, record.request.routeId);
    if (
      !record ||
      record.status !== "UNKNOWN" ||
      record.sentAt === null ||
      record.request.orderId !== order.id ||
      !["ENTRY", "EXIT", "CANCEL"].includes(record.request.action) ||
      !r ||
      r.provider !== route.provider ||
      r.account !== route.account ||
      r.environment !== route.environment ||
      r.market !== route.market
    )
      throw Error("RECONCILIATION_REQUEST_BINDING_INVALID");
  }
  return {
    ...c,
    confirmedFills: [],
    lastAsOf: null,
    lastHash: null,
    status: "UNRESOLVED",
    reason: "THREE_COMPLETE_SNAPSHOTS_REQUIRED",
  };
}

// 합성 증거의 정합성 검사이며 공급자 진본 인증이나 실제 API 수용이 아니다.
export function reconcileMockOrder(
  s: State,
  control: ControlState,
  c: ReconciliationCase,
  raw: unknown,
) {
  const parsed = reconciliationSchema.safeParse(raw);
  const hold = (reason: string) => {
    c.status = "UNRESOLVED";
    c.reason = reason;
    s.status = "RECONCILING";
    control.mode = "PAUSED";
    warn(control, "ORDER_UNRESOLVED_DO_NOT_REPLACE_MANUAL_REVIEW");
    return { result: "HOLD" as const, reason };
  };
  if (!parsed.success) return hold("EVIDENCE_INVALID");
  const e = parsed.data,
    order = s.orders.find((o) => o.id === c.orderId),
    position = s.positions.find((p) => p.id === order?.positionId);
  if (!order || (order.side === "SELL" && !position))
    return hold("LOCAL_ORDER_MISSING");
  if (
    e.caseId !== c.id ||
    e.orderId !== order.id ||
    e.positionId !== order.positionId ||
    e.symbol !== (position?.symbol ?? order.snapshot?.instrument_id) ||
    e.routeId !== c.routeId
  )
    return hold("EVIDENCE_IDENTITY_MISMATCH");
  const proofHash = hash(e);
  if (c.lastHash === proofHash)
    return { result: "DUPLICATE" as const, reason: "ALREADY_APPLIED" };
  if (c.status === "TERMINAL_CONFIRMED")
    return hold("TERMINAL_CONFLICT_REQUIRES_MANUAL_REVIEW");
  if (c.lastAsOf !== null && e.asOf <= c.lastAsOf)
    return hold("OLD_OR_CONFLICTING_EVIDENCE");
  if (!["UNKNOWN", "CANCEL_UNKNOWN"].includes(order.status))
    return hold("LOCAL_ORDER_NOT_UNKNOWN");
  if (
    e.asOf < order.submittedAt ||
    c.requestIds.some(
      (id) =>
        e.asOf <
        (control.records.find((r) => r.request.id === id)?.sentAt ?? Infinity),
    ) ||
    e.asOf > control.now ||
    control.now - e.asOf >
      policy.execution.maximum_account_snapshot_age_seconds * 1000
  )
    return hold("EVIDENCE_STALE_OR_FUTURE");
  const route = routeFor(control, c.routeId);
  const receipts = [e.order, e.fills, e.position];
  if (new Set(receipts.map((r) => r.requestId)).size !== 3)
    return hold("EVIDENCE_REQUEST_REUSED");
  for (const [i, proof] of receipts.entries()) {
    const request = control.records.find(
      (r) => r.request.id === proof.requestId,
    );
    if (
      !request ||
      request.status !== "OK" ||
      request.sentAt === null ||
      request.responseAt === null ||
      request.epoch !== control.epoch ||
      request.request.action !== evidenceActions[i] ||
      request.request.caseId !== c.id
    )
      return hold("EVIDENCE_QUERY_NOT_COMPLETE");
    const r = routeFor(control, request.request.routeId);
    if (
      r.provider !== route.provider ||
      r.account !== route.account ||
      r.environment !== route.environment ||
      r.market !== route.market
    )
      return hold("EVIDENCE_ACCOUNT_MISMATCH");
    if (
      !proof.complete ||
      proof.coverageFrom > order.submittedAt ||
      proof.asOf !== e.asOf ||
      proof.availableAt < proof.asOf ||
      proof.availableAt < request.sentAt ||
      proof.availableAt !== request.responseAt ||
      proof.availableAt > control.now
    )
      return hold("EVIDENCE_COVERAGE_OR_CUTOFF_MISMATCH");
  }
  const fills = new Map<string, (typeof e.fills.items)[number]>();
  for (const fill of e.fills.items) {
    if (
      fill.at < order.submittedAt ||
      fill.at > e.asOf ||
      d(fill.value).lte(0) ||
      (order.side === "SELL"
        ? d(fill.value).div(fill.quantity).lt(order.limit)
        : d(fill.value).div(fill.quantity).gt(order.limit))
    )
      return hold("FILL_TIME_OR_LIMIT_INVALID");
    const prior = fills.get(fill.id);
    if (prior && hash(prior) !== hash(fill)) return hold("FILL_ID_CONFLICT");
    fills.set(fill.id, fill);
  }
  const filled = [...fills.values()].reduce((n, f) => n + f.quantity, 0);
  if (
    c.confirmedFills.some(
      (prior) =>
        !fills.has(prior.id) || hash(fills.get(prior.id)) !== prior.hash,
    )
  )
    return hold("CONFIRMED_FILL_HISTORY_CHANGED");
  const value = sum([...fills.values()].map((f) => f.value));
  if (
    filled !== e.order.filled ||
    !value.eq(e.order.value) ||
    filled < order.filled ||
    filled > order.quantity ||
    value.lt(order.value)
  )
    return hold("CUMULATIVE_FILL_MISMATCH");
  if (filled === order.filled && !value.eq(order.value))
    return hold("CUMULATIVE_FILL_VALUE_CONFLICT");
  if (
    (e.order.status === "FILLED") !== (filled === order.quantity) ||
    (e.order.status === "WORKING" && filled !== 0) ||
    (e.order.status === "PARTIAL" && filled === 0)
  )
    return hold("ORDER_STATUS_QUANTITY_MISMATCH");
  if (
    e.position.quantity !==
    (position?.quantity ?? 0) +
      (order.side === "BUY" ? 1 : -1) * (filled - order.filled)
  )
    return hold("POSITION_QUANTITY_MISMATCH");
  const terminal = ["CANCELLED", "FILLED"].includes(e.order.status);
  applyOrderEvent(s, order, {
    id: `mock-reconcile-${proofHash}`,
    version: order.version + 1,
    cumulativeFilled: filled,
    cumulativeValue: value.toString(),
    status: terminal
      ? e.order.status === "FILLED"
        ? "FILLED"
        : "CANCELLED"
      : order.status,
  });
  c.lastAsOf = e.asOf;
  c.lastHash = proofHash;
  c.confirmedFills = [...fills.values()].map((f) => ({
    id: f.id,
    hash: hash(f),
  }));
  c.status = terminal ? "TERMINAL_CONFIRMED" : "UNRESOLVED";
  c.reason = terminal
    ? "THREE_WAY_TERMINAL_CONFIRMED"
    : "PARTIAL_CONFIRMED_REMAINDER_UNKNOWN";
  s.status = "RECONCILING";
  control.mode = "PAUSED";
  if (terminal)
    for (const record of control.records)
      if (
        c.requestIds.includes(record.request.id) &&
        record.status === "UNKNOWN"
      ) {
        record.status = "OK";
        record.reason = "ORDER_EVIDENCE_CONFIRMED";
      }
  return {
    result: terminal ? ("CONFIRMED" as const) : ("PARTIAL_ONLY" as const),
    reason: c.reason,
  };
}
