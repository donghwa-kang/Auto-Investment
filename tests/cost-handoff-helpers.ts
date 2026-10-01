import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { handoffKind } from "../src/core/cost-reservation.js";
import type { ReservationState } from "../src/core/cost-reservation.js";
import type { HandoffConfig } from "../src/core/cost-handoff.js";
import type { CostJournalEvent } from "../src/core/cost-journal.js";
import { reservationConfig, proposal } from "./cost-reservation-helpers.js";
export function handoffConfig(market: "KR" | "US" = "KR"): HandoffConfig {
  const c = reservationConfig(market);
  return {
    ...c,
    kind: handoffKind,
    sourceScope: {
      provider: "SYNTHETIC",
      account: "synthetic-account",
      namespace: "synthetic-session",
    },
    horizonEnd: c.seed.clock + 60000,
  };
}
export function openedHandoff(c = handoffConfig(), path = ":memory:") {
  const repo = new Repository(path, () => 1000);
  repo.acquire();
  const store = new CostReservationStore(repo, c, { initialize: true });
  return { repo, store, c };
}
export function transferred(
  store: CostReservationStore,
  ack: "CONFIRMED" | "UNKNOWN" = "CONFIRMED",
  adverse = 0,
) {
  const p = proposal(store);
  p.request.adverseExitTicks = adverse;
  store.reserve("reserve", store.prepare(p));
  return store.handoff("handoff", store.prepareHandoff(p.reservationId, ack))
    .current;
}
export function managed(s: ReservationState) {
  return s.book.sources.find(
    (v) => v.config.runId === s.handoff!.transfers[0]!.runId,
  )!;
}
export function fill(
  s: ReservationState,
  id = "fill-1",
  quantity = 1,
  orderId = "entry",
  price?: string,
): Extract<CostJournalEvent, { kind: "FILL" }> {
  const v = managed(s),
    at = s.seed.clock + 1;
  return {
    kind: "FILL",
    id: `delivery-${id}`,
    seq: v.events.length + 1,
    at,
    occurredAt: at,
    fillId: id,
    orderId,
    quantity,
    price: price ?? s.approvals[0]!.candidate.entry,
  };
}
export function execute(
  store: CostReservationStore,
  s: ReservationState,
  event: CostJournalEvent,
  id = event.id,
) {
  return store.execute(id, managed(s).config.runId, event, s).current;
}
export function settle(
  s: ReservationState,
  fillIds: string[],
): CostJournalEvent {
  return {
    kind: "SETTLE",
    id: `settle-${managed(s).events.length}`,
    seq: managed(s).events.length + 1,
    at: s.seed.clock + 1,
    fillIds,
  };
}
export function dumpHandoff(repo: Repository) {
  return [
    "cost_reservation_run",
    "cost_reservation_commands",
    "cost_reservation_approvals",
    "cost_reservation_fills",
    "audit",
  ].map((table) => repo.db.prepare(`SELECT * FROM ${table}`).all());
}
