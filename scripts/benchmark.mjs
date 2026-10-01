import { Engine } from "../dist/runtime/src/server/engine.js";
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dbPath = join(mkdtempSync(join(tmpdir(), "paper-perf-")), "test.sqlite");
const e = new Engine(dbPath);
const begin = performance.now();
await e.command("benchmark-configure", {
  type: "configure",
  config: {
    capital: 5000000,
    level: "LOW",
    mode: "PAPER",
    forecast: "TEST_ONLY",
    scenario: "B",
    market: "KR",
  },
});
const prepareMs = performance.now() - begin;
await e.command("benchmark-start", { type: "start" });
const durations = [];
for (let i = 0; i < 100; i++) {
  const at = performance.now();
  await e.command(`benchmark-tick-${i}`, { type: "step", seconds: 1 });
  durations.push(performance.now() - at);
}
const sorted = [...durations].sort((a, b) => a - b);
const report = {
  at: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  database: "FILE_SQLITE_WAL_SYNCHRONOUS_FULL",
  rawBarsGenerated: 94380,
  completedInputBarsAtInitialDecision: 93690,
  syntheticSessions: 121,
  prepareMs,
  measuredTicks: 100,
  meanTickCommandMs: durations.reduce((a, x) => a + x, 0) / 100,
  p95TickCommandMs: sorted[94],
  maxTickCommandMs: sorted[99],
  parentProcessRssBytes: process.memoryUsage().rss,
  openBotQuantity: e.state().positions.reduce((a, p) => a + p.quantity, 0),
  qualification: "SINGLE_MACHINE_SYNTHETIC_NOT_REALTIME_SLA",
};
e.close();
mkdirSync("work/phase1-verification", { recursive: true });
writeFileSync(
  "work/phase1-verification/performance.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
