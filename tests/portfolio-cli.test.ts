import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { replayFixture } from "./signal-replay-helpers.js";
import { hash } from "../src/core/policy.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
const cli = resolve("dist/runtime/src/server/portfolio-cli.js"),
  sampler = resolve("dist/runtime/src/server/portfolio-sample-cli.js");
function sandbox(blocked = false) {
  const dir = mkdtempSync(join(tmpdir(), "portfolio-cli-"));
  mkdirSync(join(dir, "outputs"));
  for (const f of [
    "AI_TRADING_POLICY_v2.3.json",
    "THEME_RESEARCH_POLICY_v1.3.json",
    "TRADING_STRATEGY_SPEC_v1.0.json",
  ])
    copyFileSync(resolve("outputs", f), join(dir, "outputs", f));
  const raw = replayFixture();
  if (blocked) raw.histories = [];
  const f = portfolioFixture(raw);
  const histories = raw.histories.map((h, i) => {
    const file = `h${i}.json`;
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
  const plan = {
    schemaVersion: "OFFLINE_PORTFOLIO_PLAN_V1",
    purpose: "TEST_ONLY",
    replayFile: "replay.json",
    replayInputHash: hash(raw),
    settings: f.settings,
    commands: f.commands,
  };
  const path = join(dir, "plan.json");
  writeFileSync(path, JSON.stringify(plan));
  return { dir, path, plan };
}
function run(
  dir: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  command = cli,
) {
  const guard =
    "data:text/javascript," +
    encodeURIComponent(
      "import http from 'node:http';import https from 'node:https';const fail=()=>{throw Error('UNEXPECTED_NETWORK')};globalThis.fetch=fail;http.request=fail;https.request=fail;",
    );
  const r = spawnSync(process.execPath, ["--import", guard, command, ...args], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    env: {
      ...process.env,
      TRADING_MODE: "PAPER",
      LIVE_ENABLED: "false",
      TOSS_CREDENTIAL_FILE: join(dir, "DO_NOT_READ_KEY.txt"),
      ...env,
    },
  });
  assert.ifError(r.error);
  return r;
}
test("PORTFOLIO-CLI-01 실제 샘플 명령→새 독립 DB·보고서·반복 재현/이전 보존", () => {
  const { dir } = sandbox();
  const generated = run(dir, [join(dir, "replay.json")], {}, sampler);
  assert.equal(generated.status, 0, generated.stderr);
  const path = JSON.parse(generated.stdout).planPath as string,
    before = readFileSync(path);
  const first = run(dir, [path]);
  assert.equal(first.status, 0, first.stderr);
  const a = JSON.parse(first.stdout),
    body = readFileSync(a.reportPath),
    report = JSON.parse(body.toString());
  assert.equal(a.approved, 2);
  assert.equal(a.simulatedOrders, 4);
  assert.equal(a.pendingOrders, 0);
  assert.equal(a.openPositions, 0);
  assert.equal(a.liveEnabled, false);
  assert.equal(report.state.orders.length, 4);
  const second = run(dir, [path]);
  assert.equal(second.status, 0, second.stderr);
  const b = JSON.parse(second.stdout);
  assert.equal(a.stateHash, b.stateHash);
  assert.notEqual(a.databasePath, b.databasePath);
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readFileSync(a.reportPath), body);
  assert.deepEqual(readdirSync(join(dir, "data")).sort(), [
    "portfolio-paper-inputs",
    "portfolio-paper-runs",
  ]);
});
test("PORTFOLIO-CLI-02 이력 보류는 모의 주문 없이 근거를 보고한다", () => {
  const { dir, path } = sandbox(true),
    r = run(dir, [path]);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.approved, 0);
  assert.equal(result.abstained, 4);
  assert.equal(result.simulatedOrders, 0);
});
test("PORTFOLIO-CLI-03 LIVE·초과 인자·경로 탐색·해시/정책 변경은 쓰기 전 거절", () => {
  const { dir, path, plan } = sandbox(true);
  for (const [args, env] of [
    [[], {}],
    [[path, path], {}],
    [[path], { TRADING_MODE: "LIVE" }],
    [[path], { LIVE_ENABLED: "true" }],
  ] as const) {
    const r = run(dir, [...args], env);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
  }
  for (const replacement of [
    { replayFile: "../secret.json" },
    { replayInputHash: "0".repeat(64) },
    { purpose: "REAL_DATA" },
  ]) {
    writeFileSync(path, JSON.stringify({ ...plan, ...replacement }));
    const r = run(dir, [path]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
  }
  writeFileSync(path, JSON.stringify(plan));
  writeFileSync(join(dir, "outputs", "AI_TRADING_POLICY_v2.3.json"), "{}");
  assert.equal(run(dir, [path]).status, 1);
  assert.ok(!readdirSync(dir).includes("data"));
});
test("PORTFOLIO-CLI-04 저장 경로 충돌은 기존 파일을 보존한다", () => {
  const { dir, path } = sandbox(true);
  mkdirSync(join(dir, "data"));
  const collision = join(dir, "data", "portfolio-paper-runs");
  writeFileSync(collision, "KEEP");
  const r = run(dir, [path]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(readFileSync(collision, "utf8"), "KEEP");
});
test("PORTFOLIO-CLI-05 실행 중 잘못된 시각은 실패 DB를 남기고 성공 출력하지 않는다", () => {
  const { dir, path, plan } = sandbox(true);
  plan.commands.push({
    type: "tick",
    at: 0,
    accountAt: 0,
    fx: { rate: "1300", at: 0 },
    quotes: [],
    frameAsOf: null,
  });
  writeFileSync(path, JSON.stringify(plan));
  const r = run(dir, [path]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  const root = join(dir, "data", "portfolio-paper-runs"),
    folder = readdirSync(root)[0]!;
  const failure = JSON.parse(
    readFileSync(join(root, folder, "failure.json"), "utf8"),
  );
  assert.equal(failure.reconciliationRequired, true);
  assert.equal(failure.liveEnabled, false);
  assert.ok(failure.state.clock > 0);
  assert.ok(!readdirSync(join(root, folder)).includes("report.json"));
});
