import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertOffline, verifyPolicies } from "../core/policy.js";
import { parseSourceInput } from "../core/source-ingest-schema.js";
import { reviewMockExecutionEvidence } from "../core/execution-evidence.js";

// 고정 합성 픽스처만 읽는다. 인수/임의 경로/실제 수집/계좌 조회는 지원하지 않는다.
try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  if (process.argv.length !== 2) throw new Error("NO_ARGUMENTS_ALLOWED");
  verifyPolicies();
  const sourceInput = parseSourceInput(
    JSON.parse(readFileSync("fixtures/source-ingest-v1.json", "utf8")),
  );
  sourceInput.captures = sourceInput.captures.filter(
    (c) => c.request.kind === "ORDERBOOK",
  );
  sourceInput.pagePlans = [];
  const report = reviewMockExecutionEvidence({
    schemaVersion: "OFFLINE_EXECUTION_EVIDENCE_V1",
    purpose: "TEST_ONLY",
    target: {
      instrumentId: "MOCK-TEST-US",
      market: "US",
      symbol: "TEST",
      venue: "MOCK",
      currency: "USD",
    },
    illustrativeQuantity: 4,
    tickSpec: {
      evidenceId: "MOCK-TICK-ONLY",
      availableAt: "2026-09-14T00:00:00Z",
      effectiveFrom: "2026-09-14T00:00:00Z",
      effectiveUntil: "2026-09-15T00:00:00Z",
      priceFrom: "1",
      priceUntil: "1000",
      tickSize: "0.01",
      lotSize: 1,
    },
    sourceInput,
  });
  const directory = resolve("work", "execution-evidence-runs");
  mkdirSync(directory, { recursive: true });
  const reportPath = resolve(
    mkdtempSync(resolve(directory, "run-")),
    "report.json",
  );
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      result: "OFFLINE_EXECUTION_EVIDENCE_COMPLETE",
      status: report.status,
      reportPath,
      counts: report.counts,
      spreadBps: report.spreadBps,
      collectionAuthorized: false,
      realCalibrationReady: false,
      liveEnabled: false,
    }),
  );
} catch {
  console.error("EXECUTION_EVIDENCE_SAMPLE_FAILED");
  process.exitCode = 1;
}
