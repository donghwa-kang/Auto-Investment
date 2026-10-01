import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { hash } from "../src/core/policy.js";
import { d } from "../src/core/math.js";

const cli = resolve("dist/runtime/src/server/execution-evidence-cli.js");
test("EVIDENCE-CLI-01 고정 샘플은 새 보고서와 실제 보정 불가를 기록한다", () => {
  const child = spawnSync(process.execPath, [cli], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.result, "OFFLINE_EXECUTION_EVIDENCE_COMPLETE");
  assert.equal(output.realCalibrationReady, false);
  const rel = relative(
    resolve("work/execution-evidence-runs"),
    output.reportPath,
  );
  assert.ok(!isAbsolute(rel) && !rel.startsWith(".."));
  const report = JSON.parse(readFileSync(output.reportPath, "utf8"));
  const { reportHash, ...content } = report;
  assert.equal(reportHash, hash(content));
  assert.equal(report.status, "MOCK_DIAGNOSTIC_COMPLETE");
  assert.equal(report.counts.quoteObservations, 1);
  assert.equal(report.rows[0].tick.oneTickForQuantity, "0.04");
  assert.equal(report.rows[0].tick.entryNotional, "404.4");
  assert.equal(
    report.spreadBps.median,
    d("0.1").div("101.05").mul(10000).toString(),
  );
  assert.equal(report.responseIntervalMs.median, "1000");
  for (const key of [
    "collectionAuthorized",
    "realCalibrationReady",
    "engineProfileApplied",
    "learningEligible",
    "liveEnabled",
  ])
    assert.equal(report[key], false);
  for (const key of [
    "feeEstimate",
    "orderLatencyEstimate",
    "cancellationLatencyEstimate",
  ])
    assert.equal(report[key], null);
});

test("EVIDENCE-CLI-02 인수·LIVE 설정은 거절하고 통과 보고서를 출력하지 않는다", () => {
  for (const [args, env] of [
    [["arbitrary-input.json"], {}],
    [[], { TRADING_MODE: "LIVE" }],
    [[], { LIVE_ENABLED: "true" }],
  ] as const) {
    const child = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, ...env },
    });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr.trim(), "EXECUTION_EVIDENCE_SAMPLE_FAILED");
  }
});
