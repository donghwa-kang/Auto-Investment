import { bindSnapshot, hash, policyHash, spec } from "./policy.js";
import { d, sum } from "./math.js";
import { fee, profile } from "./risk.js";
import {
  paperExportSchema,
  PaperLearningError,
  type PaperExport,
  type RecordedOrder,
} from "./paper-learning-schema.js";

export const paperTerminal = (o: RecordedOrder) =>
  ["FILLED", "CANCELLED", "REJECTED"].includes(o.status);
const requireValue = (ok: boolean) => {
  if (!ok) throw new PaperLearningError("PAPER_LEARNING_EVIDENCE_MISMATCH");
};
export function verifyPaperExport(raw: unknown): PaperExport {
  try {
    return verifyEvidence(raw);
  } catch (error) {
    if (error instanceof PaperLearningError) throw error;
    throw new PaperLearningError("PAPER_LEARNING_EVIDENCE_MISMATCH");
  }
}
function verifyEvidence(raw: unknown): PaperExport {
  let x: PaperExport;
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024 * 1024)
      throw new Error();
    x = paperExportSchema.parse(raw);
  } catch {
    throw new PaperLearningError("PAPER_LEARNING_EXPORT_INVALID");
  }
  const { exportHash, ...body } = x,
    j = x.journal;
  requireValue(
    hash(body) === exportHash &&
      j.policyHash === policyHash &&
      j.strategyHash === hash(spec) &&
      j.profileHash === hash(profile) &&
      x.revision === x.auditCount &&
      j.startedAt <= x.asOf,
  );
  for (const ids of [
    j.decisions.map((v) => v.id),
    j.fills.map((v) => v.id),
    j.closures.map((v) => v.positionId),
    (j.featureSources ?? []).map((v) => v.decisionId),
    x.orders.map((v) => v.id),
    x.positions.map((v) => v.id),
    x.costs.map((v) => v.id),
  ])
    requireValue(new Set(ids).size === ids.length);
  const decisions = new Map(j.decisions.map((v) => [v.id, v]));
  requireValue(
    (j.featureSources ?? []).every((v) => decisions.has(v.decisionId)),
  );
  for (const dec of j.decisions) {
    requireValue(
      dec.at >= j.startedAt &&
        dec.at <= x.asOf &&
        dec.trace.every((t) => t.as_of <= dec.at),
    );
    const orders = x.orders.filter(
      (o) => o.side === "BUY" && o.snapshot?.signal_id === dec.id,
    );
    requireValue(
      dec.result === "APPROVED"
        ? orders.length === 1 &&
            dec.quantity > 0 &&
            !!dec.strategy &&
            orders[0]!.snapshotHash === dec.snapshotHash
        : orders.length === 0 && dec.quantity === 0,
    );
  }
  const fillsByOrder = new Map<string, typeof j.fills>();
  for (const f of j.fills) {
    const group = fillsByOrder.get(f.orderId) ?? [];
    group.push(f);
    fillsByOrder.set(f.orderId, group);
  }
  for (const o of x.orders) {
    requireValue(
      o.filled <= o.quantity &&
        d(o.value).gte(0) &&
        d(o.limit).gt(0) &&
        o.submittedAt >= j.startedAt &&
        o.submittedAt <= x.asOf,
    );
    requireValue(
      (o.status === "FILLED") === (o.filled === o.quantity) &&
        new Set(o.eventIds).size === o.eventIds.length,
    );
    if (o.side === "BUY") {
      const snap = o.snapshot,
        dec = decisions.get(String(snap?.signal_id));
      requireValue(!!snap && !!dec && dec.result === "APPROVED");
      requireValue(
        bindSnapshot(snap!) === o.snapshotHash &&
          snap!.policy_hash === policyHash &&
          snap!.portfolio_run_hash === j.runHash &&
          snap!.account_alias === "LOCAL_SYNTHETIC" &&
          snap!.mode === "PAPER",
      );
      requireValue(
        snap!.model_version === "SYNTHETIC_FORECAST_V1" &&
          snap!.cost_model_version === profile.version &&
          snap!.execution_model_hash === hash(profile.execution) &&
          snap!.forecast_profile_hash === hash(profile.forecast) &&
          snap!.evaluator_version === "DECIMAL40_V1",
      );
      requireValue(
        snap!.instrument_id === dec!.symbol &&
          snap!.strategy_version === `${dec!.strategy}:1.0` &&
          snap!.quantity === dec!.quantity &&
          o.quantity === dec!.quantity &&
          o.submittedAt === dec!.at &&
          snap!.entry_price === o.limit &&
          o.intentId === o.id,
      );
      requireValue(
        ["KR", "US"].includes(String(snap!.market)) &&
          o.currency === (snap!.market === "KR" ? "KRW" : "USD") &&
          dec!.symbol.startsWith(`${snap!.market}:`),
      );
      requireValue(
        Number.isFinite(Number(snap!.signal_at)) &&
          Number(snap!.signal_at) <= dec!.at &&
          Number(snap!.quote_at) <= dec!.at &&
          d(String(snap!.stop_price)).gt(0) &&
          d(o.limit).gt(String(snap!.stop_price)),
      );
    }
    const fills = fillsByOrder.get(o.id) ?? [];
    let quantity = 0,
      value = d(0),
      last = o.submittedAt;
    for (const f of fills) {
      quantity += f.quantity;
      value = value.plus(f.value);
      requireValue(
        f.at > last &&
          f.at <= x.asOf &&
          f.positionId === o.positionId &&
          f.side === o.side &&
          f.currency === o.currency &&
          o.eventIds.includes(f.id),
      );
      requireValue(
        quantity === f.cumulativeQuantity &&
          value.eq(f.cumulativeValue) &&
          d(f.value).gt(0) &&
          fee(f.value, f.side).eq(f.fee),
      );
      requireValue(
        o.side === "BUY"
          ? d(f.value).div(f.quantity).lte(o.limit)
          : d(f.value).div(f.quantity).gte(o.limit),
      );
      last = f.at;
    }
    requireValue(quantity === o.filled && value.eq(o.value));
    requireValue(
      o.filled === 0 || x.positions.some((p) => p.id === o.positionId),
    );
    if (o.side === "SELL")
      requireValue(x.positions.some((p) => p.id === o.positionId));
  }
  requireValue(j.fills.every((f) => x.orders.some((o) => o.id === f.orderId)));
  for (const p of x.positions) {
    const orders = x.orders.filter((o) => o.positionId === p.id),
      buys = orders.filter((o) => o.side === "BUY"),
      sells = orders.filter((o) => o.side === "SELL"),
      fills = j.fills.filter((f) => f.positionId === p.id),
      b = fills.filter((f) => f.side === "BUY"),
      s = fills.filter((f) => f.side === "SELL");
    requireValue(
      buys.length === 1 &&
        buys[0]!.snapshot?.instrument_id === p.symbol &&
        buys[0]!.snapshot?.market === p.market &&
        buys[0]!.intentId === p.intentId &&
        orders.every((o) => o.currency === p.currency) &&
        p.currency === (p.market === "KR" ? "KRW" : "USD"),
    );
    requireValue(
      buys[0]!.filled === p.buyQuantity &&
        p.quantity ===
          p.buyQuantity - sells.reduce((n, o) => n + o.filled, 0) &&
        b[0]?.at === p.firstFillAt,
    );
    requireValue(
      sum(b.map((f) => f.value)).eq(p.buyValue) &&
        sum(s.map((f) => f.value)).eq(p.exitValue) &&
        sum(b.map((f) => f.fee)).eq(p.entryFees) &&
        sum(s.map((f) => f.fee)).eq(p.exitFees),
    );
    const closed = j.closures.find((c) => c.positionId === p.id);
    if (p.closedAt !== null) {
      requireValue(
        !!closed &&
          p.closedAt <= x.asOf &&
          p.closedAt >= Math.max(...fills.map((f) => f.at)) &&
          p.quantity === 0 &&
          orders.every(paperTerminal) &&
          p.protection === "CLOSED_RECONCILED",
      );
      requireValue(
        closed!.at === p.closedAt &&
          closed!.netPnlKrw === p.netPnl &&
          d(closed!.fx).gt(0) &&
          (p.currency !== "KRW" || d(closed!.fx).eq(1)),
      );
      requireValue(
        d(p.exitValue)
          .minus(p.buyValue)
          .minus(p.entryFees)
          .minus(p.exitFees)
          .mul(closed!.fx)
          .eq(closed!.netPnlKrw),
      );
    } else
      requireValue(
        !closed && p.netPnl === null && p.protection !== "CLOSED_RECONCILED",
      );
  }
  requireValue(
    j.closures.every((c) => x.positions.some((p) => p.id === c.positionId)),
  );
  requireValue(x.costs.every((c) => c.at <= x.asOf && d(c.amount).gte(0)));
  return x;
}
