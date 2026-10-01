import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertOffline, verifyPolicies } from "../core/policy.js";
import { classifyCatalog, catalogReasons } from "../core/catalog.js";
import { CatalogError } from "../core/catalog-schema.js";
import { readCatalogFile } from "./catalog-file.js";

// 웹 서버/시세/주문 모듈을 가져오지 않는 독립 오프라인 명령이다.
try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  if (process.argv.length !== 3)
    throw new CatalogError("ONE_CATALOG_FILE_ARGUMENT_REQUIRED");
  verifyPolicies();
  const report = classifyCatalog(readCatalogFile(process.argv[2]!));
  const directory = "data/catalog-checks";
  mkdirSync(directory, { recursive: true });
  const reportPath = resolve(
    directory,
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
  );
  writeFileSync(
    reportPath,
    JSON.stringify({ ...report, reasonDescriptions: catalogReasons }, null, 2) +
      "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      result: "OFFLINE_CATALOG_COMPLETE",
      purpose: report.purpose,
      stage: report.stage,
      asOf: report.asOf,
      counts: report.counts,
      diagnostics: report.diagnostics,
      decisionHash: report.decisionHash,
      strategyEvaluated: false,
      ordersEnabled: false,
      reportPath,
    }),
  );
} catch (error: unknown) {
  console.error(
    error instanceof CatalogError ? error.code : "CATALOG_CHECK_FAILED",
  );
  process.exitCode = 1;
}
