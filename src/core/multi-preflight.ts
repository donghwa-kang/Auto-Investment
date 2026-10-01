import { classifyCatalog } from "./catalog.js";
import { enrichCatalog } from "./catalog-enrichment.js";
import { checkMarketQuality } from "./market-quality.js";
import { hash } from "./policy.js";
import {
  parseMultiPreflight,
  type PreflightBinding,
} from "./multi-preflight-schema.js";

export const preflightReasons = {
  PRODUCT_EXCLUDED: "원본 또는 보강된 상품 분류에서 제외됐습니다.",
  METADATA_BLOCKED: "현재 보강 결과의 메타데이터가 확인 대기입니다.",
  BINDING_MISSING: "상품과 시장 자료 사이의 명시적 연결이 없습니다.",
  BINDING_CONFLICT: "서로 다른 연결이 같은 시장 자료 또는 상품을 가리킵니다.",
  BINDING_HASH_MISSING: "원본/보강/시장 대상 계약의 연결 해시가 누락됐습니다.",
  BASE_RECORD_HASH_MISMATCH: "연결한 원본 기록 버전이 현재 기록과 다릅니다.",
  ENRICHED_ITEM_HASH_MISMATCH:
    "연결한 상품 정보/근거 버전이 현재 보강 결과와 다릅니다.",
  QUALITY_ASSET_HASH_MISMATCH:
    "연결한 시세 대상/벤치마크/시간 창 계약이 현재 입력과 다릅니다.",
  CROSS_STAGE_IDENTITY_MISMATCH:
    "시장 자료와 현재 상품의 ID·시장·거래소·심볼·통화가 다릅니다.",
  MARKET_ASSET_MISSING: "연결 대상의 시장 자료 계약이 없습니다.",
  MARKET_QUALITY_BLOCKED: "연결된 시장 자료의 품질 검사가 보류됐습니다.",
  CATALOG_TARGET_MISSING: "연결 대상이 현재 시점 카탈로그에 없습니다.",
  BENCHMARK_PREFLIGHT_BLOCKED:
    "벤치마크의 상품·연결·품질 통합 점검이 통과하지 못했습니다.",
} as const;
type Reason = keyof typeof preflightReasons;
type Status = "TEST_PREFLIGHT_PASS" | "EXCLUDED" | "BLOCKED";
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (v: { market: string; instrumentId: string }) =>
  `${v.market}:${v.instrumentId}`;
const sorted = <T>(values: T[], key: (value: T) => string) =>
  [...values].sort((a, b) => compare(key(a), key(b)));

export function runMultiPreflight(raw: unknown) {
  const input = parseMultiPreflight(raw);
  // 외부에서 넘긴 결과/성공 플래그는 스키마가 거절한다. 기존 순수 검사기를 재실행한다.
  const catalog = classifyCatalog(input.enrichment.catalog);
  const enrichment = enrichCatalog(input.enrichment);
  const market =
    input.market === null ? null : checkMarketQuality(input.market);
  const catalogByKey = new Map(catalog.items.map((item) => [item.key, item]));
  const enrichedByKey = new Map(
    enrichment.items.map((item) => [item.key, item]),
  );
  const qualityByKey = new Map(
    market?.items.map((item) => [item.assetKey, item]) ?? [],
  );
  const assetByKey = new Map(
    input.market?.assets.map((asset) => [asset.assetKey, asset]) ?? [],
  );
  const uniqueBindings = new Map<string, PreflightBinding>();
  for (const binding of input.bindings)
    uniqueBindings.set(hash(binding), binding);
  const bindings = sorted([...uniqueBindings.values()], (binding) =>
    hash(binding),
  );
  const byAsset = new Map<string, PreflightBinding[]>(),
    byCatalog = new Map<string, PreflightBinding[]>();
  for (const binding of bindings) {
    const a = byAsset.get(binding.assetKey) ?? [],
      c = byCatalog.get(keyOf(binding)) ?? [];
    a.push(binding);
    c.push(binding);
    byAsset.set(binding.assetKey, a);
    byCatalog.set(keyOf(binding), c);
  }
  const bindingIssues: {
    assetKey: string;
    catalogKey: string | null;
    reasons: Reason[];
  }[] = [];
  for (const binding of bindings) {
    const reasons: Reason[] = [];
    if (!assetByKey.has(binding.assetKey)) reasons.push("MARKET_ASSET_MISSING");
    if (!enrichedByKey.has(keyOf(binding)))
      reasons.push("CATALOG_TARGET_MISSING");
    if (
      byAsset.get(binding.assetKey)!.length > 1 ||
      byCatalog.get(keyOf(binding))!.length > 1
    )
      reasons.push("BINDING_CONFLICT");
    if (reasons.length)
      bindingIssues.push({
        assetKey: binding.assetKey,
        catalogKey: keyOf(binding),
        reasons: reasons.sort(compare),
      });
  }
  for (const asset of assetByKey.values())
    if (!byAsset.has(asset.assetKey))
      bindingIssues.push({
        assetKey: asset.assetKey,
        catalogKey: null,
        reasons: ["BINDING_MISSING"],
      });

  const items = enrichment.items.map((enriched) => {
    const base = catalogByKey.get(enriched.key)!;
    const reasons = new Set<Reason>();
    const excluded =
      base.status === "EXCLUDED" || enriched.status === "EXCLUDED";
    if (excluded) reasons.add("PRODUCT_EXCLUDED");
    if (enriched.status === "REVIEW_REQUIRED") reasons.add("METADATA_BLOCKED");
    const links = byCatalog.get(enriched.key) ?? [];
    const binding = links.length === 1 ? links[0]! : null;
    if (!links.length) reasons.add("BINDING_MISSING");
    if (
      links.length > 1 ||
      (binding && byAsset.get(binding.assetKey)!.length > 1)
    )
      reasons.add("BINDING_CONFLICT");
    const asset = binding ? assetByKey.get(binding.assetKey) : undefined;
    const quality = binding ? qualityByKey.get(binding.assetKey) : undefined;
    const actual = {
      baseRecordHash: base.recordHash,
      enrichedItemHash: hash(enriched),
      qualityAssetHash: asset ? hash(asset) : null,
      qualityItemHash: quality ? hash(quality) : null,
    };
    if (binding) {
      if (
        !binding.baseRecordHash ||
        !binding.enrichedItemHash ||
        !binding.qualityAssetHash
      )
        reasons.add("BINDING_HASH_MISSING");
      if (binding.baseRecordHash !== actual.baseRecordHash)
        reasons.add("BASE_RECORD_HASH_MISMATCH");
      if (binding.enrichedItemHash !== actual.enrichedItemHash)
        reasons.add("ENRICHED_ITEM_HASH_MISMATCH");
      if (binding.qualityAssetHash !== actual.qualityAssetHash)
        reasons.add("QUALITY_ASSET_HASH_MISMATCH");
    }
    if (!asset || !quality) reasons.add("MARKET_ASSET_MISSING");
    else {
      const facts = enriched.facts,
        record = base.record;
      if (
        !facts ||
        !record ||
        hash(asset.identity) !==
          hash({
            instrumentId: record.instrumentId,
            market: record.market,
            symbol: record.symbol,
            venue: facts.venue,
            currency: facts.currency,
          })
      )
        reasons.add("CROSS_STAGE_IDENTITY_MISMATCH");
      if (quality.status !== "TEST_WINDOW_VALID")
        reasons.add("MARKET_QUALITY_BLOCKED");
    }
    return {
      catalogKey: enriched.key,
      symbol: enriched.symbol,
      assetKey: asset?.assetKey ?? null,
      role: asset?.role ?? null,
      status: (excluded
        ? "EXCLUDED"
        : reasons.size
          ? "BLOCKED"
          : "TEST_PREFLIGHT_PASS") as Status,
      reasons: [...reasons].sort(compare),
      stages: {
        catalog: { status: base.status, reasons: [...base.reasons] },
        enrichment: { status: enriched.status, reasons: [...enriched.reasons] },
        market: quality
          ? { status: quality.status, reasons: [...quality.reasons] }
          : { status: "MISSING", reasons: [] },
      },
      binding,
      actual,
      benchmarkCatalogKey: null as string | null,
    };
  });
  const itemsByKey = new Map(items.map((item) => [item.catalogKey, item]));
  // 원본/보강 검사도 포함한 벤치마크 상태를 전파한다. 정렬/반복 순서에 의존하지 않는다.
  const ownStatus = new Map(
    items.map((item) => [item.catalogKey, item.status]),
  );
  for (const item of items) {
    if (item.role !== "INSTRUMENT" || item.assetKey === null) continue;
    const asset = assetByKey.get(item.assetKey)!;
    const candidates =
      asset.benchmarkKey === null
        ? []
        : (byAsset.get(asset.benchmarkKey) ?? []);
    const target =
      candidates.length === 1
        ? itemsByKey.get(keyOf(candidates[0]!))
        : undefined;
    item.benchmarkCatalogKey = target?.catalogKey ?? null;
    if (
      !target ||
      target.role !== "BENCHMARK" ||
      ownStatus.get(target.catalogKey) !== "TEST_PREFLIGHT_PASS"
    ) {
      item.reasons.push("BENCHMARK_PREFLIGHT_BLOCKED");
      item.reasons.sort(compare);
      if (item.status !== "EXCLUDED") item.status = "BLOCKED";
    }
  }
  const testCandidates = items
    .filter(
      (item) =>
        item.role === "INSTRUMENT" && item.status === "TEST_PREFLIGHT_PASS",
    )
    .map((item) => item.catalogKey);
  const counts = {
    catalogItems: items.length,
    passed: items.filter((item) => item.status === "TEST_PREFLIGHT_PASS")
      .length,
    excluded: items.filter((item) => item.status === "EXCLUDED").length,
    blocked: items.filter((item) => item.status === "BLOCKED").length,
    testCandidates: testCandidates.length,
  };
  const decision = {
    schemaVersion: "OFFLINE_MULTI_PREFLIGHT_RESULT_V1",
    purpose: "TEST_ONLY",
    stage: "INTEGRATED_TEST_PREFLIGHT_ONLY",
    asOf: input.asOf,
    policyHash: catalog.policyHash,
    researchScopeHash: catalog.researchScopeHash,
    stageDecisionHashes: {
      catalog: catalog.decisionHash,
      enrichment: enrichment.decisionHash,
      market: market?.decisionHash ?? null,
    },
    bindingContractHash: hash(bindings),
    sourceAuthentication: "UNVERIFIED_TEST_INPUT",
    realDataReady: false,
    strategyReady: false,
    strategyEvaluated: false,
    selectionPerformed: false,
    paperOrdersEnabled: false,
    liveEnabled: false,
    ordering: "CANONICAL_KEY_NOT_INVESTMENT_RANK",
    status: !testCandidates.length
      ? "NO_TEST_CANDIDATES"
      : counts.blocked || bindingIssues.length
        ? "HAS_BLOCKS"
        : "TEST_PREFLIGHT_COMPLETE",
    items,
    testCandidates,
    counts,
    bindingIssues: sorted(bindingIssues, (issue) => hash(issue)),
    pendingChecks: [
      ...new Set([
        ...enrichment.pendingChecks,
        ...(market?.pendingChecks ?? ["MARKET_DATA_REQUIRED"]),
        "REAL_METADATA_TO_MARKET_BINDING",
        "INTEGRATED_STRATEGY_AND_RISK_VALIDATION",
      ]),
    ].sort(compare),
  };
  return {
    ...decision,
    decisionHash: hash(decision),
    inputHash: hash(input),
    diagnostics: { duplicateBindings: input.bindings.length - bindings.length },
    // 상세 단계 보고서의 입력 감사/미래 진단은 통합 판단 해시와 분리한다.
    stageReports: { catalog, enrichment, market },
  };
}
