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

const cli = resolve("dist/runtime/src/server/signal-replay-cli.js"),
  sampler = resolve("dist/runtime/src/server/signal-replay-sample-cli.js");
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "signal-replay-cli-"));
  mkdirSync(join(dir, "outputs"));
  for (const file of [
    "AI_TRADING_POLICY_v2.3.json",
    "THEME_RESEARCH_POLICY_v1.3.json",
    "TRADING_STRATEGY_SPEC_v1.0.json",
  ])
    copyFileSync(resolve("outputs", file), join(dir, "outputs", file));
  return dir;
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
      "globalThis.fetch=()=>{throw new Error('UNEXPECTED_NETWORK')};",
    );
  const result = spawnSync(
    process.execPath,
    ["--import", guard, command, ...args],
    {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true,
      timeout: 90000,
      env: {
        ...process.env,
        TRADING_MODE: "PAPER",
        LIVE_ENABLED: "false",
        TOSS_CREDENTIAL_FILE: join(dir, "MUST_NOT_READ_KEY.txt"),
        TOSS_CATALOG_READ_ONLY: "false",
        TOSS_CATALOG_TERMS_CONFIRMED: "false",
        ...env,
      },
    },
  );
  assert.ifError(result.error);
  return result;
}
const sampleDirectory = sandbox(),
  sampleRun = run(sampleDirectory, [], {}, sampler);
assert.equal(sampleRun.status, 0, sampleRun.stderr);
const samplePath: string = JSON.parse(sampleRun.stdout).manifestPath;
const manifest = JSON.parse(readFileSync(samplePath, "utf8"));
function blockedInput(dir: string) {
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ ...manifest, histories: [] }));
  return path;
}

test("REPLAY-CLI-01 샘플 생성과 실제 재생: 120x390분·두 종목·두 시점", () => {
  const before = readFileSync(samplePath),
    result = run(sampleDirectory, [samplePath]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout),
    report = JSON.parse(readFileSync(summary.reportPath, "utf8"));
  assert.equal(summary.result, "OFFLINE_SIGNAL_REPLAY_COMPLETE");
  assert.deepEqual(summary.counts, {
    frames: 2,
    instrumentDecisions: 4,
    evaluated: 4,
    signals: 2,
    noSignals: 1,
    blocked: 1,
  });
  assert.equal(
    report.frames[0].items[0].historyCounts.instrument.sessions,
    120,
  );
  assert.equal(report.frames[0].items[0].historyCounts.instrument.bars, 46845);
  assert.deepEqual(report.frames[0].items[0].evaluation.strategies, ["B"]);
  assert.deepEqual(report.frames[1].items[1].evaluation.strategies, ["P"]);
  assert.equal(report.liveEnabled, false);
  assert.equal(report.paperOrdersEnabled, false);
  assert.deepEqual(readFileSync(samplePath), before);
  assert.deepEqual(readdirSync(join(sampleDirectory, "data")).sort(), [
    "signal-replay-inputs",
    "signal-replay-reports",
  ]);
});
test("REPLAY-CLI-02 이력 없음도 보류 보고서 저장·반복 출력/판단 재현·기존 보존", () => {
  const dir = sandbox(),
    input = blockedInput(dir),
    first = run(dir, [input]);
  assert.equal(first.status, 0);
  const one = JSON.parse(first.stdout),
    before = readFileSync(one.reportPath);
  const two = JSON.parse(run(dir, [input]).stdout);
  assert.equal(one.counts.blocked, 4);
  assert.equal(one.counts.evaluated, 0);
  assert.equal(one.decisionHash, two.decisionHash);
  assert.notEqual(one.reportPath, two.reportPath);
  assert.deepEqual(readFileSync(one.reportPath), before);
});
test("REPLAY-CLI-03 LIVE·인자·프로필 위조 입력 시작 거절", () => {
  for (const [args, env] of [
    [[], {}],
    [[samplePath, samplePath], {}],
    [[samplePath], { TRADING_MODE: "LIVE" }],
    [[samplePath], { LIVE_ENABLED: "true" }],
  ] as const) {
    const dir = sandbox(),
      result = run(dir, [...args], env);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(readdirSync(dir), ["outputs"]);
  }
  const dir = sandbox();
  assert.equal(run(dir, [], { LIVE_ENABLED: "true" }, sampler).status, 1);
});
test("REPLAY-CLI-04 정책 변경·저장 실패는 완료 출력 없이 기존 파일 보존", () => {
  const dir = sandbox(),
    input = blockedInput(dir);
  writeFileSync(join(dir, "outputs", "AI_TRADING_POLICY_v2.3.json"), "{}");
  assert.equal(run(dir, [input]).status, 1);
  const b = sandbox(),
    path = blockedInput(b);
  mkdirSync(join(b, "data"));
  const collision = join(b, "data", "signal-replay-reports");
  writeFileSync(collision, "KEEP");
  const result = run(b, [path]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(collision, "utf8"), "KEEP");
});
test("REPLAY-CLI-05 URL/UNC/장치·상위 경로·절대 경로·중복 파일 금지", () => {
  const dir = sandbox(),
    input = join(dir, "manifest.json");
  for (const file of [
    "../secret.json",
    "C:/secret.json",
    "https://example.invalid/data",
    "\\\\server\\data",
    "a/b.json",
    "..json",
  ]) {
    writeFileSync(
      input,
      JSON.stringify({
        ...manifest,
        histories: [{ ...manifest.histories[0], file }],
      }),
    );
    const r = run(dir, [input]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), "SIGNAL_REPLAY_MANIFEST_INVALID");
  }
  writeFileSync(
    input,
    JSON.stringify({
      ...manifest,
      histories: [manifest.histories[0], manifest.histories[0]],
    }),
  );
  assert.equal(
    run(dir, [input]).stderr.trim(),
    "SIGNAL_REPLAY_DUPLICATE_FILE_BINDING",
  );
  assert.equal(run(dir, ["https://example.invalid/input"]).status, 1);
});
test("REPLAY-CLI-06 이력 스냅샷/종목 연결 해시 변조와 파일 누락", () => {
  const dir = sandbox(),
    input = join(dir, "manifest.json");
  const minimal = {
    schemaVersion: "OFFLINE_SIGNAL_HISTORY_V1",
    purpose: "TEST_ONLY",
    assetKey: manifest.histories[0].assetKey,
    datasetId: "TEST",
    sourceId: "TEST-FEED",
    identity: manifest.frames[0].market.assets[0].identity,
    basis: "RAW",
    sessions: [],
    actions: [],
    actionCoverage: null,
  };
  writeFileSync(join(dir, "history-0.json"), JSON.stringify(minimal));
  writeFileSync(
    input,
    JSON.stringify({ ...manifest, histories: [manifest.histories[0]] }),
  );
  assert.equal(
    run(dir, [input]).stderr.trim(),
    "SIGNAL_HISTORY_SNAPSHOT_MISMATCH",
  );
  writeFileSync(
    input,
    JSON.stringify({
      ...manifest,
      histories: [{ ...manifest.histories[0], file: "missing.json" }],
    }),
  );
  assert.equal(run(dir, [input]).status, 1);
});
test("REPLAY-CLI-07 오염 JSON·실자료/승인 위조·더미 비밀값 비노출", () => {
  const dir = sandbox(),
    input = join(dir, "manifest.json"),
    secret = "FAKE_SECRET_DO_NOT_PRINT";
  for (const body of [
    `{\"${secret}\":`,
    JSON.stringify({ ...manifest, histories: [], purpose: "REAL_DATA" }),
    JSON.stringify({ ...manifest, histories: [], approved: secret }),
  ]) {
    writeFileSync(input, body);
    const result = run(dir, [input]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(secret));
    assert.equal(readFileSync(input, "utf8"), body);
  }
});
test("REPLAY-CLI-08 UTF-8·16 MiB·원본 시점 불일치 거절", () => {
  const dir = sandbox(),
    input = join(dir, "input.json");
  for (const body of [
    Buffer.from([0xff]),
    Buffer.alloc(16 * 1024 * 1024 + 1),
  ]) {
    writeFileSync(input, body);
    assert.equal(run(dir, [input]).status, 1);
  }
  const f = structuredClone(manifest);
  f.histories = [];
  f.frames[0].market.asOf = "2026-09-01T00:00:00.000Z";
  writeFileSync(input, JSON.stringify(f));
  assert.equal(
    run(dir, [input]).stderr.trim(),
    "MULTI_PREFLIGHT_AS_OF_MISMATCH",
  );
});
