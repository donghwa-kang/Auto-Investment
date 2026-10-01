import { hash } from "./policy.js";
import { d } from "./math.js";
import { profile } from "./risk.js";
import { verifyPaperExport } from "./paper-learning-verify.js";
import { spec } from "./policy.js";
import { rebuildRvol } from "./learning-rvol.js";
import { RvolSourceError } from "./learning-rvol-schema.js";
import { z } from "zod";
import { completedRiskWindow } from "./calendar.js";
import { operatingCostContract } from "./operating-cost.js";

const syntheticZeroBinding = z.strictObject({
  contract: z.literal(operatingCostContract),
  source: z.literal("SYNTHETIC_ZERO"),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  window: z.strictObject({
    startInclusive: z.number().int().safe(),
    endExclusive: z.number().int().safe(),
    riskDayIds: z.array(z.string()).length(20),
  }),
});
function knownZeroOperating(snapshot: Record<string, unknown>, at: number) {
  const binding = snapshot.operating_cost_binding;
  const amount = snapshot.estimated_operating_cost_krw;
  // 두 필드 모두 없는 과거 결과만 기존 무운영비 호환 규칙을 따른다.
  if (binding === undefined && amount === undefined) return true;
  if (amount !== "0") return false;
  const parsed = syntheticZeroBinding.safeParse(binding);
  if (!parsed.success) return false;
  try {
    return hash(parsed.data.window) === hash(completedRiskWindow(at));
  } catch {
    return false;
  }
}

export const legacyEngineFeatureProfile = {
  id: "ENGINE_RVOL_TRACE_V1",
  version: 1 as const,
  origin: "ENGINE_TRACE_NOT_REBUILT" as const,
  fields: [{ id: "rvol", unit: "DIMENSIONLESS" as const }],
};
export const engineFeatureProfile = {
  id: "ENGINE_RVOL_SOURCE_V1",
  version: 1 as const,
  origin: "ENGINE_SOURCE_REBUILT" as const,
  fields: [{ id: "rvol", unit: "DIMENSIONLESS" as const }],
};
// 이 분모는 판단 시 승인한 계획 가격 위험이다. 미래의 실제 체결 수량으로 다시 정하지 않는다.
export function derivePaperRows(
  raw: unknown,
  market: "KR" | "US",
  signal: "B" | "P",
  legacyTraceCompatibility = false,
) {
  const source = verifyPaperExport(raw),
    decisions: EngineDecision[] = [],
    outcomes: EngineOutcome[] = [],
    featureChecks: {
      sourceDecisionId: string;
      traceValue: string | null;
      rebuilt: ReturnType<typeof rebuildRvol> | null;
      reasons: string[];
    }[] = [],
    diagnostics: { sourceDecisionId: string; reasons: string[] }[] = [];
  const money = (v: string) =>
    /^-?\d{1,12}(\.\d{1,8})?$/.test(v) && v.length <= 24;
  for (const dec of source.journal.decisions) {
    const reasons: string[] = [];
    const order = source.orders.find(
      (o) => o.side === "BUY" && o.snapshot?.signal_id === dec.id,
    );
    if (dec.result !== "APPROVED")
      reasons.push("ABSTAIN_PRESERVED_NOT_LABELLED");
    if (!order) reasons.push("NO_ENTRY_ORDER");
    if (dec.strategy !== signal) reasons.push("OTHER_OR_NO_STRATEGY");
    if (!dec.symbol.startsWith(`${market}:`)) reasons.push("OTHER_MARKET");
    const traces = dec.trace.filter((t) => t.predicate_id === `${signal}_RVOL`),
      t = traces[0];
    const feature =
      t && typeof t.input_values.left === "string"
        ? Number(t.input_values.left)
        : NaN;
    if (
      traces.length !== 1 ||
      t?.result !== "PASS" ||
      !Number.isFinite(feature) ||
      feature < 0 ||
      feature > 1e6
    )
      reasons.push("RVOL_FEATURE_MISSING_OR_INVALID");
    const snap = order?.snapshot;
    const proofs =
      source.journal.featureSources?.filter((p) => p.decisionId === dec.id) ??
      [];
    let rebuilt: ReturnType<typeof rebuildRvol> | null = null;
    if (!legacyTraceCompatibility) {
      if (proofs.length !== 1) reasons.push("RVOL_SOURCE_MISSING_OR_DUPLICATE");
      else {
        const proof = proofs[0]!;
        try {
          rebuilt = rebuildRvol(proof);
          if (
            proof.symbol !== dec.symbol ||
            `${proof.history.identity.market}:${proof.history.identity.instrumentId}` !==
              dec.symbol ||
            proof.asOf > dec.at ||
            proof.asOf !== t?.as_of ||
            proof.signalAt !== snap?.signal_at ||
            proof.dataVersion !== t?.data_version ||
            proof.dataVersion !== snap?.data_version ||
            proof.sourceDataHash !== snap?.source_data_hash ||
            t?.indicator_version !== proof.numericProfile ||
            t?.strategy_version !== spec.version
          )
            reasons.push("RVOL_SOURCE_CONTEXT_MISMATCH");
          if (
            !t ||
            typeof t.input_values.left !== "string" ||
            !d(rebuilt.value).eq(t.input_values.left) ||
            t.operator !== ">=" ||
            t.threshold !==
              spec.strategies.find((s) => s.id === dec.strategy)?.parameters
                .rvol_min ||
            !d(rebuilt.value).gte(t.threshold)
          )
            reasons.push("RVOL_TRACE_REBUILD_MISMATCH");
        } catch (error) {
          reasons.push(
            error instanceof RvolSourceError
              ? error.code
              : "RVOL_SOURCE_INVALID",
          );
        }
      }
    }
    const risk = snap
      ? d(String(snap.entry_price))
          .minus(String(snap.stop_price))
          .mul(Number(snap.quantity))
          .toString()
      : null;
    if (risk === null || !money(risk) || !d(risk).gt(0))
      reasons.push("PLANNED_RISK_UNREPRESENTABLE");
    featureChecks.push({
      sourceDecisionId: dec.id,
      traceValue:
        typeof t?.input_values.left === "string" ? t.input_values.left : null,
      rebuilt,
      reasons: reasons.filter((r) => r.startsWith("RVOL_")),
    });
    if (reasons.length) {
      diagnostics.push({ sourceDecisionId: dec.id, reasons });
      continue;
    }
    const id = hash([source.journal.runHash, dec.id]),
      currency = market === "KR" ? ("KRW" as const) : ("USD" as const);
    const decision: EngineDecision = {
      id,
      instrumentId: hash(dec.symbol),
      market,
      currency,
      signal,
      action: "PAPER_ENTRY",
      decisionAt: new Date(dec.at).toISOString(),
      sourceAsOf: new Date(Number(snap!.signal_at)).toISOString(),
      availableAt: new Date(dec.at).toISOString(),
      evidenceHash: hash({
        runHash: source.journal.runHash,
        decision: dec,
        snapshot: snap,
        ...(!legacyTraceCompatibility
          ? { featureSourceHash: rebuilt!.sourceHash }
          : {}),
      }),
      features: [legacyTraceCompatibility ? feature : Number(rebuilt!.value)],
      riskUnit: risk!,
    };
    decisions.push(decision);
    const p = source.positions.find((p) => p.id === order!.positionId);
    const outcome: EngineOutcome = {
      id: hash([id, "outcome"]),
      decisionId: id,
      decisionHash: hash(decision),
      kind: "UNRESOLVED",
      closedAt: null,
      availableAt: new Date(source.asOf).toISOString(),
      currency,
      grossPnl: null,
      costs: null,
    };
    if (!p) reasons.push("ENTRY_NOT_FILLED");
    else if (p.closedAt === null) reasons.push("POSITION_NOT_CLOSED");
    else if (
      source.costs.length ||
      !d(profile.fees.fixedOperatingKrw).eq(0) ||
      // 후보 비용 추정은 확정 거래별 배분이 아니다. 명시 이력은 0원도
      // 확정 배분 지원 전까지 학습 정답으로 승격하지 않는다.
      !knownZeroOperating(snap!, dec.at)
    )
      reasons.push("OPERATING_COST_ALLOCATION_UNSUPPORTED");
    else {
      const gross = d(p.exitValue).minus(p.buyValue).toString(),
        commission = d(p.entryFees).plus(p.exitFees).toString();
      if (!money(gross) || !money(commission))
        reasons.push("MONEY_PRECISION_UNREPRESENTABLE");
      else
        Object.assign(outcome, {
          kind: "SIMULATED_CLOSED",
          closedAt: new Date(p.closedAt).toISOString(),
          availableAt: new Date(p.closedAt).toISOString(),
          grossPnl: gross,
          costs: {
            commission,
            tax: "0",
            slippage: "0",
            fx: "0",
            operation: "0",
          },
        });
    }
    outcomes.push(outcome);
    diagnostics.push({ sourceDecisionId: dec.id, reasons });
  }
  return { decisions, outcomes, diagnostics, featureChecks };
}
interface EngineDecision {
  id: string;
  instrumentId: string;
  market: "KR" | "US";
  currency: "KRW" | "USD";
  signal: "B" | "P";
  action: "PAPER_ENTRY";
  decisionAt: string;
  sourceAsOf: string;
  availableAt: string;
  evidenceHash: string;
  features: number[];
  riskUnit: string;
}
interface EngineOutcome {
  id: string;
  decisionId: string;
  decisionHash: string;
  kind: "UNRESOLVED" | "SIMULATED_CLOSED";
  closedAt: string | null;
  availableAt: string;
  currency: "KRW" | "USD";
  grossPnl: string | null;
  costs: {
    commission: string;
    tax: string;
    slippage: string;
    fx: string;
    operation: string;
  } | null;
}
