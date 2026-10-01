import { CatalogError } from "../core/catalog-schema.js";
import { assertOffline, verifyPolicies } from "../core/policy.js";
import { readDailyCatalogCache } from "./toss-catalog-cache.js";

// 키·계좌·통신을 사용하지 않고 기존 당일 캐시만 검증한다.
try {
  if (process.argv.length !== 2)
    throw new CatalogError("CATALOG_CACHED_NO_ARGUMENTS");
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  verifyPolicies();
  console.log(JSON.stringify(readDailyCatalogCache()));
} catch (error: unknown) {
  console.error(
    error instanceof CatalogError ? error.code : "CATALOG_CACHED_FAILED",
  );
  process.exitCode = 1;
}
