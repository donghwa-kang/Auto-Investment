import { z } from "zod";
import { hash, spec } from "./policy.js";
import { ceil, d } from "./math.js";
import { costFor } from "./risk.js";
import { verifyPaperExport } from "./paper-learning-verify.js";
import type { PaperExport, RecordedOrder } from "./paper-learning-schema.js";

type Decision = PaperExport["journal"]["decisions"][number];
type Outcome = "PASS" | "FAIL" | "UNKNOWN" | "NOT_EVALUATED";
type Observation = { status: Outcome; evidence: string[] };
type Predicate = Observation & { id: string };
export class ProfitabilityDiagnosticError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// Presentation order only, not a new evaluator or a change to entry conditions.
const common = [
  "COMMON_HISTORY",
  "COMMON_WINDOW",
  "COMMON_TTL",
  "COMMON_DAILY",
  "COMMON_BENCHMARK",
  "COMMON_VOL_CEILING",
  "COMMON_LIQUIDITY",
];
const branches = {
  B: [
    "B_CONTIGUOUS",
    "B_PREVIOUS_RANGE",
    "B_BREAKOUT",
    "B_VWAP_POSITIVE",
    "B_VWAP_DISTANCE",
    "B_RVOL",
  ],
  P: [
    "P_CONTIGUOUS",
    "P_EMA_SLOPE",
    "P_PULLBACK",
    "P_PREVIOUS_HIGH",
    "P_ABOVE_EMA",
    "P_ABOVE_VWAP",
    "P_EMA_DISTANCE",
    "P_RVOL",
  ],
};
const recognized = new Set([
  ...common,
  ...branches.B,
  ...branches.P,
  "B_FEATURES",
  "P_FEATURES",
  "P_HISTORY_FEATURES",
]);
const observe = (status: Outcome, ...evidence: string[]): Observation => ({
  status,
  evidence,
});

function predicates(dec: Decision): Predicate[] {
  const traces = new Map(dec.trace.map((t) => [t.predicate_id, t]));
  if (traces.size !== dec.trace.length)
    throw new ProfitabilityDiagnosticError("DIAGNOSTIC_DUPLICATE_PREDICATE");
  const compatible = (t: Decision["trace"][number]) =>
    t.strategy_version === spec.version &&
    t.indicator_version === "DECIMAL40_V1";
  for (const markerId of ["B_FEATURES", "P_FEATURES", "P_HISTORY_FEATURES"]) {
    const marker = traces.get(markerId);
    if (!marker || !compatible(marker)) continue;
    const branch = markerId.startsWith("B_") ? branches.B : branches.P;
    if (
      marker.result !== "MISSING" ||
      branch.slice(1).some((id) => traces.has(id)) ||
      (markerId === "P_FEATURES" && traces.has("P_HISTORY_FEATURES"))
    )
      throw new ProfitabilityDiagnosticError("DIAGNOSTIC_TRACE_CONFLICT");
  }
  return [...common, ...branches.B, ...branches.P].map((id) => {
    const t = traces.get(id);
    if (t) {
      if (!compatible(t))
        return { id, ...observe("UNKNOWN", "TRACE_VERSION_UNSUPPORTED") };
      return {
        id,
        ...observe(
          t.result === "PASS" || t.result === "FAIL" ? t.result : "UNKNOWN",
          `TRACE_${t.result}`,
        ),
      };
    }
    // The current evaluator explicitly skips remaining branch predicates when
    // this marker is emitted. Mere absence without the marker is not a skip.
    const marker =
      traces.get(`${id[0]}_FEATURES`) ??
      (id.startsWith("P_") ? traces.get("P_HISTORY_FEATURES") : undefined);
    if (
      !id.endsWith("_CONTIGUOUS") &&
      marker?.result === "MISSING" &&
      compatible(marker)
    )
      return { id, ...observe("NOT_EVALUATED", marker.predicate_id) };
    return { id, ...observe("UNKNOWN", "TRACE_NOT_RECORDED") };
  });
}
function path(rows: Predicate[]) {
  const first = rows.find((r) => r.status !== "PASS");
  return {
    status: rows.some((r) => r.status === "FAIL")
      ? ("FAIL" as const)
      : first
        ? ("UNKNOWN" as const)
        : ("PASS" as const),
    firstBlocker: first ? { id: first.id, status: first.status } : null,
    allFailures: rows.filter((r) => r.status === "FAIL").map((r) => r.id),
    unknown: rows.filter((r) => r.status === "UNKNOWN").map((r) => r.id),
    notEvaluated: rows
      .filter((r) => r.status === "NOT_EVALUATED")
      .map((r) => r.id),
  };
}
const amount = z
  .string()
  .max(100)
  .regex(/^(0|[1-9]\d{0,29})(\.\d{1,60})?$/);
const riskSnapshot = z.object({
  entry_price: amount,
  stop_price: amount,
  fx_rate: amount,
  initial_budget: amount,
});
function oneShare(order: RecordedOrder | undefined) {
  const parsed = riskSnapshot.safeParse(order?.snapshot);
  if (!parsed.success)
    return {
      status: "UNKNOWN" as const,
      reason: "PRICE_STOP_FX_BUDGET_NOT_RECORDED",
      riskKrw: null,
      budgetKrw: null,
      withinRiskBudget: null,
    };
  const s = parsed.data;
  if (
    !d(s.stop_price).gt(0) ||
    !d(s.entry_price).gt(s.stop_price) ||
    !d(s.fx_rate).gt(0)
  )
    return {
      status: "UNKNOWN" as const,
      reason: "INVALID_RISK_EVIDENCE",
      riskKrw: null,
      budgetKrw: null,
      withinRiskBudget: null,
    };
  const costs = costFor(1, s.entry_price, s.stop_price, s.fx_rate);
  const risk = ceil(
    d(s.entry_price).minus(s.stop_price).mul(s.fx_rate).plus(costs.stop),
  );
  return {
    status: "KNOWN" as const,
    reason: "APPROVED_SNAPSHOT_LEGACY_SYNTHETIC_RISK_ONLY",
    riskKrw: risk,
    budgetKrw: s.initial_budget,
    withinRiskBudget: d(risk).lte(s.initial_budget),
  };
}
function diagnoseDecision(dec: Decision, source: PaperExport) {
  const rows = predicates(dec);
  const select = (ids: string[]) => rows.filter((r) => ids.includes(r.id));
  const paths = {
    common: path(select(common)),
    B: path(select([...common, ...branches.B])),
    P: path(select([...common, ...branches.P])),
  };
  const selected = dec.strategy !== null;
  const approved = dec.result === "APPROVED";
  const has = (code: string) => dec.reasons.includes(code);
  const order = source.orders.find(
    (o) => o.side === "BUY" && o.snapshot?.signal_id === dec.id,
  );
  const buyFills = source.journal.fills.filter((f) => f.orderId === order?.id);
  const closed = source.journal.closures.some(
    (c) => c.positionId === order?.positionId,
  );
  if (
    (approved && dec.reasons.length > 0) ||
    (selected && paths[dec.strategy!].status === "FAIL") ||
    (has("NO_FEASIBLE_LOT") &&
      (has("ECONOMIC_GATE") || has("INVALID_FORECAST"))) ||
    (has("MISSING_FORECAST_PROFILE") &&
      (has("ECONOMIC_GATE") || has("INVALID_FORECAST"))) ||
    (has("ECONOMIC_GATE") && has("INVALID_FORECAST")) ||
    (!selected &&
      [
        "NO_FEASIBLE_LOT",
        "ECONOMIC_GATE",
        "MISSING_FORECAST_PROFILE",
        "INVALID_FORECAST",
        "ROUNDED_PRICE_OR_STOP_DISTANCE",
      ].some(has))
  )
    throw new ProfitabilityDiagnosticError("DIAGNOSTIC_DECISION_CONFLICT");
  const absent = observe("NOT_EVALUATED", "NO_SELECTED_STRATEGY");
  const stages = {
    distance: !selected
      ? absent
      : has("ROUNDED_PRICE_OR_STOP_DISTANCE")
        ? observe("FAIL", "ROUNDED_PRICE_OR_STOP_DISTANCE")
        : approved
          ? observe("PASS", "APPROVED_SNAPSHOT")
          : observe("UNKNOWN", "NO_DETAILED_DISTANCE_RESULT"),
    sizing: !selected
      ? absent
      : has("NO_FEASIBLE_LOT")
        ? observe("FAIL", "NO_FEASIBLE_LOT")
        : approved || has("ECONOMIC_GATE") || has("INVALID_FORECAST")
          ? observe("PASS", "POSITIVE_QUANTITY_PATH_RECORDED")
          : observe("UNKNOWN", "PREAPPROVAL_QUANTITY_NOT_RECORDED"),
    forecast: !selected
      ? absent
      : has("MISSING_FORECAST_PROFILE")
        ? observe("UNKNOWN", "MISSING_FORECAST_PROFILE")
        : has("INVALID_FORECAST")
          ? observe("FAIL", "INVALID_FORECAST")
          : approved || has("ECONOMIC_GATE")
            ? observe("PASS", "TEST_ONLY_FORECAST_VALIDATED_PATH")
            : observe("UNKNOWN", "FORECAST_RESULT_NOT_RECORDED"),
    economic: !selected
      ? absent
      : has("NO_FEASIBLE_LOT") ||
          has("MISSING_FORECAST_PROFILE") ||
          has("INVALID_FORECAST")
        ? observe("NOT_EVALUATED", "QUANTITY_OR_VALID_FORECAST_UNAVAILABLE")
        : has("ECONOMIC_GATE")
          ? observe("FAIL", "ECONOMIC_GATE")
          : approved
            ? observe("PASS", "APPROVED_SNAPSHOT")
            : observe("UNKNOWN", "ECONOMIC_RESULT_NOT_RECORDED"),
    approval: observe(approved ? "PASS" : "FAIL", "RECORDED_DECISION"),
    fill: !order
      ? observe("NOT_EVALUATED", "NO_BUY_INTENT")
      : buyFills.length
        ? observe("PASS", "BUY_FILL_RECORDED")
        : ["CANCELLED", "REJECTED"].includes(order.status)
          ? observe("FAIL", "TERMINAL_WITHOUT_FILL")
          : observe("UNKNOWN", "NO_FILL_AS_OF_EXPORT"),
    closure: !buyFills.length
      ? observe("NOT_EVALUATED", "NO_BUY_FILL")
      : closed
        ? observe("PASS", "CLOSURE_RECORDED")
        : observe("UNKNOWN", "NO_CLOSURE_AS_OF_EXPORT"),
  };
  return {
    decisionId: dec.id,
    at: dec.at,
    symbol: dec.symbol,
    strategy: dec.strategy,
    result: dec.result,
    recordedQuantity: dec.quantity,
    zeroSizingRecorded: has("NO_FEASIBLE_LOT"),
    reasons: [...new Set(dec.reasons)].sort(),
    missingInputPredicates: dec.trace
      .filter((t) => t.result === "MISSING")
      .map((t) => t.predicate_id),
    unmappedPredicates: dec.trace
      .filter((t) => !recognized.has(t.predicate_id))
      .map((t) => ({ id: t.predicate_id, result: t.result })),
    predicates: rows,
    paths,
    stages,
    oneShare: oneShare(order),
    buyIntentId: order?.id ?? null,
    buyFillEvents: buyFills.length,
    closedPosition: closed,
  };
}
const counts = () => ({ PASS: 0, FAIL: 0, UNKNOWN: 0, NOT_EVALUATED: 0 });

/** Read-only, single-run diagnostics. Export consistency is not source authentication. */
export function diagnoseProfitability(raw: unknown) {
  const source = verifyPaperExport(raw);
  const decisions = source.journal.decisions.map((dec) =>
    diagnoseDecision(dec, source),
  );
  const stages = Object.fromEntries(
    [
      "distance",
      "sizing",
      "forecast",
      "economic",
      "approval",
      "fill",
      "closure",
    ].map((name) => {
      const count = counts();
      for (const dec of decisions) {
        const observation = Object.entries(dec.stages).find(
          ([key]) => key === name,
        )![1];
        count[observation.status]++;
      }
      return [name, { denominator: decisions.length, counts: count }];
    }),
  );
  const predicateCounts = [...common, ...branches.B, ...branches.P].map(
    (id) => {
      const count = counts();
      for (const dec of decisions)
        count[dec.predicates.find((r) => r.id === id)!.status]++;
      return { id, denominator: decisions.length, counts: count };
    },
  );
  // Two separate AND paths: common+B OR common+P. Never AND B and P together.
  const funnels = (["B", "P"] as const).map((branch) => {
    let eligible = decisions.map((dec) => dec.decisionId);
    const steps = [...common, ...branches[branch]].map((id) => {
      const count = counts();
      const next: string[] = [];
      for (const dec of decisions.filter((v) =>
        eligible.includes(v.decisionId),
      )) {
        const status = dec.predicates.find((r) => r.id === id)!.status;
        count[status]++;
        if (status === "PASS") next.push(dec.decisionId);
      }
      const row = {
        id,
        eligible: eligible.length,
        excludedByEarlierStep: decisions.length - eligible.length,
        counts: count,
      };
      eligible = next;
      return row;
    });
    return {
      branch,
      denominator: decisions.length,
      steps,
      allPass: eligible.length,
    };
  });
  const reasonCounts = [...new Set(decisions.flatMap((v) => v.reasons))]
    .sort()
    .map((reason) => ({
      reason,
      decisions: decisions.filter((v) => v.reasons.includes(reason)).length,
      denominator: decisions.length,
    }));
  const buys = source.orders.filter((o) => o.side === "BUY");
  const body = {
    schemaVersion: "OFFLINE_PROFITABILITY_DIAGNOSTIC_V1",
    purpose: "TEST_ONLY",
    status: decisions.length ? "DIAGNOSTIC_ONLY" : "NO_RECORDED_DECISIONS",
    source: {
      exportHash: source.exportHash,
      runHash: source.journal.runHash,
      stateHash: source.stateHash,
      policyHash: source.journal.policyHash,
      strategyHash: source.journal.strategyHash,
      profileHash: source.journal.profileHash,
      asOf: source.asOf,
    },
    denominators: {
      candidateDecisions: decisions.length,
      selectedSignals: decisions.filter((v) => v.strategy !== null).length,
      chartPassPaths: { B: funnels[0]!.allPass, P: funnels[1]!.allPass },
      buyIntents: buys.length,
      filledBuyIntents: buys.filter((o) => o.filled > 0).length,
      fillEvents: {
        BUY: source.journal.fills.filter((f) => f.side === "BUY").length,
        SELL: source.journal.fills.filter((f) => f.side === "SELL").length,
      },
      closedPositions: source.journal.closures.length,
    },
    stages,
    predicateCounts,
    funnels,
    reasonCounts,
    decisions,
    limitations: [
      "RECORDED_CANDIDATES_NOT_ENTIRE_MARKET",
      "TRACE_RESULTS_NOT_INDICATOR_RECALCULATION",
      "FUNNEL_PRESENTATION_ORDER_NOT_CAUSAL_ATTRIBUTION",
      "ABSENT_EVIDENCE_NOT_PASS",
      "ABSTAIN_QUANTITY_ZERO_NOT_PROOF_OF_ZERO_SIZING",
      "REJECTED_ONE_SHARE_INPUTS_NOT_RECORDED",
      "ONE_SHARE_RISK_ONLY_NOT_CASH_EXPOSURE_OR_ENTRY_APPROVAL",
      "LEGACY_FIXED_SYNTHETIC_FEES_NOT_D03_INTEGRATION",
      "EXPORT_CONSISTENCY_NOT_SOURCE_AUTHENTICATION",
      "NO_REAL_FORECAST_OR_PROFITABILITY_VALIDATION",
    ],
    orderSubmissionAllowed: false,
    learningAllowed: false,
    automaticPromotion: false,
    profitabilityValidated: false,
    liveEnabled: false,
  } as const;
  return { ...body, reportHash: hash(body) };
}
