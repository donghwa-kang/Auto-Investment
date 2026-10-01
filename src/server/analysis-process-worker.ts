// 고정된 자체 모형 전용 standalone entry. 타입 외 프로젝트/의존성 파일을 로드하지 않는다.
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import type {
  AnalysisRequest,
  AnalysisResult,
} from "../core/codex-analysis-schema.js";

function fail(): never {
  throw new Error("MOCK_RESTRICTION_FAILED");
}
function denied(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ERR_ACCESS_DENIED")
      return;
  }
  fail();
}
if (
  process.versions.node !== "24.20.0" ||
  process.platform !== "win32" ||
  !process.permission
)
  fail();
for (const scope of [
  "fs.write",
  "child",
  "worker",
  "addons",
  "wasi",
  "inspector",
] as const)
  if (process.permission.has(scope)) fail();
// 이 Windows 실행 환경이 추가하는 기본 계정/경로 변수도 모형 처리 전에 제거한다.
const windowsInjected = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
];
for (const key of Object.keys(process.env)) {
  if (windowsInjected.includes(key.toUpperCase())) delete process.env[key];
  else if (!["SYSTEMROOT", "WINDIR", "TEMP", "TMP"].includes(key.toUpperCase()))
    fail();
}
const getBuiltin = process.getBuiltinModule.bind(process);
const fs = getBuiltin("node:fs") as typeof import("node:fs");
const child = getBuiltin(
  "node:child_process",
) as typeof import("node:child_process");
const worker = getBuiltin(
  "node:worker_threads",
) as typeof import("node:worker_threads");
// 존재하지 않는 경로도 파일 접근보다 권한 검사가 먼저 실패해야 한다. 더미 이름만 사용한다.
denied(() => fs.readFileSync("../TEST_SECRET.json"));
denied(() => fs.writeFileSync("TEST_WRITE_DENIED.txt", "TEST_ONLY"));
denied(() => child.spawn(process.execPath, ["--version"]));
denied(() => new worker.Worker("", { eval: true }));
registerHooks({
  resolve() {
    throw new Error("MOCK_MODULE_DENIED");
  },
});
Object.defineProperty(process, "getBuiltinModule", {
  value: () => {
    throw new Error("MOCK_MODULE_DENIED");
  },
  writable: false,
  configurable: false,
});
for (const key of ["fetch", "WebSocket"])
  Object.defineProperty(globalThis, key, {
    value: () => {
      throw new Error("MOCK_NETWORK_DENIED");
    },
    writable: false,
    configurable: false,
  });
for (const name of [
  "node:net",
  "node:http",
  "node:https",
  "node:http2",
  "node:tls",
  "node:dgram",
  "node:dns",
  "node:sqlite",
]) {
  let rejected = false;
  try {
    await import(name);
  } catch (e) {
    rejected = e instanceof Error && e.message === "MOCK_MODULE_DENIED";
  }
  if (!rejected) fail();
}
try {
  await fetch("http://127.0.0.1:1");
  fail();
} catch (e) {
  if (!(e instanceof Error) || e.message !== "MOCK_NETWORK_DENIED") fail();
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  if (v === undefined) fail();
  return JSON.stringify(v);
}
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const emit = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
const thread = { id: "mock_thread" };
const turn = (status: string) => ({
  id: "mock_turn",
  status,
  items: [],
  error: null,
});
function expected(actual: unknown, wanted: unknown) {
  if (hash(actual) !== hash(wanted)) fail();
}
function result(q: AnalysisRequest): AnalysisResult {
  const r = {
    version: "LOCAL_MOCK_RESULT_V1" as const,
    requestId: q.id,
    requestHash: hash(q),
    bundleHash: q.bundleHash,
    adapter: "LOCAL_DETERMINISTIC_MOCK_V1" as const,
    execution: q.execution,
    generatedAt: new Date().toISOString(),
    asOf: q.bundle.asOf,
    advisoryOnly: true as const,
    mock: true as const,
    facts: (["decisions", "approved", "closedTrades"] as const).map(
      (metric) => ({
        sourceId: q.bundle.source.id,
        observedAt: q.bundle.source.observedAt,
        metric,
        value: q.bundle.source.metrics[metric],
      }),
    ),
    suggestions: [
      "COLLECT_MORE_SYNTHETIC_RECORDS",
      "KEEP_TRADING_GATES_UNCHANGED",
    ] as AnalysisResult["suggestions"],
    usage: {
      mockCalls: 1 as const,
      externalCalls: 0 as const,
      tokens: 0 as const,
      additionalCashCostKrw: 0 as const,
    },
  };
  return q.bundle.version === "ENGINE_RECORD_ANALYSIS_BUNDLE_V1"
    ? {
        ...r,
        version: "LOCAL_MOCK_RECORD_RESULT_V1",
        summary: q.bundle.summary,
        recordRefs: q.bundle.records.map((r) => r.sourceRef),
      }
    : r;
}
let step = 0,
  total = 0,
  input = Buffer.alloc(0),
  timer: ReturnType<typeof setTimeout> | undefined,
  done = false;
const lifetime = setTimeout(() => process.exit(74), 3500);
function finish(status: "completed" | "interrupted", q?: AnalysisRequest) {
  if (done) fail();
  done = true;
  clearTimeout(timer);
  clearTimeout(lifetime);
  if (q)
    emit({
      method: "item/completed",
      params: {
        threadId: thread.id,
        turnId: "mock_turn",
        item: {
          id: "mock_item",
          type: "agentMessage",
          text: JSON.stringify(result(q)),
          phase: "final_answer",
        },
      },
    });
  emit({
    method: "turn/completed",
    params: { threadId: thread.id, turn: turn(status) },
  });
  process.stdin.pause();
  process.stdout.end(() => process.exit(0));
}
function receive(raw: unknown) {
  if (done || !raw || typeof raw !== "object") fail();
  if (step === 0) {
    expected(raw, {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "paper_lab_mock_client",
          title: "Offline paper review",
          version: "1.0.0",
        },
        capabilities: { experimentalApi: false },
      },
    });
    emit({
      id: 1,
      result: {
        userAgent: "paper-lab-restricted-mock/1",
        platformFamily: "windows",
        platformOs: "win32",
      },
    });
  } else if (step === 1) expected(raw, { method: "initialized" });
  else if (step === 2) {
    expected(raw, {
      id: 2,
      method: "thread/start",
      params: { approvalPolicy: "never", sandbox: "read-only" },
    });
    emit({ id: 2, result: { thread } });
    emit({ method: "thread/started", params: { thread } });
  } else if (step === 3) {
    const r = raw as { params?: { input?: { text?: string }[] } },
      text = r.params?.input?.[0]?.text;
    if (typeof text !== "string" || Buffer.byteLength(text) > 140 * 1024)
      fail();
    expected(raw, {
      id: 3,
      method: "turn/start",
      params: {
        threadId: "mock_thread",
        input: [{ type: "text", text }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      },
    });
    const q = JSON.parse(text) as AnalysisRequest;
    if (
      q.execution?.kind !== "RESTRICTED_NODE_MOCK_STDIO_V1" ||
      q.bundleHash !== hash(q.bundle)
    )
      fail();
    emit({ id: 3, result: { turn: turn("inProgress") } });
    emit({
      method: "turn/started",
      params: { threadId: thread.id, turn: turn("inProgress") },
    });
    timer = setTimeout(() => {
      try {
        finish("completed", q);
      } catch {
        process.exit(75);
      }
    }, 250);
  } else if (step === 4) {
    expected(raw, {
      id: 4,
      method: "turn/interrupt",
      params: { threadId: thread.id, turnId: "mock_turn" },
    });
    emit({ id: 4, result: {} });
    finish("interrupted");
  } else fail();
  step++;
}
process.stdin.on("data", (chunk: Buffer) => {
  try {
    total += chunk.length;
    if (total > 160 * 1024) fail();
    input = Buffer.concat([input, chunk]);
    let at: number;
    while ((at = input.indexOf(10)) !== -1) {
      const line = input.subarray(0, at);
      input = input.subarray(at + 1);
      if (!line.length) fail();
      receive(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)),
      );
    }
  } catch {
    process.exit(75);
  }
});
process.stdin.on("end", () => {
  if (!done) process.exit(76);
});
process.stdin.on("error", () => process.exit(76));
process.stdout.on("error", () => process.exit(76));
