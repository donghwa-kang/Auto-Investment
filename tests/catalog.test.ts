import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "../fixtures/catalog-v1.json" with { type: "json" };
import { classifyCatalog, type CatalogReason } from "../src/core/catalog.js";
import {
  parseCatalog,
  type CatalogRecord,
  MAX_CATALOG_RECORDS,
} from "../src/core/catalog-schema.js";

const parsed = parseCatalog(fixture);
const row = (patch: Partial<CatalogRecord> = {}): CatalogRecord => ({
  ...parsed.records[0]!,
  ...patch,
});
const run = (records: CatalogRecord[] = [row()], extra = {}) =>
  classifyCatalog({ ...parsed, records, ...extra });
const first = (patch: Partial<CatalogRecord>) => run([row(patch)]).items[0]!;

test("CAT-01 샘플의 KR/US 후보·제외·대기와 미래 자료 집계", () => {
  const result = classifyCatalog(fixture);
  assert.deepEqual(result.counts, {
    total: 7,
    candidates: 3,
    excluded: 2,
    reviewRequired: 2,
  });
  assert.equal(result.diagnostics.deferredRecords, 1);
  for (const symbol of ["SOXL", "SOXX"])
    assert.equal(
      result.items.find((item) => item.record?.symbol === symbol)?.status,
      "REVIEW_CANDIDATE",
    );
  assert.ok(!result.items.some((item) => item.key.includes("FUTURE")));
});
test("CAT-02 사용자 단일종목 레버리지 제외의 정확한 예탁금 경계", () => {
  for (const [deposit, status] of [
    [29999999, "REVIEW_CANDIDATE"],
    [30000000, "EXCLUDED"],
    [30000001, "EXCLUDED"],
    [null, "REVIEW_REQUIRED"],
  ] as const) {
    assert.equal(
      first({ underlying: "SINGLE_STOCK", requiredDepositKrw: deposit }).status,
      status,
    );
  }
  assert.equal(
    first({ underlying: "INDEX", requiredDepositKrw: 30000000 }).status,
    "REVIEW_CANDIDATE",
  );
  assert.equal(
    first({
      underlying: "SINGLE_STOCK",
      leveraged: false,
      requiredDepositKrw: null,
    }).status,
    "REVIEW_CANDIDATE",
  );
});
test("CAT-03 동일 심볼의 다른 시장과 다른 거래소는 합치지 않음", () => {
  const result = run([
    row(),
    row({ market: "KR", currency: "KRW" }),
    row({ instrumentId: "SECOND", venue: "TEST-OTHER" }),
  ]);
  assert.equal(result.counts.candidates, 3);
  assert.equal(new Set(result.items.map((item) => item.key)).size, 3);
});
test("CAT-04 동일 시장·거래소 심볼의 서로 다른 ID는 양쪽 모두 보류", () => {
  const result = run([row(), row({ instrumentId: "SECOND" })]);
  assert.equal(result.counts.reviewRequired, 2);
  assert.ok(
    result.items.every((item) => item.reasons.includes("SYMBOL_COLLISION")),
  );
});
test("CAT-05 정규화한 완전 중복은 하나로 합치고 판단 해시는 동일", () => {
  const a = row(),
    result = run([
      a,
      {
        ...a,
        symbol: " soxl ",
        venue: " test-us ",
        instrumentId: " TEST-SOXL ",
      },
    ]);
  assert.equal(result.diagnostics.duplicates, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.decisionHash, run([a]).decisionHash);
});
test("CAT-06 같은 최신 revision의 상충은 임의 선택하지 않음", () => {
  const result = run([row(), row({ leveraged: false })]);
  assert.equal(result.items[0]!.status, "REVIEW_REQUIRED");
  assert.equal(result.items[0]!.record, null);
  assert.deepEqual(result.items[0]!.reasons, ["RECORD_CONFLICT"]);
  assert.equal(
    run([row({ leveraged: false }), row()]).decisionHash,
    result.decisionHash,
  );
});
test("CAT-07 알려진 최신 정정 적용, 과거 좋은 값으로 대체하지 않음", () => {
  const result = run([row(), row({ revision: 2, underlying: "UNKNOWN" })]);
  assert.equal(result.items[0]!.record!.revision, 2);
  assert.equal(result.items[0]!.status, "REVIEW_REQUIRED");
});
test("CAT-08 미래 수신·효력의 정정은 이전 판단에 영향 없음", () => {
  const baseline = run();
  const variants = [
    row({
      revision: 2,
      availableAt: "2026-09-11T07:00:00.001Z",
      listingStatus: "DELISTED",
    }),
    row({
      revision: 2,
      effectiveAt: "2026-09-11T07:00:00.001Z",
      listingStatus: "DELISTED",
    }),
  ];
  for (const future of variants) {
    const result = run([row(), future]);
    assert.equal(result.decisionHash, baseline.decisionHash);
    assert.equal(result.diagnostics.deferredRecords, 1);
    assert.notEqual(result.inputHash, baseline.inputHash);
  }
});
test("CAT-09 미래에만 존재하는 종목은 과거 목록에 나타나지 않음", () => {
  const result = run([
    row(),
    row({ instrumentId: "FUTURE", availableAt: "2026-09-12T07:00:00.000Z" }),
  ]);
  assert.equal(result.decisionHash, run().decisionHash);
});
test("CAT-10 asOf와 같은 시각 자료·정정은 포함", () => {
  const result = run([
    row(),
    row({
      revision: 2,
      availableAt: parsed.asOf,
      effectiveAt: parsed.asOf,
      listingStatus: "HALTED",
    }),
  ]);
  assert.equal(result.items[0]!.status, "EXCLUDED");
  assert.equal(result.items[0]!.record!.revision, 2);
});
test("CAT-11 명시적 신선도 경계는 포함, 1ms 초과 시 보류", () => {
  const age = Date.parse(parsed.asOf) - Date.parse(row().observedAt);
  assert.equal(run([row()], { metadataMaxAgeMs: age }).counts.candidates, 1);
  assert.equal(
    run([row()], { metadataMaxAgeMs: age - 1 }).counts.reviewRequired,
    1,
  );
});
test("CAT-12 알 수 없는 필드는 사유 있는 확인 대기", () => {
  const cases: [Partial<CatalogRecord>, CatalogReason][] = [
    [{ market: "UNKNOWN" }, "MARKET_UNKNOWN"],
    [{ venue: null }, "VENUE_UNKNOWN"],
    [{ currency: "UNKNOWN" }, "CURRENCY_UNKNOWN"],
    [{ kind: "UNKNOWN" }, "KIND_UNKNOWN"],
    [{ underlying: "UNKNOWN" }, "UNDERLYING_UNKNOWN"],
    [{ leveraged: null }, "LEVERAGE_UNKNOWN"],
    [{ listingStatus: "UNKNOWN" }, "LISTING_UNKNOWN"],
    [{ brokerSupported: null }, "BROKER_SUPPORT_UNKNOWN"],
  ];
  for (const [patch, reason] of cases) {
    assert.equal(first(patch).status, "REVIEW_REQUIRED");
    assert.ok(first(patch).reasons.includes(reason));
  }
});
test("CAT-13 통화 불일치·상품 속성 모순 보류", () => {
  assert.ok(
    first({ market: "KR" }).reasons.includes("CURRENCY_MARKET_MISMATCH"),
  );
  assert.ok(
    first({ kind: "STOCK" }).reasons.includes("PRODUCT_FIELDS_CONFLICT"),
  );
  assert.equal(
    first({ kind: "STOCK", underlying: "SINGLE_STOCK", leveraged: false })
      .status,
    "REVIEW_CANDIDATE",
  );
});
test("CAT-14 거래정지·상장폐지·미지원·지원 상품군 밖 제외", () => {
  for (const patch of [
    { listingStatus: "HALTED" },
    { listingStatus: "DELISTED" },
    { brokerSupported: false },
    { kind: "OTHER" },
  ] as const)
    assert.equal(first(patch).status, "EXCLUDED");
});
test("CAT-15 여러 결측/제외 사유를 함께 남기되 후보로 승인하지 않음", () => {
  const result = first({
    listingStatus: "DELISTED",
    brokerSupported: null,
    currency: "KRW",
  });
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.deepEqual(result.reasons, [
    "BROKER_SUPPORT_UNKNOWN",
    "CURRENCY_MARKET_MISMATCH",
    "NOT_ACTIVE_LISTING",
  ]);
});
test("CAT-16 상충 기록의 심볼도 다른 ID와 충돌 검사", () => {
  const result = run([
    row(),
    row({ symbol: "OTHER" }),
    row({ instrumentId: "SECOND", symbol: "OTHER" }),
  ]);
  assert.equal(result.counts.reviewRequired, 2);
  assert.ok(
    result.items.every((item) => item.reasons.includes("SYMBOL_COLLISION")),
  );
});
test("CAT-17 입력 순서·표준 시간대 표현과 무관한 판단 재현", () => {
  const forward = classifyCatalog(fixture);
  const reverse = classifyCatalog({
    ...fixture,
    records: [...fixture.records].reverse(),
    asOf: "2026-09-11T16:00:00+09:00",
  });
  assert.equal(forward.decisionHash, reverse.decisionHash);
  assert.deepEqual(forward.items, reverse.items);
  assert.ok(
    forward.items.every(
      (item, index, items) => index === 0 || items[index - 1]!.key < item.key,
    ),
  );
});
test("CAT-18 빈 목록·최초 미래 목록을 억지로 채우지 않음", () => {
  assert.equal(run([]).counts.total, 0);
  assert.equal(
    run([row({ effectiveAt: "2027-01-01T00:00:00.000Z" })]).counts.total,
    0,
  );
});
test("CAT-19 잘못된 입력·과대 수·누락·알 수 없는 필드 거절", () => {
  for (const raw of [
    null,
    {},
    { ...parsed, purpose: "REAL" },
    { ...parsed, metadataMaxAgeMs: 0 },
    { ...parsed, clientSecret: "DUMMY_DO_NOT_ECHO" },
    { ...parsed, records: [{ ...row(), revision: 0 }] },
    {
      ...parsed,
      records: [{ ...row(), requiredDepositKrw: Number.MAX_SAFE_INTEGER + 1 }],
    },
    { ...parsed, records: [{ ...row(), leveraged: "false" }] },
    { ...parsed, records: [{ ...row(), venue: undefined }] },
    { ...parsed, records: [{ ...row(), instrumentId: "../bad" }] },
  ])
    assert.throws(
      () => classifyCatalog(raw),
      /^CatalogError: CATALOG_INPUT_INVALID$/,
    );
});
test("CAT-20 날짜·출처 시간 역전·시간대 누락 거절", () => {
  for (const patch of [
    { observedAt: "not-a-date" },
    { observedAt: "2026-09-11T06:00:02Z" },
    { availableAt: "2026-09-11T05:00:00Z" },
    { effectiveAt: "2026-09-11T06:00:00" },
  ])
    assert.throws(() => run([row(patch)]), /CATALOG_INPUT_INVALID/);
});
test("CAT-21 자료 상한 초과 거절, ID 특수 이름은 Map에서 안전하게 분리", () => {
  assert.throws(
    () => run(Array.from({ length: MAX_CATALOG_RECORDS + 1 }, () => row())),
    /CATALOG_INPUT_INVALID/,
  );
  assert.equal(first({ instrumentId: "__proto__" }).status, "REVIEW_CANDIDATE");
});
test("CAT-22 후보가 많아도 투자 순위/100개 목록을 임의 생성하지 않음", () => {
  const result = run(
    Array.from({ length: 101 }, (_, index) =>
      row({ instrumentId: `ID-${index}`, symbol: `SYMBOL-${index}` }),
    ),
  );
  assert.equal(result.counts.candidates, 101);
  assert.equal(result.selectionPerformed, false);
  assert.equal(result.strategyEvaluated, false);
  assert.equal(result.ordersEnabled, false);
  assert.equal(result.liveEnabled, false);
  assert.ok(result.pendingChecks.includes("PRICE_HISTORY_TURNOVER_SPREAD"));
});
test("CAT-23 호출 입력은 변경하지 않음, 설정·판단 해시 결합", () => {
  const original = structuredClone(fixture);
  const result = classifyCatalog(original);
  assert.deepEqual(original, fixture);
  assert.notEqual(
    result.decisionHash,
    classifyCatalog({ ...original, metadataMaxAgeMs: 100 }).decisionHash,
  );
  assert.match(result.policyHash, /^[A-F0-9]{64}$/);
  assert.match(result.researchScopeHash, /^[a-f0-9]{64}$/);
});

test("CAT-24 밀리초 미만 미래 시각을 절삭해 포함하지 않음", () => {
  assert.throws(
    () => run([row({ availableAt: "2026-09-11T07:00:00.0001Z" })]),
    /CATALOG_INPUT_INVALID/,
  );
  assert.throws(
    () => run([row()], { asOf: "2026-09-11T07:00:00.0001Z" }),
    /CATALOG_INPUT_INVALID/,
  );
});
