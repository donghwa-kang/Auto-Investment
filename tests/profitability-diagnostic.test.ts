import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PortfolioProgram } from "../src/core/portfolio-program.js";
import { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { exportPaperLearning } from "../src/server/paper-learning-export.js";
import { diagnoseProfitability } from "../src/core/profitability-diagnostic.js";
import { bindSnapshot, hash, spec, type Config } from "../src/core/policy.js";
import type { PaperExport } from "../src/core/paper-learning-schema.js";
import { bridgeSandbox, resign } from "./learning-bridge-helpers.js";
import { replayFixture } from "./signal-replay-helpers.js";

const input = replayFixture(),
  fixture = portfolioFixture(input);
function recorded(
  overrides: Partial<Config> = {},
  commands = fixture.commands,
  raw = input,
) {
  const path = join(
    mkdtempSync(join(tmpdir(), "p0-diagnostic-")),
    "paper.sqlite",
  );
  const program = new PortfolioProgram(raw, {
    ...fixture.settings,
    config: { ...fixture.settings.config, ...overrides },
  });
  const engine = new PortfolioPaperEngine(program, path, {
    captureLearning: true,
  });
  try {
    for (const [i, cmd] of commands.entries()) engine.command(`case-${i}`, cmd);
  } finally {
    engine.close();
  }
  return { path, source: exportPaperLearning(path) };
}
const normal = recorded();
const missing = recorded({ forecast: "MISSING_PROFILE" });
const zero = recorded({ capital: 1 });
const empty = recorded({}, [{ type: "start" }]);
const pending = recorded({}, fixture.commands.slice(0, 2));

function report(source: PaperExport) {
  const before = hash(source),
    result = diagnoseProfitability(source);
  assert.equal(hash(source), before);
  for (const key of [
    "orderSubmissionAllowed",
    "learningAllowed",
    "automaticPromotion",
    "profitabilityValidated",
    "liveEnabled",
  ] as const)
    assert.equal(result[key], false);
  return result;
}
// Explicit diagnostic fixtures, not recorded engine outcomes. Their reconstructed
// checksum exercises consistency checking and is never claimed as authentication.
function traceFixture() {
  const s = structuredClone(empty.source);
  const at = s.asOf;
  const trace = (id: string, result: "PASS" | "FAIL" | "MISSING") => ({
    predicate_id: id,
    result,
    input_values: {},
    threshold: "TEST_ONLY",
    operator: "TEST_ONLY",
    reason: "EXPLICIT_DIAGNOSTIC_FIXTURE",
    strategy_version: spec.version,
    indicator_version: "DECIMAL40_V1",
    data_version: "TEST_ONLY",
    as_of: at,
  });
  s.journal.decisions.push({
    id: "diagnostic-fixture",
    at,
    symbol: "KR:DEMO",
    strategy: null,
    result: "ABSTAIN",
    quantity: 0,
    reasons: ["CHART_NO_SIGNAL"],
    trace: [
      trace("COMMON_HISTORY", "PASS"),
      trace("COMMON_WINDOW", "PASS"),
      trace("COMMON_TTL", "PASS"),
      trace("COMMON_DAILY", "FAIL"),
      trace("COMMON_BENCHMARK", "FAIL"),
      trace("COMMON_VOL_CEILING", "MISSING"),
      trace("COMMON_LIQUIDITY", "PASS"),
      trace("B_CONTIGUOUS", "PASS"),
      trace("B_FEATURES", "MISSING"),
      trace("P_CONTIGUOUS", "PASS"),
      trace("P_HISTORY_FEATURES", "MISSING"),
    ],
  });
  return resign(s);
}
test("P0-01 actual engine decisions, signals, intents, individual fills and closures have distinct denominators", () => {
  const r = report(normal.source);
  assert.equal(r.denominators.candidateDecisions, 4);
  assert.equal(r.denominators.selectedSignals, 2);
  assert.equal(r.denominators.buyIntents, 2);
  assert.equal(r.denominators.filledBuyIntents, 2);
  assert.equal(r.denominators.closedPositions, 2);
  assert.ok(r.denominators.fillEvents.BUY > 2);
  assert.ok(r.denominators.fillEvents.SELL > 2);
  assert.equal(r.stages.approval!.counts.PASS, 2);
  assert.equal(r.decisions.filter((v) => v.strategy === "B").length, 1);
  assert.equal(r.decisions.filter((v) => v.strategy === "P").length, 1);
});
test("P0-02 zero-capacity engine outcome does not manufacture one share, forecast or budget evidence", () => {
  const r = report(zero.source),
    signals = r.decisions.filter((v) => v.strategy !== null);
  assert.ok(signals.length > 0);
  assert.equal(r.denominators.buyIntents, 0);
  for (const v of signals) {
    assert.equal(v.zeroSizingRecorded, true);
    assert.equal(v.stages.sizing.status, "FAIL");
    assert.equal(v.stages.economic.status, "NOT_EVALUATED");
    assert.equal(v.oneShare.riskKrw, null);
    assert.equal(v.oneShare.budgetKrw, null);
  }
});
test("P0-03 missing forecast is UNKNOWN, not a sizing failure or a zero-cost prediction", () => {
  const r = report(missing.source),
    signals = r.decisions.filter((v) => v.strategy !== null);
  assert.ok(signals.length > 0);
  for (const v of signals) {
    assert.equal(v.recordedQuantity, 0);
    assert.equal(v.zeroSizingRecorded, false);
    assert.equal(v.stages.sizing.status, "UNKNOWN");
    assert.equal(v.stages.forecast.status, "UNKNOWN");
    assert.equal(v.stages.economic.status, "NOT_EVALUATED");
  }
});
test("P0-04 empty recorded journal has zero denominators, never fabricated win rates", () => {
  const r = report(empty.source);
  assert.equal(r.status, "NO_RECORDED_DECISIONS");
  assert.equal(r.denominators.candidateDecisions, 0);
  assert.deepEqual(r.decisions, []);
  assert.ok(r.funnels.every((f) => f.steps.every((s) => s.eligible === 0)));
  assert.equal(r.profitabilityValidated, false);
});
test("P0-05 multiple failures survive, whereas sequential denominator stops at the first blocker", () => {
  const r = report(traceFixture()),
    dec = r.decisions[0]!;
  assert.deepEqual(dec.paths.B.allFailures, [
    "COMMON_DAILY",
    "COMMON_BENCHMARK",
  ]);
  assert.deepEqual(dec.paths.B.firstBlocker, {
    id: "COMMON_DAILY",
    status: "FAIL",
  });
  assert.equal(
    r.predicateCounts.find((p) => p.id === "COMMON_BENCHMARK")!.counts.FAIL,
    1,
  );
  assert.equal(
    r.funnels[0]!.steps.find((p) => p.id === "COMMON_BENCHMARK")!.eligible,
    0,
  );
  assert.equal(
    dec.predicates.find((p) => p.id === "COMMON_VOL_CEILING")!.status,
    "UNKNOWN",
  );
  assert.equal(
    dec.predicates.find((p) => p.id === "B_BREAKOUT")!.status,
    "NOT_EVALUATED",
  );
  assert.equal(dec.stages.distance.status, "NOT_EVALUATED");
});
test("P0-06 absent trace is UNKNOWN, not not-evaluated, even for a recorded approval", () => {
  const s = structuredClone(normal.source);
  for (const dec of s.journal.decisions) dec.trace = [];
  const r = report(resign(s));
  assert.ok(r.predicateCounts.every((p) => p.counts.UNKNOWN === 4));
  assert.equal(r.denominators.buyIntents, 2);
  assert.deepEqual(r.denominators.chartPassPaths, { B: 0, P: 0 });
});
test("P0-07 unknown version and unknown predicate remain visible without granting passage", () => {
  const s = traceFixture(),
    trace = s.journal.decisions[0]!.trace;
  trace[0]!.strategy_version = "future";
  trace.push({ ...trace[1]!, predicate_id: "FUTURE_GATE", result: "FAIL" });
  const dec = report(resign(s)).decisions[0]!;
  assert.deepEqual(dec.paths.B.firstBlocker, {
    id: "COMMON_HISTORY",
    status: "UNKNOWN",
  });
  assert.deepEqual(dec.unmappedPredicates, [
    { id: "FUTURE_GATE", result: "FAIL" },
  ]);
});
for (const conflict of [false, true])
  test(`P0-08 repeated predicate ${conflict ? "conflicting" : "identical"} is rejected`, () => {
    const s = traceFixture(),
      dec = s.journal.decisions[0]!;
    dec.trace.push({ ...dec.trace[0]!, result: conflict ? "FAIL" : "PASS" });
    assert.throws(() => report(resign(s)), /DIAGNOSTIC_DUPLICATE_PREDICATE/);
  });
for (const kind of ["decision", "fill", "closure"] as const)
  test(`P0-09 duplicate ${kind} is rejected before counting`, () => {
    const s = structuredClone(normal.source);
    if (kind === "decision")
      s.journal.decisions.push(structuredClone(s.journal.decisions[0]!));
    if (kind === "fill")
      s.journal.fills.push(structuredClone(s.journal.fills[0]!));
    if (kind === "closure")
      s.journal.closures.push(structuredClone(s.journal.closures[0]!));
    assert.throws(() => report(resign(s)), /EVIDENCE_MISMATCH/);
  });
test("P0-10 approval plus rejection reason or a selected path FAIL is inconsistent", () => {
  for (const mode of ["reason", "trace"]) {
    const s = structuredClone(normal.source),
      dec = s.journal.decisions.find((v) => v.result === "APPROVED")!;
    if (mode === "reason") dec.reasons.push("NO_FEASIBLE_LOT");
    else
      dec.trace.find((v) => v.predicate_id === "COMMON_DAILY")!.result = "FAIL";
    assert.throws(() => report(resign(s)), /DIAGNOSTIC_DECISION_CONFLICT/);
  }
});
test("P0-11 corrupted export checksum and fill amount fail closed", () => {
  const s = structuredClone(normal.source);
  s.journal.fills[0]!.value = "1";
  assert.throws(() => report(s), /EVIDENCE_MISMATCH/);
  assert.throws(() => report(resign(s)), /EVIDENCE_MISMATCH/);
});
test("P0-12 approved integer KRW snapshots match independent BigInt one-share calculation", () => {
  const r = report(normal.source);
  for (const dec of r.decisions.filter((v) => v.result === "APPROVED")) {
    const snap = normal.source.orders.find(
      (o) => o.id === dec.buyIntentId,
    )!.snapshot!;
    const p = BigInt(String(snap.entry_price)),
      s = BigInt(String(snap.stop_price));
    // Fixed fixture: entry 1bp, stop exit 1bp + adverse buffer 2bp; KRW FX=1.
    assert.equal(snap.fx_rate, "1");
    const feeCeiling = (p + 3n * s + 9999n) / 10000n;
    const expected = p - s + feeCeiling;
    assert.equal(dec.oneShare.riskKrw, String(expected));
    assert.equal(
      dec.oneShare.withinRiskBudget,
      expected <= BigInt(String(snap.initial_budget)),
    );
    assert.equal(dec.oneShare.status, "KNOWN");
  }
});
test("P0-13 missing or noncanonical budget is UNKNOWN, not an assumed zero or Number coercion", () => {
  for (const value of [undefined, "1e3", "NaN", 1250, "-1"]) {
    const s = structuredClone(pending.source),
      order = s.orders.find((o) => o.side === "BUY")!;
    if (value === undefined) delete order.snapshot!.initial_budget;
    else order.snapshot!.initial_budget = value;
    order.snapshotHash = bindSnapshot(order.snapshot!);
    s.journal.decisions.find((v) => v.result === "APPROVED")!.snapshotHash =
      order.snapshotHash;
    const dec = report(resign(s)).decisions.find(
      (v) => v.result === "APPROVED",
    )!;
    assert.equal(dec.oneShare.status, "UNKNOWN");
  }
});
test("P0-14 pending intent is neither a failed fill nor a closed trade", () => {
  const r = report(pending.source),
    dec = r.decisions.find((v) => v.result === "APPROVED")!;
  assert.equal(dec.stages.fill.status, "UNKNOWN");
  assert.equal(dec.stages.closure.status, "NOT_EVALUATED");
  assert.equal(r.denominators.closedPositions, 0);
});
test("P0-15 repeated export/diagnosis leaves SQLite and input bytes unchanged with identical report", () => {
  const bytes = readFileSync(normal.path),
    inputHash = hash(normal.source);
  assert.deepEqual(
    report(normal.source),
    report(exportPaperLearning(normal.path)),
  );
  assert.deepEqual(readFileSync(normal.path), bytes);
  assert.equal(hash(normal.source), inputHash);
});
test("P0-16 actual engine missing history produces a recorded data gap, not a synthesized signal", () => {
  const raw = structuredClone(input);
  raw.histories = [];
  const { source } = recorded({}, fixture.commands.slice(0, 2), raw);
  const r = report(source);
  assert.equal(r.denominators.buyIntents, 0);
  assert.ok(r.reasonCounts.some((v) => /MISSING|HISTORY/.test(v.reason)));
  assert.ok(r.decisions.every((v) => v.oneShare.status === "UNKNOWN"));
});

const cli = resolve("dist/runtime/src/server/profitability-diagnostic-cli.js");
const guard =
  "data:text/javascript," +
  encodeURIComponent(`
import fs from 'node:fs';import net from 'node:net';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';
let violations=0;const deny=()=>{violations++;throw Error('OFFLINE_READONLY_GUARD')};globalThis.fetch=deny;net.Socket.prototype.connect=deny;net.connect=deny;net.createConnection=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;
fs.writeFileSync=deny;fs.appendFileSync=deny;fs.renameSync=deny;fs.unlinkSync=deny;fs.mkdirSync=deny;
const open=fs.openSync;fs.openSync=function(p,flag,...args){if(flag!=='r'||String(p)===process.env.TOSS_CREDENTIAL_FILE)return deny();return open.call(this,p,flag,...args)};
syncBuiltinESMExports();process.on('exit',()=>{if(violations)process.exitCode=91});
`);
function runCli(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, ["--import", guard, cli, ...args], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      TRADING_MODE: "PAPER",
      LIVE_ENABLED: "false",
      TOSS_CREDENTIAL_FILE: join(dir, "DO_NOT_READ.txt"),
      ...env,
    },
  });
  assert.ifError(r.error);
  assert.notEqual(r.status, 91, r.stderr);
  return r;
}
const dir = bridgeSandbox(),
  exportPath = join(dir, "export.json");
writeFileSync(exportPath, JSON.stringify(normal.source));
test("P0-17 CLI stdout equals pure report; no network/write/credential access or file changes", () => {
  const files = [
    exportPath,
    ...readdirSync(join(dir, "outputs")).map((v) => join(dir, "outputs", v)),
  ];
  const before = files.map((p) => readFileSync(p));
  const r = runCli(dir, [exportPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), report(normal.source));
  assert.deepEqual(
    files.map((p) => readFileSync(p)),
    before,
  );
  assert.deepEqual(readdirSync(dir).sort(), ["export.json", "outputs"]);
});
for (const [label, args, env] of [
  ["missing argument", [], {}],
  ["extra argument", [exportPath, "extra"], {}],
  ["remote URL", ["https://invalid.example/export.json"], {}],
  ["missing file", [join(dir, "missing.json")], {}],
  ["live mode", [exportPath], { TRADING_MODE: "LIVE" }],
  ["live flag", [exportPath], { LIVE_ENABLED: "true" }],
] as const)
  test(`P0-18 CLI rejects ${label} without report`, () => {
    const r = runCli(dir, [...args], env);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.doesNotMatch(r.stderr, /at .+\.ts|entry_price|snapshot/);
  });
test("P0-19 invalid JSON is rejected without leaking its contents", () => {
  const path = join(dir, "bad.json");
  writeFileSync(path, "{PRIVATE_SENTINEL");
  const r = runCli(dir, [path]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.doesNotMatch(r.stderr, /PRIVATE_SENTINEL/);
});
test("P0-20 skipped-feature marker cannot coexist with executed branch predicates", () => {
  const s = traceFixture(),
    dec = s.journal.decisions[0]!;
  dec.trace.push({ ...dec.trace[0]!, predicate_id: "B_BREAKOUT" });
  assert.throws(() => report(resign(s)), /DIAGNOSTIC_TRACE_CONFLICT/);
});
test("P0-21 mutually exclusive forecast and quantity evidence is rejected", () => {
  for (const reasons of [
    ["NO_FEASIBLE_LOT", "ECONOMIC_GATE"],
    ["MISSING_FORECAST_PROFILE", "INVALID_FORECAST"],
  ]) {
    const s = structuredClone(missing.source),
      dec = s.journal.decisions.find((v) => v.strategy !== null)!;
    dec.reasons = reasons;
    assert.throws(() => report(resign(s)), /DIAGNOSTIC_DECISION_CONFLICT/);
  }
});
test("P0-22 exact risk budget boundary is a risk-only observation, never approval", () => {
  const base = report(pending.source).decisions.find(
    (v) => v.result === "APPROVED",
  )!.oneShare.riskKrw!;
  for (const budget of [BigInt(base), BigInt(base) - 1n]) {
    const s = structuredClone(pending.source),
      order = s.orders.find((o) => o.side === "BUY")!;
    order.snapshot!.initial_budget = String(budget);
    order.snapshotHash = bindSnapshot(order.snapshot!);
    s.journal.decisions.find((v) => v.result === "APPROVED")!.snapshotHash =
      order.snapshotHash;
    const r = report(resign(s)),
      dec = r.decisions.find((v) => v.result === "APPROVED")!;
    assert.equal(dec.oneShare.withinRiskBudget, budget === BigInt(base));
    assert.equal(r.orderSubmissionAllowed, false);
  }
});
