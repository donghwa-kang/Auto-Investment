import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertOffline, verifyPolicies, hash } from "../core/policy.js";
import { parseSignalReplay } from "../core/signal-replay-schema.js";
import { portfolioFixture } from "../core/portfolio-fixture.js";
import { loadSignalReplay } from "./signal-replay-file.js";
import { MAX_CATALOG_BYTES } from "./catalog-file.js";

try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  verifyPolicies();
  if (process.argv.length !== 3) throw new Error("REPLAY_MANIFEST_REQUIRED");
  const input = parseSignalReplay(loadSignalReplay(process.argv[2]!));
  const sample = portfolioFixture(input);
  const root = resolve("data", "portfolio-paper-inputs");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, "sample-"));
  const write = (name: string, value: unknown) => {
    const body = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(body) > MAX_CATALOG_BYTES)
      throw new Error("SAMPLE_TOO_LARGE");
    writeFileSync(resolve(directory, name), body, { flag: "wx", mode: 0o600 });
  };
  const histories = input.histories.map((h, i) => {
    const file = `history-${i}.json`;
    write(file, h);
    return { assetKey: h.assetKey, file, snapshotHash: hash(h) };
  });
  write("replay.json", {
    ...input,
    schemaVersion: "OFFLINE_SIGNAL_REPLAY_MANIFEST_V1",
    histories,
  });
  write("plan.json", {
    schemaVersion: "OFFLINE_PORTFOLIO_PLAN_V1",
    purpose: "TEST_ONLY",
    replayFile: "replay.json",
    replayInputHash: hash(input),
    settings: sample.settings,
    commands: sample.commands,
  });
  console.log(
    JSON.stringify({
      result: "OFFLINE_PORTFOLIO_SAMPLE_CREATED",
      planPath: resolve(directory, "plan.json"),
      purpose: "TEST_ONLY",
      liveEnabled: false,
    }),
  );
} catch {
  console.error("PORTFOLIO_SAMPLE_FAILED");
  process.exitCode = 1;
}
