import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { z } from "zod";

export const launchRunIdSchema = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
export const launchHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const launchCodeSchema = z.strictObject({
  core: launchHashSchema,
  files: launchHashSchema,
  cli: launchHashSchema,
  lockfile: launchHashSchema,
});
export type LaunchCodeHashes = z.infer<typeof launchCodeSchema>;
export const launchSha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

// Windows 별칭/ADS/UNC/장치 경로/끝 공백은 거절한다. 실재 여부는 별도 계층에서 검사한다.
export function requireLaunchLocalPath(path: string): string {
  if (
    !/^[A-Z]:\\/.test(path) ||
    path.length > 220 ||
    win32.normalize(path) !== path ||
    path.endsWith("\\") ||
    path
      .slice(3)
      .split("\\")
      .some(
        (part) =>
          !part ||
          /[\x00-\x1f<>:"/|?*]/.test(part) ||
          /[ .]$/.test(part) ||
          /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(
            part,
          ),
      )
  )
    throw new Error("LAUNCH_LOCAL_PATH_REQUIRED");
  return path;
}

const intents = [
  ["bin", "READ_EXECUTE_FIXED_ARTIFACTS"],
  ["input", "READ_ONLY"],
  ["private", "NO_CONTAINER_ACCESS"],
  ["scratch", "TEMPORARY_WRITE"],
  ["profile", "ISOLATED_EMPTY_STATE"],
  ["evidence", "HOST_ONLY"],
] as const;
export function launchLayout(workspace: string, runId: string) {
  requireLaunchLocalPath(workspace);
  launchRunIdSchema.parse(runId);
  const bundleParent = win32.join(workspace, "work", "analysis-launch-plans");
  const bundle = win32.join(bundleParent, `plan-${runId}`);
  const runParent = win32.join(workspace, "work", "analysis-os-lab");
  const run = win32.join(runParent, `run-${runId}`);
  for (const path of [bundleParent, bundle, runParent, run])
    requireLaunchLocalPath(path);
  return { bundleParent, bundle, runParent, run };
}
export function launchDummyInput(runId: string) {
  launchRunIdSchema.parse(runId);
  return `ANALYSIS_LAUNCH_DUMMY_V1\n${runId}\nNO_USER_DATA\n`;
}
const planSchema = z.strictObject({
  version: z.literal("ANALYSIS_LAUNCH_PLAN_V1"),
  mode: z.literal("PREPARATION_ONLY"),
  runId: launchRunIdSchema,
  createdAt: z.iso.datetime(),
  workspace: z.string(),
  bundleRoot: z.string(),
  proposedRunRoot: z.string(),
  runtime: z.strictObject({
    platform: z.literal("win32"),
    node: z.literal("24.20.0"),
  }),
  codeHashes: launchCodeSchema,
  input: z.strictObject({
    file: z.literal("approved-input.txt"),
    bytes: z.number().int().positive().max(4096),
    sha256: launchHashSchema,
    provenance: z.literal("GENERATED_DUMMY_ONLY"),
  }),
  profile: z.strictObject({
    name: z.string().max(64),
    sid: z.null(),
    storagePath: z.null(),
    collisionCheck: z.literal("NOT_RUN"),
    capabilities: z.array(z.never()).length(0),
  }),
  targets: z
    .array(
      z.strictObject({
        role: z.string(),
        path: z.string(),
        accessIntent: z.string(),
        currentAcl: z.null(),
        effectiveAclVerified: z.literal(false),
      }),
    )
    .length(intents.length),
  limits: z.strictObject({
    activeProcesses: z.literal(1),
    commitMiB: z.literal(128),
    cpuMs: z.literal(2000),
    wallMs: z.literal(10000),
    outputBytes: z.literal(8192),
    childProcessesAllowed: z.literal(false),
    networkCapabilities: z.literal(false),
  }),
  execution: z.strictObject({
    allowed: z.literal(false),
    approval: z.literal("NOT_REQUESTED"),
    nativeArtifact: z.null(),
    nativeBuild: z.literal("NOT_VERIFIED"),
    osChangesApplied: z.literal(false),
    osIsolationVerified: z.literal(false),
    realCodexEnabled: z.literal(false),
  }),
  blockers: z.array(z.string()),
});
export type AnalysisLaunchPlan = z.infer<typeof planSchema>;
export type LaunchPlanContext = {
  workspace: string;
  runId: string;
  codeHashes: LaunchCodeHashes;
};

export function buildLaunchPlan(
  context: LaunchPlanContext & { createdAt: string },
): AnalysisLaunchPlan {
  const { workspace, runId } = context;
  const paths = launchLayout(workspace, runId);
  const input = launchDummyInput(runId);
  return planSchema.parse({
    version: "ANALYSIS_LAUNCH_PLAN_V1",
    mode: "PREPARATION_ONLY",
    runId,
    createdAt: context.createdAt,
    workspace,
    bundleRoot: paths.bundle,
    proposedRunRoot: paths.run,
    runtime: { platform: "win32", node: "24.20.0" },
    codeHashes: launchCodeSchema.parse(context.codeHashes),
    input: {
      file: "approved-input.txt",
      bytes: Buffer.byteLength(input),
      sha256: launchSha256(input),
      provenance: "GENERATED_DUMMY_ONLY",
    },
    profile: {
      name: `PaperLab.Analysis.Offline.v1.${runId.replaceAll("-", "")}`,
      sid: null,
      storagePath: null,
      collisionCheck: "NOT_RUN",
      capabilities: [],
    },
    targets: intents.map(([role, accessIntent]) => ({
      role,
      path: requireLaunchLocalPath(win32.join(paths.run, role)),
      accessIntent,
      currentAcl: null,
      effectiveAclVerified: false,
    })),
    limits: {
      activeProcesses: 1,
      commitMiB: 128,
      cpuMs: 2000,
      wallMs: 10000,
      outputBytes: 8192,
      childProcessesAllowed: false,
      networkCapabilities: false,
    },
    execution: {
      allowed: false,
      approval: "NOT_REQUESTED",
      nativeArtifact: null,
      nativeBuild: "NOT_VERIFIED",
      osChangesApplied: false,
      osIsolationVerified: false,
      realCodexEnabled: false,
    },
    blockers: [
      "NATIVE_ARTIFACT_NOT_BUILT",
      "PROFILE_SID_STORAGE_COLLISION_UNRESOLVED",
      "ACL_AND_SYSTEM_READ_SET_UNRESOLVED",
      "EXPLICIT_OS_CHANGE_APPROVAL_REQUIRED",
      "OS_ACCEPTANCE_TESTS_NOT_RUN",
      "CODEX_CONFIG_COMPATIBILITY_NOT_TESTED",
    ],
  });
}
export const serializeLaunchPlan = (plan: AnalysisLaunchPlan) =>
  JSON.stringify(plan, null, 2) + "\n";

// 별도로 지정된 해시와 고정 배치를 확인한다. 명세 자체의 허용 주장은 신뢰하지 않는다.
export function validateLaunchPlan(
  bytes: Uint8Array,
  expectedSha256: string,
  context: LaunchPlanContext,
): AnalysisLaunchPlan {
  launchHashSchema.parse(expectedSha256);
  if (
    !bytes.length ||
    bytes.length > 32768 ||
    launchSha256(bytes) !== expectedSha256
  )
    throw new Error("LAUNCH_MANIFEST_HASH_OR_SIZE");
  const source = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const plan = planSchema.parse(JSON.parse(source));
  const expected = buildLaunchPlan({ ...context, createdAt: plan.createdAt });
  if (source !== serializeLaunchPlan(expected))
    throw new Error("LAUNCH_MANIFEST_CONTRACT");
  return plan;
}

export type LaunchCommand =
  | { action: "prepare" }
  | {
      action: "check";
      runId: string;
      manifestSha256: string;
    };
export function parseLaunchCommand(args: readonly string[]): LaunchCommand {
  if (args.length === 1 && args[0] === "prepare") return { action: "prepare" };
  if (args.length === 3 && args[0] === "check")
    return {
      action: "check",
      runId: launchRunIdSchema.parse(args[1]),
      manifestSha256: launchHashSchema.parse(args[2]),
    };
  throw new Error("LAUNCH_PREPARATION_COMMAND_ONLY");
}
