import { hash, policyHash, spec } from "./policy.js";
import { d } from "./math.js";
import { fee, profile } from "./risk.js";
import type { State, Order, Position } from "./types.js";
import type { RvolSource } from "./learning-rvol-schema.js";
import {
  journalSchema,
  PaperLearningError,
  type PaperJournal,
  type RecordedOrder,
} from "./paper-learning-schema.js";

export function learningJournal(s: State): PaperJournal | null {
  const raw = s.manifest?.learningJournal;
  if (raw === undefined) return null;
  const parsed = journalSchema.safeParse(raw);
  if (!parsed.success)
    throw new PaperLearningError("PAPER_LEARNING_JOURNAL_INVALID");
  return parsed.data;
}
export function enableLearningCapture(s: State) {
  if (
    s.decisions.length ||
    s.orders.length ||
    s.positions.length ||
    s.revision !== 0
  )
    throw new PaperLearningError("PAPER_LEARNING_NEW_RUN_REQUIRED");
  s.manifest!.learningJournal = {
    schemaVersion: "PAPER_LEARNING_JOURNAL_V1",
    purpose: "TEST_ONLY",
    runHash: String(s.manifest!.runHash),
    policyHash,
    strategyHash: hash(spec),
    profileHash: hash(profile),
    startedAt: s.clock,
    featureSources: [],
    decisions: [],
    fills: [],
    closures: [],
  } satisfies PaperJournal;
}
export function recordOrder(o: Order): RecordedOrder {
  return {
    id: o.id,
    intentId: o.intentId,
    positionId: o.positionId,
    side: o.side,
    quantity: o.quantity,
    filled: o.filled,
    value: o.value,
    limit: o.limit,
    currency: o.currency,
    status: o.status,
    submittedAt: o.submittedAt,
    snapshot: o.snapshot ?? null,
    snapshotHash: o.snapshotHash ?? null,
    eventIds: [...o.eventIds],
  };
}
export function recordPosition(p: Position) {
  return {
    id: p.id,
    intentId: p.intentId,
    symbol: p.symbol,
    market: p.market,
    currency: p.currency,
    owner: p.owner,
    quantity: p.quantity,
    buyQuantity: p.buyQuantity,
    buyValue: p.buyValue,
    entryFees: p.entryFees,
    exitValue: p.exitValue,
    exitFees: p.exitFees,
    firstFillAt: p.firstFillAt,
    closedAt: p.closedAt ?? null,
    netPnl: p.netPnl ?? null,
    protection: p.protection,
  };
}
// 호출자는 이 함수를 장부와 같은 트랜잭션 안에서만 실행한다. 이전 확정 상태와의 차이를 보존한다.
export function captureLearningTransition(
  s: State,
  before: State,
  commandId: string,
  featureSource?: (decision: State["decisions"][number]) => RvolSource | null,
) {
  const j = learningJournal(before);
  if (!j) return;
  if (
    j.runHash !== s.manifest?.runHash ||
    j.policyHash !== policyHash ||
    j.profileHash !== hash(profile)
  )
    throw new PaperLearningError("PAPER_LEARNING_BINDING");
  const previousDecisions = new Map(before.decisions.map((x) => [x.id, x]));
  for (const decision of s.decisions) {
    const old = previousDecisions.get(decision.id);
    if (old && hash(old) !== hash(decision))
      throw new PaperLearningError("PAPER_LEARNING_DECISION_CHANGED");
    if (!old) {
      j.decisions.push(structuredClone(decision));
      // 과거 미수집 실행을 소급 활성화하지 않는다. 새 판단의 근거만 원자적으로 보존한다.
      if (j.featureSources && featureSource) {
        const source = featureSource(decision);
        if (source) j.featureSources.push(source);
      }
    }
  }
  if (before.decisions.some((x) => !s.decisions.some((v) => v.id === x.id)))
    throw new PaperLearningError("PAPER_LEARNING_RECORD_REMOVED");
  for (const order of s.orders) {
    const old = before.orders.find((o) => o.id === order.id),
      quantity = order.filled - (old?.filled ?? 0),
      value = d(order.value).minus(old?.value ?? "0");
    if (quantity < 0 || value.lt(0) || (quantity === 0 && !value.eq(0)))
      throw new PaperLearningError("PAPER_LEARNING_FILL_REGRESSION");
    if (quantity === 0) continue;
    const events = order.eventIds.filter((id) => !old?.eventIds.includes(id));
    if (events.length !== 1)
      throw new PaperLearningError("PAPER_LEARNING_AMBIGUOUS_FILL");
    j.fills.push({
      id: events[0]!,
      commandId,
      at: s.clock,
      orderId: order.id,
      positionId: order.positionId,
      side: order.side,
      currency: order.currency,
      quantity,
      value: value.toString(),
      fee: fee(value.toString(), order.side).toString(),
      cumulativeQuantity: order.filled,
      cumulativeValue: order.value,
    });
  }
  for (const p of s.positions)
    if (p.closedAt && !before.positions.find((q) => q.id === p.id)?.closedAt) {
      if (p.netPnl === undefined)
        throw new PaperLearningError("PAPER_LEARNING_CLOSURE_MISSING");
      j.closures.push({
        positionId: p.id,
        at: p.closedAt,
        fx: p.currency === "KRW" ? "1" : s.ledger.fx,
        netPnlKrw: p.netPnl,
      });
    }
  if (Buffer.byteLength(JSON.stringify(j)) > 8 * 1024 * 1024)
    throw new PaperLearningError("PAPER_LEARNING_JOURNAL_FULL");
  s.manifest!.learningJournal = journalSchema.parse(j);
}
