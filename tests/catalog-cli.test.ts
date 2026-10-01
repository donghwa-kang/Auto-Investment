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
import {
  readCatalogFile,
  MAX_CATALOG_BYTES,
} from "../src/server/catalog-file.js";

const cli = resolve("dist/runtime/src/server/catalog-check-cli.js");
const sample = resolve("fixtures/catalog-v1.json");
const project = process.cwd();
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), "catalog-test-"));
  mkdirSync(join(directory, "outputs"));
  for (const file of [
    "AI_TRADING_POLICY_v2.3.json",
    "THEME_RESEARCH_POLICY_v1.3.json",
    "TRADING_STRATEGY_SPEC_v1.0.json",
  ])
    copyFileSync(
      join(project, "outputs", file),
      join(directory, "outputs", file),
    );
  return directory;
}
function execute(directory: string, args: string[], env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    env: {
      ...process.env,
      TRADING_MODE: "PAPER",
      LIVE_ENABLED: "false",
      ...env,
    },
  });
  assert.ifError(result.error);
  return result;
}
test("CAT-CLI-01 실제 CLI 실행·별도 결과·입력 보존·기존 출력 미덮어쓰기", () => {
  const directory = sandbox(),
    before = readFileSync(sample);
  const first = execute(directory, [sample]);
  assert.equal(first.status, 0, first.stderr);
  const summary = JSON.parse(first.stdout);
  assert.deepEqual(summary.counts, {
    total: 7,
    candidates: 3,
    excluded: 2,
    reviewRequired: 2,
  });
  assert.equal(summary.ordersEnabled, false);
  assert.equal(summary.strategyEvaluated, false);
  const originalReport = readFileSync(summary.reportPath);
  const report = JSON.parse(originalReport.toString("utf8"));
  assert.ok(
    report.reasonDescriptions.METADATA_CLEAR.includes("거래 승인이 아닙니다"),
  );
  assert.equal(execute(directory, [sample]).status, 0);
  assert.deepEqual(readFileSync(summary.reportPath), originalReport);
  assert.equal(
    readdirSync(join(directory, "data", "catalog-checks")).length,
    2,
  );
  assert.deepEqual(readdirSync(join(directory, "data")), ["catalog-checks"]);
  assert.deepEqual(readFileSync(sample), before);
});
test("CAT-CLI-02 LIVE 모드·플래그 및 인자 누락/초과 거절", () => {
  for (const [args, env] of [
    [[sample], { TRADING_MODE: "LIVE" }],
    [[sample], { LIVE_ENABLED: "true" }],
    [[], {}],
    [[sample, sample], {}],
  ] as const) {
    const directory = sandbox(),
      result = execute(directory, [...args], env);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(readdirSync(directory), ["outputs"]);
  }
});
test("CAT-CLI-03 잘못된 JSON·스키마·누락 경로에서 원문 비노출", () => {
  const directory = sandbox(),
    secret = "DUMMY_SECRET_MUST_NOT_APPEAR";
  const path = join(directory, "input.json");
  for (const contents of [
    `{"secret":"${secret}"`,
    JSON.stringify({ secret }),
    JSON.stringify({
      ...JSON.parse(readFileSync(sample, "utf8")),
      purpose: "REAL",
    }),
  ]) {
    writeFileSync(path, contents);
    const result = execute(directory, [path]);
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    assert.equal(result.stdout, "");
  }
  const missing = execute(directory, [join(directory, secret)]);
  assert.equal(missing.status, 1);
  assert.ok(!missing.stderr.includes(secret));
});
test("CAT-CLI-04 URL·UNC 경로 거절은 파일 열기 이전", () => {
  for (const path of [
    "https://invalid.example/catalog.json",
    "//invalid/catalog.json",
    "\\\\invalid\\catalog.json",
    "\\\\.\\NUL",
  ])
    assert.throws(() => readCatalogFile(path), /LOCAL_CATALOG_FILE_REQUIRED/);
});
test("CAT-CLI-05 크기 상한·비정상 UTF8·디렉터리 거절, BOM 허용", () => {
  const directory = sandbox(),
    path = join(directory, "input.json");
  writeFileSync(path, Buffer.alloc(MAX_CATALOG_BYTES + 1));
  assert.throws(() => readCatalogFile(path), /CATALOG_FILE_TOO_LARGE/);
  writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00]));
  assert.throws(() => readCatalogFile(path), /CATALOG_FILE_READ_FAILED/);
  assert.throws(
    () => readCatalogFile(directory),
    /CATALOG_(REGULAR_FILE_REQUIRED|FILE_READ_FAILED)/,
  );
  writeFileSync(path, '\ufeff{"purpose":"TEST_ONLY"}');
  assert.deepEqual(readCatalogFile(path), { purpose: "TEST_ONLY" });
});
test("CAT-CLI-06 원본 정책 변조 시 출력 생성 없이 실패", () => {
  const directory = sandbox();
  writeFileSync(
    join(directory, "outputs", "AI_TRADING_POLICY_v2.3.json"),
    "{}",
  );
  const result = execute(directory, [sample]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "CATALOG_CHECK_FAILED");
  assert.deepEqual(readdirSync(directory), ["outputs"]);
});
