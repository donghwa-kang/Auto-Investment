import { z } from "zod";
import { Decimal } from "decimal.js";
import { tossCatalogMarkets } from "./toss-catalog.js";

// 수신 형식 연구용 자원 상한이다. 매매 기준/실제 공급원 승인값이 아니다.
export const INGEST_SPEC_VERSION = "1.2.17";
export const MAX_INGEST_BYTES = 16 * 1024 * 1024;
export const MAX_INGEST_ROWS = 10_000;
export const minuteMs = 60_000;
const number = Decimal.clone({ precision: 40 });
export const dec = (value: string) => new number(value);
export class IngestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const sourceTime = z.iso
  .datetime({ offset: true })
  .refine((s) => !/\.\d{4}/.test(s), "MILLISECOND_PRECISION_REQUIRED");
export const utc = (s: string) => new Date(s).toISOString();
const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);
export const symbol = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9.-]+$/);
const currency = z.enum(["KRW", "USD"]);
const market = z.enum(["KR", "US"]);
const target = z
  .object({ symbol, market, currency })
  .strict()
  .refine((t) => (t.market === "KR") === (t.currency === "KRW"));
const targets = z
  .array(target)
  .min(1)
  .max(200)
  .refine((ts) => new Set(ts.map((t) => t.symbol)).size === ts.length);
export const candleRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("STOCK_CANDLES"),
      target,
      interval: z.literal("1m"),
      adjusted: z.literal(false),
      count: z.number().int().min(1).max(200),
      before: sourceTime.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("INDICATOR_CANDLES"),
      symbol: z.enum(["KOSPI", "KOSDAQ"]),
      interval: z.literal("1m"),
      count: z.number().int().min(1).max(200),
      before: sourceTime.nullable(),
    })
    .strict(),
]);
export const sourceRequestSchema = z.union([
  candleRequestSchema,
  z
    .object({
      kind: z.literal("LISTING"),
      market: z.enum(tossCatalogMarkets),
      status: z.literal("ACTIVE"),
    })
    .strict(),
  z.object({ kind: z.literal("DETAIL"), targets }).strict(),
  z.object({ kind: z.literal("PRICES"), targets }).strict(),
  z.object({ kind: z.literal("ORDERBOOK"), target }).strict(),
  z.object({ kind: z.literal("CALENDAR_KR"), date: z.iso.date() }).strict(),
  z.object({ kind: z.literal("CALENDAR_US"), date: z.iso.date() }).strict(),
]);
export const captureSchema = z
  .object({
    captureId: id,
    request: sourceRequestSchema,
    requestedAt: sourceTime,
    receivedAt: sourceTime,
    availableAt: sourceTime,
    outcome: z.enum(["RESPONSE", "TIMEOUT"]),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    response: z.unknown(),
  })
  .strict()
  .refine(
    (c) =>
      Date.parse(c.requestedAt) <= Date.parse(c.receivedAt) &&
      Date.parse(c.receivedAt) <= Date.parse(c.availableAt),
  )
  .refine((c) =>
    c.outcome === "TIMEOUT"
      ? c.httpStatus === null && c.response === null
      : c.httpStatus !== null,
  );
export const pagePlanSchema = z
  .object({
    planId: id,
    request: candleRequestSchema,
    windowFrom: sourceTime,
    windowTo: sourceTime,
    maxPages: z.number().int().min(1).max(50),
    replies: z.array(captureSchema).max(50),
  })
  .strict()
  .refine((p) => {
    const start = Date.parse(p.windowFrom),
      end = Date.parse(p.windowTo);
    return (
      end > start &&
      start % minuteMs === 0 &&
      end % minuteMs === 0 &&
      (end - start) / minuteMs <= MAX_INGEST_ROWS
    );
  });
export const sourceIngestSchema = z
  .object({
    schemaVersion: z.literal("OFFLINE_SOURCE_INGEST_V1"),
    purpose: z.literal("MOCK_CONTRACT"),
    dataOrigin: z.literal("MOCK_RESPONSE"),
    source: z.literal("TOSS_REST"),
    sourceSpecVersion: z.literal(INGEST_SPEC_VERSION),
    asOf: sourceTime,
    captures: z.array(captureSchema).max(100),
    pagePlans: z.array(pagePlanSchema).max(5),
  })
  .strict()
  .refine((v) => v.captures.length + v.pagePlans.length > 0)
  .refine(
    (v) =>
      new Set(v.pagePlans.map((p) => p.planId)).size === v.pagePlans.length,
  )
  .refine((v) => {
    const ids = [...v.captures, ...v.pagePlans.flatMap((p) => p.replies)].map(
      (c) => c.captureId,
    );
    return new Set(ids).size === ids.length;
  });
export type SourceRequest = z.infer<typeof sourceRequestSchema>;
export type CandleRequest = z.infer<typeof candleRequestSchema>;
export type SourceCapture = z.infer<typeof captureSchema>;
export type PagePlan = z.infer<typeof pagePlanSchema>;
export type SourceInput = z.infer<typeof sourceIngestSchema>;

const decimal = z
  .string()
  .max(30)
  .regex(/^-?\d{1,18}(\.\d{1,12})?$/)
  .transform((s) => dec(s).toFixed());
const name = z
  .string()
  .min(1)
  .max(300)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s));
const securityType = z.enum([
  "STOCK",
  "FOREIGN_STOCK",
  "DEPOSITARY_RECEIPT",
  "INFRASTRUCTURE_FUND",
  "REIT",
  "ETF",
  "FOREIGN_ETF",
  "ETN",
  "STOCK_WARRANTS",
]);
export const listingRow = z
  .object({
    symbol,
    name,
    securityType,
    isCommonShare: z.boolean(),
    isinCode: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/),
  })
  .strict();
export const detailRow = listingRow
  .extend({
    englishName: name,
    market: z.enum(tossCatalogMarkets),
    status: z.enum(["SCHEDULED", "ACTIVE", "DELISTED"]),
    currency,
    sharesOutstanding: decimal,
    listDate: z.iso.date().nullish(),
    delistDate: z.iso.date().nullish(),
    leverageFactor: decimal.nullish(),
    koreanMarketDetail: z
      .object({
        liquidationTrading: z.boolean(),
        nxtSupported: z.boolean(),
        krxTradingSuspended: z.boolean(),
        nxtTradingSuspended: z.boolean().nullish(),
      })
      .strict()
      .nullish(),
  })
  .strict();
export const priceRow = z
  .object({
    symbol,
    timestamp: sourceTime.nullish(),
    lastPrice: decimal,
    currency,
  })
  .strict();
export const bookRow = z
  .object({
    timestamp: sourceTime.nullish(),
    currency,
    asks: z
      .array(z.object({ price: decimal, volume: decimal }).strict())
      .max(100),
    bids: z
      .array(z.object({ price: decimal, volume: decimal }).strict())
      .max(100),
  })
  .strict();
export const indicatorBar = z
  .object({
    timestamp: sourceTime,
    openPrice: decimal,
    highPrice: decimal,
    lowPrice: decimal,
    closePrice: decimal,
    volume: decimal,
  })
  .strict();
export const stockBar = indicatorBar.extend({ currency }).strict();
export const pageEnvelope = z
  .object({
    result: z
      .object({
        candles: z.array(z.unknown()).max(200),
        nextBefore: sourceTime.nullish(),
      })
      .strict(),
  })
  .strict();
export const arrayEnvelope = z
  .object({ result: z.array(z.unknown()).max(MAX_INGEST_ROWS) })
  .strict();
export const singleEnvelope = z.object({ result: z.unknown() }).strict();
const session = z
  .object({ startTime: sourceTime, endTime: sourceTime })
  .strict();
const krStartSession = session
  .extend({ singlePriceAuctionStartTime: sourceTime.nullish() })
  .strict();
const krEndSession = session
  .extend({ singlePriceAuctionEndTime: sourceTime.nullish() })
  .strict();
export const krDay = z
  .object({
    date: z.iso.date(),
    integrated: z
      .object({
        preMarket: krStartSession.nullish(),
        regularMarket: krStartSession.nullish(),
        afterMarket: krEndSession.nullish(),
      })
      .strict()
      .nullish(),
  })
  .strict();
export const usDay = z
  .object({
    date: z.iso.date(),
    dayMarket: session.nullish(),
    preMarket: session.nullish(),
    regularMarket: session.nullish(),
    afterMarket: session.nullish(),
  })
  .strict();
export const krCalendar = z
  .object({ today: krDay, previousBusinessDay: krDay, nextBusinessDay: krDay })
  .strict();
export const usCalendar = z
  .object({ today: usDay, previousBusinessDay: usDay, nextBusinessDay: usDay })
  .strict();

export function parseSourceInput(raw: unknown): SourceInput {
  try {
    const json = JSON.stringify(raw);
    if (!json || Buffer.byteLength(json) > MAX_INGEST_BYTES) throw new Error();
    // 알 수 없는 키/인증 값이 결과에 복제되는 것을 막는다. 일반 필드에 숨긴 모든 비밀값 탐지는 아니다.
    if (
      /"(?:__proto__|constructor|prototype|authorization|access_token|client_secret|client_id|api_key|headers)"\s*:/i.test(
        json,
      )
    )
      throw new Error();
    return sourceIngestSchema.parse(raw);
  } catch {
    throw new IngestError("INGEST_INPUT_INVALID");
  }
}
