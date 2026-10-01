import { z } from "zod";
import { rvolSourceSchema } from "./learning-rvol-schema.js";
// 원시 주문/판단 ID는 학습 ID보다 길다. 학습 ID로 줄일 때 전체 원문 해시를 사용한다.
export const paperId = z
  .string()
  .min(1)
  .max(220)
  .regex(/^[A-Za-z0-9:._-]+$/);
export const paperDigest = z.string().regex(/^[a-fA-F0-9]{64}$/);
export const paperTime = z
  .number()
  .int()
  .nonnegative()
  .max(8_640_000_000_000_000);
export const paperMoney = z
  .string()
  .max(100)
  .regex(/^-?\d{1,30}(\.\d{1,60})?$/);
const scalar = z.union([
  z.string().max(300),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const trace = z.strictObject({
  predicate_id: paperId,
  input_values: z.record(z.string().max(80), scalar),
  threshold: z.string().max(300),
  operator: z.string().max(80),
  result: z.enum(["PASS", "FAIL", "MISSING", "NOT_APPLICABLE"]),
  reason: z.string().max(300),
  strategy_version: z.string().max(80),
  indicator_version: z.string().max(80),
  data_version: z.string().max(120),
  as_of: paperTime,
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  effective_caps_hash: paperDigest.optional(),
});
export const recordedDecisionSchema = z.strictObject({
  id: paperId,
  at: paperTime,
  symbol: paperId,
  strategy: z.enum(["B", "P"]).nullable(),
  result: z.enum(["APPROVED", "ABSTAIN"]),
  reasons: z.array(z.string().max(300)).max(100),
  trace: z.array(trace).max(200),
  quantity: z.number().int().nonnegative(),
  snapshotHash: paperDigest.optional(),
});
export const recordedOrderSchema = z.strictObject({
  id: paperId,
  intentId: paperId,
  positionId: paperId,
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().int().positive(),
  filled: z.number().int().nonnegative(),
  value: paperMoney,
  limit: paperMoney,
  currency: z.enum(["KRW", "USD"]),
  status: z.enum([
    "INTENT_SAVED",
    "WORKING",
    "PARTIAL",
    "CANCEL_PENDING",
    "CANCEL_UNKNOWN",
    "UNKNOWN",
    "FILLED",
    "CANCELLED",
    "REJECTED",
  ]),
  submittedAt: paperTime,
  snapshot: z.record(z.string().max(100), z.unknown()).nullable(),
  snapshotHash: paperDigest.nullable(),
  eventIds: z.array(paperId).max(10000),
});
export const recordedPositionSchema = z.strictObject({
  id: paperId,
  intentId: paperId,
  symbol: paperId,
  market: z.enum(["KR", "US"]),
  currency: z.enum(["KRW", "USD"]),
  owner: z.literal("BOT"),
  quantity: z.number().int().nonnegative(),
  buyQuantity: z.number().int().positive(),
  buyValue: paperMoney,
  entryFees: paperMoney,
  exitValue: paperMoney,
  exitFees: paperMoney,
  firstFillAt: paperTime,
  closedAt: paperTime.nullable(),
  netPnl: paperMoney.nullable(),
  protection: z.string().max(50),
});
export const recordedFillSchema = z.strictObject({
  id: paperId,
  commandId: paperId,
  at: paperTime,
  orderId: paperId,
  positionId: paperId,
  side: z.enum(["BUY", "SELL"]),
  currency: z.enum(["KRW", "USD"]),
  quantity: z.number().int().positive(),
  value: paperMoney,
  fee: paperMoney,
  cumulativeQuantity: z.number().int().positive(),
  cumulativeValue: paperMoney,
});
export const journalSchema = z.strictObject({
  schemaVersion: z.literal("PAPER_LEARNING_JOURNAL_V1"),
  purpose: z.literal("TEST_ONLY"),
  runHash: paperDigest,
  policyHash: paperDigest,
  strategyHash: paperDigest,
  profileHash: paperDigest,
  startedAt: paperTime,
  featureSources: z.array(rvolSourceSchema).max(500).optional(),
  decisions: z.array(recordedDecisionSchema).max(500),
  fills: z.array(recordedFillSchema).max(10000),
  closures: z
    .array(
      z.strictObject({
        positionId: paperId,
        at: paperTime,
        fx: paperMoney,
        netPnlKrw: paperMoney,
      }),
    )
    .max(500),
});
export const paperExportSchema = z.strictObject({
  schemaVersion: z.literal("PAPER_LEARNING_EXPORT_V1"),
  purpose: z.literal("TEST_ONLY"),
  journal: journalSchema,
  asOf: paperTime,
  revision: z.number().int().positive(),
  stateHash: paperDigest,
  auditHead: paperDigest,
  auditCount: z.number().int().positive(),
  orders: z.array(recordedOrderSchema).max(2000),
  positions: z.array(recordedPositionSchema).max(500),
  costs: z
    .array(
      z.strictObject({
        id: z.string().max(220),
        amount: paperMoney,
        at: paperTime,
        paid: z.boolean(),
      }),
    )
    .max(1000),
  liveEnabled: z.literal(false),
  exportHash: paperDigest,
});
export type PaperJournal = z.infer<typeof journalSchema>;
export type PaperExport = z.infer<typeof paperExportSchema>;
export type RecordedOrder = z.infer<typeof recordedOrderSchema>;
export class PaperLearningError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
