import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { hash } from "../src/core/policy.js";
import {
  newAnalysisJob,
  verifyAnalysisJob,
  verifyAnalysisResult,
} from "../src/core/codex-analysis.js";
import { CodexAnalysisService } from "../src/server/codex-analysis-service.js";
import { AnalysisStore } from "../src/server/codex-analysis-store.js";
import { mockResult } from "../src/server/codex-analysis-mock.js";
import type {
  AnalysisJob,
  AnalysisResult,
} from "../src/core/codex-analysis-schema.js";

const newPath = () =>
  resolve(mkdtempSync(resolve(tmpdir(), "codex-analysis-")), "mock.sqlite");
const create = (s: CodexAnalysisService, id: string = randomUUID()) =>
  s.request({ type: "create", id, dataset: "SYNTHETIC_REVIEW_FIXTURE_V1" })
    .jobs[0]!;
const approve = (s: CodexAnalysisService, j: AnalysisJob) =>
  s.request({
    type: "approve",
    id: j.request.id,
    requestHash: j.requestHash,
    acknowledgeExactData: true,
    acknowledgeMockOnly: true,
  });
const run = (s: CodexAnalysisService, j: AnalysisJob) =>
  s.request({ type: "run", id: j.request.id, requestHash: j.requestHash });
const cancel = (s: CodexAnalysisService, j: AnalysisJob) =>
  s.request({ type: "cancel", id: j.request.id, requestHash: j.requestHash });

test("ANALYSIS-01 승인 전 0 · 명시 승인/실행 분리 · 중복 실행 1회 · 저장 결과 재검증", async () => {
  let calls = 0;
  const path = newPath(),
    s = new CodexAnalysisService(path, async (q) => {
      calls++;
      return JSON.stringify(mockResult(q));
    });
  const j = create(s);
  try {
    assert.equal(s.view().externalCalls, 0);
    assert.equal(create(s, j.request.id).requestHash, j.requestHash);
    assert.throws(() => run(s, j), /APPROVAL_REQUIRED/);
    assert.equal(calls, 0);
    approve(s, j);
    approve(s, j);
    assert.equal(calls, 0);
    run(s, j);
    run(s, j);
    await s.idle();
    const result = s.view().jobs[0]!;
    assert.equal(result.state, "VERIFIED_MOCK");
    assert.equal(result.result!.facts[0]!.value, 4);
    assert.equal(result.calls, 1);
    assert.equal(calls, 1);
    run(s, j);
    assert.equal(calls, 1);
    assert.equal(s.view().automaticApplication, false);
    await s.close();
    const reopened = new CodexAnalysisService(path);
    try {
      assert.deepEqual(reopened.view().jobs[0], result);
    } finally {
      await reopened.close();
    }
  } finally {
    await s.close();
  }
});
test("ANALYSIS-02 임의 자료/키/경로/권한 필드·승인 거짓·다른 해시 거절", async () => {
  const s = new CodexAnalysisService(newPath());
  try {
    for (const extra of [
      { file: "C:/TEST_SECRET.txt" },
      { apiKey: "TEST_ONLY_NOT_SECRET" },
      { adapter: "LIVE" },
      { policyWrite: true },
      { data: { decisions: 999 } },
    ])
      assert.throws(() =>
        s.request({
          type: "create",
          id: randomUUID(),
          dataset: "SYNTHETIC_REVIEW_FIXTURE_V1",
          ...extra,
        }),
      );
    const j = create(s);
    assert.throws(() => create(s), /REQUEST_ACTIVE/);
    assert.throws(() =>
      s.request({
        type: "approve",
        id: j.request.id,
        requestHash: j.requestHash,
        acknowledgeExactData: false,
        acknowledgeMockOnly: true,
      }),
    );
    assert.throws(
      () => approve(s, { ...j, requestHash: "0".repeat(64) }),
      /MISMATCH/,
    );
    assert.throws(
      () => run(s, { ...j, requestHash: "0".repeat(64) }),
      /MISMATCH/,
    );
    assert.equal(s.view().mockCalls, 0);
  } finally {
    await s.close();
  }
});
test("ANALYSIS-03 승인·실행 시작 기한 경계 · 만료 후 재승인/실행 차단", async () => {
  let now = Date.now();
  const s = new CodexAnalysisService(newPath(), undefined, () => now);
  try {
    const j = create(s);
    now += 299999;
    approve(s, j);
    now++;
    assert.equal(s.view().jobs[0]!.state, "EXPIRED");
    assert.throws(() => run(s, j), /APPROVAL_REQUIRED/);
    assert.throws(() => approve(s, j), /NOT_AWAITING_APPROVAL/);
    assert.equal(s.view().mockCalls, 0);
  } finally {
    await s.close();
  }
});
test("ANALYSIS-04 실행 전 취소·실행 중 취소·늦은 성공 폐기·재시도 없음", async () => {
  let release: ((value: string) => void) | undefined;
  let input: AnalysisJob["request"] | undefined;
  const s = new CodexAnalysisService(newPath(), (q) => {
    input = q;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  try {
    const first = create(s);
    cancel(s, first);
    assert.throws(() => run(s, first), /APPROVAL_REQUIRED/);
    const j = create(s);
    approve(s, j);
    run(s, j);
    await Promise.resolve();
    cancel(s, j);
    await s.idle();
    release!(JSON.stringify(mockResult(input!)));
    await Promise.resolve();
    assert.equal(s.view().jobs[0]!.state, "CANCELLED");
    assert.equal(s.view().jobs[0]!.result, null);
    run(s, j);
    assert.equal(s.view().mockCalls, 1);
  } finally {
    await s.close();
  }
});
test("ANALYSIS-05 실제 3초 watchdog·늦은 결과 폐기", async () => {
  let release: ((value: string) => void) | undefined;
  let input: AnalysisJob["request"] | undefined;
  const s = new CodexAnalysisService(newPath(), (q) => {
    input = q;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  try {
    const j = create(s);
    approve(s, j);
    run(s, j);
    await s.idle();
    assert.equal(s.view().jobs[0]!.state, "TIMED_OUT");
    release!(JSON.stringify(mockResult(input!)));
    await Promise.resolve();
    assert.equal(s.view().jobs[0]!.result, null);
    run(s, j);
    assert.equal(s.view().mockCalls, 1);
  } finally {
    await s.close();
  }
});
test("ANALYSIS-06 모델 오류 원문 미노출·자동 fallback/retry 없음", async () => {
  let calls = 0;
  const s = new CodexAnalysisService(newPath(), async () => {
    calls++;
    throw new Error("TEST_SECRET_EXCEPTION_DO_NOT_EXPOSE");
  });
  try {
    const j = create(s);
    approve(s, j);
    run(s, j);
    await s.idle();
    run(s, j);
    assert.equal(s.view().jobs[0]!.state, "FAILED");
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(s.view()).includes("TEST_SECRET"));
  } finally {
    await s.close();
  }
});
const mutations: [string, (r: AnalysisResult) => unknown][] = [
  [
    "출처 ID",
    (r) => ({
      ...r,
      facts: r.facts.map((f) => ({ ...f, sourceId: "UNAPPROVED" })),
    }),
  ],
  ["기준 시점", (r) => ({ ...r, asOf: "2099-01-01T00:00:00.000Z" })],
  [
    "근거 시점",
    (r) => ({
      ...r,
      facts: r.facts.map((f) => ({
        ...f,
        observedAt: "2099-01-01T00:00:00.000Z",
      })),
    }),
  ],
  ["자료 해시", (r) => ({ ...r, bundleHash: "0".repeat(64) })],
  ["요청 해시", (r) => ({ ...r, requestHash: "0".repeat(64) })],
  ["요청 ID", (r) => ({ ...r, requestId: randomUUID() })],
  [
    "숫자",
    (r) => ({ ...r, facts: r.facts.map((f) => ({ ...f, value: 999 })) }),
  ],
  [
    "중복/누락 필드",
    (r) => ({ ...r, facts: [r.facts[0], r.facts[0], r.facts[0]] }),
  ],
  [
    "미래 생성 시점",
    (r) => ({ ...r, generatedAt: "2099-01-01T00:00:00.000Z" }),
  ],
  [
    "시작 전 생성 시점",
    (r) => ({ ...r, generatedAt: "2000-01-01T00:00:00.000Z" }),
  ],
  ["주문 필드", (r) => ({ ...r, orders: [{ buy: true }] })],
  ["정책 변경 제안", (r) => ({ ...r, suggestions: ["DISABLE_STOP_LOSS"] })],
  ["비용/토큰", (r) => ({ ...r, usage: { ...r.usage, tokens: 50 } })],
  ["실제 모델 가장", (r) => ({ ...r, mock: false })],
];
for (const [name, mutate] of mutations)
  test(`ANALYSIS-RESULT ${name} 거절`, async () => {
    const s = new CodexAnalysisService(newPath(), async (q) =>
      JSON.stringify(mutate(mockResult(q))),
    );
    try {
      const j = create(s);
      approve(s, j);
      run(s, j);
      await s.idle();
      assert.equal(s.view().jobs[0]!.state, "REJECTED");
      assert.equal(s.view().jobs[0]!.result, null);
    } finally {
      await s.close();
    }
  });
test("ANALYSIS-07 잘못된 JSON·초과 출력·결측 스키마 거절", async () => {
  for (const output of [
    "invalid json",
    "x".repeat(16385),
    "{}",
    '{"__proto__":{"orders":true}}',
  ]) {
    const s = new CodexAnalysisService(newPath(), async () => output);
    try {
      const j = create(s);
      approve(s, j);
      run(s, j);
      await s.idle();
      assert.equal(s.view().jobs[0]!.state, "REJECTED");
    } finally {
      await s.close();
    }
  }
});
test("ANALYSIS-08 모형에 전달하는 객체는 저장 자료와 격리", async () => {
  const s = new CodexAnalysisService(newPath(), async (q) => {
    q.bundle.source.metrics.decisions = 777;
    return JSON.stringify(mockResult(q));
  });
  try {
    const j = create(s);
    approve(s, j);
    run(s, j);
    await s.idle();
    assert.equal(s.view().jobs[0]!.request.bundle.source.metrics.decisions, 4);
    assert.equal(s.view().jobs[0]!.state, "REJECTED");
  } finally {
    await s.close();
  }
});
test("ANALYSIS-09 저장 변조·알 수 없는 DB 거절, 원본 바이트 보존", async () => {
  const path = newPath();
  const s = new CodexAnalysisService(path);
  create(s);
  await s.close();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE state SET checksum=?").run("0".repeat(64));
  db.close();
  const bytes = readFileSync(path);
  assert.throws(() => new CodexAnalysisService(path), /INTEGRITY/);
  assert.deepEqual(readFileSync(path), bytes);
  const other = newPath(),
    unrelated = new DatabaseSync(other);
  unrelated.exec("CREATE TABLE user_data(value TEXT)");
  unrelated.close();
  const before = readFileSync(other);
  assert.throws(() => new CodexAnalysisService(other), /INTEGRITY/);
  assert.deepEqual(readFileSync(other), before);
});
test("ANALYSIS-10 현재 writer 중복 차단·소유권 손상 시 분석만 보류", async () => {
  const path = newPath(),
    s = new CodexAnalysisService(path);
  try {
    assert.throws(() => new CodexAnalysisService(path), /OWNER_ACTIVE/);
    const db = new DatabaseSync(path);
    db.exec("DELETE FROM owner");
    db.close();
    assert.equal(s.view().error, "ANALYSIS_STORE_OR_POLICY_FAILED");
    assert.equal(s.view().mockCalls, null);
    assert.throws(() => create(s), /STORE_OR_POLICY_FAILED/);
  } finally {
    await s.close().catch(() => {});
  }
});
test("ANALYSIS-11 저장 승인·RUNNING 자식 비정상 종료 후 재실행하지 않음", async () => {
  for (const stage of ["APPROVED", "RUNNING"]) {
    const path = newPath(),
      module = pathToFileURL(
        resolve("dist/runtime/src/server/codex-analysis-service.js"),
      ).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const {CodexAnalysisService}=await import(${JSON.stringify(module)});
      const s=new CodexAnalysisService(${JSON.stringify(path)},async()=>new Promise(()=>{}));
      const id=crypto.randomUUID(); const j=s.request({type:'create',id,dataset:'SYNTHETIC_REVIEW_FIXTURE_V1'}).jobs[0];
      s.request({type:'approve',id,requestHash:j.requestHash,acknowledgeExactData:true,acknowledgeMockOnly:true});
      if (${JSON.stringify(stage)}==='RUNNING') s.request({type:'run',id,requestHash:j.requestHash});
      process.exit(73);`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000 },
    );
    assert.equal(child.status, 73, child.stderr);
    const reopened = new CodexAnalysisService(path);
    try {
      const j = reopened.view().jobs[0]!;
      assert.equal(j.state, stage === "RUNNING" ? "INTERRUPTED" : "CANCELLED");
      assert.equal(j.error, "RESTART_REQUIRES_NEW_REQUEST");
      assert.equal(j.result, null);
      if (j.calls) {
        run(reopened, j);
        assert.equal(reopened.view().mockCalls, 1);
      } else assert.throws(() => run(reopened, j), /APPROVAL_REQUIRED/);
    } finally {
      await reopened.close();
    }
  }
});
test("ANALYSIS-12 저장 한도 100개와 원자적 실패, 과거 기록 삭제 안 함", () => {
  const store = new AnalysisStore(newPath()),
    now = Date.now();
  try {
    store.update((jobs) => {
      for (let i = 0; i < 100; i++)
        jobs.push({
          ...newAnalysisJob(randomUUID(), now),
          state: "CANCELLED",
          error: "USER_CANCELLED",
          finishedAt: new Date(now).toISOString(),
        });
    }, now);
    const before = store.list();
    assert.throws(() =>
      store.update((jobs) => jobs.push(newAnalysisJob(randomUUID(), now)), now),
    );
    assert.deepEqual(store.list(), before);
    assert.throws(() =>
      store.update((jobs) => {
        jobs.pop();
      }, now),
    );
    assert.deepEqual(store.list(), before);
  } finally {
    store.close();
  }
});
test("ANALYSIS-13 재서명한 요청/결과·승인 상태 변조 거절", () => {
  const now = Date.now(),
    job = newAnalysisJob(randomUUID(), now);
  job.request.bundle.source.metrics.decisions = 999;
  job.request.bundleHash = hash(job.request.bundle);
  job.requestHash = hash(job.request);
  assert.throws(() => verifyAnalysisJob(job), /INTEGRITY/);
  const clean = newAnalysisJob(randomUUID(), now);
  clean.state = "RUNNING";
  assert.throws(() => verifyAnalysisJob(clean), /INTEGRITY/);
  assert.throws(
    () =>
      verifyAnalysisResult(
        JSON.stringify(mockResult(clean.request)),
        clean,
        now,
      ),
    /INVALID_RESULT/,
  );
});
test("ANALYSIS-14 모형 전체 흐름 외부 통신/자격증명 읽기 가드", () => {
  const path = newPath(),
    module = pathToFileURL(
      resolve("dist/runtime/src/server/codex-analysis-service.js"),
    ).href;
  const guard = `import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
  const deny=()=>{throw Error('OUTSIDE_SCOPE_ACCESS')}; globalThis.fetch=deny; http.request=deny; http.get=deny; https.request=deny; https.get=deny; net.connect=deny; net.createConnection=deny; child.spawn=deny; child.exec=deny; child.spawnSync=deny;
  const read=fs.readFileSync; fs.readFileSync=(p,...a)=>{if(/TEST_SECRET|auth.json|Toss API key/i.test(String(p))) deny();return read(p,...a)}; syncBuiltinESMExports();`;
  const guardPath = resolve(dirnameOf(path), "guard.mjs");
  // 시험 전용 가드/자료 생성이며 실제 키 경로를 읽지 않는다.
  writeFileSync(guardPath, guard);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(guardPath).href,
      "--input-type=module",
      "-e",
      `
    const {CodexAnalysisService}=await import(${JSON.stringify(module)});
    const s=new CodexAnalysisService(${JSON.stringify(path)});const id=crypto.randomUUID();
    const j=s.request({type:'create',id,dataset:'SYNTHETIC_REVIEW_FIXTURE_V1'}).jobs[0];
    s.request({type:'approve',id,requestHash:j.requestHash,acknowledgeExactData:true,acknowledgeMockOnly:true});
    s.request({type:'run',id,requestHash:j.requestHash}); await s.idle();
    if(s.view().jobs[0].state!=='VERIFIED_MOCK')throw Error('VERIFY_FAILED'); await s.close();`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  );
  assert.equal(child.status, 0, child.stderr);
});
function dirnameOf(path: string) {
  return resolve(path, "..");
}
