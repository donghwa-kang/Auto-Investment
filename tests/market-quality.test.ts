import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkMarketQuality,
  qualityReasons,
} from "../src/core/market-quality.js";
import {
  parseMarketQuality,
  type QualityInput,
  type QualityRecord,
} from "../src/core/market-quality-schema.js";
import { hash, policy, spec } from "../src/core/policy.js";

const fixture = () =>
  JSON.parse(
    readFileSync("fixtures/market-quality-v1.json", "utf8"),
  ) as QualityInput;
const iso = (at: number) => new Date(at).toISOString();
const item = (input: QualityInput, key = "TEST-KR") =>
  checkMarketQuality(input).items.find((x) => x.assetKey === key)!;
const row = (
  input: QualityInput,
  kind: QualityRecord["kind"],
  key = "TEST-KR",
) => input.records.find((x) => x.assetKey === key && x.kind === kind)!;
function reason(input: QualityInput, code: string, key = "TEST-KR") {
  const result = item(input, key);
  assert.equal(result.status, "BLOCKED");
  assert.ok(
    result.reasons.includes(code),
    `${code}: ${result.reasons.join(",")}`,
  );
}
function moveObservation(record: QualityRecord, at: number) {
  record.observedAt = iso(at);
  record.receivedAt = iso(at + 100);
  record.availableAt = iso(at + 200);
}

test("QUALITY-01 KR/US·벤치마크 4개 합성 창 정상, 매매/실자료 승격 없음", () => {
  const result = checkMarketQuality(fixture());
  assert.equal(result.status, "TEST_WINDOW_VALID");
  assert.deepEqual(result.counts, { assets: 4, valid: 4, blocked: 0 });
  for (const entry of result.items) {
    assert.equal(entry.expectedBars, 3);
    assert.equal(entry.validBars, 3);
    assert.equal(entry.totalVolume, "3000");
    assert.deepEqual(entry.reasons, []);
  }
  assert.equal(result.realDataReady, false);
  assert.equal(result.strategyReady, false);
  assert.equal(result.strategyEvaluated, false);
  assert.equal(result.selectionPerformed, false);
  assert.equal(result.paperOrdersEnabled, false);
  assert.equal(result.liveEnabled, false);
  assert.equal(result.splitAdjustmentPerformed, false);
  assert.equal(result.sourceAuthentication, "UNVERIFIED_TEST_INPUT");
  assert.ok(
    result.pendingChecks.includes("FULL_WARMUP_AND_INDICATOR_PRECISION"),
  );
  assert.equal(spec.input_contract.warmup_sessions, 120);
  assert.equal(policy.execution.maximum_quote_age_seconds, 2);
});
test("QUALITY-02 입력/정책 보존·직접 호출 재현성", () => {
  const input = fixture(),
    before = structuredClone(input),
    original = hash({ policy, spec });
  assert.deepEqual(checkMarketQuality(input), checkMarketQuality(input));
  assert.deepEqual(input, before);
  assert.equal(hash({ policy, spec }), original);
});
test("QUALITY-03 엄격한 모드/형식·잘못된 소수·시각 오류는 원문 없이 거절", () => {
  const bad: unknown[] = [
    null,
    {},
    { ...fixture(), purpose: "REAL_DATA" },
    { ...fixture(), secret: "FAKE_SECRET_DO_NOT_PRINT" },
  ];
  for (const value of [
    "NaN",
    "Infinity",
    "1e3",
    "0xFF",
    "1.1234567890123",
    "9".repeat(19),
    100,
  ]) {
    const input = fixture(),
      price = row(input, "PRICE");
    bad.push({ ...input, records: [{ ...price, price: value }] });
  }
  for (const value of [
    "2026-09-11T01:03:01",
    "2026-09-11T01:03:01.0001Z",
    "2026-02-30T01:03:01Z",
  ])
    bad.push({ ...fixture(), asOf: value });
  for (const value of bad)
    assert.throws(() => checkMarketQuality(value), {
      message: "MARKET_QUALITY_INPUT_INVALID",
    });
});
test("QUALITY-04 수신/이용 시간 역전·비정수 revision 거절", () => {
  for (const mutate of [
    (r: QualityRecord) => {
      r.receivedAt = iso(Date.parse(r.observedAt) - 1);
    },
    (r: QualityRecord) => {
      r.availableAt = iso(Date.parse(r.receivedAt) - 1);
    },
    (r: QualityRecord) => {
      r.revision = 0;
    },
    (r: QualityRecord) => {
      r.revision = Number.MAX_SAFE_INTEGER + 1;
    },
  ]) {
    const input = fixture();
    mutate(input.records[0]!);
    assert.throws(
      () => checkMarketQuality(input),
      /MARKET_QUALITY_INPUT_INVALID/,
    );
  }
});
test("QUALITY-05 미래 정정/관측은 판단에서 제외·현재 판단 해시 불변", () => {
  const input = fixture(),
    original = checkMarketQuality(input),
    future = structuredClone(row(input, "PRICE"));
  future.revision++;
  future.recordId = "FUTURE";
  future.availableAt = iso(Date.parse(input.asOf) + 1);
  if (future.kind === "PRICE") future.price = null;
  input.records.push(future);
  const quote = structuredClone(row(input, "QUOTE"));
  moveObservation(quote, Date.parse(input.asOf) + 1);
  input.records.push(quote);
  const result = checkMarketQuality(input);
  assert.equal(result.decisionHash, original.decisionHash);
  assert.notEqual(result.inputHash, original.inputHash);
  assert.equal(result.diagnostics.deferredRecords, 2);
});
test("QUALITY-06 asOf와 같은 이용 가능 시점 포함, 1ms 미래 필수 봉은 누락", () => {
  const input = fixture(),
    target = row(input, "BAR");
  target.availableAt = input.asOf;
  assert.equal(item(input).status, "TEST_WINDOW_VALID");
  target.availableAt = iso(Date.parse(input.asOf) + 1);
  reason(input, "BAR_MISSING");
});
test("QUALITY-07 순서/출처 종류 순서/완전 중복 불변 및 감사 해시 구분", () => {
  const input = fixture(),
    original = checkMarketQuality(input);
  input.records.reverse();
  input.assets.reverse();
  input.sources[0]!.kinds.reverse();
  input.records.push(structuredClone(input.records[0]!));
  const result = checkMarketQuality(input);
  assert.equal(result.decisionHash, original.decisionHash);
  assert.notEqual(result.inputHash, original.inputHash);
  assert.equal(result.diagnostics.duplicates, 1);
});
test("QUALITY-08 최신 동일 revision 상충은 순서와 무관하게 보류", () => {
  for (const kind of ["BAR", "PRICE", "QUOTE"] as const) {
    const input = fixture(),
      conflict = structuredClone(row(input, kind));
    conflict.recordId = "DIFFERENT-PROVENANCE";
    input.records.push(conflict);
    reason(input, "REVISION_CONFLICT");
    const before = checkMarketQuality(input).decisionHash;
    input.records.reverse();
    assert.equal(checkMarketQuality(input).decisionHash, before);
  }
});
test("QUALITY-09 최신 결측/잘못된 값/거래정지/출처 오류를 이전 좋은 값으로 복원하지 않음", () => {
  for (const change of ["null", "negative", "halted", "source"] as const) {
    const input = fixture(),
      correction = structuredClone(row(input, "BAR"));
    assert.equal(correction.kind, "BAR");
    if (correction.kind !== "BAR") return;
    correction.revision++;
    if (change === "null") correction.c = null;
    if (change === "negative") correction.v = "-1";
    if (change === "halted") correction.halted = true;
    if (change === "source") correction.sourceId = "UNKNOWN-FEED";
    input.records.push(correction);
    reason(
      input,
      change === "halted"
        ? "BAR_INCOMPLETE_OR_HALTED"
        : change === "source"
          ? "SOURCE_MISMATCH"
          : "OHLCV_INVALID",
    );
    assert.equal(item(input).validBars, 2);
  }
});
test("QUALITY-10 높은 정정 버전으로 동일 사건 상충을 해소", () => {
  const input = fixture(),
    initial = row(input, "BAR"),
    conflict = structuredClone(initial);
  conflict.recordId = "CONFLICT";
  input.records.push(conflict);
  const correction = structuredClone(initial);
  correction.revision++;
  correction.recordId = "CORRECTION";
  input.records.push(correction);
  assert.equal(item(input).status, "TEST_WINDOW_VALID");
  assert.equal(
    item(input).selected.filter((x) => x.record.recordId === "CORRECTION")
      .length,
    1,
  );
});
test("QUALITY-11 가격/호가는 가장 최근 사건 우선, 오래된 사건의 높은 revision은 대체 못함", () => {
  for (const kind of ["PRICE", "QUOTE"] as const) {
    const input = fixture(),
      old = structuredClone(row(input, kind));
    old.revision = 999;
    moveObservation(old, Date.parse(old.observedAt) - 5000);
    if (old.kind === "PRICE") old.price = "-1";
    if (old.kind === "QUOTE") old.askSize = null;
    const before = checkMarketQuality(input).decisionHash;
    input.records.push(old);
    assert.equal(checkMarketQuality(input).decisionHash, before);
  }
});
test("QUALITY-12 최신 가격/호가 정정이 결측이면 이전 사건으로 대체하지 않음", () => {
  for (const kind of ["PRICE", "QUOTE"] as const) {
    const input = fixture(),
      latest = structuredClone(row(input, kind));
    moveObservation(latest, Date.parse(latest.observedAt) + 500);
    if (latest.kind === "PRICE") latest.price = null;
    if (latest.kind === "QUOTE") latest.bid = null;
    input.records.push(latest);
    reason(input, kind === "PRICE" ? "PRICE_INVALID" : "QUOTE_INVALID");
  }
});
test("QUALITY-13 원본 호가 2초 경계 포함/1ms 초과 보류, 수신 시각으로 신선도 갱신 금지", () => {
  const input = fixture(),
    quote = row(input, "QUOTE"),
    at = Date.parse(input.asOf);
  moveObservation(quote, at - 2000);
  quote.availableAt = input.asOf;
  assert.equal(item(input).status, "TEST_WINDOW_VALID");
  quote.observedAt = iso(at - 2001);
  reason(input, "QUOTE_STALE");
});
test("QUALITY-14 가격/시간 창 시험 신선도 경계 및 누락 프로필 보류", () => {
  for (const field of ["lastPriceMaxAgeMs", "windowEndMaxAgeMs"] as const) {
    const input = fixture();
    input.profile[field] = 1000;
    assert.equal(item(input).status, "TEST_WINDOW_VALID");
    input.profile[field] = 999;
    reason(
      input,
      field === "lastPriceMaxAgeMs" ? "PRICE_STALE" : "WINDOW_STALE",
    );
    input.profile[field] = null;
    reason(input, "PROFILE_MISSING");
  }
});
test("QUALITY-15 빈 자료/필수 종류 누락은 명시적 보류", () => {
  const input = fixture();
  input.records = [];
  for (const code of [
    "BAR_MISSING",
    "PRICE_MISSING",
    "QUOTE_MISSING",
    "BENCHMARK_DATA_BLOCKED",
  ])
    reason(input, code);
});
test("QUALITY-16 완료 표시/정지 UNKNOWN·미완성 봉·관측 시각 오류", () => {
  for (const flag of [
    "incomplete",
    "haltedUnknown",
    "observedBeforeClose",
    "length",
  ] as const) {
    const input = fixture(),
      bar = row(input, "BAR");
    if (bar.kind !== "BAR") return;
    if (flag === "incomplete") bar.completed = false;
    if (flag === "haltedUnknown") bar.halted = null;
    if (flag === "observedBeforeClose")
      bar.observedAt = iso(Date.parse(bar.closeAt) - 1);
    if (flag === "length") bar.closeAt = iso(Date.parse(bar.openAt) + 59000);
    reason(
      input,
      flag === "incomplete" || flag === "haltedUnknown"
        ? "BAR_INCOMPLETE_OR_HALTED"
        : "BAR_TIME_INVALID",
    );
  }
});
test("QUALITY-17 비정렬 여분 봉/다른 세션/빠진 봉은 완전한 창으로 승인하지 않음", () => {
  const input = fixture(),
    extra = structuredClone(row(input, "BAR"));
  if (extra.kind !== "BAR") return;
  extra.openAt = iso(Date.parse(extra.openAt) + 500);
  extra.closeAt = iso(Date.parse(extra.closeAt) + 500);
  moveObservation(extra, Date.parse(extra.closeAt));
  input.records.push(extra);
  reason(input, "BAR_TIME_INVALID");
  const other = fixture(),
    bar = row(other, "BAR");
  if (bar.kind !== "BAR") return;
  bar.sessionId = "OTHER";
  reason(other, "BAR_TIME_INVALID");
  other.records = other.records.filter((r) => r !== bar);
  reason(other, "BAR_MISSING");
});
test("QUALITY-18 OHLC 범위/0 가격/음수 거래량·소수 경계의 정확 비교", () => {
  for (const change of ["high", "low", "zero", "volume", "decimal"] as const) {
    const input = fixture(),
      bar = row(input, "BAR");
    if (bar.kind !== "BAR") return;
    if (change === "high") bar.h = "100";
    if (change === "low") bar.l = "101";
    if (change === "zero") bar.o = "0";
    if (change === "volume") bar.v = "-0.000000000001";
    if (change === "decimal") {
      bar.o = "100.000000000001";
      bar.h = "100";
    }
    reason(input, "OHLCV_INVALID");
  }
});
test("QUALITY-19 거래량 0인 개별 봉 허용·창 합계 0 보류·벤치마크 보류 전파", () => {
  const input = fixture(),
    first = row(input, "BAR");
  if (first.kind !== "BAR") return;
  first.v = "0";
  assert.equal(item(input).status, "TEST_WINDOW_VALID");
  for (const bar of input.records)
    if (bar.assetKey === "TEST-KR-BENCH" && bar.kind === "BAR") bar.v = "0";
  reason(input, "ZERO_WINDOW_VOLUME", "TEST-KR-BENCH");
  reason(input, "BENCHMARK_DATA_BLOCKED");
});
test("QUALITY-20 교차 호가/양수 잔량·양수 가격 검사, 같은 매수매도 호가는 허용", () => {
  const input = fixture(),
    quote = row(input, "QUOTE");
  if (quote.kind !== "QUOTE") return;
  quote.bid = quote.ask;
  assert.equal(item(input).status, "TEST_WINDOW_VALID");
  quote.bid = "102";
  reason(input, "QUOTE_INVALID");
  quote.bid = "100";
  quote.askSize = "0";
  reason(input, "QUOTE_INVALID");
  quote.askSize = "1";
  quote.ask = "0";
  reason(input, "QUOTE_INVALID");
});
test("QUALITY-21 식별/통화/출처 연결 검사 및 종류 권한 미등록 보류", () => {
  const input = fixture();
  row(input, "PRICE").identity.instrumentId = "WRONG";
  reason(input, "IDENTITY_MISMATCH");
  const currency = fixture();
  currency.assets[0]!.identity.currency = "USD";
  reason(currency, "CURRENCY_MISMATCH");
  const source = fixture();
  source.assets[0]!.sourceId = null;
  reason(source, "SOURCE_UNREGISTERED");
  const kind = fixture();
  kind.sources[0]!.kinds = ["BAR", "PRICE"];
  reason(kind, "SOURCE_UNREGISTERED");
});
test("QUALITY-22 같은 ID 또는 같은 거래소 심볼의 다른 자산 키 충돌", () => {
  for (const exact of [true, false]) {
    const input = fixture(),
      duplicate = structuredClone(input.assets[0]!);
    duplicate.assetKey = "OTHER-KEY";
    if (!exact) duplicate.identity.instrumentId = "OTHER-ID";
    input.assets.push(duplicate);
    reason(input, "IDENTITY_COLLISION");
    reason(input, "IDENTITY_COLLISION", "OTHER-KEY");
  }
});
test("QUALITY-23 다른 시장/거래소 심볼은 충돌로 합치지 않음", () => {
  const input = fixture();
  for (const asset of input.assets) asset.identity.symbol = "SHARED";
  input.assets[1]!.identity.venue = "OTHER-KR";
  input.assets[3]!.identity.venue = "OTHER-US";
  for (const record of input.records)
    record.identity = structuredClone(
      input.assets.find((a) => a.assetKey === record.assetKey)!.identity,
    );
  assert.equal(checkMarketQuality(input).status, "TEST_WINDOW_VALID");
});
test("QUALITY-24 없는 대상·요구 밖 과거 봉·미래 봉은 판단을 바꾸지 않음", () => {
  const input = fixture(),
    before = checkMarketQuality(input).decisionHash;
  const orphan = structuredClone(row(input, "PRICE"));
  orphan.assetKey = "NOT-REQUESTED";
  input.records.push(orphan);
  const old = structuredClone(row(input, "BAR"));
  if (old.kind !== "BAR") return;
  old.openAt = iso(Date.parse(old.openAt) - 60000);
  old.closeAt = iso(Date.parse(old.closeAt) - 60000);
  input.records.push(old);
  const future = structuredClone(old);
  future.openAt = input.asOf;
  future.closeAt = iso(Date.parse(input.asOf) + 60000);
  input.records.push(future);
  const result = checkMarketQuality(input);
  assert.equal(result.decisionHash, before);
  assert.equal(result.diagnostics.orphanRecords, 1);
  assert.equal(result.diagnostics.outsideWindowRecords, 1);
  assert.equal(result.diagnostics.deferredRecords, 1);
});
test("QUALITY-25 세션/창 범위·정렬·미래 창·빈 창 보류", () => {
  for (const mutate of [
    (a: QualityInput["assets"][number]) => {
      a.session = null;
    },
    (a: QualityInput["assets"][number]) => {
      a.session!.availableAt = "2026-09-12T00:00:00Z";
    },
    (a: QualityInput["assets"][number]) => {
      a.windowTo = a.windowFrom;
    },
    (a: QualityInput["assets"][number]) => {
      a.windowFrom = iso(Date.parse(a.windowFrom) + 1);
    },
    (a: QualityInput["assets"][number]) => {
      a.windowTo = "2026-09-11T01:04:00Z";
    },
    (a: QualityInput["assets"][number]) => {
      a.session!.closeAt = a.windowFrom;
    },
  ]) {
    const input = fixture();
    mutate(input.assets[0]!);
    assert.equal(item(input).status, "BLOCKED");
  }
});
test("QUALITY-26 기업행동 미확인/미래/분할 필요 상태에서 RAW를 신호 조정 완료로 승격하지 않음", () => {
  for (const status of [
    null,
    "UNKNOWN",
    "ADJUSTMENT_REQUIRED",
    "FUTURE",
  ] as const) {
    const input = fixture();
    input.assets[0]!.actionContext =
      status === null
        ? null
        : {
            status: status === "FUTURE" ? "NO_ACTIONS_IN_WINDOW" : status,
            availableAt:
              status === "FUTURE" ? "2026-09-12T00:00:00Z" : input.asOf,
          };
    reason(input, "ACTION_CONTEXT_UNRESOLVED");
  }
  for (const kind of ["BAR", "PRICE", "QUOTE"] as const) {
    const input = fixture();
    row(input, kind).basis = "ADJUSTED";
    reason(input, "BASIS_NOT_RAW");
  }
});
test("QUALITY-27 매핑 누락/없는 벤치마크/다른 창/자기 매핑 보류", () => {
  for (const key of [null, "MISSING", "TEST-KR"] as const) {
    const input = fixture();
    input.assets[0]!.benchmarkKey = key;
    reason(input, "BENCHMARK_MAPPING_MISSING");
  }
  const different = fixture();
  different.assets[1]!.windowFrom = "2026-09-11T01:01:00Z";
  reason(different, "BENCHMARK_MAPPING_MISSING");
});
test("QUALITY-28 계약 중복·자원/정밀도 상한 거절", () => {
  const duplicateAsset = fixture();
  duplicateAsset.assets.push(structuredClone(duplicateAsset.assets[0]!));
  const duplicateSource = fixture();
  duplicateSource.sources.push(structuredClone(duplicateSource.sources[0]!));
  const duplicateKind = fixture();
  duplicateKind.sources[0]!.kinds.push("BAR");
  const rows = fixture();
  rows.records = Array(50001).fill(rows.records[0]!);
  const windows = fixture();
  windows.assets[0]!.windowTo = "2027-09-11T01:00:00Z";
  const empty = fixture();
  empty.assets = [];
  for (const input of [
    duplicateAsset,
    duplicateSource,
    duplicateKind,
    rows,
    windows,
    empty,
  ])
    assert.throws(
      () => checkMarketQuality(input),
      /MARKET_QUALITY_INPUT_INVALID/,
    );
});
test("QUALITY-29 정규화한 시간대·소수 표현이 같은 판단을 재현", () => {
  const input = fixture(),
    before = checkMarketQuality(input).decisionHash;
  input.asOf = "2026-09-11T10:03:01+09:00";
  const price = row(input, "PRICE");
  if (price.kind !== "PRICE") return;
  price.price = "00101.0000";
  assert.equal(checkMarketQuality(input).decisionHash, before);
  assert.equal(parseMarketQuality(input).asOf, "2026-09-11T01:03:01.000Z");
});
test("QUALITY-30 보류 사유 모두 설명 제공·계약 변화는 판단 해시 변경", () => {
  const input = fixture(),
    before = checkMarketQuality(input).decisionHash;
  input.records = [];
  input.assets[0]!.actionContext = null;
  for (const entry of checkMarketQuality(input).items)
    for (const code of entry.reasons) assert.ok(qualityReasons[code], code);
  const changed = fixture();
  changed.profile.profileId = "DIFFERENT-ASSUMPTION";
  assert.notEqual(checkMarketQuality(changed).decisionHash, before);
});
