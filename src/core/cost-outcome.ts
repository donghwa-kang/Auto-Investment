import { hash, policy, policyHash } from "./policy.js";
import { d, sum } from "./math.js";
import { latch } from "./ledger.js";
import { replayCostJournal } from "./cost-journal.js";
import { outcomeKind } from "./cost-reservation.js";
import type { ReservationState } from "./cost-reservation.js";
import type { HandoffConfig } from "./cost-handoff.js";
import type { Currency } from "./types.js";
import { operatingKind } from "./cost-operating.js";
import type { CostLoopConfig } from "./cost-loop-schema.js";

export interface OutcomeConfig extends Omit<HandoffConfig, "kind"> {
  kind: typeof outcomeKind;
  executionLoop?: CostLoopConfig;
}
export interface ClosedCostOutcome {
  runId: string;
  reservationId: string;
  symbol: string;
  currency: Currency;
  closedAt: number;
  closedRevision: number;
  quantity: number;
  buyValue: string;
  sellValue: string;
  tradingFees: string;
  netPnlNative: string;
  initialBudgetKrw: string;
  fx: string | null;
  fxAt: number | null;
  netPnlKrw: string | null;
  cooldownUntil: number;
  counterApplied: boolean;
  lossStreakAfter: number | null;
  pendingReasons: string[];
  basisHash: string;
}

// Called only inside the handoff reducer, before the same writer transaction
// persists state/fill identity/audit. No independent money or outcome write.
export function recordClosedOutcomes(s: ReservationState) {
  if (
    ![outcomeKind, operatingKind].includes(s.kind) ||
    !s.outcomes ||
    !s.handoff
  )
    throw Error("OUTCOME_V3_REQUIRED");
  const hold = (reason: string) => {
    if (!s.handoff!.admissionHolds.includes(reason))
      s.handoff!.admissionHolds.push(reason);
  };
  for (const transfer of s.handoff.transfers) {
    if (s.outcomes.some((o) => o.runId === transfer.runId)) continue;
    const source = s.book.sources.find(
      (v) => v.config.runId === transfer.runId,
    )!;
    const view = replayCostJournal(source.config, source.events);
    const buys = view.postings.filter((p) => p.side === "BUY");
    if (
      !buys.length ||
      view.quantity !== 0 ||
      !view.orders.every((o) => ["FILLED", "CANCELLED"].includes(o.status))
    )
      continue;
    const approval = s.approvals.find((a) => a.id === transfer.reservationId)!;
    const buyValue = sum(buys.map((p) => p.value));
    const sellValue = sum(
      view.postings.filter((p) => p.side === "SELL").map((p) => p.value),
    );
    const tradingFees = sum(view.postings.map((p) => p.feeDelta));
    const nativePnl = sellValue.minus(buyValue).minus(tradingFees);
    const fxFresh =
      view.currency === "KRW" ||
      (Number.isSafeInteger(s.seed.ledger.fxAt) &&
        s.seed.ledger.fxAt <= s.seed.clock &&
        s.seed.clock - s.seed.ledger.fxAt <=
          policy.execution.maximum_fx_age_seconds * 1000 &&
        d(s.seed.ledger.fx).gt(0));
    const fx = fxFresh
      ? view.currency === "KRW"
        ? "1"
        : s.seed.ledger.fx
      : null;
    const pnl = fx === null ? null : nativePnl.mul(fx);
    const pendingReasons: string[] = [];
    if (s.kind === operatingKind)
      pendingReasons.push("OPERATING_ALLOCATION_NOT_FINAL");
    if (!fxFresh) pendingReasons.push("CLOSE_FX_RECONCILIATION_REQUIRED");
    // A later win must not reset a streak across an unresolved earlier close.
    if (s.outcomes.some((o) => !o.counterApplied))
      pendingReasons.push("CLOSE_SEQUENCE_RECONCILIATION_REQUIRED");
    const cooldownUntil =
      s.seed.clock + policy.risk.reentry_cooldown_minutes * 60000;
    s.seed.ledger.cooldowns[source.config.execution.instrument] = cooldownUntil;
    const counterApplied = pendingReasons.length === 0;
    if (counterApplied && pnl !== null) {
      if (pnl.lt(0)) s.seed.ledger.lossStreak++;
      else if (pnl.gt(0)) s.seed.ledger.lossStreak = 0;
      if (s.seed.ledger.lossStreak >= policy.risk.consecutive_loss_halt_count)
        latch(s.seed, "CONSECUTIVE_LOSSES");
    }
    // Even across a sequence gap, a known excessive loss still latches safety.
    if (pnl !== null && pnl.neg().gt(d(approval.candidate.budgetKrw).mul(2)))
      latch(s.seed, "STOP_LOSS_EXCEEDS_2X");
    for (const reason of pendingReasons) hold(reason);
    s.outcomes.push({
      runId: transfer.runId,
      reservationId: transfer.reservationId,
      symbol: source.config.execution.instrument,
      currency: view.currency,
      closedAt: s.seed.clock,
      closedRevision: s.revision,
      quantity: buys.reduce((n, p) => n + p.fill.quantity, 0),
      buyValue: buyValue.toString(),
      sellValue: sellValue.toString(),
      tradingFees: tradingFees.toString(),
      netPnlNative: nativePnl.toString(),
      initialBudgetKrw: approval.candidate.budgetKrw,
      fx,
      fxAt: fx === null || view.currency === "KRW" ? null : s.seed.ledger.fxAt,
      netPnlKrw: pnl?.toString() ?? null,
      cooldownUntil,
      counterApplied,
      lossStreakAfter: counterApplied ? s.seed.ledger.lossStreak : null,
      pendingReasons,
      basisHash: hash({
        contract: outcomeKind,
        policyHash,
        config: source.config,
        events: source.events,
        approval,
        closedRevision: s.revision,
        closedAt: s.seed.clock,
        observedFx: s.seed.ledger.fx,
        observedFxAt: s.seed.ledger.fxAt,
      }),
    });
  }
  s.book.seedHash = hash(s.seed);
}
