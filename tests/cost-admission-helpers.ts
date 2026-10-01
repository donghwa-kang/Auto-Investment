import { hash, policyHash } from "../src/core/policy.js";
import type { CostRiskBook } from "../src/core/cost-risk-context.js";
import { buildCostExposure } from "../src/core/cost-risk-context.js";
import { state } from "./helpers.js";
import {
  costAt,
  costProfile,
  costRequest,
} from "./transaction-cost-helpers.js";
import { journalConfig } from "./cost-journal-helpers.js";
import type { State } from "../src/core/types.js";

export function source(
  seed: State,
  symbol = "FIRST",
  market: "KR" | "US" = "KR",
  quantity = 2,
  filled = 1,
): CostRiskBook["sources"][number] {
  const config = journalConfig("ORDER", market),
    price = market === "KR" ? "10000" : "40";
  config.runId = `run-${symbol}`;
  config.execution.instrument = symbol;
  config.execution.profile = costProfile(market);
  config.execution.initialCash =
    seed.ledger.wallets[config.execution.profile.scope.currency].cash;
  return {
    config,
    events: [
      {
        id: "order-e",
        seq: 1,
        at: costAt + 1,
        kind: "ORDER",
        orderId: "buy",
        side: "BUY",
        quantity,
        limit: price,
        replaces: null,
      },
      ...(filled
        ? [
            {
              id: "fill-e",
              seq: 2,
              at: costAt + 2,
              kind: "FILL" as const,
              orderId: "buy",
              fillId: "f1",
              quantity: filled,
              price,
              occurredAt: costAt + 2,
            },
          ]
        : []),
    ],
    observation: {
      at: seed.clock,
      bid: price,
      stop: market === "KR" ? "9950" : "39.8",
      protection: "WATCHING",
      protectedQuantity: filled,
    },
  };
}
export function fixture(market: "KR" | "US" = "KR") {
  const seed = state({
    market,
    usdCapitalKrw: market === "US" ? 390000 : 0,
    stage: "STANDARD",
    level: "HIGH",
  });
  seed.clock = costAt + 20;
  seed.ledger.accountAt = seed.clock;
  seed.ledger.fxAt = seed.clock;
  const book: CostRiskBook = {
    kind: "SYNTHETIC_COST_RISK_BOOK_V1",
    policyHash,
    seedHash: hash(seed),
    initialAt: costAt,
    openingFx: "1300",
    riskEvidence: "EXPLICIT_SYNTHETIC_SNAPSHOT_NOT_CONTINUOUS_HISTORY",
    sources: [],
  };
  return { seed, book, p: costProfile(market) };
}
// Explicit test observations, not product inference from journal deliveries.
export function observe(seed: State, book: CostRiskBook) {
  seed.ledger.intents = book.sources.length;
  seed.ledger.entries = book.sources.filter((v) =>
    v.events.some((e) => e.kind === "FILL"),
  ).length;
  seed.ledger.symbolEntries = Object.fromEntries(
    book.sources
      .filter((v) => v.events.some((e) => e.kind === "FILL"))
      .map((v) => [v.config.execution.instrument, 1]),
  );
  book.seedHash = hash(seed);
}
export function request(f: ReturnType<typeof fixture>) {
  const result = buildCostExposure(f.seed, f.book);
  if (result.status !== "OK") throw Error(result.reasons.join(","));
  const r = costRequest(result.context.state, f.p);
  r.symbol = "NEW";
  return r;
}
