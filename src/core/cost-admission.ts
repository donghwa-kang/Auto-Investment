import { hash } from "./policy.js";
import { buildCostExposure } from "./cost-risk-context.js";
import { evaluateCostSizing } from "./cost-aware-sizing.js";
import type { CostSizingResult } from "./cost-aware-sizing.js";
import type { State } from "./types.js";

export interface CostAdmission {
  kind: "SYNTHETIC_COST_ADMISSION_REVIEW_V1";
  status: "RESEARCH_CANDIDATE" | "HOLD";
  reasons: string[];
  sizing: CostSizingResult | null;
  exposure: {
    sourceHash: string;
    stateHash: string;
    openRiskKrw: string;
    notionalKrw: string;
    budgetKrw: string;
    available: { KRW: string; USD: string };
  } | null;
  bindingHash: string;
  orderSubmissionAllowed: false;
  learningAllowed: false;
  liveEnabled: false;
}
// No approval/intent/order is persisted. Recheck means equality of a research
// candidate, not freshness at a later COMMIT or an authorization token.
export function reviewCostAdmission(
  seed: State,
  book: unknown,
  profile: unknown,
  request: unknown,
): CostAdmission {
  const built = buildCostExposure(seed, book);
  const bindingHash = hash({ seed, book, profile, request });
  const base = {
    kind: "SYNTHETIC_COST_ADMISSION_REVIEW_V1",
    bindingHash,
    orderSubmissionAllowed: false,
    learningAllowed: false,
    liveEnabled: false,
  } as const;
  if (built.status !== "OK")
    return {
      ...base,
      status: "HOLD",
      reasons: built.reasons,
      sizing: null,
      exposure: null,
    };
  const c = built.context;
  // The caller must bind the derived state; a seed hash cannot certify a
  // different exposure book. No request values are silently repaired.
  const sizing = evaluateCostSizing(c.state, profile, request, undefined, c);
  return {
    ...base,
    status:
      sizing.status === "RESEARCH_CANDIDATE" ? "RESEARCH_CANDIDATE" : "HOLD",
    reasons: sizing.reasons,
    sizing,
    exposure: {
      sourceHash: c.sourceHash,
      stateHash: c.stateHash,
      openRiskKrw: c.openRiskKrw,
      notionalKrw: c.notionalKrw,
      budgetKrw: c.budgetKrw,
      available: c.available,
    },
  };
}
const reviews = new WeakMap<CostAdmission, string>();
// Issuing explicitly retains a process-local, immutable-by-validation receipt.
// Serialized/edited receipts require a fresh review, never a hash-only approval.
export function issueCostAdmissionReview(
  seed: State,
  book: unknown,
  profile: unknown,
  request: unknown,
) {
  const result = reviewCostAdmission(seed, book, profile, request);
  reviews.set(result, hash(result));
  return result;
}
export function recheckCostAdmission(
  previous: CostAdmission,
  seed: State,
  book: unknown,
  profile: unknown,
  request: unknown,
) {
  const current = reviewCostAdmission(seed, book, profile, request);
  const matches =
    reviews.get(previous) === hash(previous) &&
    previous.status === "RESEARCH_CANDIDATE" &&
    current.status === "RESEARCH_CANDIDATE" &&
    hash(previous) === hash(current);
  return {
    status: matches
      ? ("RESEARCH_MATCH" as const)
      : ("REAPPROVAL_REQUIRED" as const),
    current,
    orderSubmissionAllowed: false as const,
    learningAllowed: false as const,
    liveEnabled: false as const,
  };
}
