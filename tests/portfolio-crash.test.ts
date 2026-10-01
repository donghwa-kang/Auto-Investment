import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortfolioProgram } from "../src/core/portfolio-program.js";
import { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { replayFixture } from "./signal-replay-helpers.js";
import type { State } from "../src/core/types.js";
import {
  assertUnknownSellPreserved,
  advanceUnknownSell,
} from "./sell-unknown-helpers.js";
const input = replayFixture(),
  f = portfolioFixture(input),
  program = new PortfolioProgram(input, f.settings);
for (const phase of [
  "INTENT",
  "ACCEPTED",
  "PARTIAL",
  "SELL_UNKNOWN",
  "SELL_CANCEL_UNKNOWN",
])
  test(`PORTFOLIO-CRASH ${phase} 소유 시험 프로세스 강제 종료/SQLite 복구`, async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "portfolio-crash-")),
      "paper.sqlite",
    );
    const child = spawn(
      process.execPath,
      ["scripts/portfolio-crash-fixture.mjs", path, phase],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    let error = "";
    child.stderr!.on("data", (b) => {
      error += String(b);
    });
    const before = await new Promise<State>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("OWNED_CHILD_TIMEOUT"));
      }, 45000);
      child.once("message", (v) => {
        clearTimeout(timer);
        resolve((v as { state: State }).state);
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error(error || "OWNED_CHILD_EARLY_EXIT"));
      });
    });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const restored = new PortfolioPaperEngine(program, path, {
      resume: true,
      now: () => Date.now() + 20000,
    });
    try {
      const s = restored.state();
      assert.equal(s.status, "RECONCILING");
      assert.equal(s.orders.length, before.orders.length);
      assert.equal(s.orders[0]!.filled, before.orders[0]!.filled);
      assert.deepEqual(s.ledger, before.ledger);
      assert.equal(
        s.orders[0]!.reservationCash,
        phase === "INTENT" ? "0" : before.orders[0]!.reservationCash,
      );
      assert.equal(s.positions[0]?.quantity, before.positions[0]?.quantity);
      assert.throws(
        () => restored.command("again", { type: "start" }),
        /NOT_RECONCILED/,
      );
      assert.ok(restored.repo.verifyAudit() > 2);
      if (phase.startsWith("SELL_")) {
        assert.ok(s.epoch > before.epoch);
        assertUnknownSellPreserved(s, before);
        advanceUnknownSell(restored, before);
      }
    } finally {
      restored.close();
    }
  });
