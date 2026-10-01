import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BrokerControlLab,
  brokerLabData,
} from "../src/server/broker-control-lab.js";
import { controlConfig, evidenceFor } from "./broker-control-helpers.js";
import { sellProgram, sellOrder } from "./sell-unknown-helpers.js";
import type { State } from "../src/core/types.js";
for (const status of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  test(`D02 owned crash with scan flood/US stall/${status} preserves durable safety`, async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "broker-control-crash-")),
      "test.sqlite",
    );
    const child = spawn(
      process.execPath,
      ["scripts/broker-control-crash-fixture.mjs", path, status],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr!.on("data", (b) => {
      stderr += String(b);
    });
    const { state: before, dropped } = await new Promise<{
      state: State;
      dropped: number;
    }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("OWNED_CHILD_TIMEOUT"));
      }, 45000);
      child.once("message", (msg) => {
        clearTimeout(timer);
        resolve(msg as { state: State; dropped: number });
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error(stderr || "OWNED_CHILD_EARLY_EXIT"));
      });
    });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.ok(dropped > 0);
    const prior = brokerLabData(before).control;
    assert.equal(prior.records.filter((r) => r.sentAt !== null).length, 2);
    assert.equal(prior.records.filter((r) => !r.transportClosed).length, 2);
    assert.ok(prior.warnings.includes("TIMEOUT_RECONCILE_DO_NOT_RESUBMIT"));
    const lab = new BrokerControlLab(
      sellProgram.initial(0),
      controlConfig(),
      path,
      { resume: true, now: () => Date.now() + 20000 },
    );
    try {
      let after = lab.state();
      const control = brokerLabData(after).control;
      assert.deepEqual(after.orders, before.orders);
      assert.deepEqual(after.positions, before.positions);
      assert.deepEqual(after.ledger, before.ledger);
      assert.deepEqual(
        control.records.map((r) => r.sentAt),
        prior.records.map((r) => r.sentAt),
      );
      assert.equal(control.epoch, prior.epoch + 1);
      assert.equal(
        control.records.some((r) => r.status === "QUEUED"),
        false,
      );
      assert.equal(
        control.records.every((r) => r.transportClosed),
        true,
      );
      assert.equal(control.mode, "PAUSED");
      assert.equal(control.networkRequests, 0);
      assert.equal(control.liveEnabled, false);
      assert.throws(
        () =>
          lab.command("resume", {
            kind: "CONTROL",
            command: { kind: "RESUME", at: after.clock, epoch: control.epoch },
          }),
        /UNRESOLVED_CASE/,
      );
      const e = evidenceFor(lab, "post-crash", 2, "FILLED");
      after = lab.command("confirmed", { kind: "RECONCILE", evidence: e });
      assert.equal(sellOrder(after).filled, 2);
      assert.equal(after.positions[0]!.quantity, 0);
      assert.equal(after.orders.length, before.orders.length);
      assert.equal(after.status, "RECONCILING");
      assert.ok(lab.repo.verifyAudit() > 10);
    } finally {
      lab.close();
    }
  });
