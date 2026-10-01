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

const cli = resolve("dist/runtime/src/server/multi-preflight-cli.js"),
  fixture = resolve("fixtures/multi-preflight-v1.json");
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), "multi-preflight-cli-"));
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
test("PREFLIGHT-CLI-01 실제 자식 실행·혼합 사전점검/단계 근거/잠금·출력 분리", () => {
  const directory = sandbox(),
    before = readFileSync(fixture),
    result = run(directory);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout),
    report = JSON.parse(readFileSync(summary.reportPath, "utf8"));
  assert.equal(summary.result, "OFFLINE_MULTI_PREFLIGHT_COMPLETE");
  assert.equal(summary.status, "HAS_BLOCKS");
  assert.deepEqual(summary.counts, {
    catalogItems: 8,
    passed: 4,
    excluded: 1,
    blocked: 3,
    testCandidates: 2,
  });
  assert.deepEqual(summary.testCandidates, ["KR:TEST-KR", "US:TEST-US"]);
  for (const key of [
    "realDataReady",
    "strategyReady",
    "strategyEvaluated",
    "selectionPerformed",
    "paperOrdersEnabled",
    "liveEnabled",
  ])
    assert.equal(report[key], false);
  assert.ok(report.stageReports.catalog);
  assert.ok(report.stageReports.enrichment);
  assert.ok(report.stageReports.market);
  assert.ok(report.reasonDescriptions.BENCHMARK_PREFLIGHT_BLOCKED);
  assert.deepEqual(readFileSync(fixture), before);
  assert.deepEqual(readdirSync(join(directory, "data")), [
    "multi-preflight-checks",
  ]);
});
test("PREFLIGHT-CLI-02 반복 실행·입력/기존 결과 보존·판단 재현", () => {
  const directory = sandbox(),
    first = JSON.parse(run(directory).stdout),
    before = readFileSync(first.reportPath);
  const second = JSON.parse(run(directory).stdout);
  assert.equal(first.decisionHash, second.decisionHash);
  assert.notEqual(first.reportPath, second.reportPath);
  assert.deepEqual(readFileSync(first.reportPath), before);
  assert.equal(
    readdirSync(join(directory, "data", "multi-preflight-checks")).length,
    2,
  );
});
test("PREFLIGHT-CLI-03 모드/실거래/인자 거절·입력 없음은 출력 생성 없음", () => {
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
test("PREFLIGHT-CLI-04 JSON/실자료/통과 위조·더미 비밀값 비노출", () => {
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
    JSON.stringify({
      ...JSON.parse(readFileSync(fixture, "utf8")),
      approved: true,
    }),
    readFileSync("fixtures/market-quality-v1.json", "utf8"),
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
test("PREFLIGHT-CLI-05 정책 변조·출력 저장 장애에서 성공 표시/덮어쓰기 금지", () => {
  const directory = sandbox();
  writeFileSync(
    join(directory, "outputs", "AI_TRADING_POLICY_v2.3.json"),
    "{}",
  );
  assert.equal(run(directory).status, 1);
  assert.deepEqual(readdirSync(directory), ["outputs"]);
  const blocked = sandbox();
  mkdirSync(join(blocked, "data"));
  const path = join(blocked, "data", "multi-preflight-checks");
  writeFileSync(path, "KEEP");
  const result = run(blocked);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(path, "utf8"), "KEEP");
});
test("PREFLIGHT-CLI-06 URL/UNC/누락/과대 파일/잘못된 UTF-8 거절", () => {
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
test("PREFLIGHT-CLI-07 공통 시점 불일치는 전체 거절·보류 결과와 구분", () => {
  const directory = sandbox(),
    input = JSON.parse(readFileSync(fixture, "utf8"));
  input.market.asOf = "2026-09-12T00:00:00.000Z";
  const path = join(directory, "wrong-time.json");
  writeFileSync(path, JSON.stringify(input));
  const result = run(directory, [path]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "MULTI_PREFLIGHT_AS_OF_MISMATCH");
  assert.ok(!readdirSync(directory).includes("data"));
});
test("PREFLIGHT-CLI-08 시험 후보 0개도 명령 완료와 거래 가능을 구분", () => {
  const directory = sandbox(),
    input = JSON.parse(readFileSync(fixture, "utf8"));
  input.market = null;
  const path = join(directory, "missing-market.json");
  writeFileSync(path, JSON.stringify(input));
  const result = run(directory, [path]);
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "NO_TEST_CANDIDATES");
  assert.equal(summary.counts.testCandidates, 0);
});
