import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  provisionBuildSchema,
  provisionSourceFiles,
  parseProvisionInspection,
  provisionRequest,
  buildProvisionPlan,
  validateProvisionPlan,
  type ProvisionPlan,
} from "../core/analysis-provision.js";
import {
  nativeToolHashes,
  inspectNativePe,
} from "../core/analysis-native-contract.js";
import {
  launchRunIdSchema,
  launchHashSchema,
  launchLayout,
  launchSha256,
} from "../core/analysis-launch-plan.js";
import { probeJson } from "../core/analysis-file-probe.js";
import { checkFileProbeBuild } from "./analysis-file-probe-files.js";
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
    throw new Error("PROVISION_RUNTIME");
  requireLaunchDirectory(workspace);
  requireLaunchDirectory(join(workspace, "work"));
}
function missing(path: string) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
function uncreatedRun(workspace: string, runId: string) {
  const layout = launchLayout(workspace, runId);
  if (!missing(layout.runParent)) requireLaunchDirectory(layout.runParent);
  if (!missing(layout.run)) throw new Error("PROVISION_RUN_EXISTS");
}
export function provisionCodeHashes(workspace: string) {
  return Object.fromEntries(
    Object.entries(provisionSourceFiles).map(([name, path]) => [
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
export function checkProvisionBuild(
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
    "analysis-provision-build",
    `build-${buildId}`,
  );
  requireLaunchDirectory(directory);
  const bytes = readLaunchFile(join(directory, "build.json"), 16384);
  if (launchSha256(bytes) !== buildSha) throw new Error("PROVISION_BUILD_HASH");
  const wire = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const build = provisionBuildSchema.parse(JSON.parse(wire));
  if (
    build.buildId !== buildId ||
    wire !==
      probeJson({
        ...build,
        sourceHashes: provisionCodeHashes(workspace),
        toolHashes: nativeToolHashes,
      })
  )
    throw new Error("PROVISION_BUILD_BINDING");
  const names = [
    "build.json",
    build.artifact.file,
    "inspect.obj",
    ...Object.keys(build.evidence).map((n) => `${n}.txt`),
  ];
  if (
    JSON.stringify(readdirSync(directory).sort()) !==
    JSON.stringify(names.sort())
  )
    throw new Error("PROVISION_BUILD_CONTENTS");
  for (const [name, hash] of Object.entries(build.evidence))
    if (
      launchSha256(readLaunchFile(join(directory, `${name}.txt`), 262144)) !==
      hash
    )
      throw new Error("PROVISION_EVIDENCE_CHANGED");
  const executable = readLaunchFile(
    join(directory, build.artifact.file),
    2097152,
  );
  if (
    executable.length !== build.artifact.bytes ||
    launchSha256(executable) !== build.artifact.sha256
  )
    throw new Error("PROVISION_BINARY_CHANGED");
  inspectNativePe(executable);
  return { directory, build };
}
export async function inspectProvision(
  workspace: string,
  buildId: string,
  buildSha: string,
  runId: string,
) {
  const checked = checkProvisionBuild(workspace, buildId, buildSha);
  const request = provisionRequest(runId);
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      join(checked.directory, checked.build.artifact.file),
      ["--inspect"],
      {
        cwd: checked.directory,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      },
    );
    const chunks: Buffer[] = [];
    let size = 0,
      failed = false;
    const stop = () => {
      failed = true;
      child.kill();
    };
    const timer = setTimeout(stop, 7000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) stop();
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
        reject(new Error("PROVISION_INSPECT_FAILED"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(request);
  });
  checkProvisionBuild(workspace, buildId, buildSha);
  return { bytes, inspection: parseProvisionInspection(bytes, runId) };
}
function summary(plan: ProvisionPlan, path: string, manifestSha: string) {
  return {
    status: "PROVISION_REVIEW_VALID_EXECUTION_LOCKED",
    runId: plan.runId,
    manifestPath: path,
    manifestSha256: manifestSha,
    targetCount: plan.targets.length,
    memoryStructureVerified: true,
    profileExistence: "NOT_QUERIED",
    executionAllowed: false,
    osChangesApplied: false,
    osIsolationVerified: false,
    realCodexEnabled: false,
    liveOrdersEnabled: false,
    blockers: plan.blockers,
  };
}
export async function prepareProvision(
  workspace: string,
  buildId: string,
  buildSha: string,
  probeBuildId: string,
  probeBuildSha: string,
) {
  runtime(workspace);
  const probe = checkFileProbeBuild(workspace, probeBuildId, probeBuildSha);
  checkProvisionBuild(workspace, buildId, buildSha);
  const runId = randomUUID();
  uncreatedRun(workspace, runId);
  const parent = join(workspace, "work", "analysis-provision-plans");
  if (missing(parent)) mkdirSync(parent);
  requireLaunchDirectory(parent);
  const { bytes, inspection } = await inspectProvision(
    workspace,
    buildId,
    buildSha,
    runId,
  );
  const binding = {
    buildId,
    buildSha256: buildSha,
    probeBuildId,
    probeBuildSha256: probeBuildSha,
    probeSha256: probe.build.artifacts.probe.sha256,
    codeHashes: provisionCodeHashes(workspace),
  };
  const plan = buildProvisionPlan(workspace, inspection, binding),
    wire = probeJson(plan);
  const directory = join(parent, `plan-${runId}`);
  mkdirSync(directory);
  requireLaunchDirectory(directory);
  writeFileSync(join(directory, "inspection.json"), bytes, { flag: "wx" });
  writeFileSync(join(directory, "manifest.json"), wire, { flag: "wx" });
  return {
    ...checkProvision(workspace, runId, launchSha256(wire)),
    status: "PROVISION_REVIEW_PREPARED_NOT_APPROVED",
  };
}
export function checkProvision(
  workspace: string,
  runId: string,
  manifestSha: string,
) {
  runtime(workspace);
  launchRunIdSchema.parse(runId);
  launchHashSchema.parse(manifestSha);
  const directory = join(
    workspace,
    "work",
    "analysis-provision-plans",
    `plan-${runId}`,
  );
  requireLaunchDirectory(directory);
  if (
    JSON.stringify(readdirSync(directory).sort()) !==
    JSON.stringify(["inspection.json", "manifest.json"])
  )
    throw new Error("PROVISION_EXTRA_FILE");
  const bytes = readLaunchFile(join(directory, "manifest.json"), 65536);
  if (launchSha256(bytes) !== manifestSha)
    throw new Error("PROVISION_MANIFEST_HASH");
  // Untrusted JSON is only used to select strict UUID/hash build references, never paths/commands.
  const raw = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  ) as ProvisionPlan;
  if (!raw || raw.runId !== runId || !raw.binding)
    throw new Error("PROVISION_MANIFEST_SHAPE");
  const b = raw.binding;
  checkProvisionBuild(workspace, b.buildId, b.buildSha256);
  const probe = checkFileProbeBuild(
    workspace,
    b.probeBuildId,
    b.probeBuildSha256,
  );
  const inspection = parseProvisionInspection(
    readLaunchFile(join(directory, "inspection.json"), 8192),
    runId,
  );
  const expected = buildProvisionPlan(workspace, inspection, {
    buildId: b.buildId,
    buildSha256: b.buildSha256,
    probeBuildId: b.probeBuildId,
    probeBuildSha256: b.probeBuildSha256,
    probeSha256: probe.build.artifacts.probe.sha256,
    codeHashes: provisionCodeHashes(workspace),
  });
  const plan = validateProvisionPlan(bytes, manifestSha, expected);
  uncreatedRun(workspace, runId);
  return summary(plan, join(directory, "manifest.json"), manifestSha);
}
