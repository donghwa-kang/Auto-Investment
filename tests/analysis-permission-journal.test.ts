import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  linkSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchSha256 } from "../src/core/analysis-launch-plan.js";
import {
  buildProvisionPlan,
  provisionRequest,
  provisionSddl,
  securityKinds,
} from "../src/core/analysis-provision.js";
import {
  journalJson,
  permissionJournalBinding,
  permissionRecord,
  replayPermissionJournal,
  type PermissionIntent,
} from "../src/core/analysis-permission-journal.js";
import {
  createPermissionJournal,
  PermissionJournalWriter,
  readPermissionJournal,
} from "../src/server/analysis-permission-journal-files.js";
const workspace = fileURLToPath(new URL("../../../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const hash = launchSha256("MODEL"),
  host = "S-1-5-21-111-222-333-1001",
  app = "S-1-15-2-1-2-3-4-5-6-7";
function plan() {
  const runId = randomUUID();
  return buildProvisionPlan(
    workspace,
    {
      version: "PROVISION_INSPECTION_V1",
      runId,
      requestSha256: launchSha256(provisionRequest(runId)),
      hostSid: host,
      appSid: app,
      descriptors: securityKinds.map((kind) => ({
        kind,
        sddlSha256: launchSha256(provisionSddl(kind, host, app)),
        descriptorSha256: hash,
        bytes: 256,
      })),
      memoryStructureVerified: true,
      profileExistence: "NOT_QUERIED",
      osChangesApplied: false,
      osIsolationVerified: false,
    },
    {
      buildId: runId,
      buildSha256: hash,
      probeBuildId: runId,
      probeBuildSha256: hash,
      probeSha256: hash,
      codeHashes: { model: hash },
    },
  );
}
function setup() {
  const p = plan(),
    binding = permissionJournalBinding(p),
    created = createPermissionJournal(workspace, p);
  const intent = (index = 0, restore = false): PermissionIntent => ({
    operationId: randomUUID(),
    targetIndex: index,
    direction: restore ? "RESTORE" : "APPLY",
    objectId: launchSha256(`MODEL:${created.labId}:${index}`),
    expectedSha256: restore
      ? binding.targets[index]!.appliedSha256
      : binding.targets[index]!.beforeSha256,
    desiredSha256: restore
      ? binding.targets[index]!.beforeSha256
      : binding.targets[index]!.appliedSha256,
  });
  const read = (head?: string) =>
    readPermissionJournal(
      workspace,
      created.labId,
      created.bindingSha256,
      head,
    );
  const writer = (head = created.head) =>
    new PermissionJournalWriter(
      workspace,
      created.labId,
      created.bindingSha256,
      head,
    );
  return {
    p,
    binding,
    ...created,
    intent,
    read,
    writer,
    log: join(created.directory, "events.ndjson"),
  };
}
test("durable complete 16 apply + reverse restore; clean reopen; no OS claim", () => {
  const s = setup();
  let head = s.head;
  for (const restore of [false, true]) {
    for (let offset = 0; offset < 16; offset++) {
      const i = s.intent(restore ? 15 - offset : offset, restore),
        writer = s.writer(head);
      try {
        const ack = writer.begin(i);
        assert.equal(
          s.read(ack.durableRecordSha256).pending?.operationId,
          i.operationId,
        );
        head = writer.finish(i.operationId, i.desiredSha256);
      } finally {
        writer.close();
      }
    }
  }
  const state = s.read(head);
  assert.equal(state.sequence, 64);
  assert.equal(state.appliedCount, 0);
  assert.equal(state.status, "MODEL_RECORDS_VERIFIED");
  assert.equal(state.osChangesApplied, false);
  assert.equal(state.osRecoveryVerified, false);
});
test("unanchored observations always hold", () => {
  const s = setup();
  assert.equal(s.read().status, "RECOVERY_HOLD");
});
test("external head rejects valid-prefix truncation", () => {
  const s = setup(),
    w = s.writer(),
    i = s.intent();
  w.begin(i);
  const head = w.finish(i.operationId, i.desiredSha256);
  w.close();
  truncateSync(s.log, 0);
  assert.throws(() => s.read(head), /HEAD_HOLD/);
});
test("pending before record survives normal close and blocks restart", () => {
  const s = setup(),
    w = s.writer();
  const ack = w.begin(s.intent());
  w.close();
  assert.equal(s.read(ack.durableRecordSha256).status, "RECOVERY_HOLD");
  assert.throws(() => s.writer(ack.durableRecordSha256));
});
test("uncertain result remains a hold", () => {
  const s = setup(),
    w = s.writer(),
    i = s.intent();
  w.begin(i);
  const head = w.finish(i.operationId, null);
  w.close();
  assert.equal(s.read(head).uncertain, true);
  assert.throws(() => s.writer(head));
});
test("second writer cannot enter; first writer remains usable", () => {
  const s = setup(),
    w = s.writer();
  assert.throws(() => s.writer());
  const i = s.intent();
  w.begin(i);
  const head = w.finish(i.operationId, i.desiredSha256);
  w.close();
  assert.equal(s.read(head).sequence, 2);
  assert.equal(existsSync(join(s.directory, "writer.lock")), false);
});
test("wrong binding and run path do not open files", () => {
  const s = setup();
  assert.throws(() => readPermissionJournal(workspace, s.labId, hash, s.head));
  assert.throws(() =>
    readPermissionJournal(workspace, "../data", s.bindingSha256, s.head),
  );
});
test("extra file is not ignored", () => {
  const s = setup();
  writeFileSync(join(s.directory, "extra.txt"), "MODEL", { flag: "wx" });
  assert.throws(() => s.read(s.head));
});
test("hardlinked journal rejected before append", () => {
  const s = setup();
  linkSync(
    s.log,
    join(workspace, "work", `permission-hardlink-${s.labId}.txt`),
  );
  assert.throws(() => s.writer());
});
test("bad target, out of order and mismatched security reject before writing", () => {
  for (const change of [
    (i: PermissionIntent) => ({ ...i, targetIndex: 16 }),
    (i: PermissionIntent) => ({ ...i, targetIndex: 1 }),
    (i: PermissionIntent) => ({ ...i, desiredSha256: hash }),
  ]) {
    const s = setup(),
      w = s.writer();
    try {
      assert.throws(() => w.begin(change(s.intent())));
    } finally {
      w.close();
    }
    assert.equal(readFileSync(s.log).length, 0);
  }
});
test("duplicate operation cannot be recorded twice", () => {
  const s = setup(),
    w = s.writer(),
    i = s.intent();
  w.begin(i);
  w.finish(i.operationId, i.desiredSha256);
  try {
    assert.throws(() =>
      w.begin({ ...s.intent(1), operationId: i.operationId }),
    );
  } finally {
    w.close();
  }
  assert.equal(s.read().sequence, 2);
});
test("after without owned intent cannot write", () => {
  const s = setup(),
    w = s.writer();
  try {
    assert.throws(() => w.finish(randomUUID(), hash));
  } finally {
    w.close();
  }
  assert.equal(s.read().sequence, 0);
});
test("wrong observed post-state preserves pending record", () => {
  const s = setup(),
    w = s.writer(),
    i = s.intent();
  w.begin(i);
  try {
    assert.throws(() => w.finish(i.operationId, hash));
  } finally {
    w.close();
  }
  assert.ok(s.read().pending);
});
test("restore requires same object identity and reverse order", () => {
  for (const changed of [true, false]) {
    const s = setup(),
      w = s.writer(),
      i = s.intent();
    w.begin(i);
    w.finish(i.operationId, i.desiredSha256);
    try {
      assert.throws(() =>
        w.begin(
          changed
            ? { ...s.intent(0, true), objectId: hash }
            : s.intent(1, true),
        ),
      );
    } finally {
      w.close();
    }
  }
});
test("partial, invalid utf8, duplicate key, chain tamper, reordered lines rejected", () => {
  const s = setup(),
    w = s.writer(),
    i = s.intent();
  w.begin(i);
  w.finish(i.operationId, i.desiredSha256);
  w.close();
  const bytes = readFileSync(s.log),
    text = bytes.toString("utf8"),
    lines = text.trimEnd().split("\n");
  for (const bad of [
    bytes.subarray(0, -1),
    Buffer.from([0xff, 10]),
    Buffer.from(text.replace('"sequence":1', '"sequence":1,"sequence":1')),
    Buffer.from(text.replace(i.objectId, hash)),
    Buffer.from(lines.reverse().join("\n") + "\n"),
  ])
    assert.throws(() => replayPermissionJournal(s.binding, bad));
});
test("oversized journal fails before parsing", () => {
  const s = setup();
  assert.throws(() => replayPermissionJournal(s.binding, Buffer.alloc(131073)));
});
test("binding contract cannot be relabeled native", () => {
  const s = setup();
  assert.throws(() =>
    replayPermissionJournal(
      { ...s.binding, mode: "NATIVE" } as unknown as typeof s.binding,
      Buffer.alloc(0),
    ),
  );
});
test("disk tamper between before and after poisons writer", () => {
  const s = setup(),
    w = s.writer(),
    i = s.intent();
  w.begin(i);
  appendFileSync(s.log, "broken");
  try {
    assert.throws(() => w.finish(i.operationId, i.desiredSha256));
    assert.throws(() => w.finish(i.operationId, i.desiredSha256));
  } finally {
    w.close();
  }
});
test("finished writer cannot append", () => {
  const s = setup(),
    w = s.writer();
  w.close();
  w.close();
  assert.throws(() => w.begin(s.intent()));
});
test("hash-chain row itself is independently reproducible", () => {
  const s = setup(),
    i = s.intent();
  const row = permissionRecord(1, s.head, { type: "BEFORE", intent: i });
  assert.equal(
    replayPermissionJournal(s.binding, Buffer.from(journalJson(row))).head,
    row.sha256,
  );
});
for (const phase of ["LOCKED", "BEFORE", "EFFECT", "AFTER"])
  test(`owned process termination at ${phase}: durable evidence and stale lock hold`, async () => {
    const s = setup();
    const child = spawn(
      process.execPath,
      [
        join(workspace, "scripts/permission-journal-crash-worker.mjs"),
        s.labId,
        s.bindingSha256,
        s.head,
        phase,
      ],
      {
        cwd: workspace,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        shell: false,
        windowsHide: true,
        env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      },
    );
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`checkpoint timeout ${stderr.slice(0, 200)}`)),
          10000,
        );
        child.once("message", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("child exited before checkpoint"));
        });
      });
      assert.throws(() => s.writer()); // A separate running process owns the writer lock.
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
    const state = s.read();
    assert.equal(state.writerPresent, true);
    assert.equal(state.status, "RECOVERY_HOLD");
    assert.equal(
      state.sequence,
      phase === "LOCKED" ? 0 : phase === "AFTER" ? 2 : 1,
    );
    assert.throws(() => s.writer(state.head));
    const effect = join(
      workspace,
      "work",
      `permission-model-effect-${s.labId}.json`,
    );
    assert.equal(existsSync(effect), phase === "EFFECT" || phase === "AFTER");
    assert.equal(
      existsSync(
        join(workspace, "work", "analysis-os-lab", `run-${s.p.runId}`),
      ),
      false,
    );
  });
