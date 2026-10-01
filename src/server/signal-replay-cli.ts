import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertOffline, verifyPolicies } from "../core/policy.js";
import { CatalogError } from "../core/catalog-schema.js";
import { runSignalReplay, replayReasons } from "../core/signal-replay.js";
import { historyReasons } from "../core/signal-history.js";
import { loadSignalReplay } from "./signal-replay-file.js";

try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  if (process.argv.length !== 3)
    throw new CatalogError("ONE_REPLAY_MANIFEST_ARGUMENT_REQUIRED");
  verifyPolicies();
  const report = runSignalReplay(loadSignalReplay(process.argv[2]!));
  const directory = resolve("data", "signal-replay-reports");
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
        reasonDescriptions: { ...historyReasons, ...replayReasons },
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      result: "OFFLINE_SIGNAL_REPLAY_COMPLETE",
      stage: report.stage,
      counts: report.counts,
      decisionHash: report.decisionHash,
      paperOrdersEnabled: false,
      liveEnabled: false,
      reportPath,
    }),
  );
} catch (error: unknown) {
  console.error(
    error instanceof CatalogError ? error.code : "SIGNAL_REPLAY_FAILED",
  );
  process.exitCode = 1;
}
