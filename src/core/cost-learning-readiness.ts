import { hash } from "./policy.js";
import { verifyCostOutcomeExport } from "./cost-outcome-export.js";
import type { CostExportAnchor } from "./cost-outcome-export.js";

export const costLearningReadinessKind = "COST_LEARNING_READINESS_V1";
type ReadinessCheck = {
  id:
    | "FINANCIAL_REPLAY"
    | "FEATURE_BINDING"
    | "OPERATING_ALLOCATION"
    | "TRAINING_CONTRACT"
    | "POPULATION_SCOPE";
  status: "VERIFIED" | "MISSING" | "UNSUPPORTED" | "LIMITED";
  reasons: string[];
};
function checks(): ReadinessCheck[] {
  return [
    { id: "FINANCIAL_REPLAY", status: "VERIFIED", reasons: [] },
    {
      id: "FEATURE_BINDING",
      status: "MISSING",
      reasons: ["V3_FEATURE_SOURCE_NOT_BOUND"],
    },
    {
      id: "OPERATING_ALLOCATION",
      status: "UNSUPPORTED",
      reasons: ["OPERATING_COST_ALLOCATION_UNSUPPORTED"],
    },
    {
      id: "TRAINING_CONTRACT",
      status: "UNSUPPORTED",
      reasons: ["V3_TRAINING_CONTRACT_NOT_INTEGRATED"],
    },
    {
      id: "POPULATION_SCOPE",
      status: "LIMITED",
      reasons: ["V3_PREAPPROVAL_POPULATION_NOT_RECORDED"],
    },
  ];
}

// Read-only diagnostic, not a converter. Always replays the original D2 text;
// caller-supplied "verified" objects and derived labels are not an input path.
export function assessCostLearningReadiness(
  text: string,
  anchor: CostExportAnchor,
) {
  const verified = verifyCostOutcomeExport(text, anchor);
  const financialReport = structuredClone(verified.report);
  const trades = new Map(
    financialReport.financialEvidence.trades.map((t) => [t.reservationId, t]),
  );
  const phaseCounts = {
    RESERVED_LOCAL: 0,
    RELEASED_LOCAL: 0,
    NO_FILLS: 0,
    INCOMPLETE_TRADE: 0,
    CLOSED: 0,
  };
  const records = financialReport.financialEvidence.approvals.map((a, i) => {
    const trade = trades.get(a.id);
    // D2 reconstructs both lists from the same approvals; preserve its row,
    // including original reasons and nulls, without recomputing financial data.
    const original = financialReport.learningEvidence.records[i]!;
    if (a.status === "TRANSFERRED_SYNTHETIC" && !trade)
      throw Error("COST_READINESS_TRANSFER_MISSING");
    const phase = trade
      ? trade.phase
      : a.status === "RESERVED_LOCAL"
        ? ("RESERVED_LOCAL" as const)
        : ("RELEASED_LOCAL" as const);
    phaseCounts[phase]++;
    return {
      ...structuredClone(original),
      rowId: hash({
        configHash: financialReport.source.configHash,
        sourceScope: anchor.config.sourceScope,
        reservationId: a.id,
      }),
      phase,
      checks: checks(),
    };
  });
  const body = {
    kind: costLearningReadinessKind,
    purpose: "TEST_ONLY" as const,
    status: "HOLD" as const,
    source: {
      ...financialReport.source,
      exportHash: verified.exportHash,
      financialBasisHash: financialReport.financialBasisHash,
      reportHash: financialReport.reportHash,
    },
    financialReport,
    coverage: {
      scope: "PERSISTED_APPROVALS_ONLY" as const,
      approvalCount: records.length,
      transferCount: trades.size,
      phaseCounts,
      preApprovalDecisions: "NOT_RECORDED_BY_V3_CONTRACT" as const,
    },
    checks: checks(),
    records,
    trainingInput: null,
    learningAllowed: false as const,
    orderSubmissionAllowed: false as const,
    liveEnabled: false as const,
  };
  return { ...body, readinessHash: hash(body) };
}

export type CostLearningReadiness = ReturnType<
  typeof assessCostLearningReadiness
>;
