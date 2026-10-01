import { z } from "zod";
import { Decimal } from "decimal.js";
import { hash, policyHash, spec } from "./policy.js";
import { paperExportSchema } from "./paper-learning-schema.js";
import {
  derivePaperRows,
  engineFeatureProfile,
  legacyEngineFeatureProfile,
} from "./paper-learning-convert.js";

export class LearningError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const learningId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);
const digest = z.string().regex(/^[a-fA-F0-9]{64}$/);
const time = z.iso.datetime().refine((s) => !/\.\d{4}/.test(s));
const decimal = z
  .string()
  .max(24)
  .regex(/^-?\d{1,12}(\.\d{1,8})?$/);
const nonnegative = decimal.refine((s) => new Decimal(s).gte(0));
const positive = nonnegative.refine((s) => new Decimal(s).gt(0));
const finite = z.number().finite().min(-1e6).max(1e6);
const decision = z
  .object({
    id: learningId,
    instrumentId: learningId,
    market: z.enum(["KR", "US"]),
    currency: z.enum(["KRW", "USD"]),
    signal: z.enum(["B", "P", "NONE"]),
    action: z.enum(["PAPER_ENTRY", "ABSTAIN"]),
    decisionAt: time,
    sourceAsOf: time,
    availableAt: time,
    evidenceHash: digest,
    features: z.array(finite).min(1).max(8),
    riskUnit: positive,
  })
  .strict();
const outcome = z
  .object({
    id: learningId,
    decisionId: learningId,
    decisionHash: digest,
    kind: z.enum(["SIMULATED_CLOSED", "COUNTERFACTUAL", "UNRESOLVED"]),
    closedAt: time.nullable(),
    availableAt: time,
    currency: z.enum(["KRW", "USD"]),
    grossPnl: decimal.nullable(),
    costs: z
      .object({
        commission: nonnegative,
        tax: nonnegative,
        slippage: nonnegative,
        fx: nonnegative,
        operation: nonnegative,
      })
      .strict()
      .nullable(),
  })
  .strict();
const fold = z
  .object({
    id: learningId,
    trainFrom: time,
    trainTo: time,
    testFrom: time,
    testTo: time,
  })
  .strict();
export const learningSchema = z
  .object({
    schemaVersion: z.enum([
      "LEARNING_RESEARCH_V1",
      "ENGINE_LEARNING_RESEARCH_V1",
      "ENGINE_LEARNING_RESEARCH_V2",
    ]),
    purpose: z.literal("TEST_ONLY"),
    dataOrigin: z.enum(["DECLARED_SYNTHETIC", "ENGINE_RECORDED_SYNTHETIC"]),
    engineSource: paperExportSchema.optional(),
    experimentId: learningId,
    asOf: time,
    policyHash: digest,
    strategyHash: digest,
    market: z.enum(["KR", "US"]),
    signal: z.enum(["B", "P"]),
    featureProfile: z
      .object({
        id: learningId,
        version: z.literal(1),
        origin: z.enum([
          "DECLARED_NOT_REBUILT",
          "ENGINE_TRACE_NOT_REBUILT",
          "ENGINE_SOURCE_REBUILT",
        ]),
        fields: z
          .array(
            z
              .object({ id: learningId, unit: z.literal("DIMENSIONLESS") })
              .strict(),
          )
          .min(1)
          .max(8),
      })
      .strict(),
    model: z
      .object({
        kind: z.literal("RIDGE_V1"),
        lambda: z.number().finite().min(0.000001).max(1e6),
        numericProfile: z.literal("JS_FLOAT64_RESEARCH_V1"),
      })
      .strict(),
    validation: z
      .object({
        minTrainRows: z.number().int().min(8).max(5000),
        minTestRows: z.number().int().min(2).max(5000),
        embargoMinutes: z.number().int().min(1).max(10080),
        folds: z.array(fold).min(1).max(10),
      })
      .strict(),
    decisions: z.array(decision).min(1).max(5000),
    outcomes: z.array(outcome).max(10000),
  })
  .strict()
  .superRefine((v, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (
      v.schemaVersion === "ENGINE_LEARNING_RESEARCH_V1" ||
      v.schemaVersion === "ENGINE_LEARNING_RESEARCH_V2"
    ) {
      try {
        const legacy = v.schemaVersion === "ENGINE_LEARNING_RESEARCH_V1";
        if (
          v.dataOrigin !== "ENGINE_RECORDED_SYNTHETIC" ||
          !v.engineSource ||
          hash(v.featureProfile) !==
            hash(legacy ? legacyEngineFeatureProfile : engineFeatureProfile) ||
          (legacy && v.engineSource.journal.featureSources !== undefined) ||
          Date.parse(v.asOf) !== v.engineSource.asOf
        )
          throw new Error();
        const rows = derivePaperRows(
          v.engineSource,
          v.market,
          v.signal,
          legacy,
        );
        if (
          hash(rows.decisions) !== hash(v.decisions) ||
          hash(rows.outcomes) !== hash(v.outcomes)
        )
          throw new Error();
      } catch {
        invalid("ENGINE_SOURCE_BINDING_INVALID");
      }
    } else if (
      v.dataOrigin !== "DECLARED_SYNTHETIC" ||
      v.engineSource !== undefined ||
      v.featureProfile.origin !== "DECLARED_NOT_REBUILT"
    )
      invalid("DECLARED_SOURCE_BINDING_INVALID");
    if (v.policyHash !== policyHash || v.strategyHash !== hash(spec))
      invalid("POLICY_BINDING_MISMATCH");
    for (const ids of [
      v.decisions.map((d) => d.id),
      v.outcomes.map((o) => o.id),
      v.validation.folds.map((f) => f.id),
      v.featureProfile.fields.map((f) => f.id),
    ])
      if (new Set(ids).size !== ids.length) invalid("DUPLICATE_ID");
    if (
      v.decisions.some(
        (d) => d.features.length !== v.featureProfile.fields.length,
      )
    )
      invalid("FEATURE_DIMENSION_MISMATCH");
    let priorTestEnd = -Infinity;
    for (const f of v.validation.folds) {
      const a = Date.parse(f.trainFrom),
        b = Date.parse(f.trainTo),
        c = Date.parse(f.testFrom),
        d = Date.parse(f.testTo);
      if (!(
        a < b &&
        b + v.validation.embargoMinutes * 60000 <= c &&
        c < d &&
        d <= Date.parse(v.asOf) &&
        c >= priorTestEnd
      ))
        invalid("FOLD_BOUNDARY_INVALID");
      priorTestEnd = d;
    }
  });
export type LearningInput = z.infer<typeof learningSchema>;
export type LearningDecision = LearningInput["decisions"][number];
export function parseLearningInput(raw: unknown): LearningInput {
  try {
    const text = JSON.stringify(raw);
    if (!text || Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error();
    return learningSchema.parse(raw);
  } catch {
    throw new LearningError("LEARNING_INPUT_INVALID");
  }
}
