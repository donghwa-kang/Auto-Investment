import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cli = resolve("dist/runtime/src/server/catalog-fetch-cli.js");
const originals = [
  "AI_TRADING_POLICY_v2.3.json",
  "THEME_RESEARCH_POLICY_v1.3.json",
  "TRADING_STRATEGY_SPEC_v1.0.json",
];
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), "catalog-fetch-cli-"));
  mkdirSync(join(directory, "outputs"));
  for (const file of originals)
    copyFileSync(resolve("outputs", file), join(directory, "outputs", file));
  return directory;
}
function execute(
  directory: string,
  env: NodeJS.ProcessEnv = {},
  args: string[] = [],
) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    env: {
      ...process.env,
      TRADING_MODE: "PAPER",
      LIVE_ENABLED: "false",
      TOSS_CATALOG_READ_ONLY: "false",
      TOSS_CATALOG_TERMS_CONFIRMED: "false",
      TOSS_CREDENTIAL_FILE: join(directory, "nonexistent-key.txt"),
      ...env,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.stdout, "");
  assert.equal(result.status, 1);
  return result.stderr.trim();
}

test("TCAT-CLI-01 기본/이용 조건 미확인은 키 읽기 전에 거절·출력 파일 없음", () => {
  const directory = sandbox();
  assert.equal(execute(directory), "CATALOG_READ_ONLY_CONFIRMATION_REQUIRED");
  assert.equal(
    execute(directory, { TOSS_CATALOG_READ_ONLY: "true" }),
    "CATALOG_TERMS_AND_COST_CONFIRMATION_REQUIRED",
  );
  assert.deepEqual(readdirSync(directory), ["outputs"]);
});
test("TCAT-CLI-02 LIVE/임의 인자 거절", () => {
  const directory = sandbox();
  assert.equal(
    execute(directory, { TRADING_MODE: "LIVE" }),
    "CATALOG_LIVE_DISABLED",
  );
  assert.equal(
    execute(directory, { LIVE_ENABLED: "true" }),
    "CATALOG_LIVE_DISABLED",
  );
  assert.equal(
    execute(directory, {}, ["https://example.com/orders"]),
    "CATALOG_FETCH_NO_ARGUMENTS",
  );
  assert.deepEqual(readdirSync(directory), ["outputs"]);
});
test("TCAT-CLI-03 정책 해시 변경은 자격증명 로드 전에 거절", () => {
  const directory = sandbox();
  writeFileSync(join(directory, "outputs", originals[0]!), "{}");
  assert.equal(
    execute(directory, {
      TOSS_CATALOG_READ_ONLY: "true",
      TOSS_CATALOG_TERMS_CONFIRMED: "true",
    }),
    "CATALOG_FETCH_FAILED",
  );
  assert.deepEqual(readdirSync(directory), ["outputs"]);
});
test("TCAT-CLI-04 잘못된 더미 키 내용/경로 비노출·파일 보존", () => {
  const directory = sandbox(),
    path = join(directory, "dummy-secret.txt");
  const contents = "INVALID_FAKE_SECRET_NEVER_USE_12345";
  writeFileSync(path, contents);
  assert.equal(
    execute(directory, {
      TOSS_CATALOG_READ_ONLY: "true",
      TOSS_CATALOG_TERMS_CONFIRMED: "true",
      TOSS_CREDENTIAL_FILE: path,
    }),
    "CATALOG_FETCH_FAILED",
  );
  assert.equal(readFileSync(path, "utf8"), contents);
  assert.deepEqual(readdirSync(directory), [
    "data",
    "dummy-secret.txt",
    "outputs",
  ]);
  const state = readFileSync(
    join(directory, "data", "toss-catalogs", "daily-state.json"),
    "utf8",
  );
  assert.equal(JSON.parse(state).status, "STARTED");
  assert.ok(!state.includes(contents));
});

test(
  "TCAT-CLI-05 실제 자식 CLI 성공/부분 실패 종료 코드·모형 통신·격리 출력",
  { timeout: 25000 },
  () => {
    for (const response of ["SUCCESS", "FAIL"]) {
      const directory = sandbox();
      const keyPath = join(directory, "dummy.txt");
      const dummy =
        "CLIENT_ID=FAKE_CLIENT_123456\nCLIENT_SECRET=FAKE_SECRET_123456\n";
      writeFileSync(keyPath, dummy);
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(resolve("tests/toss-catalog-fetch-hook.mjs")).href,
          cli,
        ],
        {
          cwd: directory,
          encoding: "utf8",
          windowsHide: true,
          timeout: 15000,
          env: {
            ...process.env,
            TRADING_MODE: "PAPER",
            LIVE_ENABLED: "false",
            TOSS_CATALOG_READ_ONLY: "true",
            TOSS_CATALOG_TERMS_CONFIRMED: "true",
            TOSS_CREDENTIAL_FILE: keyPath,
            TEST_TOSS_CATALOG_RESPONSE: response,
          },
        },
      );
      assert.ifError(result.error);
      assert.equal(
        result.status,
        response === "SUCCESS" ? 0 : 2,
        result.stderr,
      );
      const summary = JSON.parse(result.stdout);
      assert.equal(
        summary.result,
        response === "SUCCESS"
          ? "CATALOG_SCOPES_RECEIVED"
          : "CATALOG_INCOMPLETE",
      );
      assert.equal(summary.ordersEnabled, false);
      assert.equal(summary.metadataReady, false);
      const report = readFileSync(summary.reportPath, "utf8");
      assert.equal(
        JSON.parse(report).requests.length,
        response === "SUCCESS" ? 8 : 2,
      );
      assert.ok(!report.includes("FAKE_SECRET_123456"));
      assert.ok(!report.includes("FAKE_TOKEN_TEST_ONLY"));
      assert.deepEqual(readdirSync(join(directory, "data")), ["toss-catalogs"]);
      assert.equal(readFileSync(keyPath, "utf8"), dummy);
      // 잘못된 키 경로라도 당일 재실행에서는 읽지 않는다. 실패도 재인증하지 않는다.
      if (response === "SUCCESS") {
        const cached = spawnSync(process.execPath, [cli], {
          cwd: directory,
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
          env: {
            ...process.env,
            TRADING_MODE: "PAPER",
            LIVE_ENABLED: "false",
            TOSS_CATALOG_READ_ONLY: "true",
            TOSS_CATALOG_TERMS_CONFIRMED: "true",
            TOSS_CREDENTIAL_FILE: join(directory, "no-key.txt"),
          },
        });
        assert.ifError(cached.error);
        assert.equal(cached.status, 0, cached.stderr);
        assert.equal(JSON.parse(cached.stdout).result, "CATALOG_CACHE_REUSED");
        assert.equal(JSON.parse(cached.stdout).networkRequestsThisRun, 0);
        assert.equal(JSON.parse(cached.stdout).reportPath, summary.reportPath);
        const offline = spawnSync(
          process.execPath,
          [resolve("dist/runtime/src/server/catalog-cached-cli.js")],
          {
            cwd: directory,
            encoding: "utf8",
            windowsHide: true,
            timeout: 10000,
            env: {
              ...process.env,
              TRADING_MODE: "PAPER",
              LIVE_ENABLED: "false",
              TOSS_CATALOG_READ_ONLY: "false",
              TOSS_CATALOG_TERMS_CONFIRMED: "false",
              TOSS_CREDENTIAL_FILE: join(directory, "no-key.txt"),
            },
          },
        );
        assert.ifError(offline.error);
        assert.equal(offline.status, 0, offline.stderr);
        assert.equal(JSON.parse(offline.stdout).networkRequestsThisRun, 0);
      } else {
        assert.equal(
          execute(directory, {
            TOSS_CATALOG_READ_ONLY: "true",
            TOSS_CATALOG_TERMS_CONFIRMED: "true",
          }),
          "CATALOG_DAILY_ATTEMPT_ALREADY_USED",
        );
      }
    }
  },
);

test(
  "TCAT-CLI-06 실제 두 프로세스 잠금·소유 자식 강제 종료 후 잠금 보존",
  { timeout: 25000 },
  async () => {
    const directory = sandbox();
    const keyPath = join(directory, "dummy.txt");
    writeFileSync(
      keyPath,
      "CLIENT_ID=FAKE_CLIENT_123456\nCLIENT_SECRET=FAKE_SECRET_123456\n",
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(resolve("tests/toss-catalog-fetch-hook.mjs")).href,
        cli,
      ],
      {
        cwd: directory,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          TRADING_MODE: "PAPER",
          LIVE_ENABLED: "false",
          TOSS_CATALOG_READ_ONLY: "true",
          TOSS_CATALOG_TERMS_CONFIRMED: "true",
          TOSS_CREDENTIAL_FILE: keyPath,
          TEST_TOSS_CATALOG_RESPONSE: "HOLD",
        },
      },
    );
    const exited = new Promise<void>((done) => {
      child.once("exit", () => done());
    });
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(
          () => reject(new Error("MOCK_CHILD_NOT_READY")),
          15000,
        );
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("MOCK_CHILD_EARLY_EXIT"));
        });
        child.once("message", (message) => {
          clearTimeout(timer);
          if (message === "MOCK_AUTH_REACHED") done();
          else reject(new Error("MOCK_CHILD_MESSAGE_INVALID"));
        });
      });
      const lockPath = join(
        directory,
        "data",
        "toss-catalogs",
        "daily-fetch.lock",
      );
      const lock = readFileSync(lockPath);
      assert.equal(
        execute(directory, {
          TOSS_CATALOG_READ_ONLY: "true",
          TOSS_CATALOG_TERMS_CONFIRMED: "true",
        }),
        "CATALOG_CACHE_LOCKED_OR_UNWRITABLE",
      );
      child.kill("SIGKILL");
      await exited;
      assert.deepEqual(readFileSync(lockPath), lock);
      assert.equal(
        execute(directory, {
          TOSS_CATALOG_READ_ONLY: "true",
          TOSS_CATALOG_TERMS_CONFIRMED: "true",
        }),
        "CATALOG_CACHE_LOCKED_OR_UNWRITABLE",
      );
      assert.equal(
        JSON.parse(
          readFileSync(
            join(directory, "data", "toss-catalogs", "daily-state.json"),
            "utf8",
          ),
        ).status,
        "STARTED",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    }
  },
);

test("TCAT-CLI-07 읽기 전용 캐시 명령의 없음/인자/LIVE/정책 거절·파일 미생성", () => {
  const directory = sandbox();
  const cachedCli = resolve("dist/runtime/src/server/catalog-cached-cli.js");
  for (const mode of ["MISSING", "ARGS", "LIVE", "POLICY"]) {
    if (mode === "POLICY")
      writeFileSync(join(directory, "outputs", originals[0]!), "{}");
    const result = spawnSync(
      process.execPath,
      [cachedCli, ...(mode === "ARGS" ? ["arbitrary.json"] : [])],
      {
        cwd: directory,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        env: {
          ...process.env,
          TRADING_MODE: mode === "LIVE" ? "LIVE" : "PAPER",
          LIVE_ENABLED: "false",
          TOSS_CATALOG_READ_ONLY: "false",
          TOSS_CATALOG_TERMS_CONFIRMED: "false",
          TOSS_CREDENTIAL_FILE: join(directory, "nonexistent.txt"),
        },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.trim(),
      mode === "MISSING"
        ? "CATALOG_CACHE_MISSING"
        : mode === "ARGS"
          ? "CATALOG_CACHED_NO_ARGUMENTS"
          : "CATALOG_CACHED_FAILED",
    );
    assert.deepEqual(readdirSync(directory), ["outputs"]);
  }
});
