import { fixture } from "./cost-admission-helpers.js";
import { hash } from "../src/core/policy.js";
import { costProfile, costRequest } from "./transaction-cost-helpers.js";
import { reservationKind } from "../src/core/cost-reservation.js";
import type {
  ReservationConfig,
  ReservationState,
  ReservationCommand,
} from "../src/core/cost-reservation.js";
import type { CostReservationStore } from "../src/server/cost-reservation-store.js";
export function reservationConfig(
  market: "KR" | "US" = "KR",
): ReservationConfig {
  const f = fixture(market);
  return {
    kind: reservationKind,
    runId: "local-reservation-run",
    seed: f.seed,
    book: f.book,
  };
}
export function proposal(store: CostReservationStore, name = "FIRST") {
  const c = store.context();
  if (c.status !== "OK") throw Error(c.reasons.join(","));
  const profile = costProfile(c.context.state.config!.market),
    request = costRequest(c.context.state, profile);
  request.symbol = name;
  return { reservationId: `r-${name}`, profile, request };
}
export function observation(
  s: ReservationState,
  delta = 1,
): Extract<ReservationCommand, { kind: "OBSERVE" }> {
  const at = s.seed.clock + delta;
  return {
    kind: "OBSERVE",
    at,
    fx: s.seed.ledger.fx,
    fxAt: at,
    accountAt: at,
    observations: s.book.sources.map((v) => ({
      runId: v.config.runId,
      observation: { ...v.observation, at },
    })),
  };
}
export function usdCash(c: ReservationConfig, dollars: string) {
  c.seed.ledger.wallets.USD.cash = dollars;
  c.seed.ledger.wallets.KRW.cash = String(
    c.seed.config!.capital - Number(dollars) * 1300,
  );
  c.book.seedHash = hash(c.seed);
  return c;
}
