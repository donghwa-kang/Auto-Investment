import { hash, policyHash, spec, theme } from "./policy.js";
import { d, sum } from "./math.js";
import { profile } from "./risk.js";
import { verifyPaperExport } from "./paper-learning-verify.js";
import {
  recordBundleSchema,
  recordPeriodSchema,
  recordSummarySchema,
  type RecordBundle,
  type RecordDetail,
  type RecordPeriod,
} from "./analysis-record-schema.js";

const iso = (n: number) => new Date(n).toISOString();
export function summarizeRecords(
  records: RecordDetail[],
  context: Pick<
    RecordBundle["summary"],
    | "period"
    | "excludedDecisions"
    | "excludedFillEvents"
    | "operatingCostEventsAsOf"
  >,
) {
  const currencyTotals = (currency: "KRW" | "USD") => {
    const selected = records.filter((r) => r.currency === currency),
      closed = selected.filter((r) => r.status === "CLOSED_RECONCILED"),
      unresolved = selected.filter((r) => r.status === "COST_UNRESOLVED");
    return {
      fills: selected.reduce((n, r) => n + r.fills, 0),
      buyQuantity: selected.reduce((n, r) => n + r.buyQuantity, 0),
      sellQuantity: selected.reduce((n, r) => n + r.sellQuantity, 0),
      buyValue: sum(selected.map((r) => r.buyValue)).toString(),
      sellValue: sum(selected.map((r) => r.sellValue)).toString(),
      fillFees: sum(selected.map((r) => r.fillFees)).toString(),
      reconciledClosures: closed.length + unresolved.length,
      costUnresolvedClosures: unresolved.length,
      closedNetAfterRecordedFees:
        !closed.length || unresolved.length
          ? null
          : sum(closed.map((r) => r.netAfterRecordedFees!)).toString(),
    };
  };
  return recordSummarySchema.parse({
    ...context,
    selectionRule: "DECISION_COHORT_INCLUSIVE_AS_OF_EVENTS_V1",
    decisions: records.length,
    approved: records.filter((r) => r.action === "APPROVED").length,
    abstained: records.filter((r) => r.action === "ABSTAIN").length,
    closedTrades: records.filter((r) => r.closedAt !== null).length,
    noFillEntries: records.filter((r) => r.status === "NO_FILL_AS_OF").length,
    openOrUnreconciledEntries: records.filter(
      (r) => r.status === "OPEN_OR_UNRECONCILED",
    ).length,
    costUnresolvedClosures: records.filter(
      (r) => r.status === "COST_UNRESOLVED",
    ).length,
    totals: { KRW: currencyTotals("KRW"), USD: currencyTotals("USD") },
  });
}

export function buildRecordBundle(
  raw: unknown,
  rawPeriod: RecordPeriod,
): RecordBundle {
  const source = verifyPaperExport(raw),
    period = recordPeriodSchema.parse(rawPeriod);
  const from = Date.parse(period.from),
    to = Date.parse(period.to);
  if (from > to || from < source.journal.startedAt || to > source.asOf)
    throw new Error("ANALYSIS_PERIOD_INVALID");
  // 숫자로 정규화한 UTC 경계로 포함 여부를 판정한다. 전체 계좌 성과가 아닌 판단 코호트다.
  const canonicalPeriod = { from: iso(from), to: iso(to) };
  const selected = source.journal.decisions.filter(
    (r) => r.at >= from && r.at <= to,
  );
  if (!selected.length) throw new Error("ANALYSIS_EMPTY_PERIOD");
  if (selected.length > 100) throw new Error("ANALYSIS_RECORD_LIMIT");
  const operating = source.costs.filter((c) => c.at <= to);
  const unresolvedCosts =
    operating.length > 0 || !d(profile.fees.fixedOperatingKrw).eq(0);
  const records: RecordDetail[] = selected
    .map((dec): RecordDetail => {
      const market = dec.symbol.split(":")[0];
      if (market !== "KR" && market !== "US")
        throw new Error("ANALYSIS_MARKET_INVALID");
      const currency = market === "KR" ? "KRW" : "USD";
      const buy = source.orders.find(
        (o) => o.side === "BUY" && o.snapshot?.signal_id === dec.id,
      );
      const fills = buy
        ? source.journal.fills.filter(
            (f) => f.positionId === buy.positionId && f.at <= to,
          )
        : [];
      const buys = fills.filter((f) => f.side === "BUY"),
        sells = fills.filter((f) => f.side === "SELL");
      const buyQuantity = buys.reduce((n, f) => n + f.quantity, 0),
        sellQuantity = sells.reduce((n, f) => n + f.quantity, 0);
      const buyValue = sum(buys.map((f) => f.value)),
        sellValue = sum(sells.map((f) => f.value)),
        fees = sum(fills.map((f) => f.fee));
      const closure = buy
        ? source.journal.closures.find(
            (c) => c.positionId === buy.positionId && c.at <= to,
          )
        : undefined;
      if (
        sellQuantity > buyQuantity ||
        (closure && (buyQuantity === 0 || buyQuantity !== sellQuantity))
      )
        throw new Error("ANALYSIS_QUANTITY_MISMATCH");
      const gross = closure ? sellValue.minus(buyValue) : null;
      return {
        sourceRef: hash([source.journal.runHash, dec.id]),
        decisionHash: hash(dec),
        instrumentRef: hash(dec.symbol),
        market,
        currency,
        at: iso(dec.at),
        strategy: dec.strategy,
        action: dec.result,
        plannedQuantity: dec.quantity,
        checks: {
          pass: dec.trace.filter((t) => t.result === "PASS").length,
          fail: dec.trace.filter((t) => t.result === "FAIL").length,
          missing: dec.trace.filter((t) => t.result === "MISSING").length,
          notApplicable: dec.trace.filter((t) => t.result === "NOT_APPLICABLE")
            .length,
        },
        reasonCount: dec.reasons.length,
        entryPrice: buy ? String(buy.snapshot!.entry_price) : null,
        stopPrice: buy ? String(buy.snapshot!.stop_price) : null,
        fills: fills.length,
        buyQuantity,
        sellQuantity,
        buyValue: buyValue.toString(),
        sellValue: sellValue.toString(),
        fillFees: fees.toString(),
        status:
          dec.result === "ABSTAIN"
            ? "ABSTAIN"
            : !buyQuantity
              ? "NO_FILL_AS_OF"
              : !closure
                ? "OPEN_OR_UNRECONCILED"
                : unresolvedCosts
                  ? "COST_UNRESOLVED"
                  : "CLOSED_RECONCILED",
        closedAt: closure ? iso(closure.at) : null,
        grossPnl: gross?.toString() ?? null,
        netAfterRecordedFees:
          gross && !unresolvedCosts ? gross.minus(fees).toString() : null,
      };
    })
    .sort(
      (a, b) =>
        a.at.localeCompare(b.at) || a.sourceRef.localeCompare(b.sourceRef),
    );
  const summary = summarizeRecords(records, {
    period: canonicalPeriod,
    excludedDecisions:
      source.journal.decisions.filter((d) => d.at <= to).length -
      selected.length,
    excludedFillEvents:
      source.journal.fills.filter((f) => f.at <= to).length -
      records.reduce((n, r) => n + r.fills, 0),
    operatingCostEventsAsOf: operating.length,
  });
  const result = recordBundleSchema.parse({
    version: "ENGINE_RECORD_ANALYSIS_BUNDLE_V1",
    origin: "ENGINE_RECORDED_SYNTHETIC",
    purpose: "PAPER_REVIEW_ONLY",
    symbol: "SELECTED_DECISION_COHORT",
    periodStart: canonicalPeriod.from,
    asOf: canonicalPeriod.to,
    policies: {
      trading: policyHash.toLowerCase(),
      strategy: hash(spec),
      theme: hash(theme),
    },
    source: {
      id: source.exportHash.toLowerCase(),
      observedAt: canonicalPeriod.to,
      metrics: {
        decisions: summary.decisions,
        approved: summary.approved,
        closedTrades: summary.closedTrades,
      },
    },
    evidence: {
      runHash: source.journal.runHash.toLowerCase(),
      exportHash: source.exportHash.toLowerCase(),
      stateHash: source.stateHash.toLowerCase(),
      auditHead: source.auditHead.toLowerCase(),
      revision: source.revision,
      snapshotAsOf: iso(source.asOf),
    },
    summary,
    records,
    operatingCostAllocation: unresolvedCosts
      ? "UNRESOLVED"
      : "NO_EVENTS_SYNTHETIC_ONLY",
    caveats:
      "SYNTHETIC_RECORDED_FEES_NOT_REAL_TOTAL_COST_OR_ACCOUNT_PERFORMANCE",
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024)
    throw new Error("ANALYSIS_BUNDLE_LIMIT");
  return result;
}

// 저장된 최소 자료의 자체 일관성 검사. 원본 재대조는 서비스의 승인/실행 경계에서 별도로 수행한다.
export function verifyRecordBundle(raw: unknown): RecordBundle {
  const b = recordBundleSchema.parse(raw);
  const from = Date.parse(b.periodStart),
    to = Date.parse(b.asOf);
  if (
    from > to ||
    to > Date.parse(b.evidence.snapshotAsOf) ||
    Buffer.byteLength(JSON.stringify(b)) > 128 * 1024
  )
    throw new Error("ANALYSIS_RECORD_INTEGRITY");
  for (const r of b.records) {
    const at = Date.parse(r.at),
      closed =
        r.status === "CLOSED_RECONCILED" || r.status === "COST_UNRESOLVED";
    if (
      at < from ||
      at > to ||
      r.currency !== (r.market === "KR" ? "KRW" : "USD") ||
      r.sellQuantity > r.buyQuantity ||
      r.buyQuantity > r.plannedQuantity ||
      [r.buyValue, r.sellValue, r.fillFees].some((v) => d(v).lt(0))
    )
      throw new Error("ANALYSIS_RECORD_INTEGRITY");
    if (
      (r.action === "ABSTAIN") !== (r.status === "ABSTAIN") ||
      closed !== (r.closedAt !== null) ||
      closed !== (r.grossPnl !== null)
    )
      throw new Error("ANALYSIS_RECORD_INTEGRITY");
    if (
      closed &&
      (r.buyQuantity === 0 ||
        r.buyQuantity !== r.sellQuantity ||
        Date.parse(r.closedAt!) < at ||
        Date.parse(r.closedAt!) > to ||
        !d(r.grossPnl!).eq(d(r.sellValue).minus(r.buyValue)))
    )
      throw new Error("ANALYSIS_RECORD_INTEGRITY");
    if (
      r.status === "CLOSED_RECONCILED"
        ? r.netAfterRecordedFees === null ||
          !d(r.netAfterRecordedFees).eq(d(r.grossPnl!).minus(r.fillFees)) ||
          b.operatingCostAllocation !== "NO_EVENTS_SYNTHETIC_ONLY"
        : r.netAfterRecordedFees !== null
    )
      throw new Error("ANALYSIS_RECORD_INTEGRITY");
    if (
      r.status === "COST_UNRESOLVED" &&
      b.operatingCostAllocation !== "UNRESOLVED"
    )
      throw new Error("ANALYSIS_RECORD_INTEGRITY");
    if (
      (r.status === "ABSTAIN" || r.status === "NO_FILL_AS_OF") &&
      (r.fills !== 0 ||
        r.buyQuantity !== 0 ||
        r.sellQuantity !== 0 ||
        !d(r.buyValue).eq(0) ||
        !d(r.sellValue).eq(0) ||
        !d(r.fillFees).eq(0))
    )
      throw new Error("ANALYSIS_RECORD_INTEGRITY");
  }
  const rebuilt = summarizeRecords(b.records, b.summary);
  if (
    hash(rebuilt) !== hash(b.summary) ||
    b.periodStart !== b.summary.period.from ||
    b.asOf !== b.summary.period.to ||
    b.source.observedAt !== b.asOf ||
    b.source.id !== b.evidence.exportHash ||
    b.policies.trading !== policyHash.toLowerCase() ||
    b.policies.strategy !== hash(spec) ||
    b.policies.theme !== hash(theme) ||
    new Set(b.records.map((r) => r.sourceRef)).size !== b.records.length ||
    hash(b.source.metrics) !==
      hash({
        decisions: rebuilt.decisions,
        approved: rebuilt.approved,
        closedTrades: rebuilt.closedTrades,
      })
  )
    throw new Error("ANALYSIS_RECORD_INTEGRITY");
  return b;
}
