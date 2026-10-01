import { test } from "node:test";
import assert from "node:assert/strict";
import {
  completedRiskWindow,
  riskKeys,
  localTimeToUtc,
} from "../src/core/calendar.js";
import policy from "../outputs/AI_TRADING_POLICY_v2.3.json" with { type: "json" };

const dayMilliseconds = 86_400_000;
const utc = (value: string) => Date.parse(value);

function assertWindow(asOf: string, start: string, end: string) {
  const result = completedRiskWindow(utc(asOf));
  assert.equal(result.startInclusive, utc(start));
  assert.equal(result.endExclusive, utc(end));
  assert.equal(
    result.endExclusive - result.startInclusive,
    20 * dayMilliseconds,
  );
  assert.equal(result.riskDayIds.length, 20);
  assert.equal(new Set(result.riskDayIds).size, 20);
  assert.equal(
    result.riskDayIds[0],
    new Date(utc(start)).toISOString().split("T")[0],
  );
  assert.equal(
    result.riskDayIds.at(-1),
    new Date(utc(end) - dayMilliseconds).toISOString().split("T")[0],
  );
  for (let i = 0; i < result.riskDayIds.length; i++)
    assert.equal(
      utc(`${result.riskDayIds[i]}T00:00:00.000Z`),
      result.startInclusive + i * dayMilliseconds,
    );
  return result;
}

test("OPS-CAL-01 원본 공통 KST 09시·완료 20위험일 계약을 사용", () => {
  assert.equal(policy.risk_calendar.timezone, "Asia/Seoul");
  assert.equal(policy.risk_calendar.day_boundary, "09:00:00");
  assert.equal(policy.risk_calendar.shared_across_markets, true);
  assert.equal(policy.economic_gate.operating_cost_lookback_risk_days, 20);
});

test("OPS-CAL-02 09시 1ms 전에는 직전 위험일을 현재일로 제외", () => {
  assertWindow(
    "2026-09-17T08:59:59.999+09:00",
    "2026-08-27T09:00:00+09:00",
    "2026-09-16T09:00:00+09:00",
  );
});

test("OPS-CAL-03 09시 정각에 창을 하루 전진하고 시작 포함·끝 제외", () => {
  const window = assertWindow(
    "2026-09-17T09:00:00+09:00",
    "2026-08-28T09:00:00+09:00",
    "2026-09-17T09:00:00+09:00",
  );
  const inWindow = (at: number) =>
    at >= window.startInclusive && at < window.endExclusive;
  assert.equal(inWindow(utc("2026-08-28T08:59:59.999+09:00")), false);
  assert.equal(inWindow(utc("2026-08-28T09:00:00+09:00")), true);
  assert.equal(inWindow(utc("2026-09-17T08:59:59.999+09:00")), true);
  assert.equal(inWindow(utc("2026-09-17T09:00:00+09:00")), false);
});

test("OPS-CAL-04 11시 및 다음 09시 직전까지 동일 창·이동 구간 반례", () => {
  const window = assertWindow(
    "2026-09-17T11:00:00+09:00",
    "2026-08-28T09:00:00+09:00",
    "2026-09-17T09:00:00+09:00",
  );
  assert.deepEqual(
    completedRiskWindow(utc("2026-09-18T08:59:59.999+09:00")),
    window,
  );
  assert.notEqual(
    window.startInclusive,
    utc("2026-09-17T11:00:00+09:00") - 20 * dayMilliseconds,
  );
  assert.equal(window.riskDayIds.includes("2026-09-17"), false);
});

test("OPS-CAL-05 주말·휴장 여부로 위험일을 삭제하지 않음", () => {
  const window = assertWindow(
    "2026-09-14T09:00:00+09:00",
    "2026-08-25T09:00:00+09:00",
    "2026-09-14T09:00:00+09:00",
  );
  assert.ok(window.riskDayIds.includes("2026-09-12"));
  assert.ok(window.riskDayIds.includes("2026-09-13"));
});

test("OPS-CAL-06 월 경계 직전·정각에서 기존 위험월 의미 보존", () => {
  assertWindow(
    "2026-10-01T08:59:59.999+09:00",
    "2026-09-10T09:00:00+09:00",
    "2026-09-30T09:00:00+09:00",
  );
  assertWindow(
    "2026-10-01T09:00:00+09:00",
    "2026-09-11T09:00:00+09:00",
    "2026-10-01T09:00:00+09:00",
  );
  assert.equal(riskKeys(utc("2026-10-01T08:59:59.999+09:00")).month, "2026-09");
  assert.equal(riskKeys(utc("2026-10-01T09:00:00+09:00")).month, "2026-10");
});

test("OPS-CAL-07 연 경계·윤일·평년 말일을 달력 날짜로 보존", () => {
  assertWindow(
    "2027-01-01T09:00:00+09:00",
    "2026-12-12T09:00:00+09:00",
    "2027-01-01T09:00:00+09:00",
  );
  const leap = assertWindow(
    "2024-03-01T09:00:00+09:00",
    "2024-02-10T09:00:00+09:00",
    "2024-03-01T09:00:00+09:00",
  );
  assert.ok(leap.riskDayIds.includes("2024-02-29"));
  const common = assertWindow(
    "2025-03-01T09:00:00+09:00",
    "2025-02-09T09:00:00+09:00",
    "2025-03-01T09:00:00+09:00",
  );
  assert.equal(common.riskDayIds.includes("2025-02-29"), false);
});

test("OPS-CAL-08 미국 DST 전환과 무관하게 한국 위험일은 24시간", () => {
  for (const [before, after] of [
    ["2026-03-08", "2026-03-09"],
    ["2026-11-01", "2026-11-02"],
  ] as const) {
    const first = completedRiskWindow(utc(`${before}T09:00:00+09:00`));
    const second = completedRiskWindow(utc(`${after}T09:00:00+09:00`));
    assert.equal(second.endExclusive - first.endExclusive, dayMilliseconds);
    assert.equal(second.startInclusive - first.startInclusive, dayMilliseconds);
    assert.equal(second.endExclusive, utc(`${after}T00:00:00Z`));
  }
  assert.equal(
    localTimeToUtc("2026-03-06", "09:30", "America/New_York"),
    utc("2026-03-06T14:30:00Z"),
  );
  assert.equal(
    localTimeToUtc("2026-03-09", "09:30", "America/New_York"),
    utc("2026-03-09T13:30:00Z"),
  );
});

test("OPS-CAL-09 epoch 이전에도 올바르게 내림·0~99년 Date.UTC 보정 없음", () => {
  assertWindow(
    "1969-12-31T23:59:59.999Z",
    "1969-12-11T00:00:00Z",
    "1969-12-31T00:00:00Z",
  );
  assertWindow(
    "0099-01-01T00:00:00Z",
    "0098-12-12T00:00:00Z",
    "0099-01-01T00:00:00Z",
  );
  assert.equal(completedRiskWindow(0).endExclusive, 0);
  assert.deepEqual(completedRiskWindow(-0), completedRiskWindow(0));
});

for (const value of [
  NaN,
  Infinity,
  -Infinity,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  -Number.MAX_SAFE_INTEGER - 1,
  8_640_000_000_000_001,
  -8_640_000_000_000_001,
  null,
  undefined,
  "2026-09-17T00:00:00Z",
] as unknown[])
  test(`OPS-CAL-10 유효하지 않은 asOf 거절: ${String(value)}`, () => {
    assert.throws(() => completedRiskWindow(value as number), {
      name: "RangeError",
      message: "INVALID_COMPLETED_RISK_WINDOW_AS_OF",
    });
  });

test("OPS-CAL-11 Date 하한을 넘는 완료 창 거절·정확 하한 허용", () => {
  const minimum = -8_640_000_000_000_000;
  for (const asOf of [minimum, minimum + 20 * dayMilliseconds - 1])
    assert.throws(() => completedRiskWindow(asOf), {
      name: "RangeError",
      message: "INVALID_COMPLETED_RISK_WINDOW_START",
    });
  const window = completedRiskWindow(minimum + 20 * dayMilliseconds);
  assert.equal(window.startInclusive, minimum);
  assert.equal(window.riskDayIds[0], "-271821-04-20");
  assert.equal(window.riskDayIds.length, 20);
});

test("OPS-CAL-12 Date 상한과 확장 연도 ID를 잘림 없이 허용", () => {
  const window = assertWindow(
    "+275760-09-13T00:00:00Z",
    "+275760-08-24T00:00:00Z",
    "+275760-09-13T00:00:00Z",
  );
  assert.equal(window.riskDayIds.at(-1), "+275760-09-12");
});

test("OPS-CAL-13 결과 배열을 바꿔도 다음 계산에는 영향 없음", () => {
  const at = utc("2026-09-17T09:00:00+09:00");
  const first = completedRiskWindow(at);
  first.riskDayIds[0] = "CHANGED";
  first.riskDayIds.pop();
  const second = completedRiskWindow(at);
  assert.equal(second.riskDayIds[0], "2026-08-28");
  assert.equal(second.riskDayIds.length, 20);
});
