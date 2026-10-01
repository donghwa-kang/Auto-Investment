import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  linkSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeRequest,
  nativeSourceFiles,
  expectedNativeReceipt,
  inspectNativePe,
} from "../dist/runtime/src/core/analysis-native-contract.js";
import {
  launchHashSchema,
  launchRunIdSchema,
} from "../dist/runtime/src/core/analysis-launch-plan.js";
import { prepareAnalysisLaunch } from "../dist/runtime/src/server/analysis-launch-files.js";
import {
  checkNativeBuild,
  checkPreparedNative,
} from "../dist/runtime/src/server/analysis-native-runner.js";

if (process.argv.length !== 4)
  throw new Error("NATIVE_TEST_BUILD_ID_AND_HASH_REQUIRED");
const buildId = launchRunIdSchema.parse(process.argv[2]);
const buildSha = launchHashSchema.parse(process.argv[3]);
const workspace = fileURLToPath(new URL("../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const artifact = checkNativeBuild(workspace, buildId, buildSha);
const output = mkdtempSync(join(workspace, "work", "native-test-"));
const id = "fbab57a9-53df-41a7-a2d1-190e8004b736";
const sha = "a".repeat(64);
const inputSha = "b".repeat(64);
const request = nativeRequest(id, sha, inputSha);
const expected = Buffer.from(
  JSON.stringify(expectedNativeReceipt(id, sha, inputSha)) + "\n",
);
const results = [];
const report = () => ({
  scope: "UNSANDBOXED_NATIVE_VALIDATOR_TESTS_NOT_OS_PROBES",
  buildId,
  buildSha256: buildSha,
  artifactSha256: artifact.build.artifact.sha256,
  results,
  passed: results.length > 0 && results.every((r) => r.passed),
});
async function check(name, work) {
  const start = performance.now();
  try {
    await work();
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
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify(report(), null, 2) + "\n",
  );
  console.log(JSON.stringify(results.at(-1)));
}
async function child({
  input = request,
  args = ["--validate"],
  hold = false,
  fragmented = false,
  stdoutIgnored = false,
} = {}) {
  const start = performance.now();
  return await new Promise((resolve, reject) => {
    const p = spawn(artifact.artifactPath, args, {
      cwd: output,
      shell: false,
      windowsHide: true,
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      stdio: ["pipe", stdoutIgnored ? "ignore" : "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let total = 0;
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("TEST_PARENT_TIMEOUT"));
    }, 8000);
    const collect = (target) => (bytes) => {
      total += bytes.length;
      if (total > 8192) {
        p.kill();
        reject(new Error("TEST_OUTPUT_OVERFLOW"));
      } else target.push(bytes);
    };
    p.stdout?.on("data", collect(stdout));
    p.stderr.on("data", collect(stderr));
    p.stdin.on("error", () => {});
    p.on("error", reject);
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        elapsedMs: performance.now() - start,
      });
    });
    if (fragmented) {
      p.stdin.write(input.subarray(0, 23));
      setTimeout(() => p.stdin.end(input.subarray(23)), 40);
    } else if (hold) p.stdin.write(input);
    else p.stdin.end(input);
  });
}
function rejected(result, code = 3) {
  assert.equal(result.code, code);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
}
await check(
  "native valid frame and EOF returns bound locked receipt",
  async () => {
    const result = await child();
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, expected);
    assert.equal(result.stderr.length, 0);
  },
);
await check(
  "native fragmented stdin is accepted without prefix-only acceptance",
  async () => {
    const result = await child({ fragmented: true });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, expected);
  },
);
const invalid = {
  empty: Buffer.alloc(0),
  oversize: Buffer.alloc(385, 97),
  bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), request]),
  invalid_utf8: Buffer.from([0xff, 0xfe]),
  nul: Buffer.concat([request, Buffer.from([0])]),
  crlf: Buffer.from(request.toString().replaceAll("\n", "\r\n")),
  truncated: request.subarray(0, -1),
  extra_frame: Buffer.concat([request, request]),
  trailing: Buffer.concat([request, Buffer.from("x")]),
  uuid_version: Buffer.from(request.toString().replace("41a7", "11a7")),
  hash_upper: Buffer.from(request.toString().replace(sha, sha.toUpperCase())),
  mode: Buffer.from(request.toString().replace("PREPARATION_ONLY", "EXECUTE")),
  capabilities: Buffer.from(
    request.toString().replace("CAPABILITIES=NONE", "CAPABILITIES=ALL"),
  ),
  children: Buffer.from(
    request.toString().replace("CHILD_PROCESSES=DENY", "CHILD_PROCESSES=ALLOW"),
  ),
  limits: Buffer.from(request.toString().replace("128,2000", "999,2000")),
  unlocked: Buffer.from(
    request.toString().replace("EXECUTION=LOCKED", "EXECUTION=ALLOWED"),
  ),
  path: Buffer.from(request.toString().replace("END", "C:\\user-data")),
};
for (const [name, input] of Object.entries(invalid))
  await check(`native rejects ${name}`, async () =>
    rejected(await child({ input })),
  );
for (const args of [
  [],
  ["--execute"],
  ["--validate", "--execute"],
  ["--validate", "C:\\other"],
  ["--setup"],
  ["--approve"],
])
  await check(`native rejects arguments ${JSON.stringify(args)}`, async () =>
    rejected(await child({ args }), 2),
  );
await check("native requires stdout pipe", async () =>
  rejected(await child({ stdoutIgnored: true })),
);
await check(
  "native valid prefix without EOF expires with no result",
  async () => {
    const result = await child({ hold: true });
    rejected(result, 4);
    assert.ok(result.elapsedMs >= 4900 && result.elapsedMs < 7500);
  },
);
await check("native empty unclosed stdin expires with no result", async () =>
  rejected(await child({ input: Buffer.alloc(0), hold: true }), 4),
);
await check(
  "native rejects all one-byte NUL mutations of a valid frame",
  async () => {
    for (let i = 0; i < request.length; ++i) {
      const input = Buffer.from(request);
      input[i] = 0;
      rejected(await child({ input }));
    }
  },
);
await check(
  "binary PE flags and recorded CFG instrumentation inspected",
  () => {
    assert.equal(inspectNativePe(readFileSync(artifact.artifactPath)).nx, true);
    const config = readFileSync(
      join(artifact.directory, "loadconfig.txt"),
      "utf8",
    );
    assert.match(config, /CF instrumented/);
    assert.match(config, /FID table present/);
    // Static CRT can import file/library APIs; imports are evidence, not an allowlist proof.
    assert.match(
      readFileSync(join(artifact.directory, "imports.txt"), "utf8"),
      /KERNEL32\.dll/,
    );
  },
);

function fixture() {
  const root = mkdtempSync(join(output, "f-"));
  const files = [
    ...Object.values(nativeSourceFiles),
    ...[
      "core/analysis-launch-plan.js",
      "server/analysis-launch-files.js",
      "server/analysis-launch-cli.js",
    ].map((f) => `dist/runtime/src/${f}`),
  ];
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(workspace, file), join(root, file));
  }
  const buildDirectory = join(
    root,
    "work",
    "analysis-native-build",
    `build-${buildId}`,
  );
  mkdirSync(buildDirectory, { recursive: true });
  for (const file of [
    "build.json",
    "analysis-native-check.exe",
    "headers.txt",
    "imports.txt",
    "loadconfig.txt",
    "commands.txt",
  ])
    copyFileSync(join(artifact.directory, file), join(buildDirectory, file));
  const preparation = prepareAnalysisLaunch(root);
  return {
    root,
    buildDirectory,
    preparation,
    run: () =>
      checkPreparedNative(
        root,
        buildId,
        buildSha,
        preparation.runId,
        preparation.manifestSha256,
      ),
  };
}
await check(
  "host validates real copied preparation and build, leaves bundle unchanged",
  async () => {
    const f = fixture();
    const before = readFileSync(f.preparation.manifestPath);
    const result = await f.run();
    assert.equal(result.nativeValidationExecuted, true);
    assert.equal(result.executionAllowed, false);
    assert.equal(result.osIsolationVerified, false);
    assert.deepEqual(readFileSync(f.preparation.manifestPath), before);
    assert.equal(existsSync(f.preparation.proposedRunRoot), false);
  },
);
for (const file of [
  "analysis-native-check.exe",
  "headers.txt",
  "imports.txt",
  "loadconfig.txt",
  "commands.txt",
  "build.json",
])
  await check(
    `host rejects changed ${file} before native dispatch`,
    async () => {
      const f = fixture();
      writeFileSync(join(f.buildDirectory, file), "TAMPERED_FIXTURE_ONLY");
      await assert.rejects(f.run);
    },
  );
await check("host rejects changed current source", async () => {
  const f = fixture();
  writeFileSync(
    join(f.root, nativeSourceFiles.nativeCore),
    "CHANGED_FIXTURE_SOURCE",
  );
  await assert.rejects(f.run);
});
await check("host rejects extra build-directory sidecar", async () => {
  const f = fixture();
  writeFileSync(
    join(f.buildDirectory, "unapproved.dll"),
    "NOT_A_DLL_TEST_ONLY",
  );
  await assert.rejects(f.run);
});
await check("host rejects changed prepared input", async () => {
  const f = fixture();
  writeFileSync(
    join(dirname(f.preparation.manifestPath), "approved-input.txt"),
    "CHANGED_FIXTURE_INPUT",
  );
  await assert.rejects(f.run);
});
await check("host rejects binary hardlink", async () => {
  const f = fixture();
  linkSync(
    join(f.buildDirectory, "analysis-native-check.exe"),
    join(f.root, "duplicate.exe"),
  );
  await assert.rejects(f.run);
});
await check("host rejects build-parent junction", async () => {
  const f = fixture();
  const root = mkdtempSync(join(output, "j-"));
  mkdirSync(join(root, "work"));
  symlinkSync(
    join(f.root, "work", "analysis-native-build"),
    join(root, "work", "analysis-native-build"),
    "junction",
  );
  assert.throws(() => checkNativeBuild(root, buildId, buildSha));
});
await check(
  "actual CLI accepts only bound check and rejects extra execute flag",
  async () => {
    const f = fixture();
    const args = [
      join(f.root, "dist/runtime/src/server/analysis-native-cli.js"),
      "check",
      buildId,
      buildSha,
      f.preparation.runId,
      f.preparation.manifestSha256,
    ];
    const before = readdirSync(join(f.root, "work"));
    for (const extra of [[], ["--execute"]]) {
      const r = spawnSync(process.execPath, [...args, ...extra], {
        cwd: output,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 8192,
        env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      });
      assert.equal(r.error, undefined);
      assert.equal(r.status, extra.length ? 1 : 0);
      if (!extra.length) {
        assert.equal(JSON.parse(r.stdout).executionAllowed, false);
        assert.equal(r.stderr, "");
      } else {
        assert.equal(r.stdout, "");
        assert.equal(r.stderr.trim(), "ANALYSIS_NATIVE_CHECK_REJECTED");
      }
    }
    assert.deepEqual(readdirSync(join(f.root, "work")), before);
    assert.equal(existsSync(f.preparation.proposedRunRoot), false);
  },
);
await check(
  "build script refuses extra arguments without creating build folder",
  () => {
    const parent = dirname(artifact.directory);
    const before = readdirSync(parent);
    const result = spawnSync(
      process.execPath,
      [join(workspace, "scripts/build-analysis-native.mjs"), "--execute"],
      {
        cwd: output,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 8192,
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(readdirSync(parent), before);
  },
);
checkNativeBuild(workspace, buildId, buildSha);
console.log(
  JSON.stringify({
    report: join(output, "report.json"),
    passed: report().passed,
    checks: results.length,
    mutatedFrames: request.length,
  }),
);
if (!report().passed) process.exitCode = 1;
