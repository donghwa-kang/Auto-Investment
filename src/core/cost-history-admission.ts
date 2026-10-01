import { z } from "zod";
import { hash, policyHash } from "./policy.js";
import { completedRiskWindow } from "./calendar.js";
import { emptyLedger } from "./ledger.js";
import {
  operatingHistorySchema,
  resolveOperatingCost,
} from "./operating-cost.js";
import type { State } from "./types.js";

// Separate opt-in: never reinterpret the old D6 zero-admission contract.
export const historyAdmissionHash = hash({
  contract: "SYNTHETIC_COST_HISTORY_ADMISSION_V1",
  policyHash,
  scope: "KRW_MONTH_FIRST_DAY_FIRST_CANDIDATE_COMPLETED_20_N_POSITIVE",
  currentHistoryRequired: true,
  carrySupported: false,
  newSpendingAllowed: false,
});
export const historyAdmissionSchema = z.strictObject({
  contractHash: z.literal(historyAdmissionHash),
  purpose: z.literal("TEST_ONLY"),
  priorUnresolvedCarry: z.literal("NONE_SYNTHETIC_DECLARATION"),
});
export type HistoryAdmission = z.infer<typeof historyAdmissionSchema>;

// Bounded raw copies are retained in both admission commands. This is a
// serialization budget, not a trading limit or permission to truncate history.
export const maxAdmissionHistoryBytes = 256 * 1024;
export const admissionHistorySchema = operatingHistorySchema.refine(
  (v) =>
    new TextEncoder().encode(JSON.stringify(v)).length <=
    maxAdmissionHistoryBytes,
  "HISTORY_ADMISSION_SIZE_LIMIT",
);

export function validateHistoryAdmissionSeed(s: State) {
  const window = completedRiskWindow(s.clock);
  if (
    s.config?.market !== "KR" ||
    new Date(window.endExclusive).getUTCDate() !== 1 ||
    s.status !== "RUNNING" ||
    s.pendingLevel !== null ||
    s.fault !== null ||
    s.positions.length ||
    s.orders.length ||
    s.decisions.length ||
    hash(s.ledger) !==
      hash(emptyLedger(s.clock, s.ledger.wallets.KRW.cash, "0", s.ledger.fx))
  )
    throw Error("HISTORY_ADMISSION_FRESH_MONTH_FIRST_RUN_REQUIRED");
}

export function assessAdmissionHistory(s: State, raw: unknown) {
  if (raw === undefined)
    throw Error("HISTORY_ADMISSION_CURRENT_INPUT_REQUIRED");
  const history = admissionHistorySchema.parse(raw);
  const window = completedRiskWindow(s.clock);
  const contains = (at: number) =>
    at >= window.startInclusive && at < window.endExclusive;
  if (
    new Date(window.endExclusive).getUTCDate() !== 1 ||
    s.config?.market !== "KR" ||
    !history.closedIntents.length ||
    history.costs.some((e) => !contains(e.occurredAt)) ||
    history.closedIntents.some((e) => !contains(e.closedAt))
  )
    throw Error("HISTORY_ADMISSION_SCOPE");
  const assessment = resolveOperatingCost(s, history);
  if (
    assessment.amount === null ||
    !assessment.binding ||
    assessment.binding.source !== "EXPLICIT_TEST_HISTORY"
  )
    throw Error(`HISTORY_ADMISSION_HOLD:${assessment.reasons.join(",")}`);
  return { history, amount: assessment.amount, binding: assessment.binding };
}
