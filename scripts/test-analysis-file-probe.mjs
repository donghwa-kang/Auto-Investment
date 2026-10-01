import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyProbe,
  expectedProbeSnapshot,
  parseProbeReceipt,
  probeCases,
  probeJson,
  probeRequest,
  probeSourceFiles,
  probeTargets,
} from "../dist/runtime/src/core/analysis-file-probe.js";
import {
  launchHashSchema,
  launchRunIdSchema,
} from "../dist/runtime/src/core/analysis-launch-plan.js";
import {
  checkFileProbeBuild,
  createProbeFixture,
  exerciseProbeFixture,
  snapshotProbeFixture,
  validateProbeFixture,
} from "../dist/runtime/src/server/analysis-file-probe-files.js";

if (process.argv.length !== 4) throw new Error("BUILD_ID_AND_HASH_REQUIRED");
const buildId = launchRunIdSchema.parse(process.argv[2]),
  buildSha = launchHashSchema.parse(process.argv[3]);
const workspace = fileURLToPath(new URL("../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const build = checkFileProbeBuild(workspace, buildId, buildSha);
const directory = mkdtempSync(join(workspace, "work", "fp-test-"));
const results = [];
const report = () => ({
  scope: "UNRESTRICTED_FILE_PROBE_AND_MODEL_ONLY",
  buildId,
  buildSha256: buildSha,
  results,
  passed: results.length > 0 && results.every((r) => r.passed),
  osIsolationVerified: false,
});
async function check(name, action) {
  const start = performance.now();
  try {
    await action();
    results.push({
      name,
      passed: true,
      elapsedMs: Math.round(performance.now() - start),
    });
  } catch (error) {
    results.push({
      name,
      passed: false,
      elapsedMs: Math.round(performance.now() - start),
      error: String(error),
    });
  }
  writeFileSync(join(directory, "report.json"), probeJson(report()));
  console.log(JSON.stringify(results.at(-1)));
}
function fixture(caseId = "ALLOW_READ") {
  return createProbeFixture(workspace, caseId, buildId, buildSha);
}
async function direct(
  f,
  {
    program = "probe",
    args = ["--probe"],
    input = probeRequest(f.runId, f.caseId, f.manifestSha),
    cwd = f.root,
    hold = false,
  } = {},
) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      join(build.directory, build.build.artifacts[program].file),
      args,
      {
        cwd,
        shell: false,
        windowsHide: true,
        env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout = [],
      stderr = [];
    let total = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("TEST_TIMEOUT"));
    }, 8000);
    const collect = (into) => (bytes) => {
      total += bytes.length;
      if (total > 8192) {
        child.kill();
        reject(new Error("TEST_OUTPUT_LIMIT"));
      } else into.push(bytes);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    if (hold) child.stdin.write(input);
    else child.stdin.end(input);
  });
}
function acceptedReceipt(result, f) {
  assert.equal(result.code, 0);
  assert.equal(result.stderr.length, 0);
  assert.equal(result.signal, null);
  return parseProbeReceipt(
    result.stdout,
    f.runId,
    f.caseId,
    probeRequest(f.runId, f.caseId, f.manifestSha),
  );
}
for (const caseId of probeCases)
  await check(
    `actual ${caseId}: exact file operation and host pre/post comparison`,
    async () => {
      const f = fixture(caseId),
        r = await exerciseProbeFixture(workspace, f);
      assert.deepEqual(
        r.after,
        expectedProbeSnapshot(r.before, f.runId, caseId),
      );
      assert.equal(
        r.classification,
        caseId.startsWith("ALLOW_") ? "ALLOW_OBSERVED" : "EXPOSURE_DETECTED",
      );
      assert.equal(r.receipt.attempted, true);
      assert.notEqual(r.receipt.outcome, "ERROR");
      assert.equal(r.receipt.osIsolationVerified, false);
    },
  );
await check(
  "actual controller runs 23 lifecycle model cases; linked Win32 backend remains locked",
  async () => {
    const f = fixture(),
      r = await direct(f, {
        program: "controller",
        args: ["--self-test"],
        input: Buffer.alloc(0),
      });
    assert.equal(r.code, 0);
    assert.equal(r.stderr.length, 0);
    assert.deepEqual(JSON.parse(r.stdout), {
      status: "LIFECYCLE_MODEL_TESTS_PASSED",
      checks: 23,
      backend: "MODEL",
      win32StepsExecuted: 0,
      executionAllowed: false,
      osIsolationVerified: false,
    });
  },
);
for (const program of ["probe", "controller"])
  for (const args of [
    [],
    ["--execute"],
    ["--setup"],
    ["--approve"],
    [program === "probe" ? "--probe" : "--self-test", "--execute"],
  ])
    await check(
      `${program} rejects unsupported arguments ${JSON.stringify(args)}`,
      async () => {
        const f = fixture();
        const before = snapshotProbeFixture(f);
        const r = await direct(f, { program, args });
        assert.equal(r.code, 2);
        assert.equal(r.stdout.length, 0);
        assert.equal(r.stderr.length, 0);
        assert.deepEqual(snapshotProbeFixture(f), before);
      },
    );
const invalidFrame = fixture();
const frame = probeRequest(
  invalidFrame.runId,
  invalidFrame.caseId,
  invalidFrame.manifestSha,
);
for (const [name, input] of Object.entries({
  empty: Buffer.alloc(0),
  oversize: Buffer.alloc(385),
  bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), frame]),
  utf8: Buffer.from([0xff]),
  extra: Buffer.concat([frame, frame]),
  tail: Buffer.concat([frame, Buffer.from("x")]),
  truncated: frame.subarray(0, -1),
  crlf: Buffer.from(frame.toString().replaceAll("\n", "\r\n")),
  path_case: Buffer.from(frame.toString().replace("ALLOW_READ", "C:\\other")),
  grant: Buffer.from(
    frame.toString().replace("NO_OS_ATTESTATION", "OS_APPROVED"),
  ),
  upper_hash: Buffer.from(
    frame
      .toString()
      .replace(
        invalidFrame.manifestSha,
        invalidFrame.manifestSha.toUpperCase(),
      ),
  ),
}))
  await check(
    `native rejects ${name} frame without filesystem change`,
    async () => {
      const before = snapshotProbeFixture(invalidFrame);
      const r = await direct(invalidFrame, { input });
      assert.equal(r.code, 3);
      assert.equal(r.stdout.length, 0);
      assert.equal(r.stderr.length, 0);
      assert.deepEqual(snapshotProbeFixture(invalidFrame), before);
    },
  );
await check(
  "native valid frame without EOF expires before any file operation",
  async () => {
    const f = fixture("DENY_DELETE"),
      before = snapshotProbeFixture(f);
    const start = performance.now();
    const r = await direct(f, { hold: true });
    assert.equal(r.code, 3);
    assert.equal(r.stdout.length, 0);
    assert.ok(performance.now() - start >= 4900);
    assert.deepEqual(snapshotProbeFixture(f), before);
  },
);
await check(
  "native invalid cwd reports precondition, never access denial",
  async () => {
    const f = fixture(),
      r = acceptedReceipt(await direct(f, { cwd: directory }), f);
    assert.equal(r.attempted, false);
    assert.equal(r.stage, "PREFLIGHT");
    assert.equal(r.outcome, "ERROR");
  },
);
await check("native mutated marker fails before target operation", async () => {
  const f = fixture("DENY_DELETE");
  writeFileSync(join(f.root, "fixture-marker.txt"), "NOT_A_VALID_MARKER");
  const before = snapshotProbeFixture(f),
    r = acceptedReceipt(await direct(f), f);
  assert.equal(r.attempted, false);
  assert.equal(r.stage, "PREFLIGHT");
  assert.deepEqual(snapshotProbeFixture(f), before);
});
await check(
  "native oversized read reports FILE_TOO_LARGE, not stale access denied",
  async () => {
    const f = fixture();
    writeFileSync(join(f.root, probeTargets[f.caseId]), Buffer.alloc(4097, 65));
    const r = acceptedReceipt(await direct(f), f);
    assert.equal(r.attempted, true);
    assert.equal(r.outcome, "ERROR");
    assert.equal(r.stage, "IO");
    assert.equal(r.win32Error, 223);
  },
);
await check("native write-only append makes no preliminary data read", () => {
  // Complementary source contract check; actual write-only ACL denial is not tested here.
  const source = readFileSync(
    join(workspace, "src/native/analysis-file-probe.cpp"),
    "utf8",
  );
  assert.match(source, /append \? FILE_APPEND_DATA/);
  assert.match(source, /else if \(append \|\| create\)/);
});
await check(
  "native refuses existing create destination without replacing it",
  async () => {
    const f = fixture("DENY_CREATE"),
      path = join(f.root, "private/create.txt");
    writeFileSync(path, "EXISTING_DUMMY_ONLY", { flag: "wx" });
    const before = snapshotProbeFixture(f),
      r = acceptedReceipt(await direct(f), f);
    assert.equal(r.outcome, "ERROR");
    assert.equal(r.stage, "OPEN");
    assert.equal(r.win32Error, 80);
    assert.deepEqual(snapshotProbeFixture(f), before);
  },
);
await check(
  "native rename refuses destination replacement and preserves both dummy files",
  async () => {
    const f = fixture("DENY_RENAME"),
      path = join(f.root, "private/renamed.txt");
    writeFileSync(path, "EXISTING_DUMMY_ONLY", { flag: "wx" });
    const before = snapshotProbeFixture(f),
      r = acceptedReceipt(await direct(f), f);
    assert.equal(r.outcome, "ERROR");
    assert.equal(r.stage, "IO");
    assert.notEqual(r.win32Error, 0);
    assert.deepEqual(snapshotProbeFixture(f), before);
  },
);
await check(
  "native hardlinked append target is opened but guarded before mutation",
  async () => {
    const f = fixture("DENY_APPEND"),
      target = join(f.root, "private/append.txt");
    linkSync(target, join(directory, "hardlink-canary.txt"));
    const before = readFileSync(target),
      r = acceptedReceipt(await direct(f), f);
    assert.equal(r.attempted, true);
    assert.equal(r.stage, "GUARD");
    assert.equal(r.outcome, "ERROR");
    assert.deepEqual(readFileSync(target), before);
  },
);
await check("host rejects hardlink before spawning worker", async () => {
  const f = fixture(),
    target = join(f.root, "input/allow.txt");
  linkSync(target, join(directory, "hardlink-input.txt"));
  await assert.rejects(() => exerciseProbeFixture(workspace, f));
});
await check(
  "host refuses changed fixture manifest/content and fake root binding",
  () => {
    for (const file of [
      "manifest.json",
      "fixture-marker.txt",
      "private/read.txt",
    ]) {
      const f = fixture();
      writeFileSync(join(f.root, file), "CHANGED_DUMMY");
      assert.throws(() => validateProbeFixture(workspace, f));
    }
    const f = fixture();
    assert.throws(() =>
      validateProbeFixture(workspace, { ...f, root: directory }),
    );
  },
);
await check("host refuses extra fixture files", () => {
  const f = fixture();
  writeFileSync(join(f.root, "private", "unexpected.txt"), "DUMMY");
  assert.throws(() => validateProbeFixture(workspace, f));
});

await check(
  "native missing target is FILE_NOT_FOUND, never an access-denial pass",
  async () => {
    const f = fixture("DENY_READ");
    validateProbeFixture(workspace, f);
    renameSync(
      join(f.root, "private/read.txt"),
      join(directory, "missing-read-retained.txt"),
    );
    const before = snapshotProbeFixture(f);
    const r = acceptedReceipt(await direct(f), f);
    assert.equal(r.attempted, true);
    assert.equal(r.stage, "OPEN");
    assert.equal(r.win32Error, 2);
    assert.equal(
      classifyProbe(r, before, snapshotProbeFixture(f), f.runId),
      "INCONCLUSIVE",
    );
  },
);
function copiedBuild() {
  const root = mkdtempSync(join(directory, "w-"));
  for (const file of Object.values(probeSourceFiles)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(workspace, file), join(root, file));
  }
  const target = join(root, "work", "analysis-file-build", `build-${buildId}`);
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(build.directory))
    copyFileSync(join(build.directory, file), join(target, file));
  return { root, target };
}
await check("copied build validates current sources and artifacts", () => {
  const f = copiedBuild();
  assert.equal(
    checkFileProbeBuild(f.root, buildId, buildSha).build.osExecutionAllowed,
    false,
  );
});
for (const file of [
  "analysis-file-probe.exe",
  "analysis-isolation-controller.exe",
  "build.json",
  "commands.txt",
  "probe-imports.txt",
  "controller-loadconfig.txt",
])
  await check(`host rejects modified build artifact ${file}`, () => {
    const f = copiedBuild();
    writeFileSync(join(f.target, file), "TAMPERED_TEST_COPY");
    assert.throws(() => checkFileProbeBuild(f.root, buildId, buildSha));
  });
await check("host rejects changed current native source", () => {
  const f = copiedBuild();
  writeFileSync(join(f.root, probeSourceFiles.backend), "MODIFIED_COPY");
  assert.throws(() => checkFileProbeBuild(f.root, buildId, buildSha));
});
await check("host rejects extra DLL and build-parent junction", () => {
  const f = copiedBuild();
  writeFileSync(join(f.target, "unapproved.dll"), "NOT_A_DLL");
  assert.throws(() => checkFileProbeBuild(f.root, buildId, buildSha));
  const root = mkdtempSync(join(directory, "j-"));
  mkdirSync(join(root, "work"));
  symlinkSync(
    dirname(f.target),
    join(root, "work/analysis-file-build"),
    "junction",
  );
  assert.throws(() => checkFileProbeBuild(root, buildId, buildSha));
});
await check(
  "native PE inspection shows CFG and linked Win32 APIs, not executed restrictions",
  () => {
    for (const program of ["probe", "controller"]) {
      const config = readFileSync(
        join(build.directory, `${program}-loadconfig.txt`),
        "utf8",
      );
      assert.match(config, /CF instrumented/);
      assert.match(config, /FID table present/);
    }
    const imports = readFileSync(
      join(build.directory, "controller-imports.txt"),
      "utf8",
    );
    for (const api of [
      "CreateJobObjectW",
      "CreateProcessW",
      "GetTokenInformation",
      "ResumeThread",
      "TerminateJobObject",
    ])
      assert.ok(imports.includes(api));
    assert.ok(!imports.includes("CreateAppContainerProfile"));
    assert.ok(!imports.includes("SetNamedSecurityInfo"));
  },
);
await check(
  "actual CLI rejects execute/setup/extra flags without creating fixtures",
  () => {
    const path = join(workspace, "work", "analysis-file-lab");
    const before = readdirSync(path);
    for (const args of [
      ["execute", buildId, buildSha],
      ["setup", buildId, buildSha],
      ["self-test", buildId, buildSha, "--execute"],
    ]) {
      const r = spawnSync(
        process.execPath,
        [
          join(workspace, "dist/runtime/src/server/analysis-file-probe-cli.js"),
          ...args,
        ],
        {
          cwd: directory,
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 8192,
        },
      );
      assert.equal(r.error, undefined);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr.trim(), "FILE_PROBE_SELF_TEST_REJECTED");
    }
    assert.deepEqual(readdirSync(path), before);
  },
);
await check("actual fixed build script rejects extra arguments", () => {
  const parent = dirname(build.directory),
    before = readdirSync(parent);
  const r = spawnSync(
    process.execPath,
    [join(workspace, "scripts/build-analysis-file-probe.mjs"), "--execute"],
    {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8192,
    },
  );
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.deepEqual(readdirSync(parent), before);
});
await check(
  "fixture-parent junction is rejected before any fixture write",
  () => {
    const f = copiedBuild();
    const destination = join(directory, "junction-target");
    mkdirSync(destination);
    symlinkSync(
      destination,
      join(f.root, "work/analysis-file-lab"),
      "junction",
    );
    assert.throws(() =>
      createProbeFixture(f.root, "ALLOW_READ", buildId, buildSha),
    );
    assert.deepEqual(readdirSync(destination), []);
  },
);
await check(
  "original build remains unchanged and no OS run directory was created",
  () => {
    checkFileProbeBuild(workspace, buildId, buildSha);
    for (const entry of results) assert.equal(typeof entry.passed, "boolean");
    assert.equal(
      existsSync(
        join(workspace, "work", "analysis-os-lab", `run-${invalidFrame.runId}`),
      ),
      false,
    );
  },
);
console.log(
  JSON.stringify({
    reportPath: join(directory, "report.json"),
    checks: results.length,
    passed: report().passed,
    modelChecksIncluded: 23,
  }),
);
if (!report().passed) process.exitCode = 1;
