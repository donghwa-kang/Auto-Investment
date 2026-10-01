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

const entrySchema = z.strictObject({
  relativePath: z.string().max(80),
  objectId: launchHashSchema,
  createdByRunId: launchRunIdSchema,
  beforeSecuritySha256: launchHashSchema,
  appliedSecuritySha256: launchHashSchema,
  phase: z.enum(["RECORDED", "APPLY_STARTED", "APPLIED", "RESTORED"]),
});
const journalSchema = z.strictObject({
  version: z.literal("PROVISION_MODEL_JOURNAL_V1"),
  runId: launchRunIdSchema,
  planSha256: launchHashSchema,
  mode: z.literal("MODEL_ONLY"),
  entries: z.array(entrySchema).max(16),
  profile: z.enum([
    "NOT_ATTEMPTED",
    "CREATE_STARTED",
    "CREATED",
    "ALREADY_EXISTS",
    "FAILED_UNCERTAIN",
    "DELETE_STARTED",
    "DELETED",
  ]),
  creationReceipt: z
    .strictObject({
      runId: launchRunIdSchema,
      name: z.string(),
      sid: z.string(),
      storageIdentity: z.string(),
      creationResult: z.literal("CREATED_NEW"),
    })
    .nullable(),
});
const observationSchema = z.strictObject({
  mode: z.literal("MODEL_ONLY"),
  runId: launchRunIdSchema,
  processState: z.enum([
    "NEVER_STARTED",
    "EXITED_VERIFIED",
    "RUNNING",
    "UNKNOWN",
  ]),
  objects: z
    .array(
      z.strictObject({
        relativePath: z.string(),
        objectId: launchHashSchema,
        securitySha256: launchHashSchema,
        linksVerified: z.boolean(),
      }),
    )
    .max(16),
  profile: z.strictObject({
    status: z.enum(["ABSENT_VERIFIED", "OWNED_VERIFIED", "OTHER", "UNKNOWN"]),
    name: z.string().nullable(),
    sid: z.string().nullable(),
    storageIdentity: z.string().nullable(),
    handlesClosed: z.boolean(),
  }),
});
export type ProvisionJournal = z.infer<typeof journalSchema>;
export type RecoveryObservation = z.infer<typeof observationSchema>;
export type RecoveryAction =
  | {
      kind: "RESTORE_SECURITY";
      relativePath: string;
      objectId: string;
      expectedCurrentSha256: string;
      restoreSha256: string;
    }
  | {
      kind: "DELETE_OWNED_MODEL_PROFILE";
      name: string;
      sid: string;
      storageIdentity: string;
    };
export function planProvisionRecovery(
  plan: ProvisionPlan,
  rawJournal: unknown,
  rawObservation: unknown,
) {
  const actions: RecoveryAction[] = [],
    reasons: string[] = [];
  const hold = (reason: string) => {
    reasons.push(reason);
  };
  try {
    validateProvisionPlan(
      Buffer.from(probeJson(plan)),
      launchSha256(probeJson(plan)),
      buildProvisionPlan(plan.workspace, plan.inspection, plan.binding),
    );
    const journal = journalSchema.parse(rawJournal),
      observation = observationSchema.parse(rawObservation);
    if (
      journal.runId !== plan.runId ||
      observation.runId !== plan.runId ||
      journal.planSha256 !== launchSha256(probeJson(plan))
    )
      throw new Error("BINDING");
    if (
      !["NEVER_STARTED", "EXITED_VERIFIED"].includes(observation.processState)
    )
      hold("PROCESS_NOT_STOPPED");
    if (journal.entries.length !== observation.objects.length)
      throw new Error("MISSING_OBJECT");
    const ids = new Set<string>();
    for (let i = 0; i < journal.entries.length; i++) {
      const entry = journal.entries[i]!,
        target = plan.targets[i]!,
        observed = observation.objects[i]!;
      if (
        entry.relativePath !== target.relativePath ||
        observed.relativePath !== target.relativePath ||
        entry.createdByRunId !== plan.runId ||
        ids.has(entry.objectId) ||
        entry.beforeSecuritySha256 !== launchSha256(target.initialSddl) ||
        entry.appliedSecuritySha256 !== launchSha256(target.proposedSddl)
      )
        throw new Error("ENTRY_BINDING");
      ids.add(entry.objectId);
      if (!observed.linksVerified || observed.objectId !== entry.objectId) {
        hold("OBJECT_IDENTITY_CONFLICT");
        continue;
      }
      if (observed.securitySha256 === entry.beforeSecuritySha256) continue;
      if (
        observed.securitySha256 !== entry.appliedSecuritySha256 ||
        !["APPLY_STARTED", "APPLIED"].includes(entry.phase)
      ) {
        hold("SECURITY_STATE_CONFLICT");
        continue;
      }
      actions.unshift({
        kind: "RESTORE_SECURITY",
        relativePath: entry.relativePath,
        objectId: entry.objectId,
        expectedCurrentSha256: entry.appliedSecuritySha256,
        restoreSha256: entry.beforeSecuritySha256,
      });
    }
    const profile = observation.profile;
    if (
      [
        "CREATE_STARTED",
        "ALREADY_EXISTS",
        "FAILED_UNCERTAIN",
        "DELETE_STARTED",
      ].includes(journal.profile)
    )
      hold("PROFILE_OWNERSHIP_UNCERTAIN");
    if (journal.profile === "NOT_ATTEMPTED") {
      if (
        journal.creationReceipt !== null ||
        profile.status !== "ABSENT_VERIFIED" ||
        profile.name !== null ||
        profile.sid !== null ||
        profile.storageIdentity !== null ||
        !profile.handlesClosed ||
        actions.length !== 0
      )
        hold("UNOWNED_PROFILE");
    } else if (journal.profile === "CREATED" || journal.profile === "DELETED") {
      const receipt = journal.creationReceipt;
      if (
        !receipt ||
        receipt.runId !== plan.runId ||
        receipt.name !== plan.profile.name ||
        receipt.sid !== plan.profile.derivedSid ||
        receipt.storageIdentity !== `MODEL_STORAGE:${plan.runId}`
      )
        hold("CREATION_RECEIPT_INVALID");
      else if (!profile.handlesClosed) hold("PROFILE_HANDLES_OPEN");
      else if (
        profile.status === "OWNED_VERIFIED" &&
        journal.profile === "CREATED" &&
        profile.name === receipt.name &&
        profile.sid === receipt.sid &&
        profile.storageIdentity === receipt.storageIdentity
      )
        actions.push({
          kind: "DELETE_OWNED_MODEL_PROFILE",
          name: receipt.name,
          sid: receipt.sid,
          storageIdentity: receipt.storageIdentity,
        });
      else if (
        profile.status !== "ABSENT_VERIFIED" ||
        profile.name !== null ||
        profile.sid !== null ||
        profile.storageIdentity !== null
      )
        hold("PROFILE_STATE_CONFLICT");
    }
  } catch {
    hold("INVALID_OR_INCOMPLETE_EVIDENCE");
  }
  return {
    status: reasons.length
      ? "MODEL_RECOVERY_HOLD"
      : actions.length
        ? "MODEL_RECOVERY_READY"
        : "MODEL_NO_CHANGES",
    actions: reasons.length ? [] : actions,
    reasons,
    executionAllowed: false as const,
    osChangesApplied: false as const,
    osRecoveryVerified: false as const,
  };
}

// No backend/callback/OS handle exists here. These are cloned model records only.
export function simulateProvisionRecovery(
  plan: ProvisionPlan,
  journal: ProvisionJournal,
  observation: RecoveryObservation,
  failAt: number | null = null,
  failureTiming: "BEFORE" | "AFTER" = "BEFORE",
  profileRemovalObserved = true,
) {
  if (
    failAt !== null &&
    (!Number.isSafeInteger(failAt) || failAt < 0 || failAt > 16)
  )
    throw new Error("MODEL_FAILURE_INDEX");
  if (failureTiming !== "BEFORE" && failureTiming !== "AFTER")
    throw new Error("MODEL_FAILURE_TIMING");
  if (typeof profileRemovalObserved !== "boolean")
    throw new Error("MODEL_FAILURE_VALUE");
  const decision = planProvisionRecovery(plan, journal, observation);
  const after = structuredClone(observation),
    completed: RecoveryAction[] = [];
  if (decision.status === "MODEL_RECOVERY_HOLD")
    return {
      status: "MODEL_RECOVERY_HOLD",
      after,
      completed,
      decision,
      osRecoveryVerified: false,
    };
  for (let i = 0; i < decision.actions.length; i++) {
    if (failAt === i && failureTiming === "BEFORE")
      return {
        status: "MODEL_RECOVERY_PARTIAL",
        after,
        completed,
        decision,
        osRecoveryVerified: false,
      };
    const action = decision.actions[i]!;
    if (action.kind === "RESTORE_SECURITY") {
      const current = after.objects.find(
        (o) => o.relativePath === action.relativePath,
      );
      if (
        !current ||
        current.objectId !== action.objectId ||
        current.securitySha256 !== action.expectedCurrentSha256
      )
        return {
          status: "MODEL_RECOVERY_HOLD",
          after,
          completed,
          decision,
          osRecoveryVerified: false,
        };
      current.securitySha256 = action.restoreSha256;
    } else if (profileRemovalObserved)
      after.profile = {
        status: "ABSENT_VERIFIED",
        name: null,
        sid: null,
        storageIdentity: null,
        handlesClosed: true,
      };
    else
      return {
        status: "MODEL_RECOVERY_PARTIAL",
        after,
        completed,
        decision,
        osRecoveryVerified: false,
      };
    completed.push(action);
    if (failAt === i && failureTiming === "AFTER")
      return {
        status: "MODEL_RECOVERY_PARTIAL",
        after,
        completed,
        decision,
        osRecoveryVerified: false,
      };
  }
  const verified = planProvisionRecovery(plan, journal, after);
  return {
    status:
      verified.status === "MODEL_NO_CHANGES"
        ? "MODEL_RECOVERED"
        : "MODEL_RECOVERY_HOLD",
    after,
    completed,
    decision,
    osRecoveryVerified: false,
  };
}
