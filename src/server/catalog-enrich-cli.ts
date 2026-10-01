import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertOffline, verifyPolicies } from "../core/policy.js";
import { CatalogError } from "../core/catalog-schema.js";
import { catalogReasons } from "../core/catalog.js";
import {
  enrichCatalog,
  enrichmentReasons,
} from "../core/catalog-enrichment.js";
import { readCatalogFile } from "./catalog-file.js";

// 사용자 서버·DB·시세·자격증명 모듈과 연결하지 않는 독립 시험 명령이다.
try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  if (process.argv.length !== 3)
    throw new CatalogError("ONE_ENRICHMENT_FILE_ARGUMENT_REQUIRED");
  verifyPolicies();
  const report = enrichCatalog(readCatalogFile(process.argv[2]!));
  const directory = resolve("data", "catalog-enrichments");
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
        reasonDescriptions: { ...catalogReasons, ...enrichmentReasons },
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      result: "OFFLINE_CATALOG_ENRICHMENT_COMPLETE",
      purpose: report.purpose,
      stage: report.stage,
      asOf: report.asOf,
      counts: report.counts,
      diagnostics: report.diagnostics,
      decisionHash: report.decisionHash,
      realMetadataReady: false,
      strategyEvaluated: false,
      ordersEnabled: false,
      reportPath,
    }),
  );
} catch (error: unknown) {
  console.error(
    error instanceof CatalogError ? error.code : "CATALOG_ENRICHMENT_FAILED",
  );
  process.exitCode = 1;
}
