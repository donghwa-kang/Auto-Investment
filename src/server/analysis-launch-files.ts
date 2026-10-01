import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  buildLaunchPlan,
  launchDummyInput,
  launchLayout,
  launchRunIdSchema,
  launchSha256,
  requireLaunchLocalPath,
  serializeLaunchPlan,
  validateLaunchPlan,
  type LaunchCodeHashes,
} from "../core/analysis-launch-plan.js";

const codeFiles = {
  core: "dist/runtime/src/core/analysis-launch-plan.js",
  files: "dist/runtime/src/server/analysis-launch-files.js",
  cli: "dist/runtime/src/server/analysis-launch-cli.js",
  lockfile: "package-lock.json",
} as const;

// 경로/파일 핸들 점검은 로컬 준비 도구용이다. 악성 호스트의 경합을 막는 OS 경계가 아니다.
export function requireLaunchDirectory(path: string) {
  requireLaunchLocalPath(path);
  let cursor = path;
  for (;;) {
    const stat = lstatSync(cursor);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(cursor).toLowerCase() !== cursor.toLowerCase()
    )
      throw new Error("LAUNCH_PLAIN_DIRECTORY_REQUIRED");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
export function readLaunchFile(path: string, limit: number): Buffer {
  requireLaunchLocalPath(path);
  requireLaunchDirectory(dirname(path));
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > limit ||
    realpathSync(path).toLowerCase() !== path.toLowerCase()
  )
    throw new Error("LAUNCH_PLAIN_FILE_REQUIRED");
  const fd = openSync(path, "r");
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > limit ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev
    )
      throw new Error("LAUNCH_FILE_CHANGED");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (
      length > limit ||
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.nlink !== 1
    )
      throw new Error("LAUNCH_FILE_CHANGED");
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
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
function directoryIfPresent(path: string) {
  if (!missing(path)) requireLaunchDirectory(path);
}
function requireUncreatedTarget(workspace: string, runId: string) {
  const paths = launchLayout(workspace, runId);
  directoryIfPresent(paths.runParent);
  if (!missing(paths.run)) throw new Error("LAUNCH_TARGET_ALREADY_EXISTS");
}
export function launchCodeHashes(workspace: string): LaunchCodeHashes {
  requireLaunchDirectory(workspace);
  return {
    core: launchSha256(readLaunchFile(join(workspace, codeFiles.core), 131072)),
    files: launchSha256(
      readLaunchFile(join(workspace, codeFiles.files), 131072),
    ),
    cli: launchSha256(readLaunchFile(join(workspace, codeFiles.cli), 131072)),
    lockfile: launchSha256(
      readLaunchFile(join(workspace, codeFiles.lockfile), 2097152),
    ),
  };
}
function validateWorkspace(workspace: string) {
  if (process.platform !== "win32" || process.versions.node !== "24.20.0")
    throw new Error("LAUNCH_RUNTIME_UNSUPPORTED");
  requireLaunchDirectory(workspace);
  requireLaunchDirectory(join(workspace, "work"));
}

export function prepareAnalysisLaunch(workspace: string) {
  validateWorkspace(workspace);
  const runId = randomUUID();
  const paths = launchLayout(workspace, runId);
  const codeHashes = launchCodeHashes(workspace);
  requireUncreatedTarget(workspace, runId);
  // 부모는 고정 경로 한 단계만 생성. 링크가 있으면 하위 파일을 쓰기 전에 거절한다.
  if (missing(paths.bundleParent)) mkdirSync(paths.bundleParent);
  requireLaunchDirectory(paths.bundleParent);
  const plan = buildLaunchPlan({
    workspace,
    runId,
    codeHashes,
    createdAt: new Date().toISOString(),
  });
  const manifest = serializeLaunchPlan(plan);
  mkdirSync(paths.bundle); // 존재하면 실패하며 기존 묶음을 덮어쓰지 않는다.
  requireLaunchDirectory(paths.bundle);
  writeFileSync(
    join(paths.bundle, "approved-input.txt"),
    launchDummyInput(runId),
    { flag: "wx" },
  );
  writeFileSync(join(paths.bundle, "manifest.json"), manifest, { flag: "wx" });
  const manifestSha256 = launchSha256(manifest);
  const checked = checkAnalysisLaunch(workspace, runId, manifestSha256);
  return { ...checked, status: "PREPARED_NOT_EXECUTABLE" as const };
}

// 읽기 전용: 재검증 결과를 묶음이나 제안된 OS 실행 경로에 쓰지 않는다.
export function checkAnalysisLaunch(
  workspace: string,
  runId: string,
  manifestSha256: string,
) {
  validateWorkspace(workspace);
  launchRunIdSchema.parse(runId);
  const paths = launchLayout(workspace, runId);
  requireLaunchDirectory(paths.bundle);
  const names = readdirSync(paths.bundle).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(["approved-input.txt", "manifest.json"])
  )
    throw new Error("LAUNCH_UNEXPECTED_BUNDLE_CONTENT");
  const plan = validateLaunchPlan(
    readLaunchFile(join(paths.bundle, "manifest.json"), 32768),
    manifestSha256,
    { workspace, runId, codeHashes: launchCodeHashes(workspace) },
  );
  const input = readLaunchFile(join(paths.bundle, "approved-input.txt"), 4096);
  if (
    input.length !== plan.input.bytes ||
    launchSha256(input) !== plan.input.sha256 ||
    !input.equals(Buffer.from(launchDummyInput(runId)))
  )
    throw new Error("LAUNCH_DUMMY_INPUT_CHANGED");
  requireUncreatedTarget(workspace, runId);
  return {
    status: "PLAN_VALID_EXECUTION_LOCKED" as const,
    runId,
    manifestPath: join(paths.bundle, "manifest.json"),
    manifestSha256,
    proposedRunRoot: paths.run,
    profileName: plan.profile.name,
    executionAllowed: false as const,
    actualOsTests: "NOT_RUN" as const,
    realCodexEnabled: false as const,
    blockers: plan.blockers,
  };
}
