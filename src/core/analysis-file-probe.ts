import { z } from "zod";
import {
  launchHashSchema,
  launchRunIdSchema,
  launchSha256,
} from "./analysis-launch-plan.js";

export const probeCases = [
  "ALLOW_READ",
  "ALLOW_WRITE",
  "DENY_READ",
  "DENY_APPEND",
  "DENY_CREATE",
  "DENY_DELETE",
  "DENY_RENAME",
] as const;
export const probeCaseSchema = z.enum(probeCases);
export type ProbeCase = z.infer<typeof probeCaseSchema>;
export const probeMutation = "FILE_PROBE_MUTATION_V1\n";
export const probeTargets: Record<ProbeCase, string> = {
  ALLOW_READ: "input/allow.txt",
  ALLOW_WRITE: "scratch/write.txt",
  DENY_READ: "private/read.txt",
  DENY_APPEND: "private/append.txt",
  DENY_CREATE: "private/create.txt",
  DENY_DELETE: "private/delete.txt",
  DENY_RENAME: "private/rename.txt",
};
export const probeFileNames = [
  "fixture-marker.txt",
  "manifest.json",
  "input/allow.txt",
  "scratch/write.txt",
  "private/read.txt",
  "private/append.txt",
  "private/create.txt",
  "private/delete.txt",
  "private/rename.txt",
  "private/renamed.txt",
] as const;
export type ProbeSnapshot = Record<
  (typeof probeFileNames)[number],
  string | null
>;
export const probeSourceFiles = {
  sharedHeader: "src/native/file-probe-common.hpp",
  validatorHeader: "src/native/analysis-validator-contract.hpp",
  probe: "src/native/analysis-file-probe.cpp",
  lifecycle: "src/native/isolation-lifecycle.hpp",
  backendHeader: "src/native/isolation-win32.hpp",
  backend: "src/native/isolation-win32.cpp",
  controller: "src/native/isolation-controller.cpp",
  buildScript: "scripts/build-analysis-file-probe.mjs",
  contract: "dist/runtime/src/core/analysis-file-probe.js",
  host: "dist/runtime/src/server/analysis-file-probe-files.js",
  cli: "dist/runtime/src/server/analysis-file-probe-cli.js",
  sharedFiles: "dist/runtime/src/server/analysis-launch-files.js",
  sharedPlan: "dist/runtime/src/core/analysis-launch-plan.js",
  pe: "dist/runtime/src/core/analysis-native-contract.js",
  lockfile: "package-lock.json",
} as const;
export const probeBuildSchema = z.strictObject({
  version: z.literal("FILE_PROBE_BUILD_V1"),
  buildId: launchRunIdSchema,
  sourceHashes: z.record(z.string(), launchHashSchema),
  toolHashes: z.record(z.string(), launchHashSchema),
  artifacts: z.strictObject({
    probe: z.strictObject({
      file: z.literal("analysis-file-probe.exe"),
      sha256: launchHashSchema,
      bytes: z.number().int().positive().max(2097152),
    }),
    controller: z.strictObject({
      file: z.literal("analysis-isolation-controller.exe"),
      sha256: launchHashSchema,
      bytes: z.number().int().positive().max(2097152),
    }),
  }),
  evidence: z.record(z.string(), launchHashSchema),
  osExecutionAllowed: z.literal(false),
  win32BackendExecuted: z.literal(false),
});
export type ProbeBuild = z.infer<typeof probeBuildSchema>;
export const probeJson = (data: unknown) =>
  JSON.stringify(data, null, 2) + "\n";
export function probeRequest(
  runId: string,
  caseId: ProbeCase,
  manifestSha: string,
) {
  launchRunIdSchema.parse(runId);
  probeCaseSchema.parse(caseId);
  launchHashSchema.parse(manifestSha);
  return Buffer.from(
    [
      "FILE_PROBE_REQUEST_V1",
      runId,
      caseId,
      manifestSha,
      "GENERATED_DUMMY_ONLY",
      "NO_OS_ATTESTATION",
      "END",
      "",
    ].join("\n"),
  );
}
export function probeContent(runId: string, file: string) {
  launchRunIdSchema.parse(runId);
  if (file === "fixture-marker.txt")
    return `FILE_PROBE_FIXTURE_V1\n${runId}\nNO_USER_DATA\n`;
  if (
    !Object.values(probeTargets).includes(file) ||
    file === "private/create.txt"
  )
    throw new Error("PROBE_UNKNOWN_INITIAL_FILE");
  return `FILE_PROBE_CANARY_V1\n${runId}\n${file}\n`;
}
export function probeManifest(
  runId: string,
  caseId: ProbeCase,
  buildId: string,
  buildSha: string,
) {
  probeRequest(runId, caseId, buildSha);
  launchRunIdSchema.parse(buildId);
  return {
    version: "FILE_PROBE_FIXTURE_V1",
    runId,
    caseId,
    buildId,
    buildSha256: buildSha,
    provenance: "GENERATED_DUMMY_ONLY",
    mode: "UNRESTRICTED_SELF_TEST",
    osIsolationVerified: false,
  } as const;
}
const outcomeSchema = z.enum([
  "READ",
  "APPENDED",
  "CREATED",
  "DELETED",
  "RENAMED",
  "ERROR",
]);
const receiptSchema = z.strictObject({
  version: z.literal("FILE_PROBE_RECEIPT_V1"),
  runId: launchRunIdSchema,
  caseId: probeCaseSchema,
  requestSha256: launchHashSchema,
  attempted: z.boolean(),
  outcome: outcomeSchema,
  stage: z.enum(["PREFLIGHT", "OPEN", "GUARD", "IO", "HASH", "NONE"]),
  win32Error: z.number().int().min(0).max(4294967295),
  bytesWritten: z.number().int().min(0).max(Buffer.byteLength(probeMutation)),
  observedSha256: launchHashSchema.nullable(),
  osIsolationVerified: z.literal(false),
});
export type ProbeReceipt = z.infer<typeof receiptSchema>;
const outcomes: Record<ProbeCase, ProbeReceipt["outcome"]> = {
  ALLOW_READ: "READ",
  ALLOW_WRITE: "APPENDED",
  DENY_READ: "READ",
  DENY_APPEND: "APPENDED",
  DENY_CREATE: "CREATED",
  DENY_DELETE: "DELETED",
  DENY_RENAME: "RENAMED",
};
export function parseProbeReceipt(
  wire: Buffer,
  runId: string,
  caseId: ProbeCase,
  request: Buffer,
) {
  if (!wire.length || wire.length > 2048) throw new Error("PROBE_RECEIPT_SIZE");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(wire);
  const receipt = receiptSchema.parse(JSON.parse(text));
  if (
    text !== JSON.stringify(receipt) + "\n" ||
    receipt.runId !== runId ||
    receipt.caseId !== caseId ||
    receipt.requestSha256 !== launchSha256(request)
  )
    throw new Error("PROBE_RECEIPT_BINDING");
  if (receipt.outcome === "ERROR") {
    if (
      !receipt.win32Error ||
      receipt.stage === "NONE" ||
      (receipt.attempted
        ? receipt.stage === "PREFLIGHT"
        : receipt.stage !== "PREFLIGHT") ||
      receipt.observedSha256 !== null ||
      (receipt.stage !== "IO" && receipt.bytesWritten)
    )
      throw new Error("PROBE_ERROR_CONTRACT");
  } else {
    const read = receipt.outcome === "READ";
    const writes =
      receipt.outcome === "APPENDED" || receipt.outcome === "CREATED";
    if (
      !receipt.attempted ||
      receipt.stage !== "NONE" ||
      receipt.win32Error !== 0 ||
      receipt.outcome !== outcomes[caseId] ||
      (read
        ? receipt.observedSha256 === null
        : receipt.observedSha256 !== null) ||
      receipt.bytesWritten !== (writes ? Buffer.byteLength(probeMutation) : 0)
    )
      throw new Error("PROBE_SUCCESS_CONTRACT");
  }
  return receipt;
}
export function expectedProbeSnapshot(
  before: ProbeSnapshot,
  runId: string,
  caseId: ProbeCase,
): ProbeSnapshot {
  const after = { ...before };
  const target = probeTargets[caseId] as keyof ProbeSnapshot;
  if (caseId === "ALLOW_WRITE" || caseId === "DENY_APPEND")
    after[target] = launchSha256(probeContent(runId, target) + probeMutation);
  if (caseId === "DENY_CREATE") after[target] = launchSha256(probeMutation);
  if (caseId === "DENY_DELETE") after[target] = null;
  if (caseId === "DENY_RENAME") {
    after["private/renamed.txt"] = before[target];
    after[target] = null;
  }
  return after;
}
export function classifyProbe(
  receipt: ProbeReceipt,
  before: ProbeSnapshot,
  after: ProbeSnapshot,
  runId: string,
) {
  if (receipt.runId !== runId) return "INCONCLUSIVE" as const;
  const unchanged = probeJson(before) === probeJson(after);
  if (receipt.caseId.startsWith("DENY_") && !unchanged)
    return "EXPOSURE_DETECTED" as const;
  if (receipt.outcome === "ERROR")
    return receipt.attempted &&
      ["OPEN", "IO"].includes(receipt.stage) &&
      receipt.win32Error === 5 &&
      unchanged &&
      receipt.caseId.startsWith("DENY_")
      ? ("DENIAL_REPORTED_NOT_OS_ATTESTED" as const)
      : ("INCONCLUSIVE" as const);
  if (
    probeJson(after) !==
    probeJson(expectedProbeSnapshot(before, runId, receipt.caseId))
  )
    return "INCONCLUSIVE" as const;
  if (
    receipt.outcome === "READ" &&
    receipt.observedSha256 !==
      before[probeTargets[receipt.caseId] as keyof ProbeSnapshot]
  )
    return "INCONCLUSIVE" as const;
  return receipt.caseId.startsWith("ALLOW_")
    ? ("ALLOW_OBSERVED" as const)
    : ("EXPOSURE_DETECTED" as const);
}
export function parseProbeCommand(args: readonly string[]) {
  if (args.length !== 3 || args[0] !== "self-test")
    throw new Error("PROBE_SELF_TEST_ONLY");
  return {
    buildId: launchRunIdSchema.parse(args[1]),
    buildSha: launchHashSchema.parse(args[2]),
  };
}
