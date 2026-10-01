import { makeSignalReplayFixture } from "../core/signal-replay-fixture.js";
import { portfolioFixture } from "../core/portfolio-fixture.js";
import {
  transactionCostContract,
  type CostProfile,
} from "../core/transaction-cost.js";
import { CostSignalProgram } from "./cost-signal-bridge.js";

// Explicit new sample, not an actual broker tariff or a modification of a
// stored profile. Full 120-session synthetic histories use the existing builder.
export function makeCostWebProgram() {
  const input = makeSignalReplayFixture("KR"),
    settings = portfolioFixture(input).settings,
    at = Date.parse(input.frames[0]!.asOf);
  const profile: CostProfile = {
    contract: transactionCostContract,
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    liveEnabled: false,
    id: "cost-web-synthetic",
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
  };
  return new CostSignalProgram(
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
}
