import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ingestMockKiwoom } from "../src/core/kiwoom-ingest.js";
import { kiwoomMockSample } from "../src/core/kiwoom-ingest-sample.js";
import {
  parseKiwoomInput,
  type KiwoomInput,
} from "../src/core/kiwoom-ingest-schema.js";
import { hash } from "../src/core/policy.js";
import { inspectOfflineGraph } from "./network-boundary.js";

type JsonRecord = Record<string, unknown>;
function response(input: KiwoomInput, index = 0) {
  return input.captures[index]!.response as JsonRecord;
}
function bar(input: KiwoomInput, index = 0) {
  return (
    response(input, index)[
      index === 0 ? "stk_min_pole_chart_qry" : "result_list"
    ] as JsonRecord[]
  )[0]!;
}
function reasons(report: ReturnType<typeof ingestMockKiwoom>) {
  return [
    ...report.captures,
    ...report.pagePlans.flatMap((p) => p.captures),
  ].flatMap((c) => [...c.reasons, ...c.observations.flatMap((r) => r.reasons)]);
}
function blocked(input: KiwoomInput, reason: string) {
  const report = ingestMockKiwoom(input);
  assert.equal(report.status, "HAS_BLOCKS");
  assert.ok(reasons(report).includes(reason), JSON.stringify(reasons(report)));
  return report;
}
function pages(): KiwoomInput {
  const input = kiwoomMockSample();
  const a = structuredClone(input.captures[0]!),
    b = structuredClone(a);
  a.responseContinuation = { contYn: "Y", nextKey: "test-cursor-1" };
  b.captureId = "kr-bar-page2";
  b.requestContinuation = structuredClone(a.responseContinuation);
  b.requestedAt = "2026-09-21T14:00:00.300Z";
  b.receivedAt = "2026-09-21T14:00:00.400Z";
  b.availableAt = "2026-09-21T14:00:00.500Z";
  (
    (b.response as JsonRecord).stk_min_pole_chart_qry as JsonRecord[]
  )[0]!.cntr_tm = "20260921095900";
  input.captures = [];
  input.pagePlans = [{ planId: "kr-pages", maxPages: 2, replies: [a, b] }];
  return input;
}

test("KW-01 KR/US four read TRs parse without time, price basis or trading approval", () => {
  const input = kiwoomMockSample(),
    before = hash(input),
    r = ingestMockKiwoom(input);
  assert.equal(r.status, "MOCK_FORMAT_PARSED_SEMANTICS_HOLD");
  assert.equal(r.counts.observations, 4);
  assert.deepEqual(r.captures[0]!.observations[0]!.data, {
    open: "10000",
    high: "10050",
    low: "9990",
    close: "10010",
    volume: "10",
    currency: "KRW",
    priceBasis: "UNVERIFIED",
  });
  assert.equal(r.captures[1]!.observations[0]!.data!.close, "100.5");
  assert.equal(r.captures[2]!.observations[0]!.data!.ask, "10010");
  assert.equal(r.captures[3]!.observations[0]!.data!.ask, "100.51");
  for (const c of r.captures) {
    assert.ok(c.semanticHolds.length);
    assert.equal(c.observations[0]!.eventAt, null);
  }
  for (const field of [
    r.realCollectionEnabled,
    r.realDataReady,
    r.strategyReady,
    r.strategyEvaluated,
    r.historicalPointInTimeVerified,
    r.paperOrdersEnabled,
    r.liveEnabled,
  ])
    assert.equal(field, false);
  assert.equal(r.networkRequests, 0);
  assert.equal(hash(input), before);
  assert.deepEqual(r, ingestMockKiwoom(input));
  const { reportHash, ...body } = r;
  assert.equal(reportHash, hash(body));
  assert.equal(r.inputHash, before);
});
for (const [name, change] of [
  [
    "source",
    (v: JsonRecord) => {
      v.source = "TOSS_REST";
    },
  ],
  [
    "origin",
    (v: JsonRecord) => {
      v.dataOrigin = "REAL";
    },
  ],
  [
    "version",
    (v: JsonRecord) => {
      v.sourceSpecCommit = "main";
    },
  ],
  [
    "purpose",
    (v: JsonRecord) => {
      v.purpose = "LIVE";
    },
  ],
  [
    "unknown",
    (v: JsonRecord) => {
      v.liveEnabled = true;
    },
  ],
  [
    "credential",
    (v: JsonRecord) => {
      v.appkey = "synthetic-secret-canary";
    },
  ],
] as const)
  test(`KW input rejects ${name}`, () => {
    const v: JsonRecord = { ...kiwoomMockSample() };
    change(v);
    assert.throws(() => ingestMockKiwoom(v), /^Error: KIWOOM_INPUT_INVALID$/);
  });
for (const apiId of ["kt10000", "au10001", "usa10001", "0D", "FT"])
  test(`KW non-allowlisted TR ${apiId} rejected`, () => {
    const v = kiwoomMockSample();
    v.captures[0]!.request = Object.assign({}, v.captures[0]!.request, {
      apiId,
    }) as KiwoomInput["captures"][number]["request"];
    assert.throws(() => ingestMockKiwoom(v), /KIWOOM_INPUT_INVALID/);
  });
for (const [name, edit, reason] of [
  [
    "http",
    (i: KiwoomInput) => {
      i.captures[0]!.httpStatus = 429;
    },
    "MOCK_HTTP_FAILURE",
  ],
  [
    "provider",
    (i: KiwoomInput) => {
      response(i).return_code = 1;
      response(i).return_msg = "do not expose synthetic text";
    },
    "PROVIDER_ERROR",
  ],
  [
    "tr",
    (i: KiwoomInput) => {
      i.captures[0]!.responseApiId = "ka10004";
    },
    "RESPONSE_TR_MISMATCH",
  ],
  [
    "symbol",
    (i: KiwoomInput) => {
      response(i).stk_cd = "222222";
    },
    "RESPONSE_SYMBOL_MISMATCH",
  ],
  [
    "missing-list",
    (i: KiwoomInput) => {
      delete response(i).stk_min_pole_chart_qry;
    },
    "ENVELOPE_INVALID",
  ],
  [
    "missing-price",
    (i: KiwoomInput) => {
      delete bar(i).open_pric;
    },
    "ROW_INVALID",
  ],
  [
    "nan",
    (i: KiwoomInput) => {
      bar(i).cur_prc = "NaN";
    },
    "ROW_INVALID",
  ],
  [
    "scientific",
    (i: KiwoomInput) => {
      bar(i).trde_qty = "1e5";
    },
    "ROW_INVALID",
  ],
  [
    "negative-volume",
    (i: KiwoomInput) => {
      bar(i).trde_qty = "-1";
    },
    "ROW_INVALID",
  ],
  [
    "ohlc",
    (i: KiwoomInput) => {
      bar(i).cur_prc = "20000";
    },
    "OHLC_INVALID",
  ],
  [
    "zero-price",
    (i: KiwoomInput) => {
      bar(i).cur_prc = "0";
    },
    "PRICE_INVALID",
  ],
  [
    "kr-fraction",
    (i: KiwoomInput) => {
      bar(i).cur_prc = "10010.5";
    },
    "PRICE_INVALID",
  ],
  [
    "us-negative",
    (i: KiwoomInput) => {
      bar(i, 1).cur_prc = "-100.5";
    },
    "PRICE_INVALID",
  ],
  [
    "invalid-date",
    (i: KiwoomInput) => {
      bar(i).cntr_tm = "20260230100000";
    },
    "SOURCE_LOCAL_TIME_INVALID",
  ],
  [
    "invalid-minute",
    (i: KiwoomInput) => {
      bar(i).cntr_tm = "20260921109900";
    },
    "SOURCE_LOCAL_TIME_INVALID",
  ],
  [
    "invalid-second",
    (i: KiwoomInput) => {
      bar(i).cntr_tm = "20260921100060";
    },
    "SOURCE_LOCAL_TIME_INVALID",
  ],
  [
    "us-business-date",
    (i: KiwoomInput) => {
      bar(i, 1).bus_dt = "20260230";
    },
    "BUSINESS_DATE_INVALID",
  ],
  [
    "us-adjustment",
    (i: KiwoomInput) => {
      bar(i, 1).upd_stkpc_tp = "1";
    },
    "RESPONSE_ADJUSTMENT_CONFLICT",
  ],
  [
    "book-identity",
    (i: KiwoomInput) => {
      response(i, 3).stex_tp = "NY";
    },
    "RESPONSE_IDENTITY_MISMATCH",
  ],
  [
    "book-missing",
    (i: KiwoomInput) => {
      delete response(i, 2).sel_fpr_bid;
    },
    "ORDERBOOK_FIELDS_INVALID",
  ],
  [
    "book-empty",
    (i: KiwoomInput) => {
      response(i, 2).sel_fpr_req = "0";
    },
    "EMPTY_TOP_LEVEL",
  ],
  [
    "book-cross",
    (i: KiwoomInput) => {
      response(i, 3).buy_1bid = "+101.0000";
    },
    "LOCKED_OR_CROSSED_ORDERBOOK",
  ],
  [
    "book-clock",
    (i: KiwoomInput) => {
      response(i, 2).bid_req_base_tm = "250000";
    },
    "SOURCE_LOCAL_TIME_INVALID",
  ],
  [
    "future-capture",
    (i: KiwoomInput) => {
      i.captures[0]!.availableAt = "2026-09-21T14:00:02Z";
    },
    "CAPTURE_NOT_AVAILABLE_AS_OF",
  ],
] as const)
  test(`KW ${name}`, () => {
    const i = kiwoomMockSample();
    edit(i);
    const r = blocked(i, reason);
    assert.ok(!JSON.stringify(r).includes("do not expose synthetic text"));
  });
for (const outcome of ["TIMEOUT", "DISCONNECTED"] as const)
  test(`KW ${outcome}`, () => {
    const i = kiwoomMockSample();
    Object.assign(i.captures[0]!, {
      outcome,
      response: null,
      httpStatus: null,
      responseApiId: null,
      responseContinuation: null,
    });
    blocked(i, outcome === "TIMEOUT" ? "MOCK_TIMEOUT" : "MOCK_DISCONNECTED");
  });
test("KW clock metadata cannot authorize completed bars even for future source-local strings", () => {
  const i = kiwoomMockSample();
  bar(i).cntr_tm = "20990101100000";
  const r = ingestMockKiwoom(i);
  assert.equal(r.captures[0]!.observations[0]!.eventAt, null);
  assert.equal(r.strategyReady, false);
  assert.ok(r.semanticHolds.includes("BAR_BOUNDARY_UNVERIFIED"));
});
test("KW decimal precision and input time ordering", () => {
  const i = kiwoomMockSample();
  bar(i).trde_qty = "9007199254740993";
  assert.equal(
    ingestMockKiwoom(i).captures[0]!.observations[0]!.data!.volume,
    "9007199254740993",
  );
  i.captures[0]!.receivedAt = "2026-09-20T00:00:00Z";
  assert.throws(() => ingestMockKiwoom(i), /KIWOOM_INPUT_INVALID/);
});
test("KW nested credentials are rejected without being echoed", () => {
  const i = kiwoomMockSample();
  response(i).authorization = "synthetic-secret-canary";
  assert.throws(() => ingestMockKiwoom(i), /^Error: KIWOOM_INPUT_INVALID$/);
});
test("KW unknown payload fields are not copied into reports", () => {
  const i = kiwoomMockSample();
  bar(i).untrusted = "synthetic-secret-canary";
  assert.ok(
    !JSON.stringify(ingestMockKiwoom(i)).includes("synthetic-secret-canary"),
  );
});
test("KW duplicate/conflict uses shared reconciliation and respects asOf", () => {
  const i = kiwoomMockSample(),
    dup = structuredClone(i.captures[0]!);
  dup.captureId = "kr-duplicate";
  i.captures.push(dup);
  assert.equal(ingestMockKiwoom(i).counts.duplicates, 1);
  (
    (dup.response as JsonRecord).stk_min_pole_chart_qry as JsonRecord[]
  )[0]!.trde_qty = "99";
  const r = blocked(i, "SOURCE_REVISION_UNVERIFIED");
  assert.equal(r.captures[0]!.observations[0]!.status, "BLOCKED");
  dup.availableAt = "2026-09-21T14:00:02Z";
  const before = ingestMockKiwoom(i);
  assert.equal(before.captures[0]!.status, "MOCK_PARSED");
});
test("KW no cross-venue duplicate merge", () => {
  const i = kiwoomMockSample(),
    alt = structuredClone(i.captures[1]!);
  alt.captureId = "us-ny";
  if (alt.request.apiId === "usa06011") alt.request.body.stex_tp = "NY";
  i.captures.push(alt);
  assert.equal(ingestMockKiwoom(i).counts.duplicates, 0);
});
test("KW page happy path consumes opaque cursor without claiming history coverage", () => {
  const r = ingestMockKiwoom(pages()),
    p = r.pagePlans[0]!;
  assert.equal(p.stop, "SOURCE_EXHAUSTED");
  assert.deepEqual(p.reasons, []);
  assert.equal(p.attempts, 2);
  assert.equal(p.historyCoverageVerified, false);
  assert.equal(r.strategyReady, false);
});
for (const [name, edit, reason] of [
  [
    "cursor-repeat",
    (i: KiwoomInput) => {
      i.pagePlans[0]!.replies[1]!.responseContinuation = {
        contYn: "Y",
        nextKey: "test-cursor-1",
      };
    },
    "CURSOR_REPEATED",
  ],
  [
    "wrong-cursor",
    (i: KiwoomInput) => {
      i.pagePlans[0]!.replies[1]!.requestContinuation.nextKey = "wrong";
    },
    "PAGE_REQUEST_MISMATCH",
  ],
  [
    "missing-cursor",
    (i: KiwoomInput) => {
      i.pagePlans[0]!.replies[0]!.responseContinuation = null;
    },
    "CONTINUATION_UNKNOWN",
  ],
  [
    "no-progress",
    (i: KiwoomInput) => {
      i.pagePlans[0]!.replies[1]!.response = structuredClone(
        i.pagePlans[0]!.replies[0]!.response,
      );
    },
    "PAGE_NO_PROGRESS",
  ],
  [
    "budget",
    (i: KiwoomInput) => {
      i.pagePlans[0]!.maxPages = 1;
    },
    "PAGE_BUDGET_EXHAUSTED",
  ],
  [
    "missing-reply",
    (i: KiwoomInput) => {
      i.pagePlans[0]!.replies.pop();
    },
    "MOCK_REPLY_MISSING",
  ],
  [
    "reconnect",
    (i: KiwoomInput) => {
      i.pagePlans[0]!.replies[1]!.connectionEpoch = 1;
    },
    "RECONNECT_REQUIRES_NEW_PLAN",
  ],
  [
    "out-of-order",
    (i: KiwoomInput) => {
      i.pagePlans[0]!.replies[1]!.requestedAt = "2026-09-21T14:00:00.100Z";
    },
    "PAGE_CAPTURE_ORDER_INVALID",
  ],
  [
    "empty-continuing",
    (i: KiwoomInput) => {
      (
        i.pagePlans[0]!.replies[0]!.response as JsonRecord
      ).stk_min_pole_chart_qry = [];
    },
    "EMPTY_PAGE_WITH_CONTINUATION",
  ],
] as const)
  test(`KW pages ${name}`, () => {
    const i = pages();
    edit(i);
    const r = ingestMockKiwoom(i);
    assert.equal(r.status, "HAS_BLOCKS");
    assert.ok(r.pagePlans[0]!.reasons.includes(reason));
    assert.equal(r.realDataReady, false);
  });
test("KW empty terminal page is not full history proof", () => {
  const i = pages();
  const p = i.pagePlans[0]!;
  p.replies = p.replies.slice(0, 1);
  p.replies[0]!.responseContinuation = { contYn: "N", nextKey: "" };
  (p.replies[0]!.response as JsonRecord).stk_min_pole_chart_qry = [];
  const r = ingestMockKiwoom(i);
  assert.equal(r.pagePlans[0]!.stop, "SOURCE_EXHAUSTED");
  assert.equal(r.pagePlans[0]!.historyCoverageVerified, false);
  assert.equal(r.counts.observations, 0);
});
test("KW unique IDs/resource limits and unsupported variants fail closed", () => {
  const i = kiwoomMockSample();
  i.captures.push(structuredClone(i.captures[0]!));
  assert.throws(() => parseKiwoomInput(i), /KIWOOM_INPUT_INVALID/);
  const huge = kiwoomMockSample();
  response(huge).stk_min_pole_chart_qry = Array.from({ length: 2001 }, () =>
    bar(kiwoomMockSample()),
  );
  assert.throws(() => parseKiwoomInput(huge), /KIWOOM_INPUT_INVALID/);
  const nxt = kiwoomMockSample();
  nxt.captures[0]!.request.body.stk_cd = "111111_NX";
  assert.throws(() => parseKiwoomInput(nxt), /KIWOOM_INPUT_INVALID/);
});
test("KW dependency graph has no network/order adapter or credential loader", () => {
  const root = resolve("dist/runtime");
  const r = inspectOfflineGraph(
    (id) => {
      const p = resolve(root, id),
        rel = relative(root, p);
      assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
      return existsSync(p) ? readFileSync(p, "utf8") : undefined;
    },
    ["src/core/kiwoom-ingest.js", "src/core/kiwoom-ingest-sample.js"],
  );
  assert.deepEqual(r.findings, []);
  assert.ok(r.modules.includes("src/core/source-ingest-normalize.js"));
  assert.ok(r.modules.every((p) => !p.startsWith("src/server/")));
});

test("KW US pagination is distinct from KR response format", () => {
  const i = pages();
  const sample = kiwoomMockSample().captures[1]!;
  i.pagePlans[0]!.replies.forEach((c, n) => {
    c.request = structuredClone(sample.request);
    c.responseApiId = sample.responseApiId;
    c.response = structuredClone(sample.response);
    ((c.response as JsonRecord).result_list as JsonRecord[])[0]!.cntr_tm =
      n === 0 ? "20260921093000" : "20260921092900";
  });
  const r = ingestMockKiwoom(i);
  assert.equal(r.pagePlans[0]!.stop, "SOURCE_EXHAUSTED");
  assert.equal(r.pagePlans[0]!.captures[1]!.identity.currency, "USD");
  assert.equal(r.realDataReady, false);
});
test("KW explicit calendar/date and resource boundary validation", () => {
  const i = kiwoomMockSample();
  if (i.captures[0]!.request.apiId === "ka10080")
    i.captures[0]!.request.body.base_dt = "20260230";
  assert.throws(() => ingestMockKiwoom(i), /KIWOOM_INPUT_INVALID/);
  const large = kiwoomMockSample();
  response(large).extra = "x".repeat(4 * 1024 * 1024);
  assert.throws(() => ingestMockKiwoom(large), /KIWOOM_INPUT_INVALID/);
  const leap = kiwoomMockSample();
  bar(leap).cntr_tm = "20240229100000";
  assert.equal(ingestMockKiwoom(leap).captures[0]!.status, "MOCK_PARSED");
});
test("KW unused future page does not contaminate consumed observations", () => {
  const i = pages();
  i.pagePlans[0]!.maxPages = 1;
  const before = ingestMockKiwoom(i).pagePlans[0]!.captures;
  i.pagePlans[0]!.replies[1]!.availableAt = "2026-09-22T00:00:00Z";
  (
    (i.pagePlans[0]!.replies[1]!.response as JsonRecord)
      .stk_min_pole_chart_qry as JsonRecord[]
  )[0]!.cur_prc = "999999";
  const r = ingestMockKiwoom(i);
  assert.deepEqual(r.pagePlans[0]!.captures, before);
  assert.equal(r.pagePlans[0]!.unusedMockReplies, 1);
});
test("KW input order does not select a winner for conflicting source rows", () => {
  const i = kiwoomMockSample(),
    c = structuredClone(i.captures[0]!);
  c.captureId = "another";
  (
    (c.response as JsonRecord).stk_min_pole_chart_qry as JsonRecord[]
  )[0]!.trde_qty = "99";
  i.captures.push(c);
  const view = (input: KiwoomInput) =>
    ingestMockKiwoom(input)
      .captures.flatMap((c) => c.observations)
      .sort((a, b) => a.observationId.localeCompare(b.observationId));
  const a = view(i);
  i.captures.reverse();
  assert.deepEqual(view(i), a);
});
test("KW conflicts across standalone observations and page plans block both", () => {
  const i = pages(),
    c = structuredClone(i.pagePlans[0]!.replies[0]!);
  c.captureId = "standalone";
  (
    (c.response as JsonRecord).stk_min_pole_chart_qry as JsonRecord[]
  )[0]!.trde_qty = "99";
  i.captures = [c];
  const r = blocked(i, "SOURCE_REVISION_UNVERIFIED");
  assert.equal(r.pagePlans[0]!.stop, "BLOCKED");
  assert.ok(r.pagePlans[0]!.reasons.includes("GLOBAL_OBSERVATION_BLOCKED"));
});

test("KW total row limit counts both arrays even if one is empty", () => {
  const i = kiwoomMockSample();
  response(i).stk_min_pole_chart_qry = [];
  response(i).result_list = Array.from({ length: 2001 }, () => ({}));
  assert.throws(() => parseKiwoomInput(i), /KIWOOM_INPUT_INVALID/);
});

test("KW malformed unused array cannot hide valid rows from total limit", () => {
  const i = kiwoomMockSample();
  const row = structuredClone(bar(i));
  response(i).stk_min_pole_chart_qry = Array.from({ length: 1100 }, () => row);
  response(i).result_list = "not-an-array";
  const extra = structuredClone(i.captures[0]!);
  extra.captureId = "extra-resource-capture";
  i.captures.push(extra);
  assert.throws(() => parseKiwoomInput(i), /KIWOOM_INPUT_INVALID/);
});

for (const index of [0, 1])
  test(`KW civil seconds do not prove minute alignment for market ${index}`, () => {
    const input = kiwoomMockSample();
    bar(input, index).cntr_tm = "20260921100037";
    const r = ingestMockKiwoom(input);
    const c = r.captures[index]!;
    assert.equal(c.status, "MOCK_PARSED");
    assert.equal(c.observations[0]!.sourceTimestampRaw, "20260921100037");
    assert.equal(c.observations[0]!.sourceTimePrecision, "SECOND");
    assert.equal(c.observations[0]!.eventAt, null);
    assert.ok(c.semanticHolds.includes("BAR_BOUNDARY_UNVERIFIED"));
    assert.equal(r.strategyReady, false);
    assert.equal(r.realDataReady, false);
    assert.equal(r.status, "MOCK_FORMAT_PARSED_SEMANTICS_HOLD");
  });

test("KW timestamp precision describes format, not UTC accuracy or freshness", () => {
  const r = ingestMockKiwoom(kiwoomMockSample());
  assert.deepEqual(
    r.captures.map((c) => c.observations[0]!.sourceTimePrecision),
    ["SECOND", "SECOND", "SECOND", "MINUTE"],
  );
  assert.ok(r.captures.every((c) => c.observations[0]!.eventAt === null));
  assert.ok(
    r.captures[3]!.semanticHolds.includes("QUOTE_FRESHNESS_UNVERIFIED"),
  );
  assert.equal(r.paperOrdersEnabled, false);
});

test("KW KR date-only quote stays date-only, without invented midnight", () => {
  const i = kiwoomMockSample();
  response(i, 2).bid_req_base_tm = "20260921";
  const c = ingestMockKiwoom(i).captures[2]!;
  assert.equal(c.status, "MOCK_PARSED");
  assert.equal(c.observations[0]!.sourceTimePrecision, "DAY");
  assert.equal(c.observations[0]!.sourceTimestampRaw, "20260921");
  assert.equal(c.observations[0]!.eventAt, null);
  assert.ok(c.semanticHolds.includes("SOURCE_TIME_UNVERIFIED"));
});

test("KW invalid source clocks never acquire a valid precision", () => {
  const i = kiwoomMockSample();
  bar(i).cntr_tm = "20260921100060";
  response(i, 2).bid_req_base_tm = "246000";
  response(i, 3).bid_tm = "25:00";
  const r = blocked(i, "SOURCE_LOCAL_TIME_INVALID");
  for (const index of [0, 2, 3])
    assert.equal(r.captures[index]!.observations[0]!.sourceTimePrecision, null);
});

for (const localTime of ["20260308023000", "20261101013000"])
  test(`KW DST-looking local time ${localTime} never receives a guessed zone`, () => {
    const i = kiwoomMockSample();
    bar(i, 1).cntr_tm = localTime;
    const r = ingestMockKiwoom(i);
    assert.equal(r.captures[1]!.observations[0]!.sourceTimePrecision, "SECOND");
    assert.equal(r.captures[1]!.observations[0]!.eventAt, null);
    assert.ok(
      r.captures[1]!.semanticHolds.includes("SOURCE_TIMEZONE_UNVERIFIED"),
    );
    assert.equal(r.historicalPointInTimeVerified, false);
    assert.equal(r.liveEnabled, false);
  });
