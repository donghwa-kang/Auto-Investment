import { makeSignalReplayFixture } from "../core/signal-replay-fixture.js";
import { portfolioFixture } from "../core/portfolio-fixture.js";
import { completedRiskWindow, minute } from "../core/calendar.js";
import { hash } from "../core/policy.js";
import { transactionCostContract } from "../core/transaction-cost.js";
import type { OperatingHistory } from "../core/operating-cost.js";
import {
  CostSignalProgram,
  costSignalSelectionSchema,
} from "./cost-signal-bridge.js";

export const costAppRecipe = "COST_WEB_OPERATING_KRW_V1" as const;
// A separately named, compact synthetic source, NOT the old V3 full-session
// fixture. 120 past sessions plus today; past sessions have 60 one-minute rows.
// Current-day bars and the 315-bar RVOL comparison remain unchanged.
export function makeCostAppSources() {
  const replay = makeSignalReplayFixture("KR", "2026-09-01");
  for (const h of replay.histories)
    for (const s of h.sessions.slice(0, -1)) {
      s.closeAt = s.openAt + 60 * minute;
      s.rows = s.rows.filter((r) => r.offset < 60);
    }
  const settings = portfolioFixture(replay).settings;
  const at = Date.parse(replay.frames[0]!.asOf);
  const selection = costSignalSelectionSchema.parse({
    kind: "SYNTHETIC_COST_SIGNAL_SELECTION_V1",
    purpose: "TEST_ONLY",
    frameAsOf: at,
    catalogKey: "KR:REPLAY-KR-B",
    profile: {
      contract: transactionCostContract,
      purpose: "TEST_ONLY",
      provenance: "SYNTHETIC_FIXTURE",
      liveEnabled: false,
      id: "cost-app-compact-synthetic",
      version: 1,
      scope: { market: "KR", currency: "KRW", product: "ETF" },
      availableAt: at - 100000,
      effectiveFrom: at - 100000,
      effectiveTo: at + 7200000,
      rules: (["BUY", "SELL"] as const).flatMap((side) =>
        (["COMMISSION", "TAX", "EXCHANGE"] as const).map((component) => ({
          id: `${side}-${component}`,
          side,
          component,
          unit: "ORDER",
          basis: "NOTIONAL",
          tierMode: "MARGINAL",
          tiers: [{ upTo: null, rate: component === "COMMISSION" ? "1" : "0" }],
          fixed: "0",
          minimum: component === "COMMISSION" ? "10" : "0",
          quantum: "1",
          rounding: "UP",
        })),
      ),
    },
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
export type CostAppSources = ReturnType<typeof makeCostAppSources>;
export function costAppProgram(s: CostAppSources) {
  return new CostSignalProgram(s.replay, s.settings, s.selection, {
    executionLoop: true,
    watchdog: true,
  });
}
export function makeCostAppFixture() {
  const sources = makeCostAppSources();
  const program = costAppProgram(sources);
  const config = program
    .operatingLoop({ finalization: true, historyAdmission: true })
    .config();
  const window = completedRiskWindow(config.seed.clock);
  const history: OperatingHistory = {
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    liveEnabled: false,
    configHash: hash(config.seed.config),
    riskEpoch: 1,
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
  const schedule: Array<{
    id: string;
    kind: "QUOTE" | "RECOGNIZE" | "PAY";
    offset: number;
    price?: string;
  }> = [];
  for (let i = 1; i <= 11; i++) {
    schedule.push({
      id: `app-quote-${i}`,
      kind: "QUOTE",
      offset: i * 1000,
      price: i <= 4 ? "21400" : "22000",
    });
    if (i === 1)
      schedule.push({ id: "app-expense", kind: "RECOGNIZE", offset: 1500 });
  }
  schedule.push({ id: "app-pay", kind: "PAY", offset: 11500 });
  return {
    recipe: costAppRecipe,
    sourceVersion: "COMPACT_120_SESSION_60_MINUTE_HISTORY_V1" as const,
    sources,
    config,
    history,
    schedule,
    // This declaration belongs to this exact authored synthetic schedule. It
    // is not inferred from a DB row count or applicable to external data.
    completeness: {
      purpose: "TEST_ONLY" as const,
      coverage: "FULL_PERIOD_FROM_EMPTY" as const,
      periodStart: config.operating.periodStart,
      periodEnd: config.operating.periodEnd,
      scheduleHash: hash(schedule),
      noOtherFinancialEvents: true as const,
    },
  };
}
export type CostAppFixture = ReturnType<typeof makeCostAppFixture>;
