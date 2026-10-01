import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyDummyProbe,
  dummyCases,
  parseDummyReceipt,
} from "../core/analysis-dummy.js";
import {
  createDummyFixture,
  dummySha256,
  dummyTargets,
  plainDummyDirectory,
  type DummyJob,
} from "./analysis-dummy-files.js";

function main() {
  if (
    process.argv.length !== 2 ||
    process.platform !== "win32" ||
    process.versions.node !== "24.20.0"
  )
    throw new Error("DUMMY_RUNTIME_OR_ARGUMENTS");
  const project = fileURLToPath(new URL("../../../../", import.meta.url));
  const work = resolve(project, "work");
  plainDummyDirectory(work);
  const parent = join(work, "analysis-dummy-lab");
  mkdirSync(parent, { recursive: true });
  plainDummyDirectory(parent);
  const fixture = createDummyFixture(parent);
  const env: NodeJS.ProcessEnv = {
    TEMP: join(fixture.root, "tmp"),
    TMP: join(fixture.root, "tmp"),
  };
  for (const name of ["SystemRoot", "WINDIR"])
    if (process.env[name]) env[name] = process.env[name];
  const observations = [];
  for (const caseId of dummyCases) {
    const path = join(fixture.root, dummyTargets[caseId]);
    const beforeSha256 = dummySha256(readFileSync(path));
    const job: DummyJob = {
      version: "DUMMY_FILE_JOB_V1",
      root: fixture.root,
      runId: fixture.manifest.runId,
      caseId,
      manifestSha256: fixture.manifestSha256,
    };
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./analysis-dummy-worker.js", import.meta.url))],
      {
        cwd: fixture.root,
        env,
        input: JSON.stringify(job),
        shell: false,
        windowsHide: true,
        timeout: 7000,
        maxBuffer: 8192,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const afterSha256 = dummySha256(readFileSync(path));
    let classification: string = "INCONCLUSIVE";
    let receipt = null;
    if (!child.error && child.status === 0 && child.stderr.length === 0) {
      try {
        receipt = parseDummyReceipt(child.stdout);
        classification = classifyDummyProbe({
          caseId,
          runId: job.runId,
          manifestSha256: job.manifestSha256,
          controlMatched: beforeSha256 === fixture.manifest.targets[caseId],
          beforeSha256,
          afterSha256,
          receipt,
        });
      } catch {
        /* 잘못된 출력은 격리 성공이 아닌 미확인이다. */
      }
    }
    observations.push({
      caseId,
      beforeSha256,
      afterSha256,
      classification,
      receipt,
      childExitCode: child.status,
      childErrorCode:
        (child.error as NodeJS.ErrnoException | undefined)?.code ?? null,
    });
  }
  const passed = observations.every(
    (r) =>
      r.childExitCode === 0 &&
      r.classification ===
        (r.caseId === "ALLOW_READ" ? "ALLOW_OBSERVED" : "EXPOSURE_DETECTED") &&
      (r.caseId !== "DENY_WRITE" ||
        r.receipt?.observedSha256 === r.afterSha256),
  );
  const report = {
    version: "DUMMY_FILE_SELF_TEST_V1",
    mode: "UNSANDBOXED_TOOL_SELF_TEST",
    status: passed ? "SELF_TEST_PASSED" : "SELF_TEST_FAILED",
    runId: fixture.manifest.runId,
    manifestSha256: fixture.manifestSha256,
    nodeVersion: process.versions.node,
    platform: process.platform,
    toolHashes: Object.fromEntries(
      [
        "./analysis-dummy-cli.js",
        "./analysis-dummy-worker.js",
        "./analysis-dummy-files.js",
        "../core/analysis-dummy.js",
        "../../../../package-lock.json",
      ].map((path) => [
        path,
        dummySha256(
          readFileSync(fileURLToPath(new URL(path, import.meta.url))),
        ),
      ]),
    ),
    capturedAt: new Date().toISOString(),
    observations,
    actualOsTests: "NOT_RUN",
    osIsolationVerified: false,
    realCodexEnabled: false,
  };
  const reportPath = join(fixture.root, "self-test.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(
    JSON.stringify({
      status: report.status,
      reportPath,
      actualOsTests: report.actualOsTests,
    }),
  );
  process.exitCode = passed ? 0 : 1;
}
try {
  main();
} catch {
  console.error("DUMMY_SELF_TEST_UNAVAILABLE");
  process.exitCode = 1;
}
