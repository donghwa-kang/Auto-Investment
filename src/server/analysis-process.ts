import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analysisExecutionSchema,
  type AnalysisExecution,
} from "../core/analysis-execution-schema.js";
import {
  analysisRequestSchema,
  type AnalysisRequest,
} from "../core/codex-analysis-schema.js";
import { hash } from "../core/policy.js";
import { AnalysisJsonLines, AnalysisRpcSession } from "./analysis-rpc.js";

const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const defaultWorker = fileURLToPath(
  new URL("./analysis-process-worker.js", import.meta.url),
);
function local(path: string) {
  const full = resolve(path);
  if (full.startsWith("\\\\")) throw new Error("ANALYSIS_EXECUTION_PATH");
  for (let p = full; p !== parse(p).root; p = dirname(p))
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw new Error("ANALYSIS_EXECUTION_PATH");
  return full;
}
function readWorker(path: string) {
  const p = local(path),
    s = lstatSync(p);
  if (!s.isFile() || s.nlink !== 1 || s.size > 64 * 1024)
    throw new Error("ANALYSIS_EXECUTION_ARTIFACT");
  return readFileSync(p);
}
export function restrictedProcessOptions(cwd: string) {
  if (process.platform !== "win32" || process.versions.node !== "24.20.0")
    throw new Error("ANALYSIS_EXECUTION_UNSUPPORTED");
  const env: Record<string, string> = { TEMP: cwd, TMP: cwd };
  for (const [k, v] of Object.entries(process.env))
    if (["SYSTEMROOT", "WINDIR"].includes(k.toUpperCase()) && v) env[k] = v;
  return {
    cwd,
    env,
    shell: false as const,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
  };
}
export const restrictedNodeArgs = (entry: string) => [
  "--permission",
  "--disable-proto=throw",
  "--disallow-code-generation-from-strings",
  "--max-old-space-size=64",
  entry,
];
export interface AnalysisProcessRunner {
  binding: AnalysisExecution;
  execute(q: AnalysisRequest, signal: AbortSignal): Promise<string>;
  idle(): Promise<void>;
}
export class RestrictedAnalysisProcess implements AnalysisProcessRunner {
  readonly binding: AnalysisExecution;
  private work = new Set<Promise<string>>();
  // workerPath는 시험/서버 코드 주입점일 뿐 HTTP·환경변수에서 바꿀 수 없다.
  constructor(
    readonly root: string,
    private workerPath = defaultWorker,
  ) {
    restrictedProcessOptions(local(root));
    this.binding = analysisExecutionSchema.parse({
      kind: "RESTRICTED_NODE_MOCK_STDIO_V1",
      protocol: "APP_SERVER_DOCUMENTED_SUBSET_20260914",
      workerSha256: sha(readWorker(workerPath)),
      nodeVersion: process.versions.node,
      trustBoundary: "TRUSTED_MOCK_NOT_OS_SANDBOX",
      realCodexEnabled: false,
    });
  }
  execute(raw: AnalysisRequest, signal: AbortSignal): Promise<string> {
    const q = analysisRequestSchema.parse(raw);
    if (signal.aborted)
      return Promise.reject(new Error("ANALYSIS_EXECUTION_CANCELLED"));
    if (this.work.size) throw new Error("ANALYSIS_EXECUTION_BUSY");
    if (hash(q.execution ?? null) !== hash(this.binding))
      throw new Error("ANALYSIS_EXECUTION_BINDING");
    const bytes = readWorker(this.workerPath);
    if (sha(bytes) !== this.binding.workerSha256)
      throw new Error("ANALYSIS_EXECUTION_ARTIFACT_CHANGED");
    const root = local(this.root);
    mkdirSync(root, { recursive: true });
    if (readdirSync(root).length >= 100)
      throw new Error("ANALYSIS_EXECUTION_LIMIT");
    const cwd = resolve(root, q.id);
    mkdirSync(cwd); // 기존 실행은 재사용/덮어쓰기/재실행하지 않는다.
    const entry = resolve(cwd, "worker.mjs");
    writeFileSync(entry, bytes, { flag: "wx", mode: 0o600 });
    const receiptPath = resolve(cwd, "receipt.json");
    const receipt = {
      version: "RESTRICTED_MOCK_RECEIPT_V1",
      requestHash: hash(q),
      binding: this.binding,
      parentPid: process.pid,
      childPid: null as number | null,
      outcome: "STARTING",
      exitCode: null as number | null,
      signal: null as string | null,
      frames: 0,
      transcriptHash: "",
      outputHash: null as string | null,
    };
    writeFileSync(receiptPath, JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
    const task = new Promise<string>((resolveResult, reject) => {
      const transcript = createHash("sha256");
      const child = spawn(
        process.execPath,
        restrictedNodeArgs(entry),
        restrictedProcessOptions(cwd),
      );
      receipt.childPid = child.pid ?? null;
      let failure: string | null = null,
        output: string | null = null,
        stderrBytes = 0,
        done = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const record = (direction: string, message: unknown) => {
        receipt.frames++;
        transcript.update(hash([direction, message]));
      };
      const send = (message: unknown) => {
        if (done || child.stdin.destroyed)
          throw new Error("ANALYSIS_RPC_CLOSED");
        record("out", message);
        child.stdin.write(JSON.stringify(message) + "\n");
      };
      const session = new AnalysisRpcSession(q, send);
      const stop = (reason: string, interrupt = false) => {
        if (done || failure) return;
        failure = reason;
        if (interrupt) {
          try {
            session.interrupt();
          } catch {
            /* 중단 실패 시 아래 강제 종료 */
          }
        }
        if (!interrupt) child.kill();
        killTimer = setTimeout(() => {
          if (!done) child.kill();
        }, 100);
      };
      const decoder = new AnalysisJsonLines((message) => {
        record("in", message);
        session.receive(message);
      });
      const abort = () => stop("ANALYSIS_EXECUTION_CANCELLED", true);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(
        () => stop("ANALYSIS_EXECUTION_TIMEOUT", true),
        q.budget.timeoutMs,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        try {
          decoder.push(chunk);
        } catch {
          stop("ANALYSIS_RPC_REJECTED");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 4096) stop("ANALYSIS_EXECUTION_STDERR_LIMIT");
      });
      child.stdin.on("error", () => stop("ANALYSIS_RPC_PIPE"));
      child.on("error", () => stop("ANALYSIS_EXECUTION_SPAWN"));
      child.on("close", (code, sig) => {
        done = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", abort);
        try {
          if (!failure) {
            if (code !== 0 || sig || stderrBytes)
              throw new Error("ANALYSIS_EXECUTION_EXIT");
            decoder.end();
            output = session.result();
          }
        } catch {
          failure = "ANALYSIS_EXECUTION_INCOMPLETE";
        }
        receipt.outcome = failure ?? "COMPLETE";
        receipt.exitCode = code;
        receipt.signal = sig;
        receipt.transcriptHash = transcript.digest("hex");
        receipt.outputHash = output === null ? null : hash(output);
        try {
          writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
        } catch {
          failure = "ANALYSIS_EXECUTION_RECEIPT_FAILED";
        }
        if (failure || output === null)
          reject(new Error(failure ?? "ANALYSIS_EXECUTION_INCOMPLETE"));
        else resolveResult(output);
      });
      try {
        writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
        if (!failure) session.start();
      } catch {
        stop("ANALYSIS_RPC_START");
      }
    });
    this.work.add(task);
    void task.then(
      () => this.work.delete(task),
      () => this.work.delete(task),
    );
    return task;
  }
  async idle() {
    await Promise.allSettled([...this.work]);
  }
}
