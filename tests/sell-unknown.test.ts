import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import { stressProfiles } from "../src/core/execution-stress.js";
import {
  applyOrderEvent,
  simulatorStep,
  type FillEvent,
} from "../src/core/simulator.js";
import { checkPortfolioInvariants } from "../src/core/portfolio-invariants.js";
import { d } from "../src/core/math.js";
import { openRisk, notional, profile } from "../src/core/risk.js";
import {
  advanceUnknownSell,
  assertUnknownSellPreserved,
  injectUnknownSell,
  prepareSell,
  quietSellTick,
  sellFixture,
  sellOrder,
  sellProgram,
} from "./sell-unknown-helpers.js";

const variants = [
  { name: "default", executionStress: undefined },
  {
    name: "zero-cancel",
    executionStress: { ...stressProfiles().CONTROL, cancelLatencyMs: 0 },
  },
  {
    name: "321ms-cancel",
    executionStress: { ...stressProfiles().CONTROL, cancelLatencyMs: 321 },
  },
];

for (const status of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  for (const partial of [false, true])
    for (const variant of variants)
      test(`SELL-UNKNOWN-01 ${status} partial=${partial} ${variant.name} 시간·호가로 확정/대체하지 않는다`, () => {
        const engine = new PortfolioPaperEngine(
          sellProgram,
          ":memory:",
          variant,
        );
        try {
          prepareSell(engine, partial);
          const before = injectUnknownSell(engine, status);
          advanceUnknownSell(engine, before, { bidSize: 100 });
          assert.equal(
            openRisk(engine.state()).toString(),
            openRisk(before).toString(),
          );
          assert.equal(
            notional(engine.state()).toString(),
            notional(before).toString(),
          );
          assert.ok(engine.repo.verifyAudit() > 10);
        } finally {
          engine.close();
        }
      });

for (const variant of variants)
  test(`SELL-UNKNOWN-02 ${variant.name} 이미 기록된 취소 확정 예정 시각은 증거가 아니다`, () => {
    const engine = new PortfolioPaperEngine(sellProgram, ":memory:", variant);
    try {
      prepareSell(engine, true, true);
      const before = injectUnknownSell(engine, "CANCEL_UNKNOWN");
      assert.ok(sellOrder(before).cancelAt);
      advanceUnknownSell(engine, before, { bidSize: 100 });
    } finally {
      engine.close();
    }
  });

for (const status of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  test(`SELL-UNKNOWN-03 ${status} 새 SQLite 재개 후에도 미확정 노출을 보존한다`, () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "sell-unknown-restart-")),
      "paper.sqlite",
    );
    let engine = new PortfolioPaperEngine(sellProgram, path);
    try {
      prepareSell(engine, true, true);
      const before = injectUnknownSell(engine, status);
      engine.close();
      engine = new PortfolioPaperEngine(sellProgram, path, { resume: true });
      assert.ok(engine.state().epoch > before.epoch);
      assertUnknownSellPreserved(engine.state(), before);
      advanceUnknownSell(engine, before);
      assert.ok(engine.repo.verifyAudit() > 10);
    } finally {
      engine.close();
    }
  });

function evidence(engine: PortfolioPaperEngine, id: string, event: FillEvent) {
  engine.repo.transact(id, event, (state) => {
    assert.ok(state);
    applyOrderEvent(state, sellOrder(state), event);
    checkPortfolioInvariants(state, sellProgram.initial(state.epoch));
    return state;
  });
}

for (const status of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  test(`SELL-UNKNOWN-04 ${status} 명시적 지연 전량 체결은 한 번만 반영하고 재매도하지 않는다`, () => {
    const engine = new PortfolioPaperEngine(sellProgram);
    try {
      prepareSell(engine, true);
      const before = injectUnknownSell(engine, status);
      advanceUnknownSell(engine, before);
      const sell = sellOrder(before);
      const final: FillEvent = {
        id: "test-confirmed-fill",
        version: sell.version + 1,
        cumulativeFilled: sell.quantity,
        cumulativeValue: d(sell.value)
          .plus(d(sell.limit).mul(sell.quantity - sell.filled))
          .toString(),
        status: "FILLED",
      };
      evidence(engine, "test-fill", final);
      const applied = engine.state();
      evidence(engine, "test-duplicate", final);
      evidence(engine, "test-older-partial", {
        id: "test-old",
        version: sell.version,
        cumulativeFilled: sell.filled,
        cumulativeValue: sell.value,
        status: "PARTIAL",
      });
      assert.deepEqual(engine.state().orders, applied.orders);
      assert.deepEqual(engine.state().positions, applied.positions);
      assert.deepEqual(engine.state().ledger, applied.ledger);
      engine.command("after-fill", quietSellTick(applied.clock + 1));
      assert.equal(sellOrder(engine.state()).status, "FILLED");
      assert.equal(engine.state().positions[0]!.quantity, 0);
      assert.equal(
        engine.state().orders.filter((o) => o.side === "SELL").length,
        1,
      );
      assert.ok(engine.state().positions[0]!.closedAt);
      engine.command("test-reconcile", { type: "reconcile" });
      engine.command("test-start", { type: "start" });
      assert.equal(engine.state().status, "RUNNING");
    } finally {
      engine.close();
    }
  });

for (const status of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  test(`SELL-UNKNOWN-05 ${status} 지연 부분 체결·취소 확정 후 잔여 수량만 한 번 대체한다`, () => {
    const engine = new PortfolioPaperEngine(sellProgram);
    try {
      prepareSell(engine);
      const before = injectUnknownSell(engine, status);
      advanceUnknownSell(engine, before);
      const sell = sellOrder(before);
      const partial: FillEvent = {
        id: "test-late-partial",
        version: 1,
        cumulativeFilled: 1,
        cumulativeValue: sell.limit,
        status,
      };
      evidence(engine, "late-partial", partial);
      const applied = engine.state();
      assert.equal(applied.positions[0]!.quantity, 1);
      assert.equal(sellOrder(applied).status, status);
      // 체결 증거의 증가분만 반영하고 남은 주문 상태는 미확정으로 둔다.
      const net = d(sell.limit).minus(
        d(sell.limit).mul(profile.fees.exitBps).div(10000),
      );
      assert.equal(applied.ledger.wallets.KRW.receivable, net.toString());
      assert.equal(applied.ledger.wallets.KRW.payable, "0");
      const settled = structuredClone(applied);
      settled.ledger.wallets.KRW.cash = d(before.ledger.wallets.KRW.cash)
        .plus(net)
        .toString();
      settled.ledger.wallets.KRW.receivable = "0";
      // 다음 tick의 기존 TEST_ONLY 결제는 허용하되 주문/잔여 노출은 그대로다.
      engine.command("after-partial", quietSellTick(applied.clock + 1));
      assertUnknownSellPreserved(engine.state(), settled);
      evidence(engine, "repeat-partial", partial);
      const cancel: FillEvent = {
        ...partial,
        id: "test-confirmed-cancel",
        version: 2,
        status: "CANCELLED",
      };
      evidence(engine, "confirmed-cancel", cancel);
      const cancelled = engine.state();
      assert.equal(cancelled.positions[0]!.quantity, 1);
      assert.equal(cancelled.orders.length, before.orders.length);
      engine.command("replace-confirmed", quietSellTick(cancelled.clock + 1));
      const replaced = engine.state();
      const replacement = replaced.orders.at(-1)!;
      assert.equal(replacement.side, "SELL");
      assert.equal(replacement.quantity, 1);
      assert.equal(replacement.replaces, sell.id);
      assert.equal(replacement.status, "INTENT_SAVED");
      assert.equal(replaced.positions[0]!.replacements, 1);
      evidence(engine, "repeat-cancel", cancel);
      evidence(engine, "older-partial", { ...partial, id: "test-old-partial" });
      assert.deepEqual(engine.state().orders, replaced.orders);
      assert.deepEqual(engine.state().ledger, replaced.ledger);
      engine.command("replace-accept", quietSellTick(replaced.clock + 1));
      assert.equal(engine.state().orders.at(-1)!.status, "WORKING");
      assert.equal(
        engine.state().orders.filter((o) => o.side === "SELL").length,
        2,
      );
    } finally {
      engine.close();
    }
  });

for (const status of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  for (const kind of ["gap", "halted", "replacement-limit"] as const)
    test(`SELL-UNKNOWN-06 ${status} ${kind} 시가평가/한도 처리도 미확정을 정상 상태로 덮지 않는다`, () => {
      const engine = new PortfolioPaperEngine(sellProgram);
      try {
        prepareSell(engine, true);
        const state = injectUnknownSell(engine, status);
        if (kind === "replacement-limit") state.positions[0]!.replacements = 2;
        const before = structuredClone(state);
        const quote = quietSellTick(state.clock + 10000).quotes[0]!.quote;
        if (kind === "gap")
          quote.bid = d(sellOrder(state).limit).mul("0.9").toString();
        if (kind === "halted") quote.halted = true;
        state.clock = quote.at;
        simulatorStep(state, quote, state.positions[0]!.symbol);
        assertUnknownSellPreserved(state, before);
        assert.equal(state.positions[0]!.bid, quote.bid);
      } finally {
        engine.close();
      }
    });

for (const status of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  test(`SELL-UNKNOWN-07 ${status} 오래된 버전의 새 체결량은 정상 복귀 대신 충돌 보류한다`, () => {
    const engine = new PortfolioPaperEngine(sellProgram);
    try {
      prepareSell(engine, true);
      const before = injectUnknownSell(engine, status);
      const order = sellOrder(before);
      evidence(engine, "old-conflicting-fill", {
        id: "test-conflict",
        version: order.version,
        cumulativeFilled: order.quantity,
        cumulativeValue: d(order.limit).mul(order.quantity).toString(),
        status: "FILLED",
      });
      assert.deepEqual(engine.state().orders, before.orders);
      assert.deepEqual(engine.state().positions, before.positions);
      assert.deepEqual(engine.state().ledger.wallets, before.ledger.wallets);
      assert.ok(engine.state().ledger.halts.includes("OUT_OF_ORDER_CONFLICT"));
      assert.throws(
        () => engine.command("blocked-start", { type: "start" }),
        /NOT_RECONCILED/,
      );
      assert.throws(
        () => engine.command("blocked-reconcile", { type: "reconcile" }),
        /UNKNOWN_UNRESOLVED/,
      );
    } finally {
      engine.close();
    }
  });

test("SELL-UNKNOWN-08 미확정 동안 주문/노출을 보존하면서 평가 bid는 갱신한다", () => {
  const engine = new PortfolioPaperEngine(sellProgram);
  try {
    prepareSell(engine, true);
    const before = injectUnknownSell(engine, "UNKNOWN");
    const bid = d(before.positions[0]!.bid).minus(profile.ticks.KR).toString();
    const tick = quietSellTick(before.clock + 1);
    tick.quotes.find(
      (row) => row.catalogKey === before.positions[0]!.symbol,
    )!.quote.bid = bid;
    engine.command("mark-only", tick);
    assertUnknownSellPreserved(engine.state(), before);
    assert.equal(engine.state().positions[0]!.bid, bid);
    assert.notEqual(
      notional(engine.state()).toString(),
      notional(before).toString(),
    );
  } finally {
    engine.close();
  }
});

for (const status of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  test(`SELL-UNKNOWN-09 ${status} 정상 상태에서 승인되는 다음 프레임도 신규 진입을 차단한다`, () => {
    const candidate = sellFixture.ticks[1]!;
    const control = new PortfolioPaperEngine(sellProgram);
    const engine = new PortfolioPaperEngine(sellProgram);
    try {
      control.command("control-start", { type: "start" });
      control.command("control-candidate", candidate);
      const approved = control
        .state()
        .decisions.filter((d) => d.result === "APPROVED");
      assert.equal(approved.length, 1, "SETUP_CANDIDATE_NOT_APPROVED");
      prepareSell(engine, true);
      const before = injectUnknownSell(engine, status);
      // 노출 중 시간 건너뛰기 금지 계약도 지키며 다음 15분봉까지 진행한다.
      while (engine.state().clock < candidate.at - 1000) {
        const at = Math.min(engine.state().clock + 1000, candidate.at - 1000);
        engine.command(`wait-candidate-${at}`, quietSellTick(at));
        assertUnknownSellPreserved(engine.state(), before);
      }
      const decisionCount = engine.state().decisions.length;
      engine.command("unknown-candidate", candidate);
      const after = engine.state();
      const decisions = after.decisions.slice(decisionCount);
      assert.ok(decisions.length > 0, "CANDIDATE_NOT_EVALUATED");
      const blocked = decisions.find((d) => d.id === approved[0]!.id);
      assert.ok(blocked, "CONTROL_CANDIDATE_NOT_EVALUATED");
      assert.equal(blocked.result, "ABSTAIN");
      assert.ok(blocked.reasons.includes("ENTRY_NOT_RUNNING"));
      assert.ok(decisions.every((d) => d.result === "ABSTAIN"));
      assertUnknownSellPreserved(after, before);
    } finally {
      control.close();
      engine.close();
    }
  });
