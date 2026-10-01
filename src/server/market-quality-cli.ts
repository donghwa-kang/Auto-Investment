import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertOffline, verifyPolicies } from "../core/policy.js";
import { CatalogError } from "../core/catalog-schema.js";
import { checkMarketQuality, qualityReasons } from "../core/market-quality.js";
import { readCatalogFile } from "./catalog-file.js";

// 로컬 시험 파일 전용. 실제 시세·자격증명·DB·주문 모듈을 가져오지 않는다.
try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  if (process.argv.length !== 3)
    throw new CatalogError("ONE_MARKET_QUALITY_FILE_ARGUMENT_REQUIRED");
  verifyPolicies();
  const report = checkMarketQuality(readCatalogFile(process.argv[2]!));
  const directory = resolve("data", "market-quality-checks");
  mkdirSync(directory, { recursive: true });
  const reportPath = resolve(
    directory,
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
  );
  writeFileSync(
    reportPath,
    JSON.stringify({ ...report, reasonDescriptions: qualityReasons }, null, 2) +
      "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      result: "OFFLINE_MARKET_QUALITY_COMPLETE",
      purpose: report.purpose,
      stage: report.stage,
      status: report.status,
      counts: report.counts,
      diagnostics: report.diagnostics,
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
    error instanceof CatalogError ? error.code : "MARKET_QUALITY_FAILED",
  );
  process.exitCode = 1;
}
