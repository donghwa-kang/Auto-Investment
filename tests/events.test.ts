import { test } from "node:test";
import assert from "node:assert/strict";
import { configured, run, state } from "./helpers.js";
import {
  applySplit,
  dividendReceivable,
  eventGate,
  holdingDeadline,
} from "../src/core/events.js";
import { equity, settle } from "../src/core/ledger.js";
import { minute } from "../src/core/calendar.js";
test("EVENT-01 일정 누락·전후30분·90분/종가/사건청산", () => {
  const events = [
    { id: "synthetic", start: 100 * minute, end: 110 * minute, availableAt: 0 },
  ];
  assert.equal(eventGate(70 * minute, events), false);
  assert.equal(eventGate(140 * minute, events), false);
  assert.equal(eventGate(141 * minute, events), true);
  assert.equal(eventGate(0, null), false);
  assert.equal(holdingDeadline(0, 200 * minute, events), 85 * minute);
  assert.equal(holdingDeadline(0, 200 * minute, []), 90 * minute);
  assert.equal(holdingDeadline(0, 60 * minute, []), 50 * minute);
});
test("CA-LEDGER-01 2:1 분할 수량/경제가치·중복 인식 없음", async () => {
  const e = await configured();
  try {
    await run(e, "start");
    await run(e, "step", { seconds: 10 });
    const s = e.state(),
      before = equity(s).toString(),
      p = s.positions[0]!;
    assert.equal(
      applySplit(s, "split-1", p.symbol, "2", s.clock, s.clock),
      true,
    );
    assert.equal(p.quantity, 8);
    assert.equal(equity(s).toString(), before);
    applySplit(s, "split-1", p.symbol, "2", s.clock, s.clock);
    assert.equal(p.quantity, 8);
    assert.equal(p.stop, "10560.5");
  } finally {
    e.close();
  }
});
test("CA-LEDGER-02 배당 채권·원천 차감·지급 중복 없음", () => {
  const s = state();
  assert.equal(
    dividendReceivable(s, "div1", "KRW", "100", "15", s.clock + 1),
    false,
  );
  dividendReceivable(s, "div1", "KRW", "100", "15", s.clock);
  assert.equal(equity(s).toString(), "5000085");
  dividendReceivable(s, "div1", "KRW", "100", "15", s.clock);
  settle(s, "KRW");
  assert.equal(s.ledger.wallets.KRW.cash, "5000085");
});
