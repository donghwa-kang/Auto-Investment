import { z } from "zod";
import { hash, policyHash } from "./policy.js";
import { latch } from "./ledger.js";
import { costJournalConfigSchema } from "./cost-journal.js";
import { operatingKind, operatingRawSchema } from "./cost-operating.js";
import type { OperatingConfig } from "./cost-operating.js";
import { capturePostCloseBasis } from "./cost-post-close.js";
import { capturePartialSettlementBasis } from "./cost-partial-settlement.js";
import type { ReservationState } from "./cost-reservation.js";
import {
  operatingCloseContractHash,
  operatingCloseRequestSchema,
  projectOperatingClose,
} from "./cost-operating-close.js";

export const finalizationContractHash = hash({
  contract: "D8_ATOMIC_OPERATING_FINALIZATION_V1",
  policyHash,
  calculationContract: operatingCloseContractHash,
  scope: "NEW_SYNTHETIC_KRW_SINGLE_PERIOD",
  postClose: "RAW_QUARANTINE_NO_FINANCIAL_MUTATIONS",
  automaticResumeAllowed: false,
});
export const finalizationOptionsSchema = z.strictObject({
  contractHash: z.literal(finalizationContractHash),
});
export type FinalizationOptions = z.infer<typeof finalizationOptionsSchema>;
const id = costJournalConfigSchema.shape.runId;
const time = z.number().int().safe().nonnegative();
export const finalizationCommandSchema = z.union([
  z.strictObject({
    kind: z.literal("FINALIZE_OPERATING"),
    closeId: id,
    request: operatingCloseRequestSchema,
  }),
  z.strictObject({
    kind: z.literal("POST_CLOSE_INPUT"),
    rawJson: operatingRawSchema,
    observedAt: time,
  }),
]);
export type FinalizationCommand = z.infer<typeof finalizationCommandSchema>;
export type FinalizeCommand = Extract<
  FinalizationCommand,
  { kind: "FINALIZE_OPERATING" }
>;
type CloseReport = ReturnType<typeof projectOperatingClose>;
export interface FinalizationMetadata {
  contractHash: string;
  status: "OPEN" | "FINALIZED" | "RECONCILING";
  checkpoint: null | {
    closeId: string;
    request: FinalizeCommand["request"];
    report: CloseReport;
    appliedAt: number;
    appliedRevision: number;
    epoch: number;
    initialLossStreak: number;
    appliedLossStreak: number;
    counterApplied: true;
  };
  rejectedInputs: { rawJson: string; observedAt: number }[];
}
export const postCloseInputLimit = 100;
// Slot for finalization is separate from the unchanged 5200+100 D6 limits.
export const finalizationExtraSlots = 1 + postCloseInputLimit;
export function initializeFinalization(
  s: ReservationState,
  c: OperatingConfig,
) {
  if (!("finalization" in c)) return;
  finalizationOptionsSchema.parse(c.finalization);
  if (s.kind !== operatingKind) throw Error("FINALIZATION_OPERATING_REQUIRED");
  s.finalization = {
    contractHash: finalizationContractHash,
    status: "OPEN",
    checkpoint: null,
    rejectedInputs: [],
  };
}
export function applyFinalization(
  previous: ReservationState,
  config: OperatingConfig,
  records: readonly unknown[],
  raw: unknown,
  epoch: number,
): ReservationState {
  if (
    !config.finalization ||
    !previous.finalization ||
    previous.kind !== operatingKind
  )
    throw Error("FINALIZATION_EXPLICIT_CONTRACT_REQUIRED");
  finalizationOptionsSchema.parse(config.finalization);
  z.number().int().safe().min(previous.epoch).parse(epoch);
  const command = finalizationCommandSchema.parse(raw),
    s = structuredClone(previous),
    m = s.finalization!;
  if (command.kind === "FINALIZE_OPERATING") {
    if (m.checkpoint) throw Error("FINALIZATION_ALREADY_APPLIED");
    // Caller-supplied totals are never accepted. The Store supplies the full
    // verified prefix inside its writer transaction (and again during replay).
    const report = projectOperatingClose(
      config,
      previous,
      records,
      command.request,
    );
    if (
      report.status !== "VERIFIED_FIXTURE_PROJECTION" ||
      report.projectedLossStreak === null
    )
      throw Error(`FINALIZATION_HOLD:${report.reasons.join(",")}`);
    m.checkpoint = {
      closeId: command.closeId,
      request: command.request,
      report,
      appliedAt: command.request.asOf,
      appliedRevision: s.revision + 1,
      epoch,
      initialLossStreak: s.seed.ledger.lossStreak,
      appliedLossStreak: report.projectedLossStreak,
      counterApplied: true,
    };
    m.status = "FINALIZED";
    s.seed.ledger.lossStreak = report.projectedLossStreak;
    if (report.projectedConsecutiveLossReviewHalt)
      latch(s.seed, "CONSECUTIVE_LOSSES");
    // Keep all existing admission holds, latches and cooldowns. Closing a day
    // is not permission to resume or reset daily/monthly risk history.
    s.handoff!.admissionHolds.push("FINALIZED_MANUAL_REVIEW_REQUIRED");
    s.seed.clock = command.request.asOf;
    if (config.postClose) capturePostCloseBasis(s);
    if (config.partialSettlement) capturePartialSettlementBasis(s);
  } else {
    if (!m.checkpoint) throw Error("POST_CLOSE_REQUIRES_CHECKPOINT");
    if (m.rejectedInputs.length >= postCloseInputLimit)
      throw Error("POST_CLOSE_INPUT_LIMIT");
    if (command.observedAt < s.seed.clock)
      throw Error("POST_CLOSE_TIME_REWIND");
    if (
      (config.postClose &&
        command.observedAt >= config.postClose.followupEndExclusive) ||
      (config.partialSettlement &&
        command.observedAt >= config.partialSettlement.followupEndExclusive)
    )
      throw Error("POST_CLOSE_TIME_INVALID");
    m.rejectedInputs.push({
      rawJson: command.rawJson,
      observedAt: command.observedAt,
    });
    m.status = "RECONCILING";
    if (
      !s.handoff!.admissionHolds.includes("POST_CLOSE_RECONCILIATION_REQUIRED")
    )
      s.handoff!.admissionHolds.push("POST_CLOSE_RECONCILIATION_REQUIRED");
    s.seed.clock = command.observedAt;
  }
  s.revision++;
  s.epoch = epoch;
  s.seed.epoch = epoch;
  s.book.seedHash = hash(s.seed);
  return s;
}
