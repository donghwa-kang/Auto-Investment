import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertOffline } from "../core/policy.js";
import { CatalogError } from "../core/catalog-schema.js";
import { catalogReasons } from "../core/catalog.js";
import type { TossCatalogReport } from "./toss-catalog-client.js";
import { sourceTimeReason } from "./toss-catalog-cache-validation.js";

export function assertCatalogFetchAllowed(env: NodeJS.ProcessEnv) {
  try {
    assertOffline(env.TRADING_MODE ?? "PAPER", env.LIVE_ENABLED ?? false);
  } catch {
    throw new CatalogError("CATALOG_LIVE_DISABLED");
  }
  if (env.TOSS_CATALOG_READ_ONLY !== "true")
    throw new CatalogError("CATALOG_READ_ONLY_CONFIRMATION_REQUIRED");
  if (env.TOSS_CATALOG_TERMS_CONFIRMED !== "true")
    throw new CatalogError("CATALOG_TERMS_AND_COST_CONFIRMATION_REQUIRED");
  if (!env.TOSS_CREDENTIAL_FILE)
    throw new CatalogError("CATALOG_CREDENTIAL_FILE_REQUIRED");
  if (/^[\\/]{2}|^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(env.TOSS_CREDENTIAL_FILE))
    throw new CatalogError("CATALOG_LOCAL_CREDENTIAL_FILE_REQUIRED");
}

export function writeTossCatalogReport(
  report: TossCatalogReport,
  root = process.cwd(),
) {
  const directory = resolve(root, "data", "toss-catalogs");
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
          SOURCE_TIME_UNKNOWN: sourceTimeReason,
        },
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return reportPath;
}
