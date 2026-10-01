import { CostSignalProgram } from "../src/server/cost-signal-bridge.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import type { ReservationWriteStage } from "../src/server/cost-reservation-store.js";
import { Repository } from "../src/server/repository.js";
import { makeSignalReplayFixture } from "../src/core/signal-replay-fixture.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { completedRiskWindow, minute } from "../src/core/calendar.js";
import { hash } from "../src/core/policy.js";
import type { OperatingHistory } from "../src/core/operating-cost.js";
import type { CostLoopTick } from "../src/core/cost-loop-schema.js";
import { costProfile } from "./transaction-cost-helpers.js";
import { closeRequest } from "./cost-finalization-helpers.js";
import { op, record } from "./cost-operating-helpers.js";

let program: CostSignalProgram | undefined;
export function historyProgram() {
  if (program) return program;
  // New, coherent business-session dates; original August fixtures untouched.
  const input = makeSignalReplayFixture("KR", "2026-09-01");
  for (const h of input.histories)
    for (const s of h.sessions.slice(0, -1)) {
      s.closeAt = s.openAt + 60 * minute;
      s.rows = s.rows.filter((r) => r.offset < 60);
    }
  const settings = portfolioFixture(input).settings;
  const at = Date.parse(input.frames[0]!.asOf),
    profile = costProfile();
  profile.availableAt = profile.effectiveFrom = at - 100000;
  profile.effectiveTo = at + 7200000;
  program = new CostSignalProgram(
    input,
    settings,
    {
      kind: "SYNTHETIC_COST_SIGNAL_SELECTION_V1",
      purpose: "TEST_ONLY",
      frameAsOf: at,
      catalogKey: "KR:REPLAY-KR-B",
      profile,
      forecast: {
        model: "SYNTHETIC_POINT_SCENARIO",
        expectedExit: "22000",
        q05Exit: "21400",
        availableAt: at,
        validUntil: at + 30000,
      },
      adverseExitTicks: 0,
    },
    { executionLoop: true, watchdog: true },
  );
  return program;
}
export function admissionFixture(
  options: {
    path?: string;
    initialize?: boolean;
    leaseNow?: () => number;
    testStage?: (stage: ReservationWriteStage) => void;
    legacy?: boolean;
  } = {},
) {
  const adapter = historyProgram().operatingLoop({
    finalization: true,
    ...(options.legacy ? {} : { historyAdmission: true }),
  });
  const c = adapter.config(),
    at = c.seed.clock;
  const repo = new Repository(
    options.path ?? ":memory:",
    options.leaseNow ?? (() => 1000),
  );
  repo.acquire();
  const store = new CostReservationStore(repo, c, {
    initialize: options.initialize ?? true,
    ...(options.testStage ? { testStage: options.testStage } : {}),
  });
  const window = completedRiskWindow(at);
  const history = (amount = "10"): OperatingHistory => ({
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    liveEnabled: false,
    configHash: hash(c.seed.config),
    riskEpoch: repo.epoch,
    coverage: {
      startInclusive: window.startInclusive,
      endExclusive: window.endExclusive,
      complete: true,
      availableAt: window.endExclusive,
    },
    costs: [
      {
        id: "prior-cost",
        kind: "OPERATING",
        currency: "KRW",
        amount,
        occurredAt: window.startInclusive,
        availableAt: window.startInclusive,
      },
    ],
    closedIntents: [0, 1, 2].map((i) => ({
      entryIntentId: `prior-${i}`,
      closedAt: window.startInclusive + i,
      availableAt: window.startInclusive + i,
      buyQuantity: 4,
      sellQuantity: 4,
      allOrdersTerminal: true,
    })),
    dailyBudgetKrw: null,
    futureIncreaseKrw: "0",
  });
  const quote = (ms: number, price = "21400"): CostLoopTick => ({
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
    },
  });
  const f = { c, repo, store };
  return {
    ...f,
    adapter,
    at,
    history,
    quote,
    tick: (ms: number, price?: string) =>
      store.tick(`tick-${ms}`, quote(ms, price)),
    reserve: (h: unknown = history()) =>
      store.reserve("reserve", adapter.prepareEntry(store, h)),
    handoff: (
      h: unknown = history(),
      ack: "CONFIRMED" | "UNKNOWN" = "CONFIRMED",
    ) =>
      store.handoff(
        "handoff",
        store.prepareHandoff(adapter.reservationId, ack, h),
      ),
    expense: (amount = "50") =>
      record(store, op(store.read(), "RECOGNIZE", "expense", amount)),
    close: () =>
      store.finalizeOperating("close", "period", closeRequest(f), store.read()),
  };
}
