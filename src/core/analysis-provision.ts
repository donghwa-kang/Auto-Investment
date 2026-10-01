import { z } from "zod";
import { win32 } from "node:path";
import {
  launchRunIdSchema,
  launchHashSchema,
  launchSha256,
  launchLayout,
  requireLaunchLocalPath,
} from "./analysis-launch-plan.js";
import { probeJson } from "./analysis-file-probe.js";

export const securityKinds = [
  "HOST",
  "TRAVERSE",
  "READ",
  "EXECUTE",
  "APPEND",
] as const;
export type SecurityKind = (typeof securityKinds)[number];
const hostSidSchema = z
  .string()
  .regex(/^S-1-5-21-(?:[1-9][0-9]{0,9}-){3}[1-9][0-9]{0,9}$/);
const appSidSchema = z
  .string()
  .regex(/^S-1-15-2-(?:[0-9]{1,10}-){6}[0-9]{1,10}$/);
function sidNumbers(sid: string) {
  if (
    sid
      .split("-")
      .slice(3)
      .some((n) => !/^(?:0|[1-9][0-9]*)$/.test(n) || Number(n) > 4294967295)
  )
    throw new Error("PROVISION_SID_RANGE");
  return sid;
}
export function provisionSddl(
  kind: SecurityKind,
  hostSid: string,
  appSid: string,
) {
  z.enum(securityKinds).parse(kind);
  sidNumbers(hostSidSchema.parse(hostSid));
  sidNumbers(appSidSchema.parse(appSid));
  const mask: Record<SecurityKind, string | null> = {
    HOST: null,
    TRAVERSE: "0x001200a9",
    READ: "0x00120089",
    EXECUTE: "0x001200a9",
    APPEND: "0x00100084",
  };
  return `O:${hostSid}D:P(A;;0x001f01ff;;;S-1-5-18)(A;;0x001f01ff;;;${hostSid})${mask[kind] ? `(A;;${mask[kind]};;;${appSid})` : ""}S:P(ML;;NW;;;${kind === "APPEND" ? "LW" : "ME"})`;
}
export const provisionTargets = [
  [".", "directory", "TRAVERSE"],
  ["bin", "directory", "TRAVERSE"],
  ["input", "directory", "TRAVERSE"],
  ["private", "directory", "HOST"],
  ["scratch", "directory", "TRAVERSE"],
  ["profile", "directory", "HOST"],
  ["evidence", "directory", "HOST"],
  ["fixture-marker.txt", "file", "READ"],
  ["manifest.json", "file", "HOST"],
  ["bin/analysis-file-probe.exe", "file", "EXECUTE"],
  ["input/allow.txt", "file", "READ"],
  ["scratch/write.txt", "file", "APPEND"],
  ["private/read.txt", "file", "HOST"],
  ["private/append.txt", "file", "HOST"],
  ["private/delete.txt", "file", "HOST"],
  ["private/rename.txt", "file", "HOST"],
] as const;
export const provisionSourceFiles = {
  nativeHeader: "src/native/provision-security.hpp",
  native: "src/native/analysis-provision-inspect.cpp",
  common: "src/native/file-probe-common.hpp",
  validator: "src/native/analysis-validator-contract.hpp",
  core: "dist/runtime/src/core/analysis-provision.js",
  recovery: "dist/runtime/src/core/analysis-provision-recovery.js",
  host: "dist/runtime/src/server/analysis-provision-files.js",
  cli: "dist/runtime/src/server/analysis-provision-cli.js",
  sharedFiles: "dist/runtime/src/server/analysis-launch-files.js",
  sharedPlan: "dist/runtime/src/core/analysis-launch-plan.js",
  probeCore: "dist/runtime/src/core/analysis-file-probe.js",
  probeFiles: "dist/runtime/src/server/analysis-file-probe-files.js",
  pe: "dist/runtime/src/core/analysis-native-contract.js",
  buildScript: "scripts/build-analysis-provision.mjs",
  lockfile: "package-lock.json",
} as const;
export const provisionBuildSchema = z.strictObject({
  version: z.literal("PROVISION_INSPECT_BUILD_V1"),
  buildId: launchRunIdSchema,
  sourceHashes: z.record(z.string(), launchHashSchema),
  toolHashes: z.record(z.string(), launchHashSchema),
  artifact: z.strictObject({
    file: z.literal("analysis-provision-inspect.exe"),
    bytes: z.number().int().positive().max(2097152),
    sha256: launchHashSchema,
  }),
  evidence: z.strictObject({
    headers: launchHashSchema,
    imports: launchHashSchema,
    loadconfig: launchHashSchema,
    commands: launchHashSchema,
  }),
  osMutationBackend: z.literal("ABSENT"),
  executionAllowed: z.literal(false),
});
export function provisionRequest(runId: string) {
  launchRunIdSchema.parse(runId);
  return Buffer.from(`PROVISION_INSPECT_V1\n${runId}\nEND\n`);
}
const inspectionSchema = z.strictObject({
  version: z.literal("PROVISION_INSPECTION_V1"),
  runId: launchRunIdSchema,
  requestSha256: launchHashSchema,
  hostSid: hostSidSchema,
  appSid: appSidSchema,
  descriptors: z
    .array(
      z.strictObject({
        kind: z.enum(securityKinds),
        sddlSha256: launchHashSchema,
        descriptorSha256: launchHashSchema,
        bytes: z.number().int().min(40).max(4096),
      }),
    )
    .length(securityKinds.length),
  memoryStructureVerified: z.literal(true),
  profileExistence: z.literal("NOT_QUERIED"),
  osChangesApplied: z.literal(false),
  osIsolationVerified: z.literal(false),
});
export type ProvisionInspection = z.infer<typeof inspectionSchema>;
export function parseProvisionInspection(bytes: Uint8Array, runId: string) {
  if (!bytes.length || bytes.length > 8192)
    throw new Error("PROVISION_INSPECTION_SIZE");
  const wire = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const value = inspectionSchema.parse(JSON.parse(wire));
  if (
    wire !== JSON.stringify(value) + "\n" ||
    value.runId !== runId ||
    value.requestSha256 !== launchSha256(provisionRequest(runId))
  )
    throw new Error("PROVISION_INSPECTION_BINDING");
  value.descriptors.forEach((entry, i) => {
    if (
      entry.kind !== securityKinds[i] ||
      entry.sddlSha256 !==
        launchSha256(provisionSddl(entry.kind, value.hostSid, value.appSid))
    )
      throw new Error("PROVISION_DESCRIPTOR_BINDING");
  });
  return value;
}
export type ProvisionBinding = {
  buildId: string;
  buildSha256: string;
  probeBuildId: string;
  probeBuildSha256: string;
  probeSha256: string;
  codeHashes: Record<string, string>;
};
export function buildProvisionPlan(
  workspace: string,
  inspection: ProvisionInspection,
  binding: ProvisionBinding,
) {
  const { runId } = inspection;
  const inspected = parseProvisionInspection(
    Buffer.from(JSON.stringify(inspection) + "\n"),
    runId,
  );
  launchRunIdSchema.parse(binding.buildId);
  launchRunIdSchema.parse(binding.probeBuildId);
  for (const value of [
    binding.buildSha256,
    binding.probeBuildSha256,
    binding.probeSha256,
    ...Object.values(binding.codeHashes),
  ])
    launchHashSchema.parse(value);
  const paths = launchLayout(workspace, runId);
  return {
    version: "PROVISION_REVIEW_PLAN_V1",
    runId,
    scope: "DUMMY_FILE_PROBE_ONLY",
    workspace,
    proposedRunRoot: paths.run,
    binding,
    inspection: inspected,
    profile: {
      name: `PaperLab.Analysis.Offline.v1.${runId.replaceAll("-", "")}`,
      derivedSid: inspected.appSid,
      existence: "NOT_QUERIED",
      storagePath: null,
      registryLocation: null,
      creationReceipt: null,
      reuseExisting: false,
    },
    targets: provisionTargets.map(([relativePath, type, kind]) => ({
      relativePath,
      path: requireLaunchLocalPath(win32.join(paths.run, relativePath)),
      type,
      kind,
      currentObjectId: null,
      currentSecurity: null,
      initialSddl: provisionSddl("HOST", inspected.hostSid, inspected.appSid),
      proposedSddl: provisionSddl(kind, inspected.hostSid, inspected.appSid),
      inheritance: "NONE_EXPLICIT_PER_OBJECT",
      effectiveAccessVerified: false,
    })),
    absentTargets: ["private/create.txt", "private/renamed.txt"],
    rollback: {
      order: "STOP_VERIFY_PROCESS_THEN_REVERSE_SECURITY_THEN_OWNED_PROFILE",
      fileDeletion: "NEVER_AUTOMATIC",
      evidence: "KEEP_OUTSIDE_RUN",
      conflict: "HOLD_NO_OVERWRITE",
      profileDelete: "REQUIRES_CREATION_OWNERSHIP_AND_STORAGE_RECHECK",
      crashRecovery: "NOT_IMPLEMENTED",
    },
    approval: {
      status: "NOT_REQUESTED",
      executionAllowed: false,
      osMutationBackend: "ABSENT",
    },
    osChangesApplied: false,
    osIsolationVerified: false,
    realCodexEnabled: false,
    liveOrdersEnabled: false,
    blockers: [
      "PROFILE_STORAGE_COLLISION_UNRESOLVED",
      "NATIVE_MUTATION_AND_DURABLE_JOURNAL_NOT_IMPLEMENTED",
      "EXPLICIT_OS_CHANGE_APPROVAL_REQUIRED",
      "ACTUAL_ACL_AND_LPAC_ACCEPTANCE_NOT_RUN",
    ],
  } as const;
}
export type ProvisionPlan = ReturnType<typeof buildProvisionPlan>;
export function validateProvisionPlan(
  bytes: Uint8Array,
  expectedHash: string,
  expected: ProvisionPlan,
) {
  launchHashSchema.parse(expectedHash);
  if (
    !bytes.length ||
    bytes.length > 65536 ||
    launchSha256(bytes) !== expectedHash
  )
    throw new Error("PROVISION_PLAN_HASH_SIZE");
  if (
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !==
    probeJson(expected)
  )
    throw new Error("PROVISION_PLAN_CONTRACT");
  return expected;
}
export function parseProvisionCommand(args: readonly string[]) {
  if (args.length === 5 && args[0] === "prepare")
    return {
      action: "prepare" as const,
      buildId: launchRunIdSchema.parse(args[1]),
      buildSha: launchHashSchema.parse(args[2]),
      probeBuildId: launchRunIdSchema.parse(args[3]),
      probeBuildSha: launchHashSchema.parse(args[4]),
    };
  if (args.length === 3 && args[0] === "check")
    return {
      action: "check" as const,
      runId: launchRunIdSchema.parse(args[1]),
      manifestSha: launchHashSchema.parse(args[2]),
    };
  throw new Error("PROVISION_PREPARE_CHECK_ONLY");
}
