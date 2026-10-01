import { z } from "zod";
import { d, median, percentile } from "./math.js";
import { hash } from "./policy.js";
import { qualityIdentitySchema } from "./market-quality-schema.js";
import {
  catalogIdentifierSchema as id,
  catalogTimestampSchema as time,
} from "./catalog-schema.js";
import {
  parseSourceInput,
  sourceIngestSchema,
  bookRow,
  singleEnvelope,
} from "./source-ingest-schema.js";
import {
  normalizeSourceCapture,
  reconcileSourceObservations,
} from "./source-ingest-normalize.js";

const price = z
  .string()
  .max(32)
  .regex(/^\d{1,18}(\.\d{1,12})?$/)
  .refine((v) => d(v).gt(0));
// 자원/산술 범위다. 투자 수량 한도나 실제 종목의 호가 단위가 아니다.
const quantity = z.number().int().min(1).max(1_000_000_000);
export const executionEvidenceSchema = z.strictObject({
  schemaVersion: z.literal("OFFLINE_EXECUTION_EVIDENCE_V1"),
  purpose: z.literal("TEST_ONLY"),
  target: qualityIdentitySchema.refine(
    (t) => (t.market === "KR") === (t.currency === "KRW"),
  ),
  illustrativeQuantity: quantity,
  tickSpec: z
    .strictObject({
      evidenceId: id,
      availableAt: time,
      effectiveFrom: time,
      effectiveUntil: time,
      priceFrom: price,
      priceUntil: price,
      tickSize: price,
      lotSize: quantity,
    })
    .refine(
      (s) =>
        Date.parse(s.effectiveFrom) < Date.parse(s.effectiveUntil) &&
        d(s.priceFrom).lt(s.priceUntil),
    )
    .nullable(),
  sourceInput: sourceIngestSchema,
});
export type ExecutionEvidenceInput = z.infer<typeof executionEvidenceSchema>;

function statistics(values: string[]) {
  if (!values.length) return null;
  const sorted = values.map(d).sort((a, b) => a.cmp(b));
  return {
    count: sorted.length,
    min: sorted[0]!.toString(),
    median: median(sorted).toString(),
    p95: percentile(sorted, "0.95").toString(),
    max: sorted.at(-1)!.toString(),
  };
}

export function reviewMockExecutionEvidence(raw: unknown) {
  let input: ExecutionEvidenceInput;
  try {
    input = executionEvidenceSchema.parse(raw);
    // 기존 크기·비밀 필드·MOCK 계약 제한을 그대로 재사용한다.
    input.sourceInput = parseSourceInput(input.sourceInput);
    if (input.sourceInput.pagePlans.length) throw new Error();
  } catch {
    throw new Error("EXECUTION_EVIDENCE_INPUT_INVALID");
  }
  const asOf = Date.parse(input.sourceInput.asOf);
  const selected = input.sourceInput.captures.filter(
    (c) => c.request.kind === "ORDERBOOK",
  );
  const future = selected.filter((c) => Date.parse(c.availableAt) > asOf);
  const known = selected.filter((c) => Date.parse(c.availableAt) <= asOf);
  // 과거 수신의 품질은 당시 가용시각에서 검사한다. 최종 보고 시점으로
  // 과거 관측을 일괄 stale 처리하거나 수신시각을 소급하지 않는다.
  const normalized = known.map((c) => normalizeSourceCapture(c, c.availableAt));
  reconcileSourceObservations(normalized, input.sourceInput.asOf);
  const rows = known.map((capture, i) => {
    const result = normalized[i]!;
    const observation = result.observations[0];
    const reasons = [
      ...result.reasons,
      ...result.observations.flatMap((o) => o.reasons),
    ];
    const request = capture.request;
    if (request.kind !== "ORDERBOOK") throw new Error("EVIDENCE_INTERNAL_KIND");
    if (
      request.target.symbol !== input.target.symbol ||
      request.target.market !== input.target.market ||
      request.target.currency !== input.target.currency
    )
      reasons.push("TARGET_MISMATCH");
    const requestIntervalMs =
      Date.parse(capture.receivedAt) - Date.parse(capture.requestedAt);
    const duplicateOf = observation?.duplicateOf ?? null;
    let quote: {
      bid: string;
      ask: string;
      spreadBps: string;
      providerReportedAgeMs: number;
    } | null = null;
    let tick: {
      oneTickPerShare: string;
      oneTickForQuantity: string;
      entryNotional: string;
      oneTickBps: string;
      roundTripOneTickPerSideBps: string;
    } | null = null;
    const tickReasons: string[] = [];
    if (!reasons.length && observation && !duplicateOf) {
      // 임의 재해석 없이 기존 변환기가 검사한 최우선 호가를 타입 검사한다.
      const best = z.strictObject({ bid: price, ask: price }).parse({
        bid: observation.data?.bestBid,
        ask: observation.data?.bestAsk,
      });
      const bid = d(best.bid),
        ask = d(best.ask);
      quote = {
        bid: bid.toString(),
        ask: ask.toString(),
        spreadBps: ask
          .minus(bid)
          .div(ask.plus(bid).div(2))
          .mul(10000)
          .toString(),
        providerReportedAgeMs:
          Date.parse(capture.receivedAt) - Date.parse(observation.eventAt!),
      };
      const spec = input.tickSpec;
      if (!spec) tickReasons.push("TICK_SPEC_UNKNOWN");
      else {
        const eventAt = Date.parse(observation.eventAt!);
        if (Date.parse(spec.availableAt) > Date.parse(capture.availableAt))
          tickReasons.push("TICK_SPEC_NOT_YET_AVAILABLE");
        if (
          eventAt < Date.parse(spec.effectiveFrom) ||
          eventAt >= Date.parse(spec.effectiveUntil)
        )
          tickReasons.push("TICK_SPEC_NOT_EFFECTIVE");
        if (
          [bid, ask].some((p) => p.lt(spec.priceFrom) || p.gte(spec.priceUntil))
        )
          tickReasons.push("TICK_PRICE_BAND_MISMATCH");
        if ([bid, ask].some((p) => !p.mod(spec.tickSize).isZero()))
          tickReasons.push("OFF_TICK_PRICE");
        if (input.illustrativeQuantity % spec.lotSize !== 0)
          tickReasons.push("OFF_LOT_QUANTITY");
        // 잔량은 실제 체결/우선순위를 보장하지 않는다. 양쪽 잔량 부족은 별도로 남긴다.
        const book = bookRow.parse(
          singleEnvelope.parse(capture.response).result,
        );
        for (const [side, levels, bestPrice] of [
          ["ASK", book.asks, ask],
          ["BID", book.bids, bid],
        ] as const) {
          const matching = levels.filter((l) => d(l.price).eq(bestPrice));
          if (matching.length !== 1)
            tickReasons.push(`${side}_LEVEL_AMBIGUOUS`);
          else if (d(matching[0]!.volume).lt(input.illustrativeQuantity))
            tickReasons.push(`${side}_DISPLAYED_DEPTH_INSUFFICIENT`);
        }
        if (!tickReasons.length) {
          const value = d(spec.tickSize),
            q = d(input.illustrativeQuantity);
          const bps = value.div(ask).mul(10000);
          tick = {
            oneTickPerShare: value.toString(),
            oneTickForQuantity: value.mul(q).toString(),
            entryNotional: ask.mul(q).toString(),
            oneTickBps: bps.toString(),
            roundTripOneTickPerSideBps: bps.mul(2).toString(),
          };
        }
      }
    }
    return {
      captureId: capture.captureId,
      status: reasons.length
        ? "BLOCKED"
        : duplicateOf
          ? "DUPLICATE"
          : "MOCK_OBSERVATION",
      reasons: [...new Set(reasons)].sort(),
      duplicateOf,
      outcome: capture.outcome,
      requestIntervalMs,
      availableAt: capture.availableAt,
      quote,
      tick,
      tickReasons,
    };
  });
  const quotes = rows.flatMap((r) => (r.quote ? [r.quote] : []));
  const report = {
    schemaVersion: "OFFLINE_EXECUTION_EVIDENCE_REPORT_V1",
    purpose: "TEST_ONLY",
    inputHash: hash(raw),
    sourceSpecVersion: input.sourceInput.sourceSpecVersion,
    target: input.target,
    asOf: input.sourceInput.asOf,
    status:
      !quotes.length ||
      rows.some((r) => r.status === "BLOCKED" || r.tickReasons.length)
        ? "HAS_BLOCKS"
        : "MOCK_DIAGNOSTIC_COMPLETE",
    counts: {
      requestedBooks: selected.length,
      futureUnavailable: future.length,
      ignoredNonBookCaptures:
        input.sourceInput.captures.length - selected.length,
      quoteObservations: quotes.length,
      blocked: rows.filter((r) => r.status === "BLOCKED").length,
      duplicates: rows.filter((r) => r.status === "DUPLICATE").length,
      timeouts: rows.filter((r) => r.outcome === "TIMEOUT").length,
    },
    distributionMethod: "MEDIAN_AVERAGE_EVEN_P95_NEAREST_RANK_NO_INTERPOLATION",
    spreadBps: statistics(quotes.map((q) => q.spreadBps)),
    // 실패/timeout을 버려 성공 요청만의 지연을 전체 주문 지연으로 위장하지 않는다.
    responseIntervalMs: statistics(
      rows
        .filter((r) => r.outcome === "RESPONSE")
        .map((r) => String(r.requestIntervalMs)),
    ),
    timeoutIntervalMs: statistics(
      rows
        .filter((r) => r.outcome === "TIMEOUT")
        .map((r) => String(r.requestIntervalMs)),
    ),
    providerReportedAgeMs: statistics(
      quotes.map((q) => String(q.providerReportedAgeMs)),
    ),
    rows,
    collectionAuthorized: false,
    realCalibrationReady: false,
    engineProfileApplied: false,
    learningEligible: false,
    liveEnabled: false,
    feeEstimate: null,
    orderLatencyEstimate: null,
    cancellationLatencyEstimate: null,
    limitations: [
      "MOCK_ONLY_NOT_REAL_OBSERVATIONS",
      "SOURCE_IDENTITY_NOT_ATTESTED",
      "G1_RIGHTS_COST_AND_USER_APPROVAL_NOT_VERIFIED",
      "G2_REAL_DATA_ACCEPTANCE_NOT_RUN",
      "SOURCE_TIMESTAMP_SEMANTICS_AND_CLOCK_SYNC_UNKNOWN",
      "REQUEST_INTERVAL_IS_NOT_ORDER_LATENCY",
      "SNAPSHOT_DISTRIBUTIONS_NOT_TIME_WEIGHTED_OR_IID",
      "NO_QUEUE_IMPACT_OR_FILL_PROBABILITY",
      "TICK_COST_IS_DIAGNOSTIC_NOT_EXTRA_LEDGER_CHARGE",
      "FEES_TAXES_FX_AND_OPERATING_COSTS_UNKNOWN",
      "NO_STRESS_PROFILE_PROMOTION_OR_STRATEGY_PROFITABILITY",
    ],
  };
  return { ...report, reportHash: hash(report) };
}
