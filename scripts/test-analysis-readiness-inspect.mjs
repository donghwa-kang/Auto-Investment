import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectReadiness,
  checkReadinessReport,
  checkReadinessBuild,
} from "../dist/runtime/src/server/analysis-readiness-files.js";
import { checkProvision } from "../dist/runtime/src/server/analysis-provision-files.js";
import { createBridgeFixture } from "../dist/runtime/src/server/analysis-permission-bridge-files.js";
import {
  parseReadinessResult,
  readinessRequest,
  readinessSummary,
  readinessProcessSchema,
} from "../dist/runtime/src/core/analysis-readiness-inspect.js";
import { launchSha256 } from "../dist/runtime/src/core/analysis-launch-plan.js";

if (process.argv.length !== 8)
  throw new Error("RUN_PLAN_BRIDGE_HASH_INSPECT_HASH_REQUIRED");
const args = process.argv.slice(2),
  [runId, planHash, bridgeId, bridgeHash, buildId, buildHash] = args;
const workspace = fileURLToPath(new URL("../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const directory = join(workspace, "work", `readiness-tests-${randomUUID()}`);
mkdirSync(directory);
const report = {
  scope: "READ_ONLY_INITIAL_SECURITY_AND_OWNED_CHILD_EXIT",
  passed: false,
  checks: [],
  sample: null,
  processSelfTest: null,
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
      error: String(e.message).slice(0, 160),
    });
    save();
    throw new Error(`READINESS_TEST_FAILED: ${name}`);
  }
  save();
};
const review = checkProvision(workspace, runId, planHash),
  plan = JSON.parse(readFileSync(review.manifestPath));
const { executable } = checkReadinessBuild(workspace, buildId, buildHash);
const native = (mode, input = "") =>
  spawnSync(executable, [mode], {
    cwd: workspace,
    input,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 16000,
    maxBuffer: 300000,
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
  });
const cli = (a) =>
  spawnSync(
    process.execPath,
    ["dist/runtime/src/server/analysis-readiness-cli.js", ...a],
    {
      cwd: workspace,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 40000,
      maxBuffer: 300000,
    },
  );
let sample, wire, binding, created, request, observed;
await test("collect 16 real descriptors and keep all execution gates closed", async () => {
  sample = await collectReadiness(workspace, ...args);
  report.sample = sample;
  assert.equal(sample.status, "READ_ONLY_RECORDED_HOLD");
  assert.equal(sample.observedFiles, 16);
  assert.equal(sample.executionAllowed, false);
  assert.equal(sample.osChangesApplied, false);
  assert.equal(sample.osIsolationVerified, false);
  const folder = join(
    workspace,
    "work/analysis-readiness-lab",
    `report-${sample.reportId}`,
  );
  wire = readFileSync(join(folder, "observation.json"));
  binding = JSON.parse(readFileSync(join(folder, "binding.json")));
  created = JSON.parse(
    readFileSync(
      join(
        workspace,
        "work/analysis-permission-bridge-lab",
        `lab-${binding.fixtureId}`,
        "created.json",
      ),
    ),
  );
  request = readinessRequest(
    binding.fixtureId,
    plan,
    created.nodeIds[0],
    binding.nonce,
  );
  observed = parseReadinessResult(wire, request, plan, created.nodeIds);
  report.observationSummary = {
    saclErrors: observed.observation.files.map((f) => f.saclError),
    profileHresult: observed.observation.profile.hresult,
    baseDescriptorBytes: observed.observation.files.map(
      (f) => f.base.hex.length / 2,
    ),
  };
});
await test("anchored historical report check", () =>
  assert.equal(
    checkReadinessReport(
      workspace,
      sample.reportId,
      sample.bindingSha256,
      sample.observationSha256,
    ).processExitConfirmed,
    true,
  ));
await test("normal, nonzero, early exit claim require signaled creation handles", () => {
  const r = native("--process-self-test");
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  const result = JSON.parse(r.stdout);
  assert.equal(result.status, "OWNED_CHILD_TERMINATION_CHECKED");
  for (const key of ["normal", "nonzero", "earlyClaim"]) {
    const p = readinessProcessSchema.parse(result[key]);
    assert.ok(BigInt(p.exitTime) >= BigInt(p.creationTime));
  }
  assert.equal(result.normal.exitCode, 0);
  assert.equal(result.nonzero.exitCode, 7);
  assert.equal(result.earlyClaim.exitCode, 124);
  assert.equal(result.earlyClaim.forced, true);
  report.processSelfTest = result;
});
for (let n = 1; n <= 3; n++)
  await test(`repeat observation ${n}: drain output after process signal`, () => {
    const r = native("--stdio-inspect", request);
    assert.equal(r.status, 0);
    const v = parseReadinessResult(
      Buffer.from(r.stdout),
      request,
      plan,
      created.nodeIds,
    );
    assert.equal(v.observation.files.length, 16);
  });
const reject = (change) => {
  const v = structuredClone(observed);
  change(v);
  assert.throws(() =>
    parseReadinessResult(
      Buffer.from(JSON.stringify(v) + "\n"),
      request,
      plan,
      created.nodeIds,
    ),
  );
};
for (const [name, change] of [
  ["wrong nonce", (v) => (v.observation.nonce = randomUUID())],
  ["wrong request hash", (v) => (v.observation.requestSha256 = "a".repeat(64))],
  ["wrong owner hash", (v) => (v.observation.ownerSha256 = "a".repeat(64))],
  [
    "wrong profile SID hash",
    (v) => (v.observation.profile.appSidSha256 = "a".repeat(64)),
  ],
  [
    "duplicate object IDs",
    (v) => (v.observation.files[1].objectId = v.observation.files[0].objectId),
  ],
  ["wrong node ID", (v) => (v.observation.files[0].nodeId = "a".repeat(64))],
  ["wrong index", (v) => (v.observation.files[0].index = 1)],
  ["missing file", (v) => v.observation.files.pop()],
  ["extra result field", (v) => (v.allowed = true)],
  ["execution enabled", (v) => (v.executionAllowed = true)],
  ["OS mutation claim", (v) => (v.observation.osChangesApplied = true)],
  ["forced process is not normal completion", (v) => (v.process.forced = true)],
  ["nonzero process is not normal completion", (v) => (v.process.exitCode = 7)],
  ["unsignaled process", (v) => (v.process.waitSignaled = false)],
  ["exit before creation", (v) => (v.process.exitTime = "1")],
  ["arbitrary PID scope", (v) => (v.process.scope = "ANY_PID")],
  [
    "profile ownership claim",
    (v) => (v.observation.profile.ownership = "PROVEN"),
  ],
  [
    "contradictory profile path",
    (v) => (v.observation.profile.folder = "PATH_ABSENT"),
  ],
  [
    "SACL missing despite success",
    (v) => {
      v.observation.files[0].saclError = 0;
      v.observation.files[0].withSacl = null;
    },
  ],
  [
    "template match without SACL",
    (v) => {
      v.observation.files[0].withSacl = null;
      v.observation.files[0].saclError = 1314;
      v.observation.files[0].matchesPlannedInitial = true;
    },
  ],
  [
    "descriptor hash",
    (v) => (v.observation.files[0].base.sha256 = "a".repeat(64)),
  ],
  [
    "descriptor ACE metadata",
    (v) => (v.observation.files[0].base.aceCount = 65535),
  ],
])
  await test(`reject ${name}`, () => reject(change));
const badDescriptor = (edit) =>
  reject((v) => {
    const d = v.observation.files[0].base,
      b = Buffer.from(d.hex, "hex");
    edit(b);
    d.hex = b.toString("hex");
    d.sha256 = launchSha256(b);
  });
await test("reject descriptor revision", () =>
  badDescriptor((b) => (b[0] = 2)));
await test("reject descriptor owner offset", () =>
  badDescriptor((b) => b.writeUInt32LE(21, 4)));
await test("reject descriptor SID structure", () =>
  badDescriptor((b) => (b[b.readUInt32LE(4) + 1] = 16)));
await test("reject descriptor owner SID differing from plan", () =>
  badDescriptor((b) => (b[b.readUInt32LE(4) + 8] ^= 1)));
await test("reject descriptor ACE size", () =>
  badDescriptor((b) => b.writeUInt16LE(3, b.readUInt32LE(16) + 10)));
for (const [name, bytes] of [
  ["empty", Buffer.alloc(0)],
  ["oversize", Buffer.alloc(262145)],
  ["invalid UTF8", Buffer.from([255])],
  ["BOM", Buffer.concat([Buffer.from([239, 187, 191]), wire])],
  ["trailing whitespace", Buffer.concat([wire, Buffer.from(" ")])],
  [
    "duplicate JSON key",
    Buffer.from(
      wire
        .toString()
        .replace(
          '{"version":',
          '{"version":"READINESS_SUPERVISED_V1","version":',
        ),
    ),
  ],
])
  await test(`reject ${name}`, () =>
    assert.throws(() =>
      parseReadinessResult(bytes, request, plan, created.nodeIds),
    ));
await test("path absence still cannot prove registration or ownership", () => {
  const v = structuredClone(observed);
  Object.assign(v.observation.profile, {
    folder: "PATH_ABSENT",
    hresult: 0,
    win32Error: 2,
    pathSha256: "a".repeat(64),
  });
  const checked = parseReadinessResult(
      Buffer.from(JSON.stringify(v) + "\n"),
      request,
      plan,
      created.nodeIds,
    ),
    summary = readinessSummary(checked);
  assert.equal(summary.executionAllowed, false);
  assert.ok(summary.blockers.includes("PROFILE_OWNERSHIP_UNPROVEN"));
  assert.ok(summary.blockers.includes("PROFILE_REGISTRATION_UNVERIFIED"));
});
for (const [name, mutate] of [
  ["wrong root ID", (s) => s.replace(created.nodeIds[0], "a".repeat(64))],
  [
    "wrong owner",
    (s) => s.replace(launchSha256(plan.inspection.hostSid), "a".repeat(64)),
  ],
  ["noncanonical request", (s) => s + "\n"],
])
  await test(`native rejects ${name}`, () => {
    const r = native("--stdio-inspect", mutate(request));
    assert.equal(r.status, 2);
    assert.ok(!r.stdout.includes("READINESS_SUPERVISED_V1"));
  });
await test("native has no arbitrary executable or permission action", () => {
  assert.equal(native("--apply").status, 2);
  assert.equal(native("C:\\Windows\\System32\\cmd.exe").status, 2);
});
await test("native refuses modified dummy content", () => {
  const f = createBridgeFixture(workspace, plan, bridgeId, bridgeHash);
  writeFileSync(
    join(f.directory, "fixture/input/allow.txt"),
    "TEST_ONLY_TAMPER\n",
  );
  const r = native(
    "--stdio-inspect",
    readinessRequest(f.created.labId, plan, f.created.nodeIds[0], randomUUID()),
  );
  assert.equal(r.status, 2);
});
await test("wrong build anchor", () =>
  assert.throws(() => checkReadinessBuild(workspace, buildId, "a".repeat(64))));
await test("wrong report binding anchor", () =>
  assert.throws(() =>
    checkReadinessReport(
      workspace,
      sample.reportId,
      "a".repeat(64),
      sample.observationSha256,
    ),
  ));
await test("wrong observation anchor", () =>
  assert.throws(() =>
    checkReadinessReport(
      workspace,
      sample.reportId,
      sample.bindingSha256,
      "a".repeat(64),
    ),
  ));
await test("CLI historical check remains exit 2 with recorded HOLD", () => {
  const r = cli([
    "check",
    sample.reportId,
    sample.bindingSha256,
    sample.observationSha256,
  ]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).status, "READ_ONLY_RECORDED_HOLD");
  assert.equal(r.stderr, "");
});
await test("CLI extra args reject before fixture creation", () => {
  const parent = join(workspace, "work/analysis-readiness-lab"),
    before = readdirSync(parent).sort();
  const r = cli(["sample", ...args, "--apply"]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).status, "READINESS_OBSERVATION_HOLD");
  assert.deepEqual(readdirSync(parent).sort(), before);
});
await test("CLI sample is a new read-only record, never approval", () => {
  const r = cli(["sample", ...args]);
  assert.equal(r.status, 2);
  const result = JSON.parse(r.stdout);
  assert.equal(result.status, "READ_ONLY_RECORDED_HOLD");
  assert.notEqual(result.reportId, sample.reportId);
  assert.equal(result.executionAllowed, false);
});
await test("partial report never validates", () => {
  const id = randomUUID(),
    d = join(workspace, "work/analysis-readiness-lab", `report-${id}`);
  mkdirSync(d);
  writeFileSync(join(d, "binding.json"), "{}\n");
  assert.throws(() =>
    checkReadinessReport(workspace, id, "a".repeat(64), "a".repeat(64)),
  );
});
await test("report tampering detected; own test bytes restored", () => {
  const path = join(
    workspace,
    "work/analysis-readiness-lab",
    `report-${sample.reportId}`,
    "observation.json",
  );
  try {
    writeFileSync(path, Buffer.concat([wire, Buffer.from(" ")]));
    assert.throws(() =>
      checkReadinessReport(
        workspace,
        sample.reportId,
        sample.bindingSha256,
        sample.observationSha256,
      ),
    );
  } finally {
    writeFileSync(path, wire);
  }
  assert.equal(
    checkReadinessReport(
      workspace,
      sample.reportId,
      sample.bindingSha256,
      sample.observationSha256,
    ).status,
    "READ_ONLY_RECORDED_HOLD",
  );
});
await test("proposed OS run root remains absent", () =>
  assert.equal(existsSync(plan.proposedRunRoot), false));
report.passed = true;
save();
console.log(
  JSON.stringify({
    status: "READINESS_TESTS_PASSED",
    checks: report.checks.length,
    directory,
    executionAllowed: false,
    osChangesApplied: false,
  }),
);
