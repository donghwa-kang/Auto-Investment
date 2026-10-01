import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortfolioProgram } from "../src/core/portfolio-program.js";
import { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import { portfolioFixture, laterTick } from "../src/core/portfolio-fixture.js";
import { replayFixture } from "./signal-replay-helpers.js";
import { checkPortfolioInvariants } from "../src/core/portfolio-invariants.js";
import { d } from "../src/core/math.js";
import { terminal } from "../src/core/types.js";
import { makeSignalReplayFixture } from "../src/core/signal-replay-fixture.js";
import { hash } from "../src/core/policy.js";
import { caps } from "../src/core/ledger.js";
import { openRisk, notional, guards } from "../src/core/risk.js";
import { simulatorStep } from "../src/core/simulator.js";

const input = replayFixture();
const fixture = portfolioFixture(input),
  base = fixture.ticks[0]!;
const program = new PortfolioProgram(input, fixture.settings);
function started() {
  const e = new PortfolioPaperEngine(program);
  e.command("start", { type: "start" });
  e.command("frame", base);
  return e;
}
test("PORTFOLIO-01 검증된 다종목 프레임→공용 심사→별도 예약/체결/청산", () => {
  const e = new PortfolioPaperEngine(program);
  try {
    for (const [i, c] of fixture.commands.entries())
      e.command(`sample-${i}`, c);
    const s = e.state();
    assert.equal(s.decisions.filter((d) => d.result === "APPROVED").length, 2);
    assert.equal(s.positions.length, 2);
    assert.ok(s.positions.every((p) => p.quantity === 0 && p.closedAt));
    assert.ok(s.orders.every(terminal));
    assert.equal(s.ledger.wallets.USD.cash, "0");
    checkPortfolioInvariants(s, program.initial(s.epoch));
    assert.ok(e.repo.verifyAudit() > 40);
  } finally {
    e.close();
  }
});
test("PORTFOLIO-02 명령 중복/충돌과 시간 역행은 새 주문을 만들지 않는다", async () => {
  const e = started();
  try {
    assert.equal(e.state().orders.length, 1);
    const before = e.state();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        Promise.resolve().then(() => e.command("frame", base)),
      ),
    );
    assert.deepEqual(e.state(), before);
    assert.throws(
      () => e.command("frame", laterTick(base, 1)),
      /COMMAND_ID_CONFLICT/,
    );
    assert.throws(() => e.command("another", base), /NON_MONOTONIC/);
    assert.deepEqual(e.state(), before);
  } finally {
    e.close();
  }
});
test("PORTFOLIO-03 다른 종목의 호가는 매수/보호 가격으로 사용되지 않는다", () => {
  const e = started();
  try {
    const tick = laterTick(base, 1);
    tick.quotes = tick.quotes.slice(1);
    e.command("missing", tick);
    const s = e.state();
    assert.equal(s.positions.length, 0);
    assert.equal(s.orders[0]!.filled, 0);
    assert.equal(s.orders[0]!.status, "CANCELLED");
    assert.equal(s.status, "ENTRY_PAUSED");
  } finally {
    e.close();
  }
});
test("PORTFOLIO-04 부분 체결·취소 중 추가 체결·최종 예약 해제", () => {
  const e = started();
  try {
    e.command("t1", laterTick(base, 1));
    e.command("t2", laterTick(base, 2));
    assert.equal(e.state().positions[0]!.quantity, 1);
    e.command("pause", { type: "pause" });
    e.command("t3", laterTick(base, 3));
    assert.equal(e.state().positions[0]!.quantity, 2);
    e.command("t4", laterTick(base, 4));
    const s = e.state();
    assert.equal(s.orders[0]!.status, "CANCELLED");
    assert.equal(s.orders[0]!.reservationCash, "0");
    assert.equal(s.orders[0]!.reservationRisk, "0");
    assert.equal(s.positions[0]!.protectedQuantity, 2);
  } finally {
    e.close();
  }
});
test("PORTFOLIO-05 저장 실패는 주문·장부·예약·커서 전체를 롤백", () => {
  const e = started();
  try {
    const before = e.state();
    e.repo.failure = "DISK_FULL";
    assert.throws(() => e.command("t1", laterTick(base, 1)), /DISK_FULL/);
    assert.deepEqual(e.state(), before);
    e.repo.failure = null;
    e.command("t1", laterTick(base, 1));
    assert.equal(e.state().cursor, before.cursor + 1);
  } finally {
    e.repo.failure = null;
    e.close();
  }
});
test("PORTFOLIO-06 재시작은 RECONCILING·예약 보존, 취소 대조 후만 재개", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "portfolio-restart-")),
    "paper.sqlite",
  );
  let e = new PortfolioPaperEngine(program, path);
  e.command("start", { type: "start" });
  e.command("frame", base);
  e.command("t1", laterTick(base, 1));
  e.command("t2", laterTick(base, 2));
  const before = e.state();
  e.close();
  e = new PortfolioPaperEngine(program, path, { resume: true });
  try {
    assert.equal(e.state().status, "RECONCILING");
    assert.equal(
      e.state().orders[0]!.reservationCash,
      before.orders[0]!.reservationCash,
    );
    assert.throws(
      () => e.command("start2", { type: "start" }),
      /NOT_RECONCILED/,
    );
    assert.throws(
      () => e.command("reconcile", { type: "reconcile" }),
      /CANCEL_UNRESOLVED/,
    );
    e.command("t3", laterTick(base, 3));
    e.command("t4", laterTick(base, 4));
    e.command("reconcile", { type: "reconcile" });
    e.command("start2", { type: "start" });
    const s = e.state();
    e.command("frame", base);
    assert.deepEqual(e.state(), s);
    assert.equal(s.decisions.filter((x) => x.result === "APPROVED").length, 1);
  } finally {
    e.close();
  }
  const bytes = readFileSync(path);
  assert.throws(
    () => new PortfolioPaperEngine(program, path),
    /NEW_DB_REQUIRED/,
  );
  assert.deepEqual(readFileSync(path), bytes);
});
for (const kind of ["profile", "order", "forecast"] as const)
  test(`PORTFOLIO-07 ${kind} 누락은 ABSTAIN`, () => {
    const settings = structuredClone(fixture.settings);
    if (kind === "profile") settings.syntheticProfileHash = null;
    if (kind === "order") settings.candidateOrder = null;
    if (kind === "forecast") settings.config.forecast = "MISSING_PROFILE";
    const p = new PortfolioProgram(input, settings),
      e = new PortfolioPaperEngine(p);
    try {
      e.command("start", { type: "start" });
      e.command("frame", base);
      assert.equal(e.state().orders.length, 0);
      assert.ok(e.state().decisions.every((d) => d.result === "ABSTAIN"));
    } finally {
      e.close();
    }
  });
test("PORTFOLIO-08 손상 장부·보유·예약은 감지되고 작업을 막는다", () => {
  const e = started();
  try {
    e.command("t1", laterTick(base, 1));
    e.command("t2", laterTick(base, 2));
    for (const type of ["wallet", "position", "reservation"]) {
      const s = e.state();
      if (type === "wallet")
        s.ledger.wallets.KRW.cash = d(s.ledger.wallets.KRW.cash)
          .plus(1)
          .toString();
      if (type === "position") s.positions[0]!.quantity++;
      if (type === "reservation") s.orders[0]!.reservationCash = "0";
      assert.throws(
        () => checkPortfolioInvariants(s, program.initial(s.epoch)),
        /PORTFOLIO_INVARIANT/,
      );
    }
  } finally {
    e.close();
  }
});
test("PORTFOLIO-09 같은 시각 두 유효 신호는 하나의 PILOT 슬롯/자금을 경쟁한다", () => {
  const raw = replayFixture();
  raw.frames = raw.frames.slice(0, 1);
  const own = raw.histories[1]!,
    source = raw.histories[0]!;
  own.sessions = structuredClone(source.sessions);
  const frame = raw.frames[0]!;
  frame.market!.records = frame.market!.records.filter(
    (r) => r.assetKey !== own.assetKey,
  );
  frame.market!.records.push(
    ...frame
      .market!.records.filter((r) => r.assetKey === source.assetKey)
      .map((r) => ({
        ...structuredClone(r),
        assetKey: own.assetKey,
        identity: own.identity,
        recordId: `copy-${r.recordId}`,
      })),
  );
  const f = portfolioFixture(raw),
    p = new PortfolioProgram(raw, f.settings),
    e = new PortfolioPaperEngine(p);
  try {
    assert.equal(p.report().counts.signals, 2);
    e.command("start", { type: "start" });
    e.command("batch", f.ticks[0]!);
    const s = e.state();
    assert.equal(s.orders.length, 1);
    assert.equal(s.decisions.length, 2);
    assert.equal(s.decisions[1]!.result, "ABSTAIN");
    assert.ok(s.decisions[1]!.reasons.includes("POSITION_LIMIT"));
    assert.ok(openRisk(s).lte(caps(s).risk));
    assert.ok(notional(s).lte(caps(s).notional));
    assert.equal(
      s.orders[0]!.snapshot!.instrument_id,
      f.settings.candidateOrder![0],
    );
  } finally {
    e.close();
  }
});
test("PORTFOLIO-10 부분 체결된 같은 종목의 보유와 미체결을 두 슬롯으로 세지 않는다", () => {
  const e = started();
  try {
    e.command("t1", laterTick(base, 1));
    e.command("t2", laterTick(base, 2));
    const s = e.state();
    s.config!.stage = "STANDARD";
    assert.ok(
      !guards(
        s,
        laterTick(base, 2).quotes[0]!.quote,
        s.clock,
        "new-symbol",
      ).includes("POSITION_LIMIT"),
    );
  } finally {
    e.close();
  }
});
for (const kind of ["quote", "account", "fx", "future", "binding"] as const)
  test(`PORTFOLIO-11 ${kind} 불명확 시 진입 보류`, () => {
    const e = new PortfolioPaperEngine(program);
    try {
      const t = structuredClone(base);
      if (kind === "quote") t.quotes[0]!.quote.at -= 2001;
      if (kind === "account") t.accountAt -= 5001;
      if (kind === "fx") t.fx.at -= 60001;
      if (kind === "future") t.quotes[0]!.availableAt++;
      if (kind === "binding")
        t.quotes[0]!.quote.ask = d(t.quotes[0]!.quote.ask).plus(1).toString();
      e.command("start", { type: "start" });
      e.command("frame", t);
      assert.equal(e.state().orders.length, 0);
      assert.ok(e.state().decisions[0]!.reasons.length);
    } finally {
      e.close();
    }
  });
test("PORTFOLIO-12 노출 중 시계 건너뛰기·중복/알 수 없는 호가 거절", () => {
  const e = started();
  try {
    assert.throws(
      () => e.command("gap", laterTick(base, 10)),
      /EXPOSED_TIME_GAP/,
    );
    const tick = laterTick(base, 1);
    tick.quotes.push(structuredClone(tick.quotes[0]!));
    assert.throws(() => e.command("dup", tick));
    tick.quotes.pop();
    tick.quotes[0]!.catalogKey = "UNKNOWN";
    assert.throws(() => e.command("unknown", tick), /UNKNOWN_INSTRUMENT/);
    assert.equal(e.state().cursor, 1);
  } finally {
    e.close();
  }
});
test("PORTFOLIO-13 KR/US 공통 장부, 별도 통화와 종목 세션·틱, 손실 횟수 공유", () => {
  const us = makeSignalReplayFixture("US");
  for (const h of us.histories)
    for (const s of h.sessions.slice(0, -1)) {
      s.closeAt = s.openAt + 60 * 60000;
      s.rows = s.rows.filter((r) => r.offset < 60);
    }
  const raw = replayFixture();
  raw.frames = [raw.frames[0]!, us.frames[0]!];
  raw.histories.push(...us.histories);
  // 미국 합성 가격은 1주가 LOW/PILOT 종목 한도보다 크다. 정책을 바꾸지 않고
  // 명시적 MEDIUM/STANDARD 및 작은 시험 호가 잔량으로 두 통화 체결 경로를 시험한다.
  for (const frame of raw.frames)
    for (const row of frame.market!.records)
      if (row.kind === "QUOTE") {
        row.askSize = "20";
        row.bidSize = "20";
      }
  const f = portfolioFixture(raw);
  f.settings.config.usdCapitalKrw = 650000;
  f.settings.config.level = "MEDIUM";
  f.settings.config.stage = "STANDARD";
  const p = new PortfolioProgram(raw, f.settings),
    e = new PortfolioPaperEngine(p);
  try {
    for (const [i, c] of f.commands.entries()) e.command(`mixed-${i}`, c);
    const s = e.state();
    assert.equal(s.positions.length, 2);
    assert.deepEqual(
      s.positions.map((x) => x.currency),
      ["KRW", "USD"],
    );
    assert.deepEqual(
      s.positions.map((x) => x.market),
      ["KR", "US"],
    );
    assert.ok(s.positions[1]!.deadline > s.positions[0]!.deadline);
    assert.ok(d(s.ledger.wallets.USD.cash).gt(0));
    assert.equal(s.ledger.lossStreak, 2);
    assert.ok(s.ledger.halts.includes("CONSECUTIVE_LOSSES"));
    assert.ok(s.orders.every(terminal));
  } finally {
    e.close();
  }
});
test("PORTFOLIO-14 USD 잔고 없이 미국 주문에 KRW 자동 대체 금지", () => {
  const us = makeSignalReplayFixture("US");
  us.frames = us.frames.slice(0, 1);
  for (const h of us.histories)
    for (const s of h.sessions.slice(0, -1)) {
      s.closeAt = s.openAt + 60 * 60000;
      s.rows = s.rows.filter((r) => r.offset < 60);
    }
  const f = portfolioFixture(us),
    p = new PortfolioProgram(us, f.settings),
    e = new PortfolioPaperEngine(p);
  try {
    e.command("start", { type: "start" });
    e.command("frame", f.ticks[0]!);
    assert.equal(e.state().orders.length, 0);
    assert.ok(e.state().decisions[0]!.reasons.includes("NO_FEASIBLE_LOT"));
  } finally {
    e.close();
  }
});
test("PORTFOLIO-15 시간 청산/갭 손절은 종목별 처리하고 미체결을 완료로 표시하지 않는다", () => {
  const e = started();
  try {
    for (let i = 1; i <= 6; i++) e.command(`t${i}`, laterTick(base, i));
    const s = e.state(),
      p = s.positions[0]!,
      q = structuredClone(base.quotes[0]!.quote);
    s.clock = p.deadline;
    q.at = s.clock;
    simulatorStep(s, q, "US:NOT_THIS_ASSET");
    assert.equal(p.exitReason, undefined);
    simulatorStep(s, q, p.symbol);
    assert.equal(p.exitReason, "TIME");
    assert.equal(s.orders.at(-1)!.side, "SELL");
    assert.ok(p.quantity > 0);
    const gap = e.state(),
      gp = gap.positions[0]!,
      gq = {
        ...q,
        at: gap.clock + 1000,
        bid: d(gp.stop).mul("0.9").toString(),
        ask: d(gp.stop).mul("0.9").toString(),
      };
    for (let i = 0; i < 8; i++) {
      gap.clock += 1000;
      gq.at = gap.clock;
      simulatorStep(gap, gq, gp.symbol);
    }
    assert.ok(gp.quantity > 0);
    assert.equal(gp.closedAt, undefined);
  } finally {
    e.close();
  }
});
test("PORTFOLIO-16 UNKNOWN은 재시작 대조로 성공 위장하거나 예약 해제하지 않는다", () => {
  const e = started();
  try {
    e.repo.transact("test-unknown", { test: true }, (s) => {
      s!.orders[0]!.status = "UNKNOWN";
      s!.status = "RECONCILING";
      return s!;
    });
    const before = hash(e.state());
    assert.throws(
      () => e.command("reconcile", { type: "reconcile" }),
      /UNKNOWN_UNRESOLVED/,
    );
    assert.equal(hash(e.state()), before);
    assert.ok(d(e.state().orders[0]!.reservationCash).gt(0));
  } finally {
    e.close();
  }
});
test("PORTFOLIO-17 보유 중 공개/효력 발생 기업행동은 자동 수량 변환 없이 대조 잠금", () => {
  const raw = replayFixture();
  raw.histories[0]!.actions.push({
    eventId: "LATE-SPLIT",
    revision: 1,
    announcedAt: base.at + 3000,
    availableAt: base.at + 3000,
    effectiveAt: base.at + 3000,
    kind: "SPLIT",
    ratio: "2",
    cancelled: false,
  });
  const p = new PortfolioProgram(raw, fixture.settings),
    e = new PortfolioPaperEngine(p);
  try {
    e.command("start", { type: "start" });
    e.command("frame", base);
    e.command("t1", laterTick(base, 1));
    e.command("t2", laterTick(base, 2));
    assert.equal(e.state().positions[0]!.quantity, 1);
    e.command("t3", laterTick(base, 3));
    const s = e.state();
    assert.equal(s.positions[0]!.quantity, 1);
    assert.equal(s.status, "RECONCILING");
    assert.equal(s.fault, "CORPORATE_ACTION_RECONCILIATION_REQUIRED");
    assert.throws(
      () => e.command("reconcile", { type: "reconcile" }),
      /FAULT_UNRESOLVED/,
    );
    assert.ok(d(s.orders[0]!.reservationCash).gt(0));
  } finally {
    e.close();
  }
});
test("PORTFOLIO-18 2개 STANDARD 후보 예약도 합산 위험/위험군/현금 한도를 넘지 않는다", () => {
  const raw = replayFixture();
  raw.frames = raw.frames.slice(0, 1);
  const own = raw.histories[1]!,
    source = raw.histories[0]!;
  own.sessions = structuredClone(source.sessions);
  const frame = raw.frames[0]!;
  frame.market!.records = frame.market!.records.filter(
    (r) => r.assetKey !== own.assetKey,
  );
  frame.market!.records.push(
    ...frame
      .market!.records.filter((r) => r.assetKey === source.assetKey)
      .map((r) => ({
        ...structuredClone(r),
        assetKey: own.assetKey,
        identity: own.identity,
        recordId: `copy-${r.recordId}`,
      })),
  );
  const f = portfolioFixture(raw);
  f.settings.config.stage = "STANDARD";
  f.settings.config.level = "MEDIUM";
  const p = new PortfolioProgram(raw, f.settings),
    e = new PortfolioPaperEngine(p);
  try {
    e.command("start", { type: "start" });
    e.command("batch", f.ticks[0]!);
    const s = e.state();
    assert.equal(s.orders.length, 2);
    assert.ok(openRisk(s).lte(caps(s).risk));
    assert.ok(openRisk(s).lte(caps(s).group));
    assert.ok(notional(s).lte(caps(s).notional));
    checkPortfolioInvariants(s, p.initial(s.epoch));
    e.command("t1", laterTick(f.ticks[0]!, 1));
    e.command("t2", laterTick(f.ticks[0]!, 2));
    const after = e.state();
    checkPortfolioInvariants(after, p.initial(after.epoch));
    assert.equal(after.positions.length, 2);
    assert.ok(after.positions.every((x) => x.quantity === 1));
    assert.notEqual(after.positions[0]!.symbol, after.positions[1]!.symbol);
  } finally {
    e.close();
  }
});
for (const cancelled of [false, true])
  test(`PORTFOLIO-19 기업행동 최신 공개 정정 적용 cancelled=${cancelled}`, () => {
    const raw = replayFixture();
    raw.frames = raw.frames.slice(0, 1);
    const first = {
      eventId: "SPLIT-PLAN",
      revision: 1,
      announcedAt: base.at - 2000,
      availableAt: base.at - 2000,
      effectiveAt: base.at + 3000,
      kind: "SPLIT" as const,
      ratio: "2",
      cancelled: false,
    };
    raw.histories[0]!.actions.push(first);
    if (cancelled)
      raw.histories[0]!.actions.push({
        ...first,
        revision: 2,
        availableAt: base.at - 1000,
        cancelled: true,
      });
    const p = new PortfolioProgram(raw, fixture.settings),
      e = new PortfolioPaperEngine(p);
    try {
      e.command("start", { type: "start" });
      e.command("frame", base);
      assert.equal(e.state().orders.length, cancelled ? 1 : 0);
      assert.equal(
        e
          .state()
          .decisions[0]!.reasons.includes(
            "PORTFOLIO_ACTION_WINDOW_UNSUPPORTED",
          ),
        !cancelled,
      );
    } finally {
      e.close();
    }
  });
