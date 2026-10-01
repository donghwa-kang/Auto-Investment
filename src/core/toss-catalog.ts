import { z } from "zod";
import { classifyCatalogFacts, type CatalogFacts } from "./catalog.js";
import { CatalogError, MAX_CATALOG_RECORDS } from "./catalog-schema.js";
import { hash } from "./policy.js";

export const tossCatalogMarkets = [
  "KOSPI",
  "KOSDAQ",
  "NYSE",
  "NASDAQ",
  "AMEX",
  "KR_ETC",
  "US_ETC",
] as const;
export type TossCatalogMarket = (typeof tossCatalogMarkets)[number];
export const tossCatalogMarketSchema = z.enum(tossCatalogMarkets);
const text = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v));
export const listedStockSchema = z.object({
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .min(1)
    .max(32)
    .regex(/^[A-Z0-9._-]+$/),
  name: text,
  securityType: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Z_]+$/),
  isCommonShare: z.boolean(),
  isinCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/),
});
export type ListedStock = z.infer<typeof listedStockSchema>;
const envelope = z.object({
  result: z.array(z.unknown()).max(MAX_CATALOG_RECORDS),
});
const supportedTypes = new Map<string, CatalogFacts["kind"]>([
  ["STOCK", "STOCK"],
  ["FOREIGN_STOCK", "STOCK"],
  ["ETF", "ETF"],
  ["FOREIGN_ETF", "ETF"],
  // REIT/DR/기금의 기존 주식 범위 편입 여부는 별도 상품 프로필로 결정한다.
  ["ETN", "OTHER"],
  ["STOCK_WARRANTS", "OTHER"],
]);

export function parseTossListing(raw: unknown) {
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) throw new CatalogError("TOSS_CATALOG_ENVELOPE_INVALID");
  const records: ListedStock[] = [];
  const quarantined: { index: number; reason: "INVALID_LISTED_STOCK" }[] = [];
  parsed.data.result.forEach((row, index) => {
    const result = listedStockSchema.safeParse(row);
    if (result.success) records.push(result.data);
    else quarantined.push({ index, reason: "INVALID_LISTED_STOCK" });
  });
  // 알 수 없는 필드/잘못된 행 원문은 출력하지 않는다. 응답 원본은 수집기에서 해시만 보존한다.
  return { inputRecords: parsed.data.result.length, records, quarantined };
}

export function classifyTossListing(raw: unknown, market: TossCatalogMarket) {
  if (!tossCatalogMarketSchema.safeParse(market).success)
    throw new CatalogError("TOSS_CATALOG_MARKET_INVALID");
  const parsed = parseTossListing(raw);
  const groups = new Map<string, Map<string, ListedStock>>();
  const claims = new Map<string, Set<string>>();
  let duplicates = 0;
  for (const record of parsed.records) {
    const key = `${market}:${record.isinCode}`;
    const variants = groups.get(key) ?? new Map<string, ListedStock>();
    const fingerprint = hash(record);
    if (variants.has(fingerprint)) duplicates++;
    variants.set(fingerprint, record);
    groups.set(key, variants);
    const owners = claims.get(record.symbol) ?? new Set<string>();
    owners.add(key);
    claims.set(record.symbol, owners);
  }
  const collisions = new Set(
    [...claims.values()].filter((v) => v.size > 1).flatMap((v) => [...v]),
  );
  const items = [...groups]
    .map(([key, variants]) => {
      const record =
        variants.size === 1 ? variants.values().next().value! : null;
      const facts: CatalogFacts = {
        market: ["KOSPI", "KOSDAQ", "KR_ETC"].includes(market) ? "KR" : "US",
        // 시장 세그먼트는 체결 거래소가 아니다. ACTIVE 목록은 거래정지 여부의 증거가 아니다.
        venue: null,
        currency: "UNKNOWN",
        listingStatus: "UNKNOWN",
        kind: record
          ? (supportedTypes.get(record.securityType) ?? "UNKNOWN")
          : "UNKNOWN",
        underlying: "UNKNOWN",
        leveraged: null,
        requiredDepositKrw: null,
        brokerSupported: true,
      };
      const classified = classifyCatalogFacts(facts);
      const reasons: string[] = [...classified.reasons, "SOURCE_TIME_UNKNOWN"];
      if (!record) reasons.push("RECORD_CONFLICT");
      if (collisions.has(key)) reasons.push("SYMBOL_COLLISION");
      return {
        key,
        record,
        facts,
        recordHash: record ? hash(record) : null,
        identityBasis: "SOURCE_ISIN_UNVERIFIED" as const,
        status: "REVIEW_REQUIRED" as const,
        reasons: [...new Set(reasons)].sort(),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    market,
    inputRecords: parsed.inputRecords,
    duplicates,
    quarantined: parsed.quarantined,
    items,
    classificationHash: hash({ market, items }),
  };
}
