import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { bridgeBuildSchema } from "../core/analysis-permission-bridge.js";
import {
  launchHashSchema,
  launchRunIdSchema,
  launchSha256,
} from "../core/analysis-launch-plan.js";
import {
  nativeToolHashes,
  inspectNativePe,
} from "../core/analysis-native-contract.js";
import { probeJson } from "../core/analysis-file-probe.js";
import { journalJson } from "../core/analysis-permission-journal.js";
import { type ProvisionPlan } from "../core/analysis-provision.js";
import {
  parseReadinessResult,
  readinessHostFiles,
  readinessRequest,
  readinessSources,
  readinessSummary,
} from "../core/analysis-readiness-inspect.js";
import {
  readLaunchFile,
  requireLaunchDirectory,
} from "./analysis-launch-files.js";
import { checkProvision } from "./analysis-provision-files.js";
import {
  bridgeFreshFile,
  bridgeDirectory,
  checkBridgeFixture,
  checkBridgeRun,
  createBridgeFixture,
  type BridgeCreated,
} from "./analysis-permission-bridge-files.js";

const buildSchema = bridgeBuildSchema.extend({
  version: z.literal("READINESS_INSPECT_BUILD_V1"),
  artifact: bridgeBuildSchema.shape.artifact.extend({
    file: z.literal("analysis-readiness-inspect.exe"),
  }),
  osMutationBackend: z.literal("ABSENT"),
});
function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error("READINESS_BINDING");
}
export function readinessCodeHashes(workspace: string) {
  return Object.fromEntries(
    readinessHostFiles.map((p) => [
      p,
      launchSha256(readLaunchFile(join(workspace, p), 1048576)),
    ]),
  );
}
export function checkReadinessBuild(
  workspace: string,
  id: string,
  hash: string,
) {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.versions.node !== "24.20.0"
  )
    throw new Error("READINESS_RUNTIME");
  launchRunIdSchema.parse(id);
  launchHashSchema.parse(hash);
  const directory = join(
    workspace,
    "work/analysis-readiness-inspect-build",
    `build-${id}`,
  );
  requireLaunchDirectory(directory);
  equal(
    readdirSync(directory).sort(),
    [
      "build.json",
      "analysis-readiness-inspect.exe",
      "analysis-readiness-inspect.obj",
      "headers.txt",
      "imports.txt",
      "loadconfig.txt",
      "commands.txt",
    ].sort(),
  );
  const wire = readLaunchFile(join(directory, "build.json"), 32768);
  if (launchSha256(wire) !== hash) throw new Error("READINESS_BUILD_HASH");
  const b = buildSchema.parse(JSON.parse(wire.toString("utf8")));
  if (probeJson(b) !== wire.toString("utf8") || b.buildId !== id)
    throw new Error("READINESS_BUILD_CONTRACT");
  equal(Object.keys(b.sourceHashes).sort(), [...readinessSources].sort());
  equal(b.toolHashes, nativeToolHashes);
  for (const path of readinessSources)
    if (
      launchSha256(readLaunchFile(join(workspace, path), 1048576)) !==
      b.sourceHashes[path]
    )
      throw new Error("READINESS_SOURCE_CHANGED");
  const executable = join(directory, b.artifact.file),
    bytes = readLaunchFile(executable, 2097152);
  inspectNativePe(bytes);
  if (
    bytes.length !== b.artifact.bytes ||
    launchSha256(bytes) !== b.artifact.sha256
  )
    throw new Error("READINESS_EXE_CHANGED");
  for (const name of ["headers", "imports", "loadconfig", "commands"] as const)
    if (
      launchSha256(readLaunchFile(join(directory, `${name}.txt`), 262144)) !==
      b.evidence[name]
    )
      throw new Error("READINESS_BUILD_EVIDENCE");
  const imports = readLaunchFile(
    join(directory, "imports.txt"),
    262144,
  ).toString("utf8");
  if (
    /\b(?:SetSecurityInfo|SetNamedSecurityInfoW|AdjustTokenPrivileges|CreateAppContainerProfile|DeleteAppContainerProfile|RegCreateKeyExW)\b/.test(
      imports,
    )
  )
    throw new Error("READINESS_MUTATION_IMPORT");
  return { executable, build: b };
}
const manifestSchema = z.strictObject({
  version: z.literal("READINESS_REPORT_BINDING_V1"),
  reportId: launchRunIdSchema,
  runId: launchRunIdSchema,
  planSha256: launchHashSchema,
  buildId: launchRunIdSchema,
  buildSha256: launchHashSchema,
  fixtureId: launchRunIdSchema,
  fixtureSha256: launchHashSchema,
  nonce: launchRunIdSchema,
  requestSha256: launchHashSchema,
  hostHashes: z.record(z.string(), launchHashSchema),
  executionAllowed: z.literal(false),
});
function reportDirectory(workspace: string, id: string) {
  launchRunIdSchema.parse(id);
  return join(workspace, "work/analysis-readiness-lab", `report-${id}`);
}
function loadPlan(workspace: string, id: string, hash: string) {
  const review = checkProvision(workspace, id, hash);
  const plan = JSON.parse(
    readLaunchFile(review.manifestPath, 65536).toString("utf8"),
  ) as ProvisionPlan;
  if (plan.workspace !== workspace) throw new Error("READINESS_WORKSPACE");
  return plan;
}
export async function collectReadiness(
  workspace: string,
  runId: string,
  planSha256: string,
  bridgeId: string,
  bridgeSha256: string,
  buildId: string,
  buildSha256: string,
) {
  const plan = loadPlan(workspace, runId, planSha256),
    executable = checkReadinessBuild(
      workspace,
      buildId,
      buildSha256,
    ).executable;
  const fixture = createBridgeFixture(workspace, plan, bridgeId, bridgeSha256),
    reportId = randomUUID(),
    nonce = randomUUID();
  const parent = join(workspace, "work/analysis-readiness-lab");
  if (!existsSync(parent)) mkdirSync(parent);
  requireLaunchDirectory(parent);
  const directory = reportDirectory(workspace, reportId);
  mkdirSync(directory);
  requireLaunchDirectory(directory);
  const request = readinessRequest(
    fixture.created.labId,
    plan,
    fixture.created.nodeIds[0]!,
    nonce,
  );
  const binding = manifestSchema.parse({
    version: "READINESS_REPORT_BINDING_V1",
    reportId,
    runId,
    planSha256,
    buildId,
    buildSha256,
    fixtureId: fixture.created.labId,
    fixtureSha256: fixture.createdSha256,
    nonce,
    requestSha256: launchSha256(request),
    hostHashes: readinessCodeHashes(workspace),
    executionAllowed: false,
  });
  const bindingWire = journalJson(binding),
    bindingSha256 = launchSha256(bindingWire);
  bridgeFreshFile(join(directory, "binding.json"), bindingWire);
  const child = spawn(executable, ["--stdio-inspect"], {
    cwd: workspace,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
  });
  let total = 0,
    failed = false,
    timedOut = false;
  const chunks: Buffer[] = [];
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => resolve(code));
  });
  child.stdin.on("error", () => {
    failed = true;
    child.kill();
  });
  child.stdout.on("data", (data: Buffer) => {
    total += data.length;
    if (total > 262144) {
      failed = true;
      child.kill();
    } else chunks.push(data);
  });
  child.stderr.on("data", () => {
    failed = true;
    child.kill();
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 20000);
  try {
    child.stdin.end(request);
    const exit = await closed;
    if (exit !== 0 || failed || timedOut) {
      bridgeFreshFile(
        join(directory, "failure.json"),
        journalJson({
          version: "READINESS_COLLECTION_FAILURE_V1",
          bindingSha256,
          exitCode: exit,
          transportFailed: failed,
          timedOut,
          outputSha256: launchSha256(Buffer.concat(chunks)),
          executionAllowed: false,
        }),
      );
      throw new Error("READINESS_INSPECT_PROCESS_HOLD");
    }
    const bytes = Buffer.concat(chunks),
      result = parseReadinessResult(
        bytes,
        request,
        plan,
        fixture.created.nodeIds,
      );
    checkBridgeFixture(fixture.directory, fixture.created);
    checkReadinessBuild(workspace, buildId, buildSha256);
    loadPlan(workspace, runId, planSha256);
    equal(binding.hostHashes, readinessCodeHashes(workspace));
    bridgeFreshFile(
      join(directory, "observation.json"),
      bytes.toString("utf8"),
    );
    const observationSha256 = launchSha256(bytes);
    bridgeFreshFile(
      join(directory, "result.json"),
      journalJson({
        version: "READINESS_REPORT_RESULT_V1",
        bindingSha256,
        observationSha256,
        ...readinessSummary(result),
      }),
    );
    return {
      reportId,
      bindingSha256,
      observationSha256,
      ...checkReadinessReport(
        workspace,
        reportId,
        bindingSha256,
        observationSha256,
      ),
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}
export function checkReadinessReport(
  workspace: string,
  reportId: string,
  bindingSha256: string,
  observationSha256: string,
) {
  launchHashSchema.parse(bindingSha256);
  launchHashSchema.parse(observationSha256);
  const directory = reportDirectory(workspace, reportId);
  requireLaunchDirectory(directory);
  equal(readdirSync(directory).sort(), [
    "binding.json",
    "observation.json",
    "result.json",
  ]);
  const wire = readLaunchFile(join(directory, "binding.json"), 16384);
  if (launchSha256(wire) !== bindingSha256)
    throw new Error("READINESS_BINDING_HASH");
  const binding = manifestSchema.parse(JSON.parse(wire.toString("utf8")));
  if (
    binding.reportId !== reportId ||
    journalJson(binding) !== wire.toString("utf8")
  )
    throw new Error("READINESS_REPORT_CONTRACT");
  equal(binding.hostHashes, readinessCodeHashes(workspace));
  checkReadinessBuild(workspace, binding.buildId, binding.buildSha256);
  const plan = loadPlan(workspace, binding.runId, binding.planSha256);
  const state = checkBridgeRun(
    workspace,
    binding.fixtureId,
    binding.fixtureSha256,
  );
  if (state.records !== 0) throw new Error("READINESS_FIXTURE_ALREADY_USED");
  const created = JSON.parse(
    readLaunchFile(
      join(bridgeDirectory(workspace, binding.fixtureId), "created.json"),
      16384,
    ).toString("utf8"),
  ) as BridgeCreated;
  if (
    created.runId !== binding.runId ||
    created.planSha256 !== binding.planSha256
  )
    throw new Error("READINESS_FIXTURE_BINDING");
  const request = readinessRequest(
    binding.fixtureId,
    plan,
    created.nodeIds[0]!,
    binding.nonce,
  );
  if (launchSha256(request) !== binding.requestSha256)
    throw new Error("READINESS_REQUEST_HASH");
  const bytes = readLaunchFile(join(directory, "observation.json"), 262144);
  if (launchSha256(bytes) !== observationSha256)
    throw new Error("READINESS_OBSERVATION_HASH");
  const result = parseReadinessResult(bytes, request, plan, created.nodeIds),
    summary = readinessSummary(result);
  const final = readLaunchFile(join(directory, "result.json"), 8192);
  if (
    final.toString("utf8") !==
    journalJson({
      version: "READINESS_REPORT_RESULT_V1",
      bindingSha256,
      observationSha256,
      ...summary,
    })
  )
    throw new Error("READINESS_RESULT_BINDING");
  return summary;
}
