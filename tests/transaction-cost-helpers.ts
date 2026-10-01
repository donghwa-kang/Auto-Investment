import { hash, policyHash } from "../src/core/policy.js";
import { transactionCostContract } from "../src/core/transaction-cost.js";
import type { CostPlan, CostProfile } from "../src/core/transaction-cost.js";
import type { CostSizingRequest } from "../src/core/cost-aware-sizing.js";
import type { State } from "../src/core/types.js";
export const costAt = Date.parse("2026-08-31T00:45:00Z");
export function costProfile(market: "KR" | "US" = "KR"): CostProfile {
  return {
    contract: transactionCostContract,
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    liveEnabled: false,
    id: "synthetic-cost",
    version: 1,
    scope: {
      market,
      currency: market === "KR" ? "KRW" : "USD",
      product: "ETF",
    },
    availableAt: costAt - 100_000,
    effectiveFrom: costAt - 100_000,
    effectiveTo: costAt + 100_000,
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
        minimum:
          component === "COMMISSION" ? (market === "KR" ? "10" : "0.01") : "0",
        quantum: market === "KR" ? "1" : "0.01",
        rounding: "UP",
      })),
    ),
  };
}
export function costPlan(
  p: CostProfile,
  groups?: CostPlan["groups"],
): CostPlan {
  return {
    purpose: "TEST_ONLY",
    profileHash: hash(p),
    scope: p.scope,
    asOf: costAt,
    complete: true,
    groups: groups ?? [
      {
        id: "order-1",
        side: "BUY",
        unit: "ORDER",
        quantity: 10,
        notional: "100000",
        at: costAt,
      },
    ],
  };
}
export function costRequest(s: State, p: CostProfile): CostSizingRequest {
  const us = p.scope.market === "US";
  return {
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    stateHash: hash(s),
    profileHash: hash(p),
    policyHash,
    product: p.scope.product,
    strategy: "B",
    symbol: us ? "SYNTHETIC-US" : "SYNTHETIC-KR",
    signalAt: s.clock,
    quote: {
      at: s.clock,
      bid: us ? "39.99" : "9995",
      ask: us ? "40" : "10000",
      bidSize: 100000,
      askSize: 100000,
      lastMinuteVolume: 1000000,
      halted: false,
    },
    tickSize: us ? "0.01" : "5",
    stop: us ? "39.8" : "9950",
    atr: us ? "0.2" : "50",
    signalClose: us ? "40" : "10000",
    forecast: {
      model: "SYNTHETIC_POINT_SCENARIO",
      expectedExit: us ? "40.3" : "10100",
      q05Exit: us ? "39.8" : "9950",
      availableAt: s.clock,
      validUntil: s.clock + 30000,
    },
    executionModel: "ONE_ORDER_PER_SIDE_ONE_SHARE_FILLS",
    adverseExitTicks: 0,
  };
}
