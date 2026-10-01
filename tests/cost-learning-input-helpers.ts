import { makeSignalReplayFixture } from "../src/core/signal-replay-fixture.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { minute, completedRiskWindow } from "../src/core/calendar.js";
import { hash } from "../src/core/policy.js";
import {
  CostSignalProgram,
  costSignalSelectionSchema,
} from "../src/server/cost-signal-bridge.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { Repository } from "../src/server/repository.js";
import {
  createCostLearningInput,
  costLearningInputKind,
} from "../src/server/cost-learning-input.js";
import type { OperatingHistory } from "../src/core/operating-cost.js";
import { costProfile } from "./transaction-cost-helpers.js";
import { op, record } from "./cost-operating-helpers.js";
import { closeRequest } from "./cost-finalization-helpers.js";
import {
  fillTrade,
  sellOrder,
  journal,
  cancelOrder,
} from "./cost-outcome-helpers.js";

const seed = makeSignalReplayFixture("KR", "2026-09-01");
for (const h of seed.histories)
  for (const s of h.sessions.slice(0, -1)) {
    s.closeAt = s.openAt + 60 * minute;
    s.rows = s.rows.filter((r) => r.offset < 60);
  }
export function learningSources(strategy: "B" | "P" = "B") {
  const replay = structuredClone(seed),
    settings = portfolioFixture(replay).settings,
    at = Date.parse(replay.frames[strategy === "B" ? 0 : 1]!.asOf),
    profile = costProfile();
  profile.availableAt = profile.effectiveFrom = at - 100000;
  profile.effectiveTo = at + 7200000;
  const selection = costSignalSelectionSchema.parse({
    kind: "SYNTHETIC_COST_SIGNAL_SELECTION_V1",
    purpose: "TEST_ONLY",
    frameAsOf: at,
    catalogKey: `KR:REPLAY-KR-${strategy}`,
    profile,
    forecast: {
      model: "SYNTHETIC_POINT_SCENARIO",
      expectedExit: "22000",
      q05Exit: "21400",
      availableAt: at,
      validUntil: at + 30000,
    },
    adverseExitTicks: 0,
  });
  return { replay, settings, selection };
}
export function openLearning(sources = learningSources()) {
  const program = new CostSignalProgram(
      sources.replay,
      sources.settings,
      sources.selection,
      { executionLoop: true, watchdog: true },
    ),
    adapter = program.operatingLoop({
      finalization: true,
      historyAdmission: true,
    }),
    c = adapter.config(),
    at = c.seed.clock,
    repo = new Repository(":memory:", () => 1000);
  repo.acquire();
  const store = new CostReservationStore(repo, c, { initialize: true }),
    window = completedRiskWindow(at),
    history: OperatingHistory = {
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
          amount: "10",
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
    };
  const reserve = () =>
      store.reserve("reserve", adapter.prepareEntry(store, history)),
    handoff = (ack: "CONFIRMED" | "UNKNOWN" = "CONFIRMED") =>
      store.handoff(
        "handoff",
        store.prepareHandoff(adapter.reservationId, ack, history),
      ),
    tick = (
      ms: number,
      price = program.proposalForEvidence("0".repeat(64)).request.quote.ask,
    ) =>
      store.tick(`tick-${ms}`, {
        kind: "COST_LOOP_TICK",
        purpose: "TEST_ONLY",
        instrument: program.signalEvidence().identity.instrumentId,
        at: at + ms,
        quote: {
          at: at + ms,
          bid: price,
          ask: price,
          bidSize: 1000,
          askSize: 1000,
          halted: false,
        },
      }),
    expense = (amount = "50") =>
      record(store, op(store.read(), "RECOGNIZE", "expense", amount)),
    close = () =>
      store.finalizeOperating(
        "close",
        "period",
        closeRequest({ c, repo, store }),
        store.read(),
      ),
    capture = (asOf?: number) => {
      const financial = store.exportOperatingEvidence(),
        envelope = {
          kind: costLearningInputKind,
          purpose: "TEST_ONLY",
          asOf: asOf ?? financial.asOf,
          ...structuredClone(sources),
          operatingEvidenceText: JSON.stringify(financial),
        },
        encoded = createCostLearningInput(envelope);
      return {
        envelope,
        financial,
        text: encoded.text,
        anchor: {
          inputHash: encoded.inputHash,
          operating: { config: c, exportHash: financial.exportHash },
        },
      };
    };
  return {
    ...sources,
    program,
    adapter,
    c,
    at,
    repo,
    store,
    history,
    reserve,
    handoff,
    tick,
    expense,
    close,
    capture,
  };
}
export type LearningCapture = ReturnType<
  ReturnType<typeof openLearning>["capture"]
>;
const captures = new Map<string, LearningCapture>();
export function capturedLearning(
  mode = "closed",
  strategy: "B" | "P" = "B",
): LearningCapture {
  const key = `${mode}-${strategy}`;
  if (captures.has(key)) return structuredClone(captures.get(key)!);
  const sources = learningSources(strategy);
  if (mode === "components")
    for (const r of sources.selection.profile.rules) {
      if (r.component === "COMMISSION") r.tiers[0]!.rate = "10";
      if (r.component === "TAX") r.fixed = "2";
      if (r.component === "EXCHANGE") r.fixed = "3";
    }
  if (mode === "new-version") sources.selection.profile.version++;
  if (mode === "future") {
    const h = sources.replay.histories.find((h) =>
        h.assetKey.includes(`REPLAY-KR-${strategy}`),
      )!,
      s = h.sessions.at(-1)!,
      r = s.rows.find((r) => r.offset === 44)!;
    s.rows.push({
      ...r,
      revision: r.revision + 1,
      c: r.h,
      availableAt: sources.selection.frameAsOf + 100 * minute,
      receivedAt: sources.selection.frameAsOf + 100 * minute,
    });
  }
  if (mode === "prefix")
    sources.replay.frames = sources.replay.frames.filter(
      (f) => Date.parse(f.asOf) <= sources.selection.frameAsOf,
    );
  const f = openLearning(sources);
  try {
    if (mode !== "empty") f.reserve();
    if (mode === "released")
      f.store.release("release", f.adapter.reservationId, f.store.read());
    if (!["empty", "reserved", "released"].includes(mode))
      f.handoff(mode === "unknown" ? "UNKNOWN" : "CONFIRMED");
    if (
      !["empty", "reserved", "released", "unknown", "no-fills"].includes(mode)
    ) {
      const run = f.store.read().handoff!.transfers[0]!.runId;
      if (["unsettled", "replacement", "risk-halt"].includes(mode)) {
        const q = f.store.read().approvals[0]!.candidate.quantity;
        for (let i = 0; i < q; i++) fillTrade(f.store, run);
        const exitPrice = mode === "risk-halt" ? "20000" : "22000";
        sellOrder(f.store, run, exitPrice);
        if (mode === "replacement") {
          fillTrade(f.store, run, "exit");
          cancelOrder(f.store, run, "exit");
          sellOrder(f.store, run, exitPrice, "exit2", "exit");
          for (let i = 1; i < q; i++) fillTrade(f.store, run, "exit2");
        } else for (let i = 0; i < q; i++) fillTrade(f.store, run, "exit");
        f.expense();
      } else {
        f.tick(1000);
        if (mode !== "partial-buy") {
          f.expense();
          let ms = 2000;
          while (journal(f.store.read(), run).orders[0]!.status !== "FILLED") {
            if (ms > 30000) throw Error("FIXTURE_ENTRY_NOT_FILLED");
            f.tick(ms);
            ms += 1000;
          }
          if (mode !== "bought") {
            const price =
              mode === "loss"
                ? f.store.read().approvals[0]!.candidate.stop
                : "22000";
            f.tick(ms, price);
            ms += 1000;
            if (mode === "partial-sell") {
              while (
                !journal(f.store.read(), run).orders.some(
                  (o) => o.side === "SELL" && o.filled > 0,
                )
              ) {
                if (ms > 30000) throw Error("FIXTURE_PARTIAL_EXIT_NOT_FILLED");
                f.tick(ms, price);
                ms += 1000;
              }
            }
            if (mode !== "partial-sell") {
              while (!f.store.read().outcomes!.length) {
                if (ms > 30000) throw Error("FIXTURE_EXIT_NOT_CLOSED");
                f.tick(ms, price);
                ms += 1000;
              }
              if (mode !== "unpaid")
                record(f.store, op(f.store.read(), "PAY", "pay", "50"));
            }
          }
        }
      }
      if (
        !["partial-buy", "partial-sell", "bought", "open-close"].includes(mode)
      )
        f.close();
      if (mode === "open-close") {
        const preview = f.store.operatingClose(closeRequest(f));
        if (preview.status !== "VERIFIED_FIXTURE_PROJECTION")
          throw Error("FIXTURE_D7_PREVIEW_NOT_VERIFIED");
      }
      if (mode === "reconciling")
        f.store.postCloseInput(
          "late",
          '{"unknown":true}',
          f.c.operating.periodEnd + 1,
          f.store.read(),
        );
    }
    const result = f.capture();
    captures.set(key, result);
    return structuredClone(result);
  } finally {
    f.repo.close();
  }
}
export function reEnvelope(
  capture: LearningCapture,
  envelope = capture.envelope,
) {
  const encoded = createCostLearningInput(envelope);
  return {
    text: encoded.text,
    anchor: { ...capture.anchor, inputHash: encoded.inputHash },
  };
}
