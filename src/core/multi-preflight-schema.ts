import { z } from "zod";
import {
  CatalogError,
  catalogIdentifierSchema as id,
  catalogTimestampSchema as time,
} from "./catalog-schema.js";
import { enrichmentSchema } from "./catalog-enrichment-schema.js";
import { marketQualitySchema } from "./market-quality-schema.js";

const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
export const preflightBindingSchema = z.strictObject({
  assetKey: id,
  market: z.enum(["KR", "US", "UNKNOWN"]),
  instrumentId: id,
  baseRecordHash: digest,
  enrichedItemHash: digest,
  qualityAssetHash: digest,
});
export const multiPreflightSchema = z.strictObject({
  schemaVersion: z.literal("OFFLINE_MULTI_PREFLIGHT_V1"),
  purpose: z.literal("TEST_ONLY"),
  asOf: time,
  enrichment: enrichmentSchema,
  market: marketQualitySchema.nullable(),
  // 최대 64개 품질 대상의 연결/상충을 진단하기 위한 자원 상한이다.
  bindings: z.array(preflightBindingSchema).max(128),
});
export type PreflightInput = z.infer<typeof multiPreflightSchema>;
export type PreflightBinding = z.infer<typeof preflightBindingSchema>;
export function parseMultiPreflight(raw: unknown): PreflightInput {
  const parsed = multiPreflightSchema.safeParse(raw);
  if (!parsed.success) throw new CatalogError("MULTI_PREFLIGHT_INPUT_INVALID");
  const input = parsed.data;
  // 다른 시점의 스냅샷을 조용히 다시 날짜 지정하거나 미래 목록으로 평가하지 않는다.
  if (
    input.asOf !== input.enrichment.catalog.asOf ||
    (input.market !== null && input.asOf !== input.market.asOf)
  )
    throw new CatalogError("MULTI_PREFLIGHT_AS_OF_MISMATCH");
  return input;
}
