import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  linkSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  provisionSourceFiles,
  provisionRequest,
  parseProvisionInspection,
  securityKinds,
} from "../dist/runtime/src/core/analysis-provision.js";
import {
  checkProvisionBuild,
  prepareProvision,
  checkProvision,
} from "../dist/runtime/src/server/analysis-provision-files.js";
import {
  probeSourceFiles,
  probeJson,
} from "../dist/runtime/src/core/analysis-file-probe.js";
import { checkFileProbeBuild } from "../dist/runtime/src/server/analysis-file-probe-files.js";
import {
  launchHashSchema,
  launchRunIdSchema,
  launchSha256,
} from "../dist/runtime/src/core/analysis-launch-plan.js";
if (process.argv.length !== 6) throw new Error("FOUR_BUILD_ARGUMENTS_REQUIRED");
const [buildId, buildSha, probeBuildId, probeBuildSha] = process.argv.slice(2);
launchRunIdSchema.parse(buildId);
launchRunIdSchema.parse(probeBuildId);
launchHashSchema.parse(buildSha);
launchHashSchema.parse(probeBuildSha);
const workspace = fileURLToPath(new URL("../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const artifact = checkProvisionBuild(workspace, buildId, buildSha),
  probe = checkFileProbeBuild(workspace, probeBuildId, probeBuildSha);
const directory = mkdtempSync(join(workspace, "work", "provision-test-")),
  results = [];
const report = {
  scope: "MEMORY_DESCRIPTORS_AND_MODEL_ONLY_NOT_OS_MUTATION",
  buildId,
  buildSha,
  probeBuildId,
  probeBuildSha,
  results,
  passed: false,
};
function save() {
  writeFileSync(join(directory, "report.json"), probeJson(report));
}
async function test(name, run) {
  try {
    await run();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({
      name,
      passed: false,
      error:
        error instanceof assert.AssertionError ? error.code : "CHECK_FAILED",
    });
    save();
    throw error;
  }
}
const exe = join(artifact.directory, artifact.build.artifact.file);
const invoke = (args, input = Buffer.alloc(0), cwd = artifact.directory) =>
  spawnSync(exe, args, {
    input,
    cwd,
    encoding: null,
    shell: false,
    windowsHide: true,
    timeout: 7000,
    maxBuffer: 8192,
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
  });
const valid = (r) => {
  assert.equal(r.status, 0);
  assert.equal(r.stderr.length, 0);
  assert.equal(r.error, undefined);
};
const requestId = randomUUID();
await test("49 actual Windows in-memory descriptor structural/negative checks", () => {
  const r = invoke(["--self-test"]);
  valid(r);
  assert.deepEqual(JSON.parse(r.stdout), {
    status: "SECURITY_MEMORY_TESTS_PASSED",
    checks: 49,
    osChangesApplied: false,
    osIsolationVerified: false,
  });
});
await test("actual inspect: current token SID, derived SID and five validated templates only", () => {
  const r = invoke(["--inspect"], provisionRequest(requestId));
  valid(r);
  const data = parseProvisionInspection(r.stdout, requestId);
  assert.equal(data.descriptors.length, securityKinds.length);
  assert.equal(data.profileExistence, "NOT_QUERIED");
  assert.equal(data.osChangesApplied, false);
});
await test("SID derivation and memory descriptors repeat deterministically without profile creation", () => {
  const a = invoke(["--inspect"], provisionRequest(requestId)),
    b = invoke(["--inspect"], provisionRequest(requestId));
  valid(a);
  valid(b);
  assert.deepEqual(a.stdout, b.stdout);
});
for (const args of [
  [],
  ["execute"],
  ["--apply"],
  ["--rollback"],
  ["--inspect", "--approve"],
  ["--self-test", "extra"],
])
  await test(`native rejects unsupported arguments ${JSON.stringify(args)}`, () => {
    const r = invoke(args, provisionRequest(requestId));
    assert.equal(r.status, 2);
    assert.equal(r.stdout.length, 0);
  });
const good = provisionRequest(requestId);
for (const [name, input] of [
  ["empty", Buffer.alloc(0)],
  ["too large", Buffer.alloc(385, 65)],
  ["invalid utf8", Buffer.from([255])],
  ["BOM", Buffer.concat([Buffer.from([239, 187, 191]), good])],
  ["CRLF", Buffer.from(good.toString().replaceAll("\n", "\r\n"))],
  [
    "bad UUID",
    Buffer.from(good.toString().replace(requestId, requestId.toUpperCase())),
  ],
  ["extra frame", Buffer.concat([good, good])],
  [
    "wrong version",
    Buffer.from(
      good.toString().replace("PROVISION_INSPECT_V1", "PROVISION_APPLY_V1"),
    ),
  ],
  ["missing END", good.subarray(0, good.length - 5)],
  ["NUL", Buffer.from(good.toString().replace("END", "E\0D"))],
])
  await test(`native rejects ${name}`, () => {
    const r = invoke(["--inspect"], input);
    assert.equal(r.status, 3);
    assert.equal(r.stdout.length, 0);
  });
await test("native refuses closed non-pipe stdout", () => {
  const r = spawnSync(exe, ["--inspect"], {
    input: good,
    stdio: ["pipe", "ignore", "pipe"],
    shell: false,
    windowsHide: true,
    timeout: 7000,
  });
  assert.equal(r.status, 3);
});
await test("native requires EOF, deadline failure before inspection", async () => {
  const start = Date.now();
  const r = await new Promise((resolve, reject) => {
    const c = spawn(exe, ["--inspect"], {
      cwd: artifact.directory,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
    });
    let output = 0;
    const t = setTimeout(() => {
      c.kill();
      reject(new Error("PARENT_DEADLINE"));
    }, 7000);
    c.stdout.on("data", (b) => {
      output += b.length;
    });
    c.stderr.on("data", () => {
      c.kill();
      reject(new Error("STDERR"));
    });
    c.stdin.on("error", () => {});
    c.on("error", reject);
    c.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, output });
    });
    c.stdin.write(good);
  });
  assert.equal(r.code, 3);
  assert.equal(r.output, 0);
  assert.ok(Date.now() - start >= 4500);
});
function copyProject() {
  const target = mkdtempSync(join(directory, "p-"));
  mkdirSync(join(target, "work"));
  for (const path of new Set([
    ...Object.values(provisionSourceFiles),
    ...Object.values(probeSourceFiles),
  ])) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    copyFileSync(join(workspace, path), join(target, path));
  }
  for (const [parent, id, source] of [
    ["analysis-provision-build", buildId, artifact.directory],
    ["analysis-file-build", probeBuildId, probe.directory],
  ]) {
    const dest = join(target, "work", parent, `build-${id}`);
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(source))
      copyFileSync(join(source, name), join(dest, name));
  }
  return target;
}
await test("real prepare/check preserves manifest and does not create proposed OS root", async () => {
  const p = copyProject(),
    r = await prepareProvision(
      p,
      buildId,
      buildSha,
      probeBuildId,
      probeBuildSha,
    );
  assert.equal(r.status, "PROVISION_REVIEW_PREPARED_NOT_APPROVED");
  const original = readFileSync(r.manifestPath);
  const checked = checkProvision(p, r.runId, r.manifestSha256);
  assert.equal(checked.executionAllowed, false);
  assert.equal(checked.targetCount, 16);
  assert.deepEqual(readFileSync(r.manifestPath), original);
  assert.equal(existsSync(JSON.parse(original).proposedRunRoot), false);
});
for (const name of ["manifest.json", "inspection.json"])
  await test(`changed ${name} rejected`, async () => {
    const p = copyProject(),
      r = await prepareProvision(
        p,
        buildId,
        buildSha,
        probeBuildId,
        probeBuildSha,
      );
    writeFileSync(join(dirname(r.manifestPath), name), "{}");
    assert.throws(() => checkProvision(p, r.runId, r.manifestSha256));
  });
await test("rehashed manifest cannot turn review into execution", async () => {
  const p = copyProject(),
    r = await prepareProvision(
      p,
      buildId,
      buildSha,
      probeBuildId,
      probeBuildSha,
    );
  const value = JSON.parse(readFileSync(r.manifestPath));
  value.approval.executionAllowed = true;
  const changed = probeJson(value);
  writeFileSync(r.manifestPath, changed);
  assert.throws(() => checkProvision(p, r.runId, launchSha256(changed)));
});
await test("proposed run existing is a collision, never reused/deleted", async () => {
  const p = copyProject(),
    r = await prepareProvision(
      p,
      buildId,
      buildSha,
      probeBuildId,
      probeBuildSha,
    );
  const run = JSON.parse(readFileSync(r.manifestPath)).proposedRunRoot;
  mkdirSync(run, { recursive: true });
  assert.throws(() => checkProvision(p, r.runId, r.manifestSha256));
  assert.equal(existsSync(run), true);
});
await test("unexpected plan item rejected", async () => {
  const p = copyProject(),
    r = await prepareProvision(
      p,
      buildId,
      buildSha,
      probeBuildId,
      probeBuildSha,
    );
  writeFileSync(join(dirname(r.manifestPath), "extra.txt"), "TEST");
  assert.throws(() => checkProvision(p, r.runId, r.manifestSha256));
});
await test("manifest hardlink refused", async () => {
  const p = copyProject(),
    r = await prepareProvision(
      p,
      buildId,
      buildSha,
      probeBuildId,
      probeBuildSha,
    );
  linkSync(r.manifestPath, join(p, "work", "hardlink-copy"));
  assert.throws(() => checkProvision(p, r.runId, r.manifestSha256));
});
await test("plan parent junction refused before inspection files are written", async () => {
  const p = copyProject(),
    dest = join(p, "work", "empty");
  mkdirSync(dest);
  symlinkSync(dest, join(p, "work", "analysis-provision-plans"), "junction");
  await assert.rejects(
    prepareProvision(p, buildId, buildSha, probeBuildId, probeBuildSha),
  );
  assert.deepEqual(readdirSync(dest), []);
});
for (const file of [
  "analysis-provision-inspect.exe",
  "build.json",
  "imports.txt",
  "commands.txt",
])
  await test(`build ${file} mutation refused`, () => {
    const p = copyProject();
    writeFileSync(
      join(p, "work", "analysis-provision-build", `build-${buildId}`, file),
      "TEST_MUTATION",
    );
    assert.throws(() => checkProvisionBuild(p, buildId, buildSha));
  });
await test("changed current recovery source binding refused", () => {
  const p = copyProject();
  writeFileSync(join(p, provisionSourceFiles.recovery), "export {};\n");
  assert.throws(() => checkProvisionBuild(p, buildId, buildSha));
});
await test("extra build DLL refused", () => {
  const p = copyProject();
  writeFileSync(
    join(
      p,
      "work",
      "analysis-provision-build",
      `build-${buildId}`,
      "extra.dll",
    ),
    "TEST",
  );
  assert.throws(() => checkProvisionBuild(p, buildId, buildSha));
});
await test("inspector imports no profile creation/removal or ACL mutation API", () => {
  const imports = readFileSync(join(artifact.directory, "imports.txt"), "utf8");
  for (const name of [
    "DeriveAppContainerSidFromAppContainerName",
    "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    "GetSecurityDescriptorDacl",
    "GetTokenInformation",
  ])
    assert.ok(imports.includes(name));
  for (const name of [
    "CreateAppContainerProfile",
    "DeleteAppContainerProfile",
    "SetSecurityInfo",
    "SetNamedSecurityInfo",
    "SetFileSecurity",
    "CreateProcessW",
  ])
    assert.ok(!imports.includes(name));
});
await test("CLI mutation/extra arguments rejected with no preparation output", () => {
  const p = copyProject();
  for (const args of [
    ["execute", requestId, buildSha],
    ["approve", requestId, buildSha],
    ["rollback", requestId, buildSha],
    ["prepare", buildId, buildSha, probeBuildId, probeBuildSha, "extra"],
  ]) {
    const r = spawnSync(
      process.execPath,
      [join(p, provisionSourceFiles.cli), ...args],
      { encoding: "utf8", shell: false, windowsHide: true, timeout: 7000 },
    );
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trim(), "PROVISION_PREPARATION_REJECTED");
  }
  assert.equal(existsSync(join(p, "work", "analysis-provision-plans")), false);
});
await test("real copied CLI prepare/check ignores caller cwd and prints no token SID", () => {
  const p = copyProject();
  const args = [
    join(p, provisionSourceFiles.cli),
    "prepare",
    buildId,
    buildSha,
    probeBuildId,
    probeBuildSha,
  ];
  const r = spawnSync(process.execPath, args, {
    cwd: directory,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 7000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.ok(!r.stdout.includes("S-1-5-21-"));
  const prepared = JSON.parse(r.stdout);
  assert.ok(prepared.manifestPath.startsWith(p));
  const checked = spawnSync(
    process.execPath,
    [
      join(p, provisionSourceFiles.cli),
      "check",
      prepared.runId,
      prepared.manifestSha256,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 7000,
    },
  );
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).executionAllowed, false);
});
await test("build script rejects arguments before creating new build", () => {
  const parent = dirname(artifact.directory),
    before = readdirSync(parent).sort();
  const r = spawnSync(
    process.execPath,
    [join(workspace, "scripts/build-analysis-provision.mjs"), "--apply"],
    { encoding: "utf8", shell: false, windowsHide: true, timeout: 7000 },
  );
  assert.equal(r.status, 1);
  assert.deepEqual(readdirSync(parent).sort(), before);
});
await test("original two builds still validate after all isolated tests", () => {
  checkProvisionBuild(workspace, buildId, buildSha);
  checkFileProbeBuild(workspace, probeBuildId, probeBuildSha);
});
report.passed = true;
save();
console.log(
  JSON.stringify({
    reportPath: join(directory, "report.json"),
    checks: results.length,
    nestedMemoryCases: 49,
    passed: true,
    osChangesApplied: false,
  }),
);
