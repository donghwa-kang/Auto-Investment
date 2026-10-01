import { z } from "zod";
import { hash, policyHash, verifyPolicies } from "./policy.js";
import { operatingKind, operatingConfigSchema } from "./cost-operating.js";
import type { OperatingConfig } from "./cost-operating.js";
import type { ReservationState } from "./cost-reservation.js";
import { finalizationOptionsSchema } from "./cost-finalization.js";
import { postCloseOptionsSchema } from "./cost-post-close.js";
import { partialSettlementOptionsSchema } from "./cost-partial-settlement.js";
import { costOperatingLoopConfigSchema } from "./cost-loop-schema.js";
import { costRiskBookSchema } from "./cost-risk-context.js";
import { costJournalConfigSchema } from "./cost-journal.js";
import {
  buildOperatingReport,
  operatingReportPermissions,
} from "./cost-operating-report.js";
import {
  initialOperatingReplay,
  applyOperatingReplay,
  duplicateOperatingReplay,
  operatingRecordSchema,
  operatingRecordLimit,
  maxOperatingRecords,
  operatingSha,
} from "./cost-operating-replay.js";
import type { OperatingRecord } from "./cost-operating-replay.js";
import { historyAdmissionSchema } from "./cost-history-admission.js";

export const MAX_OPERATING_EVIDENCE_BYTES = 16 * 1024 * 1024;
export class OperatingEvidenceError extends Error {}
function reject(code: string): never {
  throw new OperatingEvidenceError(code);
}
const configShape = z.strictObject({
  kind: z.literal(operatingKind),
  runId: costJournalConfigSchema.shape.runId,
  // State is supplied by the independent, trusted caller, not cast from JSON.
  seed: z.unknown(),
  book: costRiskBookSchema,
  sourceScope: costJournalConfigSchema.shape.sourceScope,
  horizonEnd: costJournalConfigSchema.shape.horizonEnd,
  operating: operatingConfigSchema,
  finalization: finalizationOptionsSchema.optional(),
  postClose: postCloseOptionsSchema.optional(),
  partialSettlement: partialSettlementOptionsSchema.optional(),
  operatingLoop: costOperatingLoopConfigSchema.optional(),
  historyAdmission: historyAdmissionSchema.optional(),
});
const envelopeSchema = z.strictObject({
  kind: z.literal("SYNTHETIC_OPERATING_EVIDENCE_V1"),
  purpose: z.literal("TEST_ONLY"),
  config: z.unknown(),
  configHash: operatingSha,
  policyHash: z.literal(policyHash),
  initialEpoch: z.number().int().safe().min(1),
  // Validate records one by one below: a large invalid union array must not
  // allocate errors for every item before returning its first failure.
  records: z.array(z.unknown()).max(maxOperatingRecords),
  report: z.unknown(),
  asOf: z.number().int().safe().nonnegative().max(8_640_000_000_000_000),
  orderSubmissionAllowed: z.literal(false),
  learningAllowed: z.literal(false),
  liveEnabled: z.literal(false),
  newSpendingAllowed: z.literal(false),
  automaticResumeAllowed: z.literal(false),
  exportHash: operatingSha,
});
function boundedJson(text: string): unknown {
  if (
    typeof text !== "string" ||
    text.length > MAX_OPERATING_EVIDENCE_BYTES ||
    Buffer.byteLength(text, "utf8") > MAX_OPERATING_EVIDENCE_BYTES
  )
    reject("OPERATING_EVIDENCE_SIZE_LIMIT");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    reject("OPERATING_EVIDENCE_JSON_INVALID");
  }
  const pending = [{ value: raw, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 500000 || depth > 64)
      reject("OPERATING_EVIDENCE_STRUCTURE_LIMIT");
    if (typeof value === "number" && !Number.isFinite(value))
      reject("OPERATING_EVIDENCE_NONFINITE");
    if (value !== null && typeof value === "object")
      for (const child of Object.values(value))
        pending.push({ value: child, depth: depth + 1 });
  }
  return raw;
}
export function checkOperatingEvidenceConfig(c: OperatingConfig) {
  const parsed = configShape.safeParse(c);
  if (!parsed.success || hash(parsed.data) !== hash(c))
    reject("OPERATING_EVIDENCE_CONFIG_SHAPE");
}
// Capture helper for a verified Store snapshot. No file/network writes.
export function buildOperatingEvidence(
  config: OperatingConfig,
  initialEpoch: number,
  records: OperatingRecord[],
  state: ReservationState,
  asOf?: number,
) {
  checkOperatingEvidenceConfig(config);
  const report = buildOperatingReport(config, state, records, asOf);
  if (records.length > operatingRecordLimit(config))
    reject("OPERATING_EVIDENCE_RECORD_LIMIT");
  const body = {
    kind: "SYNTHETIC_OPERATING_EVIDENCE_V1" as const,
    purpose: "TEST_ONLY" as const,
    config: structuredClone(config),
    configHash: hash(config),
    policyHash,
    initialEpoch,
    records: structuredClone(records),
    asOf: report.asOf,
    report,
    ...operatingReportPermissions,
  };
  const result = { ...body, exportHash: hash(body) };
  // Refuse the complete export, never truncate a valid but oversized journal.
  boundedJson(JSON.stringify(result));
  return result;
}
export type OperatingEvidence = ReturnType<typeof buildOperatingEvidence>;
export interface OperatingEvidenceAnchor {
  config: OperatingConfig;
  exportHash: string;
}

export function verifyOperatingEvidence(
  text: string,
  anchor: OperatingEvidenceAnchor,
) {
  try {
    verifyPolicies();
    if (
      !anchor ||
      !operatingSha.safeParse(anchor.exportHash).success ||
      !anchor.config
    )
      reject("OPERATING_EVIDENCE_ANCHOR_REQUIRED");
    checkOperatingEvidenceConfig(anchor.config);
    const raw = boundedJson(text),
      parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success || hash(raw) !== hash(parsed.data))
      reject("OPERATING_EVIDENCE_SCHEMA_INVALID");
    const { exportHash, ...body } = parsed.data;
    if (hash(body) !== exportHash || exportHash !== anchor.exportHash)
      reject("OPERATING_EVIDENCE_HASH_MISMATCH");
    const c = structuredClone(anchor.config);
    if (hash(c) !== body.configHash || hash(body.config) !== body.configHash)
      reject("OPERATING_EVIDENCE_CONFIG_MISMATCH");
    if (body.records.length > operatingRecordLimit(c))
      reject("OPERATING_EVIDENCE_RECORD_LIMIT");
    let state = initialOperatingReplay(c, body.initialEpoch);
    const ids = new Set<string>(),
      prefix: OperatingRecord[] = [];
    for (const rawRecord of body.records) {
      const parsedRecord = operatingRecordSchema.safeParse(rawRecord);
      if (!parsedRecord.success || hash(rawRecord) !== hash(parsedRecord.data))
        reject("OPERATING_EVIDENCE_SCHEMA_INVALID");
      const record = parsedRecord.data;
      const { id, input, receipt } = record;
      if (
        ids.has(id) ||
        input.expectedRevision !== state.revision ||
        input.expectedStateHash !== hash(state) ||
        input.epoch < state.epoch ||
        duplicateOperatingReplay(state, input.command)
      )
        reject("OPERATING_EVIDENCE_COMMAND_MISMATCH");
      ids.add(id);
      state = applyOperatingReplay(
        state,
        c,
        input.command,
        input.epoch,
        prefix,
      );
      if (
        hash(receipt) !==
        hash({ revision: state.revision, stateHash: hash(state) })
      )
        reject("OPERATING_EVIDENCE_RECEIPT_MISMATCH");
      prefix.push(record);
    }
    const report = buildOperatingReport(c, state, prefix, body.asOf);
    if (hash(report) !== hash(body.report))
      reject("OPERATING_EVIDENCE_REPORT_MISMATCH");
    return {
      kind: "VERIFIED_SYNTHETIC_REPLAY" as const,
      status: "HOLD" as const,
      exportHash,
      report,
      ...operatingReportPermissions,
    };
  } catch (error) {
    if (error instanceof OperatingEvidenceError) throw error;
    reject("OPERATING_EVIDENCE_REPLAY_REJECTED");
  }
}
