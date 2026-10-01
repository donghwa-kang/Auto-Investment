import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  inspectNativePe,
  nativeRequest,
  nativeSourceFiles,
  validateNativeBuild,
  validateNativeReceipt,
  type NativeBuild,
} from "../core/analysis-native-contract.js";
import {
  launchDummyInput,
  launchRunIdSchema,
  launchSha256,
} from "../core/analysis-launch-plan.js";
import {
  checkAnalysisLaunch,
  readLaunchFile,
  requireLaunchDirectory,
} from "./analysis-launch-files.js";

export function nativeSourceHashes(
  workspace: string,
): NativeBuild["sourceHashes"] {
  return Object.fromEntries(
    Object.entries(nativeSourceFiles).map(([key, file]) => [
      key,
      launchSha256(
        readLaunchFile(
          join(workspace, file),
          key === "lockfile" ? 2097152 : 131072,
        ),
      ),
    ]),
  ) as NativeBuild["sourceHashes"];
}
export function nativeBuildDirectory(workspace: string, buildId: string) {
  launchRunIdSchema.parse(buildId);
  const directory = join(
    workspace,
    "work",
    "analysis-native-build",
    `build-${buildId}`,
  );
  requireLaunchDirectory(directory);
  return directory;
}
export function checkNativeBuild(
  workspace: string,
  buildId: string,
  expectedSha: string,
) {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.versions.node !== "24.20.0"
  )
    throw new Error("NATIVE_RUNTIME_UNSUPPORTED");
  const directory = nativeBuildDirectory(workspace, buildId);
  const allowed = new Set([
    "build.json",
    "analysis-native-check.exe",
    "analysis-validator.obj",
    "headers.txt",
    "imports.txt",
    "loadconfig.txt",
    "commands.txt",
  ]);
  if (readdirSync(directory).some((name) => !allowed.has(name)))
    throw new Error("NATIVE_UNEXPECTED_BUILD_FILE");
  const build = validateNativeBuild(
    readLaunchFile(join(directory, "build.json"), 16384),
    expectedSha,
    buildId,
    nativeSourceHashes(workspace),
  );
  for (const [key, sha] of Object.entries(build.evidence)) {
    if (
      launchSha256(readLaunchFile(join(directory, `${key}.txt`), 262144)) !==
      sha
    )
      throw new Error("NATIVE_BUILD_EVIDENCE_CHANGED");
  }
  const artifactPath = join(directory, build.artifact.file);
  const binary = readLaunchFile(artifactPath, 2097152);
  if (
    binary.length !== build.artifact.bytes ||
    launchSha256(binary) !== build.artifact.sha256
  )
    throw new Error("NATIVE_BINARY_CHANGED");
  return { directory, artifactPath, build, pe: inspectNativePe(binary) };
}

// Fixed executable and argument only. A trusted local process, NOT an OS sandbox.
function invokeValidator(
  executable: string,
  cwd: string,
  input: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--validate"], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
    });
    const chunks: Buffer[] = [];
    let length = 0;
    let failed = false;
    const stop = () => {
      failed = true;
      child.kill();
    };
    const timer = setTimeout(stop, 7000);
    child.stdout.on("data", (bytes: Buffer) => {
      length += bytes.length;
      if (length > 512) stop();
      else if (!failed) chunks.push(bytes);
    });
    child.stderr.on("data", stop);
    child.stdin.on("error", stop);
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failed || code !== 0 || signal)
        reject(new Error("NATIVE_PROCESS_REJECTED"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

export async function checkPreparedNative(
  workspace: string,
  buildId: string,
  buildSha: string,
  runId: string,
  manifestSha: string,
) {
  checkAnalysisLaunch(workspace, runId, manifestSha);
  const artifact = checkNativeBuild(workspace, buildId, buildSha);
  const inputSha = launchSha256(launchDummyInput(runId));
  const request = nativeRequest(runId, manifestSha, inputSha);
  const wire = await invokeValidator(
    artifact.artifactPath,
    artifact.directory,
    request,
  );
  // Discard even a valid receipt if the bound files changed during the child execution.
  checkAnalysisLaunch(workspace, runId, manifestSha);
  checkNativeBuild(workspace, buildId, buildSha);
  const receipt = validateNativeReceipt(wire, runId, manifestSha, inputSha);
  return {
    ...receipt,
    buildId,
    buildSha256: buildSha,
    artifactSha256: artifact.build.artifact.sha256,
    requestSha256: launchSha256(request),
    receiptSha256: launchSha256(wire),
    nativeValidationExecuted: true,
    osIsolationVerified: false,
    realCodexEnabled: false,
  };
}
