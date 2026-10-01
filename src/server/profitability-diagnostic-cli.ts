import {
  diagnoseProfitability,
  ProfitabilityDiagnosticError,
} from "../core/profitability-diagnostic.js";
import { PaperLearningError } from "../core/paper-learning-schema.js";
import { assertOffline, verifyPolicies } from "../core/policy.js";
import { CatalogError } from "../core/catalog-schema.js";
import { readCatalogFile } from "./catalog-file.js";

// Deliberately no engine, database writer, registry, or network client.
try {
  assertOffline(process.env.TRADING_MODE ?? "PAPER", process.env.LIVE_ENABLED);
  verifyPolicies();
  if (process.argv.length !== 3)
    throw new ProfitabilityDiagnosticError("DIAGNOSTIC_ARGUMENTS_INVALID");
  console.log(
    JSON.stringify(
      diagnoseProfitability(readCatalogFile(process.argv[2]!)),
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    error instanceof ProfitabilityDiagnosticError ||
      error instanceof PaperLearningError ||
      error instanceof CatalogError
      ? error.code
      : "DIAGNOSTIC_COMMAND_FAILED",
  );
  process.exitCode = 1;
}
