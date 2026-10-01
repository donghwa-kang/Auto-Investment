import { z } from "zod";
import { catalogReasons } from "../core/catalog.js";
import { CatalogError, MAX_CATALOG_RECORDS } from "../core/catalog-schema.js";
import { hash, policyHash } from "../core/policy.js";
import { researchScope } from "../core/research-scope.js";
import {
  classifyTossListing,
  listedStockSchema,
  tossCatalogMarkets,
  tossCatalogMarketSchema,
} from "../core/toss-catalog.js";

export const cacheDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const cacheTimeSchema = z.iso.datetime({ precision: 3 });
const count = z.number().int().min(0).max(MAX_CATALOG_RECORDS);
const batchSchema = z
  .object({
    market: tossCatalogMarketSchema,
    inputRecords: count,
    duplicates: count,
    quarantined: z.array(z.never()).length(0),
    items: z
      .array(z.object({ record: listedStockSchema.strict() }).passthrough())
      .max(MAX_CATALOG_RECORDS),
    classificationHash: cacheDigestSchema,
  })
  .strict();
const auditSchema = z.strictObject({
  operation: z.enum(["TOKEN", "LIST"]),
  market: tossCatalogMarketSchema.nullable(),
  status: z.literal(200),
  requestedAt: cacheTimeSchema,
  receivedAt: cacheTimeSchema,
  responseHash: cacheDigestSchema.nullable(),
  rateLimit: z.number().nonnegative().max(1e9).nullable(),
  retryAfter: z.number().nonnegative().max(1e9).nullable(),
});
const reportSchema = z.strictObject({
  schemaVersion: z.literal("TOSS_CATALOG_SNAPSHOT_V1"),
  purpose: z.literal("REAL_REFERENCE_SNAPSHOT"),
  source: z.literal("https://openapi.tossinvest.com/api/v1/stocks/all"),
  sourceContractCheckedOn: z.literal("2026-09-12"),
  startedAt: cacheTimeSchema,
  completedAt: cacheTimeSchema,
  sourceUpdatedAt: z.null(),
  sourceEffectiveAt: z.null(),
  sourceRevision: z.null(),
  timestampBasis: z.literal("LOCAL_REQUEST_RECEIPT_ONLY"),
  historicalUniverseReady: z.literal(false),
  requestedStatus: z.literal("ACTIVE"),
  securityTypeFilter: z.null(),
  commonShareFilter: z.null(),
  universeScope: z.literal("TOSS_SUPPORTED_ACTIVE_CATALOG_NOT_ENTIRE_EXCHANGE"),
  allScopesReceived: z.literal(true),
  dataQualityComplete: z.literal(true),
  metadataReady: z.literal(false),
  freshForTrading: z.literal(false),
  selectionPerformed: z.literal(false),
  strategyEvaluated: z.literal(false),
  ordersEnabled: z.literal(false),
  liveEnabled: z.literal(false),
  ordering: z.literal("MARKET_THEN_CANONICAL_ISIN_NOT_INVESTMENT_RANK"),
  policyHash: z.literal(policyHash),
  researchScopeHash: z.literal(hash(researchScope)),
  counts: z.strictObject({
    inputRecords: count,
    instruments: count,
    duplicates: count,
    quarantined: z.literal(0),
    candidates: z.literal(0),
    reviewRequired: count,
  }),
  pendingChecks: z.tuple([
    z.literal("SOURCE_FRESHNESS"),
    z.literal("PRODUCT_IDENTITY_AND_STRUCTURE"),
    z.literal("CURRENCY_VENUE_TRADING_STATUS"),
    z.literal("PRODUCT_AND_STRATEGY_PROFILES"),
    z.literal("LIQUIDITY_PRICE_NEWS_RESEARCH"),
  ]),
  failure: z.null(),
  scopes: z
    .array(
      z.strictObject({
        market: tossCatalogMarketSchema,
        status: z.enum(["RECEIVED", "RECEIVED_EMPTY"]),
        receivedAt: cacheTimeSchema,
        error: z.null(),
        batch: batchSchema,
      }),
    )
    .length(tossCatalogMarkets.length),
  requests: z.array(auditSchema).length(8),
  reportHash: cacheDigestSchema,
  reasonDescriptions: z.record(z.string(), z.string()),
});

export const sourceTimeReason =
  "원천 갱신·효력 시점이 없어 최신성/과거 모집단 사용을 승인하지 않습니다.";

// 체크섬만 신뢰하지 않는다. 저장된 승인/분류를 현재 순수 분류기로 재계산한다.
// 이는 손상·계약 위반 검사이며, 로컬 파일의 토스 원천 진위를 증명하는 서명은 아니다.
export function validateCachedCatalog(raw: unknown) {
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) throw new CatalogError("CATALOG_CACHE_INVALID");
  const { reportHash, reasonDescriptions, ...report } = parsed.data;
  const require = (condition: boolean) => {
    if (!condition) throw new CatalogError("CATALOG_CACHE_INVALID");
  };
  require(hash(report) === reportHash);
  require(
    hash(reasonDescriptions) ===
      hash({ ...catalogReasons, SOURCE_TIME_UNKNOWN: sourceTimeReason }),
  );
  require(report.startedAt <= report.completedAt);
  let inputRecords = 0,
    instruments = 0,
    duplicates = 0;
  for (const [index, scope] of report.scopes.entries()) {
    require(scope.market === tossCatalogMarkets[index]);
    require(scope.batch.market === scope.market);
    const recomputed = classifyTossListing(
      { result: scope.batch.items.map((item) => item.record) },
      scope.market,
    );
    require(recomputed.duplicates === 0 && recomputed.quarantined.length === 0);
    require(
      recomputed.items.every(
        (item) =>
          item.record !== null && !item.reasons.includes("SYMBOL_COLLISION"),
      ),
    );
    require(
      scope.batch.inputRecords ===
        recomputed.inputRecords + scope.batch.duplicates,
    );
    require(scope.batch.inputRecords !== 0 || scope.batch.duplicates === 0);
    require(recomputed.inputRecords !== 0 || scope.batch.inputRecords === 0);
    require(
      scope.status ===
        (scope.batch.inputRecords ? "RECEIVED" : "RECEIVED_EMPTY"),
    );
    require(
      hash(scope.batch) ===
        hash({
          ...recomputed,
          inputRecords: scope.batch.inputRecords,
          duplicates: scope.batch.duplicates,
        }),
    );
    const request = report.requests[index + 1]!;
    require(request.operation === "LIST" && request.market === scope.market);
    require(
      request.responseHash !== null && request.receivedAt === scope.receivedAt,
    );
    inputRecords += scope.batch.inputRecords;
    instruments += recomputed.items.length;
    duplicates += scope.batch.duplicates;
  }
  require(
    hash(report.counts) ===
      hash({
        inputRecords,
        instruments,
        duplicates,
        quarantined: 0,
        candidates: 0,
        reviewRequired: instruments,
      }),
  );
  const token = report.requests[0]!;
  require(
    token.operation === "TOKEN" &&
      token.market === null &&
      token.responseHash === null,
  );
  let previous = report.startedAt;
  for (const request of report.requests) {
    require(
      previous <= request.requestedAt &&
        request.requestedAt <= request.receivedAt &&
        request.receivedAt <= report.completedAt,
    );
    previous = request.receivedAt;
  }
  return {
    counts: report.counts,
    reportHash,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
  };
}
