import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBridgeSample } from "../dist/runtime/src/server/analysis-permission-bridge-runner.js";
import {
  checkBridgeRun,
  checkBridgeBuild,
  checkBridgeFixture,
  createBridgeFixture,
} from "../dist/runtime/src/server/analysis-permission-bridge-files.js";
import {
  PermissionJournalWriter,
  readPermissionJournal,
} from "../dist/runtime/src/server/analysis-permission-journal-files.js";
import { checkProvision } from "../dist/runtime/src/server/analysis-provision-files.js";
import {
  bridgeInit,
  nativeIntentDigest,
  parseBridgeReady,
} from "../dist/runtime/src/core/analysis-permission-bridge.js";
import { launchSha256 } from "../dist/runtime/src/core/analysis-launch-plan.js";

if (process.argv.length !== 6) throw new Error("RUN_PLAN_BUILD_HASH_REQUIRED");
const args = process.argv.slice(2),
  [runId, planHash, buildId, buildHash] = args;
const workspace = fileURLToPath(new URL("../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const directory = join(
  workspace,
  "work",
  `permission-bridge-tests-${randomUUID()}`,
);
mkdirSync(directory);
const report = {
  scope: "REAL_FILE_IDENTITY_AND_NATIVE_MODEL_DISK_JOURNAL_NO_ACL",
  passed: false,
  checks: [],
  samples: [],
};
const save = () =>
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
const test = async (name, body) => {
  try {
    await body();
    report.checks.push({ name, passed: true });
  } catch (e) {
    report.checks.push({
      name,
      passed: false,
      error: String(e.message).slice(0, 180),
    });
    save();
    throw e;
  }
};
const review = checkProvision(workspace, runId, planHash),
  plan = JSON.parse(readFileSync(review.manifestPath));
const { executable } = checkBridgeBuild(workspace, buildId, buildHash);
let first, context;
await test("32 native model operations / 64 durable records / file pinning", async () => {
  first = await runBridgeSample(workspace, ...args, (point, value, step) => {
    context = value;
    if (point === "READY") {
      const path = join(value.directory, "fixture/input/allow.txt");
      assert.throws(() =>
        renameSync(path, join(value.directory, "renamed.txt")),
      );
      assert.throws(() => writeFileSync(path, "MUTATED"));
    }
    if (point === "BEFORE_ACK" && step === 0) {
      const state = readPermissionJournal(
        workspace,
        value.journal.labId,
        value.journal.bindingSha256,
      );
      assert.equal(state.sequence, 1);
      assert.ok(state.pending);
      assert.ok(state.writerPresent);
      assert.throws(
        () =>
          new PermissionJournalWriter(
            workspace,
            value.journal.labId,
            value.journal.bindingSha256,
            state.head,
          ),
      );
    }
  });
  assert.equal(first.status, "NATIVE_MODEL_JOURNAL_VERIFIED");
  assert.equal(first.records, 64);
  assert.equal(first.osChangesApplied, false);
  report.samples.push(first);
});
const check = (head) =>
  checkBridgeRun(workspace, first.labId, first.createdSha256, head);
await test("anchored readonly reopen", () =>
  assert.equal(check(first.head).status, "NATIVE_MODEL_JOURNAL_VERIFIED"));
await test("missing external head stays held", () =>
  assert.equal(check().status, "RECOVERY_HOLD"));
await test("wrong creation anchor", () =>
  assert.throws(() =>
    checkBridgeRun(workspace, first.labId, "0".repeat(64), first.head),
  ));
await test("wrong journal head", () =>
  assert.throws(() => check("0".repeat(64))));
async function mutate(name, path, bytes, action) {
  await test(name, () => {
    const before = readFileSync(path);
    try {
      writeFileSync(path, bytes(before));
      assert.throws(action);
    } finally {
      writeFileSync(path, before);
    }
  });
}
await mutate(
  "truncated durable log",
  join(context.journal.directory, "events.ndjson"),
  (b) => Buffer.from(b.toString().split("\n").slice(0, 62).join("\n") + "\n"),
  () => check(first.head),
);
await mutate(
  "identity receipt tampering",
  join(context.directory, "identity.json"),
  (b) => {
    const v = JSON.parse(b);
    v.objectIds[0] = "0".repeat(64);
    return JSON.stringify(v) + "\n";
  },
  () => check(first.head),
);
await mutate(
  "started operation tampering",
  join(context.directory, "started.json"),
  (b) => {
    const v = JSON.parse(b);
    v.operations[1] = v.operations[0];
    return JSON.stringify(v) + "\n";
  },
  () => check(first.head),
);
await mutate(
  "dummy content tampering",
  join(context.directory, "fixture/input/allow.txt"),
  () => "CHANGED",
  () => check(first.head),
);
await mutate(
  "result relabeled as OS proof",
  join(context.directory, "result.json"),
  (b) =>
    b.toString().replace('"osChangesApplied":false', '"osChangesApplied":true'),
  () => check(first.head),
);
await test("completed sample preserved after negative tests", () =>
  assert.equal(check(first.head).status, "NATIVE_MODEL_JOURNAL_VERIFIED"));
for (const scenario of ["REPLACEMENT", "HARDLINK", "EXTRA", "CONTENT"]) {
  await test(`fresh fixture rejects ${scenario}`, async () => {
    let failed;
    await assert.rejects(
      runBridgeSample(workspace, ...args, (point, value) => {
        if (point !== "CREATED") return;
        failed = value;
        const path = join(value.directory, "fixture/input/allow.txt");
        if (scenario === "REPLACEMENT") {
          const bytes = readFileSync(path);
          renameSync(path, join(value.directory, "old.txt"));
          writeFileSync(path, bytes, { flag: "wx" });
        }
        if (scenario === "HARDLINK")
          linkSync(path, join(value.directory, "link.txt"));
        if (scenario === "EXTRA")
          writeFileSync(
            join(value.directory, "fixture/input/extra.txt"),
            "NEW",
            { flag: "wx" },
          );
        if (scenario === "CONTENT") writeFileSync(path, "CHANGED");
      }),
    );
    assert.ok(failed);
    assert.equal(existsSync(join(failed.directory, "started.json")), false);
    assert.equal(
      readPermissionJournal(
        workspace,
        failed.journal.labId,
        failed.journal.bindingSha256,
      ).sequence,
      0,
    );
  });
}
for (const point of [
  "BEFORE_WRITE",
  "BEFORE_ACK",
  "AFTER_WRITE",
  "AFTER_ACK",
  "DONE",
]) {
  await test(`host interruption at ${point}`, async () => {
    let failed;
    await assert.rejects(
      runBridgeSample(workspace, ...args, (actual, value, step) => {
        if (actual === point && step === 0) {
          failed = value;
          throw new Error("TEST_INTERRUPTION");
        }
      }),
      /TEST_INTERRUPTION/,
    );
    assert.ok(failed);
    const state = readPermissionJournal(
      workspace,
      failed.journal.labId,
      failed.journal.bindingSha256,
    );
    assert.equal(
      state.sequence,
      point === "BEFORE_WRITE"
        ? 0
        : ["BEFORE_ACK", "AFTER_WRITE"].includes(point)
          ? 1
          : 2,
    );
    assert.equal(
      checkBridgeRun(
        workspace,
        failed.created.labId,
        failed.createdSha256,
        state.head,
      ).status,
      "RECOVERY_HOLD",
    );
    assert.equal(existsSync(join(failed.directory, "result.json")), false);
  });
}
await test("journal altered before fsync receipt blocks native progression", async () => {
  let failed;
  await assert.rejects(
    runBridgeSample(workspace, ...args, (point, value) => {
      if (point === "BEFORE_WRITE") {
        failed = value;
        writeFileSync(
          join(value.journal.directory, "events.ndjson"),
          "{partial",
        );
      }
    }),
  );
  assert.equal(existsSync(join(failed.directory, "result.json")), false);
  assert.throws(() =>
    readPermissionJournal(
      workspace,
      failed.journal.labId,
      failed.journal.bindingSha256,
    ),
  );
});
await test("fixture inventory changed while pinned blocks BEFORE", async () => {
  let failed;
  await assert.rejects(
    runBridgeSample(workspace, ...args, (point, value) => {
      if (point === "READY") {
        failed = value;
        writeFileSync(
          join(value.directory, "fixture/evidence/extra.txt"),
          "NEW",
          { flag: "wx" },
        );
      }
    }),
  );
  assert.equal(
    readPermissionJournal(
      workspace,
      failed.journal.labId,
      failed.journal.bindingSha256,
    ).sequence,
    0,
  );
});
for (const point of ["READY", "BEFORE_ACK", "AFTER_WRITE", "AFTER_ACK"]) {
  await test(`actual owned host process termination at ${point}`, async () => {
    const child = spawn(
      process.execPath,
      [
        join(workspace, "scripts/permission-bridge-crash-worker.mjs"),
        ...args,
        point,
      ],
      {
        cwd: workspace,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let timer;
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      const checkpoint = await new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("CRASH_CHECKPOINT_TIMEOUT")),
          15000,
        );
        child.once("message", resolve);
        child.once("error", reject);
        child.once("exit", () => reject(new Error("EARLY_WORKER_EXIT")));
      });
      child.kill();
      await closed;
      const value = checkpoint.context,
        state = readPermissionJournal(
          workspace,
          value.journal.labId,
          value.journal.bindingSha256,
        );
      assert.ok(state.writerPresent);
      assert.equal(
        state.sequence,
        point === "READY" ? 0 : point === "AFTER_ACK" ? 2 : 1,
      );
      assert.throws(
        () =>
          new PermissionJournalWriter(
            workspace,
            value.journal.labId,
            value.journal.bindingSha256,
            state.head,
          ),
      );
      assert.equal(
        checkBridgeRun(
          workspace,
          value.created.labId,
          value.createdSha256,
          state.head,
        ).status,
        "RECOVERY_HOLD",
      );
      assert.ok(existsSync(join(value.journal.directory, "writer.lock")));
      report.samples.push({
        crashPhase: point,
        labId: value.created.labId,
        status: "RECOVERY_HOLD",
        records: state.sequence,
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  });
}
for (const fault of ["SHORT_WRITE", "FSYNC_BEFORE", "FSYNC_AFTER"]) {
  await test(`disk writer injected ${fault} stays held`, async () => {
    const oldWrite = fs.writeSync,
      oldSync = fs.fsyncSync;
    let failed,
      armed = false;
    try {
      await assert.rejects(
        runBridgeSample(workspace, ...args, (point, value, step) => {
          if (
            step !== 0 ||
            point !== (fault === "FSYNC_AFTER" ? "AFTER_WRITE" : "BEFORE_WRITE")
          )
            return;
          failed = value;
          armed = true;
          if (fault === "SHORT_WRITE") fs.writeSync = () => 0;
          else
            fs.fsyncSync = () => {
              throw new Error("TEST_FSYNC_FAILED");
            };
          syncBuiltinESMExports();
        }),
      );
    } finally {
      fs.writeSync = oldWrite;
      fs.fsyncSync = oldSync;
      syncBuiltinESMExports();
    }
    assert.ok(armed);
    const state = readPermissionJournal(
      workspace,
      failed.journal.labId,
      failed.journal.bindingSha256,
    );
    assert.equal(
      state.sequence,
      fault === "SHORT_WRITE" ? 0 : fault === "FSYNC_BEFORE" ? 1 : 2,
    );
    assert.equal(
      checkBridgeRun(
        workspace,
        failed.created.labId,
        failed.createdSha256,
        state.head,
      ).status,
      "RECOVERY_HOLD",
    );
    assert.equal(existsSync(join(failed.directory, "result.json")), false);
  });
}
// Direct native protocol probes only observe fresh fixture identities and mutate in-memory flags.
const fixture = createBridgeFixture(workspace, plan, buildId, buildHash),
  init = bridgeInit(fixture.created.labId, plan, planHash);
async function raw(mode) {
  const child = spawn(executable, ["--stdio-model"], {
    cwd: workspace,
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  let pending = "",
    op = randomUUID(),
    timer;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  child.stdin.on("error", () => {});
  child.stderr.resume();
  child.stdout.on("data", (data) => {
    pending += data.toString();
    let n;
    while ((n = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, n);
      pending = pending.slice(n + 1);
      lines.push(line);
      if (line.startsWith("READY ")) {
        const ids = parseBridgeReady(line, init, fixture.created.nodeIds);
        const intent = {
          operationId: op,
          targetIndex: 0,
          direction: "APPLY",
          objectId: ids[0],
          expectedSha256: launchSha256(plan.targets[0].initialSddl),
          desiredSha256: launchSha256(plan.targets[0].proposedSddl),
        };
        raw.digest = nativeIntentDigest(plan, planHash, intent);
        child.stdin.write(`OP ${op}\n`);
      } else if (line.startsWith("BEFORE ")) {
        assert.equal(line, `BEFORE ${op} ${raw.digest}`);
        if (mode === "WRONG_DIGEST")
          child.stdin.end(
            `ACK_BEFORE ${op} ${"0".repeat(64)} ${"1".repeat(64)}\n`,
          );
        if (mode === "WRONG_OPERATION")
          child.stdin.end(
            `ACK_BEFORE ${randomUUID()} ${raw.digest} ${"1".repeat(64)}\n`,
          );
        if (mode === "DUPLICATE_BEFORE")
          child.stdin.write(
            `ACK_BEFORE ${op} ${raw.digest} ${"1".repeat(64)}\nACK_BEFORE ${op} ${raw.digest} ${"1".repeat(64)}\n`,
          );
        if (mode === "EOF_BEFORE") child.stdin.end();
        if (mode === "DUPLICATE_OPERATION")
          child.stdin.write(
            `ACK_BEFORE ${op} ${raw.digest} ${"1".repeat(64)}\n`,
          );
      } else if (line.startsWith("AFTER ") && mode === "DUPLICATE_OPERATION")
        child.stdin.write(`ACK_AFTER ${op} ${"2".repeat(64)}\n`);
      else if (line.startsWith("DONE ") && mode === "DUPLICATE_OPERATION")
        child.stdin.end(`OP ${op}\n`);
    }
  });
  timer = setTimeout(() => child.kill(), 10000);
  child.stdin.write(init);
  try {
    assert.equal(await done, 2);
  } finally {
    clearTimeout(timer);
  }
  if (
    [
      "WRONG_DIGEST",
      "WRONG_OPERATION",
      "EOF_BEFORE",
      "TIMEOUT_BEFORE",
    ].includes(mode)
  )
    assert.equal(
      lines.some((l) => l.startsWith("AFTER ")),
      false,
    );
  checkBridgeFixture(fixture.directory, fixture.created);
}
for (const mode of [
  "WRONG_DIGEST",
  "WRONG_OPERATION",
  "EOF_BEFORE",
  "TIMEOUT_BEFORE",
  "DUPLICATE_BEFORE",
  "DUPLICATE_OPERATION",
])
  await test(`native protocol ${mode}`, () => raw(mode));
for (const input of [
  "",
  "BRIDGE_MODEL_V1\n",
  init.replace("BRIDGE_MODEL_V1", "BRIDGE_OS_V1"),
  init.replace(" ", "\0"),
  "A".repeat(5000) + "\n",
]) {
  await test(`native malformed input ${report.checks.length}`, () => {
    const r = spawnSync(executable, ["--stdio-model"], {
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 7000,
    });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
  });
}
for (const argv of [
  [],
  ["--apply"],
  ["--restore"],
  ["--stdio-model", "--approve"],
])
  await test(`native rejects ${argv.join(" ") || "no args"}`, () => {
    const r = spawnSync(executable, argv, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 7000,
      env: { ...process.env, ALLOW_OS_EXECUTION: "true" },
    });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
  });
const cli = join(
  workspace,
  "dist/runtime/src/server/analysis-permission-bridge-cli.js",
);
for (const argv of [
  [],
  ["apply"],
  ["sample", ...args, "--approve"],
  ["check", "../escape", first.createdSha256, first.head],
])
  await test(`CLI rejects ${argv[0] ?? "no args"}`, () => {
    const r = spawnSync(process.execPath, [cli, ...argv], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stderr).status, "BRIDGE_HOLD");
  });
await test("CLI readonly check", () => {
  const r = spawnSync(
    process.execPath,
    [cli, "check", first.labId, first.createdSha256, first.head],
    { encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).records, 64);
});
await test("build independent anchor and extra file rejected", () => {
  assert.throws(() => checkBridgeBuild(workspace, buildId, "0".repeat(64)));
  const extra = join(
    workspace,
    "work/analysis-permission-bridge-build",
    `build-${buildId}`,
    `test-${randomUUID()}.txt`,
  );
  try {
    writeFileSync(extra, "TEST_ONLY", { flag: "wx" });
    assert.throws(() => checkBridgeBuild(workspace, buildId, buildHash));
  } finally {
    unlinkSync(extra);
  }
  checkBridgeBuild(workspace, buildId, buildHash);
});
assert.equal(existsSync(plan.proposedRunRoot), false);
report.passed = true;
save();
console.log(
  JSON.stringify({
    passed: true,
    checks: report.checks.length,
    report: join(directory, "report.json"),
    sample: first,
  }),
);
