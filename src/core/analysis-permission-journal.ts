import { z } from "zod";
import {
  launchHashSchema,
  launchRunIdSchema,
  launchSha256,
} from "./analysis-launch-plan.js";
import {
  buildProvisionPlan,
  validateProvisionPlan,
  type ProvisionPlan,
} from "./analysis-provision.js";
import { probeJson } from "./analysis-file-probe.js";

export const journalJson = (value: unknown) => JSON.stringify(value) + "\n";
const targetSchema = z.strictObject({
  index: z.number().int().min(0).max(15),
  relativePath: z.string().min(1).max(80),
  beforeSha256: launchHashSchema,
  appliedSha256: launchHashSchema,
});
export const journalBindingSchema = z.strictObject({
  version: z.literal("PERMISSION_JOURNAL_V1"),
  mode: z.literal("MODEL_ONLY"),
  runId: launchRunIdSchema,
  planSha256: launchHashSchema,
  targets: z.array(targetSchema).length(16),
});
export type JournalBinding = z.infer<typeof journalBindingSchema>;
export function permissionJournalBinding(plan: ProvisionPlan): JournalBinding {
  const expected = buildProvisionPlan(
    plan.workspace,
    plan.inspection,
    plan.binding,
  );
  validateProvisionPlan(
    Buffer.from(probeJson(plan)),
    launchSha256(probeJson(plan)),
    expected,
  );
  return journalBindingSchema.parse({
    version: "PERMISSION_JOURNAL_V1",
    mode: "MODEL_ONLY",
    runId: plan.runId,
    planSha256: launchSha256(probeJson(plan)),
    targets: plan.targets.map((t, index) => ({
      index,
      relativePath: t.relativePath,
      beforeSha256: launchSha256(t.initialSddl),
      appliedSha256: launchSha256(t.proposedSddl),
    })),
  });
}
export const permissionIntentSchema = z.strictObject({
  operationId: launchRunIdSchema,
  targetIndex: z.number().int().min(0).max(15),
  direction: z.enum(["APPLY", "RESTORE"]),
  objectId: launchHashSchema,
  expectedSha256: launchHashSchema,
  desiredSha256: launchHashSchema,
});
export type PermissionIntent = z.infer<typeof permissionIntentSchema>;
const beforeSchema = z.strictObject({
  type: z.literal("BEFORE"),
  intent: permissionIntentSchema,
});
const afterSchema = z.strictObject({
  type: z.literal("AFTER"),
  operationId: launchRunIdSchema,
  outcome: z.enum(["VERIFIED", "UNCERTAIN"]),
  observedSha256: launchHashSchema.nullable(),
});
export const permissionEventSchema = z.discriminatedUnion("type", [
  beforeSchema,
  afterSchema,
]);
export type PermissionEvent = z.infer<typeof permissionEventSchema>;
const recordSchema = z.strictObject({
  sequence: z.number().int().min(1).max(128),
  previousSha256: launchHashSchema,
  event: permissionEventSchema,
  sha256: launchHashSchema,
});
export function permissionRecord(
  sequence: number,
  previousSha256: string,
  event: PermissionEvent,
) {
  const body = {
    sequence,
    previousSha256,
    event: permissionEventSchema.parse(event),
  };
  return recordSchema.parse({
    ...body,
    sha256: launchSha256(journalJson(body)),
  });
}

// 이 해시 체인은 서명이나 OS 증명이 아니다. 외부에서 보관한 head와 함께 대조한다.
export function replayPermissionJournal(
  binding: JournalBinding,
  bytes: Buffer,
) {
  journalBindingSchema.parse(binding);
  if (bytes.length > 131072) throw new Error("JOURNAL_SIZE");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  if (text && !text.endsWith("\n"))
    throw new Error("JOURNAL_PARTIAL_RECORD_HOLD");
  const lines = text ? text.slice(0, -1).split("\n") : [];
  if (lines.length > 128) throw new Error("JOURNAL_RECORD_LIMIT");
  let head = launchSha256(journalJson(binding));
  let pending: PermissionIntent | null = null;
  let uncertain = false,
    restoring = false;
  const stack: PermissionIntent[] = [],
    operations = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const row = recordSchema.parse(JSON.parse(line));
    const expected = permissionRecord(index + 1, head, row.event);
    if (
      journalJson(row) !== line + "\n" ||
      journalJson(row) !== journalJson(expected)
    )
      throw new Error("JOURNAL_CHAIN_HOLD");
    if (uncertain) throw new Error("JOURNAL_AFTER_UNCERTAIN_HOLD");
    if (row.event.type === "BEFORE") {
      const intent = row.event.intent,
        target = binding.targets[intent.targetIndex];
      if (!target || pending || operations.has(intent.operationId))
        throw new Error("JOURNAL_DUPLICATE_OR_PENDING_HOLD");
      const apply = intent.direction === "APPLY",
        last = stack.at(-1);
      if (
        apply
          ? restoring || intent.targetIndex !== stack.length
          : !last ||
            last.targetIndex !== intent.targetIndex ||
            last.objectId !== intent.objectId
      )
        throw new Error("JOURNAL_ORDER_IDENTITY_HOLD");
      if (
        intent.expectedSha256 !==
          (apply ? target.beforeSha256 : target.appliedSha256) ||
        intent.desiredSha256 !==
          (apply ? target.appliedSha256 : target.beforeSha256)
      )
        throw new Error("JOURNAL_SECURITY_HOLD");
      if (apply && stack.some((p) => p.objectId === intent.objectId))
        throw new Error("JOURNAL_OBJECT_REUSE_HOLD");
      operations.add(intent.operationId);
      pending = intent;
      if (!apply) restoring = true;
    } else {
      if (!pending || row.event.operationId !== pending.operationId)
        throw new Error("JOURNAL_AFTER_WITHOUT_BEFORE_HOLD");
      if (row.event.outcome === "VERIFIED") {
        if (row.event.observedSha256 !== pending.desiredSha256)
          throw new Error("JOURNAL_POST_STATE_HOLD");
        if (pending.direction === "APPLY") stack.push(pending);
        else stack.pop();
        pending = null;
      } else uncertain = true;
    }
    head = row.sha256;
  }
  return {
    head,
    sequence: lines.length,
    pending,
    uncertain,
    appliedCount: stack.length,
    status:
      pending || uncertain
        ? ("RECOVERY_HOLD" as const)
        : ("MODEL_RECORDS_VERIFIED" as const),
    executionAllowed: false,
    osChangesApplied: false,
    osRecoveryVerified: false,
  };
}
