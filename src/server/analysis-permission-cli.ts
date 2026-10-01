import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { launchSha256 } from "../core/analysis-launch-plan.js";
import { type ProvisionPlan } from "../core/analysis-provision.js";
import { checkProvision } from "./analysis-provision-files.js";
import { readLaunchFile } from "./analysis-launch-files.js";
import {
  createPermissionJournal,
  PermissionJournalWriter,
  readPermissionJournal,
} from "./analysis-permission-journal-files.js";

const workspace = fileURLToPath(
  new URL("../../../../", import.meta.url),
).replace(/[\\/]$/, "");
function main(args: string[]) {
  if (args.length === 3 && args[0] === "sample") {
    const review = checkProvision(workspace, args[1]!, args[2]!);
    const plan = JSON.parse(
      readLaunchFile(review.manifestPath, 65536).toString("utf8"),
    ) as ProvisionPlan;
    const created = createPermissionJournal(workspace, plan);
    const writer = new PermissionJournalWriter(
      workspace,
      created.labId,
      created.bindingSha256,
      created.head,
    );
    const binding = readPermissionJournal(
      workspace,
      created.labId,
      created.bindingSha256,
      created.head,
    ).binding;
    let head = created.head;
    try {
      for (const restore of [false, true])
        for (let offset = 0; offset < 16; offset++) {
          const index = restore ? 15 - offset : offset,
            target = binding.targets[index]!;
          const operationId = randomUUID();
          writer.begin({
            operationId,
            targetIndex: index,
            direction: restore ? "RESTORE" : "APPLY",
            objectId: launchSha256(`MODEL:${created.labId}:${index}`),
            expectedSha256: restore
              ? target.appliedSha256
              : target.beforeSha256,
            desiredSha256: restore ? target.beforeSha256 : target.appliedSha256,
          });
          // Fixed in-memory model only. No file permission or native-port bridge exists here.
          head = writer.finish(
            operationId,
            restore ? target.beforeSha256 : target.appliedSha256,
          );
        }
    } finally {
      writer.close();
    }
    const state = readPermissionJournal(
      workspace,
      created.labId,
      created.bindingSha256,
      head,
    );
    return {
      ...created,
      head,
      status: state.status,
      records: state.sequence,
      appliedCount: state.appliedCount,
      mode: "MODEL_ONLY",
      executionAllowed: false,
      osChangesApplied: false,
      osRecoveryVerified: false,
    };
  }
  if (args.length === 4 && args[0] === "check") {
    const state = readPermissionJournal(
      workspace,
      args[1]!,
      args[2]!,
      args[3]!,
    );
    return {
      status: state.status,
      head: state.head,
      records: state.sequence,
      pending: state.pending !== null,
      writerPresent: state.writerPresent,
      appliedCount: state.appliedCount,
      mode: "MODEL_ONLY",
      executionAllowed: false,
      osChangesApplied: false,
      osRecoveryVerified: false,
    };
  }
  throw new Error("PERMISSION_SAMPLE_CHECK_ONLY");
}
try {
  const result = main(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.status === "RECOVERY_HOLD") process.exitCode = 2;
} catch {
  console.error(
    JSON.stringify({
      status: "PERMISSION_HOLD",
      executionAllowed: false,
      osChangesApplied: false,
    }),
  );
  process.exitCode = 2;
}
