import { z } from "zod";
import {
  launchHashSchema,
  launchRunIdSchema,
  launchSha256,
} from "./analysis-launch-plan.js";
import { type PermissionIntent } from "./analysis-permission-journal.js";
import { type ProvisionPlan } from "./analysis-provision.js";

export const bridgeSources = [
  "src/native/permission-mutation.hpp",
  "src/native/permission-win32.cpp",
  "src/native/analysis-permission-bridge.cpp",
  "src/native/provision-security.hpp",
  "src/native/file-probe-common.hpp",
  "src/native/analysis-validator-contract.hpp",
  "scripts/build-analysis-permission-bridge.mjs",
  "package-lock.json",
] as const;
export const bridgeHostFiles = [
  "dist/runtime/src/core/analysis-permission-bridge.js",
  "dist/runtime/src/core/analysis-permission-journal.js",
  "dist/runtime/src/server/analysis-permission-bridge-files.js",
  "dist/runtime/src/server/analysis-permission-bridge-runner.js",
  "dist/runtime/src/server/analysis-permission-bridge-cli.js",
  "dist/runtime/src/server/analysis-permission-journal-files.js",
  "dist/runtime/src/server/analysis-launch-files.js",
] as const;
export const bridgeBuildSchema = z.strictObject({
  version: z.literal("PERMISSION_BRIDGE_BUILD_V1"),
  buildId: launchRunIdSchema,
  sourceHashes: z.record(z.string(), launchHashSchema),
  toolHashes: z.record(z.string(), launchHashSchema),
  artifact: z.strictObject({
    file: z.literal("analysis-permission-bridge.exe"),
    bytes: z.number().int().positive().max(2097152),
    sha256: launchHashSchema,
  }),
  evidence: z.strictObject({
    headers: launchHashSchema,
    imports: launchHashSchema,
    loadconfig: launchHashSchema,
    commands: launchHashSchema,
  }),
  osMutationBackend: z.literal("COMPILED_LOCKED"),
  executionAllowed: z.literal(false),
});
export function bridgeDummy(labId: string, index: number) {
  return `BRIDGE_DUMMY_V1\n${labId}\n${index}\n`;
}
export function bridgeInit(
  labId: string,
  plan: ProvisionPlan,
  planSha256: string,
) {
  launchRunIdSchema.parse(labId);
  launchHashSchema.parse(planSha256);
  return `BRIDGE_MODEL_V1 ${labId} ${plan.runId} ${planSha256} ${launchSha256(plan.inspection.hostSid)}\n`;
}
// Exact counterpart of permission_mutation::intent_hash; JSON hashing is a different contract.
export function nativeIntentDigest(
  plan: ProvisionPlan,
  planSha256: string,
  intent: PermissionIntent,
) {
  return launchSha256(
    [
      plan.runId,
      intent.operationId,
      planSha256,
      intent.objectId,
      launchSha256(Buffer.from(plan.proposedRunRoot, "utf16le")),
      String(intent.targetIndex),
      intent.direction,
      intent.expectedSha256,
      intent.desiredSha256,
      "",
    ].join("\n"),
  );
}
export function parseBridgeReady(
  line: string,
  init: string,
  nodeIds: readonly string[],
) {
  const fields = line.split(" ");
  if (
    fields.length !== 35 ||
    fields[0] !== "READY" ||
    fields[1] !== launchSha256(init) ||
    fields[2] !== init.trimEnd().split(" ")[4]
  )
    throw new Error("BRIDGE_READY_BINDING");
  const objectIds = nodeIds.map((id, index) => {
    if (fields[3 + index * 2] !== id)
      throw new Error("BRIDGE_CREATED_IDENTITY");
    return launchHashSchema.parse(fields[4 + index * 2]);
  });
  if (objectIds.length !== 16 || new Set(objectIds).size !== 16)
    throw new Error("BRIDGE_ID_REUSE");
  return objectIds;
}
