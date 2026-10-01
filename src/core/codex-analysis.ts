import { hash, policyHash, spec, theme } from "./policy.js";
import { verifyRecordBundle } from "./analysis-records.js";
import type { RecordBundle } from "./analysis-record-schema.js";
import {
  analysisExecutionSchema,
  type AnalysisExecution,
} from "./analysis-execution-schema.js";
import {
  analysisJobSchema,
  analysisRequestSchema,
  analysisResultSchema,
  type AnalysisRequest,
  type AnalysisJob,
  type AnalysisResult,
} from "./codex-analysis-schema.js";

export function makeAnalysisRequest(id: string, now: number): AnalysisRequest {
  const bundle = {
    version: "MOCK_ANALYSIS_BUNDLE_V1" as const,
    origin: "FIXED_SYNTHETIC_NOT_ENGINE_RECORDS" as const,
    purpose: "PAPER_REVIEW_ONLY" as const,
    symbol: "TEST_KR_A" as const,
    periodStart: "2026-09-10T00:00:00.000Z",
    asOf: "2026-09-10T01:00:00.000Z",
    // 거래 정책은 파일 바이트 해시, 나머지는 기존 canonical 객체 해시다.
    policies: {
      trading: policyHash.toLowerCase(),
      strategy: hash(spec),
      theme: hash(theme),
    },
    source: {
      id: "SYNTHETIC_REVIEW_FIXTURE_V1" as const,
      observedAt: "2026-09-10T01:00:00.000Z",
      metrics: { decisions: 4, approved: 1, closedTrades: 0 },
    },
  };
  return analysisRequestSchema.parse({
    version: "LOCAL_MOCK_REQUEST_V1",
    id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300000).toISOString(),
    adapter: "LOCAL_DETERMINISTIC_MOCK_V1",
    promptVersion: "MOCK_PAPER_REVIEW_V1",
    parserVersion: "MOCK_RESULT_VALIDATOR_V1",
    budget: { calls: 1, timeoutMs: 3000, retries: 0 },
    permissions: {
      network: false,
      files: false,
      tools: false,
      orders: false,
      policyWrite: false,
      modelPromotion: false,
    },
    bundle,
    bundleHash: hash(bundle),
  });
}
export function newAnalysisJob(
  id: string,
  now: number,
  bundle?: RecordBundle,
  execution?: AnalysisExecution,
): AnalysisJob {
  const request = makeAnalysisRequest(id, now);
  if (execution) request.execution = analysisExecutionSchema.parse(execution);
  if (bundle) {
    request.bundle = verifyRecordBundle(bundle);
    request.bundleHash = hash(request.bundle);
  }
  return {
    request,
    requestHash: hash(request),
    state: "AWAITING_APPROVAL",
    approvedHash: null,
    approvedAt: null,
    startedAt: null,
    finishedAt: null,
    calls: 0,
    rawOutput: null,
    result: null,
    resultHash: null,
    error: null,
  };
}
export function verifyAnalysisResult(
  raw: string,
  job: AnalysisJob,
  end: number,
): AnalysisResult {
  if (Buffer.byteLength(raw) > 16384) throw new Error("INVALID_RESULT");
  const r = analysisResultSchema.parse(JSON.parse(raw));
  const { request: q } = job;
  if (hash(r.execution ?? null) !== hash(q.execution ?? null))
    throw new Error("INVALID_RESULT");
  if (
    r.requestId !== q.id ||
    r.requestHash !== job.requestHash ||
    r.bundleHash !== q.bundleHash ||
    r.asOf !== q.bundle.asOf ||
    !job.startedAt ||
    Date.parse(r.generatedAt) < Date.parse(job.startedAt) ||
    Date.parse(r.generatedAt) > end ||
    end - Date.parse(job.startedAt) >= q.budget.timeoutMs ||
    new Set(r.facts.map((f) => f.metric)).size !== 3 ||
    new Set(r.suggestions).size !== r.suggestions.length
  )
    throw new Error("INVALID_RESULT");
  for (const f of r.facts) {
    if (
      f.sourceId !== q.bundle.source.id ||
      f.observedAt !== q.bundle.source.observedAt ||
      Date.parse(f.observedAt) > Date.parse(q.bundle.asOf) ||
      f.value !== q.bundle.source.metrics[f.metric]
    )
      throw new Error("INVALID_RESULT");
  }
  if (q.bundle.version === "ENGINE_RECORD_ANALYSIS_BUNDLE_V1") {
    if (
      r.version !== "LOCAL_MOCK_RECORD_RESULT_V1" ||
      hash(r.summary) !== hash(q.bundle.summary) ||
      hash(r.recordRefs) !== hash(q.bundle.records.map((r) => r.sourceRef))
    )
      throw new Error("INVALID_RESULT");
  } else if (r.version !== "LOCAL_MOCK_RESULT_V1")
    throw new Error("INVALID_RESULT");
  return r;
}
export function verifyAnalysisJob(raw: unknown): AnalysisJob {
  const j = analysisJobSchema.parse(raw),
    q = j.request;
  const expected = makeAnalysisRequest(q.id, Date.parse(q.createdAt));
  if (q.execution)
    expected.execution = analysisExecutionSchema.parse(q.execution);
  if (q.bundle.version === "ENGINE_RECORD_ANALYSIS_BUNDLE_V1") {
    expected.bundle = verifyRecordBundle(q.bundle);
    expected.bundleHash = hash(expected.bundle);
  }
  // 요청 외피는 동일하게 고정한다. 기록 원본 대조는 승인/실행 전에 별도 수행한다.
  if (hash(q) !== j.requestHash || hash(expected) !== j.requestHash)
    throw new Error("ANALYSIS_INTEGRITY");
  const approved = j.approvedHash !== null;
  if (
    approved !== (j.approvedAt !== null) ||
    (approved && j.approvedHash !== j.requestHash) ||
    (j.approvedAt &&
      (Date.parse(j.approvedAt) < Date.parse(q.createdAt) ||
        Date.parse(j.approvedAt) >= Date.parse(q.expiresAt)))
  )
    throw new Error("ANALYSIS_INTEGRITY");
  if (
    (j.calls === 1) !== (j.startedAt !== null) ||
    (j.startedAt &&
      (!approved ||
        Date.parse(j.startedAt) < Date.parse(j.approvedAt!) ||
        Date.parse(j.startedAt) >= Date.parse(q.expiresAt)))
  )
    throw new Error("ANALYSIS_INTEGRITY");
  const active = ["AWAITING_APPROVAL", "APPROVED", "RUNNING"].includes(j.state);
  if (
    active !== (j.finishedAt === null) ||
    (j.finishedAt &&
      Date.parse(j.finishedAt) <
        Date.parse(j.startedAt ?? j.approvedAt ?? q.createdAt))
  )
    throw new Error("ANALYSIS_INTEGRITY");
  if (
    (j.state === "AWAITING_APPROVAL" && approved) ||
    (j.state === "APPROVED" && (!approved || j.calls !== 0)) ||
    (j.state === "RUNNING" && j.calls !== 1)
  )
    throw new Error("ANALYSIS_INTEGRITY");
  if (
    ["REJECTED", "TIMED_OUT", "FAILED", "INTERRUPTED"].includes(j.state) &&
    j.calls !== 1
  )
    throw new Error("ANALYSIS_INTEGRITY");
  if (j.state === "EXPIRED" && j.calls !== 0)
    throw new Error("ANALYSIS_INTEGRITY");
  if (active && (j.error || j.rawOutput !== null))
    throw new Error("ANALYSIS_INTEGRITY");
  if (!active && j.state !== "VERIFIED_MOCK" && !j.error)
    throw new Error("ANALYSIS_INTEGRITY");
  if (j.rawOutput !== null && !["VERIFIED_MOCK", "REJECTED"].includes(j.state))
    throw new Error("ANALYSIS_INTEGRITY");
  if (j.state === "VERIFIED_MOCK") {
    if (
      j.calls !== 1 ||
      !j.rawOutput ||
      !j.result ||
      !j.finishedAt ||
      j.error ||
      hash(verifyAnalysisResult(j.rawOutput, j, Date.parse(j.finishedAt))) !==
        j.resultHash ||
      hash(j.result) !== j.resultHash
    )
      throw new Error("ANALYSIS_INTEGRITY");
  } else if (j.result !== null || j.resultHash !== null)
    throw new Error("ANALYSIS_INTEGRITY");
  return j;
}
