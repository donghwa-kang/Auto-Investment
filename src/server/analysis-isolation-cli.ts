import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  existsSync,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";
import {
  assessIsolationHost,
  parseIsolationProbe,
} from "../core/analysis-isolation.js";

function local(path: string) {
  const full = resolve(path);
  if (full.startsWith("\\\\")) throw new Error("LOCAL_PATH_REQUIRED");
  for (let p = full; p !== parse(p).root; p = dirname(p))
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw new Error("LOCAL_PATH_REQUIRED");
  return full;
}
// 허용된 단일 로컬 조회만 실행한다. 임의 경로/명령/출력 경로 인자를 받지 않는다.
function inspect() {
  if (process.argv.length !== 2 || process.platform !== "win32")
    throw new Error("ISOLATION_PROBE_ARGUMENT_OR_PLATFORM");
  const script = local("scripts/probe-analysis-isolation.ps1");
  const stat = lstatSync(script);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384)
    throw new Error("ISOLATION_PROBE_SCRIPT");
  const scriptHash = createHash("sha256")
    .update(readFileSync(script))
    .digest("hex");
  const base = local("work/analysis-isolation-reports");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(resolve(base, "probe-"));
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot))
    throw new Error("ISOLATION_SYSTEM_ROOT");
  const executable = local(
    resolve(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
  );
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script];
  // PATH는 명령 존재 조회에만 필요하다. 실제 Codex/WSL을 실행하지 않는다.
  const env = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    TEMP: root,
    TMP: root,
    PATH: process.env.PATH ?? process.env.Path ?? "",
    PSModulePath: resolve(
      systemRoot,
      "System32/WindowsPowerShell/v1.0/Modules",
    ),
  };
  const probe = spawnSync(executable, args, {
    cwd: root,
    env,
    shell: false,
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 32768,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let report: unknown;
  let exitCode = 2;
  if (probe.error || probe.status !== 0 || probe.stderr.length !== 0) {
    report = {
      version: "ANALYSIS_ISOLATION_PROBE_FAILURE_V1",
      status: "BLOCKED",
      realCodexEnabled: false,
      osIsolationVerified: false,
      error: "PROBE_EXECUTION_UNAVAILABLE",
      scriptHash,
    };
    exitCode = 1;
  } else {
    try {
      report = {
        ...assessIsolationHost(parseIsolationProbe(probe.stdout)),
        scriptHash,
        nodeVersion: process.versions.node,
      };
    } catch {
      report = {
        version: "ANALYSIS_ISOLATION_PROBE_FAILURE_V1",
        status: "BLOCKED",
        realCodexEnabled: false,
        osIsolationVerified: false,
        error: "PROBE_OUTPUT_REJECTED",
        scriptHash,
      };
      exitCode = 1;
    }
  }
  const path = resolve(root, "report.json");
  writeFileSync(path, JSON.stringify(report, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: "BLOCKED",
      reportPath: path,
      exitCode,
      realCodexEnabled: false,
    }),
  );
  process.exitCode = exitCode;
}
try {
  inspect();
} catch {
  console.error("ISOLATION_PREPARATION_FAILED");
  process.exitCode = 1;
}
