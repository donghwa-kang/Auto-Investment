import { z } from "zod";
import {
  initialHandoff,
  applyHandoffCommand,
  extendedHandoffCommandSchema,
  handoffCommandLimit,
  duplicateHandoffFill,
} from "./cost-handoff.js";
import {
  operatingKind,
  operatingEventLimit,
  duplicateOperatingEvent,
} from "./cost-operating.js";
import type { OperatingConfig } from "./cost-operating.js";
import type { ReservationState } from "./cost-reservation.js";
import {
  initializeFinalization,
  applyFinalization,
  finalizationCommandSchema,
  finalizationExtraSlots,
} from "./cost-finalization.js";
import {
  initializePostClose,
  applyPostClose,
  isPostCloseCommand,
  postCloseCommandSchema,
  postCloseTargetLimit,
} from "./cost-post-close.js";
import {
  initializePartialSettlement,
  applyPartialSettlement,
  isPartialSettlementCommand,
  partialSettlementCommandSchema,
  partialSettlementEventLimit,
} from "./cost-partial-settlement.js";
import { costJournalConfigSchema } from "./cost-journal.js";

export const operatingSha = z.string().regex(/^[a-f0-9]{64}$/);
export const maxOperatingRecords =
  handoffCommandLimit +
  operatingEventLimit +
  finalizationExtraSlots +
  partialSettlementEventLimit;
const revision = z.number().int().min(0).max(maxOperatingRecords);
export const operatingRecordSchema = z.strictObject({
  id: costJournalConfigSchema.shape.runId,
  input: z.strictObject({
    expectedRevision: revision,
    expectedStateHash: operatingSha,
    epoch: z.number().int().safe().min(1),
    command: z.union([
      extendedHandoffCommandSchema,
      finalizationCommandSchema,
      postCloseCommandSchema,
      partialSettlementCommandSchema,
    ]),
  }),
  receipt: z.strictObject({ revision, stateHash: operatingSha }),
});
export type OperatingRecord = z.infer<typeof operatingRecordSchema>;
export type OperatingReplayCommand = OperatingRecord["input"]["command"];
export function operatingRecordLimit(c: OperatingConfig) {
  return (
    handoffCommandLimit +
    operatingEventLimit +
    (c.finalization ? finalizationExtraSlots : 0) +
    (c.postClose ? postCloseTargetLimit : 0) +
    (c.partialSettlement ? partialSettlementEventLimit : 0)
  );
}

// Shared by the existing Store and the portable verifier. This extraction
// changes no persisted state, command, receipt or hash format.
export function initialOperatingReplay(c: OperatingConfig, epoch: number) {
  if (c.kind !== operatingKind) throw Error("OPERATING_REPLAY_V4_REQUIRED");
  const s = initialHandoff(c, epoch);
  if ("finalization" in c) initializeFinalization(s, c);
  if ("postClose" in c) initializePostClose(s, c);
  if ("partialSettlement" in c) initializePartialSettlement(s, c);
  return s;
}
export function applyOperatingReplay(
  s: ReservationState,
  c: OperatingConfig,
  command: OperatingReplayCommand,
  epoch: number,
  records: readonly OperatingRecord[],
) {
  if (isPostCloseCommand(command)) return applyPostClose(s, command, epoch);
  if (isPartialSettlementCommand(command))
    return applyPartialSettlement(s, command, epoch);
  if (
    command.kind === "FINALIZE_OPERATING" ||
    command.kind === "POST_CLOSE_INPUT"
  )
    return applyFinalization(s, c, records, command, epoch);
  return applyHandoffCommand(s, command, epoch);
}
export function duplicateOperatingReplay(
  s: ReservationState,
  command: OperatingReplayCommand,
) {
  // D8/D9/D10 reducers already reject duplicated business events. FILL and
  // OPERATING writer retries must not become persisted extra records either.
  if (
    isPostCloseCommand(command) ||
    isPartialSettlementCommand(command) ||
    command.kind === "FINALIZE_OPERATING" ||
    command.kind === "POST_CLOSE_INPUT"
  )
    return false;
  return command.kind === "OPERATING"
    ? duplicateOperatingEvent(s, command.event)
    : duplicateHandoffFill(s, command);
}
