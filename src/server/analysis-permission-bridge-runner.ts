import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  bridgeInit,
  nativeIntentDigest,
  parseBridgeReady,
} from "../core/analysis-permission-bridge.js";
import { launchSha256 } from "../core/analysis-launch-plan.js";
import {
  journalJson,
  type PermissionIntent,
} from "../core/analysis-permission-journal.js";
import { type ProvisionPlan } from "../core/analysis-provision.js";
import { readLaunchFile } from "./analysis-launch-files.js";
import { checkProvision } from "./analysis-provision-files.js";
import {
  PermissionJournalWriter,
  readPermissionJournal,
} from "./analysis-permission-journal-files.js";
import {
  bridgeFreshFile,
  checkBridgeBuild,
  checkBridgeFixture,
  checkBridgeRun,
  createBridgeFixture,
} from "./analysis-permission-bridge-files.js";

export type BridgeCheckpoint =
  | "CREATED"
  | "READY"
  | "BEFORE_WRITE"
  | "BEFORE_ACK"
  | "AFTER_WRITE"
  | "AFTER_ACK"
  | "DONE";
export type BridgeContext = ReturnType<typeof createBridgeFixture>;
// Internal test seam; CLI exposes no hooks, arbitrary executable, paths, resume or permission flags.
export type BridgeObserver = (
  point: BridgeCheckpoint,
  context: BridgeContext,
  step: number,
) => void | Promise<void>;
export async function runBridgeSample(
  workspace: string,
  runId: string,
  planSha256: string,
  buildId: string,
  buildSha256: string,
  observe?: BridgeObserver,
) {
  const review = checkProvision(workspace, runId, planSha256);
  const plan = JSON.parse(
    readLaunchFile(review.manifestPath, 65536).toString("utf8"),
  ) as ProvisionPlan;
  if (plan.workspace !== workspace) throw new Error("BRIDGE_WORKSPACE");
  const build = checkBridgeBuild(workspace, buildId, buildSha256);
  const context = createBridgeFixture(workspace, plan, buildId, buildSha256);
  const { created, createdSha256, directory, journal } = context;
  await observe?.("CREATED", context, 0);
  checkBridgeFixture(directory, created);
  const writer = new PermissionJournalWriter(
    workspace,
    journal.labId,
    journal.bindingSha256,
    journal.head,
  );
  let head = journal.head,
    identitySha256 = "",
    step = 0;
  let phase: "READY" | "BEFORE" | "AFTER" | "DONE" | "COMPLETE" | "EXIT" =
    "READY";
  let objectIds: string[] = [],
    intent: PermissionIntent | undefined;
  const init = bridgeInit(created.labId, plan, planSha256);
  const operations = Array.from({ length: 32 }, () => randomUUID());
  const binding = readPermissionJournal(
    workspace,
    journal.labId,
    journal.bindingSha256,
    head,
  ).binding;
  let child: ReturnType<typeof spawn> | undefined;
  let closed:
    Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let processError = false,
    timedOut = false,
    diagnostic = "";
  try {
    bridgeFreshFile(
      join(directory, "started.json"),
      journalJson({
        version: "PERMISSION_BRIDGE_STARTED_V1",
        createdSha256,
        requestSha256: launchSha256(init),
        operations,
      }),
    );
    child = spawn(build.executable, ["--stdio-model"], {
      cwd: workspace,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
    });
    const ownedChild = child;
    closed = new Promise((resolve) => {
      ownedChild.once("error", () => {
        processError = true;
      });
      ownedChild.once("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdin!.on("error", () => {
      processError = true;
      ownedChild.kill();
    });
    child.stderr!.on("data", (data: Buffer) => {
      processError = true;
      if (diagnostic.length < 128)
        diagnostic += data.toString("ascii").slice(0, 128);
      ownedChild.kill();
    });
    timer = setTimeout(() => {
      timedOut = true;
      ownedChild.kill();
    }, 45000);
    const write = (wire: string) => {
      if (processError || timedOut || !ownedChild.stdin!.writable)
        throw new Error("BRIDGE_PIPE_HOLD");
      ownedChild.stdin!.write(wire);
    };
    const next = () => {
      const index = step < 16 ? step : 31 - step,
        target = binding.targets[index]!;
      intent = {
        operationId: operations[step]!,
        targetIndex: index,
        direction: step < 16 ? "APPLY" : "RESTORE",
        objectId: objectIds[index]!,
        expectedSha256: step < 16 ? target.beforeSha256 : target.appliedSha256,
        desiredSha256: step < 16 ? target.appliedSha256 : target.beforeSha256,
      };
      phase = "BEFORE";
      write(`OP ${intent.operationId}\n`);
    };
    const receive = async (line: string) => {
      if (phase === "READY") {
        objectIds = parseBridgeReady(line, init, created.nodeIds);
        checkBridgeFixture(directory, created);
        const identity = journalJson({
          version: "PERMISSION_BRIDGE_IDENTITY_V1",
          createdSha256,
          requestSha256: launchSha256(init),
          ownerSha256: launchSha256(plan.inspection.hostSid),
          objectIds,
          nodeIds: created.nodeIds,
        });
        bridgeFreshFile(join(directory, "identity.json"), identity);
        identitySha256 = launchSha256(identity);
        await observe?.("READY", context, step);
        next();
        return;
      }
      if (phase === "COMPLETE") {
        if (line !== "COMPLETE 32 WIN32_LOCKED")
          throw new Error("BRIDGE_COMPLETE_HOLD");
        phase = "EXIT";
        return;
      }
      if (!intent) throw new Error("BRIDGE_NO_INTENT");
      if (phase === "BEFORE") {
        const digest = nativeIntentDigest(plan, planSha256, intent);
        if (line !== `BEFORE ${intent.operationId} ${digest}`)
          throw new Error("BRIDGE_BEFORE_CONTRACT");
        await observe?.("BEFORE_WRITE", context, step);
        checkBridgeFixture(directory, created);
        const receipt = writer.begin(intent);
        head = receipt.durableRecordSha256;
        await observe?.("BEFORE_ACK", context, step);
        phase = "AFTER";
        write(`ACK_BEFORE ${intent.operationId} ${digest} ${head}\n`);
        return;
      }
      if (phase === "AFTER") {
        if (line !== `AFTER ${intent.operationId} VERIFIED`)
          throw new Error("BRIDGE_AFTER_CONTRACT");
        await observe?.("AFTER_WRITE", context, step);
        checkBridgeFixture(directory, created);
        head = writer.finish(intent.operationId, intent.desiredSha256);
        await observe?.("AFTER_ACK", context, step);
        phase = "DONE";
        write(`ACK_AFTER ${intent.operationId} ${head}\n`);
        return;
      }
      if (phase === "DONE") {
        if (line !== `DONE ${intent.operationId}`)
          throw new Error("BRIDGE_DONE_CONTRACT");
        await observe?.("DONE", context, step);
        step++;
        if (step === 32) {
          phase = "COMPLETE";
          write("END\n");
          ownedChild.stdin!.end();
        } else next();
        return;
      }
      throw new Error("BRIDGE_UNEXPECTED_OUTPUT");
    };
    write(init);
    let pending = "",
      total = 0;
    for await (const chunk of child.stdout!) {
      const bytes = Buffer.from(chunk as Uint8Array);
      total += bytes.length;
      if (total > 32768 || bytes.some((b) => b !== 10 && (b < 32 || b > 126)))
        throw new Error("BRIDGE_OUTPUT_BYTES");
      pending += bytes.toString("ascii");
      if (pending.length > 8192) throw new Error("BRIDGE_OUTPUT_SIZE");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        await receive(line);
      }
    }
    const exit = await closed;
    // phase is updated inside the receive callback; inspect after stdout and process close.
    if (
      exit.code !== 0 ||
      exit.signal ||
      processError ||
      timedOut ||
      pending ||
      String(phase) !== "EXIT" ||
      step !== 32
    )
      throw new Error(
        /^BRIDGE_NATIVE_HOLD_[0-9]+_WIN32_[0-9]+\r?\n$/.test(diagnostic)
          ? diagnostic.trim()
          : "BRIDGE_PROCESS_HOLD",
      );
    checkBridgeFixture(directory, created);
    checkBridgeBuild(workspace, buildId, buildSha256);
    checkProvision(workspace, runId, planSha256);
    writer.close();
    const state = readPermissionJournal(
      workspace,
      journal.labId,
      journal.bindingSha256,
      head,
    );
    if (
      state.status !== "MODEL_RECORDS_VERIFIED" ||
      state.sequence !== 64 ||
      state.appliedCount !== 0
    )
      throw new Error("BRIDGE_FINAL_JOURNAL");
    bridgeFreshFile(
      join(directory, "result.json"),
      journalJson({
        version: "PERMISSION_BRIDGE_RESULT_V1",
        createdSha256,
        startedSha256: launchSha256(
          readLaunchFile(join(directory, "started.json"), 8192),
        ),
        identitySha256,
        head,
        operations: 32,
        records: 64,
        status: "NATIVE_MODEL_JOURNAL_VERIFIED",
        executionAllowed: false,
        osChangesApplied: false,
        osRecoveryVerified: false,
      }),
    );
    return {
      labId: created.labId,
      createdSha256,
      ...checkBridgeRun(workspace, created.labId, createdSha256, head),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (child && closed) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
    writer.close();
  }
}
