import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CostWebRun } from "../src/server/cost-web-run.js";
import { CostWebService } from "../src/server/cost-web-service.js";
import { makeCostWebProgram } from "../src/server/cost-web-fixture.js";
import {
  costWebRequestSchema,
  type CostWebControl,
} from "../src/core/cost-web-schema.js";
import { hash } from "../src/core/policy.js";
import { Engine } from "../src/server/engine.js";
import { createApp } from "../src/server/http.js";
const program = makeCostWebProgram();
const directory = () => mkdtempSync(resolve(tmpdir(), "cost-web-test-"));
const runId = randomUUID();
function control(
  run: CostWebRun,
  action: CostWebControl["action"],
): CostWebControl {
  return {
    type: "control",
    runId,
    id: randomUUID(),
    expectedControl: run.view().controlRevision,
    action,
  };
}

test("CW-08 final control slot is reserved for STOP; limits never strand a running timer", () => {
  const run = new CostWebRun(directory(), program, true);
  try {
    const before = hash(run.store.read());
    for (let i = 0; i < 99; i++) run.control(control(run, "STOP"));
    assert.equal(run.view().controlRevision, 99);
    assert.throws(() => run.control(control(run, "START")), /CONTROL_LIMIT/);
    run.control(control(run, "STOP"));
    assert.equal(run.view().controlRevision, 100);
    assert.equal(run.view().runtime.phase, "STOPPED");
    assert.equal(run.view().runtime.timerPending, false);
    assert.equal(hash(run.store.read()), before);
  } finally {
    run.close();
  }
});
test("CW-01 strict HTTP contract rejects custom amounts/quotes/paths and live fields", () => {
  const create = {
    type: "create",
    id: randomUUID(),
    acknowledgeSynthetic: true,
  };
  assert.equal(costWebRequestSchema.safeParse(create).success, true);
  for (const extra of [
    { capital: 1 },
    { live: true },
    { path: "../db" },
    { quote: {} },
  ])
    assert.equal(
      costWebRequestSchema.safeParse({ ...create, ...extra }).success,
      false,
    );
  assert.equal(
    costWebRequestSchema.safeParse({ ...create, id: "../x" }).success,
    false,
  );
  assert.equal(
    costWebRequestSchema.safeParse({ ...create, acknowledgeSynthetic: false })
      .success,
    false,
  );
});
test("CW-02 actual signal fixture; start/stop/retry/CAS never duplicate intent or finance", () => {
  let now = 0;
  const run = new CostWebRun(directory(), program, true, undefined, () => now);
  try {
    assert.equal(run.view().runtime.phase, "IDLE");
    assert.equal(
      run.view().report.financialEvidence.accounts[0]!.cash,
      "5000000",
    );
    const start = control(run, "START");
    run.control(start);
    now = 1000;
    run.step();
    assert.equal(run.view().report.financialEvidence.trades[0]!.quantity, 1);
    const stop = control(run, "STOP");
    run.control(stop);
    const before = hash(run.store.read());
    now = 6000;
    run.step();
    run.control(start);
    assert.equal(run.view().runtime.phase, "STOPPED");
    assert.equal(hash(run.store.read()), before);
    assert.throws(
      () => run.control({ ...start, action: "STOP" }),
      /COMMAND_ID_CONFLICT/,
    );
    assert.throws(
      () => run.control({ ...start, id: randomUUID() }),
      /CONTROL_STALE/,
    );
    run.control(control(run, "START"));
    assert.ok(run.view().loop.holds.includes("WATCHDOG_INPUT_STALE"));
    assert.equal(run.view().report.financialEvidence.trades[0]!.quantity, 1);
    assert.equal(run.view().report.learningAllowed, false);
  } finally {
    run.close();
  }
});
test("CW-03 fixed synthetic round trip uses exact core report and learning HOLD", () => {
  let now = 0;
  const run = new CostWebRun(directory(), program, true, undefined, () => now);
  try {
    run.control(control(run, "START"));
    for (
      now = 1000;
      now <= 16000 && run.view().runtime.phase === "RUNNING";
      now += 1000
    )
      run.step();
    const v = run.view(),
      report = run.store.report();
    assert.equal(v.error, null);
    assert.equal(v.loop.status, "CLOSED");
    assert.equal(v.runtime.phase, "STOPPED");
    assert.equal(v.safeToLeave, true);
    assert.deepEqual(v.report, report);
    const t = report.financialEvidence.trades[0]!,
      a = report.financialEvidence.accounts[0]!;
    assert.equal(t.quantity, 0);
    assert.equal(t.unsettledFillCount, 0);
    assert.equal(t.tradingFees, "20");
    assert.equal(t.outcome!.netPnlNative, String(4n * (22000n - 21400n) - 20n));
    assert.equal(a.cash, "5002380");
    assert.equal(a.reservedCash, "0");
    assert.equal(a.payable, "0");
    assert.equal(a.receivable, "0");
    assert.equal(
      report.learningEvidence.financialBasisHash,
      report.report.financialBasisHash,
    );
    assert.equal(report.learningEvidence.status, "HOLD");
    assert.equal(report.liveEnabled, false);
    assert.equal(report.orderSubmissionAllowed, false);
    assert.throws(() => run.control(control(run, "START")), /START_BLOCKED/);
  } finally {
    run.close();
  }
});
test("CW-04 independent timer detects disconnected input; restored feed preserves HOLD", async () => {
  let now = 0;
  const run = new CostWebRun(directory(), program, true, undefined, () => now);
  try {
    run.control(control(run, "START"));
    now = 1000;
    run.step();
    run.control(control(run, "FEED_OFF"));
    const financial = hash(run.view().report.financialEvidence.accounts);
    now = 4001;
    await delay(700);
    assert.ok(run.view().loop.holds.includes("WATCHDOG_INPUT_STALE"));
    assert.equal(hash(run.view().report.financialEvidence.accounts), financial);
    run.control(control(run, "FEED_ON"));
    run.step();
    assert.ok(run.view().loop.holds.includes("WATCHDOG_INPUT_STALE"));
    assert.equal(run.view().safeToLeave, false);
    for (
      now = 5001;
      now <= 24001 && run.view().runtime.phase === "RUNNING";
      now += 1000
    )
      run.step();
    assert.equal(run.view().finished, true);
    assert.equal(run.view().runtime.phase, "STOPPED");
    assert.ok(run.view().loop.holds.includes("WATCHDOG_INPUT_STALE"));
    assert.equal(run.view().safeToLeave, false);
    assert.throws(() => run.control(control(run, "START")), /START_BLOCKED/);
  } finally {
    run.close();
  }
});
test("CW-05 reopen is inspection-only; exact stored financial/report evidence preserved", () => {
  const path = directory();
  let now = 0;
  const first = new CostWebRun(path, program, true, undefined, () => now);
  const start = control(first, "START");
  first.control(start);
  now = 1000;
  first.step();
  first.control(control(first, "STOP"));
  const before = first.view().report;
  first.close();
  const reopened = new CostWebRun(path, program, false);
  try {
    assert.equal(reopened.view().recoveryRequired, true);
    assert.equal(reopened.view().runtime.timerPending, false);
    assert.deepEqual(reopened.view().report, before);
    reopened.control(start);
    assert.equal(reopened.view().runtime.phase, "IDLE");
    assert.throws(
      () => reopened.control(control(reopened, "START")),
      /INSPECTION_ONLY/,
    );
    assert.throws(() => new CostWebRun(path, program, true), /DATABASE_STATE/);
  } finally {
    reopened.close();
  }
});
test("CW-06 failed control persistence never starts; stale view exposes FAULT on tick write error", () => {
  let now = 0;
  const run = new CostWebRun(directory(), program, true, undefined, () => now);
  try {
    run.repo.failure = "DISK_FULL";
    assert.throws(() => run.control(control(run, "START")), /DISK_FULL/);
    assert.equal(run.view().runtime.phase, "STOPPED");
    assert.equal(run.view().controlRevision, 0);
    assert.ok(run.view().error);
    assert.equal(run.view().runtime.timerPending, false);
    assert.equal(run.view().safeToLeave, false);
  } finally {
    run.repo.failure = null;
    run.close();
  }
  const second = new CostWebRun(
    directory(),
    program,
    true,
    undefined,
    () => now,
  );
  try {
    second.control(control(second, "START"));
    second.repo.failure = "DISK_FULL";
    const before = second.view().report.reportHash;
    now = 1000;
    second.step();
    assert.ok(second.view().error);
    assert.equal(second.view().report.reportHash, before);
    assert.equal(second.view().runtime.timerPending, false);
  } finally {
    second.repo.failure = null;
    second.close();
  }
});
test("CW-07 HTTP auth/CSRF/origin, duplicate create and cold recovery gate", async () => {
  const root = directory(),
    service = new CostWebService(root),
    engine = new Engine(":memory:");
  const app = createApp(engine, "COST_WEB_TEST_ONLY_CODE", { cost: service });
  const url = await app.listen(0);
  try {
    assert.equal((await fetch(url + "/api/cost-lab")).status, 401);
    const login = await fetch(url + "/api/login", {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "COST_WEB_TEST_ONLY_CODE" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!,
      { csrf } = (await login.json()) as { csrf: string };
    const request = {
      type: "create",
      id: randomUUID(),
      acknowledgeSynthetic: true,
    };
    const headers = {
      Origin: url,
      Cookie: cookie,
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
    };
    assert.equal(
      (
        await fetch(url + "/api/cost-lab", {
          method: "POST",
          headers: { ...headers, "x-csrf-token": "bad" },
          body: JSON.stringify(request),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + "/api/cost-lab", {
          method: "POST",
          headers: { ...headers, Origin: "https://example.com" },
          body: JSON.stringify(request),
        })
      ).status,
      403,
    );
    const responses = await Promise.all(
      [1, 2].map(() =>
        fetch(url + "/api/cost-lab", {
          method: "POST",
          headers,
          body: JSON.stringify(request),
        }),
      ),
    );
    assert.ok(responses.every((r) => r.status === 200));
    assert.equal(readdirSync(root).length, 1);
    for (let i = 0; i < 200 && service.view().phase === "PREPARING"; i++)
      await delay(500);
    assert.equal(service.view().phase, "READY");
    assert.equal(service.view().view!.runtime.phase, "IDLE");
    assert.equal(service.view().canCreate, false);
    await assert.rejects(
      () => service.request({ ...request, id: randomUUID() }),
      /UNRESOLVED_RUN/,
    );
    assert.equal(engine.runtimeError, null);
  } finally {
    await service.close();
    await app.close();
    engine.close();
  }
  const second = new CostWebService(root);
  try {
    assert.equal(second.view().canCreate, false);
  } finally {
    await second.close();
  }
});
