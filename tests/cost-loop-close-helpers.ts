import { makeCostWebProgram } from "../src/server/cost-web-fixture.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import type { ReservationWriteStage } from "../src/server/cost-reservation-store.js";
import { CostLoopRuntime } from "../src/server/cost-loop-runtime.js";
import { Repository } from "../src/server/repository.js";
import { replayCostJournal } from "../src/core/cost-journal.js";
import type { CostLoopTick } from "../src/core/cost-loop-schema.js";
import { closeRequest } from "./cost-finalization-helpers.js";
import { op, record } from "./cost-operating-helpers.js";

let program: ReturnType<typeof makeCostWebProgram> | undefined;
export function loopCloseProgram() {
  return (program ??= makeCostWebProgram());
}
export function loopCloseFixture(
  options: {
    path?: string;
    leaseNow?: () => number;
    initialize?: boolean;
    handoff?: "CONFIRMED" | "UNKNOWN" | "NONE";
    testStage?: (stage: ReservationWriteStage) => void;
  } = {},
) {
  const adapter = loopCloseProgram().operatingLoop({ finalization: true }),
    c = adapter.config(),
    at = c.seed.clock,
    repo = new Repository(
      options.path ?? ":memory:",
      options.leaseNow ?? (() => 1000),
    );
  repo.acquire();
  const store = new CostReservationStore(repo, c, {
    initialize: options.initialize ?? true,
    ...(options.testStage ? { testStage: options.testStage } : {}),
  });
  if ((options.initialize ?? true) && options.handoff !== "NONE") {
    store.reserve("reserve", adapter.prepareEntry(store));
    store.handoff(
      "handoff",
      store.prepareHandoff(
        adapter.reservationId,
        options.handoff ?? "CONFIRMED",
      ),
    );
  }
  const quote = (
    ms: number,
    price = "21400",
    extra: Partial<CostLoopTick["quote"]> = {},
  ): CostLoopTick => ({
    kind: "COST_LOOP_TICK",
    purpose: "TEST_ONLY",
    instrument: "REPLAY-KR-B",
    at: at + ms,
    quote: {
      at: at + ms,
      bid: price,
      ask: price,
      bidSize: 1000,
      askSize: 1000,
      halted: false,
      ...extra,
    },
  });
  const f = { repo, store, c };
  return {
    ...f,
    adapter,
    at,
    quote,
    tick: (ms: number, price?: string) =>
      store.tick(`tick-${ms}`, quote(ms, price)),
    pulse: (ms: number) => ({
      kind: "COST_LOOP_PULSE" as const,
      purpose: "TEST_ONLY" as const,
      instrument: "REPLAY-KR-B",
      at: at + ms,
    }),
    view: () => {
      const source = store.read().book.sources[0]!;
      return replayCostJournal(source.config, source.events);
    },
    expense: (amount = "50") =>
      record(store, op(store.read(), "RECOGNIZE", "expense", amount)),
    request: () => closeRequest(f),
    close: () =>
      store.finalizeOperating("close", "period", closeRequest(f), store.read()),
  };
}
export type LoopCloseFixture = ReturnType<typeof loopCloseFixture>;
export function finishLoop(f: LoopCloseFixture, price = "22000") {
  f.tick(1000);
  f.expense();
  for (const ms of [2000, 3000, 4000]) f.tick(ms);
  for (const ms of [5000, 6000, 7000, 8000, 9000, 10000, 11000])
    f.tick(ms, price);
}
export function manualRuntime(f: LoopCloseFixture, initialMs: number) {
  let wall = f.at + initialMs;
  const callbacks: (() => void)[] = [];
  let cancels = 0;
  const runtime = new CostLoopRuntime(f.store, {
    clock: { wallNow: () => wall, monotonicNow: () => wall - f.at },
    timer: {
      schedule: (_delay, callback) => {
        callbacks.push(callback);
        return () => {
          cancels++;
        };
      },
    },
  });
  return {
    runtime,
    callbacks,
    advance: (ms: number) => {
      wall = f.at + ms;
    },
    cancels: () => cancels,
  };
}
