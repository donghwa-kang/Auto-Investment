import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { pathToFileURL } from "node:url";
import { createLearningSample } from "../src/core/learning-sample.js";
import { LearningRegistry } from "../src/server/learning-registry.js";

const cli = resolve("dist/runtime/src/server/learning-cli.js");
const registryUrl = pathToFileURL(
  resolve("dist/runtime/src/server/learning-registry.js"),
).href;
const evaluatorUrl = pathToFileURL(
  resolve("dist/runtime/src/core/learning.js"),
).href;
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), "learning-cli-"));
  mkdirSync(join(directory, "outputs"));
  for (const file of [
    "AI_TRADING_POLICY_v2.3.json",
    "THEME_RESEARCH_POLICY_v1.3.json",
    "TRADING_STRATEGY_SPEC_v1.0.json",
  ])
    copyFileSync(resolve("outputs", file), join(directory, "outputs", file));
  return directory;
}
const guard =
  "data:text/javascript," +
  encodeURIComponent(`
  import fs from 'node:fs'; import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import {syncBuiltinESMExports} from 'node:module';
  let violations=0; const deny=()=>{violations++;throw new Error('OFFLINE_GUARD')};
  globalThis.fetch=deny; net.connect=deny; net.createConnection=deny; net.Socket.prototype.connect=deny;
  http.request=deny;http.get=deny;https.request=deny;https.get=deny;
  const read=fs.readFileSync,open=fs.openSync,rename=fs.renameSync;
  fs.readFileSync=function(path,...args){if(String(path)===process.env.TOSS_CREDENTIAL_FILE)return deny();return read.call(this,path,...args)};
  fs.openSync=function(path,...args){if(String(path)===process.env.TOSS_CREDENTIAL_FILE)return deny();return open.call(this,path,...args)};
  if(process.env.LEARNING_TEST_EXPORT_FAILURE==='true')fs.renameSync=function(from,to){if(String(from).endsWith('result.partial'))throw new Error('FAKE_PRIVATE_EXPORT');return rename.call(this,from,to)};
  syncBuiltinESMExports();process.on('exit',()=>{if(violations)process.exitCode=91});
`);
function environment(directory: string) {
  return {
    ...process.env,
    TRADING_MODE: "PAPER",
    LIVE_ENABLED: "false",
    TOSS_CREDENTIAL_FILE: join(directory, "MUST_NOT_READ.txt"),
    TOSS_CATALOG_READ_ONLY: "false",
    TOSS_CATALOG_TERMS_CONFIRMED: "false",
  };
}
function run(directory: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(
    process.execPath,
    ["--import", guard, cli, ...args],
    {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      env: { ...environment(directory), ...env },
    },
  );
  assert.ifError(result.error);
  assert.notEqual(result.status, 91);
  return result;
}
function register(directory: string) {
  const input = join(directory, "input.json");
  writeFileSync(input, JSON.stringify(createLearningSample()));
  const r = run(directory, ["register", input]);
  assert.equal(r.status, 0, r.stderr);
  return input;
}
test("LEARN-CLI-01 네트워크 없는 샘플 생성·등록·학습·조회·재실행", () => {
  const directory = sandbox(),
    generated = run(directory, ["sample"]);
  assert.equal(generated.status, 0, generated.stderr);
  const sample = JSON.parse(generated.stdout),
    bytes = readFileSync(sample.inputPath);
  const registered = run(directory, ["register", sample.inputPath]);
  assert.equal(registered.status, 0, registered.stderr);
  assert.equal(JSON.parse(registered.stdout).state, "REGISTERED");
  const first = run(directory, ["run", sample.experimentId]);
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout),
    report = JSON.parse(readFileSync(result.reportPath, "utf8"));
  assert.equal(result.status, "RESEARCH_EVALUATED");
  assert.equal(result.eligible, 96);
  assert.equal(result.folds, 2);
  assert.equal(result.networkRequests, 0);
  assert.equal(result.paperOrdersEnabled, false);
  assert.equal(report.profitabilityValidated, false);
  assert.equal(
    JSON.parse(run(directory, ["status", sample.experimentId]).stdout).state,
    "COMPLETE",
  );
  const second = JSON.parse(
    run(directory, ["run", sample.experimentId]).stdout,
  );
  assert.equal(second.reused, true);
  assert.equal(second.reportHash, result.reportHash);
  assert.notEqual(second.reportPath, result.reportPath);
  assert.deepEqual(readFileSync(sample.inputPath), bytes);
  assert.deepEqual(readdirSync(join(directory, "data")).sort(), [
    "learning-inputs",
    "learning-lab",
    "learning-reports",
  ]);
});
test("LEARN-CLI-02 잘못된 인자/실자료/키/모드는 기존 파일과 DB를 바꾸지 않음", () => {
  const directory = sandbox(),
    path = join(directory, "bad.json");
  for (const body of [
    '{"api_key":"FAKE_PRIVATE"}',
    JSON.stringify({ ...createLearningSample(), dataOrigin: "REAL" }),
    '{"private":"FAKE_PRIVATE"',
  ]) {
    writeFileSync(path, body);
    const r = run(directory, ["register", path]);
    assert.equal(r.status, 1);
    assert.ok(!r.stderr.includes("FAKE_PRIVATE"));
    assert.equal(r.stdout, "");
  }
  for (const [args, env] of [
    [[], {}],
    [["sample", "extra"], {}],
    [["sample"], { TRADING_MODE: "LIVE" }],
    [["sample"], { LIVE_ENABLED: "true" }],
    [["status", "valid-id"], {}],
    [["run", "../bad"], {}],
  ] as const) {
    assert.equal(run(directory, [...args], env).status, 1);
  }
  assert.equal(existsSync(join(directory, "data")), false);
});
test("LEARN-CLI-03 URL·UNC·정책 불일치 거절", () => {
  const directory = sandbox();
  for (const path of [
    "https://example.invalid/data.json",
    "\\\\example.invalid\\data.json",
  ])
    assert.equal(run(directory, ["register", path]).status, 1);
  writeFileSync(
    join(directory, "outputs", "AI_TRADING_POLICY_v2.3.json"),
    "{}",
  );
  assert.equal(run(directory, ["sample"]).status, 1);
  assert.equal(existsSync(join(directory, "data")), false);
});
test("LEARN-CLI-04 보고서 파일 게시 실패 후 DB 결과 보존·재실행은 재학습 안 함", () => {
  const directory = sandbox();
  register(directory);
  const failed = run(directory, ["run", "learning-demo-v1"], {
    LEARNING_TEST_EXPORT_FAILURE: "true",
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /LEARNING_EXPORT_FAILED/);
  assert.ok(!failed.stderr.includes("FAKE_PRIVATE_EXPORT"));
  assert.equal(
    JSON.parse(run(directory, ["status", "learning-demo-v1"]).stdout).state,
    "COMPLETE",
  );
  const root = join(directory, "data", "learning-reports"),
    firstFolder = readdirSync(root)[0]!;
  assert.deepEqual(readdirSync(join(root, firstFolder)), ["result.partial"]);
  const retry = run(directory, ["run", "learning-demo-v1"]);
  assert.equal(retry.status, 0);
  assert.equal(JSON.parse(retry.stdout).reused, true);
  assert.deepEqual(readdirSync(join(root, firstFolder)), ["result.partial"]);
});
test("LEARN-CLI-05 평가권 예약 후 소유 자식 실제 종료·RUNNING/노출 보존", () => {
  const directory = sandbox();
  register(directory);
  const script = `import {LearningRegistry} from ${JSON.stringify(registryUrl)};const r=new LearningRegistry();r.run('learning-demo-v1',()=>process.exit(73));`;
  const child = spawnSync(
    process.execPath,
    ["--import", guard, "--input-type=module", "-e", script],
    {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      env: environment(directory),
    },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 73);
  assert.equal(
    JSON.parse(run(directory, ["status", "learning-demo-v1"]).stdout).state,
    "RUNNING",
  );
  const retry = run(directory, ["run", "learning-demo-v1"]);
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /LEARNING_REVIEW_REQUIRED/);
  const registry = new LearningRegistry(directory, false);
  try {
    registry.register(createLearningSample("another"));
    assert.throws(
      () => registry.run("another"),
      /LEARNING_EVALUATION_WINDOW_USED/,
    );
  } finally {
    registry.close();
  }
});
test("LEARN-CLI-06 동시 실행은 평가권 하나만 소비", async () => {
  const directory = sandbox();
  register(directory);
  const script = `import {LearningRegistry} from ${JSON.stringify(registryUrl)};import {evaluateLearning} from ${JSON.stringify(evaluatorUrl)};
  const r=new LearningRegistry();try{r.run('learning-demo-v1',input=>{console.log('CLAIMED');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2500);return evaluateLearning(input)});}finally{r.close()}`;
  const child = spawn(
    process.execPath,
    ["--import", guard, "--input-type=module", "-e", script],
    {
      cwd: directory,
      windowsHide: true,
      env: environment(directory),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errorText = "";
  child.stderr.on("data", (b) => {
    errorText += String(b);
  });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("TEST_CHILD_TIMEOUT"));
    }, 10000);
    child.stdout.on("data", (b) => {
      if (String(b).includes("CLAIMED")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(errorText));
    });
  });
  const other = run(directory, ["run", "learning-demo-v1"]);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /LEARNING_REVIEW_REQUIRED/);
  assert.equal(await completed, 0, errorText);
  assert.equal(
    JSON.parse(run(directory, ["status", "learning-demo-v1"]).stdout).state,
    "COMPLETE",
  );
});
