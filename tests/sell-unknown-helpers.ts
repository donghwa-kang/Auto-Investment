import assert from "node:assert/strict";
import { portfolioFixture, laterTick } from "../src/core/portfolio-fixture.js";
import { PortfolioProgram } from "../src/core/portfolio-program.js";
import type { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import { checkPortfolioInvariants } from "../src/core/portfolio-invariants.js";
import { policy } from "../src/core/policy.js";
import { terminal, type Quote, type State } from "../src/core/types.js";
import { replayFixture } from "./signal-replay-helpers.js";

// 로컬 시험 전용: 실제 브로커 결과나 사용자 DB를 사용하지 않는다.
const raw = replayFixture();
export const sellFixture = portfolioFixture(raw);
export const sellBase = sellFixture.ticks[0]!;
export const sellProgram = new PortfolioProgram(raw, sellFixture.settings);
export type UnknownSellStatus = "UNKNOWN" | "CANCEL_UNKNOWN";

export function quietSellTick(at: number, changes: Partial<Quote> = {}) {
  const tick = laterTick(sellBase, (at - sellBase.at) / 1000);
  for (const row of tick.quotes)
    Object.assign(row.quote, { bidSize: 0, askSize: 0 }, changes);
  return tick;
}

export function sellOrder(s: State) {
  const order = s.orders.find((o) => o.side === "SELL");
  assert.ok(order, "SETUP_SELL_MISSING");
  return order;
}

export function prepareSell(
  engine: PortfolioPaperEngine,
  partial = false,
  pendingCancel = false,
) {
  engine.command("setup-start", { type: "start" });
  engine.command("setup-frame", sellBase);
  assert.equal(engine.state().orders.length, 1);
  engine.command("setup-accept", laterTick(sellBase, 0.1));
  engine.command("setup-buy-1", laterTick(sellBase, 0.2));
  engine.command("setup-buy-2", laterTick(sellBase, 0.3));
  assert.equal(engine.state().positions[0]!.quantity, 2);
  engine.command("setup-exit", { type: "liquidate", confirm: true });
  for (let i = 0; i < 125; i++) {
    const state = engine.state();
    if (terminal(state.orders[0]!)) break;
    engine.command(`setup-cancel-${i}`, quietSellTick(state.clock + 500));
  }
  assert.ok(terminal(engine.state().orders[0]!), "SETUP_BUY_NOT_TERMINAL");
  assert.equal(sellOrder(engine.state()).status, "INTENT_SAVED");
  engine.command(
    "setup-sell-accept",
    quietSellTick(engine.state().clock + 100),
  );
  assert.equal(sellOrder(engine.state()).status, "WORKING");
  if (partial) {
    engine.command(
      "setup-sell-partial",
      quietSellTick(engine.state().clock + 100, { bidSize: 1 }),
    );
    assert.equal(sellOrder(engine.state()).status, "PARTIAL");
    assert.equal(sellOrder(engine.state()).filled, 1);
    assert.equal(engine.state().positions[0]!.quantity, 1);
  }
  if (pendingCancel) {
    const reviewAt =
      sellOrder(engine.state()).lastProgressAt +
      policy.execution.emergency_exit.no_progress_review_seconds * 1000;
    while (engine.state().clock < reviewAt) {
      const at = Math.min(engine.state().clock + 1000, reviewAt);
      engine.command(`setup-review-${at}`, quietSellTick(at));
    }
    assert.equal(sellOrder(engine.state()).status, "CANCEL_PENDING");
    assert.ok(sellOrder(engine.state()).cancelFinalAt);
  }
  checkPortfolioInvariants(
    engine.state(),
    sellProgram.initial(engine.state().epoch),
  );
  return engine.state();
}

export function injectUnknownSell(
  engine: PortfolioPaperEngine,
  status: UnknownSellStatus,
) {
  engine.repo.transact("test-inject-unknown-sell", { status }, (s) => {
    assert.ok(s);
    const order = sellOrder(s);
    assert.ok(["WORKING", "PARTIAL", "CANCEL_PENDING"].includes(order.status));
    order.status = status;
    if (status === "CANCEL_UNKNOWN")
      s.positions[0]!.protection = "CANCEL_UNKNOWN";
    s.status = "RECONCILING";
    return s;
  });
  return engine.state();
}

export function assertUnknownSellPreserved(actual: State, before: State) {
  assert.deepEqual(actual.orders, before.orders, "UNRESOLVED_ORDER_CHANGED");
  assert.deepEqual(
    actual.positions.map(({ bid: _bid, ...p }) => p),
    before.positions.map(({ bid: _bid, ...p }) => p),
    "UNRESOLVED_EXPOSURE_CHANGED",
  );
  assert.deepEqual(actual.ledger.wallets, before.ledger.wallets);
  assert.equal(actual.positions[0]!.closedAt, undefined);
  assert.equal(actual.positions[0]!.netPnl, undefined);
  assert.equal(actual.status, "RECONCILING");
  checkPortfolioInvariants(actual, sellProgram.initial(actual.epoch));
}

export function advanceUnknownSell(
  engine: PortfolioPaperEngine,
  before: State,
  changes: Partial<Quote> = {},
) {
  const order = sellOrder(before);
  const reviewAt =
    order.lastProgressAt +
    policy.execution.emergency_exit.no_progress_review_seconds * 1000;
  const boundaries = [reviewAt - 1, reviewAt, reviewAt + 1];
  if (order.cancelFinalAt !== undefined)
    boundaries.push(
      order.cancelFinalAt - 1,
      order.cancelFinalAt,
      order.cancelFinalAt + 1,
    );
  const end = Math.max(before.clock, reviewAt, order.cancelFinalAt ?? 0) + 6000;
  boundaries.push(end);
  for (const boundary of [...new Set(boundaries)].sort((a, b) => a - b)) {
    while (engine.state().clock < boundary) {
      const at = Math.min(engine.state().clock + 1000, boundary);
      engine.command(`unresolved-${at}`, quietSellTick(at, changes));
      assertUnknownSellPreserved(engine.state(), before);
    }
  }
  assert.throws(
    () => engine.command("unresolved-reconcile", { type: "reconcile" }),
    /UNKNOWN_UNRESOLVED/,
  );
  assert.throws(
    () => engine.command("unresolved-start", { type: "start" }),
    /NOT_RECONCILED/,
  );
}
