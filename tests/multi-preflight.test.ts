import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  runMultiPreflight,
  preflightReasons,
} from "../src/core/multi-preflight.js";
import {
  parseMultiPreflight,
  type PreflightInput,
} from "../src/core/multi-preflight-schema.js";
import { parseEnrichment } from "../src/core/catalog-enrichment-schema.js";
import { enrichCatalog } from "../src/core/catalog-enrichment.js";
import { parseMarketQuality } from "../src/core/market-quality-schema.js";
import { checkMarketQuality } from "../src/core/market-quality.js";
import { classifyCatalog } from "../src/core/catalog.js";
import { hash, policy, spec } from "../src/core/policy.js";

const fixture = () =>
  JSON.parse(
    readFileSync("fixtures/multi-preflight-v1.json", "utf8"),
  ) as PreflightInput;
const item = (input: PreflightInput, key = "KR:TEST-KR") =>
  runMultiPreflight(input).items.find((i) => i.catalogKey === key)!;
const binding = (input: PreflightInput, key = "TEST-KR") =>
  input.bindings.find((b) => b.assetKey === key)!;
const asset = (input: PreflightInput, key = "TEST-KR") =>
  input.market!.assets.find((a) => a.assetKey === key)!;
const record = (input: PreflightInput, key = "TEST-KR") =>
  input.enrichment.catalog.records.find((r) => r.instrumentId === key)!;
function reason(input: PreflightInput, code: string, key = "KR:TEST-KR") {
  const result = item(input, key);
  assert.notEqual(result.status, "TEST_PREFLIGHT_PASS");
  assert.ok(
    result.reasons.some((reason) => reason === code),
    `${key} ${code}: ${result.reasons}`,
  );
}
// 새 시험 입력을 의도적으로 만들 때만 새 결합 해시를 계산한다. 제품의 자동 재결합 기능이 아니다.
function rebind(input: PreflightInput) {
  input.enrichment = parseEnrichment(input.enrichment);
  input.market =
    input.market === null ? null : parseMarketQuality(input.market);
  const metadata = enrichCatalog(input.enrichment);
  for (const b of input.bindings) {
    const enriched = metadata.items.find(
      (i) => i.key === `${b.market}:${b.instrumentId}`,
    );
    const target = input.market?.assets.find((a) => a.assetKey === b.assetKey);
    b.baseRecordHash = enriched?.baseRecordHash ?? null;
    b.enrichedItemHash = enriched ? hash(enriched) : null;
    b.qualityAssetHash = target ? hash(target) : null;
  }
}

test("PREFLIGHT-01 혼합 8개 상품·4통과/1제외/3보류·시험 종목 후보 2개", () => {
  const result = runMultiPreflight(fixture());
  assert.equal(result.status, "HAS_BLOCKS");
  assert.deepEqual(result.counts, {
    catalogItems: 8,
    passed: 4,
    excluded: 1,
    blocked: 3,
    testCandidates: 2,
  });
  assert.deepEqual(result.testCandidates, ["KR:TEST-KR", "US:TEST-US"]);
  assert.deepEqual(result.bindingIssues, []);
  assert.equal(
    result.decisionHash,
    "ccb8f520987e6c57cd91bb4ac382a6c16cff0498ef2a03c81927f8fef1e69f3e",
  );
  for (const key of [
    "realDataReady",
    "strategyReady",
    "strategyEvaluated",
    "selectionPerformed",
    "paperOrdersEnabled",
    "liveEnabled",
  ] as const)
    assert.equal(result[key], false);
  assert.equal(result.sourceAuthentication, "UNVERIFIED_TEST_INPUT");
});
test("PREFLIGHT-02 원본 입력/정책 불변·세 검사 실제 재실행 결과 대조", () => {
  const input = fixture(),
    before = structuredClone(input),
    policyBefore = hash({ policy, spec });
  const result = runMultiPreflight(input);
  assert.deepEqual(
    result.stageReports.catalog,
    classifyCatalog(input.enrichment.catalog),
  );
  assert.deepEqual(
    result.stageReports.enrichment,
    enrichCatalog(input.enrichment),
  );
  assert.deepEqual(
    result.stageReports.market,
    checkMarketQuality(input.market),
  );
  assert.deepEqual(input, before);
  assert.equal(hash({ policy, spec }), policyBefore);
  assert.deepEqual(result, runMultiPreflight(input));
});
test("PREFLIGHT-03 보강으로 해결된 원본 결측만 통과, 원본 상태는 기록에 보존", () => {
  const result = item(fixture());
  assert.equal(result.stages.catalog.status, "REVIEW_REQUIRED");
  assert.equal(result.stages.enrichment.status, "REVIEW_CANDIDATE");
  assert.equal(result.stages.market.status, "TEST_WINDOW_VALID");
  assert.equal(result.status, "TEST_PREFLIGHT_PASS");
});
test("PREFLIGHT-04 상품 제외는 좋은 시세로 해제되지 않음", () => {
  const input = fixture(),
    result = item(input, "KR:TEST-EXCLUDED");
  assert.equal(result.stages.market.status, "TEST_WINDOW_VALID");
  assert.equal(result.status, "EXCLUDED");
  assert.ok(
    !runMultiPreflight(input).testCandidates.includes("KR:TEST-EXCLUDED"),
  );
});
test("PREFLIGHT-05 해결되지 않은 상품 결측·나쁜 호가·연결 누락 전파", () => {
  const input = fixture();
  reason(input, "METADATA_BLOCKED", "KR:TEST-METADATA");
  reason(input, "MARKET_QUALITY_BLOCKED", "US:TEST-QUOTE");
  reason(input, "BINDING_MISSING", "US:TEST-MISSING");
});
test("PREFLIGHT-06 원본/보강/시장 대상 해시 누락 및 잘못된 해시 보류", () => {
  for (const key of [
    "baseRecordHash",
    "enrichedItemHash",
    "qualityAssetHash",
  ] as const) {
    for (const value of [null, "0".repeat(64)]) {
      const input = fixture();
      binding(input)[key] = value;
      reason(
        input,
        value === null
          ? "BINDING_HASH_MISSING"
          : {
              baseRecordHash: "BASE_RECORD_HASH_MISMATCH",
              enrichedItemHash: "ENRICHED_ITEM_HASH_MISMATCH",
              qualityAssetHash: "QUALITY_ASSET_HASH_MISMATCH",
            }[key],
      );
    }
  }
});
test("PREFLIGHT-07 최신 원본 정정은 옛 연결을 무효화", () => {
  const input = fixture(),
    correction = structuredClone(record(input, "TEST-US"));
  correction.revision++;
  input.enrichment.catalog.records.push(correction);
  reason(input, "BASE_RECORD_HASH_MISMATCH", "US:TEST-US");
  rebind(input);
  assert.equal(item(input, "US:TEST-US").status, "TEST_PREFLIGHT_PASS");
});
test("PREFLIGHT-08 같은 상품 값이라도 새 근거 버전은 옛 연결을 무효화", () => {
  const input = fixture(),
    correction = structuredClone(input.enrichment.evidence[0]!);
  correction.revision++;
  correction.evidenceId = "NEW-EVIDENCE";
  input.enrichment.evidence.push(correction);
  reason(input, "ENRICHED_ITEM_HASH_MISMATCH");
  rebind(input);
  assert.equal(item(input).status, "TEST_PREFLIGHT_PASS");
});
test("PREFLIGHT-09 시장 대상 계약 변경은 자동 재결합하지 않음", () => {
  const input = fixture();
  asset(input).sourceId = "OTHER";
  reason(input, "QUALITY_ASSET_HASH_MISMATCH");
  rebind(input);
  reason(input, "MARKET_QUALITY_BLOCKED");
});
test("PREFLIGHT-10 해시를 다시 계산해도 ID·시장·거래소·심볼·통화 불일치 차단", () => {
  for (const key of [
    "instrumentId",
    "market",
    "venue",
    "symbol",
    "currency",
  ] as const) {
    const input = fixture(),
      target = asset(input);
    if (key === "market") target.identity.market = "US";
    else if (key === "currency") target.identity.currency = "USD";
    else target.identity[key] = "WRONG";
    for (const row of input.market!.records)
      if (row.assetKey === target.assetKey)
        row.identity = structuredClone(target.identity);
    rebind(input);
    reason(input, "CROSS_STAGE_IDENTITY_MISMATCH");
  }
});
test("PREFLIGHT-11 벤치마크 상품 보류는 정상 호가 종목에도 전파", () => {
  const input = fixture();
  record(input, "TEST-KR-BENCH").underlying = "UNKNOWN";
  rebind(input);
  assert.equal(item(input).stages.market.status, "TEST_WINDOW_VALID");
  reason(input, "BENCHMARK_PREFLIGHT_BLOCKED");
  assert.equal(item(input, "US:TEST-US").status, "TEST_PREFLIGHT_PASS");
});
test("PREFLIGHT-12 벤치마크 제외/연결 누락/오래된 해시 전파", () => {
  for (const mode of ["excluded", "missing", "hash"] as const) {
    const input = fixture();
    if (mode === "excluded") {
      record(input, "TEST-KR-BENCH").brokerSupported = false;
      rebind(input);
    }
    if (mode === "missing")
      input.bindings = input.bindings.filter(
        (b) => b.assetKey !== "TEST-KR-BENCH",
      );
    if (mode === "hash")
      binding(input, "TEST-KR-BENCH").enrichedItemHash = "0".repeat(64);
    reason(input, "BENCHMARK_PREFLIGHT_BLOCKED");
  }
});
test("PREFLIGHT-13 같은 시장 대상에 상충 연결을 달면 관련 상품 모두 보류", () => {
  const input = fixture(),
    conflict = structuredClone(binding(input));
  conflict.market = "US";
  conflict.instrumentId = "TEST-US";
  input.bindings.push(conflict);
  reason(input, "BINDING_CONFLICT");
  reason(input, "BINDING_CONFLICT", "US:TEST-US");
  assert.ok(runMultiPreflight(input).bindingIssues.length > 0);
});
test("PREFLIGHT-14 다른 시장 대상을 한 상품에 다중 연결하면 보류", () => {
  const input = fixture(),
    conflict = structuredClone(binding(input));
  conflict.assetKey = "TEST-US";
  input.bindings.push(conflict);
  reason(input, "BINDING_CONFLICT");
  reason(input, "BINDING_CONFLICT", "US:TEST-US");
});
test("PREFLIGHT-15 완전 중복 연결은 한 번 처리하고 감사만 변경", () => {
  const input = fixture(),
    before = runMultiPreflight(input);
  input.bindings.push(structuredClone(binding(input)));
  const result = runMultiPreflight(input);
  assert.equal(result.decisionHash, before.decisionHash);
  assert.notEqual(result.inputHash, before.inputHash);
  assert.equal(result.diagnostics.duplicateBindings, 1);
});
test("PREFLIGHT-16 연결이 없는 시장 대상은 진단에 남기며 투자 후보로 만들지 않음", () => {
  const input = fixture();
  input.bindings = input.bindings.filter((b) => b.assetKey !== "TEST-KR");
  reason(input, "BINDING_MISSING");
  assert.ok(
    runMultiPreflight(input).bindingIssues.some(
      (issue) =>
        issue.assetKey === "TEST-KR" &&
        issue.reasons.includes("BINDING_MISSING"),
    ),
  );
});
test("PREFLIGHT-17 없는 카탈로그를 가리킨 연결은 무시하거나 심볼로 대체하지 않음", () => {
  const input = fixture();
  binding(input).instrumentId = "NOT-IN-CATALOG";
  reason(input, "BINDING_MISSING");
  assert.ok(
    runMultiPreflight(input).bindingIssues.some((issue) =>
      issue.reasons.includes("CATALOG_TARGET_MISSING"),
    ),
  );
});
test("PREFLIGHT-18 누락된 시장 묶음/대상/시세 행은 보류", () => {
  const none = fixture();
  none.market = null;
  reason(none, "MARKET_ASSET_MISSING");
  assert.equal(runMultiPreflight(none).status, "NO_TEST_CANDIDATES");
  const missing = fixture();
  missing.market!.assets = missing.market!.assets.filter(
    (a) => a.assetKey !== "TEST-KR",
  );
  reason(missing, "MARKET_ASSET_MISSING");
  const empty = fixture();
  empty.market!.records = [];
  reason(empty, "MARKET_QUALITY_BLOCKED");
});
test("PREFLIGHT-19 세 시점은 일치해야 하며 자동 소급/재날짜 지정하지 않음", () => {
  for (const target of ["root", "catalog", "market"] as const) {
    const input = fixture(),
      before = structuredClone(input),
      changed = "2026-09-11T01:03:02.000Z";
    if (target === "root") input.asOf = changed;
    if (target === "catalog") input.enrichment.catalog.asOf = changed;
    if (target === "market") input.market!.asOf = changed;
    assert.throws(
      () => runMultiPreflight(input),
      /MULTI_PREFLIGHT_AS_OF_MISMATCH/,
    );
    assert.notDeepEqual(input, before);
    assert.equal(
      target === "root"
        ? input.asOf
        : target === "catalog"
          ? input.enrichment.catalog.asOf
          : input.market!.asOf,
      changed,
    );
  }
});
test("PREFLIGHT-20 시각/식별 정규화 후 같은 입력으로 결합", () => {
  const input = fixture(),
    before = runMultiPreflight(input).decisionHash;
  input.asOf = "2026-09-11T10:03:01+09:00";
  asset(input).identity.symbol = "test-kr";
  assert.equal(runMultiPreflight(input).decisionHash, before);
  assert.equal(parseMultiPreflight(input).asOf, "2026-09-11T01:03:01.000Z");
});
test("PREFLIGHT-21 미래 상품/근거/시세 정정은 현재 통합 판단 불변", () => {
  const input = fixture(),
    before = runMultiPreflight(input);
  const future = "2026-09-12T00:00:00.000Z";
  const catalog = structuredClone(record(input));
  catalog.revision++;
  catalog.availableAt = future;
  catalog.brokerSupported = false;
  input.enrichment.catalog.records.push(catalog);
  const newProduct = structuredClone(catalog);
  newProduct.instrumentId = "FUTURE-PRODUCT";
  input.enrichment.catalog.records.push(newProduct);
  const evidence = structuredClone(input.enrichment.evidence[0]!);
  evidence.revision++;
  evidence.availableAt = future;
  input.enrichment.evidence.push(evidence);
  const price = structuredClone(
    input.market!.records.find(
      (r) => r.assetKey === "TEST-KR" && r.kind === "PRICE",
    )!,
  );
  price.revision++;
  price.availableAt = future;
  if (price.kind === "PRICE") price.price = null;
  input.market!.records.push(price);
  const result = runMultiPreflight(input);
  assert.equal(result.decisionHash, before.decisionHash);
  assert.notEqual(result.inputHash, before.inputHash);
  assert.ok(!result.items.some((i) => i.catalogKey.includes("FUTURE-PRODUCT")));
});
test("PREFLIGHT-22 미래 입력도 스키마 위반이면 전체 거절", () => {
  const input = fixture();
  input.market!.records[0]!.availableAt = "2026-09-12T00:00:00.0001Z";
  assert.throws(
    () => runMultiPreflight(input),
    /MULTI_PREFLIGHT_INPUT_INVALID/,
  );
});
test("PREFLIGHT-23 입력 순서·완전 중복·정렬 순서에 독립적", () => {
  const input = fixture(),
    before = runMultiPreflight(input).decisionHash;
  input.enrichment.catalog.records.reverse();
  input.enrichment.evidence.reverse();
  input.enrichment.sources.reverse();
  input.enrichment.sources[0]!.allowedFields.reverse();
  input.market!.assets.reverse();
  input.market!.records.reverse();
  input.market!.sources[0]!.kinds.reverse();
  input.bindings.reverse();
  input.enrichment.catalog.records.push(
    structuredClone(input.enrichment.catalog.records[0]!),
  );
  input.market!.records.push(structuredClone(input.market!.records[0]!));
  assert.equal(runMultiPreflight(input).decisionHash, before);
});
test("PREFLIGHT-24 상품 ID 상충 및 심볼 충돌은 연결 해시 갱신으로 해제되지 않음", () => {
  const input = fixture(),
    conflict = structuredClone(record(input, "TEST-US"));
  conflict.kind = "STOCK";
  input.enrichment.catalog.records.push(conflict);
  rebind(input);
  reason(input, "METADATA_BLOCKED", "US:TEST-US");
  const collision = fixture(),
    duplicate = structuredClone(record(collision, "TEST-US"));
  duplicate.instrumentId = "DUPLICATE";
  collision.enrichment.catalog.records.push(duplicate);
  rebind(collision);
  reason(collision, "METADATA_BLOCKED", "US:TEST-US");
});
test("PREFLIGHT-25 원본 만료/근거 상충을 좋은 시세로 덮어쓰지 않음", () => {
  const stale = fixture();
  stale.enrichment.catalog.metadataMaxAgeMs = 1;
  rebind(stale);
  reason(stale, "METADATA_BLOCKED");
  const conflict = fixture(),
    e = structuredClone(conflict.enrichment.evidence[0]!);
  e.evidenceId = "CONFLICT";
  conflict.enrichment.evidence.push(e);
  rebind(conflict);
  reason(conflict, "METADATA_BLOCKED");
});
test("PREFLIGHT-26 나쁜 최신 시세 정정은 옛 정상 시세/저장된 통과로 대체하지 않음", () => {
  const input = fixture(),
    bad = structuredClone(
      input.market!.records.find(
        (r) => r.assetKey === "TEST-KR" && r.kind === "QUOTE",
      )!,
    );
  bad.revision++;
  if (bad.kind === "QUOTE") bad.askSize = null;
  input.market!.records.push(bad);
  reason(input, "MARKET_QUALITY_BLOCKED");
  assert.equal(item(input, "US:TEST-US").status, "TEST_PREFLIGHT_PASS");
});
test("PREFLIGHT-27 위조 통과 결과/실자료/추가 필드/잘못된 해시는 원문 없이 거절", () => {
  for (const input of [
    { ...fixture(), purpose: "REAL_DATA" },
    { ...fixture(), approved: true },
    { ...fixture(), stageReports: { market: { status: "TEST_WINDOW_VALID" } } },
    { ...fixture(), market: checkMarketQuality(fixture().market) },
    {
      ...fixture(),
      bindings: [{ ...binding(fixture()), baseRecordHash: "FAKE_SECRET" }],
    },
  ])
    assert.throws(() => runMultiPreflight(input), {
      message: "MULTI_PREFLIGHT_INPUT_INVALID",
    });
});
test("PREFLIGHT-28 빈 목록/모두 제외는 실행됐어도 시험 후보 없음", () => {
  const input = fixture();
  input.enrichment.catalog.records = [];
  input.enrichment.evidence = [];
  input.market = null;
  input.bindings = [];
  const empty = runMultiPreflight(input);
  assert.equal(empty.status, "NO_TEST_CANDIDATES");
  assert.equal(empty.counts.passed, 0);
  const excluded = fixture();
  for (const r of excluded.enrichment.catalog.records)
    r.brokerSupported = false;
  rebind(excluded);
  assert.equal(runMultiPreflight(excluded).status, "NO_TEST_CANDIDATES");
});
test("PREFLIGHT-29 연결 자원 상한과 안전한 특수 ID", () => {
  const input = fixture();
  input.bindings = Array(129).fill(binding(input));
  assert.throws(
    () => runMultiPreflight(input),
    /MULTI_PREFLIGHT_INPUT_INVALID/,
  );
  const special = fixture(),
    target = asset(special);
  target.assetKey = "__proto__";
  for (const r of special.market!.records)
    if (r.assetKey === "TEST-KR") r.assetKey = "__proto__";
  binding(special).assetKey = "__proto__";
  rebind(special);
  assert.equal(item(special).status, "TEST_PREFLIGHT_PASS");
});
test("PREFLIGHT-30 별도 원본 검사기의 기존 판단 해시 보존", () => {
  const original = JSON.parse(readFileSync("fixtures/catalog-v1.json", "utf8"));
  assert.equal(
    classifyCatalog(original).decisionHash,
    "3abf3c482207154a588c380f1e46e6842b37562aa91c13e3e1950125a650c256",
  );
  for (const entry of runMultiPreflight(fixture()).items)
    for (const code of entry.reasons) assert.ok(preflightReasons[code], code);
});

test("PREFLIGHT-31 모두 통과한 시험 범위만 COMPLETE·벤치마크는 후보에서 제외", () => {
  const input = fixture(),
    keys = ["TEST-KR", "TEST-KR-BENCH", "TEST-US", "TEST-US-BENCH"];
  input.enrichment.catalog.records = input.enrichment.catalog.records.filter(
    (r) => keys.includes(r.instrumentId),
  );
  input.market!.assets = input.market!.assets.filter((a) =>
    keys.includes(a.assetKey),
  );
  input.market!.records = input.market!.records.filter((r) =>
    keys.includes(r.assetKey),
  );
  input.bindings = input.bindings.filter((b) => keys.includes(b.assetKey));
  const result = runMultiPreflight(input);
  assert.equal(result.status, "TEST_PREFLIGHT_COMPLETE");
  assert.deepEqual(result.counts, {
    catalogItems: 4,
    passed: 4,
    excluded: 0,
    blocked: 0,
    testCandidates: 2,
  });
  assert.equal(result.strategyReady, false);
  assert.equal(result.liveEnabled, false);
});
test("PREFLIGHT-32 같은 벤치마크를 쓰는 여러 종목에 보류 전파·순서 독립", () => {
  const input = fixture();
  asset(input, "TEST-US").benchmarkKey = "TEST-KR-BENCH";
  record(input, "TEST-KR-BENCH").brokerSupported = false;
  rebind(input);
  reason(input, "BENCHMARK_PREFLIGHT_BLOCKED");
  reason(input, "BENCHMARK_PREFLIGHT_BLOCKED", "US:TEST-US");
  const before = runMultiPreflight(input).decisionHash;
  input.market!.assets.reverse();
  input.bindings.reverse();
  assert.equal(runMultiPreflight(input).decisionHash, before);
});
test("PREFLIGHT-33 거래소/통화 결측 보강 후 원본 아닌 최종 사실과 시장 자료를 연결", () => {
  const input = fixture(),
    original = record(input, "TEST-US");
  original.venue = null;
  original.currency = "UNKNOWN";
  const common = {
    ...input.enrichment.evidence[0]!,
    subject: {
      market: "US",
      instrumentId: original.instrumentId,
      symbol: original.symbol,
      baseRecordHash: hash(original),
    },
  };
  input.enrichment = parseEnrichment({
    ...input.enrichment,
    sources: [
      {
        ...input.enrichment.sources[0]!,
        allowedFields: ["underlying", "leveraged", "venue", "currency"],
      },
    ],
    evidence: [
      ...input.enrichment.evidence,
      { ...common, evidenceId: "US-VENUE", field: "venue", value: "TEST-US" },
      { ...common, evidenceId: "US-CURRENCY", field: "currency", value: "USD" },
    ],
  });
  rebind(input);
  const result = item(input, "US:TEST-US");
  assert.equal(result.stages.catalog.status, "REVIEW_REQUIRED");
  assert.equal(result.status, "TEST_PREFLIGHT_PASS");
});
