import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildLaunchPlan,
  launchLayout,
  launchSha256,
  parseLaunchCommand,
  requireLaunchLocalPath,
  serializeLaunchPlan,
  validateLaunchPlan,
} from "../src/core/analysis-launch-plan.js";
import {
  checkAnalysisLaunch,
  prepareAnalysisLaunch,
  readLaunchFile,
} from "../src/server/analysis-launch-files.js";

const runId = "269be5e8-4dc3-4aa0-a327-0c9033018bda";
const hashes = {
  core: "a".repeat(64),
  files: "b".repeat(64),
  cli: "c".repeat(64),
  lockfile: "d".repeat(64),
};
const context = { workspace: "C:\\PaperLab", runId, codeHashes: hashes };
const createdAt = "2026-09-14T00:00:00.000Z";
const actualWorkspace = fileURLToPath(
  new URL("../../../", import.meta.url),
).replace(/[\\/]$/, "");
function plan() {
  return buildLaunchPlan({ ...context, createdAt });
}
function validate(value: ReturnType<typeof plan>, patch = {}) {
  const bytes = Buffer.from(serializeLaunchPlan(value));
  return validateLaunchPlan(bytes, launchSha256(bytes), {
    ...context,
    ...patch,
  });
}
function fixture() {
  const root = mkdtempSync(join(actualWorkspace, "work", "launch-plan-test-"));
  mkdirSync(join(root, "work"));
  for (const file of [
    "package-lock.json",
    "dist/runtime/src/core/analysis-launch-plan.js",
    "dist/runtime/src/server/analysis-launch-files.js",
    "dist/runtime/src/server/analysis-launch-cli.js",
  ]) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(actualWorkspace, file), path);
  }
  return root;
}
function prepared() {
  const root = fixture();
  const result = prepareAnalysisLaunch(root);
  return { root, result, bundle: dirname(result.manifestPath) };
}
function cli(root: string, args: string[]) {
  const temp = join(root, "work");
  return spawnSync(
    process.execPath,
    [join(root, "dist/runtime/src/server/analysis-launch-cli.js"), ...args],
    {
      shell: false,
      windowsHide: true,
      cwd: temp,
      timeout: 10000,
      maxBuffer: 32768,
      encoding: "utf8",
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: temp,
        TMP: temp,
      },
    },
  );
}

test("PLAN 정상 명세는 결정적·미확정 값을 보존하고 실행 불가", () => {
  const value = validate(plan());
  assert.deepEqual(value, plan());
  assert.equal(value.profile.sid, null);
  assert.equal(value.profile.storagePath, null);
  assert.equal(value.profile.name.length, 61);
  assert.equal(value.execution.allowed, false);
  assert.equal(value.execution.realCodexEnabled, false);
  assert.equal(value.execution.nativeArtifact, null);
  assert.equal(value.targets.length, 6);
  assert.deepEqual(hashes, context.codeHashes);
});

for (const path of [
  "relative",
  "C:relative",
  "C:\\",
  "c:\\lab",
  "\\\\host\\share",
  "\\\\?\\C:\\lab",
  "C:\\a\\..\\b",
  "C:\\a\\NUL.txt",
  "C:\\a\\COM1",
  "C:\\a\\name:stream",
  "C:\\a\\name.",
  "C:\\a\\name ",
  "C:/lab",
  "C:\\a\\b\n",
  "C:\\" + "a".repeat(221),
])
  test(`PLAN 비정규/장치/공유 경로 거절 ${JSON.stringify(path)}`, () => {
    assert.throws(() => requireLaunchLocalPath(path));
  });

test("PLAN 입력·명세 해시/크기/인코딩·중복 키·비정규 표현 거절", () => {
  const valid = Buffer.from(serializeLaunchPlan(plan()));
  assert.throws(() => validateLaunchPlan(valid, "e".repeat(64), context));
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(32769),
    Buffer.from([0xc3, 0x28]),
    Buffer.from("{}"),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
    Buffer.from(" " + valid.toString()),
    Buffer.from(
      valid
        .toString()
        .replace('"mode":', '"mode": "PREPARATION_ONLY", "mode":'),
    ),
    Buffer.from(valid.toString() + "{}"),
  ])
    assert.throws(() =>
      validateLaunchPlan(bytes, launchSha256(bytes), context),
    );
});

test("PLAN 범위/순서/제한/승인·출처 위조는 해시를 다시 계산해도 거절", () => {
  const mutations: ((p: ReturnType<typeof plan>) => void)[] = [
    (p) => {
      p.targets[0]!.path = "C:\\Windows";
    },
    (p) => {
      p.targets[0]!.accessIntent = "FULL_ACCESS";
    },
    (p) => {
      p.targets.reverse();
    },
    (p) => {
      p.targets[1] = p.targets[0]!;
    },
    (p) => {
      p.profile.name = "ExistingProfile";
    },
    (p) => {
      p.blockers = [];
    },
    (p) => {
      p.input.sha256 = "e".repeat(64);
    },
    (p) => {
      Object.assign(p.execution, { allowed: true, approval: "APPROVED" });
    },
    (p) => {
      Object.assign(p.profile, {
        sid: "S-1-1-0",
        capabilities: ["internetClient"],
      });
    },
    (p) => {
      Object.assign(p.limits, { activeProcesses: 4 });
    },
    (p) => {
      Object.assign(p, { command: "cmd.exe", apiKey: "DUMMY_ONLY" });
    },
  ];
  for (const mutate of mutations) {
    const value = plan();
    mutate(value);
    assert.throws(() => validate(value));
  }
});

test("PLAN 프로젝트/run-id/코드/잠금 파일 변경은 승인 해시 재사용 불가", () => {
  for (const patch of [
    { workspace: "C:\\Different" },
    { runId: "a69be5e8-4dc3-4aa0-a327-0c9033018bda" },
    { codeHashes: { ...hashes, core: "e".repeat(64) } },
    { codeHashes: { ...hashes, lockfile: "f".repeat(64) } },
  ])
    assert.throws(() => validate(plan(), patch));
});

test("PLAN 명령은 prepare/check만 수용하고 실행/승인/임의 경로 거절", () => {
  assert.deepEqual(parseLaunchCommand(["prepare"]), { action: "prepare" });
  assert.equal(
    parseLaunchCommand(["check", runId, hashes.core]).action,
    "check",
  );
  for (const args of [
    [],
    ["execute"],
    ["approve"],
    ["setup"],
    ["prepare", "--execute"],
    ["check", "../other", hashes.core],
    ["check", runId, "bad"],
    ["check", runId, hashes.core, "--approve"],
  ])
    assert.throws(() => parseLaunchCommand(args));
});

test("PLAN 실제 준비 2회는 새 묶음, check는 읽기 전용, OS 경로 생성 없음", () => {
  const root = fixture();
  const first = prepareAnalysisLaunch(root);
  const paths = launchLayout(root, first.runId);
  const before = readdirSync(paths.bundle).map((name) => [
    name,
    launchSha256(readFileSync(join(paths.bundle, name))),
  ]);
  const checked = checkAnalysisLaunch(root, first.runId, first.manifestSha256);
  assert.equal(checked.status, "PLAN_VALID_EXECUTION_LOCKED");
  assert.equal(checked.executionAllowed, false);
  assert.equal(checked.actualOsTests, "NOT_RUN");
  const after = readdirSync(paths.bundle).map((name) => [
    name,
    launchSha256(readFileSync(join(paths.bundle, name))),
  ]);
  assert.deepEqual(after, before);
  assert.equal(existsSync(paths.runParent), false);
  const second = prepareAnalysisLaunch(root);
  assert.notEqual(first.runId, second.runId);
  assert.equal(
    checkAnalysisLaunch(root, first.runId, first.manifestSha256)
      .executionAllowed,
    false,
  );
});

test("PLAN 실제 파일 입력 변경/누락/추가 파일 거절", () => {
  for (const kind of ["input", "missing", "extra"] as const) {
    const { root, result, bundle } = prepared();
    if (kind === "input")
      writeFileSync(join(bundle, "approved-input.txt"), "ALTERED_DUMMY");
    if (kind === "missing")
      renameSync(result.manifestPath, join(root, "saved-manifest.json"));
    if (kind === "extra")
      writeFileSync(join(bundle, "extra.txt"), "DUMMY_ONLY");
    assert.throws(() =>
      checkAnalysisLaunch(root, result.runId, result.manifestSha256),
    );
  }
});

test("PLAN 명세 변경·현재 코드 변경·예정 OS 경로 충돌 거절", () => {
  for (const kind of ["manifest", "code", "target"] as const) {
    const { root, result } = prepared();
    if (kind === "manifest") writeFileSync(result.manifestPath, "{}");
    if (kind === "code")
      writeFileSync(
        join(root, "dist/runtime/src/core/analysis-launch-plan.js"),
        "// MODIFIED_TEST_COPY\n",
      );
    if (kind === "target")
      mkdirSync(result.proposedRunRoot, { recursive: true });
    assert.throws(() =>
      checkAnalysisLaunch(root, result.runId, result.manifestSha256),
    );
  }
});

test("PLAN 실제 hardlink 파일 거절, 외부 dummy 변경 없음", () => {
  const { root, result, bundle } = prepared();
  const path = join(bundle, "approved-input.txt");
  linkSync(path, join(root, "linked-dummy.txt"));
  const before = readFileSync(path);
  assert.throws(() =>
    checkAnalysisLaunch(root, result.runId, result.manifestSha256),
  );
  assert.deepEqual(readFileSync(path), before);
});

test("PLAN 실제 junction 부모에서 새 묶음을 쓰지 않음", () => {
  const root = fixture();
  const destination = mkdtempSync(
    join(actualWorkspace, "work", "launch-junction-test-"),
  );
  symlinkSync(
    destination,
    join(root, "work", "analysis-launch-plans"),
    "junction",
  );
  assert.throws(() => prepareAnalysisLaunch(root));
  assert.deepEqual(readdirSync(destination), []);
});

test("PLAN 실제 oversized 파일 읽기 거절", () => {
  const root = fixture();
  const path = join(root, "too-large.txt");
  writeFileSync(path, Buffer.alloc(4097));
  assert.throws(() => readLaunchFile(path, 4096));
});

test("PLAN 추가 장치 별칭과 run-id 형식 거절", () => {
  for (const path of ["C:\\lab\\CONIN$", "C:\\lab\\COM¹", "C:\\lab\\LPT².txt"])
    assert.throws(() => requireLaunchLocalPath(path));
  for (const id of [
    runId.toUpperCase(),
    "../run",
    runId.replace("4aa0", "1aa0"),
  ])
    assert.throws(() => launchLayout(context.workspace, id));
  assert.doesNotThrow(() =>
    launchLayout(context.workspace, runId.replace("4dc3", "1dc3")),
  );
});

test("PLAN 예정 실행 부모 junction은 check에서 거절하며 대상은 불변", () => {
  const { root, result } = prepared();
  const destination = mkdtempSync(
    join(actualWorkspace, "work", "launch-target-link-"),
  );
  symlinkSync(destination, join(root, "work", "analysis-os-lab"), "junction");
  assert.throws(() =>
    checkAnalysisLaunch(root, result.runId, result.manifestSha256),
  );
  assert.deepEqual(readdirSync(destination), []);
});

test("PLAN 준비 실패가 기존 묶음을 덮어쓰지 않고 잘못된 check도 쓰기 없음", () => {
  const { root, result, bundle } = prepared();
  const before = readdirSync(bundle).map((name) => [
    name,
    launchSha256(readFileSync(join(bundle, name))),
  ]);
  const response = cli(root, ["check", result.runId, "f".repeat(64)]);
  assert.equal(response.status, 1);
  assert.equal(response.stdout, "");
  assert.deepEqual(
    readdirSync(bundle).map((name) => [
      name,
      launchSha256(readFileSync(join(bundle, name))),
    ]),
    before,
  );
  // 잠금 파일 결측은 새 묶음을 만들기 전에 거절한다. 이 파일은 시험 복사본이다.
  renameSync(join(root, "package-lock.json"), join(root, "saved-lock.json"));
  const existing = readdirSync(join(root, "work", "analysis-launch-plans"));
  assert.throws(() => prepareAnalysisLaunch(root));
  assert.deepEqual(
    readdirSync(join(root, "work", "analysis-launch-plans")),
    existing,
  );
});

test("PLAN 실제 CLI는 prepare/check 성공, 실행/승인 인자는 쓰기 전에 거절", () => {
  const root = fixture();
  for (const args of [
    [],
    ["execute"],
    ["prepare", "--approve"],
    ["check", runId, "bad"],
  ]) {
    const result = cli(root, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "ANALYSIS_LAUNCH_PREPARATION_REJECTED");
    assert.deepEqual(readdirSync(join(root, "work")), []);
  }
  const prepared = cli(root, ["prepare"]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const result = JSON.parse(prepared.stdout) as {
    status: string;
    runId: string;
    manifestSha256: string;
  };
  assert.equal(result.status, "PREPARED_NOT_EXECUTABLE");
  const checked = cli(root, ["check", result.runId, result.manifestSha256]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).executionAllowed, false);
  assert.equal(existsSync(join(root, "work", "analysis-os-lab")), false);
});
