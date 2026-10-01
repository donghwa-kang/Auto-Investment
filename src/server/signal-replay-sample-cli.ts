import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertOffline, verifyPolicies, hash } from "../core/policy.js";
import { makeSignalReplayFixture } from "../core/signal-replay-fixture.js";
import { MAX_CATALOG_BYTES } from "./catalog-file.js";

try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  if (process.argv.length !== 2) throw new Error("NO_SAMPLE_ARGUMENTS");
  verifyPolicies();
  const fixture = makeSignalReplayFixture();
  const directory = resolve(
    "data",
    "signal-replay-inputs",
    `${Date.now()}-${randomUUID()}`,
  );
  mkdirSync(directory, { recursive: true });
  const histories = fixture.histories.map((h, i) => {
    const file = `history-${i}.json`,
      body = JSON.stringify(h) + "\n";
    if (Buffer.byteLength(body) > MAX_CATALOG_BYTES)
      throw new Error("SAMPLE_TOO_LARGE");
    writeFileSync(resolve(directory, file), body, { flag: "wx", mode: 0o600 });
    return { assetKey: h.assetKey, file, snapshotHash: hash(h) };
  });
  const manifestPath = resolve(directory, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        ...fixture,
        schemaVersion: "OFFLINE_SIGNAL_REPLAY_MANIFEST_V1",
        histories,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      result: "SYNTHETIC_REPLAY_SAMPLE_CREATED",
      manifestPath,
      historyFiles: histories.length,
      frames: fixture.frames.length,
      ordersEnabled: false,
    }),
  );
} catch {
  console.error("SIGNAL_REPLAY_SAMPLE_FAILED");
  process.exitCode = 1;
}
