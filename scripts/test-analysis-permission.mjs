import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchRunIdSchema,
  launchHashSchema,
  launchSha256,
} from "../dist/runtime/src/core/analysis-launch-plan.js";
import {
  readLaunchFile,
  requireLaunchDirectory,
} from "../dist/runtime/src/server/analysis-launch-files.js";
import {
  inspectNativePe,
  nativeToolHashes,
} from "../dist/runtime/src/core/analysis-native-contract.js";
if (process.argv.length !== 4) throw Error("BUILD_ID_HASH_REQUIRED");
const [id, hash] = process.argv.slice(2);
launchRunIdSchema.parse(id);
launchHashSchema.parse(hash);
const workspace = fileURLToPath(new URL("../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const directory = join(
  workspace,
  "work",
  "analysis-permission-build",
  `build-${id}`,
);
const sources = [
  "src/native/permission-mutation.hpp",
  "src/native/permission-win32.cpp",
  "src/native/analysis-permission-check.cpp",
  "src/native/provision-security.hpp",
  "src/native/file-probe-common.hpp",
  "src/native/analysis-validator-contract.hpp",
  "scripts/build-analysis-permission.mjs",
  "package-lock.json",
];
function check() {
  requireLaunchDirectory(directory);
  assert.deepEqual(
    readdirSync(directory).sort(),
    [
      "build.json",
      "analysis-permission-check.exe",
      "analysis-permission-check.obj",
      "permission-win32.obj",
      "commands.txt",
      "headers.txt",
      "imports.txt",
      "loadconfig.txt",
    ].sort(),
  );
  const wire = readLaunchFile(join(directory, "build.json"), 32768);
  assert.equal(launchSha256(wire), hash);
  const b = JSON.parse(wire);
  assert.equal(b.version, "PERMISSION_ADAPTER_BUILD_V1");
  assert.equal(b.buildId, id);
  assert.equal(b.executionAllowed, false);
  assert.equal(b.osMutationBackend, "COMPILED_LOCKED");
  assert.deepEqual(Object.keys(b.sourceHashes).sort(), sources.slice().sort());
  assert.deepEqual(b.toolHashes, nativeToolHashes);
  for (const file of sources)
    assert.equal(
      launchSha256(readLaunchFile(join(workspace, file), 1048576)),
      b.sourceHashes[file],
    );
  const exe = readLaunchFile(
    join(directory, "analysis-permission-check.exe"),
    2097152,
  );
  inspectNativePe(exe);
  assert.equal(b.artifact.file, "analysis-permission-check.exe");
  assert.equal(exe.length, b.artifact.bytes);
  assert.equal(launchSha256(exe), b.artifact.sha256);
  for (const name of ["headers", "imports", "loadconfig", "commands"])
    assert.equal(
      launchSha256(readLaunchFile(join(directory, `${name}.txt`), 262144)),
      b.evidence[name],
    );
  assert.match(
    readFileSync(join(directory, "imports.txt"), "utf8"),
    /SetSecurityInfo/,
  );
  assert.match(
    readFileSync(join(directory, "imports.txt"), "utf8"),
    /GetSecurityInfo/,
  );
}
check();
const results = [];
for (const args of [
  ["--self-test"],
  [],
  ["--apply"],
  ["--restore"],
  ["--self-test", "--approve"],
]) {
  const r = spawnSync(join(directory, "analysis-permission-check.exe"), args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 8192,
    env: {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      ALLOW_OS_EXECUTION: "true",
    },
  });
  assert.equal(r.error, undefined);
  assert.equal(
    r.status,
    args.length === 1 && args[0] === "--self-test" ? 0 : 2,
  );
  if (r.status === 0) {
    const value = JSON.parse(r.stdout);
    assert.equal(value.checks, 49);
    assert.equal(value.osChangesApplied, false);
    assert.equal(value.osRecoveryVerified, false);
  } else assert.equal(r.stdout, "");
  results.push({ args, exitCode: r.status, stdout: r.stdout });
}
check();
const output = join(
  workspace,
  "work",
  "analysis-permission-verification",
  `native-${Date.now()}`,
);
mkdirSync(output, { recursive: true });
const report = {
  scope: "COMPILED_WIN32_UNCALLED_AND_MODEL_ONLY",
  buildId: id,
  buildSha256: hash,
  modelChecks: 49,
  cliChecks: 5,
  results,
  passed: true,
};
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    passed: true,
    modelChecks: 49,
    cliChecks: 5,
    report: join(output, "report.json"),
  }),
);
