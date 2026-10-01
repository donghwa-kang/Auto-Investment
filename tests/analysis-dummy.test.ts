import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  linkSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  classifyDummyProbe,
  parseDummyReceipt,
  dummyReceiptSchema,
  type DummyReceipt,
} from "../src/core/analysis-dummy.js";
import {
  createDummyFixture,
  executeDummyFileProbe,
  dummyTargets,
  dummySha256,
  dummyMutation,
  type DummyJob,
} from "../src/server/analysis-dummy-files.js";

const runId = "269be5e8-4dc3-4aa0-a327-0c9033018bda";
const hash = "a".repeat(64);
function receipt(patch: Partial<DummyReceipt> = {}): DummyReceipt {
  return {
    version: "DUMMY_FILE_RECEIPT_V1",
    runId,
    caseId: "DENY_READ",
    manifestSha256: hash,
    attempted: true,
    outcome: "ERROR",
    errorCode: "EACCES",
    observedSha256: null,
    ...patch,
  };
}
function classify(
  r: DummyReceipt,
  patch: Partial<Parameters<typeof classifyDummyProbe>[0]> = {},
) {
  return classifyDummyProbe({
    caseId: r.caseId,
    runId,
    manifestSha256: hash,
    controlMatched: true,
    beforeSha256: hash,
    afterSha256: hash,
    receipt: r,
    ...patch,
  });
}
for (const code of ["EACCES", "EPERM"] as const)
  test(`DUMMY permission ${code}는 보고된 거절이지 OS 증명이 아님`, () => {
    assert.equal(
      classify(receipt({ errorCode: code })),
      "DENIAL_REPORTED_NOT_OS_ATTESTED",
    );
  });
for (const code of ["ENOENT", "OTHER", "PRECONDITION"] as const)
  test(`DUMMY ${code}를 차단 통과로 세지 않음`, () => {
    assert.equal(classify(receipt({ errorCode: code })), "INCONCLUSIVE");
  });
test("DUMMY 양성 대조·요청 ID·자료 해시·case 일치 필수", () => {
  for (const patch of [
    { controlMatched: false },
    { runId: "b" },
    { manifestSha256: "b".repeat(64) },
    { caseId: "DENY_WRITE" as const },
  ])
    assert.equal(classify(receipt(), patch), "INCONCLUSIVE");
  assert.equal(classify(receipt({ attempted: false })), "INCONCLUSIVE");
});
test("DUMMY 읽기/쓰기 성공은 비허용 대상의 노출", () => {
  assert.equal(
    classify(
      receipt({ outcome: "READ", errorCode: null, observedSha256: hash }),
    ),
    "EXPOSURE_DETECTED",
  );
  assert.equal(
    classify(
      receipt({
        caseId: "DENY_WRITE",
        outcome: "WRITE",
        errorCode: null,
        observedSha256: hash,
      }),
    ),
    "EXPOSURE_DETECTED",
  );
});
test("DUMMY 거절 주장과 달리 대상 변경은 노출, 사후 해시 결측은 미확인", () => {
  assert.equal(
    classify(receipt({ caseId: "DENY_WRITE" }), {
      afterSha256: "b".repeat(64),
    }),
    "EXPOSURE_DETECTED",
  );
  assert.equal(
    classify(receipt({ caseId: "DENY_WRITE" }), { afterSha256: null }),
    "INCONCLUSIVE",
  );
});
test("DUMMY 허용 읽기는 실제 내용 해시/불변이 맞아야 함", () => {
  const r = receipt({
    caseId: "ALLOW_READ",
    outcome: "READ",
    errorCode: null,
    observedSha256: hash,
  });
  assert.equal(classify(r), "ALLOW_OBSERVED");
  assert.equal(
    classify({ ...r, observedSha256: "b".repeat(64) }),
    "INCONCLUSIVE",
  );
});
test("DUMMY 영수증의 모순·임의 성공 필드 거절", () => {
  for (const r of [
    { ...receipt(), approved: true },
    receipt({ outcome: "READ" }),
    receipt({
      caseId: "DENY_WRITE",
      outcome: "READ",
      errorCode: null,
      observedSha256: hash,
    }),
    receipt({ observedSha256: hash }),
  ])
    assert.equal(dummyReceiptSchema.safeParse(r).success, false);
});
test("DUMMY 출력 크기·손상 UTF8·JSON/추가 메시지 거절", () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(4097),
    Buffer.from([0xc3, 0x28]),
    Buffer.from("{}\n{}"),
    Buffer.from("null"),
  ])
    assert.throws(() => parseDummyReceipt(bytes));
  assert.deepEqual(
    parseDummyReceipt(Buffer.from(JSON.stringify(receipt()))),
    receipt(),
  );
});
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "paper-dummy-test-"));
  return createDummyFixture(parent);
}
function job(
  f: ReturnType<typeof fixture>,
  caseId: DummyJob["caseId"],
): DummyJob {
  return {
    version: "DUMMY_FILE_JOB_V1",
    root: f.root,
    runId: f.manifest.runId,
    caseId,
    manifestSha256: f.manifestSha256,
  };
}
test("DUMMY 실제 더미 파일의 양성 대조·전용 쓰기", () => {
  const f = fixture();
  for (const caseId of ["ALLOW_READ", "DENY_READ"] as const) {
    const r = executeDummyFileProbe(job(f, caseId));
    assert.equal(r.outcome, "READ");
    assert.equal(r.observedSha256, f.manifest.targets[caseId]);
    assert.equal(
      dummySha256(readFileSync(join(f.root, dummyTargets[caseId]))),
      f.manifest.targets[caseId],
    );
  }
  const path = join(f.root, dummyTargets.DENY_WRITE);
  const before = readFileSync(path);
  const r = executeDummyFileProbe(job(f, "DENY_WRITE"));
  assert.equal(r.outcome, "WRITE");
  assert.deepEqual(
    readFileSync(path),
    Buffer.concat([before, Buffer.from(dummyMutation)]),
  );
  assert.equal(r.observedSha256, dummySha256(readFileSync(path)));
  assert.equal(executeDummyFileProbe(job(f, "DENY_WRITE")).attempted, false);
});
test("DUMMY marker 변조·runId 불일치·임의 경로 거절", () => {
  const f = fixture();
  assert.equal(
    executeDummyFileProbe({ ...job(f, "ALLOW_READ"), runId }).attempted,
    false,
  );
  assert.equal(
    executeDummyFileProbe({ ...job(f, "ALLOW_READ"), root: "../data" })
      .attempted,
    false,
  );
  assert.throws(() =>
    executeDummyFileProbe({ ...job(f, "ALLOW_READ"), target: "arbitrary" }),
  );
  writeFileSync(join(f.root, "manifest.json"), "{}");
  assert.equal(executeDummyFileProbe(job(f, "ALLOW_READ")).attempted, false);
});
test("DUMMY 전용 내용과 다른 파일은 쓰지 않음", () => {
  const f = fixture();
  const path = join(f.root, dummyTargets.DENY_WRITE);
  writeFileSync(path, "not-a-dummy-target");
  const r = executeDummyFileProbe(job(f, "DENY_WRITE"));
  assert.equal(r.attempted, false);
  assert.equal(readFileSync(path, "utf8"), "not-a-dummy-target");
});
test("DUMMY 존재하지 않는 대상은 사전조건 실패", () => {
  const f = fixture();
  const path = join(f.root, dummyTargets.DENY_READ);
  renameSync(path, join(f.root, "preserved-read-target.txt"));
  const r = executeDummyFileProbe(job(f, "DENY_READ"));
  assert.equal(r.errorCode, "PRECONDITION");
  assert.equal(r.attempted, false);
});
test("DUMMY hardlink와 junction을 대상 파일/루트로 받지 않음", () => {
  const f = fixture();
  const path = join(f.root, dummyTargets.DENY_WRITE);
  const preserved = join(f.root, "preserved-write-target.txt");
  renameSync(path, preserved);
  linkSync(preserved, path);
  assert.equal(executeDummyFileProbe(job(f, "DENY_WRITE")).attempted, false);
  assert.equal(
    dummySha256(readFileSync(preserved)),
    f.manifest.targets.DENY_WRITE,
  );
  const alias = join(f.root, "lab-ABC123");
  symlinkSync(f.root, alias, "junction");
  assert.equal(
    executeDummyFileProbe({ ...job(f, "ALLOW_READ"), root: alias }).attempted,
    false,
  );
});
const worker = fileURLToPath(
  new URL("../src/server/analysis-dummy-worker.js", import.meta.url),
);
const cli = fileURLToPath(
  new URL("../src/server/analysis-dummy-cli.js", import.meta.url),
);
test("DUMMY 실제 worker는 초과/손상/임의 명령 입력을 거절하고 원문을 출력하지 않음", () => {
  for (const input of [
    "x".repeat(4097),
    "not-json",
    JSON.stringify({ command: "never-run" }),
  ]) {
    const r = spawnSync(process.execPath, [worker], {
      input,
      shell: false,
      windowsHide: true,
      timeout: 7000,
    });
    assert.equal(r.status, 1);
    assert.equal(r.stdout.length, 0);
    assert.equal(r.stderr.length, 0);
  }
});
test("DUMMY stdin 완료가 없는 소유 worker는 5초 기한 후 종료", async () => {
  const child = spawn(process.execPath, [worker], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = await new Promise<number | null>((resolveExit, reject) => {
    const watchdog = setTimeout(() => {
      child.kill();
      reject(new Error("DUMMY_WATCHDOG"));
    }, 7000);
    child.once("error", (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      resolveExit(code);
    });
  });
  assert.equal(exit, 1);
});
test("DUMMY CLI 임의 인자는 새 실행 생성 전에 거절", () => {
  const root = resolve("work");
  const before = readdirSync(root).sort();
  const r = spawnSync(process.execPath, [cli, "--execute"], {
    shell: false,
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(r.status, 1);
  assert.deepEqual(readdirSync(root).sort(), before);
});
test("DUMMY 실제 CLI는 노출을 확인한 자기검사이며 실제 OS 시험은 NOT_RUN", () => {
  const r = spawnSync(process.execPath, [cli], {
    shell: false,
    windowsHide: true,
    timeout: 15000,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const output = JSON.parse(r.stdout) as { status: string; reportPath: string };
  const report = JSON.parse(readFileSync(output.reportPath, "utf8")) as {
    status: string;
    actualOsTests: string;
    osIsolationVerified: boolean;
    realCodexEnabled: boolean;
    observations: { classification: string }[];
  };
  assert.equal(report.status, "SELF_TEST_PASSED");
  assert.equal(report.actualOsTests, "NOT_RUN");
  assert.equal(report.osIsolationVerified, false);
  assert.equal(report.realCodexEnabled, false);
  assert.deepEqual(
    report.observations.map((x) => x.classification),
    ["ALLOW_OBSERVED", "EXPOSURE_DETECTED", "EXPOSURE_DETECTED"],
  );
});
