import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enrichCatalog } from "../src/core/catalog-enrichment.js";
import {
  enrichmentFields,
  type EnrichmentInput,
  type MetadataEvidence,
} from "../src/core/catalog-enrichment-schema.js";
import { classifyCatalog } from "../src/core/catalog.js";
import { parseCatalog } from "../src/core/catalog-schema.js";
import { hash } from "../src/core/policy.js";

function sample(): EnrichmentInput {
  return JSON.parse(
    readFileSync("fixtures/catalog-enrichment-v1.json", "utf8"),
  );
}
function bind(input: EnrichmentInput) {
  const records = parseCatalog(input.catalog).records;
  for (const e of input.evidence) {
    const record = records.find(
      (r) =>
        r.market === e.subject.market &&
        r.instrumentId === e.subject.instrumentId,
    );
    if (record) {
      e.subject.baseRecordHash = hash(record);
      e.subject.symbol = record.symbol;
    }
  }
}
function soxl(input: EnrichmentInput) {
  return enrichCatalog(input).items.find((i) => i.key === "US:TEST-SOXL")!;
}
function extra(
  input: EnrichmentInput,
  changes: Partial<MetadataEvidence> = {},
) {
  const e = structuredClone(input.evidence[0]!);
  Object.assign(e, { evidenceId: "TEST-EXTRA", ...changes });
  input.evidence.push(e);
  return e;
}

test("ENRICH-01 합성 샘플 2후보/1제외/2대기·10필드 보강·고정 판단 해시", () => {
  const result = enrichCatalog(sample());
  assert.deepEqual(result.counts, {
    total: 5,
    candidates: 2,
    excluded: 1,
    reviewRequired: 2,
    enrichedFields: 10,
  });
  assert.equal(
    result.decisionHash,
    "3516f76d3bfbc71d3841bf838dfe5889e2f8dff0a07721e83e629618cf9dc01d",
  );
  assert.equal(result.ordersEnabled, false);
  assert.equal(result.realMetadataReady, false);
  assert.equal(result.historicalUniverseReady, false);
  assert.equal(result.sourceAuthentication, "UNVERIFIED_TEST_INPUT");
  assert.ok(
    result.items
      .find((i) => i.key === "US:TEST-EXCLUDED")!
      .reasons.includes("USER_EXCLUDED_SINGLE_STOCK_LEVERAGE"),
  );
});
test("ENRICH-02 원본 입력 불변·기존 카탈로그 판단 해시 불변", () => {
  const input = sample(),
    before = structuredClone(input);
  enrichCatalog(input);
  assert.deepEqual(input, before);
  const base = JSON.parse(readFileSync("fixtures/catalog-v1.json", "utf8"));
  assert.equal(
    classifyCatalog(base).decisionHash,
    "3abf3c482207154a588c380f1e46e6842b37562aa91c13e3e1950125a650c256",
  );
});
test("ENRICH-03 8개 필드 타입별 결측 보강과 필드별 근거 보존", () => {
  const input = sample();
  const template = structuredClone(input.evidence[0]!);
  const values = {
    venue: "TEST-US",
    currency: "USD",
    kind: "ETF",
    underlying: "INDEX",
    leveraged: true,
    requiredDepositKrw: 0,
    listingStatus: "LISTED",
    brokerSupported: true,
  };
  input.catalog.records = [input.catalog.records[0]!];
  Object.assign(input.catalog.records[0]!, {
    venue: null,
    currency: "UNKNOWN",
    kind: "UNKNOWN",
    underlying: "UNKNOWN",
    leveraged: null,
    requiredDepositKrw: null,
    listingStatus: "UNKNOWN",
    brokerSupported: null,
  });
  input.sources[0]!.allowedFields = [...enrichmentFields];
  input.evidence = enrichmentFields.map((field, i) =>
    Object.assign(structuredClone(template), {
      evidenceId: `TEST-ALL-${i}`,
      field,
      value: values[field],
    }),
  );
  bind(input);
  const result = soxl(input);
  assert.equal(result.status, "REVIEW_CANDIDATE");
  assert.deepEqual(result.facts, { market: "US", ...values });
  assert.ok(
    result.fields.every(
      (f) => f.state === "ENRICHED" && f.evidence.length === 1,
    ),
  );
  assert.ok(
    result.fields.every(
      (f) => f.evidence[0]!.subject.baseRecordHash === result.baseRecordHash,
    ),
  );
});
test("ENRICH-04 필드/값 불일치·추가 키·실자료·없는 필드는 전체 거절", () => {
  for (const mutation of [
    "REAL",
    "REAL_BASE",
    "EXTRA",
    "BAD_VALUE",
    "MISSING",
    "IMMUTABLE_MARKET",
    "BAD_DIGEST",
    "NEGATIVE",
  ]) {
    const input = sample();
    if (mutation === "REAL")
      Object.assign(input, { purpose: "REAL_REFERENCE_SNAPSHOT" });
    if (mutation === "REAL_BASE")
      Object.assign(input.catalog, { purpose: "REAL" });
    if (mutation === "EXTRA")
      Object.assign(input.evidence[0]!, {
        secret: "FAKE_SECRET_MUST_NOT_LEAK",
      });
    if (mutation === "BAD_VALUE")
      Object.assign(input.evidence[0]!, { field: "leveraged", value: "true" });
    if (mutation === "MISSING")
      Reflect.deleteProperty(input.evidence[0]!, "effectiveAt");
    if (mutation === "IMMUTABLE_MARKET")
      Object.assign(input.evidence[0]!, { field: "market", value: "US" });
    if (mutation === "BAD_DIGEST")
      input.evidence[0]!.sourceDocumentHash = "invalid";
    if (mutation === "NEGATIVE")
      Object.assign(input.evidence[0]!, {
        field: "requiredDepositKrw",
        value: -1,
      });
    assert.throws(() => enrichCatalog(input), {
      code: "CATALOG_ENRICHMENT_INPUT_INVALID",
    });
  }
});
test("ENRICH-05 미래 이용 가능/효력 근거는 과거 판단 해시에 영향 없음", () => {
  for (const field of ["availableAt", "effectiveAt"] as const) {
    const input = sample(),
      before = enrichCatalog(input);
    extra(input, {
      revision: 2,
      value: "SINGLE_STOCK",
      [field]: "2026-09-11T07:00:00.001Z",
    });
    const result = enrichCatalog(input);
    assert.equal(result.decisionHash, before.decisionHash);
    assert.notEqual(result.inputHash, before.inputHash);
    assert.equal(result.diagnostics.deferredEvidence, 1);
  }
});
test("ENRICH-06 시점 동일 경계 포함·밀리초 미만/역순/시간대 누락 거절", () => {
  const input = sample();
  extra(input, {
    revision: 2,
    value: "SINGLE_STOCK",
    availableAt: input.catalog.asOf,
    effectiveAt: input.catalog.asOf,
  });
  assert.equal(soxl(input).facts!.underlying, "SINGLE_STOCK");
  for (const changes of [
    { availableAt: "2026-09-11T07:00:00.0001Z" },
    { receivedAt: "2026-09-11T05:59:59.000Z" },
    { observedAt: "2026-09-11T06:00:00" },
  ]) {
    const bad = sample();
    Object.assign(bad.evidence[0]!, changes);
    assert.throws(() => enrichCatalog(bad), {
      code: "CATALOG_ENRICHMENT_INPUT_INVALID",
    });
  }
});
test("ENRICH-07 관측 시점 기준 신선도 경계·만료 최신 정정의 이전 값 대체 금지", () => {
  const input = sample();
  input.sources[0]!.metadataMaxAgeMs = 3600000;
  assert.equal(soxl(input).status, "REVIEW_CANDIDATE");
  input.sources[0]!.metadataMaxAgeMs--;
  assert.ok(soxl(input).reasons.includes("EVIDENCE_STALE"));
  const latest = sample();
  extra(latest, { revision: 2, observedAt: "2026-09-09T06:00:00.000Z" });
  assert.equal(soxl(latest).facts!.underlying, "UNKNOWN");
  assert.ok(soxl(latest).reasons.includes("EVIDENCE_STALE"));
});
test("ENRICH-08 최신 UNKNOWN/null은 좋은 이전 값으로 복원하지 않음", () => {
  const input = sample();
  extra(input, { revision: 2, value: "UNKNOWN" });
  assert.equal(soxl(input).facts!.underlying, "UNKNOWN");
  assert.ok(soxl(input).reasons.includes("EVIDENCE_UNKNOWN"));
  const leverage = sample();
  const e = structuredClone(leverage.evidence[1]!);
  Object.assign(e, { revision: 2, evidenceId: "TEST-NULL", value: null });
  leverage.evidence.push(e);
  assert.equal(soxl(leverage).facts!.leveraged, null);
  assert.equal(soxl(leverage).status, "REVIEW_REQUIRED");
});
test("ENRICH-09 출처 간 같은 값은 결합·충돌은 다수결 없이 보류", () => {
  const input = sample();
  extra(input, { sourceId: "TEST-SECOND-ISSUER" });
  const clear = soxl(input);
  assert.equal(clear.status, "REVIEW_CANDIDATE");
  assert.equal(
    clear.fields.find((f) => f.field === "underlying")!.evidence.length,
    2,
  );
  Object.assign(input.evidence.at(-1)!, { value: "SINGLE_STOCK" });
  assert.ok(soxl(input).reasons.includes("EVIDENCE_SOURCE_CONFLICT"));
  assert.equal(soxl(input).facts!.underlying, "UNKNOWN");
});
test("ENRICH-10 동일 출처 최신 동일 revision 상충·고버전 명시 정정", () => {
  const input = sample();
  extra(input, { value: "SINGLE_STOCK" });
  assert.ok(soxl(input).reasons.includes("EVIDENCE_REVISION_CONFLICT"));
  extra(input, { evidenceId: "TEST-REVISION-2", revision: 2, value: "INDEX" });
  assert.equal(soxl(input).status, "REVIEW_CANDIDATE");
});
test("ENRICH-11 원본 확인 값과 모순되는 근거는 원본 덮어쓰기 금지", () => {
  const input = sample();
  input.catalog.records[0]!.underlying = "SINGLE_STOCK";
  bind(input);
  const result = soxl(input);
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.ok(result.reasons.includes("EVIDENCE_BASE_CONFLICT"));
  const field = result.fields.find((f) => f.field === "underlying")!;
  assert.equal(field.baseValue, "SINGLE_STOCK");
  assert.equal(field.value, "UNKNOWN");
});
test("ENRICH-12 원본 동일 값은 근거 확인으로만 표시", () => {
  const input = sample();
  input.catalog.records[0]!.underlying = "INDEX";
  bind(input);
  assert.equal(
    soxl(input).fields.find((f) => f.field === "underlying")!.state,
    "CORROBORATED",
  );
});
test("ENRICH-13 심볼/기록 해시 불일치·잘못된 출처/필드 범위 보류", () => {
  for (const mutation of ["SYMBOL", "HASH", "SOURCE", "FIELD"]) {
    const input = sample();
    if (mutation === "SYMBOL") input.evidence[0]!.subject.symbol = "WRONG";
    if (mutation === "HASH")
      input.evidence[0]!.subject.baseRecordHash = "0".repeat(64);
    if (mutation === "SOURCE") input.evidence[0]!.sourceId = "UNREGISTERED";
    if (mutation === "FIELD") input.sources[0]!.allowedFields = ["leveraged"];
    const result = soxl(input);
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.facts!.underlying, "UNKNOWN");
    assert.ok(result.reasons.some((r) => r.startsWith("EVIDENCE_")));
  }
});
test("ENRICH-14 다른 시장/미등록 ID를 심볼만으로 합치거나 신규 종목으로 추가하지 않음", () => {
  const input = sample(),
    before = enrichCatalog(input);
  const orphan = extra(input);
  orphan.subject.market = "KR";
  const other = extra(input, { evidenceId: "TEST-ORPHAN" });
  other.subject.instrumentId = "UNREGISTERED";
  const result = enrichCatalog(input);
  assert.equal(result.decisionHash, before.decisionHash);
  assert.equal(result.diagnostics.orphanEvidence, 2);
});
test("ENRICH-15 원본 만료는 새 일부 근거로 갱신 처리하지 않음", () => {
  const input = sample();
  input.catalog.records[0]!.observedAt = "2026-09-09T06:00:00.000Z";
  bind(input);
  const result = soxl(input);
  assert.equal(result.facts!.underlying, "INDEX");
  assert.ok(result.reasons.includes("METADATA_STALE"));
  assert.equal(result.status, "REVIEW_REQUIRED");
});
test("ENRICH-16 원본 같은 ID 충돌과 기존 심볼 충돌을 보강으로 해제하지 않음", () => {
  const input = sample(),
    conflict = structuredClone(input.catalog.records[0]!);
  conflict.leveraged = false;
  input.catalog.records.push(conflict);
  assert.equal(soxl(input).facts, null);
  assert.ok(soxl(input).reasons.includes("RECORD_CONFLICT"));
  const collision = sample();
  collision.catalog.records[1]!.symbol = "SOXL";
  bind(collision);
  assert.ok(soxl(collision).reasons.includes("SYMBOL_COLLISION"));
});
test("ENRICH-17 거래소 보강 후 새로 생긴 심볼 충돌은 양쪽 모두 보류", () => {
  const input = sample();
  input.catalog.records[0]!.venue = null;
  input.catalog.records[1]!.symbol = "SOXL";
  input.sources[0]!.allowedFields.push("venue");
  extra(input, { field: "venue", value: "TEST-US" });
  bind(input);
  const result = enrichCatalog(input);
  for (const id of ["US:TEST-SOXL", "US:TEST-SOXX"])
    assert.ok(
      result.items
        .find((i) => i.key === id)!
        .reasons.includes("SYMBOL_COLLISION"),
    );
});
test("ENRICH-18 입력 순서/완전 중복/출처 필드 순서는 판단 불변·감사는 변화", () => {
  const input = sample(),
    before = enrichCatalog(input);
  input.evidence.push(structuredClone(input.evidence[0]!));
  input.evidence.reverse();
  input.catalog.records.reverse();
  input.sources.reverse();
  input.sources.forEach((s) => s.allowedFields.reverse());
  const after = enrichCatalog(input);
  assert.equal(after.decisionHash, before.decisionHash);
  assert.notEqual(after.inputHash, before.inputHash);
  assert.equal(after.diagnostics.duplicates, 1);
});
test("ENRICH-19 사용자 예탁금 3천만 원 경계·지수형 레버리지 별도 유지", () => {
  for (const value of [0, 29999999, 30000000, 30000001]) {
    const input = sample();
    Object.assign(input.evidence[6]!, { value });
    const item = enrichCatalog(input).items.find(
      (i) => i.key === "US:TEST-EXCLUDED",
    )!;
    assert.equal(
      item.status,
      value >= 30000000 ? "EXCLUDED" : "REVIEW_CANDIDATE",
    );
    assert.equal(soxl(input).status, "REVIEW_CANDIDATE");
  }
});
test("ENRICH-20 등록 출처 중복/상한·근거 행 상한·자료 형식 안전 정수 검사", () => {
  const duplicate = sample();
  duplicate.sources.push(structuredClone(duplicate.sources[0]!));
  assert.throws(() => enrichCatalog(duplicate), {
    code: "CATALOG_ENRICHMENT_INPUT_INVALID",
  });
  const many = sample();
  many.evidence = Array.from({ length: 50001 }, () => many.evidence[0]!);
  assert.throws(() => enrichCatalog(many), {
    code: "CATALOG_ENRICHMENT_INPUT_INVALID",
  });
  const bad = sample();
  bad.evidence[0]!.revision = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => enrichCatalog(bad), {
    code: "CATALOG_ENRICHMENT_INPUT_INVALID",
  });
});
test("ENRICH-21 증거가 없는 원본 판정 유지·빈 카탈로그 허용", () => {
  const input = sample();
  input.evidence = [];
  input.sources = [];
  assert.equal(enrichCatalog(input).counts.candidates, 0);
  input.catalog.records = [];
  assert.deepEqual(enrichCatalog(input).counts, {
    total: 0,
    candidates: 0,
    excluded: 0,
    reviewRequired: 0,
    enrichedFields: 0,
  });
});

test("ENRICH-22 원본과 일치/불일치가 섞인 출처도 입력 순서에 독립적", () => {
  const input = sample();
  input.catalog.records[0]!.underlying = "INDEX";
  extra(input, { sourceId: "TEST-SECOND-ISSUER", value: "SINGLE_STOCK" });
  bind(input);
  const first = enrichCatalog(input);
  input.evidence.reverse();
  const second = enrichCatalog(input);
  assert.equal(first.decisionHash, second.decisionHash);
  assert.ok(soxl(input).reasons.includes("EVIDENCE_BASE_CONFLICT"));
});

function venueCollisionInput() {
  const input = sample();
  input.catalog.records = input.catalog.records.slice(0, 2);
  input.catalog.records[1]!.symbol = "SOXL";
  input.catalog.records[1]!.venue = null;
  input.evidence = input.evidence.slice(0, 4);
  input.sources[0]!.allowedFields.push("venue");
  input.sources[2]!.allowedFields.push("venue");
  const venue = extra(input, {
    field: "venue",
    value: "TEST-US",
    evidenceId: "TEST-SECOND-VENUE",
  });
  venue.subject.instrumentId = "TEST-SOXX";
  return input;
}
test("ENRICH-23 거래소 모순으로 null이 돼도 원본 심볼 주장은 보존", () => {
  const input = venueCollisionInput();
  extra(input, { field: "venue", value: "TEST-OTHER" });
  bind(input);
  const result = enrichCatalog(input);
  assert.ok(
    result.items.every(
      (i) =>
        i.status === "REVIEW_REQUIRED" &&
        i.reasons.includes("SYMBOL_COLLISION"),
    ),
  );
});
test("ENRICH-24 원본에 없는 상충된 거래소 주장도 상대 종목 충돌 검사에 포함", () => {
  const input = venueCollisionInput();
  input.catalog.records[0]!.venue = "TEST-ORIGINAL";
  extra(input, {
    field: "venue",
    value: "TEST-US",
    sourceId: "TEST-SECOND-ISSUER",
  });
  bind(input);
  const result = enrichCatalog(input);
  assert.ok(result.items.every((i) => i.reasons.includes("SYMBOL_COLLISION")));
});
test("ENRICH-25 원본 ID 충돌의 모든 최신 심볼 주장과 새 보강 충돌 대조", () => {
  const input = venueCollisionInput();
  const conflict = structuredClone(input.catalog.records[0]!);
  conflict.venue = "TEST-OTHER";
  input.catalog.records.push(conflict);
  bind(input);
  const result = enrichCatalog(input);
  assert.ok(result.items.every((i) => i.reasons.includes("SYMBOL_COLLISION")));
  assert.equal(result.items.find((i) => i.key === "US:TEST-SOXL")!.facts, null);
});

test("ENRICH-26 미래/대체된 버전/식별 불일치 거래소 근거로 다른 종목을 충돌 처리하지 않음", () => {
  for (const mode of [
    "FUTURE",
    "SUPERSEDED",
    "WRONG_IDENTITY",
    "WRONG_SOURCE",
  ]) {
    const input = venueCollisionInput();
    input.catalog.records[0]!.venue = "TEST-ORIGINAL";
    const e = extra(input, { field: "venue", value: "TEST-US" });
    if (mode === "FUTURE") e.effectiveAt = "2026-09-11T07:00:00.001Z";
    if (mode === "SUPERSEDED")
      extra(input, {
        field: "venue",
        value: "TEST-ORIGINAL",
        revision: 2,
        evidenceId: "TEST-NEW-VENUE",
      });
    bind(input);
    if (mode === "WRONG_IDENTITY") e.subject.baseRecordHash = "0".repeat(64);
    if (mode === "WRONG_SOURCE") e.sourceId = "UNREGISTERED";
    const target = enrichCatalog(input).items.find(
      (i) => i.key === "US:TEST-SOXX",
    )!;
    assert.equal(target.status, "REVIEW_CANDIDATE");
    assert.ok(!target.reasons.includes("SYMBOL_COLLISION"));
  }
});
