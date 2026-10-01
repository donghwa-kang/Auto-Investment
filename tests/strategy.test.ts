import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asOfBars,
  aggregate,
  indicators,
  evaluateFeatures,
  roundedEntry,
  type Bar,
  type Feature,
} from "../src/core/strategy.js";
import { session, minute } from "../src/core/calendar.js";
import { adverseBarOutcome } from "../src/core/simulator.js";
import { hash } from "../src/core/policy.js";
const s = session("2026-08-31", "KR")!;
function bar(i: number): Bar {
  return {
    session: s.id,
    openAt: s.open + i * minute,
    closeAt: s.open + (i + 1) * minute,
    availableAt: s.open + (i + 1) * minute,
    revision: 1,
    o: "100",
    h: "110",
    l: "90",
    c: "100",
    v: "10",
  };
}
const raw = Array.from({ length: 390 }, (_, i) => bar(i));
test("DATA-01 미완료/수신지연/최신 정정 as-of", () => {
  const b = bar(0),
    revision = { ...b, revision: 2, c: "101", availableAt: b.closeAt + 1000 };
  assert.equal(asOfBars([b, revision], b.closeAt)[0]!.c, "100");
  assert.equal(asOfBars([b, revision], b.closeAt + 1000)[0]!.c, "101");
  assert.equal(asOfBars([b], b.closeAt - 1).length, 0);
  assert.equal(
    asOfBars([{ ...b, availableAt: b.closeAt + 1 }], b.closeAt).length,
    0,
  );
});
test("DATA-02 집계 누락·중단 봉 압축 금지", () => {
  assert.equal(
    aggregate(raw.slice(0, 15), [s], s.open + 15 * minute).bars.length,
    1,
  );
  assert.equal(
    aggregate(
      raw.filter((_, i) => i !== 5),
      [s],
      s.open + 15 * minute,
    ).bars.length,
    0,
  );
  assert.equal(
    aggregate(
      raw.map((b, i) => (i === 5 ? { ...b, halted: true } : b)),
      [s],
      s.open + 15 * minute,
    ).bars.length,
    0,
  );
});
test("CA-01 효력/공개/수신 시점별 분할", () => {
  const a = {
    announcedAt: s.open,
    availableAt: s.open,
    effectiveAt: s.open + 2 * minute,
    ratio: "2",
  };
  assert.equal(asOfBars([bar(0)], s.open + minute, [a])[0]!.c, "100");
  const adjusted = asOfBars([bar(0)], s.open + 2 * minute, [a])[0]!;
  assert.equal(adjusted.c, "50");
  assert.equal(adjusted.v, "20");
  assert.equal(
    asOfBars([bar(0)], s.open + 2 * minute, [
      { ...a, availableAt: s.open + 3 * minute },
    ])[0]!.c,
    "100",
  );
});
test("IND-01 ATR14/EMA20 초기 평균·VWAP 및 RVOL 부족", () => {
  const f = indicators(raw, [s], s.close);
  assert.equal(f[12]!.atr, null);
  assert.equal(f[13]!.atr, "20");
  assert.equal(f[19]!.ema, "100");
  assert.equal(f[18]!.ema, null);
  assert.equal(f.at(-1)!.vwap, "100");
  assert.equal(f.at(-1)!.rvol, null);
  assert.equal(f.at(-1)!.volCeiling, null);
});
test("PIT-01 prefix/미래 변조 불변·잘못된 검사기 양성", () => {
  const at = s.open + 60 * minute,
    mutated = raw.map((b) =>
      b.closeAt > at ? { ...b, c: "999999", h: "999999", v: "999999" } : b,
    );
  const before = indicators(raw, [s], at),
    prefix = indicators(
      raw.filter((b) => b.closeAt <= at),
      [s],
      at,
    );
  assert.equal(hash(before), hash(prefix));
  assert.equal(hash(before), hash(indicators(mutated, [s], at)));
  const deliberatelyLeaky = (bars: Bar[]) => bars.at(-1)!.c;
  assert.notEqual(deliberatelyLeaky(raw), deliberatelyLeaky(mutated));
});
function features(): Feature[] {
  return [0, 1, 2, 3].map((i) => ({
    ...bar(i * 15),
    openAt: s.open + i * 15 * minute,
    closeAt: s.open + (i + 1) * 15 * minute,
    availableAt: s.open + (i + 1) * 15 * minute,
    slot: i,
    atr: "100",
    ema: String(1000 + i * 2),
    vwap: "1000",
    rvol: "1.5",
    orh: "1080",
    volCeiling: "1",
    o: "1050",
    h: i === 2 ? "1090" : "1100",
    l: "1000",
    c: i === 3 ? "1100" : "1050",
    v: "200",
  }));
}
const trend = {
  close: "1050",
  sma20: "1020",
  sma60: "1000",
  turnover: "20000000000",
  count: 120,
};
function evaluate(fs = features()) {
  const bench = features();
  return evaluateFeatures(
    fs,
    bench,
    trend,
    trend,
    s,
    s.open + 60 * minute,
    "DEMO",
  );
}
test("SIGNAL-01 B 엄격 돌파·포함 RVOL 경계", () => {
  let f = features();
  assert.ok(evaluate(f).strategies.includes("B"));
  f[3]!.c = "1085";
  assert.equal(evaluate(f).strategies.includes("B"), false);
  f = features();
  f[3]!.rvol = "1.499999";
  assert.equal(evaluate(f).strategies.includes("B"), false);
});
test("SIGNAL-02 P 각각의 엄격/포함 경계", () => {
  const f = features();
  f[3]!.c = "1100";
  f[3]!.ema = "1020";
  f[0]!.ema = "1010";
  f[3]!.rvol = "1.2";
  assert.ok(evaluate(f).strategies.includes("P"));
  f[3]!.ema = "1010";
  assert.equal(evaluate(f).strategies.includes("P"), false);
  f[3]!.ema = "1020";
  f[3]!.c = f[2]!.h;
  assert.equal(evaluate(f).strategies.includes("P"), false);
});
test("SIGNAL-03 P 누락·B/P 중단창·동시 신호 기록", () => {
  const f = features();
  f[3]!.ema = "1020";
  assert.equal(evaluate(f).strategies.length, 2);
  f[1]!.closeAt -= minute;
  assert.equal(evaluate(f).strategies.includes("P"), false);
  f[3]!.rvol = null;
  assert.equal(evaluate(f).strategies.length, 0);
});
test("SIGNAL-04 호가 올림/손절 내림 뒤 거리 재검사", () => {
  const e = evaluate();
  e.stops.B = "1019.1";
  e.current!.c = "1100";
  assert.equal(roundedEntry(e, "B", "1100", "1").S, "1019");
  assert.equal(roundedEntry(e, "B", "1100", "1").valid, true);
  e.stops.B = "1021.01";
  assert.equal(roundedEntry(e, "B", "1100", "1").valid, false);
  assert.equal(roundedEntry(e, "B", "1110.01", "1").valid, false);
});
test("EXEC-01 OHLC 접촉은 체결 아님·동일 봉 불리한 순서", () => {
  assert.equal(
    adverseBarOutcome("90", "130", "95", "120"),
    "ADVERSE_STOP_FIRST_UNRESOLVED_FILL",
  );
  assert.equal(
    adverseBarOutcome("94", "110", "95", "120"),
    "STOP_TRIGGER_ONLY",
  );
});
