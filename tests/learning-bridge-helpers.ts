import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { replayFixture } from "./signal-replay-helpers.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { hash } from "../src/core/policy.js";
import type { PaperExport } from "../src/core/paper-learning-schema.js";
export function bridgePlan(source: PaperExport, market: "KR" | "US" = "KR") {
  const times = [...new Set(source.journal.decisions.map((d) => d.at))].sort(
      (a, b) => a - b,
    ),
    first = times[0]!,
    last = times.at(-1)!;
  const iso = (n: number) => new Date(n).toISOString();
  return {
    schemaVersion: "ENGINE_LEARNING_PLAN_V1",
    experimentId: "engine-test-v1",
    market,
    signal: "B",
    model: {
      kind: "RIDGE_V1",
      lambda: 0.1,
      numericProfile: "JS_FLOAT64_RESEARCH_V1",
    },
    validation: {
      minTrainRows: 8,
      minTestRows: 2,
      embargoMinutes: 1,
      folds: [
        {
          id: "fold-1",
          trainFrom: iso(first - 60000),
          trainTo: iso(first + 60000),
          testFrom: iso(Math.max(first + 120000, last)),
          testTo: iso(source.asOf),
        },
      ],
    },
  };
}
export function bridgeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "learning-bridge-"));
  mkdirSync(join(dir, "outputs"));
  for (const f of [
    "AI_TRADING_POLICY_v2.3.json",
    "THEME_RESEARCH_POLICY_v1.3.json",
    "TRADING_STRATEGY_SPEC_v1.0.json",
  ])
    copyFileSync(resolve("outputs", f), join(dir, "outputs", f));
  return dir;
}
export function writeBridgeFixture(dir: string) {
  const raw = replayFixture(),
    f = portfolioFixture(raw);
  const histories = raw.histories.map((h, i) => {
    const file = `history-${i}.json`;
    writeFileSync(join(dir, file), JSON.stringify(h));
    return { assetKey: h.assetKey, file, snapshotHash: hash(h) };
  });
  writeFileSync(
    join(dir, "replay.json"),
    JSON.stringify({
      ...raw,
      schemaVersion: "OFFLINE_SIGNAL_REPLAY_MANIFEST_V1",
      histories,
    }),
  );
  const path = join(dir, "plan.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "OFFLINE_PORTFOLIO_PLAN_V1",
      purpose: "TEST_ONLY",
      replayFile: "replay.json",
      replayInputHash: hash(raw),
      settings: f.settings,
      commands: f.commands,
    }),
  );
  return path;
}
export function resign(source: PaperExport) {
  source.exportHash = hash(
    Object.fromEntries(
      Object.entries(source).filter(([key]) => key !== "exportHash"),
    ),
  );
  return source;
}
