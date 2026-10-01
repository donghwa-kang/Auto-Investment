import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  replayMockKiwoomCollection as replay,
  type KiwoomCollectionInput,
} from "../src/core/kiwoom-collection.js";
import { kiwoomCollectionSample } from "../src/core/kiwoom-collection-sample.js";
import { kiwoomMockSample } from "../src/core/kiwoom-ingest-sample.js";
import { hash } from "../src/core/policy.js";
import { inspectOfflineGraph } from "./network-boundary.js";

const base = Date.parse("2026-09-21T14:00:00Z");
const time = (ms: number) => new Date(base + ms).toISOString();
function fixture(
  indexes: number[] = [2],
  offsets = indexes.map((_, n) => n * 100),
): KiwoomCollectionInput {
  const input = kiwoomCollectionSample(),
    samples = kiwoomMockSample().captures;
  input.sourceInput.captures = indexes.map((index, n) => ({
    ...structuredClone(samples[index]!),
    captureId: `capture-${n}`,
    connectionEpoch: 0,
    requestedAt: time(offsets[n]!),
    receivedAt: time(offsets[n]!),
    availableAt: time(offsets[n]!),
  }));
  input.sourceInput.asOf = time(10_000);
  input.deadlineAt = time(20_000);
  input.maxAttempts = 50;
  input.minIntervalMs = 0;
  input.events = input.sourceInput.captures.map((c) => ({
    kind: "ATTEMPT",
    captureId: c.captureId,
  }));
  return input;
}
const allReasons = (r: ReturnType<typeof replay>) =>
  r.decisions.flatMap((d) => d.reasons);
function has(input: KiwoomCollectionInput, reason: string) {
  const r = replay(input);
  assert.ok(allReasons(r).includes(reason), JSON.stringify(r.decisions));
  return r;
}
function pauseResume(
  input: KiwoomCollectionInput,
  pauseAt: number,
  resumeAt: number,
) {
  input.events.splice(
    1,
    0,
    { kind: "PAUSE", at: time(pauseAt) },
    { kind: "RESUME", at: time(resumeAt), connectionEpoch: 1 },
  );
  input.sourceInput.captures.slice(1).forEach((c) => {
    c.connectionEpoch = 1;
  });
}
function pages() {
  const i = fixture([0, 0], [0, 1_000]);
  i.sourceInput.captures[0]!.responseContinuation = {
    contYn: "Y",
    nextKey: "opaque-1",
  };
  i.sourceInput.captures[1]!.requestContinuation = {
    contYn: "Y",
    nextKey: "opaque-1",
  };
  const rows = (i.sourceInput.captures[1]!.response as Record<string, unknown>)
    .stk_min_pole_chart_qry as Record<string, unknown>[];
  rows[0]!.cntr_tm = "20260921095900";
  return i;
}
test("KC sample preserves holds, pure replay, policy and original timestamps", () => {
  const i = kiwoomCollectionSample(),
    before = hash(i),
    r = replay(i);
  assert.equal(r.state, "STOPPED");
  assert.equal(r.stopReason, "USER_STOP");
  assert.deepEqual(r.budget, { maxAttempts: 8, used: 4, remaining: 4 });
  assert.equal(r.connectionEpoch, 1);
  assert.equal(r.ingest!.counts.observations, 4);
  assert.equal(r.ingest!.status, "MOCK_FORMAT_PARSED_SEMANTICS_HOLD");
  for (const enabled of [
    r.realCollectionEnabled,
    r.realDataReady,
    r.strategyReady,
    r.paperOrdersEnabled,
    r.liveEnabled,
    r.historyCoverageVerified,
  ])
    assert.equal(enabled, false);
  assert.equal(r.networkRequests, 0);
  assert.equal(r.automaticRetries, 0);
  assert.equal(hash(i), before);
  assert.deepEqual(replay(i), r);
  const { reportHash, ...body } = r;
  assert.equal(hash(body), reportHash);
  assert.equal(
    r.ingest!.captures[3]!.requestedAt,
    i.sourceInput.captures[3]!.requestedAt,
  );
  assert.ok(
    r.ingest!.captures.every((c) =>
      c.observations.every((o) => o.eventAt === null),
    ),
  );
});
test("KC KR aggregate cap is shared by both read TRs; sixth denied", () => {
  const r = has(fixture([2, 0, 2, 0, 2, 0]), "KR_QUERY_RATE_LIMIT");
  assert.equal(r.budget.used, 5);
  assert.equal(r.decisions[5]!.notBefore, time(1_000));
  assert.equal(r.ingest!.counts.captures, 5);
});
test("KC rolling second does not reset at a wall-clock second boundary", () => {
  const r = has(
    fixture([2, 2, 2, 2, 2, 2], [800, 850, 900, 950, 999, 1_001]),
    "KR_QUERY_RATE_LIMIT",
  );
  assert.equal(r.budget.used, 5);
  assert.equal(r.decisions[5]!.notBefore, time(1_800));
});
test("KC exactly 1000ms releases a rolling-window slot", () => {
  const r = replay(fixture([2, 2, 2, 2, 2, 2], [0, 100, 200, 300, 400, 1_000]));
  assert.equal(r.budget.used, 6);
  assert.deepEqual(allReasons(r), []);
});
test("KC domestic and US budgets are distinct", () => {
  const r = replay(fixture([2, 2, 2, 2, 2, 3, 3, 3, 3, 3]));
  assert.equal(r.budget.used, 10);
  assert.deepEqual(allReasons(r), []);
});
for (const [start, count, expected] of [
  ["2026-09-21T00:00:00Z", 4, "US_PEAK_QUERY_RATE_LIMIT"],
  ["2026-09-21T00:59:59Z", 4, "US_PEAK_QUERY_RATE_LIMIT"],
  ["2026-09-21T01:00:00Z", 6, "US_QUERY_RATE_LIMIT"],
  ["2026-09-21T14:30:00Z", 6, "US_QUERY_RATE_LIMIT"],
] as const)
  test(`KC US KST peak boundary ${start}`, () => {
    const i = fixture(Array.from({ length: count }, () => 3)),
      startMs = Date.parse(start);
    i.startedAt = start;
    i.deadlineAt = new Date(startMs + 20_000).toISOString();
    i.sourceInput.asOf = new Date(startMs + 10_000).toISOString();
    i.sourceInput.captures.forEach((c, n) => {
      c.requestedAt =
        c.receivedAt =
        c.availableAt =
          new Date(startMs + n * 100).toISOString();
    });
    assert.equal(has(i, expected).budget.used, count - 1);
  });
test("KC entering peak counts pre-peak requests in the same rolling second", () => {
  const i = fixture([3, 3, 3, 3]);
  const start = Date.parse("2026-09-20T23:59:59.700Z");
  i.startedAt = new Date(start).toISOString();
  i.deadlineAt = new Date(start + 20_000).toISOString();
  i.sourceInput.asOf = new Date(start + 10_000).toISOString();
  i.sourceInput.captures.forEach((c, n) => {
    c.requestedAt =
      c.receivedAt =
      c.availableAt =
        new Date(start + n * 100).toISOString();
  });
  assert.equal(has(i, "US_PEAK_QUERY_RATE_LIMIT").budget.used, 3);
});
test("KC mock profile applies one per TR, not one for all TRs", () => {
  const i = fixture([2, 0, 3, 1, 2]);
  i.limitProfile = "PUBLISHED_MOCK_LIMITS";
  assert.equal(has(i, "MOCK_TR_RATE_LIMIT").budget.used, 4);
});
test("KC min interval is global, exact boundary passes", () => {
  const i = fixture([2, 3, 3], [0, 249, 250]);
  i.minIntervalMs = 250;
  const r = has(i, "LOCAL_INTERVAL_OR_COOLDOWN");
  assert.equal(r.budget.used, 2);
  assert.equal(r.decisions[1]!.notBefore, time(250));
});
test("KC pause/resume retains rate history and total attempts", () => {
  const i = fixture([2, 2, 2, 2, 2, 2], [0, 100, 200, 300, 400, 500]);
  pauseResume(i, 10, 20);
  const r = has(i, "KR_QUERY_RATE_LIMIT");
  assert.equal(r.budget.used, 5);
  assert.equal(r.connectionEpoch, 1);
});
test("KC pause/resume cannot reset min interval", () => {
  const i = fixture([2, 2], [0, 500]);
  i.minIntervalMs = 1_000;
  pauseResume(i, 10, 20);
  const r = has(i, "COOLDOWN_ACTIVE");
  assert.equal(r.budget.used, 1);
  assert.equal(r.state, "PAUSED");
});
test("KC attempt budget terminates, resume and remaining captures cannot refill it", () => {
  const i = fixture([2, 2], [0, 2_000]);
  i.maxAttempts = 1;
  pauseResume(i, 10, 20);
  const r = has(i, "ATTEMPT_BUDGET_EXHAUSTED");
  assert.equal(r.budget.used, 1);
  assert.equal(r.budget.remaining, 0);
  assert.equal(r.state, "STOPPED");
  assert.equal(r.decisions[2]!.disposition, "REJECTED");
});
for (const scenario of [
  "429",
  "500",
  "401",
  "TIMEOUT",
  "DISCONNECTED",
  "provider",
  "fields",
] as const)
  test(`KC ${scenario} consumes budget, pauses, has no automatic retry`, () => {
    const i = fixture([2, 2], [0, 2_000]),
      c = i.sourceInput.captures[0]!;
    if (["429", "500", "401"].includes(scenario))
      c.httpStatus = Number(scenario);
    else if (scenario === "TIMEOUT" || scenario === "DISCONNECTED") {
      c.outcome = scenario;
      c.httpStatus =
        c.responseApiId =
        c.responseContinuation =
        c.response =
          null;
    } else if (scenario === "provider")
      c.response = { return_code: 1, return_msg: "untrusted-provider-message" };
    else c.response = { return_code: 0 };
    const r = replay(i);
    assert.equal(r.state, "PAUSED");
    assert.equal(r.budget.used, 1);
    assert.equal(r.ingest!.status, "HAS_BLOCKS");
    assert.ok(allReasons(r).includes("SESSION_PAUSED"));
    assert.equal(r.automaticRetries, 0);
    assert.equal(
      JSON.stringify(r).includes("untrusted-provider-message"),
      false,
    );
  });
test("KC fault needs explicit new epoch after cooldown; exact cooldown boundary resumes", () => {
  const i = fixture([2, 2], [0, 1_000]);
  i.sourceInput.captures[0]!.httpStatus = 429;
  i.sourceInput.captures[1]!.connectionEpoch = 1;
  i.events.splice(
    1,
    0,
    { kind: "RESUME", at: time(999), connectionEpoch: 1 },
    { kind: "RESUME", at: time(1_000), connectionEpoch: 1 },
  );
  const r = has(i, "COOLDOWN_ACTIVE");
  assert.equal(r.budget.used, 2);
  assert.equal(r.state, "READY");
  assert.equal(r.ingest!.status, "HAS_BLOCKS");
});
for (const wrongEpoch of [0, 2])
  test(`KC wrong resume epoch ${wrongEpoch} rejected`, () => {
    const i = fixture([2, 2], [0, 2_000]);
    pauseResume(i, 10, 20);
    i.events[2] = { kind: "RESUME", at: time(20), connectionEpoch: wrongEpoch };
    assert.equal(has(i, "RESUME_EPOCH_INVALID").budget.used, 1);
  });
test("KC capture connection change without explicit resume rejected", () => {
  const i = fixture([2, 2]);
  i.sourceInput.captures[1]!.connectionEpoch = 1;
  assert.equal(has(i, "CONNECTION_EPOCH_MISMATCH").budget.used, 1);
});
test("KC neither capture nor controls can overlap the modeled outstanding request", () => {
  const i = fixture([2, 2], [0, 100]);
  i.sourceInput.captures[0]!.availableAt = time(300);
  i.events.splice(1, 0, { kind: "PAUSE", at: time(50) });
  const r = has(i, "SERIAL_ATTEMPT_IN_FLIGHT");
  assert.equal(r.budget.used, 1);
  assert.equal(r.decisions[1]!.disposition, "REJECTED");
  assert.equal(r.decisions[2]!.notBefore, time(300));
});
test("KC control at exact completion time is allowed", () => {
  const i = fixture();
  i.sourceInput.captures[0]!.availableAt = time(300);
  i.events.push({ kind: "PAUSE", at: time(300) });
  assert.equal(replay(i).state, "PAUSED");
});
test("KC request at deadline is not admitted", () => {
  const i = fixture([2, 2], [0, 1_000]);
  i.deadlineAt = time(1_000);
  assert.equal(has(i, "DEADLINE_EXCEEDED").budget.used, 1);
});
test("KC response after deadline is charged but never normalized", () => {
  const i = fixture();
  i.deadlineAt = time(100);
  i.sourceInput.captures[0]!.availableAt = time(101);
  const r = has(i, "RESPONSE_AFTER_DEADLINE");
  assert.equal(r.budget.used, 1);
  assert.equal(r.ingest, null);
});
test("KC response exactly at deadline may be inspected, final session is stopped", () => {
  const i = fixture();
  i.deadlineAt = time(100);
  i.sourceInput.captures[0]!.availableAt = time(100);
  const r = replay(i);
  assert.equal(r.ingest!.counts.captures, 1);
  assert.equal(r.stopReason, "DEADLINE_EXCEEDED");
});
test("KC idle or paused session expires as of deadline", () => {
  const i = fixture();
  i.deadlineAt = time(5_000);
  i.events.push({ kind: "PAUSE", at: time(500) });
  assert.equal(replay(i).stopReason, "DEADLINE_EXCEEDED");
});
test("KC STOP prevents subsequent attempts and resume", () => {
  const i = fixture([2, 2], [0, 500]);
  i.events.splice(
    1,
    0,
    { kind: "STOP", at: time(100) },
    { kind: "RESUME", at: time(200), connectionEpoch: 1 },
  );
  const r = has(i, "SESSION_STOPPED");
  assert.equal(r.budget.used, 1);
  assert.equal(r.stopReason, "USER_STOP");
});
test("KC valid page chain reuses existing page rules but never asserts history completeness", () => {
  const r = replay(pages());
  assert.deepEqual(allReasons(r), []);
  assert.equal(r.pendingContinuation, false);
  assert.equal(r.budget.used, 2);
  assert.equal(r.ingest!.counts.observations, 2);
  assert.equal(r.historyCoverageVerified, false);
});
test("KC unresolved Y cursor stays pending at log end", () => {
  const i = pages();
  i.sourceInput.captures.pop();
  i.events.pop();
  assert.equal(replay(i).pendingContinuation, true);
});
test("KC page limit pauses and does not consume the next page", () => {
  const i = pages();
  i.maxPagesPerChain = 1;
  assert.equal(has(i, "PAGE_BUDGET_EXHAUSTED").budget.used, 1);
});
test("KC resume discards old cursor; only fresh N request can restart", () => {
  const i = pages();
  pauseResume(i, 100, 200);
  assert.equal(has(i, "CURSOR_OR_QUERY_MISMATCH").budget.used, 1);
  i.sourceInput.captures[1]!.requestContinuation = { contYn: "N", nextKey: "" };
  assert.equal(replay(i).budget.used, 2);
});
test("KC request identity cannot change inside a chain", () => {
  const i = pages();
  i.sourceInput.captures[1]!.request.body.stk_cd = "222222";
  assert.equal(has(i, "CURSOR_OR_QUERY_MISMATCH").budget.used, 1);
});
test("KC repeated opaque cursor invokes existing page block", () => {
  const i = pages();
  i.sourceInput.captures[1]!.responseContinuation = {
    contYn: "Y",
    nextKey: "opaque-1",
  };
  const r = has(i, "CURSOR_REPEATED");
  assert.equal(r.state, "PAUSED");
  assert.equal(r.budget.used, 2);
});
test("KC page without new rows cannot advance", () => {
  const i = pages();
  i.sourceInput.captures[1]!.response = structuredClone(
    i.sourceInput.captures[0]!.response,
  );
  assert.equal(has(i, "PAGE_NO_PROGRESS").state, "PAUSED");
});
test("KC unknown chart continuation is not assumed terminal", () => {
  const i = fixture([0]);
  i.sourceInput.captures[0]!.responseContinuation = null;
  assert.equal(has(i, "CONTINUATION_UNKNOWN").state, "PAUSED");
});
test("KC book Y continuation not silently followed", () => {
  const i = fixture();
  i.sourceInput.captures[0]!.responseContinuation = {
    contYn: "Y",
    nextKey: "opaque",
  };
  assert.equal(has(i, "BOOK_CONTINUATION_UNSUPPORTED").state, "PAUSED");
});
test("KC fresh duplicate after resume is reconciled, not lost", () => {
  const i = fixture([2, 2], [0, 2_000]);
  pauseResume(i, 10, 20);
  const r = replay(i);
  assert.equal(r.ingest!.counts.duplicates, 1);
  assert.equal(r.ingest!.counts.observations, 2);
});
test("KC conflicting observation across epochs stays blocked", () => {
  const i = fixture([2, 2], [0, 2_000]);
  pauseResume(i, 10, 20);
  (i.sourceInput.captures[1]!.response as Record<string, unknown>).sel_fpr_bid =
    "10020";
  const r = has(i, "CAPTURE_BLOCKED");
  assert.equal(r.ingest!.status, "HAS_BLOCKS");
  assert.equal(r.state, "PAUSED");
});
test("KC response outcome is not labeled as known at request time", () => {
  const i = fixture();
  i.sourceInput.captures[0]!.availableAt = time(300);
  const r = replay(i);
  assert.equal(r.decisions[0]!.at, time(0));
  assert.equal(r.decisions[0]!.resultKnownAt, time(300));
  i.deadlineAt = time(200);
  assert.equal(replay(i).decisions[0]!.resultKnownAt, time(200));
});
test("KC cooldown starts after outcome availability, not request dispatch", () => {
  const i = fixture([2, 2], [0, 1_300]);
  const first = i.sourceInput.captures[0]!;
  first.availableAt = time(300);
  first.httpStatus = 429;
  i.sourceInput.captures[1]!.connectionEpoch = 1;
  i.events.splice(
    1,
    0,
    { kind: "RESUME", at: time(1_000), connectionEpoch: 1 },
    { kind: "RESUME", at: time(1_300), connectionEpoch: 1 },
  );
  const r = has(i, "COOLDOWN_ACTIVE");
  assert.equal(r.decisions[1]!.notBefore, time(1_300));
  assert.equal(r.budget.used, 2);
});
test("KC equivalent UTC offset does not create a new rate window", () => {
  const i = fixture([2, 2, 2, 2, 2, 2]);
  const c = i.sourceInput.captures[5]!;
  c.requestedAt =
    c.receivedAt =
    c.availableAt =
      "2026-09-21T23:00:00.500+09:00";
  assert.equal(has(i, "KR_QUERY_RATE_LIMIT").budget.used, 5);
});
test("KC first request with stale cursor consumes no budget or payload", () => {
  const i = fixture();
  i.sourceInput.captures[0]!.requestContinuation = {
    contYn: "Y",
    nextKey: "old",
  };
  const r = has(i, "CURSOR_OR_QUERY_MISMATCH");
  assert.equal(r.budget.used, 0);
  assert.equal(r.ingest, null);
});
test("KC repeated pause and unsolicited resume do not change state", () => {
  const i = fixture();
  i.events.push(
    { kind: "RESUME", at: time(100), connectionEpoch: 1 },
    { kind: "PAUSE", at: time(200) },
    { kind: "PAUSE", at: time(300) },
  );
  const r = has(i, "CONTROL_STATE_INVALID");
  assert.equal(r.connectionEpoch, 0);
  assert.equal(r.state, "PAUSED");
});
test("KC empty continuing page is blocked by the existing ingest contract", () => {
  const i = fixture([0]);
  const c = i.sourceInput.captures[0]!;
  c.response = { return_code: 0, stk_cd: "111111", stk_min_pole_chart_qry: [] };
  c.responseContinuation = { contYn: "Y", nextKey: "next" };
  assert.equal(has(i, "EMPTY_PAGE_WITH_CONTINUATION").state, "PAUSED");
});
test("KC pre-admission rejections do not consume response values", () => {
  const i = fixture([2, 2, 2, 2, 2, 2]);
  i.sourceInput.captures[5]!.response = {
    return_code: 42,
    return_msg: "hidden-failure",
  };
  const r = has(i, "KR_QUERY_RATE_LIMIT");
  assert.equal(r.state, "READY");
  assert.equal(r.ingest!.status, "MOCK_FORMAT_PARSED_SEMANTICS_HOLD");
});

const invalidCases: [string, (i: KiwoomCollectionInput) => unknown][] = [
  [
    "future response",
    (i) => {
      i.sourceInput.captures[0]!.availableAt = time(10_001);
      return i;
    },
  ],
  [
    "future control",
    (i) => {
      i.events.push({ kind: "STOP", at: time(10_001) });
      return i;
    },
  ],
  [
    "decreasing event time",
    (i) => {
      i.events.push({ kind: "STOP", at: time(-1) });
      return i;
    },
  ],
  [
    "unknown capture",
    (i) => {
      i.events[0] = { kind: "ATTEMPT", captureId: "missing" };
      return i;
    },
  ],
  [
    "reused capture",
    (i) => {
      i.events.push(i.events[0]!);
      return i;
    },
  ],
  [
    "unused capture",
    (i) => {
      i.events = [{ kind: "STOP", at: time(0) }];
      return i;
    },
  ],
  [
    "request before start",
    (i) => {
      i.startedAt = time(1);
      return i;
    },
  ],
  [
    "reversed deadline",
    (i) => {
      i.deadlineAt = time(0);
      return i;
    },
  ],
  [
    "overlong run",
    (i) => {
      i.deadlineAt = time(86_400_001);
      return i;
    },
  ],
  [
    "overlarge budget",
    (i) => {
      i.maxAttempts = 51;
      return i;
    },
  ],
  [
    "negative interval",
    (i) => {
      i.minIntervalMs = -1;
      return i;
    },
  ],
  [
    "no cooldown",
    (i) => {
      i.faultCooldownMs = 0;
      return i;
    },
  ],
  ["live flag", (i) => ({ ...i, liveEnabled: true })],
  ["report as checkpoint", (i) => replay(i)],
  [
    "credentials",
    (i) => {
      i.sourceInput.captures[0]!.response = {
        authorization: "synthetic-secret-canary",
      };
      return i;
    },
  ],
  [
    "order TR",
    (i) => {
      Object.assign(i.sourceInput.captures[0]!.request, { apiId: "kt10000" });
      return i;
    },
  ],
  [
    "extra control field",
    (i) => {
      Object.assign(i.events[0]!, { token: "synthetic-secret-canary" });
      return i;
    },
  ],
  ["caller limit override", (i) => ({ ...i, krPerSecond: 1_000 })],
  [
    "nested page plan",
    (i) => {
      i.sourceInput.pagePlans = [
        {
          planId: "forbidden",
          maxPages: 1,
          replies: [{ ...i.sourceInput.captures[0]!, captureId: "other" }],
        },
      ];
      return i;
    },
  ],
  [
    "oversized response",
    (i) => {
      i.sourceInput.captures[0]!.response = {
        padding: "x".repeat(4 * 1024 * 1024),
      };
      return i;
    },
  ],
];
for (const [label, edit] of invalidCases)
  test(`KC invalid ${label} fails closed with value-free error`, () => {
    assert.throws(
      () => replay(edit(fixture())),
      /^Error: KIWOOM_COLLECTION_INPUT_INVALID$/,
    );
  });
test("KC dependency graph adds no network, transport, timers or credential loader", () => {
  const root = resolve("dist/runtime");
  const r = inspectOfflineGraph(
    (id) => {
      const p = resolve(root, id),
        rel = relative(root, p);
      assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
      return existsSync(p) ? readFileSync(p, "utf8") : undefined;
    },
    ["src/core/kiwoom-collection.js", "src/core/kiwoom-collection-sample.js"],
  );
  assert.deepEqual(r.findings, []);
  assert.ok(r.modules.includes("src/core/kiwoom-ingest.js"));
  assert.ok(r.modules.every((p) => !p.startsWith("src/server/")));
});
