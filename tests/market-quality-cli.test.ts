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

const cli = resolve("dist/runtime/src/server/market-quality-cli.js");
const fixture = resolve("fixtures/market-quality-v1.json");
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), "market-quality-cli-"));
  mkdirSync(join(directory, "outputs"));
  for (const file of [
    "AI_TRADING_POLICY_v2.3.json",
    "THEME_RESEARCH_POLICY_v1.3.json",
    "TRADING_STRATEGY_SPEC_v1.0.json",
  ])
    copyFileSync(resolve("outputs", file), join(directory, "outputs", file));
  return directory;
}
function run(
  directory: string,
  args: string[] = [fixture],
  env: NodeJS.ProcessEnv = {},
) {
  const guard =
    "data:text/javascript," +
    encodeURIComponent(
      "globalThis.fetch=()=>{throw new Error('UNEXPECTED_NETWORK')};",
    );
  const result = spawnSync(
    process.execPath,
    ["--import", guard, cli, ...args],
    {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      env: {
        ...process.env,
        TRADING_MODE: "PAPER",
        LIVE_ENABLED: "false",
        TOSS_CREDENTIAL_FILE: join(directory, "MUST_NOT_READ_KEY.txt"),
        TOSS_CATALOG_READ_ONLY: "false",
        TOSS_CATALOG_TERMS_CONFIRMED: "false",
        ...env,
      },
    },
  );
  assert.ifError(result.error);
  return result;
}
test("QUALITY-CLI-01 실제 자식 실행·4개 합성 창/안전 플래그·출력 분리", () => {
  const directory = sandbox(),
    before = readFileSync(fixture),
    result = run(directory);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout),
    report = JSON.parse(readFileSync(summary.reportPath, "utf8"));
  assert.equal(summary.result, "OFFLINE_MARKET_QUALITY_COMPLETE");
  assert.deepEqual(summary.counts, { assets: 4, valid: 4, blocked: 0 });
  assert.equal(report.status, "TEST_WINDOW_VALID");
  for (const key of [
    "realDataReady",
    "strategyReady",
    "strategyEvaluated",
    "paperOrdersEnabled",
    "liveEnabled",
  ])
    assert.equal(report[key], false);
  assert.ok(report.reasonDescriptions.BAR_MISSING);
  assert.deepEqual(readFileSync(fixture), before);
  assert.deepEqual(readdirSync(join(directory, "data")), [
    "market-quality-checks",
  ]);
});
test("QUALITY-CLI-02 반복 실행·입력과 기존 결과 보존·판단 재현", () => {
  const directory = sandbox(),
    first = JSON.parse(run(directory).stdout),
    before = readFileSync(first.reportPath);
  const second = JSON.parse(run(directory).stdout);
  assert.equal(first.decisionHash, second.decisionHash);
  assert.notEqual(first.reportPath, second.reportPath);
  assert.deepEqual(readFileSync(first.reportPath), before);
  assert.equal(
    readdirSync(join(directory, "data", "market-quality-checks")).length,
    2,
  );
});
test("QUALITY-CLI-03 모드/실거래/인자 거절은 출력 없음", () => {
  for (const [args, env] of [
    [[fixture], { TRADING_MODE: "LIVE" }],
    [[fixture], { LIVE_ENABLED: "true" }],
    [[], {}],
    [[fixture, fixture], {}],
  ] as const) {
    const directory = sandbox(),
      result = run(directory, [...args], env);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(readdirSync(directory), ["outputs"]);
  }
});
test("QUALITY-CLI-04 JSON/스키마/실자료 오류와 더미 비밀값 비노출", () => {
  const directory = sandbox(),
    path = join(directory, "input.json"),
    secret = "FAKE_PRIVATE_DO_NOT_PRINT";
  for (const body of [
    `{\"secret\":\"${secret}\"`,
    JSON.stringify({ secret }),
    JSON.stringify({
      ...JSON.parse(readFileSync(fixture, "utf8")),
      purpose: "REAL_DATA",
    }),
    readFileSync("fixtures/catalog-v1.json", "utf8"),
  ]) {
    writeFileSync(path, body);
    const result = run(directory, [path]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(secret));
    assert.equal(readFileSync(path, "utf8"), body);
  }
  assert.ok(!readdirSync(directory).includes("data"));
});
test("QUALITY-CLI-05 정책 변조·출력 저장 장애는 성공으로 표시하지 않음", () => {
  const directory = sandbox();
  writeFileSync(
    join(directory, "outputs", "AI_TRADING_POLICY_v2.3.json"),
    "{}",
  );
  assert.equal(run(directory).status, 1);
  assert.deepEqual(readdirSync(directory), ["outputs"]);
  const blocked = sandbox();
  mkdirSync(join(blocked, "data"));
  const path = join(blocked, "data", "market-quality-checks");
  writeFileSync(path, "KEEP");
  const result = run(blocked);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(path, "utf8"), "KEEP");
});
test("QUALITY-CLI-06 URL/UNC/없는 파일/크기 초과/잘못된 UTF-8 거절", () => {
  const directory = sandbox(),
    large = join(directory, "large.json"),
    invalid = join(directory, "invalid.json");
  writeFileSync(large, Buffer.alloc(16 * 1024 * 1024 + 1));
  writeFileSync(invalid, Buffer.from([0xff]));
  for (const path of [
    "https://example.invalid/input",
    "\\\\invalid\\input",
    join(directory, "FAKE_PRIVATE_PATH"),
    large,
    invalid,
  ]) {
    const result = run(directory, [path]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("FAKE_PRIVATE_PATH"));
  }
  assert.ok(!readdirSync(directory).includes("data"));
});
test("QUALITY-CLI-07 품질 보류는 명령 실패와 구분하고 사유 저장", () => {
  const directory = sandbox(),
    input = JSON.parse(readFileSync(fixture, "utf8"));
  input.records = [];
  const path = join(directory, "blocked.json");
  writeFileSync(path, JSON.stringify(input));
  const result = run(directory, [path]);
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout),
    report = JSON.parse(readFileSync(summary.reportPath, "utf8"));
  assert.equal(summary.status, "BLOCKED");
  assert.equal(summary.counts.blocked, 4);
  assert.ok(report.items[0].reasons.includes("BAR_MISSING"));
  assert.equal(report.paperOrdersEnabled, false);
});
