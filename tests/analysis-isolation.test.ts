import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assessIsolationHost,
  parseIsolationProbe,
  type IsolationHost,
} from "../src/core/analysis-isolation.js";

function fixture(): IsolationHost {
  return {
    version: "ANALYSIS_ISOLATION_HOST_V1",
    capturedAt: "2026-09-14T00:00:00.000Z",
    platform: "win32",
    os: { editionId: "Core", build: 26200, is64Bit: true },
    elevated: false,
    hardware: {
      logicalProcessors: null,
      memoryMiB: null,
      hypervisorPresent: null,
      virtualizationFirmwareEnabled: null,
      slat: null,
    },
    executables: { windowsSandbox: false, wsl: true, codexOnPath: true },
    features: {
      windowsSandbox: "UNKNOWN",
      hyperV: "UNKNOWN",
      virtualMachinePlatform: "UNKNOWN",
      wsl: "UNKNOWN",
    },
    unavailable: [
      "COMPUTER_QUERY_UNAVAILABLE",
      "PROCESSOR_QUERY_UNAVAILABLE",
      "FEATURE_QUERY_UNAVAILABLE",
    ],
  };
}
test("ISO-01 Home 후보 제외·네이티브/WSL 실행 가능 또는 격리 성공으로 오인하지 않음", () => {
  const r = assessIsolationHost(fixture());
  assert.equal(r.candidates.microsoftWindowsSandbox, "UNSUPPORTED_EDITION");
  assert.equal(r.candidates.codexNative, "INVESTIGATE_ELEVATED_BOUNDARY");
  assert.equal(
    r.candidates.wsl2,
    "EXECUTABLE_ONLY_DISTRO_AND_ISOLATION_UNCONFIRMED",
  );
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.realCodexEnabled, false);
  assert.equal(r.osIsolationVerified, false);
  assert.equal(r.host.hardware.memoryMiB, null);
});
test("ISO-02 모든 기능 Enabled/관리자/실행 파일 존재여도 연결 승인 불가", () => {
  const f = fixture();
  f.os.editionId = "Professional";
  f.elevated = true;
  f.features = {
    windowsSandbox: "Enabled",
    hyperV: "Enabled",
    virtualMachinePlatform: "Enabled",
    wsl: "Enabled",
  };
  f.executables.windowsSandbox = true;
  f.hardware = {
    logicalProcessors: 16,
    memoryMiB: 32768,
    hypervisorPresent: true,
    virtualizationFirmwareEnabled: true,
    slat: true,
  };
  f.unavailable = [];
  const r = assessIsolationHost(f);
  assert.equal(r.candidates.microsoftWindowsSandbox, "CANDIDATE_NOT_TESTED");
  assert.equal(r.realCodexEnabled, false);
  assert.equal(r.osIsolationVerified, false);
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.missingEvidence.length, 5);
});
test("ISO-03 알 수 없는 에디션/빌드/기능은 실패를 false/0으로 채우지 않음", () => {
  const f = fixture();
  f.os.editionId = null;
  f.os.build = null;
  f.executables.codexOnPath = null;
  f.executables.wsl = null;
  const r = assessIsolationHost(f);
  assert.equal(r.candidates.microsoftWindowsSandbox, "EDITION_UNCONFIRMED");
  assert.equal(r.candidates.codexNative, "ENVIRONMENT_UNCONFIRMED");
  assert.equal(r.candidates.wsl2, "ENVIRONMENT_UNCONFIRMED");
  assert.equal(r.host.os.build, null);
  f.os.editionId = "FutureEdition";
  assert.equal(
    assessIsolationHost(f).candidates.microsoftWindowsSandbox,
    "EDITION_UNCONFIRMED",
  );
});
for (const state of [
  "Disabled",
  "EnablePending",
  "DisablePending",
  "DisabledWithPayloadRemoved",
  "UNKNOWN",
] as const) {
  test(`ISO-04 기능 ${state}는 Enabled가 아님`, () => {
    const f = fixture();
    f.os.editionId = "Enterprise";
    f.features.windowsSandbox = state;
    f.executables.windowsSandbox = true;
    assert.equal(
      assessIsolationHost(f).candidates.microsoftWindowsSandbox,
      "FEATURE_UNCONFIRMED",
    );
  });
}
test("ISO-05 추가 승인/비밀/임의 본문 필드·잘못된 자료형 거절", () => {
  for (const extra of [
    { realCodexEnabled: true },
    { token: "TEST_ONLY_NOT_A_SECRET" },
    { osIsolationVerified: true },
    { model: "ANY" },
  ])
    assert.throws(() => assessIsolationHost({ ...fixture(), ...extra }));
  assert.throws(() => assessIsolationHost({ ...fixture(), elevated: "false" }));
  assert.throws(() =>
    assessIsolationHost({
      ...fixture(),
      hardware: { ...fixture().hardware, memoryMiB: -1 },
    }),
  );
  assert.throws(() =>
    assessIsolationHost({
      ...fixture(),
      os: { ...fixture().os, path: "TEST_ONLY" },
    }),
  );
  assert.throws(() =>
    assessIsolationHost({ ...fixture(), unavailable: ["PRIVATE_ERROR_BODY"] }),
  );
});
test("ISO-06 BOM/공백 JSON 수용·빈/과대/손상 인코딩·추가 문서 거절", () => {
  const text = JSON.stringify(fixture());
  assert.deepEqual(
    parseIsolationProbe(Buffer.from("\uFEFF " + text + "\r\n")),
    fixture(),
  );
  for (const b of [
    Buffer.alloc(0),
    Buffer.alloc(16385, 32),
    Buffer.from([0xff]),
    Buffer.from(text + text),
    Buffer.from("{broken"),
  ])
    assert.throws(() => parseIsolationProbe(b));
});
test("ISO-07 입력 수정 없음·결정적 진단·숫자/상태 고정", () => {
  const f = fixture(),
    before = JSON.stringify(f);
  const r = assessIsolationHost(f);
  assert.deepEqual(r, assessIsolationHost(f));
  assert.equal(JSON.stringify(f), before);
  r.host.os.build = 1;
  assert.equal(JSON.stringify(f), before);
});
test("ISO-08 조회 스크립트는 고정 읽기 명령·개인 파일/설정/실행/다운로드 경로 없음", () => {
  const s = readFileSync("scripts/probe-analysis-isolation.ps1", "utf8");
  assert.ok(
    !/\b(?:Set-Item|Set-ItemProperty|New-Item|Remove-Item|Enable-WindowsOptionalFeature|Disable-WindowsOptionalFeature|Start-Process|Invoke-Expression|Invoke-WebRequest|Invoke-RestMethod|Get-Content|Get-LocalUser)\b/i.test(
      s,
    ),
  );
  assert.ok(
    !/auth\.json|sandbox-secrets|Toss API key|\.env\b|\.wslconfig/.test(s),
  );
  assert.ok(s.includes("Get-Command codex.exe -CommandType Application"));
  assert.ok(s.includes("Get-WindowsOptionalFeature -Online"));
  assert.ok(
    s.includes("catch { $probe.unavailable.Add('FEATURE_QUERY_UNAVAILABLE') }"),
  );
});
test("ISO-09 CLI 임의 명령 인자는 실행/보고 폴더 생성 전에 거절", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "isolation-arguments-"));
  const entry = fileURLToPath(
    new URL("../src/server/analysis-isolation-cli.js", import.meta.url),
  );
  for (const args of [
    ["--enable"],
    ["--command", "TEST_ONLY"],
    ["--output", "TEST_ONLY"],
  ]) {
    const r = spawnSync(process.execPath, [entry, ...args], {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trim(), "ISOLATION_PREPARATION_FAILED");
    assert.equal(existsSync(resolve(cwd, "work")), false);
  }
});

for (const mode of [
  "timeout",
  "exit",
  "stderr",
  "bad-json",
  "success",
] as const) {
  test(`ISO-10 CLI ${mode}: 고정 조회 옵션·보고서 오류 원문 배제·연결 차단`, () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "isolation-cli-mock-"));
    mkdirSync(resolve(cwd, "scripts"));
    copyFileSync(
      "scripts/probe-analysis-isolation.ps1",
      resolve(cwd, "scripts/probe-analysis-isolation.ps1"),
    );
    const guard = resolve(cwd, "probe-mock.mjs");
    const response = {
      status: mode === "exit" ? 1 : 0,
      stdout:
        mode === "bad-json"
          ? "TEST_ONLY_BAD_OUTPUT"
          : JSON.stringify(fixture()),
      stderr: mode === "stderr" ? "TEST_ONLY_PRIVATE_ERROR" : "",
      error:
        mode === "timeout"
          ? { code: "ETIMEDOUT", message: "TEST_ONLY_PRIVATE_ERROR" }
          : null,
    };
    writeFileSync(
      guard,
      `import assert from 'node:assert/strict';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
child.spawnSync = (exe,args,opts) => {
 assert.ok(exe.endsWith('powershell.exe'));
 assert.deepEqual(args.slice(0,4),['-NoLogo','-NoProfile','-NonInteractive','-File']);
 assert.equal(args.length,5); assert.ok(args[4].endsWith('probe-analysis-isolation.ps1'));
 assert.equal(opts.shell,false); assert.equal(opts.windowsHide,true); assert.equal(opts.timeout,20000); assert.equal(opts.maxBuffer,32768);
 assert.deepEqual(opts.stdio,['ignore','pipe','pipe']);
 assert.deepEqual(Object.keys(opts.env).sort(),['PATH','PSModulePath','SystemRoot','TEMP','TMP','WINDIR']);
 const r=${JSON.stringify(response)};
 return {...r,stdout:Buffer.from(r.stdout),stderr:Buffer.from(r.stderr)};
};
syncBuiltinESMExports();`,
      { flag: "wx" },
    );
    const entry = fileURLToPath(
      new URL("../src/server/analysis-isolation-cli.js", import.meta.url),
    );
    const r = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(guard).href, entry],
      { cwd, windowsHide: true, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(r.status, mode === "success" ? 2 : 1);
    assert.equal(r.stderr, "");
    const info = JSON.parse(r.stdout),
      body = readFileSync(info.reportPath, "utf8"),
      report = JSON.parse(body);
    assert.equal(info.status, "BLOCKED");
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.realCodexEnabled, false);
    assert.equal(report.osIsolationVerified, false);
    assert.equal(body.includes("TEST_ONLY_PRIVATE_ERROR"), false);
    assert.equal(body.includes("TEST_ONLY_BAD_OUTPUT"), false);
    if (mode === "success") assert.equal(report.host.os.editionId, "Core");
    else
      assert.equal(
        report.error,
        mode === "bad-json"
          ? "PROBE_OUTPUT_REJECTED"
          : "PROBE_EXECUTION_UNAVAILABLE",
      );
  });
}
