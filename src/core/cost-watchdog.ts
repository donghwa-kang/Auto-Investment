import { hash, policy } from "./policy.js";
import { profile } from "./risk.js";
import { holdingDeadline } from "./events.js";
import { replayCostJournal } from "./cost-journal.js";
import { costLoopPulseSchema } from "./cost-loop-schema.js";
import type { ReservationState } from "./cost-reservation.js";
import { outcomeKind } from "./cost-reservation.js";
import { operatingKind } from "./cost-operating.js";

// Time is not a quote, fill, cancellation acknowledgement or settlement proof.
// This projector never calls the execution/financial reducers.
function project(previous: ReservationState, raw: unknown) {
  if (previous.finalization?.checkpoint)
    throw Error("FINALIZED_FINANCIAL_MUTATION_BLOCKED");
  const command = costLoopPulseSchema.parse(raw),
    loop = previous.loop;
  if (
    !(
      (previous.kind === outcomeKind &&
        loop?.config.kind === "SYNTHETIC_COST_LOOP_V1") ||
      (previous.kind === operatingKind &&
        previous.operating &&
        loop?.config.kind === "SYNTHETIC_COST_OPERATING_LOOP_V1")
    ) ||
    !loop?.config.watchdog ||
    !loop.watchdog ||
    !previous.handoff ||
    previous.book.sources.length !== 1 ||
    previous.handoff.transfers.length !== 1
  )
    throw Error("COST_WATCHDOG_OPT_IN_REQUIRED");
  const source = previous.book.sources[0]!,
    at = command.at,
    w = loop.watchdog;
  if (
    source.config.execution.instrument !== command.instrument ||
    source.config.execution.profile.scope.currency !== "KRW"
  )
    throw Error("COST_WATCHDOG_INSTRUMENT");
  if (at < Math.max(previous.seed.clock, w.lastPulseAt ?? 0))
    throw Error("COST_WATCHDOG_TIME_REGRESSION");
  const v = replayCostJournal(source.config, source.events),
    active = v.orders.filter(
      (o) => !["FILLED", "CANCELLED"].includes(o.status),
    ),
    buys = v.postings.filter((p) => p.side === "BUY"),
    unresolved =
      active.length > 0 ||
      v.quantity > 0 ||
      v.postings.some((p) => p.settledAt === null),
    quoteAt = w.lastQuoteAt ?? previous.approvals[0]!.proposal.request.quote.at,
    holds = new Set(w.holds);
  let deadline = loop.deadline,
    reason = loop.reason,
    triggeredAt = loop.triggeredAt;
  if (buys.length)
    deadline = Math.min(
      deadline ?? Infinity,
      holdingDeadline(
        Math.min(...buys.map((p) => p.fill.occurredAt)),
        previous.seed.sessionClose,
        profile.eventCalendar.events,
      ),
    );
  if (
    unresolved &&
    at - quoteAt > policy.execution.maximum_quote_age_seconds * 1000
  )
    holds.add("WATCHDOG_INPUT_STALE");
  if (active.some((o) => ["UNKNOWN", "CANCEL_UNKNOWN"].includes(o.status)))
    holds.add("ORDER_RECONCILIATION_REQUIRED");
  if (
    active.some(
      (o) =>
        o.side === "BUY" &&
        at - o.at >=
          policy.execution.cancel_unfilled_entry_after_seconds * 1000,
    )
  )
    holds.add("WATCHDOG_ENTRY_CANCEL_REQUIRED");
  if (
    active.some(
      (o) =>
        o.side === "SELL" &&
        at - o.lastAt >=
          policy.execution.emergency_exit.no_progress_review_seconds * 1000,
    )
  )
    holds.add("WATCHDOG_EXIT_REVIEW_REQUIRED");
  if (v.quantity > 0 && deadline !== null && at >= deadline) {
    holds.add("WATCHDOG_TIME_EXIT_REQUIRED");
    reason ??= "TIME";
    triggeredAt ??= at;
  }
  if (unresolved && at >= previous.handoff.horizonEnd)
    holds.add("WATCHDOG_HORIZON_EXHAUSTED");
  return { command, deadline, reason, triggeredAt, holds: [...holds].sort() };
}
export function costWatchdogNeedsPulse(s: ReservationState, raw: unknown) {
  const p = project(s, raw),
    l = s.loop!;
  return (
    p.deadline !== l.deadline ||
    p.reason !== l.reason ||
    p.triggeredAt !== l.triggeredAt ||
    hash(p.holds) !== hash(l.watchdog!.holds)
  );
}
export function applyCostWatchdog(
  previous: ReservationState,
  raw: unknown,
  epoch: number,
): ReservationState {
  const p = project(previous, raw);
  if (!Number.isSafeInteger(epoch) || epoch < previous.epoch)
    throw Error("COST_LOOP_EPOCH");
  if (!costWatchdogNeedsPulse(previous, raw))
    throw Error("COST_WATCHDOG_NO_CHANGE");
  // Reserve the rest of the existing command budget for evidence/exit handling.
  const executionRevision =
    previous.revision -
    (previous.operating?.events.length ?? 0) -
    (previous.operating?.rejectedInputs.length ?? 0);
  if (executionRevision >= 5200 || previous.loop!.watchdog!.pulses >= 64)
    throw Error("COST_WATCHDOG_COMMAND_LIMIT");
  const s = structuredClone(previous),
    l = s.loop!,
    w = l.watchdog!;
  w.lastPulseAt = p.command.at;
  w.pulses++;
  w.holds = p.holds;
  l.deadline = p.deadline;
  l.reason = p.reason;
  l.triggeredAt = p.triggeredAt;
  l.holds = [...new Set([...l.holds, ...w.holds])];
  if (w.holds.length) {
    l.status = "HOLD";
    if (!s.handoff!.admissionHolds.includes("WATCHDOG_REVIEW_REQUIRED"))
      s.handoff!.admissionHolds.push("WATCHDOG_REVIEW_REQUIRED");
  }
  // Keep financial as-of, marks, outcome counters and all source events intact.
  s.epoch = s.seed.epoch = epoch;
  s.revision++;
  s.book.seedHash = hash(s.seed);
  return s;
}
