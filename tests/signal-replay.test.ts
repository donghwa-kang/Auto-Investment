import { test } from "node:test";
import assert from "node:assert/strict";
import { lastOnly, prepare, replayFixture } from "./signal-replay-helpers.js";
import { runSignalReplay } from "../src/core/signal-replay.js";
import {
  indicators,
  dailyTrend,
  asOfBars,
  evaluateFeatures,
} from "../src/core/strategy.js";
import { hash } from "../src/core/policy.js";
import { makeSignalReplayFixture } from "../src/core/signal-replay-fixture.js";
import { minute } from "../src/core/calendar.js";
const baseInput = lastOnly(),
  baseline = runSignalReplay(baseInput);

test("REPLAY-08 미국 달러 시험 자료·동일 평가기·시장 식별 격리", () => {
  const f = makeSignalReplayFixture("US");
  f.frames = f.frames.slice(-1);
  for (const h of f.histories)
    for (const s of h.sessions.slice(0, -1)) {
      s.closeAt = s.openAt + 60 * minute;
      s.rows = s.rows.filter((r) => r.offset < 60);
    }
  const report = runSignalReplay(f);
  assert.equal(report.counts.evaluated, 2);
  assert.ok(
    report.frames[0]!.items.every((i) => i.catalogKey.startsWith("US:")),
  );
  assert.equal(report.frames[0]!.items[1]!.status, "CHART_SIGNAL");
  assert.equal(report.frames[0]!.items[1]!.evaluation!.current!.c, "213");
});

test("REPLAY-01 기존 공용 평가기의 결과·조건별 수치/연산자와 일치", () => {
  const a = prepare(baseInput),
    b = prepare(baseInput, 2),
    at = Date.parse(baseInput.frames[0]!.asOf);
  const direct = evaluateFeatures(
    indicators(a.bars, a.sessions, at, a.actions),
    indicators(b.bars, b.sessions, at, b.actions),
    dailyTrend(asOfBars(a.bars, at, a.actions), a.sessions, at),
    dailyTrend(asOfBars(b.bars, at, b.actions), b.sessions, at),
    a.current!,
    at,
    "REPLAY-KR-B",
  );
  const actual = baseline.frames[0]!.items[0]!.evaluation!;
  assert.deepEqual(actual.strategies, direct.strategies);
  assert.deepEqual(actual.stops, direct.stops);
  assert.deepEqual(actual.current, direct.current);
  const strip = (x: typeof direct.trace) =>
    x.map(({ data_version: _ignored, ...rest }) => rest);
  assert.deepEqual(strip(actual.trace), strip(direct.trace));
  assert.notEqual(actual.dataVersion, "SYNTHETIC_V1");
});
test("REPLAY-02 단계/비활성 경계·벤치마크는 매매 판단 목록 제외", () => {
  assert.equal(baseline.counts.instrumentDecisions, 2);
  assert.equal(baseline.counts.evaluated, 2);
  assert.equal(baseline.counts.signals, 1);
  assert.equal(baseline.frames[0]!.items[1]!.status, "CHART_SIGNAL");
  assert.deepEqual(baseline.frames[0]!.items[1]!.evaluation!.strategies, ["P"]);
  for (const k of [
    "liveEnabled",
    "paperOrdersEnabled",
    "riskEvaluated",
    "economicEvaluated",
    "selectionPerformed",
    "performanceQualified",
    "realDataReady",
  ] as const)
    assert.equal(baseline[k], false);
  for (const i of baseline.frames[0]!.items) {
    assert.equal(i.orderApproved, false);
    assert.equal(i.strategyPriorityResolved, false);
  }
});
test("REPLAY-03 전체 프레임은 시간순·이전 시점의 P 연속 봉 부족은 보류", () => {
  const f = replayFixture();
  f.frames.reverse();
  const r = runSignalReplay(f);
  assert.ok(Date.parse(r.frames[0]!.asOf) < Date.parse(r.frames[1]!.asOf));
  assert.equal(r.frames[0]!.items[0]!.status, "CHART_SIGNAL");
  assert.equal(r.frames[0]!.items[1]!.status, "BLOCKED");
  assert.ok(r.frames[0]!.items[1]!.reasons.includes("REPLAY_FEATURES_MISSING"));
  assert.equal(r.frames[1]!.decisionHash, baseline.frames[0]!.decisionHash);
});
test("REPLAY-04 미래 가격 변조/prefix·입력 순서 불변 및 감사 해시 분리", () => {
  const f = lastOnly(),
    at = Date.parse(f.frames[0]!.asOf);
  for (const h of f.histories)
    for (const s of h.sessions) {
      s.rows = s.rows.filter((r) => r.availableAt <= at);
      s.rows.reverse();
    }
  f.histories.reverse();
  assert.equal(runSignalReplay(f).decisionHash, baseline.decisionHash);
  const g = lastOnly();
  for (const h of g.histories)
    for (const r of h.sessions.at(-1)!.rows)
      if (r.availableAt > at) {
        r.h = "9999999";
        r.c = "9999999";
      }
  const result = runSignalReplay(g);
  assert.equal(result.decisionHash, baseline.decisionHash);
  assert.notEqual(result.inputHash, baseline.inputHash);
});
test("REPLAY-05 한 종목 누락은 해당 종목만 보류·공유 벤치마크 오류는 모두 보류", () => {
  const f = lastOnly();
  f.histories[0]!.sessions[1]!.rows.pop();
  const r = runSignalReplay(f);
  assert.equal(r.frames[0]!.items[0]!.status, "BLOCKED");
  assert.equal(hash(r.frames[0]!.items[1]), hash(baseline.frames[0]!.items[1]));
  const g = lastOnly();
  g.histories[2]!.sessions[1]!.rows.pop();
  const result = runSignalReplay(g);
  assert.equal(result.counts.blocked, 2);
  assert.equal(result.counts.evaluated, 0);
  assert.ok(
    result.frames[0]!.items.every((i) =>
      i.reasons.includes("REPLAY_BENCHMARK_HISTORY_BLOCKED"),
    ),
  );
});
test("REPLAY-06 원본 사전점검/프로필 누락은 지표 실행으로 우회 불가", () => {
  const f = lastOnly();
  f.frames[0]!.bindings[0]!.baseRecordHash = null;
  const r = runSignalReplay(f);
  assert.equal(r.frames[0]!.items[0]!.strategyEvaluated, false);
  assert.ok(
    r.frames[0]!.items[0]!.reasons.includes("REPLAY_PREFLIGHT_BLOCKED"),
  );
  for (const field of [
    "profileHash",
    "policyHash",
    "strategyDefinitionHash",
  ] as const) {
    const g = lastOnly();
    g[field] = null;
    const report = runSignalReplay(g);
    assert.equal(report.counts.evaluated, 0);
    assert.equal(report.counts.blocked, 2);
  }
});
test("REPLAY-07 이력의 분할을 일봉과 분봉 양쪽에 같은 단위로 반영", () => {
  const f = lastOnly(),
    h = f.histories[0]!,
    at = h.sessions.at(-1)!.openAt;
  h.actions.push({
    eventId: "SPLIT",
    revision: 1,
    announcedAt: at - 1,
    availableAt: at - 1,
    effectiveAt: at,
    ratio: "2",
    kind: "SPLIT",
    cancelled: false,
  });
  const report = runSignalReplay(f),
    item = report.frames[0]!.items[0]!;
  assert.equal(item.strategyEvaluated, true);
  assert.equal(item.historyCounts!.instrument.splits, 1);
  const daily = item.evaluation!.trace.find(
    (t) => t.predicate_id === "COMMON_DAILY",
  )!;
  const original = baseline.frames[0]!.items[0]!.evaluation!.trace.find(
    (t) => t.predicate_id === "COMMON_DAILY",
  )!;
  assert.equal(
    Number(daily.input_values.close) * 2,
    Number(original.input_values.close),
  );
  assert.equal(
    item.evaluation!.current!.c,
    baseline.frames[0]!.items[0]!.evaluation!.current!.c,
  );
});
