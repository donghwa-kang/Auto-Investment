import type {
  CostJournalConfig,
  CostJournalEvent,
} from "../src/core/cost-journal.js";
import { costJournalKind } from "../src/core/cost-journal.js";
import { executionConfig, executionEvents } from "./cost-execution-helpers.js";
import { costAt } from "./transaction-cost-helpers.js";
export function journalConfig(
  unit: "ORDER" | "FILL" = "ORDER",
  market: "KR" | "US" = "KR",
): CostJournalConfig {
  return {
    kind: costJournalKind,
    runId: "synthetic-run",
    sourceScope: {
      provider: "SYNTHETIC",
      account: "synthetic-account",
      namespace: "synthetic-session",
    },
    settlement: "SYNTHETIC_EXPLICIT_NEXT_EVENT",
    operatingCosts: "EXPLICIT_ZERO_FIXTURE",
    horizonEnd: costAt + 10000,
    execution: executionConfig(unit, market),
  };
}
export function journalEvents(): CostJournalEvent[] {
  const original = executionEvents();
  return [
    ...original.slice(0, 6),
    {
      kind: "SETTLE" as const,
      id: "settle-buy",
      seq: 7,
      at: costAt + 7,
      fillIds: ["buy-fill1", "buy-fill2"],
    },
    ...original.slice(6),
    {
      kind: "SETTLE" as const,
      id: "settle-sell",
      seq: 14,
      at: costAt + 14,
      fillIds: ["sell-fill1", "sell-fill2"],
    },
  ].map((e, i) => ({
    ...e,
    seq: i + 1,
    at: costAt + i + 1,
    ...(e.kind === "FILL" ? { occurredAt: costAt + i + 1 } : {}),
    ...(e.kind === "CANCEL_CONFIRMED" ? { evidenceAt: costAt + i + 1 } : {}),
  }));
}
