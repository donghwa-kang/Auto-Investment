import { completedRiskWindow } from "../src/core/calendar.js";
import {
  operatingKind,
  operatingContractHash,
} from "../src/core/cost-operating.js";
import type {
  OperatingConfig,
  OperatingEvent,
} from "../src/core/cost-operating.js";
import type { ReservationState } from "../src/core/cost-reservation.js";
import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { handoffConfig } from "./cost-handoff-helpers.js";
export function operatingConfig(): OperatingConfig {
  const c = handoffConfig(),
    start = completedRiskWindow(c.seed.clock).endExclusive;
  return {
    ...c,
    kind: operatingKind,
    operating: {
      contractHash: operatingContractHash,
      periodStart: start,
      periodEnd: start + 86400000,
      priorMonthIncurredKrw: "0",
      priorMonthReservedKrw: "0",
    },
  };
}
export function openedOperating(c = operatingConfig(), path = ":memory:") {
  const repo = new Repository(path, () => 1000);
  repo.acquire();
  const store = new CostReservationStore(repo, c, { initialize: true });
  return { repo, store, c };
}
export function op(
  s: ReservationState,
  kind: OperatingEvent["kind"],
  eventId: string,
  amountKrw = "50",
  obligationId = "debt",
  reservationId: string | null = null,
): OperatingEvent {
  const base = {
    eventId,
    sequence: s.operating!.events.length + 1,
    occurredAt: s.seed.clock + 1,
    availableAt: s.seed.clock + 1,
  };
  if (kind === "RELEASE")
    return { ...base, kind, reservationId: reservationId! };
  if (kind === "RECOGNIZE")
    return { ...base, kind, amountKrw, obligationId, reservationId };
  return { ...base, kind, amountKrw, obligationId };
}
export function record(
  store: CostReservationStore,
  e: OperatingEvent,
  id = e.eventId,
) {
  return store.operating(id, e, store.read()).current;
}
