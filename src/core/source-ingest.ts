import { hash, policyHash, spec } from "./policy.js";
import {
  IngestError,
  MAX_INGEST_ROWS,
  parseSourceInput,
  utc,
} from "./source-ingest-schema.js";
import {
  normalizeSourceCapture,
  reconcileSourceObservations,
} from "./source-ingest-normalize.js";
import { runMockPagePlan } from "./source-ingest-pages.js";

export function ingestMockSource(raw: unknown) {
  const input = parseSourceInput(raw);
  const allInputs = [
    ...input.captures,
    ...input.pagePlans.flatMap((p) => p.replies),
  ];
  let totalRows = 0;
  for (const capture of allInputs) {
    const response = capture.response as { result?: unknown } | null;
    const result =
      response && typeof response === "object" ? response.result : null;
    totalRows += Array.isArray(result)
      ? result.length
      : result &&
          typeof result === "object" &&
          "candles" in result &&
          Array.isArray(result.candles)
        ? result.candles.length
        : 1;
  }
  if (totalRows > MAX_INGEST_ROWS) throw new IngestError("INGEST_ROW_LIMIT");
  const captures = input.captures.map((c) =>
    normalizeSourceCapture(c, input.asOf),
  );
  reconcileSourceObservations(captures, input.asOf);
  const pagePlans = input.pagePlans.map((p) => runMockPagePlan(p, input.asOf));
  // 서로 다른 입력/계획 사이의 상충도 보존·차단한다. 계획의 로컬 커버리지는 전역 승인이 아니다.
  const allCaptures = [...captures, ...pagePlans.flatMap((p) => p.captures)];
  reconcileSourceObservations(allCaptures, input.asOf);
  for (const page of pagePlans)
    if (page.captures.some((c) => c.status === "BLOCKED")) {
      page.status = "INCOMPLETE";
      page.reasons = [
        ...new Set([...page.reasons, "GLOBAL_OBSERVATION_BLOCKED"]),
      ].sort();
    }
  const rows = allCaptures.flatMap((c) => c.observations);
  const report = {
    schemaVersion: "OFFLINE_SOURCE_INGEST_REPORT_V1",
    purpose: input.purpose,
    dataOrigin: input.dataOrigin,
    source: input.source,
    sourceSpecVersion: input.sourceSpecVersion,
    asOf: utc(input.asOf),
    stage: "SOURCE_FORMAT_REHEARSAL_ONLY",
    status:
      allCaptures.some((c) => c.status === "BLOCKED") ||
      pagePlans.some((p) => p.status === "INCOMPLETE")
        ? "HAS_BLOCKS"
        : "MOCK_TRANSFORM_COMPLETE",
    inputHash: hash(raw),
    policyHash,
    strategyHash: hash(spec),
    sourceAuthentication: "UNVERIFIED_MOCK",
    historicalPointInTimeVerified: false,
    corporateActionsVerified: false,
    realDataReady: false,
    strategyReady: false,
    strategyEvaluated: false,
    paperOrdersEnabled: false,
    liveEnabled: false,
    networkRequests: 0,
    counts: {
      captures: allCaptures.length,
      observations: rows.length,
      blocked: rows.filter((r) => r.status === "BLOCKED").length,
      duplicates: rows.filter((r) => r.duplicateOf !== null).length,
      pagePlans: pagePlans.length,
    },
    captures,
    pagePlans,
    limitations: [
      "MOCK_NOT_REAL_SOURCE",
      "NO_TRADE_OR_STRATEGY_APPROVAL",
      "NO_HISTORICAL_AVAILABILITY_PROOF",
      "SOURCE_REVISION_UNKNOWN",
      "CORPORATE_ACTIONS_UNKNOWN",
      "REQUEST_IDENTITY_NOT_BROKER_ATTESTED",
      "NO_PRICE_FRESHNESS_OR_BENCHMARK_PROFILE",
      "CALENDAR_NOT_STRATEGY_SESSION_APPROVAL",
    ],
  };
  return { ...report, reportHash: hash(report) };
}
export type IngestReport = ReturnType<typeof ingestMockSource>;
