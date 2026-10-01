import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  PortfolioWebRun,
  type PortfolioWebView,
} from "../src/server/portfolio-web-run.js";
import type { State } from "../src/core/types.js";
import { webDirectory, webSetup } from "./portfolio-web-helpers.js";

test("WEB-CRASH-01 부분 체결 뒤 소유 worker 강제 종료→lease 만료→저장 위치/장부 복구", async () => {
  const { directory } = webDirectory();
  const worker = new Worker(
    new URL("../src/server/portfolio-web-worker.js", import.meta.url),
    {
      workerData: {
        directory,
        setup: webSetup,
        create: false,
        intervalMs: 200,
      },
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("WORKER_TEST_TIMEOUT")),
        60000,
      );
      worker.on("error", reject);
      worker.on("message", (m: { type: string; view?: PortfolioWebView }) => {
        if (m.type === "fatal") {
          clearTimeout(timer);
          reject(new Error("WORKER_TEST_FATAL"));
        }
        if (m.type === "ready")
          worker.postMessage({
            type: "control",
            id: randomUUID(),
            commandId: randomUUID(),
            action: { type: "start" },
          });
        if (m.view?.exposureCount) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } finally {
    await worker.terminate();
  }
  const db = new DatabaseSync(resolve(directory, "paper.sqlite"), {
    readOnly: true,
  });
  const before = JSON.parse(
    (
      db.prepare("SELECT body FROM aggregate WHERE id=1").get() as {
        body: string;
      }
    ).body,
  ) as State;
  db.close();
  assert.ok(before.positions.some((p) => p.quantity > 0));
  // 실제 writer lease를 우회/수정하지 않는다. 소유 프로세스 종료 후 만료를 기다린다.
  await new Promise((r) => setTimeout(r, 10200));
  const run = new PortfolioWebRun(directory);
  try {
    const after = run.engine.state();
    assert.deepEqual(after.ledger.wallets, before.ledger.wallets);
    assert.deepEqual(after.positions, before.positions);
    assert.equal(after.cursor, before.cursor);
    assert.equal(run.view().playing, false);
    assert.equal(run.view().recoveryRequired, true);
    assert.ok(after.epoch > before.epoch);
    assert.deepEqual(
      after.orders.map((o) => [o.id, o.filled]),
      before.orders.map((o) => [o.id, o.filled]),
    );
    assert.throws(
      () => run.control(randomUUID(), { type: "start" }),
      /RECONCILIATION_REQUIRED/,
    );
    assert.ok(run.engine.repo.verifyAudit() > 0);
  } finally {
    run.close();
  }
});
