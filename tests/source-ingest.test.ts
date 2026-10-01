import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hash } from "../src/core/policy.js";
import { ingestMockSource } from "../src/core/source-ingest.js";
import {
  parseSourceInput,
  type SourceCapture,
} from "../src/core/source-ingest-schema.js";

const sample = () =>
  parseSourceInput(
    JSON.parse(readFileSync("fixtures/source-ingest-v1.json", "utf8")),
  );
type Obj = Record<string, unknown>;
const obj = (x: unknown) => x as Obj;
const body = (c: SourceCapture) => obj(obj(c.response).result);
const rows = (c: SourceCapture) => obj(c.response).result as Obj[];
const bars = (c: SourceCapture) => body(c).candles as Obj[];
const capture = (s: ReturnType<typeof sample>, id: string) =>
  s.captures.find((c) => c.captureId === id)!;
const normalized = (s: ReturnType<typeof sample>, id: string) =>
  ingestMockSource(s).captures.find((c) => c.captureId === id)!;
function blocked(s: ReturnType<typeof sample>, id: string, reason: string) {
  const c = normalized(s, id);
  assert.equal(c.status, "BLOCKED");
  assert.ok(
    [...c.reasons, ...c.observations.flatMap((r) => r.reasons)].includes(
      reason,
    ),
    JSON.stringify(c.reasons),
  );
}
function pageReason(s: ReturnType<typeof sample>, reason: string) {
  const report = ingestMockSource(s),
    page = report.pagePlans[0]!;
  assert.equal(report.status, "HAS_BLOCKS");
  assert.equal(page.status, "INCOMPLETE");
  assert.ok(page.reasons.includes(reason), JSON.stringify(page.reasons));
  return page;
}

test("INGEST-01 8종 형식·모의 창·승인 불가·재현·입력 미변경", () => {
  const s = sample(),
    before = structuredClone(s),
    r = ingestMockSource(s);
  assert.equal(r.status, "MOCK_TRANSFORM_COMPLETE");
  assert.deepEqual(r.counts, {
    captures: 9,
    observations: 11,
    blocked: 0,
    duplicates: 1,
    pagePlans: 1,
  });
  assert.equal(
    new Set(
      [...r.captures, ...r.pagePlans[0]!.captures].map((c) => c.request.kind),
    ).size,
    8,
  );
  assert.equal(r.pagePlans[0]!.status, "MOCK_WINDOW_COVERED");
  assert.equal(r.pagePlans[0]!.observedSlots, 3);
  for (const v of [
    r.realDataReady,
    r.strategyReady,
    r.strategyEvaluated,
    r.paperOrdersEnabled,
    r.liveEnabled,
    r.historicalPointInTimeVerified,
    r.corporateActionsVerified,
  ])
    assert.equal(v, false);
  assert.equal(r.networkRequests, 0);
  const { reportHash, ...content } = r;
  assert.equal(hash(content), reportHash);
  assert.equal(ingestMockSource(s).reportHash, reportHash);
  assert.deepEqual(s, before);
});
test("INGEST-02 원시 오프셋·UTC·수신/사용 가능 시각·미확인 메타데이터 보존", () => {
  const r = normalized(sample(), "prices").observations[0]!;
  assert.equal(r.sourceTimestampRaw, "2026-09-14T22:33:01+09:00");
  assert.equal(r.eventAt, "2026-09-14T13:33:01.000Z");
  assert.equal(r.receivedAt, "2026-09-14T13:33:01.000Z");
  assert.equal(r.availableAt, "2026-09-14T13:33:02.000Z");
  assert.equal(r.sourcePublishedAt, null);
  assert.equal(r.sourceRevision, null);
  assert.equal(r.identity.executionVenue, null);
  assert.equal(r.identity.basis, "REQUEST_CONTEXT_UNVERIFIED");
  assert.equal(r.data!.lastPrice, "101");
});
test("INGEST-03 종목 종료/지표 시작 봉 시각과 지표 POINTS 분리", () => {
  const r = ingestMockSource(sample()),
    stock = r.pagePlans[0]!.captures[0]!.observations[0]!,
    index = r.captures.find((c) => c.captureId === "indicator")!
      .observations[0]!;
  assert.equal(stock.data!.openAt, "2026-09-14T13:32:00.000Z");
  assert.equal(stock.data!.closeAt, "2026-09-14T13:33:00.000Z");
  assert.equal(stock.data!.timestampConvention, "CLOSE");
  assert.equal(stock.data!.priceBasis, "RAW_REQUESTED");
  assert.equal(index.data!.openAt, "2026-09-14T00:00:00.000Z");
  assert.equal(index.data!.closeAt, "2026-09-14T00:01:00.000Z");
  assert.equal(index.data!.unit, "POINTS");
  assert.equal(index.identity.currency, null);
  assert.equal(stock.data!.halted, null);
});
test("INGEST-04 배수 정보만으로 단일종목/예탁금/매매 자격 승인하지 않음", () => {
  const r = normalized(sample(), "detail").observations[0]!;
  assert.equal(r.data!.leverageFactor, "3");
  assert.equal(r.data!.underlying, "UNKNOWN");
  assert.equal(r.data!.requiredDepositKrw, null);
  assert.equal(r.data!.corporateActionStatus, "UNKNOWN");
  assert.equal(r.data!.sourceEffectiveAt, null);
  assert.equal(r.identity.marketSegment, "NASDAQ");
});
for (const [name, mutate] of [
  [
    "REAL 출처",
    (s: Obj) => {
      s.dataOrigin = "REAL";
    },
  ],
  [
    "승인 목적",
    (s: Obj) => {
      s.purpose = "REAL_REFERENCE_SNAPSHOT";
    },
  ],
  [
    "미확인 버전",
    (s: Obj) => {
      s.sourceSpecVersion = "99.0.0";
    },
  ],
  [
    "알 수 없는 키",
    (s: Obj) => {
      s.extra = true;
    },
  ],
  [
    "밀리초 초과",
    (s: Obj) => {
      s.asOf = "2026-09-14T13:33:02.0001Z";
    },
  ],
  [
    "인증 키",
    (s: Obj) => {
      obj((s.captures as SourceCapture[])[0]!.response).authorization =
        "FAKE_ONLY";
    },
  ],
] as const)
  test(`INGEST-INPUT ${name} 거절`, () => {
    const s = sample();
    mutate(obj(s));
    assert.throws(() => ingestMockSource(s), /INGEST_INPUT_INVALID/);
  });
test("INGEST-05 입력 순서·중복 ID·통화·페이지 자원 상한 거절", () => {
  for (const edit of [
    (s: ReturnType<typeof sample>) => {
      s.captures[0]!.receivedAt = "2026-09-14T13:32:00Z";
    },
    (s: ReturnType<typeof sample>) => {
      s.captures[0]!.captureId = "detail";
    },
    (s: ReturnType<typeof sample>) => {
      obj(s.pagePlans[0]!.request).adjusted = true;
    },
    (s: ReturnType<typeof sample>) => {
      obj(s.pagePlans[0]!.request).interval = "1d";
    },
    (s: ReturnType<typeof sample>) => {
      s.pagePlans[0]!.maxPages = 51;
    },
    (s: ReturnType<typeof sample>) => {
      obj(obj(s.pagePlans[0]!.request).target).currency = "KRW";
    },
  ]) {
    const s = sample();
    edit(s);
    assert.throws(() => ingestMockSource(s), /INGEST_INPUT_INVALID/);
  }
});
test("INGEST-06 전체 행 상한·크기 상한", () => {
  const s = sample();
  const listing = rows(capture(s, "listing"))[0];
  obj(capture(s, "listing").response).result = Array.from(
    { length: 10001 },
    () => listing,
  );
  assert.throws(() => ingestMockSource(s), /INGEST_ROW_LIMIT/);
  const large = sample();
  capture(large, "listing").response = "x".repeat(16 * 1024 * 1024);
  assert.throws(() => ingestMockSource(large), /INGEST_INPUT_INVALID/);
});
test("INGEST-07 응답 미허용 필드·숫자/지수 형식은 원문 출력 없이 차단", () => {
  for (const value of [101, "1e2", "NaN", "Infinity"]) {
    const s = sample();
    rows(capture(s, "prices"))[0]!.lastPrice = value;
    blocked(s, "prices", "PAYLOAD_INVALID");
  }
  const s = sample();
  rows(capture(s, "prices"))[0]!.unlisted = "FAKE_PRIVATE_SENTINEL";
  assert.ok(
    !JSON.stringify(ingestMockSource(s)).includes("FAKE_PRIVATE_SENTINEL"),
  );
  assert.equal(normalized(s, "prices").observations[0]!.data, null);
});
test("INGEST-08 시각 누락은 현재 시각으로 메우지 않음", () => {
  for (const value of [null, undefined]) {
    const s = sample();
    rows(capture(s, "prices"))[0]!.timestamp = value;
    blocked(s, "prices", "SOURCE_TIMESTAMP_MISSING");
    assert.equal(normalized(s, "prices").observations[0]!.eventAt, null);
  }
});
test("INGEST-09 미래 시각·수신 이후 자료·미완성 지표 봉 차단", () => {
  const s = sample();
  capture(s, "prices").availableAt = "2026-09-14T13:33:03Z";
  blocked(s, "prices", "CAPTURE_NOT_AVAILABLE_AS_OF");
  const future = sample();
  rows(capture(future, "prices"))[0]!.timestamp = "2026-09-14T13:33:02Z";
  blocked(future, "prices", "SOURCE_TIME_AFTER_RECEIPT");
  const index = sample();
  bars(capture(index, "indicator"))[0]!.timestamp = "2026-09-14T13:33:00Z";
  blocked(index, "indicator", "BAR_NOT_CLOSED");
});
test("INGEST-10 요청 밖/누락 종목·상세 시장/통화 불일치 차단", () => {
  const s = sample();
  rows(capture(s, "prices"))[0]!.symbol = "OTHER";
  blocked(s, "prices", "UNREQUESTED_SYMBOL");
  blocked(s, "prices", "REQUESTED_SYMBOL_MISSING");
  const detail = sample();
  rows(capture(detail, "detail"))[0]!.market = "KOSPI";
  blocked(detail, "detail", "DETAIL_MARKET_MISMATCH");
  const price = sample();
  rows(capture(price, "prices"))[0]!.currency = "KRW";
  blocked(price, "prices", "CURRENCY_MISMATCH");
});
test("INGEST-11 잘못된 앞 행이 정상 뒤 행의 개별 사유를 오염시키지 않음", () => {
  const s = sample(),
    c = capture(s, "prices");
  rows(c).unshift({ symbol: "BAD" });
  const r = normalized(s, "prices");
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.observations[0]!.status, "BLOCKED");
  assert.equal(r.observations[1]!.status, "MOCK_PARSED");
});
test("INGEST-12 호가 2초 경계와 2.001초 만료", () => {
  const s = sample();
  body(capture(s, "book")).timestamp = "2026-09-14T13:33:00Z";
  assert.equal(normalized(s, "book").status, "MOCK_PARSED");
  s.asOf = "2026-09-14T13:33:02.001Z";
  blocked(s, "book", "QUOTE_STALE");
});
test("INGEST-13 호가 정렬·빈 호가·교차·음수 수량 차단", () => {
  const s = sample();
  body(capture(s, "book")).asks = [
    { price: "110", volume: "10" },
    { price: "101.1", volume: "10" },
    { price: "99", volume: "0" },
  ];
  assert.equal(normalized(s, "book").observations[0]!.data!.bestAsk, "101.1");
  const empty = sample();
  body(capture(empty, "book")).asks = [{ price: "101.1", volume: "0" }];
  blocked(empty, "book", "EMPTY_ORDERBOOK");
  const crossed = sample();
  body(capture(crossed, "book")).bids = [{ price: "200", volume: "1" }];
  blocked(crossed, "book", "CROSSED_ORDERBOOK");
  const negative = sample();
  body(capture(negative, "book")).asks = [{ price: "101.1", volume: "-1" }];
  blocked(negative, "book", "VALUE_INVALID");
});
test("INGEST-14 잘못된 OHLCV/분 경계/요청 before 차단", () => {
  const s = sample();
  bars(capture(s, "indicator"))[0]!.highPrice = "98";
  blocked(s, "indicator", "OHLCV_INVALID");
  const aligned = sample();
  bars(capture(aligned, "indicator"))[0]!.timestamp = "2026-09-14T00:00:01Z";
  blocked(aligned, "indicator", "BAR_ALIGNMENT_INVALID");
  const bound = sample();
  obj(capture(bound, "indicator").request).before = "2026-09-13T00:00:00Z";
  blocked(bound, "indicator", "BEFORE_BOUND_EXCEEDED");
});
test("INGEST-15 동일 관측 중복은 보존·연결하고 값 변경은 모든 버전 보류", () => {
  const s = sample(),
    duplicate = structuredClone(capture(s, "prices"));
  duplicate.captureId = "prices-duplicate";
  duplicate.availableAt = "2026-09-14T13:33:02.001Z";
  s.asOf = duplicate.availableAt;
  s.captures.push(duplicate);
  assert.equal(
    normalized(s, "prices-duplicate").observations[0]!.duplicateOf,
    "prices.0",
  );
  rows(duplicate)[0]!.lastPrice = "102";
  const r = ingestMockSource(s),
    both = r.captures.filter((c) => c.captureId.startsWith("prices"));
  assert.deepEqual(
    both.map((c) => c.observations[0]!.localObservationVersion),
    [1, 2],
  );
  for (const c of both)
    assert.ok(
      c.observations[0]!.reasons.includes("SOURCE_REVISION_UNVERIFIED"),
    );
  assert.deepEqual(
    both.map((c) => c.observations[0]!.data!.lastPrice),
    ["101", "102"],
  );
});
test("INGEST-16 미래에 사용 가능한 변경 관측은 과거 정상 행을 오염시키지 않음", () => {
  const s = sample(),
    future = structuredClone(capture(s, "prices"));
  future.captureId = "prices-future";
  future.availableAt = "2026-09-14T13:33:03Z";
  rows(future)[0]!.lastPrice = "200";
  s.captures.push(future);
  assert.equal(normalized(s, "prices").status, "MOCK_PARSED");
  blocked(s, "prices-future", "CAPTURE_NOT_AVAILABLE_AS_OF");
});
test("INGEST-17 KR 동시호가 경계·US 날짜 넘김 보존, 거래 세션 승인 아님", () => {
  const s = sample(),
    kr = normalized(s, "calendar-kr").observations[0]!.data!;
  assert.equal(
    obj(obj(obj(kr.today).integrated).regularMarket)
      .singlePriceAuctionStartTime,
    "2026-09-14T15:20:00+09:00",
  );
  assert.equal(
    kr.sessionInterpretation,
    "PROVIDER_SESSIONS_NOT_APPROVED_STRATEGY_WINDOW",
  );
  assert.equal(normalized(s, "calendar-us").status, "MOCK_PARSED");
});
test("INGEST-18 달력 누락과 명시적 null 구분", () => {
  const s = sample();
  delete obj(body(capture(s, "calendar-kr")).today).integrated;
  blocked(s, "calendar-kr", "SESSION_FIELD_MISSING");
  obj(body(capture(s, "calendar-kr")).today).integrated = null;
  assert.equal(normalized(s, "calendar-kr").status, "MOCK_PARSED");
  const us = sample();
  delete obj(body(capture(us, "calendar-us")).today).preMarket;
  blocked(us, "calendar-us", "SESSION_FIELD_MISSING");
});
test("INGEST-19 달력 날짜·겹침·동시호가 범위 오류 차단", () => {
  const s = sample();
  obj(body(capture(s, "calendar-us")).today).date = "2026-09-13";
  blocked(s, "calendar-us", "CALENDAR_DATE_MISMATCH");
  const overlap = sample();
  obj(body(capture(overlap, "calendar-us")).today).preMarket = {
    startTime: "2026-09-14T13:00:00Z",
    endTime: "2026-09-14T14:00:00Z",
  };
  blocked(overlap, "calendar-us", "SESSION_ORDER_INVALID");
  const auction = sample();
  obj(
    obj(obj(body(capture(auction, "calendar-kr")).today).integrated)
      .regularMarket,
  ).singlePriceAuctionStartTime = "2026-09-14T16:00:00+09:00";
  blocked(auction, "calendar-kr", "AUCTION_BOUNDARY_INVALID");
});
test("INGEST-20 미국 겨울시각은 고정 UTC 차감 없이 현지 날짜로 검증", () => {
  const s = sample(),
    c = capture(s, "calendar-us");
  c.request = { kind: "CALENDAR_US", date: "2026-12-14" };
  for (const [key, date] of [
    ["today", "2026-12-14"],
    ["previousBusinessDay", "2026-12-11"],
    ["nextBusinessDay", "2026-12-15"],
  ]) {
    body(c)[key!] = {
      date,
      dayMarket: null,
      preMarket: null,
      regularMarket: {
        startTime: `${date}T09:30:00-05:00`,
        endTime: `${date}T16:00:00-05:00`,
      },
      afterMarket: null,
    };
  }
  assert.equal(normalized(s, "calendar-us").status, "MOCK_PARSED");
});
test("INGEST-PAGE-01 inclusive 중복 경계와 2회 소비", () => {
  const p = ingestMockSource(sample()).pagePlans[0]!;
  assert.equal(p.attempts, 2);
  assert.equal(p.unusedMockReplies, 0);
  assert.equal(p.stop, "WINDOW_REACHED");
  assert.equal(p.captures[1]!.observations[0]!.duplicateOf, "stock-page-1.1");
  assert.equal(p.realHistoryCoverageVerified, false);
});
test("INGEST-PAGE-02 예산은 추가 응답이 있어도 초과하지 않음", () => {
  const s = sample();
  s.pagePlans[0]!.maxPages = 1;
  const p = pageReason(s, "PAGE_BUDGET_EXHAUSTED");
  assert.equal(p.attempts, 1);
  assert.equal(p.unusedMockReplies, 1);
});
test("INGEST-PAGE-03 HTTP 429/timeout은 시도에 남고 후속 응답은 소비하지 않음", () => {
  for (const timeout of [false, true]) {
    const s = sample(),
      c = s.pagePlans[0]!.replies[0]!;
    c.outcome = timeout ? "TIMEOUT" : "RESPONSE";
    c.httpStatus = timeout ? null : 429;
    c.response = timeout ? null : { privateError: "FAKE_PRIVATE_ERROR" };
    const p = pageReason(s, "PAGE_DATA_BLOCKED");
    assert.equal(p.attempts, 1);
    assert.equal(p.unusedMockReplies, 1);
    assert.ok(
      p.captures[0]!.reasons.includes(
        timeout ? "MOCK_TIMEOUT" : "MOCK_HTTP_FAILURE",
      ),
    );
    assert.ok(!JSON.stringify(p).includes("FAKE_PRIVATE_ERROR"));
  }
});
test("INGEST-PAGE-04 커서 누락·미래 커서 거절", () => {
  const s = sample();
  delete body(s.pagePlans[0]!.replies[0]!).nextBefore;
  pageReason(s, "CURSOR_MISSING");
  const forward = sample();
  body(forward.pagePlans[0]!.replies[0]!).nextBefore = "2026-09-14T13:34:00Z";
  pageReason(forward, "CURSOR_NOT_PROGRESSING");
});
test("INGEST-PAGE-05 빈 페이지의 종료·미해결과 실제 공백을 구분", () => {
  for (const cursor of [null, "2026-09-14T13:32:00Z", undefined]) {
    const s = sample();
    body(s.pagePlans[0]!.replies[0]!).candles = [];
    body(s.pagePlans[0]!.replies[0]!).nextBefore = cursor;
    const p = pageReason(s, "WINDOW_GAPS");
    assert.equal(p.stop, cursor === null ? "SOURCE_EXHAUSTED" : "BLOCKED");
    if (cursor !== null) assert.ok(p.reasons.includes("EMPTY_PAGE_UNRESOLVED"));
  }
});
test("INGEST-PAGE-06 내림차순·응답 요청·응답 순서 불일치 차단", () => {
  const s = sample();
  bars(s.pagePlans[0]!.replies[0]!).reverse();
  pageReason(s, "PAGE_ORDER_INVALID");
  const request = sample();
  obj(request.pagePlans[0]!.replies[1]!.request).before = null;
  pageReason(request, "PAGE_REQUEST_MISMATCH");
  const order = sample();
  order.pagePlans[0]!.replies[1]!.requestedAt = "2026-09-14T13:33:00Z";
  pageReason(order, "PAGE_CAPTURE_ORDER_INVALID");
});
test("INGEST-PAGE-07 겹친 페이지만 반복하거나 커서 반복 시 중단", () => {
  const s = sample();
  body(s.pagePlans[0]!.replies[1]!).candles = [
    bars(s.pagePlans[0]!.replies[1]!)[0],
  ];
  pageReason(s, "PAGE_NO_PROGRESS");
  const cursor = sample();
  body(cursor.pagePlans[0]!.replies[1]!).nextBefore = "2026-09-14T13:32:00Z";
  pageReason(cursor, "CURSOR_NOT_PROGRESSING");
});
test("INGEST-PAGE-08 빠진 응답·미완성 창·요청 분 공백 차단", () => {
  const missing = sample();
  missing.pagePlans[0]!.replies.pop();
  pageReason(missing, "MOCK_REPLY_MISSING");
  const future = sample();
  future.pagePlans[0]!.windowTo = "2026-09-14T13:34:00Z";
  assert.equal(pageReason(future, "WINDOW_NOT_CLOSED").attempts, 0);
  const gaps = sample();
  bars(gaps.pagePlans[0]!.replies[1]!)[1]!.timestamp = "2026-09-14T13:30:00Z";
  assert.deepEqual(pageReason(gaps, "WINDOW_GAPS").missing, [
    "2026-09-14T13:30:00.000Z",
  ]);
});
test("INGEST-PAGE-09 페이지 간 동일 봉 변경은 원본 둘을 보존·보류", () => {
  const s = sample();
  bars(s.pagePlans[0]!.replies[1]!)[0]!.closePrice = "102";
  const p = pageReason(s, "PAGE_DATA_BLOCKED");
  assert.ok(
    p.captures[0]!.observations[1]!.reasons.includes(
      "SOURCE_REVISION_UNVERIFIED",
    ),
  );
  assert.equal(p.captures[0]!.observations[1]!.data!.closePrice, "101");
  assert.equal(p.captures[1]!.observations[0]!.data!.closePrice, "102");
});
test("INGEST-PAGE-10 직접 입력과 페이지 사이 상충도 창 승인으로 우회 못함", () => {
  const s = sample(),
    direct = structuredClone(s.pagePlans[0]!.replies[0]!);
  direct.captureId = "direct-conflict";
  bars(direct)[0]!.closePrice = "102";
  s.captures.push(direct);
  const p = pageReason(s, "GLOBAL_OBSERVATION_BLOCKED");
  assert.ok(
    p.captures[0]!.observations[0]!.reasons.includes(
      "SOURCE_REVISION_UNVERIFIED",
    ),
  );
});
