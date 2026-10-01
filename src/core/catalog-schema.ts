import { z } from "zod";

// 자료 형식/자원 상한이다. 매매 기준이나 시장 감시 목록 한도가 아니다.
export const MAX_CATALOG_RECORDS = 50_000;
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);
const symbol = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9._-]+$/);
const timestamp = z.iso
  .datetime({ offset: true })
  // 밀리초보다 작은 미래 시각을 잘라서 과거 입력으로 바꾸지 않는다.
  .refine((value) => !/\.\d{4}/.test(value), "MILLISECOND_PRECISION_REQUIRED")
  .transform((value) => new Date(value).toISOString());
const recordSchema = z
  .object({
    instrumentId: identifier,
    market: z.enum(["KR", "US", "UNKNOWN"]),
    venue: identifier.transform((value) => value.toUpperCase()).nullable(),
    symbol,
    currency: z.enum(["KRW", "USD", "UNKNOWN"]),
    kind: z.enum(["STOCK", "ETF", "OTHER", "UNKNOWN"]),
    underlying: z.enum(["SINGLE_STOCK", "INDEX", "UNKNOWN"]),
    leveraged: z.boolean().nullable(),
    requiredDepositKrw: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    listingStatus: z.enum(["LISTED", "HALTED", "DELISTED", "UNKNOWN"]),
    brokerSupported: z.boolean().nullable(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    observedAt: timestamp,
    receivedAt: timestamp,
    availableAt: timestamp,
    effectiveAt: timestamp,
  })
  .strict()
  .refine(
    (record) =>
      Date.parse(record.observedAt) <= Date.parse(record.receivedAt) &&
      Date.parse(record.receivedAt) <= Date.parse(record.availableAt),
    { message: "INVALID_SOURCE_CHRONOLOGY" },
  );

export const catalogSchema = z
  .object({
    schemaVersion: z.literal("OFFLINE_CATALOG_V1"),
    purpose: z.literal("TEST_ONLY"),
    sourceId: identifier,
    asOf: timestamp,
    // 사용자가 명시한 합성 자료 신선도 가정. 실제 시장 승인값으로 승계하지 않는다.
    metadataMaxAgeMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    records: z.array(recordSchema).max(MAX_CATALOG_RECORDS),
  })
  .strict();

export type CatalogRecord = z.infer<typeof recordSchema>;
// 별도 TEST_ONLY 보강 계약에서도 동일한 형식/정규화 경계를 재사용한다.
export {
  identifier as catalogIdentifierSchema,
  symbol as catalogSymbolSchema,
  timestamp as catalogTimestampSchema,
  recordSchema as catalogRecordSchema,
};
export type CatalogInput = z.infer<typeof catalogSchema>;
export class CatalogError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CatalogError";
  }
}
export function parseCatalog(input: unknown): CatalogInput {
  const parsed = catalogSchema.safeParse(input);
  if (!parsed.success) throw new CatalogError("CATALOG_INPUT_INVALID");
  return parsed.data;
}
