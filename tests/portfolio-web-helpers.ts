import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { hash } from "../src/core/policy.js";
import type { WebSetup } from "../src/core/portfolio-web-schema.js";
import { replayFixture } from "./signal-replay-helpers.js";
export const webSetup: WebSetup = {
  capital: 5000000,
  usdCapitalKrw: 0,
  level: "LOW",
  stage: "PILOT",
  forecast: "TEST_ONLY",
  sampleMarket: "KR",
  acknowledgeSynthetic: true,
};
export function webDirectory(setup = webSetup) {
  const root = mkdtempSync(resolve(tmpdir(), "paper-web-test-")),
    id = randomUUID(),
    directory = resolve(root, id);
  mkdirSync(directory);
  const input = replayFixture(),
    f = portfolioFixture(input);
  f.settings.config = {
    ...f.settings.config,
    capital: setup.capital,
    usdCapitalKrw: setup.usdCapitalKrw,
    level: setup.level,
    stage: setup.stage,
    forecast: setup.forecast,
  };
  const write = (name: string, v: unknown) =>
    writeFileSync(resolve(directory, name), JSON.stringify(v), { flag: "wx" });
  write("request.json", { id, setup, createdAt: new Date().toISOString() });
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
    settings: f.settings,
    commands: f.commands,
  });
  return { root, id, directory };
}
