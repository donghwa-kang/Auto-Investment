import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().datetime();
const count = z.number().int().nonnegative().max(10000);
export const recordMoney = z
  .string()
  .regex(/^-?\d{1,30}(\.\d{1,40})?$/)
  .max(72);
export const recordPeriodSchema = z.strictObject({ from: at, to: at });
export type RecordPeriod = z.infer<typeof recordPeriodSchema>;
const totalsSchema = z.strictObject({
  fills: count,
  buyQuantity: count,
  sellQuantity: count,
  buyValue: recordMoney,
  sellValue: recordMoney,
  fillFees: recordMoney,
  reconciledClosures: count,
  costUnresolvedClosures: count,
  closedNetAfterRecordedFees: recordMoney.nullable(),
});
export const recordSummarySchema = z.strictObject({
  selectionRule: z.literal("DECISION_COHORT_INCLUSIVE_AS_OF_EVENTS_V1"),
  period: recordPeriodSchema,
  decisions: count,
  approved: count,
  abstained: count,
  closedTrades: count,
  noFillEntries: count,
  openOrUnreconciledEntries: count,
  costUnresolvedClosures: count,
  excludedDecisions: count,
  excludedFillEvents: count,
  operatingCostEventsAsOf: count,
  totals: z.strictObject({ KRW: totalsSchema, USD: totalsSchema }),
});
export type RecordSummary = z.infer<typeof recordSummarySchema>;
export const recordDetailSchema = z.strictObject({
  sourceRef: digest,
  decisionHash: digest,
  instrumentRef: digest,
  market: z.enum(["KR", "US"]),
  currency: z.enum(["KRW", "USD"]),
  at,
  strategy: z.enum(["B", "P"]).nullable(),
  action: z.enum(["APPROVED", "ABSTAIN"]),
  plannedQuantity: count,
  checks: z.strictObject({
    pass: count,
    fail: count,
    missing: count,
    notApplicable: count,
  }),
  reasonCount: count,
  entryPrice: recordMoney.nullable(),
  stopPrice: recordMoney.nullable(),
  fills: count,
  buyQuantity: count,
  sellQuantity: count,
  buyValue: recordMoney,
  sellValue: recordMoney,
  fillFees: recordMoney,
  status: z.enum([
    "ABSTAIN",
    "NO_FILL_AS_OF",
    "OPEN_OR_UNRECONCILED",
    "CLOSED_RECONCILED",
    "COST_UNRESOLVED",
  ]),
  closedAt: at.nullable(),
  grossPnl: recordMoney.nullable(),
  netAfterRecordedFees: recordMoney.nullable(),
});
export type RecordDetail = z.infer<typeof recordDetailSchema>;
export const recordBundleSchema = z.strictObject({
  version: z.literal("ENGINE_RECORD_ANALYSIS_BUNDLE_V1"),
  origin: z.literal("ENGINE_RECORDED_SYNTHETIC"),
  purpose: z.literal("PAPER_REVIEW_ONLY"),
  symbol: z.literal("SELECTED_DECISION_COHORT"),
  periodStart: at,
  asOf: at,
  policies: z.strictObject({
    trading: digest,
    strategy: digest,
    theme: digest,
  }),
  source: z.strictObject({
    id: digest,
    observedAt: at,
    metrics: z.strictObject({
      decisions: count,
      approved: count,
      closedTrades: count,
    }),
  }),
  evidence: z.strictObject({
    runHash: digest,
    exportHash: digest,
    stateHash: digest,
    auditHead: digest,
    revision: count,
    snapshotAsOf: at,
  }),
  summary: recordSummarySchema,
  records: z.array(recordDetailSchema).min(1).max(100),
  operatingCostAllocation: z.enum(["NO_EVENTS_SYNTHETIC_ONLY", "UNRESOLVED"]),
  caveats: z.literal(
    "SYNTHETIC_RECORDED_FEES_NOT_REAL_TOTAL_COST_OR_ACCOUNT_PERFORMANCE",
  ),
});
export type RecordBundle = z.infer<typeof recordBundleSchema>;
export interface RecordSourceInfo {
  sourceId: string;
  runHash: string;
  from: string;
  to: string;
  decisions: number;
  fillEvents: number;
  revision: number;
}
