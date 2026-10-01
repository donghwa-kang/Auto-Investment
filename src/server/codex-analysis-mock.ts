import type {
  AnalysisRequest,
  AnalysisResult,
} from "../core/codex-analysis-schema.js";
import { hash } from "../core/policy.js";

// 실제 SDK/계정/환경변수/파일/네트워크/명령 실행 기능이 없는 결정적 모형.
// 주입점은 자동 시험 전용이며 HTTP에서 어댑터나 코드를 선택할 수 없다.
export type AnalysisMock = (
  request: AnalysisRequest,
  signal: AbortSignal,
) => Promise<string>;
export function mockResult(
  request: AnalysisRequest,
  now = Date.now(),
): AnalysisResult {
  const result = {
    version: "LOCAL_MOCK_RESULT_V1",
    requestId: request.id,
    requestHash: hash(request),
    bundleHash: request.bundleHash,
    adapter: "LOCAL_DETERMINISTIC_MOCK_V1",
    ...(request.execution
      ? { execution: structuredClone(request.execution) }
      : {}),
    generatedAt: new Date(now).toISOString(),
    asOf: request.bundle.asOf,
    advisoryOnly: true,
    mock: true,
    facts: (["decisions", "approved", "closedTrades"] as const).map(
      (metric) => ({
        sourceId: request.bundle.source.id,
        observedAt: request.bundle.source.observedAt,
        metric,
        value: request.bundle.source.metrics[metric],
      }),
    ),
    suggestions: [
      "COLLECT_MORE_SYNTHETIC_RECORDS",
      "KEEP_TRADING_GATES_UNCHANGED",
    ],
    usage: {
      mockCalls: 1,
      externalCalls: 0,
      tokens: 0,
      additionalCashCostKrw: 0,
    },
  } satisfies AnalysisResult;
  if (request.bundle.version === "ENGINE_RECORD_ANALYSIS_BUNDLE_V1")
    return {
      ...result,
      version: "LOCAL_MOCK_RECORD_RESULT_V1",
      summary: structuredClone(request.bundle.summary),
      recordRefs: request.bundle.records.map((r) => r.sourceRef),
    };
  return result;
}
export const localAnalysisMock: AnalysisMock = async (request, signal) => {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("ABORTED"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("ABORTED"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 250);
    signal.addEventListener("abort", abort, { once: true });
  });
  return JSON.stringify(mockResult(request));
};
