import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { CostExecutionStore } from "../src/server/cost-execution-store.js";
import { replayCostExecutions } from "../src/core/cost-execution.js";
import type { CostExecutionView } from "../src/core/cost-execution.js";
import { executionConfig, executionEvents } from "./cost-execution-helpers.js";
const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "cost-execution-")), "owned-test.sqlite");

test("CSTORE-01 event journal, cost report and held learning evidence commit together", () => {
  const c = executionConfig(),
    e = executionEvents(),
    store = new CostExecutionStore(c);
  try {
    for (const event of e) store.append(event);
    assert.deepEqual(store.read(), replayCostExecutions(c, e));
  } finally {
    store.close();
  }
});
test("CSTORE-02 orderly reopen replays without double charging/reserving", () => {
  const path = fresh(),
    c = executionConfig(),
    e = executionEvents();
  let store = new CostExecutionStore(c, path);
  for (const event of e.slice(0, 5)) store.append(event);
  const before = store.read();
  store.close();
  store = new CostExecutionStore(c, path, { resume: true });
  try {
    assert.deepEqual(store.read(), before);
    assert.deepEqual(store.append(e[4]!), before);
    for (const event of e.slice(5)) store.append(event);
    assert.equal(store.read().report.tradingNetPnl, "170");
  } finally {
    store.close();
  }
});
test("CSTORE-03 write failure rolls back the event, cash, reservations and projections", () => {
  const store = new CostExecutionStore(executionConfig()),
    e = executionEvents();
  try {
    store.append(e[0]!);
    const before = store.read();
    store.failure = "WRITE_FAILURE";
    assert.throws(() => store.append(e[1]!), /WRITE_FAILURE/);
    assert.deepEqual(store.read(), before);
    store.failure = null;
    const after = store.append(e[1]!);
    assert.equal(after.cash, "98990");
    assert.equal(after.fills.length, 1);
    assert.deepEqual(store.append(e[1]!), after);
  } finally {
    store.close();
  }
});
test("CSTORE-04 conflicting/invalid event failure never leaves partial mutations", () => {
  const store = new CostExecutionStore(executionConfig()),
    e = executionEvents();
  try {
    store.append(e[0]!);
    const before = store.read();
    assert.throws(
      () => store.append({ ...e[0], limit: "999" }),
      /EXECUTION_EVENT_ID_CONFLICT/,
    );
    assert.deepEqual(store.read(), before);
    assert.throws(() => store.append({ ...e[1], quantity: 5 }), /OVERFILL/);
    assert.deepEqual(store.read(), before);
    assert.throws(
      () => store.append({ ...e[1], price: "abc" }),
      /INVALID_EXECUTION_EVENT/,
    );
    assert.deepEqual(store.read(), before);
  } finally {
    store.close();
  }
});
test("CSTORE-05 two local handles serialize against latest journal; stale sequence is rejected", () => {
  const path = fresh(),
    c = executionConfig(),
    e = executionEvents(),
    a = new CostExecutionStore(c, path),
    b = new CostExecutionStore(c, path, { resume: true });
  try {
    a.append(e[0]!);
    b.append(e[1]!);
    assert.equal(a.read().cash, "98990");
    assert.throws(
      () => a.append({ ...e[2], seq: 2 }),
      /EXECUTION_SEQUENCE_GAP/,
    );
    assert.equal(b.read().fills.length, 1);
    a.append(e[2]!);
    assert.equal(b.read().report.tradingFees, "10");
    assert.deepEqual(a.read(), b.read());
  } finally {
    a.close();
    b.close();
  }
});
test("CSTORE-06 existing non-lab files and missing resume targets are never adopted", () => {
  const path = fresh(),
    c = executionConfig();
  writeFileSync(path, "not a database", { flag: "wx" });
  const before = readFileSync(path);
  assert.throws(
    () => new CostExecutionStore(c, path),
    /COST_STORE_RESUME_REQUIRED/,
  );
  assert.throws(() => new CostExecutionStore(c, path, { resume: true }));
  assert.deepEqual(readFileSync(path), before);
  assert.throws(
    () => new CostExecutionStore(c, fresh(), { resume: true }),
    /COST_STORE_MISSING_FOR_RESUME/,
  );
});
test("CSTORE-07 a different schema database is rejected read-only", () => {
  const path = fresh(),
    db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE user_data (value TEXT); INSERT INTO user_data VALUES ('synthetic-preserve')",
  );
  db.close();
  const before = readFileSync(path);
  assert.throws(
    () => new CostExecutionStore(executionConfig(), path, { resume: true }),
    /COST_STORE_NOT_A_COST_DATABASE/,
  );
  assert.deepEqual(readFileSync(path), before);
});
test("CSTORE-08 changed cost configuration cannot resume a previous fee basis", () => {
  const path = fresh(),
    c = executionConfig(),
    store = new CostExecutionStore(c, path);
  store.append(executionEvents()[0]!);
  store.close();
  const before = readFileSync(path);
  c.profile.version++;
  assert.throws(
    () => new CostExecutionStore(c, path, { resume: true }),
    /COST_STORE_CONFIG_MISMATCH/,
  );
  assert.deepEqual(readFileSync(path), before);
});
test("CSTORE-09 stored report/checksum corruption does not become a learning value", () => {
  const path = fresh(),
    c = executionConfig(),
    store = new CostExecutionStore(c, path);
  store.close();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE cost_execution SET result_hash=? WHERE id=1").run(
    "0".repeat(64),
  );
  db.close();
  assert.throws(
    () => new CostExecutionStore(c, path, { resume: true }),
    /COST_STORE_CHECKSUM_MISMATCH/,
  );
});
for (const prefix of [3, 5])
  test(`CSTORE-10 owned child kill after ${prefix} events preserves committed cost basis`, async () => {
    const path = fresh(),
      child = spawn(
        process.execPath,
        ["scripts/cost-execution-crash-fixture.mjs", path, String(prefix)],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
    let stderr = "";
    child.stderr!.on("data", (b) => {
      stderr += String(b);
    });
    const before = await new Promise<CostExecutionView>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("OWNED_COST_CHILD_TIMEOUT"));
      }, 30000);
      child.once("message", (message) => {
        clearTimeout(timer);
        resolve(message as CostExecutionView);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error(stderr || "OWNED_COST_CHILD_EARLY_EXIT"));
      });
    });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const store = new CostExecutionStore(executionConfig(), path, {
      resume: true,
    });
    try {
      assert.deepEqual(store.read(), before);
      assert.equal(before.reservedCash, "2000");
      assert.equal(before.report.tradingFees, "10");
      assert.deepEqual(store.append(executionEvents()[prefix - 1]!), before);
      for (const event of executionEvents().slice(prefix)) store.append(event);
      assert.equal(store.read().report.tradingNetPnl, "170");
    } finally {
      store.close();
    }
  });
