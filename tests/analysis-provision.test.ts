import assert from "node:assert/strict";
import { test } from "node:test";
import {
  securityKinds,
  provisionSddl,
  provisionTargets,
  provisionRequest,
  parseProvisionInspection,
  buildProvisionPlan,
  validateProvisionPlan,
  parseProvisionCommand,
  type ProvisionInspection,
} from "../src/core/analysis-provision.js";
import {
  planProvisionRecovery,
  simulateProvisionRecovery,
  type ProvisionJournal,
  type RecoveryObservation,
} from "../src/core/analysis-provision-recovery.js";
import { launchSha256 } from "../src/core/analysis-launch-plan.js";
import { probeJson } from "../src/core/analysis-file-probe.js";
const id = "5dd10c89-7dba-44d2-a793-fa09d92c5e66",
  hash = "a".repeat(64),
  other = "b".repeat(64);
const host = "S-1-5-21-111-222-333-1001",
  app = "S-1-15-2-1-2-3-4-5-6-7";
function inspection(): ProvisionInspection {
  return {
    version: "PROVISION_INSPECTION_V1",
    runId: id,
    requestSha256: launchSha256(provisionRequest(id)),
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
  };
}
const wire = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
function plan() {
  return buildProvisionPlan("C:\\PaperLab", inspection(), {
    buildId: id,
    buildSha256: hash,
    probeBuildId: id,
    probeBuildSha256: other,
    probeSha256: hash,
    codeHashes: { test: hash },
  });
}
function model() {
  const p = plan();
  const j: ProvisionJournal = {
    version: "PROVISION_MODEL_JOURNAL_V1",
    runId: id,
    planSha256: launchSha256(probeJson(p)),
    mode: "MODEL_ONLY",
    entries: p.targets.map((t, i) => ({
      relativePath: t.relativePath,
      objectId: launchSha256(`MODEL_OBJECT_${i}`),
      createdByRunId: id,
      beforeSecuritySha256: launchSha256(t.initialSddl),
      appliedSecuritySha256: launchSha256(t.proposedSddl),
      phase: "APPLIED",
    })),
    profile: "CREATED",
    creationReceipt: {
      runId: id,
      name: p.profile.name,
      sid: app,
      storageIdentity: `MODEL_STORAGE:${id}`,
      creationResult: "CREATED_NEW",
    },
  };
  const o: RecoveryObservation = {
    mode: "MODEL_ONLY",
    runId: id,
    processState: "EXITED_VERIFIED",
    objects: j.entries.map((e) => ({
      relativePath: e.relativePath,
      objectId: e.objectId,
      securitySha256: e.appliedSecuritySha256,
      linksVerified: true,
    })),
    profile: {
      status: "OWNED_VERIFIED",
      name: p.profile.name,
      sid: app,
      storageIdentity: `MODEL_STORAGE:${id}`,
      handlesClosed: true,
    },
  };
  return { p, j, o };
}
test("PROVISION-01 fixed request and SID numeric bounds", () => {
  assert.equal(
    provisionRequest(id).toString(),
    `PROVISION_INSPECT_V1\n${id}\nEND\n`,
  );
  for (const bad of [id.toUpperCase(), "../user", id.replace("44d2", "14d2")])
    assert.throws(() => provisionRequest(bad));
  for (const bad of [
    "WD",
    "S-1-5-18",
    "S-1-5-21-111-222-333-4294967296",
    "S-1-5-21-011-222-333-1001",
    host + ")(A;;FA;;;WD)",
  ])
    assert.throws(() => provisionSddl("HOST", bad, app));
  for (const bad of [
    "AC",
    "S-1-15-2-1",
    app + "-8",
    app.replace("-7", "-4294967296"),
    app.replace("-7", "-07"),
  ])
    assert.throws(() => provisionSddl("READ", host, bad));
});
test("PROVISION-02 explicit DACL/label no broad or inherited grants", () => {
  for (const kind of securityKinds) {
    const s = provisionSddl(kind, host, app);
    assert.match(s, /D:P/);
    assert.match(s, /S:P\(ML;;NW;;;/);
    assert.doesNotMatch(s, /;OI|;CI|;;;WD|;;;AC|NO_ACCESS_CONTROL/);
  }
  assert.ok(!provisionSddl("HOST", host, app).includes(app));
  assert.match(provisionSddl("APPEND", host, app), /0x00100084/);
  assert.match(provisionSddl("APPEND", host, app), /;;;LW/);
  for (const kind of securityKinds.filter((k) => k !== "APPEND"))
    assert.match(provisionSddl(kind, host, app), /;;;ME/);
});
test("PROVISION-03 memory receipt binds run/request/kinds/exact templates", () => {
  const r = inspection();
  assert.deepEqual(parseProvisionInspection(wire(r), id), r);
  for (const changed of [
    { ...r, runId: id.replace("7dba", "7dbb") },
    { ...r, requestSha256: other },
    { ...r, hostSid: host.replace("1001", "1002") },
    { ...r, appSid: app.replace("-7", "-8") },
    { ...r, descriptors: [...r.descriptors].reverse() },
    { ...r, osChangesApplied: true },
    { ...r, osIsolationVerified: true },
    { ...r, profileExistence: "EXISTS" },
    { ...r, approved: true },
  ])
    assert.throws(() => parseProvisionInspection(wire(changed), id));
});
test("PROVISION-04 noncanonical/malformed/large receipt rejected", () => {
  const valid = wire(inspection());
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(8193),
    Buffer.from([255]),
    Buffer.concat([Buffer.from([239, 187, 191]), valid]),
    Buffer.concat([valid, valid]),
    Buffer.from(
      valid
        .toString()
        .replace(
          '"osChangesApplied":false',
          '"osChangesApplied":false,"osChangesApplied":false',
        ),
    ),
    Buffer.from(valid.toString().replaceAll("\n", "\r\n")),
    Buffer.from(valid.toString().trim()),
  ])
    assert.throws(() => parseProvisionInspection(bytes, id));
});
test("PROVISION-05 full target plan is closed and all future objects unresolved", () => {
  const p = plan();
  assert.equal(p.targets.length, 16);
  assert.equal(new Set(p.targets.map((t) => t.path)).size, 16);
  assert.equal(p.profile.storagePath, null);
  assert.equal(p.profile.creationReceipt, null);
  assert.equal(p.approval.executionAllowed, false);
  assert.equal(p.approval.osMutationBackend, "ABSENT");
  assert.deepEqual(p.absentTargets, [
    "private/create.txt",
    "private/renamed.txt",
  ]);
  for (const t of p.targets) {
    assert.equal(t.currentSecurity, null);
    assert.equal(t.currentObjectId, null);
    assert.equal(t.effectiveAccessVerified, false);
    assert.ok(t.path.startsWith(p.proposedRunRoot));
    assert.equal(t.initialSddl, provisionSddl("HOST", host, app));
  }
  assert.equal(
    p.targets.find((t) => t.relativePath === "profile")?.kind,
    "HOST",
  );
  assert.equal(
    p.targets.find((t) => t.relativePath === "scratch/write.txt")?.kind,
    "APPEND",
  );
  assert.equal(provisionTargets.length, 16);
});
test("PROVISION-06 manifest edits cannot authorize or replace paths even with recomputed hash", () => {
  const p = plan();
  const bytes = Buffer.from(probeJson(p));
  assert.deepEqual(validateProvisionPlan(bytes, launchSha256(bytes), p), p);
  for (const mutate of [
    (v: ReturnType<typeof plan>) => ({ ...v, proposedRunRoot: "C:\\Users" }),
    (v: ReturnType<typeof plan>) => ({ ...v, targets: v.targets.slice(1) }),
    (v: ReturnType<typeof plan>) => ({
      ...v,
      approval: { ...v.approval, executionAllowed: true },
    }),
    (v: ReturnType<typeof plan>) => ({
      ...v,
      profile: { ...v.profile, storagePath: "C:\\Users" },
    }),
  ]) {
    const wire = Buffer.from(probeJson(mutate(p)));
    assert.throws(() => validateProvisionPlan(wire, launchSha256(wire), p));
  }
  assert.throws(() => validateProvisionPlan(bytes, other, p));
});
test("PROVISION-07 only prepare/check fixed identities; mutations rejected", () => {
  assert.equal(
    parseProvisionCommand(["prepare", id, hash, id, other]).action,
    "prepare",
  );
  assert.equal(parseProvisionCommand(["check", id, hash]).action, "check");
  for (const args of [
    [],
    ["approve", id, hash],
    ["execute", id, hash],
    ["rollback", id, hash],
    ["setup"],
    ["check", id, hash, "--apply"],
    ["prepare", "C:\\bad.exe", hash, id, hash],
  ])
    assert.throws(() => parseProvisionCommand(args));
});
test("RECOVERY-01 reverse explicit ACL actions before owned profile removal", () => {
  const { p, j, o } = model();
  const r = planProvisionRecovery(p, j, o);
  assert.equal(r.status, "MODEL_RECOVERY_READY");
  assert.equal(r.executionAllowed, false);
  assert.equal(r.osRecoveryVerified, false);
  const changed = [...j.entries]
    .reverse()
    .filter((e) => e.beforeSecuritySha256 !== e.appliedSecuritySha256)
    .map((e) => e.relativePath);
  assert.deepEqual(
    r.actions
      .filter((a) => a.kind === "RESTORE_SECURITY")
      .map((a) => a.relativePath),
    changed,
  );
  assert.equal(r.actions.at(-1)?.kind, "DELETE_OWNED_MODEL_PROFILE");
});
test("RECOVERY-02 normal, repeated, immutable model recovery", () => {
  const { p, j, o } = model(),
    before = structuredClone({ p, j, o });
  const result = simulateProvisionRecovery(p, j, o);
  assert.equal(result.status, "MODEL_RECOVERED");
  assert.equal(result.osRecoveryVerified, false);
  assert.equal(
    planProvisionRecovery(p, j, result.after).status,
    "MODEL_NO_CHANGES",
  );
  assert.deepEqual({ p, j, o }, before);
  assert.equal(
    simulateProvisionRecovery(p, j, result.after).completed.length,
    0,
  );
});
test("RECOVERY-03 every before/after action failure retains partial state, explicit retry can verify", () => {
  const { p, j, o } = model();
  const actions = planProvisionRecovery(p, j, o).actions;
  for (let i = 0; i < actions.length; i++)
    for (const timing of ["BEFORE", "AFTER"] as const) {
      const partial = simulateProvisionRecovery(p, j, o, i, timing);
      assert.equal(partial.status, "MODEL_RECOVERY_PARTIAL");
      assert.equal(partial.completed.length, i + (timing === "AFTER" ? 1 : 0));
      const retry = simulateProvisionRecovery(p, j, partial.after);
      assert.equal(retry.status, "MODEL_RECOVERED");
    }
});
test("RECOVERY-04 live or unknown process prevents every restore/delete", () => {
  for (const processState of ["RUNNING", "UNKNOWN"] as const) {
    const { p, j, o } = model();
    o.processState = processState;
    const r = planProvisionRecovery(p, j, o);
    assert.equal(r.status, "MODEL_RECOVERY_HOLD");
    assert.deepEqual(r.actions, []);
  }
});
test("RECOVERY-05 no ownership from matching name or uncertain creation/deletion", () => {
  for (const state of [
    "CREATE_STARTED",
    "ALREADY_EXISTS",
    "FAILED_UNCERTAIN",
    "DELETE_STARTED",
  ] as const) {
    const { p, j, o } = model();
    j.profile = state;
    assert.equal(planProvisionRecovery(p, j, o).status, "MODEL_RECOVERY_HOLD");
  }
  for (const value of [
    null,
    {
      runId: id,
      name: plan().profile.name,
      sid: app,
      storageIdentity: "MODEL_STORAGE:other",
      creationResult: "CREATED_NEW",
    },
  ]) {
    const { p, j, o } = model();
    assert.equal(
      planProvisionRecovery(p, { ...j, creationReceipt: value }, o).status,
      "MODEL_RECOVERY_HOLD",
    );
  }
});
test("RECOVERY-06 missing/duplicate/reordered/outside entries rejected before actions", () => {
  const { p, j, o } = model();
  for (const changed of [
    { ...j, entries: j.entries.slice(1) },
    { ...j, entries: [...j.entries].reverse() },
    {
      ...j,
      entries: [
        { ...j.entries[0], relativePath: "../outside" },
        ...j.entries.slice(1),
      ],
    },
    {
      ...j,
      entries: [
        j.entries[0],
        { ...j.entries[1], objectId: j.entries[0]!.objectId },
        ...j.entries.slice(2),
      ],
    },
  ])
    assert.equal(
      planProvisionRecovery(p, changed, o).status,
      "MODEL_RECOVERY_HOLD",
    );
  assert.equal(
    planProvisionRecovery(p, j, { ...o, objects: o.objects.slice(1) }).status,
    "MODEL_RECOVERY_HOLD",
  );
});
test("RECOVERY-07 current object/ACL/link conflict holds entire recovery; no overwrite", () => {
  for (const patch of [
    { objectId: other },
    { securitySha256: other },
    { linksVerified: false },
  ]) {
    const { p, j, o } = model();
    o.objects[0] = { ...o.objects[0]!, ...patch };
    const r = planProvisionRecovery(p, j, o);
    assert.equal(r.status, "MODEL_RECOVERY_HOLD");
    assert.deepEqual(r.actions, []);
  }
});
test("RECOVERY-08 corrupt ownership/baseline/manifest evidence rejected", () => {
  const { p, j, o } = model();
  for (const patch of [
    { createdByRunId: id.replace("7dba", "7dbb") },
    { beforeSecuritySha256: other },
    { appliedSecuritySha256: other },
  ])
    assert.equal(
      planProvisionRecovery(
        p,
        {
          ...j,
          entries: [{ ...j.entries[0], ...patch }, ...j.entries.slice(1)],
        },
        o,
      ).status,
      "MODEL_RECOVERY_HOLD",
    );
  for (const patch of [
    { mode: "REAL" },
    { planSha256: other },
    { executionAllowed: true },
    { runId: id.replace("7dba", "7dbb") },
  ])
    assert.equal(
      planProvisionRecovery(p, { ...j, ...patch }, o).status,
      "MODEL_RECOVERY_HOLD",
    );
});
test("RECOVERY-09 apply-start journal can reconcile before/after; unlogged or restored mutation conflicts", () => {
  for (const phase of ["RECORDED", "RESTORED"] as const) {
    const { p, j, o } = model();
    j.entries[0]!.phase = phase;
    assert.equal(planProvisionRecovery(p, j, o).status, "MODEL_RECOVERY_HOLD");
    o.objects[0]!.securitySha256 = j.entries[0]!.beforeSecuritySha256;
    assert.equal(planProvisionRecovery(p, j, o).status, "MODEL_RECOVERY_READY");
  }
  const { p, j, o } = model();
  j.entries[0]!.phase = "APPLY_STARTED";
  assert.equal(planProvisionRecovery(p, j, o).status, "MODEL_RECOVERY_READY");
});
test("RECOVERY-10 profile identity/handles and absence verification required", () => {
  for (const patch of [
    { status: "OTHER" },
    { status: "UNKNOWN" },
    { name: "other" },
    { sid: host },
    { storageIdentity: "other" },
    { handlesClosed: false },
    { status: "ABSENT_VERIFIED" },
  ]) {
    const { p, j, o } = model();
    assert.equal(
      planProvisionRecovery(p, j, { ...o, profile: { ...o.profile, ...patch } })
        .status,
      "MODEL_RECOVERY_HOLD",
    );
  }
  const { p, j, o } = model();
  const r = simulateProvisionRecovery(p, j, o, null, "BEFORE", false);
  assert.equal(r.status, "MODEL_RECOVERY_PARTIAL");
  assert.equal(r.after.profile.status, "OWNED_VERIFIED");
});
test("RECOVERY-11 empty untouched model is no change, reused or unowned profile is held", () => {
  const { p, j, o } = model();
  j.entries = [];
  j.profile = "NOT_ATTEMPTED";
  j.creationReceipt = null;
  o.objects = [];
  o.processState = "NEVER_STARTED";
  o.profile = {
    status: "ABSENT_VERIFIED",
    name: null,
    sid: null,
    storageIdentity: null,
    handlesClosed: true,
  };
  assert.equal(planProvisionRecovery(p, j, o).status, "MODEL_NO_CHANGES");
  o.profile.status = "OWNED_VERIFIED";
  assert.equal(planProvisionRecovery(p, j, o).status, "MODEL_RECOVERY_HOLD");
});
test("RECOVERY-12 incomplete/invalid inputs remain held, never real recovery", () => {
  const { p, j, o } = model();
  for (const bad of [null, {}, [], { ...j, entries: [null] }])
    assert.equal(
      planProvisionRecovery(p, bad, o).status,
      "MODEL_RECOVERY_HOLD",
    );
  assert.equal(
    planProvisionRecovery(p, j, { ...o, extra: true }).status,
    "MODEL_RECOVERY_HOLD",
  );
  assert.throws(() => simulateProvisionRecovery(p, j, o, -1));
  assert.throws(() => simulateProvisionRecovery(p, j, o, 1.5));
});

test("RECOVERY-13 contradictory absent/unattempted profile cannot authorize restore", () => {
  const { p, j, o } = model();
  j.profile = "NOT_ATTEMPTED";
  j.creationReceipt = null;
  o.profile = {
    status: "ABSENT_VERIFIED",
    name: null,
    sid: null,
    storageIdentity: null,
    handlesClosed: true,
  };
  assert.equal(planProvisionRecovery(p, j, o).status, "MODEL_RECOVERY_HOLD");
  j.entries = [];
  o.objects = [];
  for (const patch of [
    { name: "retained" },
    { sid: app },
    { storageIdentity: "retained" },
    { handlesClosed: false },
  ]) {
    assert.equal(
      planProvisionRecovery(p, j, { ...o, profile: { ...o.profile, ...patch } })
        .status,
      "MODEL_RECOVERY_HOLD",
    );
  }
});
