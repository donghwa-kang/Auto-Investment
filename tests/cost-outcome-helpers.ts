import { outcomeKind } from "../src/core/cost-reservation.js";
import type { ReservationState } from "../src/core/cost-reservation.js";
import type { OutcomeConfig } from "../src/core/cost-outcome.js";
import type { CostJournalEvent } from "../src/core/cost-journal.js";
import { replayCostJournal } from "../src/core/cost-journal.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { Repository } from "../src/server/repository.js";
import { hash, policy } from "../src/core/policy.js";
import { handoffConfig } from "./cost-handoff-helpers.js";
import { proposal } from "./cost-reservation-helpers.js";
import type { CostProfile } from "../src/core/transaction-cost.js";

export function outcomeConfig(market: "KR" | "US" = "KR"): OutcomeConfig {
  const c = handoffConfig(market);
  return { ...c, kind: outcomeKind, horizonEnd: c.seed.clock + 80000 };
}
export function openedOutcome(c = outcomeConfig(), path = ":memory:") {
  const repo = new Repository(path, () => 1000);
  repo.acquire();
  const store = new CostReservationStore(repo, c, { initialize: true });
  return { repo, store, c };
}
export function beginTrade(
  store: CostReservationStore,
  name = "FIRST",
  quantity = 1,
  ack: "CONFIRMED" | "UNKNOWN" = "CONFIRMED",
  customize?: (p: CostProfile) => void,
) {
  const p = proposal(store, name);
  p.request.quote.askSize = Math.ceil(
    (quantity * 10000) /
      policy.execution.maximum_best_ask_size_participation_bps,
  );
  customize?.(p.profile);
  p.request.profileHash = hash(p.profile);
  store.reserve(`reserve-${name}`, store.prepare(p));
  const s = store.handoff(
    `handoff-${name}`,
    store.prepareHandoff(p.reservationId, ack),
  ).current;
  return s.handoff!.transfers.find((t) => t.reservationId === p.reservationId)!
    .runId;
}
export function source(s: ReservationState, runId: string) {
  return s.book.sources.find((v) => v.config.runId === runId)!;
}
export function journal(s: ReservationState, runId: string) {
  const v = source(s, runId);
  return replayCostJournal(v.config, v.events);
}
type WithoutTime<T> = T extends CostJournalEvent
  ? Omit<T, "seq" | "at">
  : never;
type EventBody = WithoutTime<CostJournalEvent>;
export function event(
  s: ReservationState,
  runId: string,
  body: EventBody,
  at = s.seed.clock + 1,
): CostJournalEvent {
  return { ...body, seq: source(s, runId).events.length + 1, at };
}
export function execute(
  store: CostReservationStore,
  runId: string,
  body: EventBody,
  at?: number,
) {
  const s = store.read();
  return store.execute(body.id, runId, event(s, runId, body, at), s).current;
}
export function fillEvent(
  s: ReservationState,
  runId: string,
  orderId = "entry",
  quantity = 1,
  price?: string,
  at = s.seed.clock + 1,
): Extract<CostJournalEvent, { kind: "FILL" }> {
  const v = source(s, runId),
    order = journal(s, runId).orders.find((o) => o.id === orderId)!;
  return {
    kind: "FILL",
    id: `${v.config.execution.instrument}-fill-${v.events.length}`,
    seq: v.events.length + 1,
    at,
    occurredAt: at,
    fillId: `${v.config.execution.instrument}-fill-${v.events.length}`,
    orderId,
    quantity,
    price: price ?? order.limit,
  };
}
export function fillTrade(
  store: CostReservationStore,
  runId: string,
  orderId = "entry",
  quantity = 1,
  price?: string,
  at?: number,
) {
  const s = store.read(),
    e = fillEvent(s, runId, orderId, quantity, price, at);
  return store.execute(e.id, runId, e, s).current;
}
export function sellOrder(
  store: CostReservationStore,
  runId: string,
  price: string,
  id = "exit",
  replaces: string | null = null,
) {
  const s = store.read();
  return execute(store, runId, {
    kind: "ORDER",
    id: `${source(s, runId).config.execution.instrument}-${id}`,
    orderId: id,
    side: "SELL",
    quantity: journal(s, runId).quantity,
    limit: price,
    replaces,
  });
}
export function closeTrade(
  store: CostReservationStore,
  runId: string,
  price: string,
) {
  const s = sellOrder(store, runId, price);
  return fillTrade(store, runId, "exit", journal(s, runId).quantity, price);
}
export function cancelOrder(
  store: CostReservationStore,
  runId: string,
  orderId = "entry",
) {
  const status = journal(store.read(), runId).orders.find(
    (o) => o.id === orderId,
  )!.status;
  const s = execute(store, runId, {
    kind:
      status === "UNKNOWN" || status === "CANCEL_UNKNOWN"
        ? "CANCEL_UNKNOWN"
        : "CANCEL_REQUEST",
    id: `${runId}-${orderId}-cancel`,
    orderId,
  });
  const o = journal(s, runId).orders.find((o) => o.id === orderId)!;
  return execute(store, runId, {
    kind: "CANCEL_CONFIRMED",
    id: `${runId}-${orderId}-confirmed`,
    orderId,
    cumulativeQuantity: o.filled,
    cumulativeValue: o.value,
    evidenceAt: s.seed.clock + 1,
  });
}
