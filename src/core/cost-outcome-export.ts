import { z } from "zod";
import { hash, policyHash, verifyPolicies } from "./policy.js";
import {
  initialHandoff,
  applyHandoffCommand,
  duplicateHandoffFill,
  handoffCommandSchema,
  handoffCommandLimit,
} from "./cost-handoff.js";
import { costJournalConfigSchema } from "./cost-journal.js";
import { outcomeKind } from "./cost-reservation.js";
import type { ReservationState } from "./cost-reservation.js";
import type { OutcomeConfig } from "./cost-outcome.js";
import { buildCostOutcomeReport } from "./cost-outcome-report.js";

export const MAX_COST_EXPORT_BYTES = 16 * 1024 * 1024;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.number().int().safe().min(1);
const revision = z.number().int().min(0).max(handoffCommandLimit);
const recordSchema = z
  .object({
    id: costJournalConfigSchema.shape.runId,
    input: z
      .object({
        expectedRevision: revision,
        expectedStateHash: sha,
        epoch,
        command: handoffCommandSchema,
      })
      .strict(),
    receipt: z.object({ revision, stateHash: sha }).strict(),
  })
  .strict();
export type CostExportRecord = z.infer<typeof recordSchema>;
const envelopeSchema = z
  .object({
    kind: z.literal("SYNTHETIC_COST_HOLD_EXPORT_V1"),
    purpose: z.literal("TEST_ONLY"),
    config: z.unknown(),
    configHash: sha,
    policyHash: z.literal(policyHash),
    initialEpoch: epoch,
    records: z.array(recordSchema).max(handoffCommandLimit),
    report: z.unknown(),
    orderSubmissionAllowed: z.literal(false),
    learningAllowed: z.literal(false),
    liveEnabled: z.literal(false),
    exportHash: sha,
  })
  .strict();

export class CostOutcomeExportError extends Error {}
function reject(code: string): never {
  throw new CostOutcomeExportError(code);
}

// Internal capture helper: caller must have verified one committed V3 snapshot.
// This is not the untrusted-file entry point.
export function buildCostOutcomeExport(
  config: OutcomeConfig,
  initialEpoch: number,
  records: CostExportRecord[],
  state: ReservationState,
) {
  if (config.kind !== outcomeKind) reject("COST_EXPORT_V3_REQUIRED");
  const body = {
    kind: "SYNTHETIC_COST_HOLD_EXPORT_V1" as const,
    purpose: "TEST_ONLY" as const,
    config: structuredClone(config),
    configHash: hash(config),
    policyHash,
    initialEpoch,
    records: structuredClone(records),
    report: buildCostOutcomeReport(state, hash(config)),
    orderSubmissionAllowed: false as const,
    learningAllowed: false as const,
    liveEnabled: false as const,
  };
  return { ...body, exportHash: hash(body) };
}
export type CostOutcomeExport = ReturnType<typeof buildCostOutcomeExport>;
export interface CostExportAnchor {
  // Supplied independently by the local verifier, NEVER taken from the file.
  config: OutcomeConfig;
  exportHash: string;
}

function parseBoundedJson(text: string): unknown {
  if (
    typeof text !== "string" ||
    text.length > MAX_COST_EXPORT_BYTES ||
    Buffer.byteLength(text, "utf8") > MAX_COST_EXPORT_BYTES
  )
    reject("COST_EXPORT_SIZE_LIMIT");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    reject("COST_EXPORT_JSON_INVALID");
  }
  const pending: { value: unknown; depth: number }[] = [
    { value: raw, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 500000 || depth > 64) reject("COST_EXPORT_STRUCTURE_LIMIT");
    if (typeof value === "number" && !Number.isFinite(value))
      reject("COST_EXPORT_NONFINITE_NUMBER");
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value))
        pending.push({ value: child, depth: depth + 1 });
    }
  }
  return raw;
}

// Independent of SQLite and stored derived reports, not a second cost model.
// The trusted config prevents treating an arbitrary JSON State as a typed seed.
export function verifyCostOutcomeExport(
  text: string,
  anchor: CostExportAnchor,
) {
  try {
    verifyPolicies();
    if (!sha.safeParse(anchor.exportHash).success)
      reject("COST_EXPORT_ANCHOR_REQUIRED");
    if (anchor.config.kind !== outcomeKind) reject("COST_EXPORT_V3_REQUIRED");
    const raw = parseBoundedJson(text);
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) reject("COST_EXPORT_SCHEMA_INVALID");
    if (hash(raw) !== hash(parsed.data))
      reject("COST_EXPORT_SCHEMA_NORMALIZATION");
    const { exportHash, ...body } = parsed.data;
    if (hash(body) !== exportHash || exportHash !== anchor.exportHash)
      reject("COST_EXPORT_HASH_MISMATCH");
    const configHash = hash(anchor.config);
    if (body.configHash !== configHash || hash(body.config) !== configHash)
      reject("COST_EXPORT_CONFIG_MISMATCH");
    let state = initialHandoff(
      structuredClone(anchor.config),
      body.initialEpoch,
    );
    const ids = new Set<string>();
    for (const record of body.records) {
      const { id, input, receipt } = record;
      if (
        ids.has(id) ||
        input.expectedRevision !== state.revision ||
        input.expectedStateHash !== hash(state) ||
        input.epoch < state.epoch ||
        duplicateHandoffFill(state, input.command)
      )
        reject("COST_EXPORT_COMMAND_MISMATCH");
      ids.add(id);
      state = applyHandoffCommand(state, input.command, input.epoch);
      if (
        hash(receipt) !==
        hash({ revision: state.revision, stateHash: hash(state) })
      )
        reject("COST_EXPORT_RECEIPT_MISMATCH");
    }
    const report = buildCostOutcomeReport(state, configHash);
    if (hash(body.report) !== hash(report))
      reject("COST_EXPORT_REPORT_MISMATCH");
    return {
      kind: "VERIFIED_COST_HOLD_EXPORT_V1" as const,
      status: "HOLD" as const,
      exportHash,
      report,
      orderSubmissionAllowed: false as const,
      learningAllowed: false as const,
      liveEnabled: false as const,
    };
  } catch (error) {
    if (error instanceof CostOutcomeExportError) throw error;
    // Do not reflect input data, paths or parser/reducer errors to callers.
    reject("COST_EXPORT_REPLAY_REJECTED");
  }
}
