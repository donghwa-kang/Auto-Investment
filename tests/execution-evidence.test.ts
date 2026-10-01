import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  reviewMockExecutionEvidence,
  type ExecutionEvidenceInput,
} from "../src/core/execution-evidence.js";
import {
  bookRow,
  parseSourceInput,
  singleEnvelope,
  type SourceCapture,
} from "../src/core/source-ingest-schema.js";
import { d } from "../src/core/math.js";
import { hash } from "../src/core/policy.js";
import { inspectOfflineGraph } from "./network-boundary.js";

type Book = ReturnType<typeof bookRow.parse>;
function sourceFixture() {
  return parseSourceInput(
    JSON.parse(readFileSync("fixtures/source-ingest-v1.json", "utf8")),
  );
}
function updateBook(capture: SourceCapture, update: (book: Book) => void) {
  const book = bookRow.parse(singleEnvelope.parse(capture.response).result);
  update(book);
  capture.response = { result: book };
}
function fixture(market: "KR" | "US" = "US"): ExecutionEvidenceInput {
  const sourceInput = sourceFixture();
  const capture = sourceInput.captures.find(
    (entry) => entry.request.kind === "ORDERBOOK",
  )!;
  const currency = market === "KR" ? "KRW" : "USD";
  capture.request = {
    kind: "ORDERBOOK",
    target: { symbol: "TEST", market, currency },
  };
  updateBook(capture, (book) => {
    book.currency = currency;
    book.asks = [{ price: market === "KR" ? "10000" : "100", volume: "10" }];
    book.bids = [{ price: market === "KR" ? "9990" : "99.99", volume: "10" }];
  });
  sourceInput.captures = [capture];
  sourceInput.pagePlans = [];
  return {
    schemaVersion: "OFFLINE_EXECUTION_EVIDENCE_V1",
    purpose: "TEST_ONLY",
    target: {
      instrumentId: `${market}-TEST`,
      market,
      symbol: "TEST",
      venue: market === "KR" ? "KRX" : "NASDAQ",
      currency,
    },
    illustrativeQuantity: 4,
    tickSpec: {
      evidenceId: "synthetic-tick-contract",
      availableAt: "2026-09-14T00:00:00Z",
      effectiveFrom: "2026-09-14T00:00:00Z",
      effectiveUntil: "2026-09-15T00:00:00Z",
      priceFrom: "1",
      priceUntil: "1000000",
      tickSize: market === "KR" ? "10" : "0.01",
      lotSize: 1,
    },
    sourceInput,
  };
}
const first = (input: ExecutionEvidenceInput) => input.sourceInput.captures[0]!;
function row(input: ExecutionEvidenceInput) {
  return reviewMockExecutionEvidence(input).rows[0]!;
}
function tickReason(input: ExecutionEvidenceInput, reason: string) {
  const report = reviewMockExecutionEvidence(input);
  assert.equal(report.status, "HAS_BLOCKS");
  assert.equal(report.rows[0]!.tick, null);
  assert.ok(report.rows[0]!.tickReasons.includes(reason));
}
function blocked(input: ExecutionEvidenceInput, reason: string) {
  const report = reviewMockExecutionEvidence(input);
  assert.equal(report.status, "HAS_BLOCKS");
  assert.equal(report.rows[0]!.status, "BLOCKED");
  assert.equal(report.rows[0]!.quote, null);
  assert.equal(report.rows[0]!.tick, null);
  assert.ok(report.rows[0]!.reasons.includes(reason));
}

test("EVIDENCE-01 KR 원화 스프레드·틱의 단위와 수량별 절대 금액", () => {
  const report = reviewMockExecutionEvidence(fixture("KR"));
  assert.equal(report.status, "MOCK_DIAGNOSTIC_COMPLETE");
  assert.equal(report.target.currency, "KRW");
  assert.equal(
    report.rows[0]!.quote!.spreadBps,
    "10.00500250125062531265632816408204102051",
  );
  assert.deepEqual(report.rows[0]!.tick, {
    oneTickPerShare: "10",
    oneTickForQuantity: "40",
    entryNotional: "40000",
    oneTickBps: "10",
    roundTripOneTickPerSideBps: "20",
  });
});

test("EVIDENCE-02 US 달러 수치에 원화 환산·수수료를 임의 혼합하지 않는다", () => {
  const report = reviewMockExecutionEvidence(fixture());
  assert.equal(report.status, "MOCK_DIAGNOSTIC_COMPLETE");
  assert.equal(report.target.currency, "USD");
  assert.equal(
    report.rows[0]!.quote!.spreadBps,
    "1.000050002500125006250312515625781289064",
  );
  assert.deepEqual(report.rows[0]!.tick, {
    oneTickPerShare: "0.01",
    oneTickForQuantity: "0.04",
    entryNotional: "400",
    oneTickBps: "1",
    roundTripOneTickPerSideBps: "2",
  });
});

test("EVIDENCE-03 qδ의 절대비용은 증가하지만 qδ/(qP)는 수량과 무관하다", () => {
  const one = fixture("KR"),
    eight = fixture("KR");
  one.illustrativeQuantity = 1;
  eight.illustrativeQuantity = 8;
  const a = row(one).tick!,
    b = row(eight).tick!;
  assert.equal(a.oneTickForQuantity, "10");
  assert.equal(b.oneTickForQuantity, "80");
  assert.equal(a.oneTickBps, b.oneTickBps);
  assert.equal(
    d(a.oneTickForQuantity).div(a.entryNotional).toString(),
    "0.001",
  );
  assert.equal(
    d(b.oneTickForQuantity).div(b.entryNotional).toString(),
    "0.001",
  );
});

test("EVIDENCE-04 짝수 중앙값과 p95 nearest-rank를 원본 수치로 확인", () => {
  const input = fixture();
  const template = first(input);
  const base = Date.parse("2026-09-14T13:33:00Z");
  input.tickSpec = null;
  input.sourceInput.captures = Array.from({ length: 20 }, (_, index) => {
    const n = index + 1,
      capture = structuredClone(template);
    capture.captureId = `book-${n}`;
    capture.requestedAt = new Date(base + n * 1000).toISOString();
    capture.receivedAt = new Date(base + n * 1000 + n * 10).toISOString();
    capture.availableAt = new Date(
      base + n * 1000 + n * 10 + 100,
    ).toISOString();
    updateBook(capture, (book) => {
      book.timestamp = capture.receivedAt;
      book.bids[0]!.price = String(1000 - n / 2);
      book.asks[0]!.price = String(1000 + n / 2);
    });
    return capture;
  }).reverse();
  input.sourceInput.asOf = new Date(base + 30000).toISOString();
  const report = reviewMockExecutionEvidence(input);
  assert.deepEqual(report.spreadBps, {
    count: 20,
    min: "10",
    median: "105",
    p95: "190",
    max: "200",
  });
  assert.deepEqual(report.responseIntervalMs, {
    count: 20,
    min: "10",
    median: "105",
    p95: "190",
    max: "200",
  });
  assert.equal(
    report.distributionMethod,
    "MEDIAN_AVERAGE_EVEN_P95_NEAREST_RANK_NO_INTERPOLATION",
  );
});

test("EVIDENCE-05 정상 진단도 수집·실보정·학습·실거래 승인이 아니다", () => {
  const report = reviewMockExecutionEvidence(fixture());
  for (const value of [
    report.collectionAuthorized,
    report.realCalibrationReady,
    report.engineProfileApplied,
    report.learningEligible,
    report.liveEnabled,
  ])
    assert.equal(value, false);
  for (const value of [
    report.feeEstimate,
    report.orderLatencyEstimate,
    report.cancellationLatencyEstimate,
  ])
    assert.equal(value, null);
  assert.equal(report.purpose, "TEST_ONLY");
  assert.ok(
    report.limitations.includes("REQUEST_INTERVAL_IS_NOT_ORDER_LATENCY"),
  );
  assert.ok(report.limitations.includes("SOURCE_IDENTITY_NOT_ATTESTED"));
});

test("EVIDENCE-06 입력 미변경·재현성과 입력/보고서 해시 결합", () => {
  const input = fixture(),
    original = structuredClone(input);
  const report = reviewMockExecutionEvidence(input);
  const { reportHash, ...body } = report;
  assert.deepEqual(input, original);
  assert.equal(report.inputHash, hash(input));
  assert.equal(reportHash, hash(body));
  assert.equal(reviewMockExecutionEvidence(input).reportHash, reportHash);
  input.illustrativeQuantity = 5;
  const changed = reviewMockExecutionEvidence(input);
  assert.notEqual(changed.inputHash, report.inputHash);
  assert.notEqual(changed.reportHash, reportHash);
});

test("EVIDENCE-07 실자료 표기·알 수 없는 필드·잘못된 통화·수량 입력 거절", () => {
  const input = fixture();
  const invalid = [
    { ...input, purpose: "REAL_CALIBRATION" },
    { ...input, collectionAuthorized: true },
    { ...input, target: { ...input.target, currency: "KRW" } },
    { ...input, illustrativeQuantity: 0 },
    { ...input, illustrativeQuantity: 1.5 },
    {
      ...input,
      sourceInput: { ...input.sourceInput, dataOrigin: "REAL_RESPONSE" },
    },
    { ...input, sourceInput: { ...input.sourceInput, purpose: "REAL_DATA" } },
    { ...input, tickSpec: { ...input.tickSpec, approved: true } },
  ];
  for (const candidate of invalid)
    assert.throws(
      () => reviewMockExecutionEvidence(candidate),
      /EXECUTION_EVIDENCE_INPUT_INVALID/,
    );
});

test("EVIDENCE-08 응답 통화가 요청 통화와 다르면 수치 진단 차단", () => {
  const input = fixture();
  updateBook(first(input), (book) => {
    book.currency = "KRW";
  });
  blocked(input, "CURRENCY_MISMATCH");
});

test("EVIDENCE-09 미래 수신의 payload 변경은 현재 통계에 영향을 주지 않는다", () => {
  const input = fixture();
  const future = structuredClone(first(input));
  future.captureId = "future-book";
  future.availableAt = "2026-09-14T13:33:03Z";
  input.sourceInput.captures.push(future);
  const before = reviewMockExecutionEvidence(input);
  updateBook(future, (book) => {
    book.asks[0]!.price = "900000";
    book.currency = "KRW";
  });
  const after = reviewMockExecutionEvidence(input);
  assert.equal(before.counts.futureUnavailable, 1);
  assert.equal(before.counts.quoteObservations, 1);
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.spreadBps, before.spreadBps);
  assert.deepEqual(after.responseIntervalMs, before.responseIntervalMs);
  assert.notEqual(after.inputHash, before.inputHash);
});

test("EVIDENCE-10 나중 보고 시점으로 정상 과거 수신을 stale 처리하지 않는다", () => {
  const input = fixture();
  input.sourceInput.asOf = "2026-09-15T13:33:02Z";
  const report = reviewMockExecutionEvidence(input);
  assert.equal(report.status, "MOCK_DIAGNOSTIC_COMPLETE");
  assert.equal(report.counts.quoteObservations, 1);
  assert.equal(report.rows[0]!.quote!.providerReportedAgeMs, 0);
});

test("EVIDENCE-11 가용시각에서 정확히 2초는 통과하고 2초 초과는 차단", () => {
  const input = fixture(),
    capture = first(input);
  capture.availableAt = "2026-09-14T13:33:03Z";
  input.sourceInput.asOf = "2026-09-14T13:33:04Z";
  assert.equal(row(input).status, "MOCK_OBSERVATION");
  capture.availableAt = "2026-09-14T13:33:03.001Z";
  blocked(input, "QUOTE_STALE");
});

test("EVIDENCE-12 동일 관측의 재수신은 스프레드 표본을 중복 가중하지 않는다", () => {
  const input = fixture(),
    duplicate = structuredClone(first(input));
  duplicate.captureId = "book-copy";
  input.sourceInput.captures.push(duplicate);
  const report = reviewMockExecutionEvidence(input);
  assert.equal(report.counts.duplicates, 1);
  assert.equal(report.counts.quoteObservations, 1);
  assert.equal(report.spreadBps!.count, 1);
  assert.equal(report.responseIntervalMs!.count, 2);
  const retained = report.rows.find(
    (entry) => entry.status === "MOCK_OBSERVATION",
  )!;
  const repeated = report.rows.find((entry) => entry.status === "DUPLICATE")!;
  assert.ok(retained);
  assert.ok(repeated);
  assert.equal(retained.duplicateOf, null);
  assert.equal(repeated.duplicateOf, `${retained.captureId}.0`);
  assert.equal(repeated.quote, null);
  assert.equal(repeated.tick, null);
  // 동일 가용시각의 primary는 기존 변환기의 관측 ID 정렬 계약을 따른다.
  // 배열의 입력 순서를 바꾸어도 primary와 중복 관계는 바뀌지 않는다.
  input.sourceInput.captures.reverse();
  const reversed = reviewMockExecutionEvidence(input);
  const byCaptureId = (a: typeof retained, b: typeof retained) =>
    a.captureId.localeCompare(b.captureId, "en");
  assert.deepEqual(
    [...reversed.rows].sort(byCaptureId),
    [...report.rows].sort(byCaptureId),
  );
  assert.deepEqual(reversed.counts, report.counts);
  assert.deepEqual(reversed.spreadBps, report.spreadBps);
  assert.deepEqual(reversed.responseIntervalMs, report.responseIntervalMs);
  assert.deepEqual(reversed.timeoutIntervalMs, report.timeoutIntervalMs);
  assert.deepEqual(
    reversed.providerReportedAgeMs,
    report.providerReportedAgeMs,
  );
});

test("EVIDENCE-13 동일 종목·동일 원천시각 상충은 최신값으로 덮지 않는다", () => {
  const input = fixture(),
    conflicting = structuredClone(first(input));
  conflicting.captureId = "book-revised";
  updateBook(conflicting, (book) => {
    book.asks[0]!.price = "101";
  });
  input.sourceInput.captures.push(conflicting);
  const report = reviewMockExecutionEvidence(input);
  assert.equal(report.counts.blocked, 2);
  assert.equal(report.counts.quoteObservations, 0);
  assert.equal(report.spreadBps, null);
  for (const entry of report.rows)
    assert.ok(entry.reasons.includes("SOURCE_REVISION_UNVERIFIED"));
});

test("EVIDENCE-14 HTTP 실패도 응답 분포에 포함하고 timeout 분포는 분리", () => {
  const input = fixture(),
    error = structuredClone(first(input)),
    timeout = structuredClone(first(input));
  error.captureId = "http-error";
  error.httpStatus = 503;
  error.receivedAt = "2026-09-14T13:33:02Z";
  error.response = { error: "MOCK_UNAVAILABLE" };
  timeout.captureId = "timeout";
  timeout.outcome = "TIMEOUT";
  timeout.httpStatus = null;
  timeout.response = null;
  timeout.receivedAt = "2026-09-14T13:33:05Z";
  timeout.availableAt = timeout.receivedAt;
  input.sourceInput.captures.push(error, timeout);
  input.sourceInput.asOf = timeout.availableAt;
  const report = reviewMockExecutionEvidence(input);
  assert.deepEqual(report.counts, {
    requestedBooks: 3,
    futureUnavailable: 0,
    ignoredNonBookCaptures: 0,
    quoteObservations: 1,
    blocked: 2,
    duplicates: 0,
    timeouts: 1,
  });
  assert.deepEqual(report.responseIntervalMs, {
    count: 2,
    min: "1000",
    median: "1500",
    p95: "2000",
    max: "2000",
  });
  assert.deepEqual(report.timeoutIntervalMs, {
    count: 1,
    min: "5000",
    median: "5000",
    p95: "5000",
    max: "5000",
  });
  assert.equal(report.orderLatencyEstimate, null);
});

test("EVIDENCE-15 다른 종목 호가는 차단하고 비호가 캡처는 통계에서 제외", () => {
  const input = fixture(),
    capture = first(input);
  assert.equal(capture.request.kind, "ORDERBOOK");
  if (capture.request.kind !== "ORDERBOOK") throw new Error("TEST_KIND");
  capture.request.target.symbol = "OTHER";
  blocked(input, "TARGET_MISMATCH");
  input.sourceInput.captures = sourceFixture().captures.filter(
    (c) => c.request.kind !== "ORDERBOOK",
  );
  const report = reviewMockExecutionEvidence(input);
  assert.equal(report.counts.ignoredNonBookCaptures, 6);
  assert.equal(report.counts.requestedBooks, 0);
  assert.equal(report.spreadBps, null);
  assert.equal(report.status, "HAS_BLOCKS");
});

test("EVIDENCE-16 미확인 틱 규격에서 가격 스프레드만 보고 틱 비용은 추측하지 않음", () => {
  const input = fixture();
  input.tickSpec = null;
  tickReason(input, "TICK_SPEC_UNKNOWN");
  assert.notEqual(row(input).quote, null);
});

test("EVIDENCE-17 틱 근거 가용시각과 시행기간 경계는 관측 당시로 판정", () => {
  const future = fixture();
  future.tickSpec!.availableAt = "2026-09-14T13:33:02.001Z";
  tickReason(future, "TICK_SPEC_NOT_YET_AVAILABLE");
  const from = fixture();
  from.tickSpec!.effectiveFrom = "2026-09-14T13:33:01Z";
  assert.notEqual(row(from).tick, null);
  from.tickSpec!.effectiveFrom = "2026-09-14T13:33:01.001Z";
  tickReason(from, "TICK_SPEC_NOT_EFFECTIVE");
  const until = fixture();
  until.tickSpec!.effectiveUntil = "2026-09-14T13:33:01Z";
  tickReason(until, "TICK_SPEC_NOT_EFFECTIVE");
});

test("EVIDENCE-18 양쪽 가격 모두 반개구간 틱 가격대 안에 있어야 한다", () => {
  const lower = fixture();
  lower.tickSpec!.priceFrom = "100";
  tickReason(lower, "TICK_PRICE_BAND_MISMATCH");
  const upper = fixture();
  upper.tickSpec!.priceUntil = "100";
  tickReason(upper, "TICK_PRICE_BAND_MISMATCH");
  const exact = fixture();
  exact.tickSpec!.priceFrom = "99.99";
  exact.tickSpec!.priceUntil = "100.01";
  assert.notEqual(row(exact).tick, null);
});

test("EVIDENCE-19 틱/로트 배수가 맞지 않으면 임의 반올림하지 않는다", () => {
  const tick = fixture();
  updateBook(first(tick), (book) => {
    book.asks[0]!.price = "100.005";
  });
  tickReason(tick, "OFF_TICK_PRICE");
  const lot = fixture();
  lot.tickSpec!.lotSize = 3;
  tickReason(lot, "OFF_LOT_QUANTITY");
  assert.equal(lot.illustrativeQuantity, 4);
});

test("EVIDENCE-20 최우선 호가의 양쪽 표시 잔량을 따로 검사한다", () => {
  for (const side of ["asks", "bids"] as const) {
    const input = fixture();
    updateBook(first(input), (book) => {
      book[side][0]!.volume = "3";
      book[side].push({ price: side === "asks" ? "101" : "99", volume: "100" });
    });
    tickReason(
      input,
      `${side === "asks" ? "ASK" : "BID"}_DISPLAYED_DEPTH_INSUFFICIENT`,
    );
    assert.notEqual(row(input).quote, null);
  }
  const exact = fixture();
  exact.illustrativeQuantity = 10;
  assert.notEqual(row(exact).tick, null);
});

test("EVIDENCE-21 동일 최우선 가격의 중복 레벨을 임의 합산하지 않는다", () => {
  for (const side of ["asks", "bids"] as const) {
    const input = fixture();
    updateBook(first(input), (book) => {
      book[side].push({ ...book[side][0]! });
    });
    tickReason(input, `${side === "asks" ? "ASK" : "BID"}_LEVEL_AMBIGUOUS`);
  }
});

test("EVIDENCE-22 공식처럼 보이는 출처 이름·시장 메타데이터도 권한 증거가 아님", () => {
  const input = fixture();
  input.tickSpec!.evidenceId = "KRX-OFFICIAL-CONTRACT";
  const report = reviewMockExecutionEvidence(input);
  assert.equal(report.sourceSpecVersion, "1.2.17");
  assert.equal(report.collectionAuthorized, false);
  assert.equal(report.realCalibrationReady, false);
  assert.ok(
    report.limitations.includes(
      "G1_RIGHTS_COST_AND_USER_APPROVAL_NOT_VERIFIED",
    ),
  );
  assert.ok(report.limitations.includes("G2_REAL_DATA_ACCEPTANCE_NOT_RUN"));
});

test("EVIDENCE-23 페이지 수집·인증 필드·역전된 시각은 조용히 무시하지 않는다", () => {
  const pages = fixture();
  pages.sourceInput.pagePlans = sourceFixture().pagePlans;
  const secret = fixture();
  first(secret).response = {
    result: { api_key: "TEST_ONLY_NOT_A_CREDENTIAL" },
  };
  const time = fixture();
  first(time).receivedAt = "2026-09-14T13:32:59Z";
  for (const input of [pages, secret, time])
    assert.throws(
      () => reviewMockExecutionEvidence(input),
      /EXECUTION_EVIDENCE_INPUT_INVALID/,
    );
});

test("EVIDENCE-24 원천 시각 누락·미래·빈/교차 호가는 원래 변환기 차단 유지", () => {
  const scenarios: [string, (book: Book) => void][] = [
    [
      "SOURCE_TIMESTAMP_MISSING",
      (book) => {
        book.timestamp = null;
      },
    ],
    [
      "SOURCE_TIME_AFTER_RECEIPT",
      (book) => {
        book.timestamp = "2026-09-14T13:33:01.001Z";
      },
    ],
    [
      "EMPTY_ORDERBOOK",
      (book) => {
        book.asks = [];
      },
    ],
    [
      "CROSSED_ORDERBOOK",
      (book) => {
        book.bids[0]!.price = "101";
      },
    ],
  ];
  for (const [reason, mutate] of scenarios) {
    const input = fixture();
    updateBook(first(input), mutate);
    blocked(input, reason);
  }
});

test("EVIDENCE-25 신규 진단 모듈의 전이 의존성은 기존 정적 통신 경계를 통과", () => {
  const root = resolve("dist/runtime");
  const report = inspectOfflineGraph(
    (id) => {
      const path = resolve(root, id),
        rel = relative(root, path);
      assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    },
    ["src/core/execution-evidence.js"],
  );
  assert.deepEqual(report.findings, []);
  assert.ok(report.modules.includes("src/core/source-ingest-normalize.js"));
  assert.ok(report.modules.includes("src/core/source-ingest-schema.js"));
  assert.ok(!report.modules.includes("src/server/toss-market-data.js"));
});
