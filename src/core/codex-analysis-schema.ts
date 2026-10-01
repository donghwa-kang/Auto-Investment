import { z } from "zod";
import { analysisExecutionSchema } from "./analysis-execution-schema.js";
import {
  recordBundleSchema,
  recordPeriodSchema,
  recordSummarySchema,
} from "./analysis-record-schema.js";

export const analysisHash = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().datetime();
export const analysisMetric = z.enum(["decisions", "approved", "closedTrades"]);
export const analysisSuggestion = z.enum([
  "COLLECT_MORE_SYNTHETIC_RECORDS",
  "KEEP_TRADING_GATES_UNCHANGED",
]);
export const fixedAnalysisBundleSchema = z.strictObject({
  version: z.literal("MOCK_ANALYSIS_BUNDLE_V1"),
  origin: z.literal("FIXED_SYNTHETIC_NOT_ENGINE_RECORDS"),
  purpose: z.literal("PAPER_REVIEW_ONLY"),
  symbol: z.literal("TEST_KR_A"),
  periodStart: at,
  asOf: at,
  policies: z.strictObject({
    trading: analysisHash,
    strategy: analysisHash,
    theme: analysisHash,
  }),
  source: z.strictObject({
    id: z.literal("SYNTHETIC_REVIEW_FIXTURE_V1"),
    observedAt: at,
    metrics: z.strictObject({
      decisions: z.number().int().min(0).max(10000),
      approved: z.number().int().min(0).max(10000),
      closedTrades: z.number().int().min(0).max(10000),
    }),
  }),
});
export const analysisBundleSchema = z.discriminatedUnion("version", [
  fixedAnalysisBundleSchema,
  recordBundleSchema,
]);
export type AnalysisBundle = z.infer<typeof analysisBundleSchema>;
export const analysisRequestSchema = z.strictObject({
  version: z.literal("LOCAL_MOCK_REQUEST_V1"),
  id: z.string().uuid(),
  createdAt: at,
  expiresAt: at,
  adapter: z.literal("LOCAL_DETERMINISTIC_MOCK_V1"),
  execution: analysisExecutionSchema.optional(),
  promptVersion: z.literal("MOCK_PAPER_REVIEW_V1"),
  parserVersion: z.literal("MOCK_RESULT_VALIDATOR_V1"),
  budget: z.strictObject({
    calls: z.literal(1),
    timeoutMs: z.literal(3000),
    retries: z.literal(0),
  }),
  permissions: z.strictObject({
    network: z.literal(false),
    files: z.literal(false),
    tools: z.literal(false),
    orders: z.literal(false),
    policyWrite: z.literal(false),
    modelPromotion: z.literal(false),
  }),
  bundle: analysisBundleSchema,
  bundleHash: analysisHash,
});
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;
const fixedAnalysisResultSchema = z.strictObject({
  version: z.literal("LOCAL_MOCK_RESULT_V1"),
  requestId: z.string().uuid(),
  requestHash: analysisHash,
  bundleHash: analysisHash,
  adapter: z.literal("LOCAL_DETERMINISTIC_MOCK_V1"),
  execution: analysisExecutionSchema.optional(),
  generatedAt: at,
  asOf: at,
  advisoryOnly: z.literal(true),
  mock: z.literal(true),
  facts: z
    .array(
      z.strictObject({
        sourceId: z.union([
          z.literal("SYNTHETIC_REVIEW_FIXTURE_V1"),
          analysisHash,
        ]),
        observedAt: at,
        metric: analysisMetric,
        value: z.number().int().nonnegative().max(10000),
      }),
    )
    .length(3),
  suggestions: z.array(analysisSuggestion).min(1).max(2),
  usage: z.strictObject({
    mockCalls: z.literal(1),
    externalCalls: z.literal(0),
    tokens: z.literal(0),
    additionalCashCostKrw: z.literal(0),
  }),
});
export const analysisResultSchema = z.discriminatedUnion("version", [
  fixedAnalysisResultSchema,
  fixedAnalysisResultSchema.extend({
    version: z.literal("LOCAL_MOCK_RECORD_RESULT_V1"),
    summary: recordSummarySchema,
    recordRefs: z.array(analysisHash).min(1).max(100),
  }),
]);
export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export const analysisStatus = z.enum([
  "AWAITING_APPROVAL",
  "APPROVED",
  "RUNNING",
  "VERIFIED_MOCK",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "TIMED_OUT",
  "FAILED",
  "INTERRUPTED",
]);
export type AnalysisStatus = z.infer<typeof analysisStatus>;
export const analysisJobSchema = z.strictObject({
  request: analysisRequestSchema,
  requestHash: analysisHash,
  state: analysisStatus,
  approvedHash: analysisHash.nullable(),
  approvedAt: at.nullable(),
  startedAt: at.nullable(),
  finishedAt: at.nullable(),
  calls: z.number().int().min(0).max(1),
  rawOutput: z.string().max(16384).nullable(),
  result: analysisResultSchema.nullable(),
  resultHash: analysisHash.nullable(),
  error: z
    .enum([
      "RESTART_REQUIRES_NEW_REQUEST",
      "USER_CANCELLED",
      "APPROVAL_EXPIRED",
      "TIMEOUT",
      "MOCK_FAILURE",
      "INVALID_RESULT",
      "SHUTDOWN_INTERRUPTED",
    ])
    .nullable(),
});
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export const analysisCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create"),
    id: z.string().uuid(),
    dataset: z.literal("SYNTHETIC_REVIEW_FIXTURE_V1"),
  }),
  z.strictObject({
    type: z.literal("create-record"),
    id: z.string().uuid(),
    sourceId: analysisHash,
    period: recordPeriodSchema,
  }),
  z.strictObject({
    type: z.literal("approve"),
    id: z.string().uuid(),
    requestHash: analysisHash,
    acknowledgeMockOnly: z.literal(true),
    acknowledgeExactData: z.literal(true),
  }),
  z.strictObject({
    type: z.literal("run"),
    id: z.string().uuid(),
    requestHash: analysisHash,
  }),
  z.strictObject({
    type: z.literal("cancel"),
    id: z.string().uuid(),
    requestHash: analysisHash,
  }),
]);
export type AnalysisCommand = z.infer<typeof analysisCommandSchema>;
export interface AnalysisView {
  mode: "MOCK_ONLY";
  jobs: AnalysisJob[];
  mockCalls: number | null;
  externalCalls: 0;
  automaticApplication: false;
  error: string | null;
}
