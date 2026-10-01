import { d, sum, tick } from "./math.js";
import { hash, policy } from "./policy.js";
import { profile } from "./risk.js";
import { holdingDeadline } from "./events.js";
import { exitTarget } from "./execution-loop-rules.js";
import { costWatchdogNeedsPulse } from "./cost-watchdog.js";
import { replayCostJournal } from "./cost-journal.js";
import { outcomeKind } from "./cost-reservation.js";
import { operatingKind } from "./cost-operating.js";
import type { CostJournalEvent } from "./cost-journal.js";
import type { ReservationState } from "./cost-reservation.js";
import type { ExtendedHandoffCommand } from "./cost-handoff.js";
import type { CostLoopTick } from "./cost-loop-schema.js";

type Step = Exclude<
  ExtendedHandoffCommand,
  { kind: "COST_LOOP_TICK" | "COST_LOOP_PULSE" }
>;
type EventInput = CostJournalEvent extends infer E
  ? E extends CostJournalEvent
    ? Omit<E, "id" | "seq" | "at">
    : never
  : never;
const terminal = (status: string) => ["FILLED", "CANCELLED"].includes(status);
const unknown = (status: string) =>
  ["UNKNOWN", "CANCEL_UNKNOWN"].includes(status);

// Pure, bounded synthetic reducer. The store calls it inside its existing
// single writer transaction. No I/O, promises, AI or secondary money writer.
export function applyCostLoopTick(
  previous: ReservationState,
  command: CostLoopTick,
  epoch: number,
  apply: (state: ReservationState, command: Step) => ReservationState,
): ReservationState {
  if (previous.finalization?.checkpoint)
    throw Error("FINALIZED_FINANCIAL_MUTATION_BLOCKED");
  if (
    !previous.loop ||
    !previous.handoff ||
    !(
      (previous.kind === outcomeKind &&
        previous.loop.config.kind === "SYNTHETIC_COST_LOOP_V1") ||
      (previous.kind === operatingKind &&
        previous.operating &&
        previous.loop.config.kind === "SYNTHETIC_COST_OPERATING_LOOP_V1")
    )
  )
    throw Error("COST_LOOP_OPT_IN_REQUIRED");
  const executionRevision =
    previous.revision -
    (previous.operating?.events.length ?? 0) -
    (previous.operating?.rejectedInputs.length ?? 0);
  if (executionRevision >= 5200 || previous.loop.ticks >= 4096)
    throw Error("COST_LOOP_COMMAND_LIMIT");
  if (!Number.isSafeInteger(epoch) || epoch < previous.epoch)
    throw Error("COST_LOOP_EPOCH");
  if (
    previous.book.sources.length !== 1 ||
    previous.handoff.transfers.length !== 1
  )
    throw Error("COST_LOOP_SINGLE_HANDOFF_REQUIRED");
  const initialSource = previous.book.sources[0]!,
    approval = previous.approvals.find(
      (a) => a.id === previous.handoff!.transfers[0]!.reservationId,
    )!,
    at = command.at,
    q = command.quote;
  if (
    initialSource.config.execution.instrument !== command.instrument ||
    initialSource.config.execution.profile.scope.currency !== "KRW"
  )
    throw Error("COST_LOOP_INSTRUMENT");
  if (
    at < previous.seed.clock ||
    at <= (previous.loop.lastTickAt ?? -1) ||
    at < (previous.loop.watchdog?.lastPulseAt ?? 0) ||
    at > previous.handoff.horizonEnd
  )
    throw Error("COST_LOOP_TIME_OR_HORIZON");
  if (q.at > at || d(q.bid).gt(q.ask)) throw Error("COST_LOOP_INVALID_QUOTE");
  if (
    previous.loop.watchdog &&
    costWatchdogNeedsPulse(previous, {
      kind: "COST_LOOP_PULSE",
      purpose: "TEST_ONLY",
      instrument: command.instrument,
      at,
    })
  )
    throw Error("COST_WATCHDOG_CHECK_REQUIRED");
  let s = structuredClone(previous);
  s.loop!.ticks++;
  s.loop!.lastTickAt = at;
  s.loop!.holds = [];
  const hold = (reason: string) => {
    if (!s.loop!.holds.includes(reason)) s.loop!.holds.push(reason);
  };
  const blockExit = () => {
    s.loop!.exitBlocked = true;
    hold("EXIT_PRICE_OR_REPLACEMENT_LIMIT");
  };
  if (s.loop!.exitBlocked) hold("EXIT_PRICE_OR_REPLACEMENT_LIMIT");
  const source = () => s.book.sources[0]!;
  const view = () => replayCostJournal(source().config, source().events);
  const event = (e: EventInput) => {
    const seq = source().events.length + 1;
    s = apply(s, {
      kind: "EXECUTION",
      runId: source().config.runId,
      event: {
        ...e,
        seq,
        at,
        id: `loop-${s.loop!.ticks}-${seq}`,
      } as CostJournalEvent,
    });
  };
  const fresh = q.at === at && !q.halted;
  if (s.loop!.watchdog) {
    if (fresh) s.loop!.watchdog.lastQuoteAt = q.at;
    for (const reason of s.loop!.watchdog.holds) hold(reason);
  }
  const observe = () => {
    const v = view(),
      sell = v.orders.find((o) => o.side === "SELL" && !terminal(o.status)),
      suspected =
        s.loop!.triggeredAt === at &&
        (s.loop!.reason === "STOP" || s.loop!.reason === "TARGET");
    s = apply(s, {
      kind: "OBSERVE",
      at,
      fx: s.seed.ledger.fx,
      fxAt: at,
      accountAt: at,
      observations: [
        {
          runId: source().config.runId,
          observation: {
            at,
            bid: q.bid,
            stop: approval.candidate.stop,
            protection:
              v.quantity === 0 && v.orders.every((o) => terminal(o.status))
                ? "CLOSED_RECONCILED"
                : s.loop!.holds.length
                  ? "EXIT_BLOCKED"
                  : sell
                    ? sell.filled
                      ? "EXIT_PARTIAL"
                      : "EXIT_WORKING"
                    : suspected
                      ? "TRIGGER_SUSPECTED"
                      : s.loop!.reason
                        ? "TRIGGERED"
                        : "WATCHING",
            protectedQuantity: v.quantity,
          },
        },
      ],
    });
  };
  if (!fresh) hold(q.halted ? "HALTED_QUOTE" : "STALE_QUOTE");
  // Explicit fixture settlement of previously committed fills, never real T+N.
  const pending = view().postings.filter(
    (p) => p.settledAt === null && p.fill.at < at,
  );
  if (pending.length)
    event({ kind: "SETTLE", fillIds: pending.map((p) => p.fill.fillId) });

  // Only orders present at tick start can execute. Newly submitted exits must
  // await a strictly later executable quote and the pinned fixture latency.
  for (const original of view().orders) {
    let o = view().orders.find((v) => v.id === original.id)!;
    if (terminal(o.status)) continue;
    if (unknown(o.status)) {
      hold("ORDER_RECONCILIATION_REQUIRED");
      continue;
    }
    const cancel = source().events.findLast(
      (e) => e.kind === "CANCEL_REQUEST" && e.orderId === o.id,
    );
    if (
      o.status === "CANCEL_PENDING" &&
      cancel &&
      at >= cancel.at + s.loop!.config.cancelLatencyMs
    ) {
      event({
        kind: "CANCEL_CONFIRMED",
        orderId: o.id,
        cumulativeQuantity: o.filled,
        cumulativeValue: o.value,
        evidenceAt: at,
      });
      continue;
    }
    if (
      o.side === "BUY" &&
      o.status !== "CANCEL_PENDING" &&
      at - o.at >= policy.execution.cancel_unfilled_entry_after_seconds * 1000
    ) {
      event({ kind: "CANCEL_REQUEST", orderId: o.id });
      o = view().orders.find((v) => v.id === o.id)!;
    }
    const price = o.side === "BUY" ? q.ask : q.bid;
    const quantity = Math.min(
      o.quantity - o.filled,
      profile.execution.maxUnitsPerFill,
      o.side === "BUY" ? q.askSize : q.bidSize,
    );
    if (
      fresh &&
      quantity > 0 &&
      at > o.at &&
      at - o.at >= profile.execution.latencyMs &&
      (o.side === "BUY" ? d(price).lte(o.limit) : d(price).gte(o.limit))
    ) {
      event({
        kind: "FILL",
        orderId: o.id,
        fillId: `loop-fill-${s.loop!.ticks}-${source().events.length + 1}`,
        quantity,
        price,
        occurredAt: at,
      });
    }
  }
  // Refresh quantity and mark together before evaluating portfolio risk.
  if (fresh) observe();
  let v = view();
  const buys = v.postings.filter((p) => p.side === "BUY");
  if (buys.length) {
    const buyQuantity = buys.reduce((n, p) => n + p.fill.quantity, 0);
    s.loop!.target = exitTarget(
      sum(buys.map((p) => p.value))
        .div(buyQuantity)
        .toString(),
      approval.candidate.stop,
      profile.ticks.KR,
    );
    // Receipt order is not execution order. A delayed earlier fill may only
    // shorten the holding window; never move a previously known deadline out.
    s.loop!.deadline = Math.min(
      s.loop!.deadline ?? Infinity,
      holdingDeadline(
        Math.min(...buys.map((p) => p.fill.occurredAt)),
        s.seed.sessionClose,
        profile.eventCalendar.events,
      ),
    );
    if (v.quantity > 0) {
      // Risk/time cannot wait for quote confirmation or an AI result. STOP and
      // TARGET preserve the legacy rule: suspected now, exit on the next tick.
      if (s.seed.ledger.halts.length) {
        s.loop!.reason = "RISK";
        s.loop!.triggeredAt ??= at;
      } else if (!s.loop!.reason && at >= s.loop!.deadline) {
        s.loop!.reason = "TIME";
        s.loop!.triggeredAt = at;
      } else if (
        !s.loop!.reason &&
        fresh &&
        (d(q.bid).lte(approval.candidate.stop) || d(q.bid).gte(s.loop!.target))
      ) {
        s.loop!.reason = d(q.bid).lte(approval.candidate.stop)
          ? "STOP"
          : "TARGET";
        s.loop!.triggeredAt = at;
      }
      const ready =
        s.loop!.reason &&
        (["RISK", "TIME"].includes(s.loop!.reason) ||
          at > s.loop!.triggeredAt!);
      if (ready) {
        for (const o of v.orders.filter(
          (o) => o.side === "BUY" && !terminal(o.status),
        ))
          if (!unknown(o.status) && o.status !== "CANCEL_PENDING")
            event({ kind: "CANCEL_REQUEST", orderId: o.id });
        v = view();
        const activeBuy = v.orders.some(
          (o) => o.side === "BUY" && !terminal(o.status),
        );
        const sells = v.orders.filter((o) => o.side === "SELL"),
          last = sells.at(-1);
        if (!activeBuy && fresh && !s.loop!.exitBlocked) {
          s.loop!.referenceBid ??= q.bid;
          const floor = tick(
            d(s.loop!.referenceBid).mul(
              d(1).minus(d(profile.execution.maxAdversePriceBps).div(10000)),
            ),
            profile.ticks.KR,
            true,
          );
          if (last && !terminal(last.status)) {
            if (
              !unknown(last.status) &&
              last.status !== "CANCEL_PENDING" &&
              at - last.lastAt >=
                policy.execution.emergency_exit.no_progress_review_seconds *
                  1000
            ) {
              if (
                last.replacements >=
                  policy.execution.emergency_exit.maximum_replacements ||
                d(q.bid).lt(floor)
              )
                blockExit();
              else event({ kind: "CANCEL_REQUEST", orderId: last.id });
            }
          } else {
            const limit = tick(
              s.loop!.reason === "STOP" && !last
                ? approval.candidate.stop
                : q.bid,
              profile.ticks.KR,
            );
            if (
              d(limit).lt(floor) ||
              (last &&
                last.replacements >=
                  policy.execution.emergency_exit.maximum_replacements)
            )
              blockExit();
            else
              event({
                kind: "ORDER",
                orderId: `loop-exit-${sells.length}`,
                side: "SELL",
                quantity: v.quantity,
                limit,
                replaces: last?.id ?? null,
              });
          }
        }
      }
    }
  }
  v = view();
  if (fresh && buys.length) {
    const loss = sum(buys.map((p) => p.value))
      .plus(v.tradingFees)
      .minus(
        sum(v.postings.filter((p) => p.side === "SELL").map((p) => p.value)),
      )
      .minus(d(q.bid).mul(v.quantity));
    if (
      loss.gt(approval.candidate.budgetKrw) &&
      !s.handoff!.admissionHolds.includes("EXECUTION_BUDGET_EXCEEDED")
    )
      s.handoff!.admissionHolds.push("EXECUTION_BUDGET_EXCEEDED");
  }
  const closed = v.quantity === 0 && v.orders.every((o) => terminal(o.status));
  if (at === s.handoff!.horizonEnd && !closed)
    hold("OBSERVATION_HORIZON_EXHAUSTED");
  for (const reason of s.handoff!.admissionHolds) hold(reason);
  s.loop!.status = s.loop!.holds.length
    ? "HOLD"
    : closed
      ? "CLOSED"
      : s.loop!.reason
        ? "EXITING"
        : buys.length
          ? "WATCHING"
          : "WAITING";
  if (fresh) observe();
  s.seed.clock = at;
  for (const reason of s.handoff!.admissionHolds) hold(reason);
  if (s.loop!.holds.length) s.loop!.status = "HOLD";
  s.epoch = epoch;
  s.seed.epoch = epoch;
  s.revision = previous.revision + 1;
  s.book.seedHash = hash(s.seed);
  return s;
}
