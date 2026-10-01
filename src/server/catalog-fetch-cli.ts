import { CatalogError } from "../core/catalog-schema.js";
import { verifyPolicies } from "../core/policy.js";
import { assertCatalogFetchAllowed } from "./catalog-fetch.js";
import { collectDailyCatalog } from "./toss-catalog-cache.js";
import { TossCatalogClient } from "./toss-catalog-client.js";
import { readCredentials } from "./toss-market-data.js";

// 웹 서버·합성 엔진·사용자 DB는 시작하거나 변경하지 않는다.
try {
  if (process.argv.length !== 2)
    throw new CatalogError("CATALOG_FETCH_NO_ARGUMENTS");
  assertCatalogFetchAllowed(process.env);
  verifyPolicies();
  const report = await collectDailyCatalog(() => {
    const credentials = readCredentials(process.env.TOSS_CREDENTIAL_FILE!);
    return new TossCatalogClient().collect(credentials);
  });
  console.log(JSON.stringify(report));
  if (!report.allScopesReceived || !report.dataQualityComplete)
    process.exitCode = 2;
} catch (error: unknown) {
  console.error(
    error instanceof CatalogError ? error.code : "CATALOG_FETCH_FAILED",
  );
  process.exitCode = 1;
}
