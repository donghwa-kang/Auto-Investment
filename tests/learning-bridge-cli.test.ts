import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  bridgePlan,
  bridgeSandbox,
  writeBridgeFixture,
} from "./learning-bridge-helpers.js";
import { exportPaperLearning } from "../src/server/paper-learning-export.js";
import type { PaperExport } from "../src/core/paper-learning-schema.js";
import { pathToFileURL } from "node:url";

const cli = resolve("dist/runtime/src/server/paper-learning-cli.js"),
  lab = resolve("dist/runtime/src/server/learning-cli.js");
const guard =
  "data:text/javascript," +
  encodeURIComponent(`
import fs from 'node:fs';import net from 'node:net';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';
let violations=0;const deny=()=>{violations++;throw Error('OFFLINE_GUARD')};globalThis.fetch=deny;net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;
const read=fs.readFileSync,open=fs.openSync,rename=fs.renameSync;fs.readFileSync=function(p,...a){if(String(p)===process.env.TOSS_CREDENTIAL_FILE)return deny();return read.call(this,p,...a)};fs.openSync=function(p,...a){if(String(p)===process.env.TOSS_CREDENTIAL_FILE)return deny();return open.call(this,p,...a)};
if(process.env.BRIDGE_EXPORT_FAIL==='true')fs.renameSync=function(from,to){if(String(from).endsWith('result.partial'))throw Error('PRIVATE_TEST_EXPORT_FAILURE');return rename.call(this,from,to)};
syncBuiltinESMExports();process.on('exit',()=>{if(violations)process.exitCode=91});
`);
function run(
  dir: string,
  args: string[],
  target = cli,
  env: NodeJS.ProcessEnv = {},
) {
  const r = spawnSync(process.execPath, ["--import", guard, target, ...args], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      TRADING_MODE: "PAPER",
      LIVE_ENABLED: "false",
      TOSS_CREDENTIAL_FILE: join(dir, "MUST_NOT_READ.txt"),
      ...env,
    },
  });
  assert.ifError(r.error);
  assert.notEqual(r.status, 91);
  return r;
}
const dir = bridgeSandbox(),
  plan = writeBridgeFixture(dir),
  initial = run(dir, ["record", plan]);
assert.equal(initial.status, 0, initial.stderr);
const recorded = JSON.parse(initial.stdout) as {
  databasePath: string;
  exportPath: string;
  sourceDecisions: number;
  fillEvents: number;
};
const source = JSON.parse(
  readFileSync(recorded.exportPath, "utf8"),
) as PaperExport;
test("BRIDGE-CLI-01 기록→내보내기→변환→등록→표본 부족 진단→결과 재조회", () => {
  assert.equal(recorded.sourceDecisions, 4);
  assert.ok(recorded.fillEvents > 4);
  const bytes = readFileSync(recorded.databasePath),
    exportBytes = readFileSync(recorded.exportPath);
  const p = join(dir, "research-plan.json");
  writeFileSync(p, JSON.stringify(bridgePlan(source)));
  const converted = run(dir, ["convert", recorded.exportPath, p]);
  assert.equal(converted.status, 0, converted.stderr);
  const c = JSON.parse(converted.stdout);
  assert.equal(c.convertedDecisions, 1);
  assert.equal(c.closedOutcomes, 1);
  const registered = run(dir, ["register", c.inputPath], lab);
  assert.equal(registered.status, 0, registered.stderr);
  const evaluated = run(dir, ["run", c.experimentId], lab);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  const r = JSON.parse(evaluated.stdout);
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.profitabilityValidated, false);
  assert.equal(r.liveEnabled, false);
  assert.equal(r.networkRequests, 0);
  const again = JSON.parse(run(dir, ["run", c.experimentId], lab).stdout);
  assert.equal(again.reused, true);
  assert.equal(again.reportHash, r.reportHash);
  assert.deepEqual(readFileSync(recorded.databasePath), bytes);
  assert.deepEqual(readFileSync(recorded.exportPath), exportBytes);
});
test("BRIDGE-CLI-02 기존 기록 DB의 반복 내보내기는 새 파일·같은 증거", () => {
  const a = run(dir, ["export", recorded.databasePath]),
    b = run(dir, ["export", recorded.databasePath]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  const first = JSON.parse(a.stdout),
    second = JSON.parse(b.stdout);
  assert.equal(first.exportHash, second.exportHash);
  assert.notEqual(first.exportPath, second.exportPath);
});
test("BRIDGE-CLI-03 LIVE·URL·UNC·키 입력·초과 인자 거절", () => {
  const empty = bridgeSandbox(),
    path = join(empty, "bad.json");
  writeFileSync(path, JSON.stringify({ api_key: "FAKE_PRIVATE_DO_NOT_PRINT" }));
  for (const args of [
    [],
    ["record", path],
    ["export", "https://example.invalid/file.sqlite"],
    ["export", "\\\\server\\file.sqlite"],
    ["convert", path, path],
    ["record", path, path],
  ]) {
    const r = run(empty, args);
    assert.equal(r.status, 1);
    assert.ok(!r.stderr.includes("FAKE_PRIVATE"));
  }
  assert.equal(
    run(empty, ["record", plan], cli, { LIVE_ENABLED: "true" }).status,
    1,
  );
  assert.ok(!existsSync(join(empty, "data")));
});
test("BRIDGE-CLI-04 내보내기 실패 후 DB/부분 파일 보존·조회만 재시도", () => {
  const temp = bridgeSandbox(),
    bytes = readFileSync(recorded.databasePath),
    r = run(temp, ["export", recorded.databasePath], cli, {
      BRIDGE_EXPORT_FAIL: "true",
    });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("LEARNING_EXPORT_FAILED"));
  assert.ok(!r.stderr.includes("PRIVATE_TEST"));
  const root = join(temp, "data", "paper-learning-exports"),
    folder = readdirSync(root)[0]!;
  assert.ok(existsSync(join(root, folder, "result.partial")));
  assert.ok(!existsSync(join(root, folder, "result.json")));
  assert.equal(run(temp, ["export", recorded.databasePath]).status, 0);
  assert.deepEqual(readFileSync(recorded.databasePath), bytes);
});
test("BRIDGE-CLI-05 원본 정책 변경은 기록/변환 전에 거절", () => {
  const temp = bridgeSandbox();
  writeFileSync(join(temp, "outputs", "AI_TRADING_POLICY_v2.3.json"), "{}");
  const r = run(temp, ["record", plan]);
  assert.equal(r.status, 1);
  assert.ok(!existsSync(join(temp, "data")));
});
test("BRIDGE-CLI-06 누락 비용/파생 특징 변경 자료는 등록 전 거절", () => {
  const p = join(dir, "research-plan-2.json");
  writeFileSync(
    p,
    JSON.stringify({ ...bridgePlan(source), experimentId: "engine-invalid" }),
  );
  const converted = JSON.parse(
      run(dir, ["convert", recorded.exportPath, p]).stdout,
    ),
    input = JSON.parse(readFileSync(converted.inputPath, "utf8"));
  input.outcomes[0].costs.commission = "0";
  const temp = bridgeSandbox(),
    bad = join(temp, "tampered.json");
  writeFileSync(bad, JSON.stringify(input));
  assert.equal(run(temp, ["register", bad], lab).status, 1);
  assert.ok(!existsSync(join(temp, "data", "learning-lab")));
});
test("BRIDGE-CLI-07 실패한 새 기록 실행의 DB는 지우거나 완료로 표시하지 않음", () => {
  const temp = bridgeSandbox(),
    path = writeBridgeFixture(temp),
    body = JSON.parse(readFileSync(path, "utf8"));
  body.commands.push({
    type: "tick",
    at: 0,
    accountAt: 0,
    fx: { rate: "1300", at: 0 },
    quotes: [],
    frameAsOf: null,
  });
  writeFileSync(path, JSON.stringify(body));
  const r = run(temp, ["record", path]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  const root = join(temp, "data", "paper-learning-runs"),
    folder = readdirSync(root)[0]!,
    dbPath = join(root, folder, "paper.sqlite");
  assert.ok(existsSync(dbPath));
  const x = exportPaperLearning(dbPath);
  assert.equal(x.journal.closures.length, 2);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM commands WHERE id=?")
        .get(`plan-${body.commands.length - 1}`)!.n,
      0,
    );
  } finally {
    db.close();
  }
});
test("BRIDGE-CLI-08 부분 체결 저장 직후 소유 자식 종료에도 장부와 기록 함께 보존", () => {
  const temp = bridgeSandbox(),
    path = writeBridgeFixture(temp),
    dbPath = join(temp, "crash.sqlite");
  const uri = (name: string) =>
    pathToFileURL(resolve(`dist/runtime/src/${name}.js`)).href;
  const code = `import {loadPortfolioPlan} from ${JSON.stringify(uri("server/portfolio-file"))};import {PortfolioProgram} from ${JSON.stringify(uri("core/portfolio-program"))};import {PortfolioPaperEngine} from ${JSON.stringify(uri("server/portfolio-engine"))};const {plan,input}=loadPortfolioPlan(process.argv[1]);const e=new PortfolioPaperEngine(new PortfolioProgram(input,plan.settings),process.argv[2],{captureLearning:true});for(const [i,c]of plan.commands.slice(0,4).entries())e.command('crash-'+i,c);process.exit(73);`;
  const child = spawnSync(
    process.execPath,
    ["--import", guard, "--input-type=module", "-e", code, path, dbPath],
    {
      cwd: temp,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000,
      env: {
        ...process.env,
        TRADING_MODE: "PAPER",
        LIVE_ENABLED: "false",
        TOSS_CREDENTIAL_FILE: join(temp, "MUST_NOT_READ.txt"),
      },
    },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 73, child.stderr);
  const source = exportPaperLearning(dbPath);
  assert.equal(source.journal.fills.length, 1);
  assert.equal(source.positions[0]!.quantity, 1);
  assert.equal(source.journal.closures.length, 0);
  assert.equal(source.auditCount, 5);
});
