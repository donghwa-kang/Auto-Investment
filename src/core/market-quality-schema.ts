import { z } from "zod";
import { d } from "./math.js";
import {
  CatalogError,
  catalogIdentifierSchema as id,
  catalogSymbolSchema as symbol,
  catalogTimestampSchema as time,
} from "./catalog-schema.js";

// 처리량/정밀도 상한이며 투자 한도나 실제 공급원 승인 조건이 아니다.
export const MAX_QUALITY_RECORDS = 50_000;
export const MAX_QUALITY_SLOTS = 50_000;
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const decimal = z
  .string()
  .max(32)
  .regex(/^-?\d{1,18}(\.\d{1,12})?$/)
  .transform((value) => d(value).toFixed());
export const qualityIdentitySchema = z
  .object({
    instrumentId: id,
    market: z.enum(["KR", "US"]),
    symbol,
    venue: id.transform((value) => value.toUpperCase()),
    currency: z.enum(["KRW", "USD"]),
  })
  .strict();
const common = {
  recordId: id,
  assetKey: id,
  sourceId: id,
  identity: qualityIdentitySchema,
  revision: integer,
  observedAt: time,
  receivedAt: time,
  availableAt: time,
};
const record = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...common,
        kind: z.literal("BAR"),
        sessionId: id,
        openAt: time,
        closeAt: time,
        basis: z.enum(["RAW", "ADJUSTED", "UNKNOWN"]),
        completed: z.boolean(),
        halted: z.boolean().nullable(),
        o: decimal.nullable(),
        h: decimal.nullable(),
        l: decimal.nullable(),
        c: decimal.nullable(),
        v: decimal.nullable(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("PRICE"),
        price: decimal.nullable(),
        basis: z.enum(["RAW", "ADJUSTED", "UNKNOWN"]),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("QUOTE"),
        basis: z.enum(["RAW", "ADJUSTED", "UNKNOWN"]),
        bid: decimal.nullable(),
        ask: decimal.nullable(),
        bidSize: decimal.nullable(),
        askSize: decimal.nullable(),
      })
      .strict(),
  ])
  .refine(
    (row) =>
      Date.parse(row.observedAt) <= Date.parse(row.receivedAt) &&
      Date.parse(row.receivedAt) <= Date.parse(row.availableAt),
    "SOURCE_TIME_ORDER",
  );

const asset = z
  .object({
    assetKey: id,
    identity: qualityIdentitySchema,
    role: z.enum(["INSTRUMENT", "BENCHMARK"]),
    sourceId: id.nullable(),
    benchmarkKey: id.nullable(),
    // 외부 검증된 달력/기업행동이 아닌 명시적인 시험 계약이다.
    session: z
      .object({
        sessionId: id,
        openAt: time,
        closeAt: time,
        availableAt: time,
      })
      .strict()
      .nullable(),
    windowFrom: time,
    windowTo: time,
    actionContext: z
      .object({
        status: z.enum([
          "NO_ACTIONS_IN_WINDOW",
          "ADJUSTMENT_REQUIRED",
          "UNKNOWN",
        ]),
        availableAt: time,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const marketQualitySchema = z
  .object({
    schemaVersion: z.literal("OFFLINE_MARKET_QUALITY_V1"),
    purpose: z.literal("TEST_ONLY"),
    asOf: time,
    profile: z
      .object({
        profileId: id,
        purpose: z.literal("TEST_ONLY"),
        lastPriceMaxAgeMs: integer.nullable(),
        windowEndMaxAgeMs: integer.nullable(),
      })
      .strict(),
    sources: z
      .array(
        z
          .object({
            sourceId: id,
            kinds: z
              .array(z.enum(["BAR", "PRICE", "QUOTE"]))
              .min(1)
              .max(3)
              .refine((values) => new Set(values).size === values.length),
          })
          .strict(),
      )
      .max(64),
    assets: z.array(asset).min(1).max(64),
    records: z.array(record).max(MAX_QUALITY_RECORDS),
  })
  .strict()
  .superRefine((input, ctx) => {
    for (const keys of [
      input.sources.map((x) => x.sourceId),
      input.assets.map((x) => x.assetKey),
    ])
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: "custom", message: "DUPLICATE_CONTRACT_KEY" });
    const slots = input.assets.reduce(
      (total, item) =>
        total +
        Math.max(
          0,
          Math.ceil(
            (Date.parse(item.windowTo) - Date.parse(item.windowFrom)) / 60000,
          ),
        ),
      0,
    );
    if (slots > MAX_QUALITY_SLOTS)
      ctx.addIssue({ code: "custom", message: "WINDOW_RESOURCE_LIMIT" });
  });
export type QualityInput = z.infer<typeof marketQualitySchema>;
export type QualityRecord = QualityInput["records"][number];
export type QualityAsset = QualityInput["assets"][number];
export function parseMarketQuality(raw: unknown): QualityInput {
  const parsed = marketQualitySchema.safeParse(raw);
  if (!parsed.success) throw new CatalogError("MARKET_QUALITY_INPUT_INVALID");
  return parsed.data;
}
