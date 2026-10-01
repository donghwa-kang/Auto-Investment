import { parseCatalog, type CatalogRecord } from "./catalog-schema.js";
import { hash, policyHash } from "./policy.js";
import { researchAdmission, researchScope } from "./research-scope.js";

export const catalogReasons = {
  METADATA_CLEAR: "메타데이터 범위의 검토 후보입니다. 거래 승인이 아닙니다.",
  RECORD_CONFLICT: "같은 종목의 최신 동일 버전 자료가 상충합니다.",
  SYMBOL_COLLISION: "같은 시장·거래소·심볼에 서로 다른 종목 ID가 있습니다.",
  METADATA_STALE: "명시된 시험 자료 유효기간을 초과했습니다.",
  MARKET_UNKNOWN: "시장이 확인되지 않았습니다.",
  VENUE_UNKNOWN: "거래소 식별 정보가 없습니다.",
  CURRENCY_UNKNOWN: "통화가 확인되지 않았습니다.",
  CURRENCY_MARKET_MISMATCH: "시장과 결제 통화가 계약에 맞지 않습니다.",
  KIND_UNKNOWN: "상품 종류가 확인되지 않았습니다.",
  UNSUPPORTED_PRODUCT: "현재 주식·ETF 검토 범위 밖의 상품입니다.",
  LISTING_UNKNOWN: "상장·거래 상태가 확인되지 않았습니다.",
  NOT_ACTIVE_LISTING: "거래정지 또는 상장폐지 상태로 신규 후보에서 제외합니다.",
  BROKER_SUPPORT_UNKNOWN: "공급 자료의 브로커 지원 여부가 확인되지 않았습니다.",
  BROKER_UNSUPPORTED: "공급 자료에서 브로커 미지원으로 표시됐습니다.",
  LEVERAGE_UNKNOWN: "레버리지 여부가 확인되지 않았습니다.",
  UNDERLYING_UNKNOWN: "기초자산 분류가 확인되지 않았습니다.",
  PRODUCT_FIELDS_CONFLICT: "보통주 상품과 기초자산·레버리지 분류가 상충합니다.",
  DEPOSIT_UNKNOWN: "단일종목 레버리지의 요구 예탁금 정보가 없습니다.",
  USER_EXCLUDED_SINGLE_STOCK_LEVERAGE:
    "사용자가 제외한 3천만 원 이상 예탁금 단일종목 레버리지입니다.",
} as const;
export type CatalogReason = keyof typeof catalogReasons;
export type CatalogStatus = "REVIEW_CANDIDATE" | "EXCLUDED" | "REVIEW_REQUIRED";
export interface CatalogItem {
  key: string;
  record: CatalogRecord | null;
  recordHash: string | null;
  status: CatalogStatus;
  reasons: CatalogReason[];
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (record: CatalogRecord) =>
  `${record.market}:${record.instrumentId}`;

export type CatalogFacts = Pick<
  CatalogRecord,
  | "market"
  | "venue"
  | "currency"
  | "kind"
  | "underlying"
  | "leveraged"
  | "requiredDepositKrw"
  | "listingStatus"
  | "brokerSupported"
>;

// 시점 계약은 각 자료 어댑터에서 확인한다. 합성/실제 자료에 공통인 사실 분류만 재사용한다.
export function classifyCatalogFacts(record: CatalogFacts): {
  status: CatalogStatus;
  reasons: CatalogReason[];
} {
  const review: CatalogReason[] = [];
  const exclude: CatalogReason[] = [];
  if (record.market === "UNKNOWN") review.push("MARKET_UNKNOWN");
  if (record.venue === null) review.push("VENUE_UNKNOWN");
  if (record.currency === "UNKNOWN") review.push("CURRENCY_UNKNOWN");
  else if (
    (record.market === "KR" && record.currency !== "KRW") ||
    (record.market === "US" && record.currency !== "USD")
  )
    review.push("CURRENCY_MARKET_MISMATCH");
  if (record.kind === "UNKNOWN") review.push("KIND_UNKNOWN");
  if (record.kind === "OTHER") exclude.push("UNSUPPORTED_PRODUCT");
  if (record.listingStatus === "UNKNOWN") review.push("LISTING_UNKNOWN");
  else if (record.listingStatus !== "LISTED")
    exclude.push("NOT_ACTIVE_LISTING");
  if (record.brokerSupported === null) review.push("BROKER_SUPPORT_UNKNOWN");
  else if (!record.brokerSupported) exclude.push("BROKER_UNSUPPORTED");
  if (record.leveraged === null) review.push("LEVERAGE_UNKNOWN");
  if (record.underlying === "UNKNOWN") review.push("UNDERLYING_UNKNOWN");
  if (
    record.kind === "STOCK" &&
    (record.underlying === "INDEX" || record.leveraged === true)
  )
    review.push("PRODUCT_FIELDS_CONFLICT");
  if (
    record.underlying === "SINGLE_STOCK" &&
    record.leveraged === true &&
    record.requiredDepositKrw === null
  )
    review.push("DEPOSIT_UNKNOWN");
  // 기존 후보 분류 계약을 재사용한다. 실계좌 자격은 판정하지 않는다.
  if (
    researchAdmission({
      underlying: record.underlying,
      leveraged: record.leveraged,
      requiredDepositKrw: record.requiredDepositKrw,
    }) === "EXCLUDED_BY_USER"
  )
    exclude.push("USER_EXCLUDED_SINGLE_STOCK_LEVERAGE");
  const reasons = [...new Set([...review, ...exclude])].sort(compare);
  return {
    // 상충/결측 자료를 확정 사실로 취급하지 않되 확실한 제외 사유도 함께 남긴다.
    status: review.length
      ? "REVIEW_REQUIRED"
      : exclude.length
        ? "EXCLUDED"
        : "REVIEW_CANDIDATE",
    reasons: reasons.length ? reasons : ["METADATA_CLEAR"],
  };
}

function classify(
  record: CatalogRecord,
  asOf: string,
  maxAge: number,
): CatalogItem {
  const result = classifyCatalogFacts(record);
  if (Date.parse(asOf) - Date.parse(record.observedAt) > maxAge) {
    result.status = "REVIEW_REQUIRED";
    result.reasons = [
      ...result.reasons.filter((reason) => reason !== "METADATA_CLEAR"),
      "METADATA_STALE",
    ].sort(compare) as CatalogReason[];
  }
  return { key: keyOf(record), record, recordHash: hash(record), ...result };
}

export function classifyCatalog(raw: unknown) {
  const input = parseCatalog(raw);
  const groups = new Map<string, Map<number, Map<string, CatalogRecord>>>();
  let deferredRecords = 0;
  let duplicates = 0;
  for (const record of input.records) {
    // 미래 자료는 종목의 존재 자체도 과거 후보 목록에 추가하지 않는다.
    if (
      Date.parse(record.availableAt) > Date.parse(input.asOf) ||
      Date.parse(record.effectiveAt) > Date.parse(input.asOf)
    ) {
      deferredRecords++;
      continue;
    }
    const key = keyOf(record);
    let versions = groups.get(key);
    if (!versions) {
      versions = new Map();
      groups.set(key, versions);
    }
    let variants = versions.get(record.revision);
    if (!variants) {
      variants = new Map();
      versions.set(record.revision, variants);
    }
    const fingerprint = hash(record);
    if (variants.has(fingerprint)) duplicates++;
    variants.set(fingerprint, record);
  }
  const items: CatalogItem[] = [];
  // 충돌한 최신 버전의 모든 심볼 주장도 보존하여 다른 ID를 잘못 통과시키지 않는다.
  const symbolClaims = new Map<string, Set<string>>();
  for (const [key, versions] of groups) {
    const latest = versions.get(Math.max(...versions.keys()))!;
    for (const record of latest.values()) {
      const symbolKey = JSON.stringify([
        record.market,
        record.venue,
        record.symbol,
      ]);
      let claims = symbolClaims.get(symbolKey);
      if (!claims) {
        claims = new Set();
        symbolClaims.set(symbolKey, claims);
      }
      claims.add(key);
    }
    if (latest.size > 1)
      items.push({
        key,
        record: null,
        recordHash: null,
        status: "REVIEW_REQUIRED",
        reasons: ["RECORD_CONFLICT"],
      });
    else
      items.push(
        classify(
          latest.values().next().value!,
          input.asOf,
          input.metadataMaxAgeMs,
        ),
      );
  }
  const collisions = new Set<string>();
  for (const claims of symbolClaims.values())
    if (claims.size > 1) for (const key of claims) collisions.add(key);
  for (const item of items) {
    if (!collisions.has(item.key)) continue;
    item.status = "REVIEW_REQUIRED";
    item.reasons = [
      ...new Set([
        ...item.reasons.filter((reason) => reason !== "METADATA_CLEAR"),
        "SYMBOL_COLLISION" as const,
      ]),
    ].sort(compare);
  }
  items.sort((a, b) => compare(a.key, b.key));
  const decision = {
    classifierVersion: "OFFLINE_METADATA_V1",
    purpose: input.purpose,
    sourceId: input.sourceId,
    asOf: input.asOf,
    metadataMaxAgeMs: input.metadataMaxAgeMs,
    policyHash,
    researchScopeHash: hash(researchScope),
    stage: "METADATA_CLASSIFICATION_ONLY",
    ordering: "CANONICAL_KEY_NOT_INVESTMENT_RANK",
    selectionPerformed: false,
    strategyEvaluated: false,
    ordersEnabled: false,
    liveEnabled: false,
    pendingChecks: [
      "PRICE_HISTORY_TURNOVER_SPREAD",
      "PRODUCT_BENCHMARK_PROFILES",
      "SELECTION_PROFILE",
      "FORECAST_COST_EXECUTION_PROFILES",
      "STRATEGY_AND_PORTFOLIO_RISK",
      "LIVE_ELIGIBILITY_IF_LIVE",
    ],
    items,
  } as const;
  return {
    ...decision,
    decisionHash: hash(decision),
    // 입력 감사 해시는 미래 자료·중복 추가에 따라 변한다. 판단 해시와 구분한다.
    inputHash: hash(input),
    diagnostics: {
      inputRecords: input.records.length,
      deferredRecords,
      duplicates,
    },
    counts: {
      total: items.length,
      candidates: items.filter((item) => item.status === "REVIEW_CANDIDATE")
        .length,
      excluded: items.filter((item) => item.status === "EXCLUDED").length,
      reviewRequired: items.filter((item) => item.status === "REVIEW_REQUIRED")
        .length,
    },
  };
}
