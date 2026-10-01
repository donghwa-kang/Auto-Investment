import { z } from "zod";
import {
  catalogSchema,
  catalogRecordSchema,
  catalogIdentifierSchema,
  catalogSymbolSchema,
  catalogTimestampSchema,
  CatalogError,
} from "./catalog-schema.js";

export const enrichmentFields = [
  "venue",
  "currency",
  "kind",
  "underlying",
  "leveraged",
  "requiredDepositKrw",
  "listingStatus",
  "brokerSupported",
] as const;
export type EnrichmentField = (typeof enrichmentFields)[number];
// 파일 자원 제한이다. 실제 출처의 신뢰도·유효기간·투자 한도를 정하는 값이 아니다.
export const MAX_ENRICHMENT_EVIDENCE = 50000;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const fields = catalogRecordSchema.shape;
const common = {
  evidenceId: catalogIdentifierSchema,
  sourceId: catalogIdentifierSchema,
  sourceDocumentId: catalogIdentifierSchema,
  sourceDocumentHash: digest,
  subject: z.strictObject({
    market: fields.market,
    instrumentId: fields.instrumentId,
    symbol: catalogSymbolSchema,
    baseRecordHash: digest,
  }),
  revision: positive,
  observedAt: catalogTimestampSchema,
  receivedAt: catalogTimestampSchema,
  availableAt: catalogTimestampSchema,
  effectiveAt: catalogTimestampSchema,
};
const evidenceSchema = z
  .discriminatedUnion("field", [
    z.strictObject({
      ...common,
      field: z.literal("venue"),
      value: fields.venue,
    }),
    z.strictObject({
      ...common,
      field: z.literal("currency"),
      value: fields.currency,
    }),
    z.strictObject({ ...common, field: z.literal("kind"), value: fields.kind }),
    z.strictObject({
      ...common,
      field: z.literal("underlying"),
      value: fields.underlying,
    }),
    z.strictObject({
      ...common,
      field: z.literal("leveraged"),
      value: fields.leveraged,
    }),
    z.strictObject({
      ...common,
      field: z.literal("requiredDepositKrw"),
      value: fields.requiredDepositKrw,
    }),
    z.strictObject({
      ...common,
      field: z.literal("listingStatus"),
      value: fields.listingStatus,
    }),
    z.strictObject({
      ...common,
      field: z.literal("brokerSupported"),
      value: fields.brokerSupported,
    }),
  ])
  .refine(
    (e) => e.observedAt <= e.receivedAt && e.receivedAt <= e.availableAt,
    { message: "INVALID_EVIDENCE_CHRONOLOGY" },
  );

export const enrichmentSchema = z.strictObject({
  schemaVersion: z.literal("OFFLINE_CATALOG_ENRICHMENT_V1"),
  purpose: z.literal("TEST_ONLY"),
  catalog: catalogSchema,
  // 테스트에 명시적으로 등록한 출처별 사용 범위다. 외부 출처 인증 기능이 아니다.
  sources: z
    .array(
      z.strictObject({
        sourceId: catalogIdentifierSchema,
        purpose: z.literal("TEST_ONLY"),
        allowedFields: z
          .array(z.enum(enrichmentFields))
          .min(1)
          .max(enrichmentFields.length)
          .refine((v) => new Set(v).size === v.length),
        metadataMaxAgeMs: positive,
      }),
    )
    .max(64)
    .refine((v) => new Set(v.map((s) => s.sourceId)).size === v.length),
  evidence: z.array(evidenceSchema).max(MAX_ENRICHMENT_EVIDENCE),
});
export type EnrichmentInput = z.infer<typeof enrichmentSchema>;
export type MetadataEvidence = z.infer<typeof evidenceSchema>;
export function parseEnrichment(raw: unknown): EnrichmentInput {
  const parsed = enrichmentSchema.safeParse(raw);
  if (!parsed.success)
    throw new CatalogError("CATALOG_ENRICHMENT_INPUT_INVALID");
  return parsed.data;
}
