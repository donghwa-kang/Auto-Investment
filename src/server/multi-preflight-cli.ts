import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertOffline, verifyPolicies } from "../core/policy.js";
import { CatalogError } from "../core/catalog-schema.js";
import {
  runMultiPreflight,
  preflightReasons,
} from "../core/multi-preflight.js";
import { catalogReasons } from "../core/catalog.js";
import { enrichmentReasons } from "../core/catalog-enrichment.js";
import { qualityReasons } from "../core/market-quality.js";
import { readCatalogFile } from "./catalog-file.js";

try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  if (process.argv.length !== 3)
    throw new CatalogError("ONE_PREFLIGHT_FILE_ARGUMENT_REQUIRED");
  verifyPolicies();
  const report = runMultiPreflight(readCatalogFile(process.argv[2]!));
  const directory = resolve("data", "multi-preflight-checks");
  mkdirSync(directory, { recursive: true });
  const reportPath = resolve(
    directory,
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
  );
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ...report,
        reasonDescriptions: {
          ...catalogReasons,
          ...enrichmentReasons,
          ...qualityReasons,
          ...preflightReasons,
        },
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      result: "OFFLINE_MULTI_PREFLIGHT_COMPLETE",
      purpose: report.purpose,
      stage: report.stage,
      status: report.status,
      counts: report.counts,
      testCandidates: report.testCandidates,
      decisionHash: report.decisionHash,
      realDataReady: false,
      strategyReady: false,
      paperOrdersEnabled: false,
      liveEnabled: false,
      reportPath,
    }),
  );
} catch (error: unknown) {
  console.error(
    error instanceof CatalogError ? error.code : "MULTI_PREFLIGHT_FAILED",
  );
  process.exitCode = 1;
}
