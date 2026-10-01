import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm run verify로 실행하세요.");
mkdirSync("work/phase1-verification", { recursive: true });
const results = [];
for (const name of [
  "verify:originals",
  "typecheck",
  "lint",
  "format:check",
  "test",
  "build",
  "test:e2e",
]) {
  const start = performance.now();
  console.log(`검사 시작: npm run ${name}`);
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [npmCli, "run", name], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => {
      stdout += String(b);
    });
    child.stderr.on("data", (b) => {
      stderr += String(b);
    });
    child.on("error", (error) =>
      resolve({ exitCode: 1, stdout, stderr: stderr + error.message }),
    );
    child.on("exit", (code) => resolve({ exitCode: code, stdout, stderr }));
  });
  const safe = name.replaceAll(":", "-");
  writeFileSync(
    `work/phase1-verification/${safe}.log`,
    result.stdout + "\n" + result.stderr,
  );
  const row = {
    command: `npm run ${name}`,
    exitCode: result.exitCode,
    durationMs: Math.round(performance.now() - start),
    log: `work/phase1-verification/${safe}.log`,
  };
  results.push(row);
  console.log(
    `검사 종료: ${name} / exit ${row.exitCode} / ${row.durationMs}ms`,
  );
}
const baselinePath = existsSync("work/phase1-original-hashes.json")
  ? "work/phase1-original-hashes.json"
  : "profiles/public-original-hashes.json";
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const originals = baseline.map((f) => ({
  path: f.path,
  unchanged:
    createHash("sha256")
      .update(readFileSync(f.path))
      .digest("hex")
      .toUpperCase() === f.sha256,
}));
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  scope: "LOCAL_SYNTHETIC_PAPER_ONLY",
  profitabilityValidated: false,
  liveEnabled: false,
  originalsBaseline: baselinePath,
  results,
  originals,
};
writeFileSync(
  "work/phase1-verification/report.json",
  JSON.stringify(report, null, 2) + "\n",
);
process.exitCode =
  results.every((r) => r.exitCode === 0) && originals.every((r) => r.unchanged)
    ? 0
    : 1;
