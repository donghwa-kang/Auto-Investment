import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  bridgeBuildSchema,
  bridgeDummy,
  bridgeHostFiles,
  bridgeSources,
} from "../core/analysis-permission-bridge.js";
import {
  launchHashSchema,
  launchRunIdSchema,
  launchSha256,
} from "../core/analysis-launch-plan.js";
import {
  inspectNativePe,
  nativeToolHashes,
} from "../core/analysis-native-contract.js";
import { probeJson } from "../core/analysis-file-probe.js";
import { journalJson } from "../core/analysis-permission-journal.js";
import {
  provisionTargets,
  type ProvisionPlan,
} from "../core/analysis-provision.js";
import {
  readLaunchFile,
  requireLaunchDirectory,
} from "./analysis-launch-files.js";
import {
  createPermissionJournal,
  readPermissionJournal,
} from "./analysis-permission-journal-files.js";
import { checkProvision } from "./analysis-provision-files.js";

function same(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error("BRIDGE_BINDING_HOLD");
}
export function bridgeCodeHashes(workspace: string) {
  return Object.fromEntries(
    bridgeHostFiles.map((p) => [
      p,
      launchSha256(readLaunchFile(join(workspace, p), 1048576)),
    ]),
  );
}
export function checkBridgeBuild(
  workspace: string,
  buildId: string,
  hash: string,
) {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.versions.node !== "24.20.0"
  )
    throw new Error("BRIDGE_RUNTIME");
  launchRunIdSchema.parse(buildId);
  launchHashSchema.parse(hash);
  const directory = join(
    workspace,
    "work/analysis-permission-bridge-build",
    `build-${buildId}`,
  );
  requireLaunchDirectory(directory);
  same(
    readdirSync(directory).sort(),
    [
      "build.json",
      "analysis-permission-bridge.exe",
      "analysis-permission-bridge.obj",
      "permission-win32.obj",
      "headers.txt",
      "imports.txt",
      "loadconfig.txt",
      "commands.txt",
    ].sort(),
  );
  const bytes = readLaunchFile(join(directory, "build.json"), 32768);
  if (launchSha256(bytes) !== hash) throw new Error("BRIDGE_BUILD_HASH");
  const build = bridgeBuildSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (probeJson(build) !== bytes.toString("utf8") || build.buildId !== buildId)
    throw new Error("BRIDGE_BUILD_CONTRACT");
  same(Object.keys(build.sourceHashes).sort(), [...bridgeSources].sort());
  same(build.toolHashes, nativeToolHashes);
  for (const path of bridgeSources)
    if (
      launchSha256(readLaunchFile(join(workspace, path), 1048576)) !==
      build.sourceHashes[path]
    )
      throw new Error("BRIDGE_SOURCE_CHANGED");
  const executable = join(directory, build.artifact.file),
    exe = readLaunchFile(executable, 2097152);
  inspectNativePe(exe);
  if (
    exe.length !== build.artifact.bytes ||
    launchSha256(exe) !== build.artifact.sha256
  )
    throw new Error("BRIDGE_EXE_CHANGED");
  for (const name of ["headers", "imports", "loadconfig", "commands"] as const)
    if (
      launchSha256(readLaunchFile(join(directory, `${name}.txt`), 262144)) !==
      build.evidence[name]
    )
      throw new Error("BRIDGE_EVIDENCE_CHANGED");
  return { executable, build };
}
export function bridgeFreshFile(path: string, value: string) {
  const fd = openSync(path, "wx");
  try {
    const bytes = Buffer.from(value);
    let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!n) throw new Error("BRIDGE_SHORT_WRITE");
      offset += n;
    }
    fsyncSync(fd);
    return fstatSync(fd, { bigint: true });
  } finally {
    closeSync(fd);
  }
}
export function bridgeNodeId(stat: { dev: bigint; ino: bigint }) {
  return launchSha256(`${stat.dev}\n${stat.ino}\n`);
}
const createdSchema = z.strictObject({
  version: z.literal("PERMISSION_BRIDGE_CREATED_V1"),
  mode: z.literal("MODEL_ONLY"),
  labId: launchRunIdSchema,
  runId: launchRunIdSchema,
  planSha256: launchHashSchema,
  buildId: launchRunIdSchema,
  buildSha256: launchHashSchema,
  hostHashes: z.record(z.string(), launchHashSchema),
  nodeIds: z.array(launchHashSchema).length(16),
  journalId: launchRunIdSchema,
  journalBindingSha256: launchHashSchema,
});
export type BridgeCreated = z.infer<typeof createdSchema>;
const startedSchema = z.strictObject({
  version: z.literal("PERMISSION_BRIDGE_STARTED_V1"),
  createdSha256: launchHashSchema,
  requestSha256: launchHashSchema,
  operations: z.array(launchRunIdSchema).length(32),
});
const identitySchema = z.strictObject({
  version: z.literal("PERMISSION_BRIDGE_IDENTITY_V1"),
  createdSha256: launchHashSchema,
  requestSha256: launchHashSchema,
  ownerSha256: launchHashSchema,
  objectIds: z.array(launchHashSchema).length(16),
  nodeIds: z.array(launchHashSchema).length(16),
});
function canonicalJson<T>(bytes: Buffer, schema: z.ZodType<T>): T {
  const wire = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes),
    value = schema.parse(JSON.parse(wire));
  if (journalJson(value) !== wire) throw new Error("BRIDGE_JSON_CONTRACT");
  return value;
}
export function bridgeDirectory(workspace: string, labId: string) {
  launchRunIdSchema.parse(labId);
  return join(workspace, "work/analysis-permission-bridge-lab", `lab-${labId}`);
}
export function createBridgeFixture(
  workspace: string,
  plan: ProvisionPlan,
  buildId: string,
  buildSha256: string,
) {
  checkBridgeBuild(workspace, buildId, buildSha256);
  const journal = createPermissionJournal(workspace, plan),
    labId = randomUUID(),
    directory = bridgeDirectory(workspace, labId);
  const parent = join(workspace, "work/analysis-permission-bridge-lab");
  requireLaunchDirectory(join(workspace, "work"));
  if (!existsSync(parent)) mkdirSync(parent);
  requireLaunchDirectory(parent);
  mkdirSync(directory);
  requireLaunchDirectory(directory);
  const fixture = join(directory, "fixture"),
    nodeIds: string[] = [];
  for (const [index, [path, kind]] of provisionTargets.entries()) {
    const target = join(fixture, path);
    const stat =
      kind === "file"
        ? bridgeFreshFile(target, bridgeDummy(labId, index))
        : (mkdirSync(target), lstatSync(target, { bigint: true }));
    nodeIds.push(bridgeNodeId(stat));
  }
  const created = createdSchema.parse({
    version: "PERMISSION_BRIDGE_CREATED_V1",
    mode: "MODEL_ONLY",
    labId,
    runId: plan.runId,
    planSha256: launchSha256(probeJson(plan)),
    buildId,
    buildSha256,
    hostHashes: bridgeCodeHashes(workspace),
    nodeIds,
    journalId: journal.labId,
    journalBindingSha256: journal.bindingSha256,
  });
  const wire = journalJson(created);
  bridgeFreshFile(join(directory, "created.json"), wire);
  checkBridgeFixture(directory, created);
  return { created, createdSha256: launchSha256(wire), directory, journal };
}
export function checkBridgeFixture(directory: string, created: BridgeCreated) {
  const fixture = join(directory, "fixture");
  requireLaunchDirectory(directory);
  for (const [index, [path, kind]] of provisionTargets.entries()) {
    const target = join(fixture, path),
      stat = lstatSync(target, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      bridgeNodeId(stat) !== created.nodeIds[index] ||
      (kind === "file"
        ? !stat.isFile() || stat.nlink !== 1n
        : !stat.isDirectory())
    )
      throw new Error("BRIDGE_FIXTURE_IDENTITY");
    if (kind === "file")
      same(
        readLaunchFile(target, 128).toString("utf8"),
        bridgeDummy(created.labId, index),
      );
    else {
      requireLaunchDirectory(target);
      const prefix = path === "." ? "" : `${path}/`;
      const expected = provisionTargets
        .map((t) => t[0])
        .filter(
          (p) =>
            p !== "." &&
            p.startsWith(prefix) &&
            !p.slice(prefix.length).includes("/"),
        )
        .map((p) => p.slice(prefix.length))
        .sort();
      same(readdirSync(target).sort(), expected);
    }
  }
}
// Recovery is read-only. No restart, unlock, cleanup, ACL replay or model replay.
export function checkBridgeRun(
  workspace: string,
  labId: string,
  createdSha256: string,
  expectedHead?: string,
) {
  launchHashSchema.parse(createdSha256);
  const directory = bridgeDirectory(workspace, labId);
  requireLaunchDirectory(directory);
  const wire = readLaunchFile(join(directory, "created.json"), 16384);
  if (launchSha256(wire) !== createdSha256)
    throw new Error("BRIDGE_CREATED_CHANGED");
  const created = canonicalJson(wire, createdSchema);
  if (created.labId !== labId) throw new Error("BRIDGE_CREATED_CONTRACT");
  same(created.hostHashes, bridgeCodeHashes(workspace));
  checkBridgeBuild(workspace, created.buildId, created.buildSha256);
  checkBridgeFixture(directory, created);
  const names = readdirSync(directory).sort();
  if (
    names.some(
      (n) =>
        ![
          "fixture",
          "created.json",
          "started.json",
          "identity.json",
          "result.json",
        ].includes(n),
    )
  )
    throw new Error("BRIDGE_EXTRA_FILE");
  const journal = readPermissionJournal(
    workspace,
    created.journalId,
    created.journalBindingSha256,
    expectedHead,
  );
  if (
    journal.binding.runId !== created.runId ||
    journal.binding.planSha256 !== created.planSha256
  )
    throw new Error("BRIDGE_JOURNAL_BINDING");
  let complete = false;
  if (
    names.includes("result.json") &&
    names.includes("identity.json") &&
    names.includes("started.json") &&
    expectedHead
  ) {
    const review = checkProvision(workspace, created.runId, created.planSha256);
    const plan = JSON.parse(
      readLaunchFile(review.manifestPath, 65536).toString("utf8"),
    ) as ProvisionPlan;
    const startedBytes = readLaunchFile(join(directory, "started.json"), 8192),
      started = canonicalJson(startedBytes, startedSchema);
    const identity = readLaunchFile(join(directory, "identity.json"), 8192),
      ids = canonicalJson(identity, identitySchema);
    const resultBytes = readLaunchFile(join(directory, "result.json"), 8192),
      result: unknown = JSON.parse(resultBytes.toString("utf8"));
    const request = `BRIDGE_MODEL_V1 ${labId} ${created.runId} ${created.planSha256} ${launchSha256(plan.inspection.hostSid)}\n`;
    if (
      started.createdSha256 !== createdSha256 ||
      ids.createdSha256 !== createdSha256 ||
      started.requestSha256 !== launchSha256(request) ||
      ids.requestSha256 !== started.requestSha256 ||
      ids.ownerSha256 !== launchSha256(plan.inspection.hostSid) ||
      new Set(started.operations).size !== 32 ||
      new Set(ids.objectIds).size !== 16
    )
      throw new Error("BRIDGE_RECEIPT_BINDING");
    same(ids.nodeIds, created.nodeIds);
    const rows = journal.bytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            event: {
              type: string;
              intent?: {
                operationId: string;
                targetIndex: number;
                direction: string;
                objectId: string;
              };
            };
          },
      );
    const before = rows.filter((row) => row.event.type === "BEFORE");
    if (before.length !== 32) throw new Error("BRIDGE_OPERATION_COUNT");
    before.forEach((row, step) => {
      const index = step < 16 ? step : 31 - step,
        intent = row.event.intent;
      if (
        !intent ||
        intent.operationId !== started.operations[step] ||
        intent.targetIndex !== index ||
        intent.direction !== (step < 16 ? "APPLY" : "RESTORE") ||
        intent.objectId !== ids.objectIds[index]
      )
        throw new Error("BRIDGE_OPERATION_BINDING");
    });
    // The caller's separately kept head anchors the log; result alone never authorizes anything.
    same(result, {
      version: "PERMISSION_BRIDGE_RESULT_V1",
      createdSha256,
      startedSha256: launchSha256(startedBytes),
      identitySha256: launchSha256(identity),
      head: expectedHead,
      operations: 32,
      records: 64,
      status: "NATIVE_MODEL_JOURNAL_VERIFIED",
      executionAllowed: false,
      osChangesApplied: false,
      osRecoveryVerified: false,
    });
    if (journalJson(result) !== resultBytes.toString("utf8"))
      throw new Error("BRIDGE_RESULT_CANONICAL");
    complete =
      journal.status === "MODEL_RECORDS_VERIFIED" &&
      journal.sequence === 64 &&
      journal.appliedCount === 0;
  }
  return {
    status: complete ? "NATIVE_MODEL_JOURNAL_VERIFIED" : "RECOVERY_HOLD",
    records: journal.sequence,
    head: journal.head,
    executionAllowed: false,
    osChangesApplied: false,
    osRecoveryVerified: false,
  };
}
