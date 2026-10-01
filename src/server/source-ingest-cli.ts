import { assertOffline, verifyPolicies } from "../core/policy.js";
import { CatalogError } from "../core/catalog-schema.js";
import { IngestError } from "../core/source-ingest-schema.js";
import { ingestMockSource } from "../core/source-ingest.js";
import { readCatalogFile } from "./catalog-file.js";
import { saveSourceIngest } from "./source-ingest-store.js";

try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  if (process.argv.length !== 3)
    throw new IngestError("ONE_SOURCE_INGEST_FILE_REQUIRED");
  verifyPolicies();
  const report = ingestMockSource(readCatalogFile(process.argv[2]!));
  const reportPath = saveSourceIngest(report);
  console.log(
    JSON.stringify({
      result: "OFFLINE_SOURCE_INGEST_COMPLETE",
      purpose: report.purpose,
      dataOrigin: report.dataOrigin,
      status: report.status,
      counts: report.counts,
      networkRequests: 0,
      realDataReady: false,
      paperOrdersEnabled: false,
      liveEnabled: false,
      reportHash: report.reportHash,
      reportPath,
    }),
  );
} catch (error: unknown) {
  console.error(
    error instanceof IngestError || error instanceof CatalogError
      ? error.code
      : "SOURCE_INGEST_FAILED",
  );
  process.exitCode = 1;
}
