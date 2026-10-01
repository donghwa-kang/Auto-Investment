import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  cpSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { hash } from "../src/core/policy.js";
import { CostAppRun } from "../src/server/cost-app-run.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { Repository } from "../src/server/repository.js";
import { costAppRecipe } from "../src/server/cost-app-fixture.js";
import { CostWebService } from "../src/server/cost-web-service.js";
import { costWebRequestSchema } from "../src/core/cost-web-schema.js";
import type { CostWebControl } from "../src/core/cost-web-schema.js";
import { saveCostAppText } from "../src/server/cost-app-files.js";
import { verifyCostLearningInput } from "../src/server/cost-learning-input.js";

const directory = () => mkdtempSync(resolve(tmpdir(), "cost-app-test-"));
const command = (
  run: CostAppRun,
  action: CostWebControl["action"],
): CostWebControl => ({
  type: "control",
  runId: "00000000-0000-4000-8000-000000000001",
  id: randomUUID(),
  expectedControl: run.view().controlRevision,
  action,
});
const finish = (run: CostAppRun) => {
  run.control(command(run, "START"));
  for (let i = 0; i < 14 && run.view().runtime.phase === "RUNNING"; i++)
    run.step();
  assert.equal(run.view().error, null);
  assert.equal(run.view().finished, true);
};
let closedPath: string;
let closedView: ReturnType<CostAppRun["view"]>;

test("CA-03/06/09 normal same-core 2330 BigInt oracle, immutable capture and duplicate close", () => {
  closedPath = directory();
  const run = new CostAppRun(closedPath, true);
  let input: ReturnType<CostAppRun["verificationInput"]>;
  try {
    assert.equal(run.view().cursor, 0);
    run.step();
    assert.equal(run.view().cursor, 0);
    finish(run);
    const v = run.view(),
      f = v.report.financialEvidence,
      a = f.currentAccounts[0]!;
    assert.equal(
      f.trades[0]!.finalNetPnlKrw,
      String(4n * (22000n - 21400n) - 20n - 50n),
    );
    assert.equal(a.cash, "5002330");
    assert.equal(a.totalPayable, "0");
    assert.equal(a.receivable, "0");
    assert.equal(a.reservedCash, "0");
    assert.equal(
      BigInt(a.cash) - BigInt(a.totalPayable) - BigInt(a.reservedCash),
      BigInt(a.availableCash),
    );
    assert.equal(f.operating.current.incurredKrw, "50");
    assert.equal(f.operating.current.paidKrw, "50");
    assert.equal(v.report.status, "HOLD");
    assert.equal(v.safeToLeave, false);
    assert.equal(v.closeIntentStatus, "COMMITTED");
    const stored = JSON.parse(
      readFileSync(resolve(closedPath, "close-intent.json"), "utf8"),
    ) as {
      intent: {
        commandId: string;
        closeId: string;
        request: unknown;
        expected: ReturnType<CostReservationStore["read"]>;
      };
    };
    // The artifact is the exact completed snapshot. Do not spend the writer's
    // lease on another full replay before exercising a duplicate write.
    const before: unknown = JSON.parse(
      readFileSync(resolve(closedPath, "financial.json"), "utf8"),
    );
    // Match the real worker's next stopped turn. This still refuses an expired
    // lease: no longer timeout, clock override, or automatic reacquisition.
    run.step();
    assert.equal(run.view().error, null);
    assert.equal(
      run.store.finalizeOperating(
        stored.intent.commandId,
        stored.intent.closeId,
        stored.intent.request,
        stored.intent.expected,
      ).duplicate,
      true,
    );
    run.step();
    assert.equal(run.view().error, null);
    assert.deepEqual(run.view().report, v.report);
    assert.deepEqual(run.store.exportOperatingEvidence(), before);
    input = run.verificationInput();
    assert.equal(a.netAssetValue, null);
    assert.deepEqual(run.verificationInput(), input);
    closedView = v;
  } finally {
    run.close();
  }
  // Read-only S10 work never retains this test's writer. Production uses the
  // separately exercised verification worker, not this direct call.
  const result = verifyCostLearningInput(input.text, input.anchor);
  assert.equal(result.status, "SYNTHETIC_INPUT_ELIGIBLE");
  assert.equal(result.trainingLabel!.finalNetPnlKrw, "2330");
  assert.equal(
    result.audit.financialReport.financialBasisHash,
    closedView.report.financialBasisHash,
  );
  assert.equal(result.learningAllowed, false);
  assert.equal(result.orderSubmissionAllowed, false);
  assert.equal(result.automaticResumeAllowed, false);
});

test("CA-01/02 source/history pins and cold inspection retain config and report", () => {
  const run = new CostAppRun(closedPath, false);
  try {
    assert.deepEqual(run.view().report, closedView.report);
    assert.equal(run.view().runtime.phase, "IDLE");
    assert.equal(run.view().recoveryRequired, true);
    assert.equal(run.view().closeIntentStatus, "COMMITTED");
    assert.equal(run.fixture.history.costs[0]!.amount, "10");
    assert.equal(run.fixture.history.closedIntents.length, 3);
    const proposal = run.view().report.financialEvidence.approvals[0]!;
    assert.equal(proposal.candidate.quantity, 4);
    assert.throws(() => run.control(command(run, "START")), /INSPECTION_ONLY/);
    const original = hash(run.store.exportOperatingEvidence());
    run.step();
    assert.equal(hash(run.store.exportOperatingEvidence()), original);
    // Builder contract: 120 historical sessions plus the current session.
    assert.equal(run.fixture.sources.replay.histories[0]!.sessions.length, 121);
    assert.equal(
      run.fixture.sources.replay.histories[0]!.sessions[0]!.rows.length,
      60,
    );
  } finally {
    run.close();
  }
});

test("CA-05 STOP freezes cursor; missing feed records pulse/HOLD and never backdates replay", () => {
  const run = new CostAppRun(directory(), true);
  try {
    const start = command(run, "START");
    run.control(start);
    run.step();
    const stop = command(run, "STOP");
    run.control(stop);
    const before = hash(run.store.read()),
      cursor = run.view().cursor;
    run.step();
    run.control(start);
    assert.equal(run.view().runtime.phase, "STOPPED");
    assert.equal(run.view().cursor, cursor);
    assert.equal(hash(run.store.read()), before);
    assert.equal(
      run.view().report.financialEvidence.trades[0]!.finalNetPnlKrw,
      null,
    );
    run.control(command(run, "START"));
    run.control(command(run, "FEED_OFF"));
    for (let i = 0; i < 4; i++) run.step();
    assert.ok(run.view().loop.holds.includes("WATCHDOG_INPUT_STALE"));
    assert.equal(run.view().cursor, cursor);
    run.control(command(run, "FEED_ON"));
    run.step();
    assert.equal(run.view().error, "COST_APP_SCHEDULE_TIME_PASSED");
    assert.equal(run.view().finished, false);
    assert.equal(run.view().capture, null);
  } finally {
    run.close();
  }
});

test("CA-06 lease expiry before COMMIT rolls back; heartbeat cannot revive it; diagnostics distinguish cause", () => {
  let at = 1000;
  const repo = new Repository(":memory:", () => at);
  repo.acquire();
  try {
    let failure: unknown;
    try {
      repo.writerTransaction(() => {
        repo.db.prepare("INSERT INTO commands VALUES(?,?)").run("one", "hash");
        at += 10000;
      });
    } catch (e) {
      failure = e;
    }
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, "FENCED_WRITER");
    assert.deepEqual(failure.cause, {
      kind: "WRITER_LEASE_DIAGNOSTIC",
      rowPresent: true,
      ownerMatches: true,
      epochMatches: true,
      remainingMs: 0,
    });
    assert.equal(
      repo.db.prepare("SELECT COUNT(*) AS n FROM commands").get()!.n,
      0,
    );
    assert.equal(repo.db.isTransaction, false);
    assert.throws(() => repo.heartbeat(), /FENCED_WRITER/);
  } finally {
    repo.close();
  }
});

test("CA-06/09 failed persisted control never starts; immutable partial/conflict never published", () => {
  const path = directory(),
    run = new CostAppRun(path, true);
  try {
    const before = hash(run.store.exportOperatingEvidence());
    run.repo.failure = "DISK_FULL";
    assert.throws(() => run.control(command(run, "START")), /DISK_FULL/);
    assert.equal(run.view().runtime.phase, "STOPPED");
    assert.equal(run.view().controlRevision, 0);
    assert.equal(hash(run.store.exportOperatingEvidence()), before);
  } finally {
    run.repo.failure = null;
    run.close();
  }
  saveCostAppText(path, "artifact.json", "one");
  assert.throws(
    () => saveCostAppText(path, "artifact.json", "two"),
    /FILE_CONFLICT/,
  );
  writeFileSync(resolve(path, "unfinished.json.partial"), "partial", {
    flag: "wx",
  });
  assert.throws(
    () => saveCostAppText(path, "unfinished.json", "new"),
    /EEXIST/,
  );
  assert.equal(existsSync(resolve(path, "unfinished.json")), false);
});

test("CA-09 fixture/input/anchor/capture corruption rejects cold open without financial writes", () => {
  const financialHash = (path: string) => {
    const db = new DatabaseSync(resolve(path, "cost.sqlite"), {
      readOnly: true,
    });
    try {
      return hash(
        [
          "cost_reservation_run",
          "cost_reservation_commands",
          "cost_reservation_approvals",
          "cost_reservation_fills",
          "audit",
        ].map((table) =>
          db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ),
      );
    } finally {
      db.close();
    }
  };
  const original = financialHash(closedPath);
  for (const file of [
    "fixture.json",
    "learning-input.json",
    "anchor.json",
    "snapshot.json",
    "close-intent.json",
  ]) {
    const target = directory();
    cpSync(closedPath, target, { recursive: true });
    const before = financialHash(target);
    writeFileSync(resolve(target, file), "{}");
    assert.throws(() => new CostAppRun(target, false));
    assert.equal(financialHash(target), before);
    assert.equal(financialHash(closedPath), original);
  }
  for (const change of [
    "missing-intent",
    "valid-shape-wrong-snapshot",
    "conflicting-schedule",
  ]) {
    const target = directory();
    cpSync(closedPath, target, { recursive: true });
    const before = financialHash(target);
    if (change === "missing-intent")
      unlinkSync(resolve(target, "close-intent.json"));
    else if (change === "conflicting-schedule") {
      const name = resolve(target, "fixture.json");
      const fixture = JSON.parse(
        readFileSync(name, "utf8"),
      ) as CostAppRun["fixture"];
      fixture.schedule[0]!.price = "21401";
      fixture.completeness.scheduleHash = hash(fixture.schedule);
      writeFileSync(name, JSON.stringify(fixture));
      writeFileSync(
        resolve(target, "fixture-pin.json"),
        JSON.stringify({ fixtureHash: hash(fixture) }),
      );
    } else {
      const name = resolve(target, "snapshot.json");
      const capture = JSON.parse(readFileSync(name, "utf8")) as {
        snapshotId: string;
      };
      capture.snapshotId = "f".repeat(64);
      writeFileSync(name, JSON.stringify(capture));
    }
    assert.throws(
      () => new CostAppRun(target, false),
      /CLOSE_INTENT_MISSING|SNAPSHOT_MISMATCH|SCHEDULE_MISMATCH/,
    );
    assert.equal(financialHash(target), before);
  }
});

test("CA-10 V4 final control slot remains STOP-only without changing the financial snapshot", () => {
  const run = new CostAppRun(directory(), true);
  try {
    const before = hash(run.store.exportOperatingEvidence());
    run.control(command(run, "START"));
    for (let i = 1; i < 99; i++) run.control(command(run, "FEED_ON"));
    assert.equal(run.view().runtime.phase, "RUNNING");
    assert.throws(() => run.control(command(run, "FEED_OFF")), /CONTROL_LIMIT/);
    run.control(command(run, "STOP"));
    assert.equal(run.view().controlRevision, 100);
    assert.equal(run.view().runtime.phase, "STOPPED");
    assert.equal(hash(run.store.exportOperatingEvidence()), before);
  } finally {
    run.close();
  }
});

test("CA-01/10 active UUID cannot silently change recipe, strict schemas and unresolved gate", async () => {
  const root = directory(),
    id = randomUUID();
  cpSync(closedPath, resolve(root, id), { recursive: true });
  writeFileSync(
    resolve(root, id, "request.json"),
    JSON.stringify({
      id,
      createdAt: new Date().toISOString(),
      recipe: costAppRecipe,
    }),
  );
  const service = new CostWebService(root);
  try {
    const create = {
      type: "create",
      id,
      acknowledgeSynthetic: true,
      recipe: costAppRecipe,
    };
    assert.equal(costWebRequestSchema.safeParse(create).success, true);
    for (const extra of [
      { amount: "1" },
      { path: "../" },
      { liveEnabled: true },
      { anchor: {} },
    ])
      assert.equal(
        costWebRequestSchema.safeParse({ ...create, ...extra }).success,
        false,
      );
    await service.request({ type: "open", runId: id });
    await assert.rejects(
      () => service.request({ ...create, recipe: "COST_WEB_SYNTHETIC_KRW_V1" }),
      /RECIPE_CONFLICT/,
    );
    while (service.view().phase === "PREPARING") await delay(100);
    assert.equal(service.view().phase, "READY");
    assert.equal(service.view().canCreate, false);
    const current = service.view().view!;
    if (!("recipe" in current)) throw Error("EXPECTED_V4");
    for (const [runId, snapshotId] of [
      [id, "f".repeat(64)],
      [randomUUID(), current.capture!.snapshotId],
    ])
      await assert.rejects(
        () => service.request({ type: "verify", runId, snapshotId }),
        /CAPTURE_NOT_READY/,
      );
    assert.equal(service.view().verification, null);
    await assert.rejects(
      () => service.request({ ...create, id: randomUUID() }),
      /UNRESOLVED_RUN/,
    );
    const eight = Array.from({ length: 8 }, () =>
      service.request({
        type: "control",
        runId: id,
        id: randomUUID(),
        expectedControl: 1,
        action: "STOP",
      }),
    );
    // Attach handlers immediately: these inspection-only controls will reject.
    const settled = Promise.allSettled(eight);
    await assert.rejects(
      () =>
        service.request({
          type: "control",
          runId: id,
          id: randomUUID(),
          expectedControl: 1,
          action: "STOP",
        }),
      /REQUEST_BUSY/,
    );
    assert.ok((await settled).every((r) => r.status === "rejected"));
  } finally {
    await service.close();
  }
});

test("CA-10 shared twenty-run limit and strict verify request reject unauthorized fields", async () => {
  const root = directory();
  for (let i = 0; i < 20; i++) {
    const id = randomUUID();
    const path = resolve(root, id);
    // Copy just a small saved descriptor, not a populated user database.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path);
    writeFileSync(
      resolve(path, "request.json"),
      JSON.stringify({
        id,
        createdAt: new Date().toISOString(),
        recipe: i % 2 ? costAppRecipe : "COST_WEB_SYNTHETIC_KRW_V1",
      }),
    );
  }
  const service = new CostWebService(root);
  try {
    assert.equal(service.view().runs.length, 20);
    assert.equal(service.view().canCreate, false);
    await assert.rejects(
      () =>
        service.request({
          type: "create",
          id: randomUUID(),
          acknowledgeSynthetic: true,
          recipe: costAppRecipe,
        }),
      /INSPECT_SAVED_RUNS_FIRST/,
    );
    assert.equal(
      costWebRequestSchema.safeParse({
        type: "verify",
        runId: randomUUID(),
        snapshotId: "f".repeat(64),
        text: "untrusted",
      }).success,
      false,
    );
  } finally {
    await service.close();
  }
});

for (const stage of ["before", "after"] as const)
  test(`CA-07 child termination ${stage} D8 dispatch/commit preserves original durable intent`, async () => {
    const path = directory();
    const source = `import {CostAppRun} from './dist/runtime/src/server/cost-app-run.js';
    import {CostReservationStore} from './dist/runtime/src/server/cost-reservation-store.js';
    const original=CostReservationStore.prototype.finalizeOperating;
    const pause=()=>{process.send({stage:${JSON.stringify(stage)}});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
    CostReservationStore.prototype.finalizeOperating=function(...args){if(${JSON.stringify(stage)}==='before')pause();const r=original.apply(this,args);if(${JSON.stringify(stage)}==='after')pause();return r;};
    const run=new CostAppRun(${JSON.stringify(path)},true);
    run.control({type:'control',id:'00000000-0000-4000-8000-000000000002',runId:'00000000-0000-4000-8000-000000000001',expectedControl:0,action:'START'});
    for(let i=0;i<14;i++)run.step();
    process.send({unexpected:run.view().error});run.close();process.disconnect();`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const timeout = setTimeout(() => child.kill(), 120000);
    let stderr = "";
    child.stderr!.on("data", (b) => {
      stderr += String(b);
    });
    try {
      const message = await Promise.race([
        once(child, "message").then(([m]) => m),
        once(child, "exit").then(() => {
          throw Error(`Child exited: ${stderr}`);
        }),
      ]);
      assert.deepEqual(message, { stage });
      const exited = once(child, "exit");
      child.kill();
      await exited;
      await delay(10050); // Real lease must expire; no manual ownership rewrite.
      const intent = readFileSync(resolve(path, "close-intent.json"), "utf8");
      const run = new CostAppRun(path, false);
      try {
        assert.equal(
          run.view().closeIntentStatus,
          stage === "after" ? "COMMITTED" : "UNCOMMITTED_INSPECTION_ONLY",
        );
        assert.equal(run.view().finished, stage === "after");
        assert.equal(run.view().capture, null);
        const before = hash(run.store.exportOperatingEvidence());
        run.step();
        assert.equal(hash(run.store.exportOperatingEvidence()), before);
        assert.equal(
          readFileSync(resolve(path, "close-intent.json"), "utf8"),
          intent,
        );
        assert.throws(
          () => run.control(command(run, "START")),
          /INSPECTION_ONLY/,
        );
      } finally {
        run.close();
      }
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
    }
  });
