import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  copyFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  newAnalysisJob,
  verifyAnalysisJob,
  verifyAnalysisResult,
} from "../src/core/codex-analysis.js";
import { CodexAnalysisService } from "../src/server/codex-analysis-service.js";
import {
  RestrictedAnalysisProcess,
  restrictedProcessOptions,
} from "../src/server/analysis-process.js";
import {
  AnalysisJsonLines,
  AnalysisRpcSession,
} from "../src/server/analysis-rpc.js";
import { mockResult } from "../src/server/codex-analysis-mock.js";
import { recordedAnalysisFixture } from "./analysis-record-helpers.js";

const artifact = fileURLToPath(
  new URL("../src/server/analysis-process-worker.js", import.meta.url),
);
const root = () => mkdtempSync(resolve(tmpdir(), "analysis-process-"));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const create = (s: CodexAnalysisService) =>
  s.request({
    type: "create",
    id: randomUUID(),
    dataset: "SYNTHETIC_REVIEW_FIXTURE_V1",
  }).jobs[0]!;
const approve = (s: CodexAnalysisService, j: ReturnType<typeof create>) =>
  s.request({
    type: "approve",
    id: j.request.id,
    requestHash: j.requestHash,
    acknowledgeExactData: true,
    acknowledgeMockOnly: true,
  });
const command = (type: "run" | "cancel", j: ReturnType<typeof create>) => ({
  type,
  id: j.request.id,
  requestHash: j.requestHash,
});

test("PROCESS-01 승인 전 자식/실행 폴더 0·별도 실행·자체 권한 검사·원본 결과와 일치", async () => {
  const dir = root(),
    runner = new RestrictedAnalysisProcess(resolve(dir, "executions"));
  const s = new CodexAnalysisService(
    resolve(dir, "mock.sqlite"),
    undefined,
    Date.now,
    undefined,
    runner,
  );
  try {
    const j = create(s);
    verifyAnalysisJob(j);
    assert.ok(j.request.execution);
    assert.ok(!existsSync(runner.root));
    approve(s, j);
    assert.ok(!existsSync(runner.root));
    s.request(command("run", j));
    s.request(command("run", j));
    await s.idle();
    const out = s.view().jobs[0]!;
    assert.equal(out.state, "VERIFIED_MOCK");
    assert.equal(s.view().mockCalls, 1);
    assert.deepEqual(
      out.result,
      mockResult(j.request, Date.parse(out.result!.generatedAt)),
    );
    const receipt = JSON.parse(
      readFileSync(resolve(runner.root, j.request.id, "receipt.json"), "utf8"),
    );
    assert.equal(receipt.outcome, "COMPLETE");
    assert.equal(receipt.exitCode, 0);
    assert.ok(receipt.childPid !== process.pid);
    assert.equal(readdirSync(resolve(runner.root, j.request.id)).length, 2);
    assert.equal(receipt.requestHash, j.requestHash);
    assert.equal(
      out.result!.execution!.trustBoundary,
      "TRUSTED_MOCK_NOT_OS_SANDBOX",
    );
  } finally {
    await s.close();
  }
});
test("PROCESS-02 실제 기록 최소 묶음만 전달·원본 DB 불변·저장 후 재조회", async () => {
  const f = recordedAnalysisFixture(),
    info = f.sources.inspect({ type: "inspect", runId: f.runId }),
    original = readFileSync(f.path);
  const runner = new RestrictedAnalysisProcess(resolve(f.root, "executions")),
    path = resolve(f.root, "mock.sqlite");
  let s = new CodexAnalysisService(
    path,
    undefined,
    Date.now,
    f.sources,
    runner,
  );
  try {
    const j = s.request({
      type: "create-record",
      id: randomUUID(),
      sourceId: info.sourceId,
      period: f.period,
    }).jobs[0]!;
    approve(s, j);
    s.request(command("run", j));
    await s.idle();
    const result = s.view().jobs[0]!;
    assert.equal(result.state, "VERIFIED_MOCK");
    assert.equal(result.result!.version, "LOCAL_MOCK_RECORD_RESULT_V1");
    await s.close();
    s = new CodexAnalysisService(
      path,
      undefined,
      Date.now,
      f.sources,
      new RestrictedAnalysisProcess(runner.root),
    );
    assert.deepEqual(s.view().jobs[0], result);
    assert.deepEqual(readFileSync(f.path), original);
    assert.ok(
      !readFileSync(
        resolve(runner.root, j.request.id, "receipt.json"),
        "utf8",
      ).includes(f.path),
    );
  } finally {
    await s.close();
  }
});
test("PROCESS-03 환경변수 허용 목록·NODE_OPTIONS/증권/AI 인증값 상속 없음", () => {
  const previous = process.env.TEST_SECRET;
  try {
    process.env.TEST_SECRET = "TEST_ONLY_NO_REAL_CREDENTIAL";
    const options = restrictedProcessOptions(root());
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    assert.ok(
      Object.keys(options.env).every((k) =>
        ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"].includes(k.toUpperCase()),
      ),
    );
  } finally {
    if (previous === undefined) delete process.env.TEST_SECRET;
    else process.env.TEST_SECRET = previous;
  }
});
test("PROCESS-04 실행 코드 교체/잘못된 승인 실행 바인딩은 실행 없이 거절", async () => {
  const dir = root(),
    file = resolve(dir, "worker.mjs");
  copyFileSync(artifact, file);
  const runner = new RestrictedAnalysisProcess(
      resolve(dir, "executions"),
      file,
    ),
    j = newAnalysisJob(randomUUID(), Date.now(), undefined, runner.binding);
  const tampered = structuredClone(j);
  tampered.request.execution!.workerSha256 = "0".repeat(64);
  assert.throws(() => verifyAnalysisJob(tampered));
  assert.throws(
    () => runner.execute(tampered.request, new AbortController().signal),
    /BINDING/,
  );
  writeFileSync(file, readFileSync(file, "utf8") + "\n// TEST_CHANGED");
  assert.throws(
    () => runner.execute(j.request, new AbortController().signal),
    /ARTIFACT_CHANGED/,
  );
  assert.ok(!existsSync(runner.root));
});
test("PROCESS-05 취소 후 출력 미반영·실행 종료까지 대기", async () => {
  const dir = root(),
    runner = new RestrictedAnalysisProcess(resolve(dir, "executions"));
  const s = new CodexAnalysisService(
    resolve(dir, "mock.sqlite"),
    undefined,
    Date.now,
    undefined,
    runner,
  );
  try {
    const j = create(s);
    approve(s, j);
    s.request(command("run", j));
    await pause(130);
    s.request(command("cancel", j));
    await s.idle();
    assert.equal(s.view().jobs[0]!.state, "CANCELLED");
    assert.equal(s.view().jobs[0]!.result, null);
    assert.equal(s.view().mockCalls, 1);
    const r = JSON.parse(
      readFileSync(resolve(runner.root, j.request.id, "receipt.json"), "utf8"),
    );
    assert.equal(r.outcome, "ANALYSIS_EXECUTION_CANCELLED");
    assert.throws(() => process.kill(r.childPid, 0));
  } finally {
    await s.close();
  }
});
test("PROCESS-06 무응답 자식 timeout·재시도 없음·서비스 종료 시 회수", async () => {
  const dir = root(),
    file = resolve(dir, "silent.mjs");
  writeFileSync(file, "setInterval(() => {}, 1000);");
  const runner = new RestrictedAnalysisProcess(
      resolve(dir, "executions"),
      file,
    ),
    s = new CodexAnalysisService(
      resolve(dir, "mock.sqlite"),
      undefined,
      Date.now,
      undefined,
      runner,
    );
  try {
    const j = create(s);
    approve(s, j);
    s.request(command("run", j));
    await s.idle();
    assert.equal(s.view().jobs[0]!.state, "TIMED_OUT");
    s.request(command("run", j));
    assert.equal(readdirSync(runner.root).length, 1);
    const receipt = JSON.parse(
      readFileSync(resolve(runner.root, j.request.id, "receipt.json"), "utf8"),
    );
    assert.throws(() => process.kill(receipt.childPid, 0));
  } finally {
    await s.close();
  }
});
for (const [label, body] of [
  ["조기 정상 종료", "process.exit(0)"],
  ["오류 종료", "process.exit(71)"],
  ["잘못된 JSON", "process.stdout.write('{bad}\\n');setInterval(()=>{},1000)"],
  [
    "큰 stdout",
    "process.stdout.write('x'.repeat(300000));setInterval(()=>{},1000)",
  ],
  [
    "큰 stderr",
    "process.stderr.write('x'.repeat(5000));setInterval(()=>{},1000)",
  ],
])
  test(`PROCESS-07 ${label}: 고정 오류로 보류·자동 모형 대체 없음`, async () => {
    const dir = root(),
      file = resolve(dir, "fault.mjs");
    writeFileSync(file, body!);
    const runner = new RestrictedAnalysisProcess(
        resolve(dir, "executions"),
        file,
      ),
      s = new CodexAnalysisService(
        resolve(dir, "mock.sqlite"),
        async () => {
          throw new Error("FALLBACK_MUST_NOT_RUN");
        },
        Date.now,
        undefined,
        runner,
      );
    try {
      const j = create(s);
      approve(s, j);
      s.request(command("run", j));
      await s.idle();
      assert.equal(s.view().jobs[0]!.state, "FAILED");
      assert.equal(s.view().jobs[0]!.error, "MOCK_FAILURE");
      assert.equal(s.view().jobs[0]!.rawOutput, null);
    } finally {
      await s.close();
    }
  });

function rpcFixture() {
  const q = newAnalysisJob(randomUUID(), Date.now()).request;
  const output = JSON.stringify(mockResult(q)),
    thread = { id: "mock_thread" },
    turn = (status: string) => ({
      id: "mock_turn",
      status,
      items: [],
      error: null,
    });
  const messages: unknown[] = [
    {
      id: 1,
      result: {
        userAgent: "paper-lab-restricted-mock/1",
        platformFamily: "windows",
        platformOs: "win32",
      },
    },
    { id: 2, result: { thread } },
    { method: "thread/started", params: { thread } },
    { id: 3, result: { turn: turn("inProgress") } },
    {
      method: "turn/started",
      params: { threadId: thread.id, turn: turn("inProgress") },
    },
    {
      method: "item/completed",
      params: {
        threadId: thread.id,
        turnId: "mock_turn",
        item: {
          id: "mock_item",
          type: "agentMessage",
          text: output,
          phase: "final_answer",
        },
      },
    },
    {
      method: "turn/completed",
      params: { threadId: thread.id, turn: turn("completed") },
    },
  ];
  return { q, output, messages };
}
test("RPC-01 분할/여러 프레임·공식 부분집합 순서·성공은 최종 완료 뒤에만", () => {
  const f = rpcFixture(),
    sent: unknown[] = [],
    s = new AnalysisRpcSession(f.q, (v) => sent.push(v)),
    lines = new AnalysisJsonLines((v) => s.receive(v));
  s.start();
  for (const v of f.messages.slice(0, -1)) {
    const bytes = Buffer.from(JSON.stringify(v) + "\n");
    for (let i = 0; i < bytes.length; i += 3)
      lines.push(bytes.subarray(i, i + 3));
  }
  assert.throws(() => s.result(), /INCOMPLETE/);
  lines.push(Buffer.from(JSON.stringify(f.messages.at(-1)) + "\n"));
  lines.end();
  assert.equal(s.result(), f.output);
  assert.deepEqual(
    sent.map((x) => (x as { method: string }).method),
    ["initialize", "initialized", "thread/start", "turn/start"],
  );
  assert.throws(() => s.receive(f.messages.at(-1)), /AFTER_COMPLETE/);
});
test("RPC-02 초기화 중복·ID/시점/스키마/순서·권한 요청·다른 서버 가장 차단", () => {
  const f = rpcFixture();
  for (const message of [
    { id: 99, result: {} },
    { id: 1, result: { userAgent: "real-server" } },
    { method: "warning", params: {} },
    { jsonrpc: "2.0", ...(f.messages[0] as object) },
    { id: 1, error: { code: -1, message: "TEST_SECRET" } },
  ]) {
    assert.throws(() => new AnalysisRpcSession(f.q, () => {}).receive(message));
  }
  const sent: unknown[] = [],
    s = new AnalysisRpcSession(f.q, (x) => sent.push(x));
  assert.throws(
    () =>
      s.receive({
        id: 5,
        method: "item/commandExecution/requestApproval",
        params: { command: "TEST_SECRET" },
      }),
    /ACTION_DENIED/,
  );
  assert.equal((sent[0] as { error: { code: number } }).error.code, -32601);
  assert.ok(!JSON.stringify(sent).includes("TEST_SECRET"));
  const r = new AnalysisRpcSession(f.q, () => {});
  r.receive(f.messages[0]);
  assert.throws(() => r.receive(f.messages[0]));
});
test("RPC-03 중간 취소 메시지·초기 취소는 턴 명령 없음", () => {
  const f = rpcFixture(),
    sent: unknown[] = [],
    s = new AnalysisRpcSession(f.q, (x) => sent.push(x));
  s.interrupt();
  assert.equal(sent.length, 0);
  for (const m of f.messages.slice(0, 5)) s.receive(m);
  s.interrupt();
  assert.deepEqual(sent.at(-1), {
    id: 4,
    method: "turn/interrupt",
    params: { threadId: "mock_thread", turnId: "mock_turn" },
  });
});
test("RPC-04 불완전 UTF-8·잘린 JSON·빈 줄·프레임/총량 제한", () => {
  assert.throws(() =>
    new AnalysisJsonLines(() => {}).push(Buffer.from([0xff, 10])),
  );
  const cut = new AnalysisJsonLines(() => {});
  cut.push(Buffer.from('{"id":1}'));
  assert.throws(() => cut.end(), /TRUNCATED/);
  for (const input of [
    "\n",
    "{}\n".repeat(17),
    "x".repeat(200000),
    "x".repeat(300000),
  ])
    assert.throws(() =>
      new AnalysisJsonLines(() => {}).push(Buffer.from(input)),
    );
});
test("PROCESS-08 자체 검사 실제 더미 파일 보호·코드 변경/추가 권한 없는 실행", async () => {
  const dir = root(),
    runner = new RestrictedAnalysisProcess(resolve(dir, "executions")),
    q = newAnalysisJob(
      randomUUID(),
      Date.now(),
      undefined,
      runner.binding,
    ).request;
  // worker cwd의 상위 폴더에 실제 더미 파일을 두어 ENOENT가 아닌 접근 거절을 확인한다.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(runner.root);
  writeFileSync(resolve(runner.root, "TEST_SECRET.json"), "TEST_ONLY_SENTINEL");
  const out = await runner.execute(q, new AbortController().signal);
  assert.equal(JSON.parse(out).usage.externalCalls, 0);
  assert.equal(
    readFileSync(resolve(runner.root, "TEST_SECRET.json"), "utf8"),
    "TEST_ONLY_SENTINEL",
  );
  assert.ok(!existsSync(resolve(runner.root, q.id, "TEST_WRITE_DENIED.txt")));
});
test("PROCESS-09 결과 실행 코드 바인딩 조작·중복 폴더·링크 거절", async () => {
  const dir = root(),
    runner = new RestrictedAnalysisProcess(resolve(dir, "executions")),
    j = newAnalysisJob(randomUUID(), Date.now(), undefined, runner.binding);
  const out = await runner.execute(j.request, new AbortController().signal);
  j.approvedHash = j.requestHash;
  j.approvedAt = j.request.createdAt;
  j.startedAt = j.request.createdAt;
  j.calls = 1;
  const parsed = JSON.parse(out);
  parsed.execution.workerSha256 = "0".repeat(64);
  assert.throws(() =>
    verifyAnalysisResult(JSON.stringify(parsed), j, Date.now()),
  );
  assert.throws(() => runner.execute(j.request, new AbortController().signal));
  const link = resolve(dir, "linked");
  symlinkSync(runner.root, link, "junction");
  assert.throws(() => new RestrictedAnalysisProcess(link), /PATH/);
});
test("PROCESS-10 부모 비정상 종료 시 stdin EOF로 자식 종료·재시작 분석은 중단", async () => {
  const dir = root(),
    parent = resolve(dir, "parent.mjs"),
    database = resolve(dir, "analysis.sqlite"),
    executions = resolve(dir, "executions");
  const serviceModule = pathToFileURL(
    fileURLToPath(
      new URL("../src/server/codex-analysis-service.js", import.meta.url),
    ),
  ).href;
  const runnerModule = pathToFileURL(
    fileURLToPath(
      new URL("../src/server/analysis-process.js", import.meta.url),
    ),
  ).href;
  writeFileSync(
    parent,
    `import {CodexAnalysisService} from ${JSON.stringify(serviceModule)}; import {RestrictedAnalysisProcess} from ${JSON.stringify(runnerModule)};
const s=new CodexAnalysisService(${JSON.stringify(database)},undefined,Date.now,undefined,new RestrictedAnalysisProcess(${JSON.stringify(executions)}));
const j=s.request({type:'create',id:${JSON.stringify(randomUUID())},dataset:'SYNTHETIC_REVIEW_FIXTURE_V1'}).jobs[0];const b={id:j.request.id,requestHash:j.requestHash};s.request({type:'approve',...b,acknowledgeExactData:true,acknowledgeMockOnly:true});s.request({type:'run',...b});setTimeout(()=>process.exit(73),100);`,
  );
  const child = spawn(process.execPath, [parent], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: "ignore",
  });
  const exit = await new Promise((r) => child.once("exit", r));
  assert.equal(exit, 73);
  const folder = readdirSync(executions)[0]!,
    receipt = JSON.parse(
      readFileSync(resolve(executions, folder, "receipt.json"), "utf8"),
    );
  assert.ok(receipt.childPid);
  let alive = true;
  for (let i = 0; i < 45; i++) {
    try {
      process.kill(receipt.childPid, 0);
    } catch {
      alive = false;
      break;
    }
    await pause(100);
  }
  assert.equal(alive, false);
  const s = new CodexAnalysisService(
    database,
    undefined,
    Date.now,
    undefined,
    new RestrictedAnalysisProcess(executions),
  );
  try {
    assert.equal(s.view().jobs[0]!.state, "INTERRUPTED");
    assert.equal(s.view().mockCalls, 1);
  } finally {
    await s.close();
  }
  assert.equal(dirname(resolve(executions, folder)), executions);
});
