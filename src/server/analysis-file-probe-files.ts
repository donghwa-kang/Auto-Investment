import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  inspectNativePe,
  nativeToolHashes,
} from "../core/analysis-native-contract.js";
import {
  launchHashSchema,
  launchRunIdSchema,
  launchSha256,
} from "../core/analysis-launch-plan.js";
import {
  classifyProbe,
  expectedProbeSnapshot,
  parseProbeReceipt,
  probeBuildSchema,
  probeCases,
  probeContent,
  probeFileNames,
  probeJson,
  probeManifest,
  probeRequest,
  probeSourceFiles,
  type ProbeCase,
  type ProbeSnapshot,
} from "../core/analysis-file-probe.js";
import {
  readLaunchFile,
  requireLaunchDirectory,
} from "./analysis-launch-files.js";

function runtime(workspace: string) {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.versions.node !== "24.20.0"
  )
    throw new Error("FILE_PROBE_RUNTIME");
  requireLaunchDirectory(workspace);
  requireLaunchDirectory(join(workspace, "work"));
}
function createParent(workspace: string, name: string) {
  runtime(workspace);
  const parent = join(workspace, "work", name);
  if (!existsSync(parent)) mkdirSync(parent);
  requireLaunchDirectory(parent);
  return parent;
}
export function fileProbeSourceHashes(workspace: string) {
  return Object.fromEntries(
    Object.entries(probeSourceFiles).map(([name, path]) => [
      name,
      launchSha256(
        readLaunchFile(
          join(workspace, path),
          name === "lockfile" ? 2097152 : 131072,
        ),
      ),
    ]),
  );
}
export function checkFileProbeBuild(
  workspace: string,
  buildId: string,
  buildSha: string,
) {
  runtime(workspace);
  launchRunIdSchema.parse(buildId);
  launchHashSchema.parse(buildSha);
  const directory = join(
    workspace,
    "work",
    "analysis-file-build",
    `build-${buildId}`,
  );
  requireLaunchDirectory(directory);
  const bytes = readLaunchFile(join(directory, "build.json"), 16384);
  if (launchSha256(bytes) !== buildSha)
    throw new Error("FILE_PROBE_BUILD_HASH");
  const wire = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const build = probeBuildSchema.parse(JSON.parse(wire));
  if (
    build.buildId !== buildId ||
    wire !==
      probeJson({
        ...build,
        sourceHashes: fileProbeSourceHashes(workspace),
        toolHashes: nativeToolHashes,
      })
  )
    throw new Error("FILE_PROBE_BUILD_BINDING");
  const evidenceNames = [
    "probe-headers",
    "probe-imports",
    "probe-loadconfig",
    "controller-headers",
    "controller-imports",
    "controller-loadconfig",
    "commands",
  ];
  if (
    JSON.stringify(Object.keys(build.evidence).sort()) !==
    JSON.stringify([...evidenceNames].sort())
  )
    throw new Error("FILE_PROBE_BUILD_EVIDENCE");
  const allowed = new Set([
    "build.json",
    "analysis-file-probe.exe",
    "analysis-isolation-controller.exe",
    "probe.obj",
    "controller.obj",
    "backend.obj",
    ...evidenceNames.map((name) => `${name}.txt`),
  ]);
  if (readdirSync(directory).some((name) => !allowed.has(name)))
    throw new Error("FILE_PROBE_BUILD_EXTRA");
  for (const [name, sha] of Object.entries(build.evidence))
    if (
      launchSha256(readLaunchFile(join(directory, `${name}.txt`), 262144)) !==
      sha
    )
      throw new Error("FILE_PROBE_EVIDENCE_CHANGED");
  for (const artifact of Object.values(build.artifacts)) {
    const file = readLaunchFile(join(directory, artifact.file), 2097152);
    if (
      file.length !== artifact.bytes ||
      launchSha256(file) !== artifact.sha256
    )
      throw new Error("FILE_PROBE_BINARY_CHANGED");
    inspectNativePe(file);
  }
  return { directory, build };
}
export type ProbeFixture = {
  root: string;
  runId: string;
  caseId: ProbeCase;
  buildId: string;
  buildSha: string;
  manifestSha: string;
};
export function createProbeFixture(
  workspace: string,
  caseId: ProbeCase,
  buildId: string,
  buildSha: string,
): ProbeFixture {
  const runId = randomUUID();
  const manifest = probeJson(probeManifest(runId, caseId, buildId, buildSha));
  const parent = createParent(workspace, "analysis-file-lab");
  const root = join(parent, `run-${runId}`);
  mkdirSync(root);
  requireLaunchDirectory(root);
  for (const name of ["input", "private", "scratch"])
    mkdirSync(join(root, name));
  for (const file of probeFileNames) {
    if (file === "private/create.txt" || file === "private/renamed.txt")
      continue;
    writeFileSync(
      join(root, file),
      file === "manifest.json" ? manifest : probeContent(runId, file),
      { flag: "wx" },
    );
  }
  return {
    root,
    runId,
    caseId,
    buildId,
    buildSha,
    manifestSha: launchSha256(manifest),
  };
}
export function snapshotProbeFixture(fixture: ProbeFixture): ProbeSnapshot {
  requireLaunchDirectory(fixture.root);
  for (const [directory, allowed] of [
    [
      "",
      ["fixture-marker.txt", "manifest.json", "input", "private", "scratch"],
    ],
    ["input", ["allow.txt"]],
    ["scratch", ["write.txt"]],
    [
      "private",
      [
        "read.txt",
        "append.txt",
        "create.txt",
        "delete.txt",
        "rename.txt",
        "renamed.txt",
      ],
    ],
  ] as const) {
    const path = join(fixture.root, directory);
    requireLaunchDirectory(path);
    if (
      readdirSync(path).some(
        (name) => !(allowed as readonly string[]).includes(name),
      )
    )
      throw new Error("FILE_PROBE_UNEXPECTED_FILE");
  }
  return Object.fromEntries(
    probeFileNames.map((file) => {
      const path = join(fixture.root, file);
      try {
        lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return [file, null];
        throw error;
      }
      return [file, launchSha256(readLaunchFile(path, 4096))];
    }),
  ) as ProbeSnapshot;
}
export function validateProbeFixture(workspace: string, fixture: ProbeFixture) {
  const manifest = probeJson(
    probeManifest(
      fixture.runId,
      fixture.caseId,
      fixture.buildId,
      fixture.buildSha,
    ),
  );
  if (
    fixture.root !==
      join(workspace, "work", "analysis-file-lab", `run-${fixture.runId}`) ||
    fixture.manifestSha !== launchSha256(manifest)
  )
    throw new Error("FILE_PROBE_FIXTURE_BINDING");
  const before = snapshotProbeFixture(fixture);
  for (const file of probeFileNames) {
    const expected =
      file === "private/create.txt" || file === "private/renamed.txt"
        ? null
        : launchSha256(
            file === "manifest.json"
              ? manifest
              : probeContent(fixture.runId, file),
          );
    if (before[file] !== expected)
      throw new Error("FILE_PROBE_FIXTURE_CHANGED");
  }
  return before;
}
async function invoke(
  executable: string,
  args: string[],
  cwd: string,
  input: Buffer,
) {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
    });
    const chunks: Buffer[] = [];
    let bytes = 0,
      failed = false;
    const stop = () => {
      failed = true;
      child.kill();
    };
    const timer = setTimeout(stop, 7000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2048) stop();
      else if (!failed) chunks.push(chunk);
    });
    child.stderr.on("data", stop);
    child.stdin.on("error", stop);
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failed || code !== 0 || signal)
        reject(new Error("FILE_PROBE_PROCESS_FAILED"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}
export async function exerciseProbeFixture(
  workspace: string,
  fixture: ProbeFixture,
) {
  const artifact = checkFileProbeBuild(
    workspace,
    fixture.buildId,
    fixture.buildSha,
  );
  const before = validateProbeFixture(workspace, fixture);
  const request = probeRequest(
    fixture.runId,
    fixture.caseId,
    fixture.manifestSha,
  );
  const wire = await invoke(
    join(artifact.directory, artifact.build.artifacts.probe.file),
    ["--probe"],
    fixture.root,
    request,
  );
  checkFileProbeBuild(workspace, fixture.buildId, fixture.buildSha);
  const after = snapshotProbeFixture(fixture);
  const receipt = parseProbeReceipt(
    wire,
    fixture.runId,
    fixture.caseId,
    request,
  );
  return {
    fixture,
    before,
    after,
    receipt,
    classification: classifyProbe(receipt, before, after, fixture.runId),
    actualOsTests: "NOT_RUN" as const,
  };
}
export async function selfTestFileProbe(
  workspace: string,
  buildId: string,
  buildSha: string,
) {
  const artifact = checkFileProbeBuild(workspace, buildId, buildSha);
  const expectedModel = {
    status: "LIFECYCLE_MODEL_TESTS_PASSED",
    checks: 23,
    backend: "MODEL",
    win32StepsExecuted: 0,
    executionAllowed: false,
    osIsolationVerified: false,
  };
  const model = await invoke(
    join(artifact.directory, artifact.build.artifacts.controller.file),
    ["--self-test"],
    artifact.directory,
    Buffer.alloc(0),
  );
  if (!model.equals(Buffer.from(JSON.stringify(expectedModel) + "\n")))
    throw new Error("FILE_PROBE_MODEL_RECEIPT");
  checkFileProbeBuild(workspace, buildId, buildSha);
  const parent = createParent(workspace, "analysis-file-checks");
  const directory = join(parent, `check-${randomUUID()}`);
  mkdirSync(directory);
  const results: Awaited<ReturnType<typeof exerciseProbeFixture>>[] = [];
  const attemptedFixtures: ProbeFixture[] = [];
  let failure = false;
  try {
    for (const caseId of probeCases) {
      const fixture = createProbeFixture(workspace, caseId, buildId, buildSha);
      attemptedFixtures.push(fixture);
      const result = await exerciseProbeFixture(workspace, fixture);
      results.push(result);
      writeFileSync(join(directory, `${caseId}.json`), probeJson(result), {
        flag: "wx",
      });
      if (
        result.classification !==
          (caseId.startsWith("ALLOW_")
            ? "ALLOW_OBSERVED"
            : "EXPOSURE_DETECTED") ||
        result.receipt.outcome === "ERROR" ||
        probeJson(result.after) !==
          probeJson(expectedProbeSnapshot(result.before, fixture.runId, caseId))
      ) {
        failure = true;
        break;
      }
    }
  } catch {
    failure = true;
  }
  const report = {
    status:
      !failure && results.length === probeCases.length
        ? "FILE_PROBE_SELF_TEST_PASSED"
        : "FILE_PROBE_SELF_TEST_INCONCLUSIVE",
    scope: "UNRESTRICTED_DUMMY_FILES_AND_MODEL_LIFECYCLE",
    buildId,
    buildSha256: buildSha,
    model: expectedModel,
    results,
    attemptedFixtures,
    failure,
    actualOsTests: "NOT_RUN",
    osIsolationVerified: false,
    realCodexEnabled: false,
    liveOrdersEnabled: false,
  };
  writeFileSync(join(directory, "report.json"), probeJson(report), {
    flag: "wx",
  });
  return {
    status: report.status,
    reportPath: join(directory, "report.json"),
    fileCases: results.length,
    modelCases: expectedModel.checks,
    actualOsTests: report.actualOsTests,
    osIsolationVerified: false,
    realCodexEnabled: false,
    liveOrdersEnabled: false,
  };
}
