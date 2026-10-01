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

const cli = resolve("dist/runtime/src/server/catalog-enrich-cli.js");
const fixture = resolve("fixtures/catalog-enrichment-v1.json");
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), "catalog-enrich-cli-"));
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
        TOSS_CATALOG_READ_ONLY: "false",
        TOSS_CATALOG_TERMS_CONFIRMED: "false",
        TOSS_CREDENTIAL_FILE: join(directory, "MUST_NOT_READ_KEY.txt"),
        ...env,
      },
    },
  );
  assert.ifError(result.error);
  return result;
}
test("ENRICH-CLI-01 실제 자식 CLI·키/네트워크 없는 샘플 및 출처 기록", () => {
  const directory = sandbox(),
    before = readFileSync(fixture);
  const result = run(directory);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout),
    report = JSON.parse(readFileSync(summary.reportPath, "utf8"));
  assert.equal(summary.result, "OFFLINE_CATALOG_ENRICHMENT_COMPLETE");
  assert.deepEqual(summary.counts, {
    total: 5,
    candidates: 2,
    excluded: 1,
    reviewRequired: 2,
    enrichedFields: 10,
  });
  assert.equal(report.ordersEnabled, false);
  assert.equal(report.liveEnabled, false);
  assert.equal(report.realMetadataReady, false);
  assert.equal(report.strategyEvaluated, false);
  assert.ok(report.reasonDescriptions.EVIDENCE_BASE_CONFLICT);
  assert.deepEqual(readdirSync(join(directory, "data")), [
    "catalog-enrichments",
  ]);
  assert.deepEqual(readFileSync(fixture), before);
});
test("ENRICH-CLI-02 반복 실행의 판단 재현·기존 결과와 입력 미덮어쓰기", () => {
  const directory = sandbox();
  const first = JSON.parse(run(directory).stdout),
    bytes = readFileSync(first.reportPath);
  const second = JSON.parse(run(directory).stdout);
  assert.equal(first.decisionHash, second.decisionHash);
  assert.notEqual(first.reportPath, second.reportPath);
  assert.deepEqual(readFileSync(first.reportPath), bytes);
  assert.equal(
    readdirSync(join(directory, "data", "catalog-enrichments")).length,
    2,
  );
});
test("ENRICH-CLI-03 모드/실거래/인자 거절 시 출력 없음", () => {
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
test("ENRICH-CLI-04 잘못된 JSON/스키마/실자료 입력은 원문 비노출", () => {
  const directory = sandbox(),
    path = join(directory, "input.json"),
    secret = "FAKE_PRIVATE_MUST_NOT_LEAK";
  for (const body of [
    `{\"secret\":\"${secret}\"`,
    JSON.stringify({ secret }),
    JSON.stringify({
      ...JSON.parse(readFileSync(fixture, "utf8")),
      purpose: "REAL_REFERENCE_SNAPSHOT",
    }),
    readFileSync("fixtures/catalog-v1.json", "utf8"),
  ]) {
    writeFileSync(path, body);
    const result = run(directory, [path]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(secret));
    assert.deepEqual(readFileSync(path, "utf8"), body);
  }
  assert.ok(!readdirSync(directory).includes("data"));
});
test("ENRICH-CLI-05 정책 원본 불일치와 출력 저장 장애는 성공으로 표시하지 않음", () => {
  const directory = sandbox();
  writeFileSync(
    join(directory, "outputs", "AI_TRADING_POLICY_v2.3.json"),
    "{}",
  );
  assert.equal(run(directory).status, 1);
  assert.deepEqual(readdirSync(directory), ["outputs"]);
  const blocked = sandbox();
  mkdirSync(join(blocked, "data"));
  writeFileSync(
    join(blocked, "data", "catalog-enrichments"),
    "KEEP-EXISTING-FILE",
  );
  const result = run(blocked);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    readFileSync(join(blocked, "data", "catalog-enrichments"), "utf8"),
    "KEEP-EXISTING-FILE",
  );
});
test("ENRICH-CLI-06 URL/직접 UNC 및 없는 경로 거절", () => {
  const directory = sandbox();
  for (const path of [
    "https://example.invalid/test.json",
    "\\\\invalid\\test.json",
    join(directory, "FAKE_SECRET_PATH"),
  ]) {
    const result = run(directory, [path]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("FAKE_SECRET_PATH"));
  }
  assert.deepEqual(readdirSync(directory), ["outputs"]);
});
