import { test } from "node:test";
import assert from "node:assert/strict";
import { replayFixture } from "./signal-replay-helpers.js";
import { minute } from "../src/core/calendar.js";
import { hash } from "../src/core/policy.js";
import { indicators, type Bar } from "../src/core/strategy.js";
import { createRvolSource, rebuildRvol } from "../src/core/learning-rvol.js";
import type { RvolSource } from "../src/core/learning-rvol-schema.js";

function fixture() {
  const h = replayFixture().histories[0]!;
  const current = h.sessions.at(-1)!;
  const at = current.openAt + 45 * minute;
  h.sessions.slice(-21).forEach((s, i) => {
    for (const r of s.rows)
      if (r.offset >= 30 && r.offset < 45) r.v = String(i + 1);
  });
  const context = {
    decisionId: "rvol-test",
    symbol: `${h.identity.market}:${h.identity.instrumentId}`,
    asOf: at,
    signalAt: at,
    dataVersion: hash("data"),
    sourceDataHash: hash("source"),
    historyEvidenceHash: hash("history"),
  };
  return { h, context, current, build: () => createRvolSource(h, context) };
}
function resign(x: RvolSource) {
  x.sourceHash = hash(
    Object.fromEntries(Object.entries(x).filter(([k]) => k !== "sourceHash")),
  );
  return x;
}
test("RVOL-01 원본 315봉의 20세션 중앙값·현재 세션 제외 해석적 검산", () => {
  const f = fixture(),
    x = f.build(),
    r = rebuildRvol(x);
  assert.equal(r.selectedBarCount, 315);
  assert.equal(r.referenceWindows.length, 20);
  assert.equal(r.numerator, "315");
  assert.equal(r.denominator, "157.5");
  assert.equal(r.value, "2");
  assert.equal(x.history.sessions.length, 121);
  assert.ok(x.history.sessions.slice(0, -21).every((s) => s.rows.length === 0));
  assert.deepEqual(f.build(), x);
});
test("RVOL-02 원본 전략 계산과 독립 계산의 차등 대조", () => {
  const f = fixture();
  const bars: Bar[] = f.h.sessions.flatMap((s) =>
    s.rows.map((r) => ({
      session: s.sessionId,
      openAt: s.openAt + r.offset * minute,
      closeAt: s.openAt + (r.offset + 1) * minute,
      availableAt: r.availableAt,
      revision: r.revision,
      o: r.o!,
      h: r.h!,
      l: r.l!,
      c: r.c!,
      v: r.v!,
      halted: r.halted ?? true,
    })),
  );
  const sessions = f.h.sessions.map((s) => ({
    id: s.sessionId,
    open: s.openAt,
    close: s.closeAt,
    market: f.h.identity.market,
    version: "TEST_ONLY",
  }));
  assert.equal(
    indicators(bars, sessions, f.context.asOf).at(-1)!.rvol,
    rebuildRvol(f.build()).value,
  );
});
test("RVOL-03 현재 봉 누락·미완성·중단·음수/불가능 OHLC는 보류", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.current.rows = f.current.rows.filter((r) => r.offset !== 30);
    },
    (f: ReturnType<typeof fixture>) => {
      f.current.rows[30]!.completed = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.current.rows[30]!.halted = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.current.rows[30]!.v = "-1";
    },
    (f: ReturnType<typeof fixture>) => {
      f.current.rows[30]!.h = "0";
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(f.build, /RVOL_REQUIRED_BAR/);
  }
});
test("RVOL-04 직전 비교 세션 누락은 더 오래된 정상 세션으로 바꾸지 않음", () => {
  const f = fixture();
  f.h.sessions.at(-2)!.rows = f.h.sessions
    .at(-2)!
    .rows.filter((r) => r.offset !== 30);
  assert.throws(f.build, /RVOL_REQUIRED_BAR_MISSING/);
  const small = fixture();
  small.h.sessions = small.h.sessions.slice(-20);
  assert.throws(small.build, /RVOL_REFERENCE_SESSIONS_MISSING/);
});
test("RVOL-05 원본 순서·동일 중복·미래 봉/세션 추가는 과거 근거 불변", () => {
  const f = fixture(),
    before = f.build();
  f.current.rows.push(structuredClone(f.current.rows[30]!));
  for (const r of f.current.rows) if (r.offset >= 45) r.v = "999999";
  f.h.sessions.push({
    ...structuredClone(f.current),
    sessionId: "future-session",
    openAt: f.current.openAt + 86400000,
    closeAt: f.current.closeAt + 86400000,
    availableAt: f.current.openAt + 86400000,
    rows: [],
  });
  f.h.sessions.reverse();
  f.current.rows.reverse();
  assert.deepEqual(f.build(), before);
});
test("RVOL-06 나중 수신 정정은 과거 특징·근거 해시를 바꾸지 않음", () => {
  const f = fixture(),
    before = f.build();
  f.current.rows.push({
    ...f.current.rows[30]!,
    revision: 2,
    v: "999999",
    receivedAt: f.context.asOf + 1,
    availableAt: f.context.asOf + 1,
  });
  assert.deepEqual(f.build(), before);
});
test("RVOL-07 당시 공개된 최신 정정 적용·동일 최신 버전 상충 거절", () => {
  const f = fixture(),
    old = f.current.rows[30]!;
  f.current.rows.push({ ...old, revision: 2, v: "42" });
  const source = f.build();
  assert.equal(rebuildRvol(source).numerator, "336");
  assert.equal(source.history.sessions.at(-1)!.rows[0]!.revision, 2);
  f.current.rows.push({ ...old, revision: 2, v: "43" });
  assert.throws(f.build, /RVOL_REVISION_CONFLICT/);
});
test("RVOL-08 관측/수신/가용 시각 역전과 늦은 필수 봉 차단", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.current.rows[30]!.observedAt = f.current.openAt;
    },
    (f: ReturnType<typeof fixture>) => {
      f.current.rows[30]!.receivedAt = f.current.openAt;
    },
    (f: ReturnType<typeof fixture>) => {
      f.current.rows[30]!.receivedAt = f.context.asOf + 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.current.rows[30]!.availableAt = f.context.asOf + 1;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(f.build, /RVOL_REQUIRED_BAR/);
  }
});
test("RVOL-09 미래/미완료/정렬 불일치 신호 시각 차단", () => {
  for (const n of [1, -1, -15 * minute]) {
    const f = fixture();
    f.context.signalAt += n;
    assert.throws(f.build, /RVOL_SIGNAL_TIME_INVALID/);
  }
});
test("RVOL-10 효력 발생 분할만 거래량 단위에 한 번 반영", () => {
  const f = fixture();
  f.h.actions.push({
    eventId: "split",
    revision: 1,
    announcedAt: f.current.openAt - 1,
    availableAt: f.current.openAt - 1,
    effectiveAt: f.current.openAt,
    kind: "SPLIT",
    ratio: "2",
    cancelled: false,
  });
  const source = f.build(),
    r = rebuildRvol(source);
  assert.equal(r.denominator, "315");
  assert.equal(r.value, "1");
  assert.equal(source.history.sessions.at(-2)!.rows[0]!.v, "20");
  f.h.actions.push({
    ...f.h.actions[0]!,
    revision: 2,
    ratio: "4",
    availableAt: f.context.asOf + 1,
  });
  assert.deepEqual(f.build(), source);
  f.h.actions.push({
    ...f.h.actions[0]!,
    eventId: "future-split",
    effectiveAt: f.current.closeAt + 86400000,
  });
  assert.deepEqual(f.build(), source);
});
test("RVOL-11 분할 취소·중복·미지원·미확인 기업행동", () => {
  const f = fixture();
  const a = {
    eventId: "split",
    revision: 1,
    announcedAt: f.current.openAt - 1,
    availableAt: f.current.openAt - 1,
    effectiveAt: f.current.openAt,
    kind: "SPLIT" as const,
    ratio: "2",
    cancelled: false,
  };
  f.h.actions = [a, { ...a, revision: 2, cancelled: true }];
  assert.equal(rebuildRvol(f.build()).value, "2");
  f.h.actions = [a, { ...a, eventId: "duplicate" }];
  assert.throws(f.build, /RVOL_ACTION_CONFLICT/);
  f.h.actions = [{ ...a, kind: "UNSUPPORTED" }];
  assert.throws(f.build, /RVOL_ACTION_UNSUPPORTED/);
  f.h.actions = [];
  f.h.actionCoverage!.status = "UNKNOWN";
  assert.throws(f.build, /RVOL_ACTIONS_UNKNOWN/);
});
test("RVOL-12 조기 종료 비교 불가능 세션 제외·개장 기준 슬롯 보존", () => {
  const f = fixture(),
    shortened = f.h.sessions.at(-2)!;
  shortened.closeAt = shortened.openAt + 30 * minute;
  shortened.rows = shortened.rows.filter((r) => r.offset < 30);
  const r = rebuildRvol(f.build());
  assert.equal(r.referenceWindows.length, 20);
  assert.ok(
    !r.referenceWindows.some((w) => w.sessionId === shortened.sessionId),
  );
  assert.equal(
    r.referenceWindows[0]!.sessionId,
    f.h.sessions.at(-22)!.sessionId,
  );
});
test("RVOL-13 분모 0은 보류·현재 거래량 0은 수학적으로 0", () => {
  const f = fixture();
  for (const s of f.h.sessions.slice(0, -1)) for (const r of s.rows) r.v = "0";
  assert.throws(() => rebuildRvol(f.build()), /RVOL_ZERO_DENOMINATOR/);
  const zero = fixture();
  for (const r of zero.current.rows) r.v = "0";
  assert.equal(rebuildRvol(zero.build()).value, "0");
});
test("RVOL-14 봉/프로필 해시·과잉/미래 근거·스키마 변조 거절", () => {
  const original = fixture().build();
  const mutated = structuredClone(original);
  mutated.history.sessions.at(-1)!.rows[0]!.v = "999";
  assert.throws(() => rebuildRvol(mutated), /RVOL_SOURCE_HASH_MISMATCH/);
  mutated.strategyHash = hash("wrong");
  assert.throws(() => rebuildRvol(resign(mutated)), /RVOL_PROFILE_MISMATCH/);
  const extra = structuredClone(original);
  extra.history.sessions.at(-1)!.rows.push({
    ...extra.history.sessions.at(-1)!.rows[0]!,
    availableAt: extra.asOf + 1,
    revision: 2,
  });
  assert.throws(() => rebuildRvol(resign(extra)), /RVOL_SOURCE_SCHEMA_INVALID/);
  assert.throws(
    () => rebuildRvol({ ...original, execute: "not-allowed" }),
    /RVOL_SOURCE_SCHEMA_INVALID/,
  );
});
test("RVOL-15 봉 시각·세션 중복/겹침·조정주가·세션 공개 지연 차단", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.h.sessions[1]!.sessionId = f.h.sessions[0]!.sessionId;
    },
    (f: ReturnType<typeof fixture>) => {
      f.h.sessions[1]!.openAt = f.h.sessions[0]!.openAt;
    },
    (f: ReturnType<typeof fixture>) => {
      f.h.basis = "ADJUSTED";
    },
    (f: ReturnType<typeof fixture>) => {
      f.current.availableAt = f.context.asOf + 1;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(f.build, /RVOL_/);
  }
});
