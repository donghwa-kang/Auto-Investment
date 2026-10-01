// Only created by the journal tests. No OS permission or user-data operations.
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import {
  PermissionJournalWriter,
  readPermissionJournal,
} from "../dist/runtime/src/server/analysis-permission-journal-files.js";
import { launchSha256 } from "../dist/runtime/src/core/analysis-launch-plan.js";
import { randomUUID } from "node:crypto";
if (process.argv.length !== 6 || !process.send)
  throw new Error("TEST_IPC_ONLY");
const workspace = fileURLToPath(new URL("../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const [labId, bindingHash, head, phase] = process.argv.slice(2);
if (!["LOCKED", "BEFORE", "EFFECT", "AFTER"].includes(phase))
  throw new Error("TEST_PHASE");
const state = readPermissionJournal(workspace, labId, bindingHash, head);
const writer = new PermissionJournalWriter(workspace, labId, bindingHash, head);
const target = state.binding.targets[0];
const intent = {
  operationId: randomUUID(),
  targetIndex: 0,
  direction: "APPLY",
  objectId: launchSha256(`MODEL:${labId}:0`),
  expectedSha256: target.beforeSha256,
  desiredSha256: target.appliedSha256,
};
let receipt = null;
if (phase !== "LOCKED") receipt = writer.begin(intent);
if (phase === "EFFECT" || phase === "AFTER") {
  const fd = openSync(
    join(workspace, "work", `permission-model-effect-${labId}.json`),
    "wx",
  );
  try {
    writeFileSync(fd, JSON.stringify({ mode: "MODEL_ONLY", intent }) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
if (phase === "AFTER") writer.finish(intent.operationId, intent.desiredSha256);
process.send({ phase, receipt });
// The parent kills this owned process only after the durable checkpoint message.
process.on("message", () => {});
