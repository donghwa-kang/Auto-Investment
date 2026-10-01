import { test } from "node:test";
import assert from "node:assert/strict";
import { lastOnly, prepare } from "./signal-replay-helpers.js";
import { parseSignalReplay } from "../src/core/signal-replay-schema.js";
import { asOfBars } from "../src/core/strategy.js";
import { minute } from "../src/core/calendar.js";

test("HISTORY-01 120개 완료 세션·현재 60분·벤치마크 결합", () => {
  const f = lastOnly(),
    h = prepare(f);
  assert.deepEqual(h.reasons, []);
  assert.equal(h.counts.sessions, 120);
  assert.equal(h.bars.length, 7260);
  assert.equal(prepare(f, 2).reasons.length, 0);
});
test("HISTORY-02 부족한 이력과 과거 봉 누락은 보류·이전 세션 대체 없음", () => {
  const f = lastOnly();
  f.histories[0]!.sessions.shift();
  assert.ok(prepare(f).reasons.includes("HISTORY_WARMUP_MISSING"));
  const g = lastOnly();
  g.histories[0]!.sessions[4]!.rows.splice(4, 1);
  assert.ok(prepare(g).reasons.includes("HISTORY_BAR_MISSING"));
});
test("HISTORY-03 미완료·정지·0가격·음수 거래량·시점 오류 보류", () => {
  for (const mutate of [
    { completed: false },
    { halted: true },
    { halted: null },
    { c: "0" },
    { v: "-1" },
    { o: null },
    { observedAt: 0 },
    { receivedAt: 0 },
    { availableAt: 0 },
  ]) {
    const f = lastOnly();
    Object.assign(f.histories[0]!.sessions[0]!.rows[0]!, mutate);
    assert.ok(
      prepare(f).reasons.includes("HISTORY_BAR_INVALID"),
      JSON.stringify(mutate),
    );
  }
});
test("HISTORY-04 동일 버전 상충과 입력 순서 독립·상위 정정으로 해결", () => {
  const f = lastOnly(),
    rows = f.histories[0]!.sessions[0]!.rows;
  rows.push({ ...rows[0]!, c: "20001" });
  const h = prepare(f);
  assert.ok(h.reasons.includes("HISTORY_REVISION_CONFLICT"));
  rows.reverse();
  assert.equal(prepare(f).evidenceHash, h.evidenceHash);
  const original = rows.find((r) => r.offset === 0 && r.c === "20000")!;
  rows.push({ ...original, revision: 2 });
  assert.deepEqual(prepare(f).reasons, []);
});
test("HISTORY-05 미래 정정·미완성 시간 봉은 과거 판단에 혼입 안 함", () => {
  const f = lastOnly(),
    before = prepare(f),
    at = Date.parse(f.frames[0]!.asOf);
  const s = f.histories[0]!.sessions[0]!;
  s.rows.push({
    ...s.rows[0]!,
    revision: 99,
    c: "999999",
    h: "999999",
    availableAt: at + 1,
  });
  const future = f.histories[0]!.sessions.at(-1)!.rows.find(
    (r) => r.offset === 60,
  )!;
  Object.assign(future, {
    o: "999999",
    h: "999999",
    c: "999999",
    availableAt: at,
  });
  assert.equal(prepare(f).evidenceHash, before.evidenceHash);
});
test("HISTORY-06 현재 정정은 알려진 뒤 반영·과거 값 유지 금지", () => {
  const f = lastOnly(),
    before = prepare(f),
    rows = f.histories[0]!.sessions[0]!.rows;
  rows.push({
    ...rows[0]!,
    revision: 2,
    c: "20001",
    availableAt: Date.parse(f.frames[0]!.asOf),
  });
  const after = prepare(f);
  assert.equal(after.bars[0]!.c, "20001");
  assert.notEqual(after.evidenceHash, before.evidenceHash);
});
test("HISTORY-07 같은 현재 봉의 가격·버전·수신 시점 불일치 차단", () => {
  for (const mutate of [{ c: "21221" }, { revision: 2 }, { receivedAt: 0 }]) {
    const f = lastOnly();
    Object.assign(f.histories[0]!.sessions.at(-1)!.rows[0]!, mutate);
    assert.ok(prepare(f).reasons.includes("HISTORY_WINDOW_MISMATCH"));
  }
});
test("HISTORY-08 다른 종목·출처·통화·수정 가격·이력 누락", () => {
  for (const mutate of [
    { sourceId: "WRONG" },
    { assetKey: "WRONG" },
    { basis: "ADJUSTED" as const },
  ]) {
    const f = lastOnly();
    Object.assign(f.histories[0]!, mutate);
    assert.ok(prepare(f).reasons.length);
  }
  const f = lastOnly();
  f.histories[0]!.identity.currency = "USD";
  assert.ok(prepare(f).reasons.includes("HISTORY_IDENTITY_MISMATCH"));
  f.histories.shift();
  assert.ok(prepare(f).reasons.includes("HISTORY_MISSING"));
});
test("HISTORY-09 겹친 세션·불완전 분 길이·현재 세션 불일치·늦은 달력", () => {
  for (const change of ["overlap", "fraction", "current", "late"] as const) {
    const f = lastOnly(),
      h = f.histories[0]!;
    if (change === "overlap") h.sessions[1]!.openAt = h.sessions[0]!.openAt;
    if (change === "fraction") h.sessions[0]!.closeAt++;
    if (change === "current") h.sessions.at(-1)!.sessionId = "OTHER";
    if (change === "late")
      h.sessions[0]!.availableAt = h.sessions[0]!.openAt + 1;
    assert.ok(prepare(f).reasons.length, change);
  }
});
test("HISTORY-10 기업행동 확인 범위/시점 부족·미확인 보류", () => {
  for (const change of ["null", "unknown", "from", "to", "future"] as const) {
    const f = lastOnly(),
      h = f.histories[0]!;
    if (change === "null") h.actionCoverage = null;
    else if (change === "unknown") h.actionCoverage!.status = "UNKNOWN";
    else if (change === "from") h.actionCoverage!.from++;
    else if (change === "to") h.actionCoverage!.to = 0;
    else h.actionCoverage!.availableAt = Date.parse(f.frames[0]!.asOf) + 1;
    assert.ok(prepare(f).reasons.includes("HISTORY_ACTIONS_UNKNOWN"));
  }
});
function split(f = lastOnly()) {
  const h = f.histories[0]!,
    at = h.sessions.at(-1)!.openAt;
  const action = {
    eventId: "SPLIT-1",
    revision: 1,
    announcedAt: at - minute,
    availableAt: at - minute,
    effectiveAt: at,
    ratio: "2",
    kind: "SPLIT" as const,
    cancelled: false,
  };
  h.actions.push(action);
  return { f, h, action };
}
test("HISTORY-11 세션 개장 분할: 과거 가격 /2·거래량 *2·현재 원시값 유지", () => {
  const { f } = split(),
    h = prepare(f);
  assert.deepEqual(h.reasons, []);
  const adjusted = asOfBars(h.bars, Date.parse(f.frames[0]!.asOf), h.actions);
  assert.equal(adjusted[0]!.c, "10000");
  assert.equal(adjusted[0]!.v, "40000");
  assert.equal(adjusted.at(-1)!.c, h.bars.at(-1)!.c);
  assert.equal(h.bars[0]!.c, "20000");
});
test("HISTORY-12 미래 효력/미래 수신 분할 배제·늦은 알려짐은 이후에만 반영", () => {
  const base = prepare(lastOnly());
  for (const mode of ["effectiveAt", "availableAt"] as const) {
    const { f, action } = split();
    action[mode] = Date.parse(f.frames[0]!.asOf) + 1;
    assert.equal(prepare(f).evidenceHash, base.evidenceHash);
  }
});
test("HISTORY-13 기업행동 상충·0비율·장중 분할·미지원은 보류", () => {
  const { f, h, action } = split();
  h.actions.push({ ...action, ratio: "3" });
  assert.ok(prepare(f).reasons.includes("HISTORY_ACTION_CONFLICT"));
  h.actions.reverse();
  assert.ok(prepare(f).reasons.includes("HISTORY_ACTION_CONFLICT"));
  for (const change of [
    { ratio: "0" },
    { effectiveAt: action.effectiveAt + minute },
    { kind: "UNSUPPORTED" as const },
  ]) {
    const x = split();
    Object.assign(x.action, change);
    assert.ok(prepare(x.f).reasons.includes("HISTORY_ACTION_UNSUPPORTED"));
  }
});
test("HISTORY-14 기업행동 취소 정정과 병합·다중 분할", () => {
  const { f, h, action } = split();
  h.actions.push({ ...action, revision: 2, cancelled: true });
  assert.equal(prepare(f).actions.length, 0);
  h.actions = [
    { ...action, ratio: "0.5" },
    {
      ...action,
      eventId: "SPLIT-2",
      effectiveAt: h.sessions[20]!.openAt,
      ratio: "2",
    },
  ];
  const ready = prepare(f),
    rows = asOfBars(ready.bars, Date.parse(f.frames[0]!.asOf), ready.actions);
  assert.deepEqual(ready.reasons, []);
  assert.equal(rows[0]!.c, "20000");
});
test("HISTORY-15 완전 중복·세션/봉 순서·미래 세션 prefix 재현", () => {
  const f = lastOnly(),
    before = prepare(f),
    h = f.histories[0]!;
  h.sessions[0]!.rows.push({ ...h.sessions[0]!.rows[0]! });
  h.sessions.reverse();
  for (const s of h.sessions) s.rows.reverse();
  assert.equal(prepare(f).evidenceHash, before.evidenceHash);
  const at = Date.parse(f.frames[0]!.asOf);
  for (const s of h.sessions)
    s.rows = s.rows.filter(
      (r) => r.availableAt <= at && s.openAt + (r.offset + 1) * minute <= at,
    );
  assert.equal(prepare(f).evidenceHash, before.evidenceHash);
});
test("HISTORY-16 엄격한 시험 계약·중복 ID·시점·자원 경계", () => {
  const f = lastOnly();
  for (const raw of [
    { ...f, purpose: "REAL_DATA" },
    { ...f, approved: true },
    { ...f, histories: [...f.histories, f.histories[0]] },
    { ...f, frames: [f.frames[0], f.frames[0]] },
  ])
    assert.throws(() => parseSignalReplay(raw), /SIGNAL_REPLAY_INPUT_INVALID/);
  const g = lastOnly();
  g.histories[0]!.sessions.push(g.histories[0]!.sessions[0]!);
  assert.throws(() => parseSignalReplay(g), /SIGNAL_REPLAY_INPUT_INVALID/);
  const wrong = lastOnly();
  wrong.frames[0]!.market!.asOf = "2026-09-01T00:00:00.000Z";
  assert.throws(
    () => parseSignalReplay(wrong),
    /MULTI_PREFLIGHT_AS_OF_MISMATCH/,
  );
});
test("HISTORY-17 과거 세션의 미래 공개는 세션 수가 많아도 보류", () => {
  const f = lastOnly();
  f.histories[0]!.sessions[0]!.availableAt = Date.parse(f.frames[0]!.asOf) + 1;
  assert.ok(prepare(f).reasons.includes("HISTORY_SESSION_INVALID"));
});
test("HISTORY-18 미래 효력 상충은 현재 제외·현재/미래 혼합 상충은 순서 무관 보류", () => {
  const { f, h, action } = split(),
    at = Date.parse(f.frames[0]!.asOf);
  const before = prepare(lastOnly());
  action.effectiveAt = at + minute;
  h.actions.push({ ...action, ratio: "3" });
  assert.equal(prepare(f).evidenceHash, before.evidenceHash);
  h.actions[1]!.effectiveAt = h.sessions.at(-1)!.openAt;
  assert.ok(prepare(f).reasons.includes("HISTORY_ACTION_CONFLICT"));
  h.actions.reverse();
  assert.ok(prepare(f).reasons.includes("HISTORY_ACTION_CONFLICT"));
});
test("HISTORY-19 같은 효력의 별도 분할 ID 중복 적용은 보류", () => {
  const { f, h, action } = split();
  h.actions.push({ ...action, eventId: "DUPLICATE-EFFECT" });
  assert.ok(prepare(f).reasons.includes("HISTORY_ACTION_CONFLICT"));
});
test("HISTORY-20 분할 사건 버전·근거 해시 보존 및 명시적 작업량 상한", () => {
  const { f, h, action } = split(),
    before = prepare(f);
  h.actions = [{ ...action, revision: 2 }];
  const after = prepare(f);
  assert.equal(after.actionEvidence[0]!.revision, 2);
  assert.notEqual(after.evidenceHash, before.evidenceHash);
  const big = lastOnly();
  big.histories[0]!.sessions[0]!.closeAt += 3_000_000 * minute;
  assert.throws(() => parseSignalReplay(big), /SIGNAL_REPLAY_INPUT_INVALID/);
});
