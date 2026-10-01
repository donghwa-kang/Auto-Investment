import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executionStressSchema,
  stressProfiles,
  stressQuote,
  type ExecutionStress,
} from "../src/core/execution-stress.js";
import { PortfolioProgram } from "../src/core/portfolio-program.js";
import { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import { laterTick, portfolioFixture } from "../src/core/portfolio-fixture.js";
import { checkPortfolioInvariants } from "../src/core/portfolio-invariants.js";
import {
  cancelEntries,
  requestExit,
  simulatorStep,
} from "../src/core/simulator.js";
import { caps, equity } from "../src/core/ledger.js";
import { d } from "../src/core/math.js";
import { hash, policy } from "../src/core/policy.js";
import { notional, openRisk, profile } from "../src/core/risk.js";
import { makeSignalReplayFixture } from "../src/core/signal-replay-fixture.js";
import { terminal, type Quote, type State } from "../src/core/types.js";
import { replayFixture } from "./signal-replay-helpers.js";

const input = replayFixture();
const fixture = portfolioFixture(input);
const base = fixture.ticks[0]!;
const program = new PortfolioProgram(input, fixture.settings);
const control = stressProfiles().CONTROL;

function stress(overrides: Partial<ExecutionStress> = {}): ExecutionStress {
  return executionStressSchema.parse({ ...control, ...overrides });
}

function started(executionStress: ExecutionStress = control) {
  const engine = new PortfolioPaperEngine(program, ":memory:", {
    executionStress,
  });
  engine.command("start", { type: "start" });
  engine.command("frame", base);
  assert.equal(engine.state().orders.length, 1);
  return engine;
}

function workingState() {
  const engine = started();
  try {
    engine.command("accepted", laterTick(base, 0.1));
    const state = engine.state();
    assert.equal(state.orders[0]!.status, "WORKING");
    return state;
  } finally {
    engine.close();
  }
}

function simulate(
  state: State,
  seconds: number,
  timing: ExecutionStress,
  changes: Partial<Quote> = {},
) {
  const quote = {
    ...base.quotes[0]!.quote,
    ...changes,
    at: base.at + seconds * 1000,
  };
  state.clock = base.at + seconds * 1000;
  simulatorStep(state, quote, base.quotes[0]!.catalogKey, timing);
}

test("STRESS-01 프로필은 TEST_ONLY 정수 경계를 강제하고 미지 필드를 거부한다", () => {
  assert.deepEqual(control, {
    schemaVersion: "OFFLINE_EXECUTION_STRESS_V1",
    purpose: "TEST_ONLY",
    latencyMs: 0,
    cancelLatencyMs: 2000,
    adverseTicks: 0,
    liquidityBps: 10000,
  });
  for (const value of Object.values(stressProfiles()))
    assert.deepEqual(executionStressSchema.parse(value), value);
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...control, schemaVersion: "OFFLINE_EXECUTION_STRESS_V2" },
    { ...control, purpose: "LIVE" },
    { ...control, latencyMs: -1 },
    { ...control, latencyMs: 60001 },
    { ...control, latencyMs: 0.5 },
    { ...control, latencyMs: "500" },
    { ...control, cancelLatencyMs: -1 },
    { ...control, cancelLatencyMs: 60001 },
    { ...control, cancelLatencyMs: 0.5 },
    { ...control, adverseTicks: -1 },
    { ...control, adverseTicks: 101 },
    { ...control, adverseTicks: 0.5 },
    { ...control, liquidityBps: -1 },
    { ...control, liquidityBps: 10001 },
    { ...control, liquidityBps: 0.5 },
    { ...control, liquidityBps: Number.NaN },
    { ...control, ignored: true },
  ];
  for (const value of invalid)
    assert.equal(executionStressSchema.safeParse(value).success, false);
  assert.doesNotThrow(() =>
    stress({
      latencyMs: 60000,
      cancelLatencyMs: 0,
      adverseTicks: 100,
      liquidityBps: 0,
    }),
  );
});

for (const market of ["KR", "US"] as const)
  test(`STRESS-02 ${market} 호가 변환은 틱·정수 잔량만 바꾸고 입력과 시각을 보존한다`, () => {
    const quote: Quote = Object.freeze({
      bid: "100",
      ask: "101",
      bidSize: 7,
      askSize: 3,
      lastMinuteVolume: 999,
      at: base.at,
      halted: true,
    });
    const before = structuredClone(quote);
    const changed = stressQuote(
      quote,
      market,
      stress({ adverseTicks: 2, liquidityBps: 5000 }),
    );
    assert.deepEqual(quote, before);
    assert.equal(
      changed.bid,
      d(quote.bid).minus(d(profile.ticks[market]).mul(2)).toString(),
    );
    assert.equal(
      changed.ask,
      d(quote.ask).plus(d(profile.ticks[market]).mul(2)).toString(),
    );
    assert.equal(changed.bidSize, 3);
    assert.equal(changed.askSize, 1);
    assert.equal(changed.at, quote.at);
    assert.equal(changed.halted, true);
    assert.equal(changed.lastMinuteVolume, quote.lastMinuteVolume);
    assert.deepEqual(stressQuote(quote, market, control), quote);
    assert.equal(
      stressQuote(quote, market, stress({ liquidityBps: 0 })).askSize,
      0,
    );
    assert.equal(
      stressQuote(
        { ...quote, askSize: 1 },
        market,
        stress({ liquidityBps: 9999 }),
      ).askSize,
      0,
    );
    assert.throws(() =>
      stressQuote(
        { ...quote, bid: profile.ticks[market] },
        market,
        stress({ adverseTicks: 1 }),
      ),
    );
  });

test("STRESS-03 접수 다음 tick부터 최소 체결연령 500ms 경계에서만 체결한다", () => {
  const engine = started(stress({ latencyMs: 500 }));
  try {
    assert.equal(engine.state().orders[0]!.status, "INTENT_SAVED");
    engine.command("100ms", laterTick(base, 0.1));
    assert.equal(engine.state().orders[0]!.status, "WORKING");
    assert.equal(engine.state().orders[0]!.filled, 0);
    engine.command("499ms", laterTick(base, 0.499));
    assert.equal(engine.state().orders[0]!.filled, 0);
    engine.command("500ms", laterTick(base, 0.5));
    assert.equal(engine.state().orders[0]!.filled, 1);
    assert.equal(engine.state().positions[0]!.firstFillAt, base.at + 500);
  } finally {
    engine.close();
  }
});

test("STRESS-04 최소 체결연령이 지나도 INTENT 접수와 체결은 같은 tick에서 일어나지 않는다", () => {
  const engine = started(stress({ latencyMs: 500 }));
  try {
    engine.command("first-after-arrival", laterTick(base, 0.5));
    assert.equal(engine.state().orders[0]!.status, "WORKING");
    assert.equal(engine.state().orders[0]!.filled, 0);
    engine.command("later-evidence", laterTick(base, 0.501));
    assert.equal(engine.state().orders[0]!.filled, 1);
  } finally {
    engine.close();
  }
});

for (const invalid of ["future", "unavailable", "stale", "halted"] as const)
  test(`STRESS-05 ${invalid} 호가는 최소 체결연령 이후에도 체결 증거가 아니다`, () => {
    const engine = started(stress({ latencyMs: 500 }));
    try {
      engine.command("accepted", laterTick(base, 0.1));
      const tick = laterTick(base, 0.5);
      for (const row of tick.quotes) {
        if (invalid === "future") row.quote.at = tick.at + 1;
        if (invalid === "unavailable") row.availableAt = tick.at + 1;
        if (invalid === "stale") row.quote.at = tick.at - 60000;
        if (invalid === "halted") row.quote.halted = true;
      }
      engine.command("invalid-evidence", tick);
      assert.equal(engine.state().orders[0]!.filled, 0);
      assert.equal(engine.state().positions.length, 0);
    } finally {
      engine.close();
    }
  });

test("STRESS-06 악화된 매수/매도 호가를 지정가에 고정해 허위 체결하지 않는다", () => {
  const state = workingState();
  const buy = state.orders[0]!;
  const adverse = stress({ adverseTicks: 1 });
  const buyQuote = stressQuote(
    { ...base.quotes[0]!.quote, ask: buy.limit },
    "KR",
    adverse,
  );
  simulate(state, 0.2, adverse, buyQuote);
  assert.equal(buy.filled, 0);
  simulate(state, 0.3, control, { ask: buy.limit });
  assert.equal(buy.filled, 1);
  cancelEntries(state, stress({ cancelLatencyMs: 0 }));
  simulate(state, 0.4, control);
  const position = state.positions[0]!;
  requestExit(
    state,
    position,
    "USER",
    { ...base.quotes[0]!.quote, at: state.clock },
    adverse,
  );
  const sell = state.orders.at(-1)!;
  assert.equal(sell.side, "SELL");
  simulate(state, 0.5, adverse);
  assert.equal(sell.status, "WORKING");
  const sellQuote = stressQuote(
    { ...base.quotes[0]!.quote, bid: sell.limit },
    "KR",
    adverse,
  );
  simulate(state, 0.6, adverse, sellQuote);
  assert.equal(sell.filled, 0);
  assert.equal(position.quantity, 1);
});

test("STRESS-07 취소 확정은 최소 체결연령과 독립적으로 예약을 해제한다", () => {
  const engine = started(stress({ latencyMs: 500, cancelLatencyMs: 100 }));
  try {
    engine.command("accepted", laterTick(base, 0.1));
    engine.command("pause", { type: "pause" });
    const pending = engine.state().orders[0]!;
    assert.equal(pending.cancelFinalAt, base.at + 200);
    engine.command("before-cancel", laterTick(base, 0.199));
    assert.equal(engine.state().orders[0]!.status, "CANCEL_PENDING");
    engine.command("cancel-confirmed", laterTick(base, 0.2));
    const order = engine.state().orders[0]!;
    assert.equal(order.status, "CANCELLED");
    assert.equal(order.filled, 0);
    assert.equal(order.reservationCash, "0");
    assert.equal(order.reservationRisk, "0");
  } finally {
    engine.close();
  }
});

test("STRESS-08 취소 전 추가 체결은 허용하지만 정확한 확정 시각에는 금지한다", () => {
  const state = workingState();
  const timing = stress({ latencyMs: 150, cancelLatencyMs: 200 });
  cancelEntries(state, timing);
  const order = state.orders[0]!;
  const originalReservation = order.reservationCash;
  simulate(state, 0.299, timing);
  assert.equal(order.filled, 1);
  assert.equal(order.status, "CANCEL_PENDING");
  assert.ok(d(order.reservationCash).lt(originalReservation));
  simulate(state, 0.3, timing);
  assert.equal(order.filled, 1);
  assert.equal(order.status, "CANCELLED");
  assert.equal(order.reservationCash, "0");
  assert.equal(order.reservationRisk, "0");
});

test("STRESS-09 미접수 의도 즉시 취소·0ms 취소·미확정 상태 예약을 보존한다", () => {
  const engine = started(stress({ cancelLatencyMs: 60000 }));
  try {
    engine.command("pause", { type: "pause" });
    assert.equal(engine.state().orders[0]!.status, "CANCELLED");
    assert.equal(engine.state().orders[0]!.reservationCash, "0");
  } finally {
    engine.close();
  }
  const zero = workingState();
  cancelEntries(zero, stress({ cancelLatencyMs: 0 }));
  simulate(zero, 0.101, control);
  assert.equal(zero.orders[0]!.filled, 0);
  assert.equal(zero.orders[0]!.status, "CANCELLED");
  for (const status of ["UNKNOWN", "CANCEL_UNKNOWN"] as const) {
    const state = workingState();
    const order = state.orders[0]!;
    order.status = status;
    const before = structuredClone(order);
    cancelEntries(state, stress({ cancelLatencyMs: 0 }));
    simulate(state, 1, control);
    assert.deepEqual(order, before);
  }
});

test("STRESS-10 자동 미체결 취소와 부분체결 시나리오도 설정 취소 지연을 따른다", () => {
  const timing = stress({ latencyMs: 60000, cancelLatencyMs: 321 });
  const state = workingState();
  simulate(state, policy.execution.cancel_unfilled_entry_after_seconds, timing);
  assert.equal(state.orders[0]!.status, "CANCEL_PENDING");
  assert.equal(state.orders[0]!.cancelFinalAt, state.clock + 321);
  const partial = workingState();
  partial.config!.scenario = "PARTIAL_CANCEL";
  simulate(partial, 0.2, stress({ cancelLatencyMs: 123 }));
  assert.equal(partial.orders[0]!.filled, 1);
  assert.equal(partial.orders[0]!.status, "CANCEL_PENDING");
  assert.equal(partial.orders[0]!.cancelFinalAt, partial.clock + 123);
});

test("STRESS-11 실행 옵션은 복사·결합되고 원본 tick은 감사 기록에 보존된다", () => {
  const options = stress({ latencyMs: 500 });
  const saved = structuredClone(options);
  const engine = started(options);
  try {
    options.latencyMs = 0;
    options.liquidityBps = 0;
    engine.command("accepted", laterTick(base, 0.1));
    engine.command("before-arrival", laterTick(base, 0.499));
    assert.equal(engine.state().orders[0]!.filled, 0);
    const raw = laterTick(base, 0.5);
    const before = structuredClone(raw);
    engine.command("arrival", raw);
    assert.equal(engine.state().orders[0]!.filled, 1);
    assert.deepEqual(raw, before);
    assert.deepEqual(engine.state().manifest!.executionStress, saved);
    const event = engine.repo
      .events()
      .map(
        (row) =>
          JSON.parse(String(row.body)) as { command: string; input: unknown },
      )
      .find((row) => row.command === "arrival");
    assert.deepEqual(event?.input, raw);
    assert.ok(engine.repo.verifyAudit() > 0);
  } finally {
    engine.close();
  }
});

test("STRESS-12 잘못된 옵션과 학습 수집 혼용은 DB 생성 전에 거부한다", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "execution-stress-invalid-")),
    "paper.sqlite",
  );
  assert.throws(
    () =>
      new PortfolioPaperEngine(program, path, {
        executionStress: { ...control, latencyMs: -1 },
      }),
  );
  assert.equal(existsSync(path), false);
  assert.throws(
    () =>
      new PortfolioPaperEngine(program, path, {
        executionStress: control,
        captureLearning: true,
      }),
    /STRESS_LEARNING_UNSUPPORTED/,
  );
  assert.equal(existsSync(path), false);
});

test("STRESS-13 재시작 프로필 불일치와 기본값 생략은 기존 DB를 변경하지 않는다", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "execution-stress-resume-")),
    "paper.sqlite",
  );
  const timing = stress({ latencyMs: 500 });
  const first = new PortfolioPaperEngine(program, path, {
    executionStress: timing,
  });
  first.command("start", { type: "start" });
  first.command("frame", base);
  first.close();
  const before = readFileSync(path);
  for (const executionStress of [
    undefined,
    stress({ latencyMs: 501 }),
    stress({ cancelLatencyMs: 2001 }),
    stress({ liquidityBps: 9999 }),
    stress({ adverseTicks: 1 }),
  ]) {
    assert.throws(
      () =>
        new PortfolioPaperEngine(program, path, {
          resume: true,
          executionStress,
        }),
      /STRESS|MISMATCH/,
    );
    assert.deepEqual(readFileSync(path), before);
  }
  const resumed = new PortfolioPaperEngine(program, path, {
    resume: true,
    executionStress: timing,
  });
  try {
    assert.equal(resumed.state().status, "RECONCILING");
    assert.deepEqual(resumed.state().manifest!.executionStress, timing);
    assert.ok(resumed.repo.verifyAudit() > 0);
  } finally {
    resumed.close();
  }
  const legacyPath = join(
    mkdtempSync(join(tmpdir(), "execution-stress-legacy-")),
    "paper.sqlite",
  );
  const legacy = new PortfolioPaperEngine(program, legacyPath);
  legacy.close();
  const legacyBytes = readFileSync(legacyPath);
  assert.throws(
    () =>
      new PortfolioPaperEngine(program, legacyPath, {
        resume: true,
        executionStress: control,
      }),
    /STRESS|MISMATCH/,
  );
  assert.deepEqual(readFileSync(legacyPath), legacyBytes);
});

test("STRESS-14 명시적 CONTROL은 기본 엔진과 주문·체결·손익이 동일하다", () => {
  const legacy = new PortfolioPaperEngine(program);
  const explicit = new PortfolioPaperEngine(program, ":memory:", {
    executionStress: control,
  });
  try {
    for (const [index, command] of fixture.commands.entries()) {
      legacy.command(`same-${index}`, command);
      explicit.command(`same-${index}`, command);
    }
    const a = legacy.state();
    const b = explicit.state();
    assert.ok(a.positions.length > 0);
    assert.ok(
      a.positions.every(
        (position) => position.closedAt && position.netPnl !== undefined,
      ),
    );
    assert.ok(a.orders.every(terminal));
    // 실행 조건 결합만 의도적으로 추가된다. 경제적 결과 비교에서만 그 결합을 정규화한다.
    for (const order of b.orders) {
      if (order.side !== "BUY") continue;
      assert.equal(order.snapshot!.execution_stress_hash, hash(control));
      delete order.snapshot!.execution_stress_hash;
      order.snapshotHash = hash(order.snapshot);
      b.decisions.find(
        (decision) => decision.id === order.snapshot!.signal_id,
      )!.snapshotHash = order.snapshotHash;
    }
    assert.deepEqual(a.orders, b.orders);
    assert.deepEqual(a.positions, b.positions);
    assert.deepEqual(a.ledger, b.ledger);
    assert.deepEqual(a.decisions, b.decisions);
    assert.notEqual(hash(a.manifest), hash(b.manifest));
  } finally {
    legacy.close();
    explicit.close();
  }
});

for (const market of ["KR", "US"] as const)
  test(`STRESS-15 ${market} 소액 자금과 잔량 축소에서도 정수 수량·예약 한도를 유지한다`, () => {
    const raw =
      market === "KR" ? replayFixture() : makeSignalReplayFixture("US");
    raw.frames = raw.frames.slice(0, 1);
    if (market === "US")
      for (const history of raw.histories)
        for (const session of history.sessions.slice(0, -1)) {
          session.closeAt = session.openAt + 60 * 60000;
          session.rows = session.rows.filter((row) => row.offset < 60);
        }
    const sample = portfolioFixture(raw);
    sample.settings.config.capital = 100000;
    sample.settings.config.usdCapitalKrw = market === "US" ? 40000 : 0;
    const ownProgram = new PortfolioProgram(raw, sample.settings);
    const engine = new PortfolioPaperEngine(ownProgram, ":memory:", {
      executionStress: stress({ liquidityBps: 5000 }),
    });
    try {
      engine.command("start", { type: "start" });
      engine.command("frame", sample.ticks[0]!);
      for (let second = 1; second <= 3; second++)
        engine.command(`tick-${second}`, laterTick(sample.ticks[0]!, second));
      const state = engine.state();
      checkPortfolioInvariants(state, ownProgram.initial(state.epoch));
      assert.ok(openRisk(state).lte(caps(state).risk));
      assert.ok(openRisk(state).lte(caps(state).group));
      assert.ok(notional(state).lte(caps(state).notional));
      assert.ok(
        state.orders.every(
          (order) =>
            Number.isSafeInteger(order.quantity) &&
            Number.isSafeInteger(order.filled),
        ),
      );
      for (const currency of ["KRW", "USD"] as const) {
        const wallet = state.ledger.wallets[currency];
        const reserved = state.orders
          .filter((order) => order.currency === currency && !terminal(order))
          .reduce((sum, order) => sum.plus(order.reservationCash), d(0));
        assert.ok(
          reserved
            .plus(wallet.payable)
            .plus(wallet.unpaidFees)
            .lte(wallet.cash),
        );
      }
      assert.ok(state.decisions.length > 0);
      assert.equal(state.orders.length, 0);
      assert.ok(
        state.decisions.some((decision) =>
          decision.reasons.includes("NO_FEASIBLE_LOT"),
        ),
      );
    } finally {
      engine.close();
    }
  });

test("STRESS-16 악화 조건은 진입 심사·체결 가격·평가 bid와 원본 감사를 함께 유지한다", () => {
  const timing = stress({
    adverseTicks: 1,
    liquidityBps: 5000,
    latencyMs: 500,
  });
  const engine = started(timing);
  try {
    const before = structuredClone(base);
    assert.ok(
      engine
        .state()
        .decisions.every(
          (decision) =>
            !decision.reasons.includes("ENTRY_QUOTE_PREFLIGHT_MISMATCH"),
        ),
    );
    engine.command("accepted", laterTick(base, 0.1));
    engine.command("arrival", laterTick(base, 0.5));
    const state = engine.state();
    assert.equal(state.orders[0]!.filled, 1);
    assert.equal(
      state.orders[0]!.value,
      d(base.quotes[0]!.quote.ask).plus(profile.ticks.KR).toString(),
    );
    assert.equal(
      state.positions[0]!.bid,
      d(base.quotes[0]!.quote.bid).minus(profile.ticks.KR).toString(),
    );
    const event = engine.repo
      .events()
      .map(
        (row) =>
          JSON.parse(String(row.body)) as { command: string; input: unknown },
      )
      .find((row) => row.command === "frame");
    assert.deepEqual(event?.input, before);
    assert.deepEqual(base, before);
    checkPortfolioInvariants(state, program.initial(state.epoch));
  } finally {
    engine.close();
  }
});

test("STRESS-17 변환 실패와 저장 실패는 시각·예약·주문·감사 기록을 롤백한다", () => {
  const engine = started(stress({ adverseTicks: 1 }));
  try {
    const before = engine.state();
    const count = engine.repo.verifyAudit();
    const invalid = laterTick(base, 0.1);
    invalid.quotes[0]!.quote.bid = "1";
    assert.throws(
      () => engine.command("bad-bid", invalid),
      /STRESS_QUOTE_INVALID/,
    );
    assert.deepEqual(engine.state(), before);
    assert.equal(engine.repo.verifyAudit(), count);
    engine.repo.failure = "DISK_FULL";
    assert.throws(
      () => engine.command("write-failure", laterTick(base, 0.1)),
      /DISK_FULL/,
    );
    engine.repo.failure = null;
    assert.deepEqual(engine.state(), before);
    assert.equal(engine.repo.verifyAudit(), count);
    engine.command("write-failure", laterTick(base, 0.1));
    assert.equal(engine.state().orders[0]!.status, "WORKING");
  } finally {
    engine.repo.failure = null;
    engine.close();
  }
});

test("STRESS-18 청산 미진행 취소와 대체 주문에도 설정 지연이 이어진다", () => {
  const state = workingState();
  const timing = stress({ cancelLatencyMs: 321 });
  simulate(state, 0.2, timing);
  assert.equal(state.positions[0]!.quantity, 1);
  cancelEntries(state, stress({ cancelLatencyMs: 0 }));
  simulate(state, 0.3, timing);
  const position = state.positions[0]!;
  requestExit(
    state,
    position,
    "USER",
    { ...base.quotes[0]!.quote, at: state.clock },
    timing,
  );
  const sell = state.orders.at(-1)!;
  const belowLimit = d(sell.limit).minus(profile.ticks.KR).toString();
  simulate(state, 0.4, timing, { bid: belowLimit });
  assert.equal(sell.status, "WORKING");
  const reviewAt =
    0.3 + policy.execution.emergency_exit.no_progress_review_seconds;
  simulate(state, reviewAt, timing, { bid: belowLimit });
  assert.equal(sell.status, "CANCEL_PENDING");
  assert.equal(sell.cancelFinalAt, state.clock + 321);
  simulate(state, reviewAt + 0.321, timing, { bid: belowLimit });
  assert.equal(sell.status, "CANCELLED");
  assert.equal(sell.filled, 0);
  assert.equal(position.quantity, 1);
  assert.equal(position.replacements, 1);
  assert.equal(state.orders.at(-1)!.replaces, sell.id);
  assert.equal(state.orders.at(-1)!.status, "INTENT_SAVED");
});

test("STRESS-19 원본 진입 호가 위조와 0 잔량은 스트레스 적용 후에도 진입을 막는다", () => {
  for (const kind of ["forged", "zero-liquidity"] as const) {
    const timing = stress({
      adverseTicks: 1,
      liquidityBps: kind === "forged" ? 10000 : 0,
    });
    const engine = new PortfolioPaperEngine(program, ":memory:", {
      executionStress: timing,
    });
    try {
      const frame = structuredClone(base);
      if (kind === "forged")
        frame.quotes[0]!.quote.ask = d(frame.quotes[0]!.quote.ask)
          .plus(1)
          .toString();
      engine.command("start", { type: "start" });
      engine.command("frame", frame);
      const state = engine.state();
      assert.equal(state.orders.length, 0);
      assert.ok(
        state.decisions.every((decision) => decision.result === "ABSTAIN"),
      );
      assert.ok(
        state.decisions.some((decision) =>
          decision.reasons.includes(
            kind === "forged"
              ? "ENTRY_QUOTE_PREFLIGHT_MISMATCH"
              : "NO_FEASIBLE_LOT",
          ),
        ),
      );
    } finally {
      engine.close();
    }
  }
});

test("STRESS-20 체결 후 정지·가격 갭은 미체결 청산과 잔여 노출로 남는다", () => {
  const timing = stress({
    adverseTicks: 1,
    latencyMs: 500,
    cancelLatencyMs: 0,
  });
  const engine = started(timing);
  try {
    engine.command("accepted", laterTick(base, 0.1));
    engine.command("filled", laterTick(base, 0.5));
    assert.equal(engine.state().positions[0]!.quantity, 1);
    engine.command("exit", { type: "liquidate", confirm: true });
    engine.command("entry-cancelled-exit-intent", laterTick(base, 0.6));
    engine.command("exit-accepted", laterTick(base, 0.7));
    assert.equal(engine.state().orders.at(-1)!.side, "SELL");
    assert.equal(engine.state().orders.at(-1)!.status, "WORKING");
    const halted = laterTick(base, 0.8);
    halted.quotes[0]!.quote.halted = true;
    engine.command("halted", halted);
    assert.equal(engine.state().orders.at(-1)!.filled, 0);
    assert.equal(engine.state().positions[0]!.quantity, 1);
    const reviewSeconds =
      policy.execution.emergency_exit.no_progress_review_seconds;
    for (let seconds = 1; seconds <= reviewSeconds + 2; seconds++) {
      const gap = laterTick(base, seconds);
      gap.quotes[0]!.quote.bid = d(base.quotes[0]!.quote.bid)
        .mul("0.9")
        .toString();
      engine.command(`gap-${seconds}`, gap);
    }
    const state = engine.state();
    assert.equal(state.positions[0]!.quantity, 1);
    assert.equal(state.positions[0]!.protection, "EXIT_BLOCKED");
    assert.equal(state.positions[0]!.closedAt, undefined);
    assert.equal(state.positions[0]!.netPnl, undefined);
    assert.equal(state.orders.at(-1)!.filled, 0);
    assert.equal(terminal(state.orders.at(-1)!), false);
    checkPortfolioInvariants(state, program.initial(state.epoch));
  } finally {
    engine.close();
  }
});

test("STRESS-21 USD 실제 매수·청산의 악화 호가와 수수료는 환산 손익에 한 번 반영된다", () => {
  const raw = makeSignalReplayFixture("US");
  raw.frames = raw.frames.slice(0, 1);
  for (const history of raw.histories)
    for (const session of history.sessions.slice(0, -1)) {
      session.closeAt = session.openAt + 60 * 60000;
      session.rows = session.rows.filter((row) => row.offset < 60);
    }
  const sample = portfolioFixture(raw);
  // 합성 USD 양방향 체결 경로를 확인하는 명시적 시험 설정이며 CLI 기본값은 바꾸지 않는다.
  sample.settings.config.capital = 5000000;
  sample.settings.config.usdCapitalKrw = 2000000;
  sample.settings.config.level = "HIGH";
  sample.settings.config.stage = "STANDARD";
  const ownProgram = new PortfolioProgram(raw, sample.settings);
  const timing = stress({ adverseTicks: 1, latencyMs: 500 });
  const engine = new PortfolioPaperEngine(ownProgram, ":memory:", {
    executionStress: timing,
  });
  try {
    const initial = engine.state();
    for (const [index, command] of sample.commands.entries()) {
      engine.command(`usd-${index}`, command);
      const state = engine.state();
      checkPortfolioInvariants(state, ownProgram.initial(state.epoch));
    }
    const state = engine.state();
    const buys = state.orders.filter((order) => order.side === "BUY");
    const sells = state.orders.filter((order) => order.side === "SELL");
    const buyQuantity = buys.reduce((total, order) => total + order.filled, 0);
    const sellQuantity = sells.reduce(
      (total, order) => total + order.filled,
      0,
    );
    assert.ok(buyQuantity > 0);
    assert.equal(sellQuantity, buyQuantity);
    assert.ok(
      state.orders.every(
        (order) => order.currency === "USD" && terminal(order),
      ),
    );
    assert.ok(state.positions.length > 0);
    assert.ok(
      state.positions.every(
        (position) =>
          position.market === "US" &&
          position.quantity === 0 &&
          position.closedAt,
      ),
    );
    for (const order of buys)
      assert.equal(order.snapshot!.execution_stress_hash, hash(timing));
    assert.deepEqual(state.manifest!.executionStress, timing);
    const buyValue = buys.reduce(
      (total, order) => total.plus(order.value),
      d(0),
    );
    const sellValue = sells.reduce(
      (total, order) => total.plus(order.value),
      d(0),
    );
    const entryFees = state.positions.reduce(
      (total, position) => total.plus(position.entryFees),
      d(0),
    );
    const exitFees = state.positions.reduce(
      (total, position) => total.plus(position.exitFees),
      d(0),
    );
    assert.ok(entryFees.gt(0) && exitFees.gt(0));
    assert.equal(
      entryFees.toString(),
      buyValue.mul(profile.fees.entryBps).div(10000).toString(),
    );
    assert.equal(
      exitFees.toString(),
      sellValue.mul(profile.fees.exitBps).div(10000).toString(),
    );
    const quote = sample.ticks[0]!.quotes[0]!.quote;
    const expectedGrossUsd = d(quote.bid)
      .minus(quote.ask)
      .minus(d(profile.ticks.US).mul(2))
      .mul(buyQuantity);
    const grossUsd = sellValue.minus(buyValue);
    assert.equal(grossUsd.toString(), expectedGrossUsd.toString());
    const feesUsd = entryFees.plus(exitFees);
    const expectedNetKrw = grossUsd.minus(feesUsd).mul(state.ledger.fx);
    const closedNetKrw = state.positions.reduce(
      (total, position) => total.plus(position.netPnl!),
      d(0),
    );
    const equityChangeKrw = equity(state).minus(equity(initial));
    assert.equal(closedNetKrw.toString(), expectedNetKrw.toString());
    assert.equal(equityChangeKrw.toString(), expectedNetKrw.toString());
    assert.equal(
      grossUsd.mul(state.ledger.fx).minus(equityChangeKrw).toString(),
      feesUsd.mul(state.ledger.fx).toString(),
    );
    assert.equal(
      state.ledger.wallets.KRW.cash,
      initial.ledger.wallets.KRW.cash,
    );
    assert.equal(state.ledger.wallets.USD.payable, "0");
    assert.equal(state.ledger.wallets.USD.receivable, "0");
    assert.equal(state.ledger.costs.length, 0);
    assert.ok(engine.repo.verifyAudit() > sample.commands.length);
  } finally {
    engine.close();
  }
});
