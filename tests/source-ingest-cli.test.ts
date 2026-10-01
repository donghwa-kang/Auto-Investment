import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hash } from "../src/core/policy.js";
import {
  ingestMockSource,
  type IngestReport,
} from "../src/core/source-ingest.js";
import { saveSourceIngest } from "../src/server/source-ingest-store.js";

const cli = resolve("dist/runtime/src/server/source-ingest-cli.js");
const fixture = resolve("fixtures/source-ingest-v1.json");
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), "source-ingest-cli-"));
  mkdirSync(join(directory, "outputs"));
  for (const file of [
    "AI_TRADING_POLICY_v2.3.json",
    "THEME_RESEARCH_POLICY_v1.3.json",
    "TRADING_STRATEGY_SPEC_v1.0.json",
  ])
    copyFileSync(resolve("outputs", file), join(directory, "outputs", file));
  return directory;
}
// 테스트 자식에만 적용. 실제 키 대신 존재하지 않는 센티널 경로를 사용한다.
const hook =
  "data:text/javascript," +
  encodeURIComponent(`
  import fs from 'node:fs';
  import net from 'node:net';
  import http from 'node:http';
  import https from 'node:https';
  import { syncBuiltinESMExports } from 'node:module';
  let violations = 0;
  const deny = () => { violations++; throw new Error('OFFLINE_GUARD'); };
  globalThis.fetch = deny;
  net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
  http.request = deny; http.get = deny; https.request = deny; https.get = deny;
  const read = fs.readFileSync, open = fs.openSync, rename = fs.renameSync;
  const protectedPath = process.env.TOSS_CREDENTIAL_FILE;
  fs.readFileSync = function(path, ...args) { if (String(path) === protectedPath) return deny(); return read.call(this, path, ...args); };
  fs.openSync = function(path, ...args) { if (String(path) === protectedPath) return deny(); return open.call(this, path, ...args); };
  if (process.env.INGEST_TEST_RENAME_FAILURE === 'true') fs.renameSync = function(from, to) {
    if (String(from).endsWith('report.partial')) throw new Error('FAKE_SAVE_PRIVATE_SENTINEL');
    return rename.call(this, from, to);
  };
  syncBuiltinESMExports();
  process.on('exit', () => { if (violations) process.exitCode = 91; });
`);
function run(
  directory: string,
  args: string[] = [fixture],
  env: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync(process.execPath, ["--import", hook, cli, ...args], {
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
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 91, "네트워크/센티널 키 읽기 시도");
  return result;
}

test("INGEST-CLI-01 네트워크/키 읽기 금지 자식 실행·격리 결과·입력 보존", () => {
  const directory = sandbox(),
    before = readFileSync(fixture),
    result = run(directory);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout),
    report = JSON.parse(
      readFileSync(summary.reportPath, "utf8"),
    ) as IngestReport;
  assert.equal(summary.result, "OFFLINE_SOURCE_INGEST_COMPLETE");
  assert.equal(summary.status, "MOCK_TRANSFORM_COMPLETE");
  assert.deepEqual(summary.counts, {
    captures: 9,
    observations: 11,
    blocked: 0,
    duplicates: 1,
    pagePlans: 1,
  });
  const { reportHash, ...content } = report;
  assert.equal(hash(content), reportHash);
  assert.equal(summary.reportHash, reportHash);
  assert.equal(report.realDataReady, false);
  assert.equal(report.paperOrdersEnabled, false);
  assert.equal(report.liveEnabled, false);
  assert.deepEqual(readdirSync(join(directory, "data")), [
    "source-ingest-checks",
  ]);
  assert.deepEqual(readFileSync(fixture), before);
});
test("INGEST-CLI-02 반복 실행은 새 경로·동일 해시·기존 보고서 미덮어쓰기", () => {
  const directory = sandbox(),
    first = JSON.parse(run(directory).stdout),
    bytes = readFileSync(first.reportPath);
  const second = JSON.parse(run(directory).stdout);
  assert.notEqual(first.reportPath, second.reportPath);
  assert.equal(first.reportHash, second.reportHash);
  assert.deepEqual(readFileSync(first.reportPath), bytes);
  assert.equal(
    readdirSync(join(directory, "data", "source-ingest-checks")).length,
    2,
  );
});
test("INGEST-CLI-03 LIVE·실거래 플래그·인자 오류는 저장 전에 실패", () => {
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
test("INGEST-CLI-04 잘못된 JSON/실자료 계약/민감 필드는 내용 비노출·출력 없음", () => {
  const directory = sandbox(),
    path = join(directory, "input.json"),
    marker = "FAKE_PRIVATE_MUST_NOT_LEAK";
  for (const body of [
    `{"secret":"${marker}"`,
    JSON.stringify({
      ...JSON.parse(readFileSync(fixture, "utf8")),
      purpose: "REAL",
    }),
    JSON.stringify({ api_key: marker }),
  ]) {
    writeFileSync(path, body);
    const result = run(directory, [path]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(marker));
    assert.equal(readFileSync(path, "utf8"), body);
  }
  assert.equal(existsSync(join(directory, "data")), false);
});
test("INGEST-CLI-05 URL·UNC 입력은 네트워크 접근 없이 거절", () => {
  const directory = sandbox();
  for (const path of [
    "https://example.invalid/private-input.json",
    "\\\\example.invalid\\private-input.json",
  ]) {
    const result = run(directory, [path]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
  assert.equal(existsSync(join(directory, "data")), false);
});
test("INGEST-CLI-06 의미적 차단은 진단 보고서 성공과 거래 승인을 구분", () => {
  const directory = sandbox(),
    path = join(directory, "input.json"),
    s = JSON.parse(readFileSync(fixture, "utf8"));
  s.captures[2].response.result[0].timestamp = null;
  writeFileSync(path, JSON.stringify(s));
  const result = run(directory, [path]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "HAS_BLOCKS");
  assert.equal(summary.paperOrdersEnabled, false);
  assert.equal(summary.realDataReady, false);
  assert.ok(
    JSON.parse(
      readFileSync(summary.reportPath, "utf8"),
    ).captures[2].observations[0].reasons.includes("SOURCE_TIMESTAMP_MISSING"),
  );
});
test("INGEST-CLI-07 정책 불일치·출력 위치 장애는 실패·기존 파일 보존", () => {
  const directory = sandbox();
  writeFileSync(
    join(directory, "outputs", "AI_TRADING_POLICY_v2.3.json"),
    "{}",
  );
  assert.equal(run(directory).status, 1);
  assert.equal(existsSync(join(directory, "data")), false);
  const locked = sandbox();
  mkdirSync(join(locked, "data"));
  const path = join(locked, "data", "source-ingest-checks");
  writeFileSync(path, "KEEP_EXISTING");
  const result = run(locked);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /INGEST_SAVE_FAILED/);
  assert.equal(readFileSync(path, "utf8"), "KEEP_EXISTING");
});
test("INGEST-CLI-08 게시 rename 실패 후 완료 파일 없음·부분 파일은 자동 삭제 안 함", () => {
  const directory = sandbox(),
    result = run(directory, [fixture], { INGEST_TEST_RENAME_FAILURE: "true" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /INGEST_SAVE_FAILED/);
  assert.ok(!result.stderr.includes("FAKE_SAVE_PRIVATE_SENTINEL"));
  const root = join(directory, "data", "source-ingest-checks"),
    runs = readdirSync(root);
  assert.equal(runs.length, 1);
  assert.deepEqual(readdirSync(join(root, runs[0]!)), ["report.partial"]);
  const retried = run(directory);
  assert.equal(retried.status, 0);
  assert.deepEqual(readdirSync(join(root, runs[0]!)), ["report.partial"]);
});
test("INGEST-CLI-09 변조된 보고서 해시는 저장 이전에 거절", () => {
  const directory = sandbox(),
    report = ingestMockSource(JSON.parse(readFileSync(fixture, "utf8")));
  report.realDataReady = true;
  assert.throws(
    () => saveSourceIngest(report, directory),
    /INGEST_SAVE_FAILED/,
  );
  const { reportHash: previousHash, ...content } = report;
  assert.notEqual(previousHash, hash(content));
  report.reportHash = hash(content);
  assert.throws(
    () => saveSourceIngest(report, directory),
    /INGEST_SAVE_FAILED/,
  );
  assert.equal(existsSync(join(directory, "data")), false);
});
