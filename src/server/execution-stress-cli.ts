import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runExecutionStressSample } from "./execution-stress-run.js";

try {
  if (
    process.argv.length !== 4 ||
    !/^\d{1,7}$/.test(process.argv[2]!) ||
    !["KR", "US"].includes(process.argv[3]!)
  )
    throw new Error("STRESS_ARGUMENTS");
  const report = runExecutionStressSample(
    Number(process.argv[2]),
    process.argv[3] === "US" ? "US" : "KR",
  );
  const root = resolve("work", "execution-stress-runs");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, "run-"));
  const reportPath = resolve(directory, "report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      result: "OFFLINE_STRESS_SAMPLE_COMPLETE",
      purpose: report.purpose,
      performanceQualified: false,
      liveEnabled: false,
      reportPath,
      cases: report.results.map((r) => ({
        name: r.name,
        quantity: r.feasibleQuantity,
        firstFillAt: r.firstFillAt,
        exposureStatus: r.exposureStatus,
        equityChangeKrw: r.equityChangeKrw,
      })),
    }),
  );
} catch {
  console.error("OFFLINE_STRESS_SAMPLE_FAILED");
  process.exitCode = 1;
}
