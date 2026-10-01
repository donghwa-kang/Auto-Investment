import { z } from "zod";
import { hash, policyHash, spec } from "./policy.js";
import { learningSchema, parseLearningInput } from "./learning-schema.js";
import {
  derivePaperRows,
  engineFeatureProfile,
} from "./paper-learning-convert.js";
import { verifyPaperExport } from "./paper-learning-verify.js";
import { PaperLearningError } from "./paper-learning-schema.js";

export const engineLearningPlanSchema = z.strictObject({
  schemaVersion: z.literal("ENGINE_LEARNING_PLAN_V1"),
  experimentId: learningSchema.shape.experimentId,
  market: learningSchema.shape.market,
  signal: learningSchema.shape.signal,
  model: learningSchema.shape.model,
  validation: learningSchema.shape.validation,
});
export function convertPaperLearning(raw: unknown, rawPlan: unknown) {
  const source = verifyPaperExport(raw),
    plan = engineLearningPlanSchema.parse(rawPlan),
    rows = derivePaperRows(source, plan.market, plan.signal);
  let previousEnd = -Infinity;
  const ids = new Set<string>();
  for (const f of plan.validation.folds) {
    const a = Date.parse(f.trainFrom),
      b = Date.parse(f.trainTo),
      c = Date.parse(f.testFrom),
      end = Date.parse(f.testTo);
    if (
      ids.has(f.id) ||
      !(
        a < b &&
        b + plan.validation.embargoMinutes * 60000 <= c &&
        c < end &&
        end <= source.asOf &&
        c >= previousEnd
      )
    )
      throw new PaperLearningError("PAPER_LEARNING_PLAN_BOUNDARY_INVALID");
    ids.add(f.id);
    previousEnd = end;
  }
  const input = rows.decisions.length
    ? parseLearningInput({
        schemaVersion: "ENGINE_LEARNING_RESEARCH_V2",
        purpose: "TEST_ONLY",
        dataOrigin: "ENGINE_RECORDED_SYNTHETIC",
        engineSource: source,
        experimentId: plan.experimentId,
        asOf: new Date(source.asOf).toISOString(),
        policyHash,
        strategyHash: hash(spec),
        market: plan.market,
        signal: plan.signal,
        featureProfile: engineFeatureProfile,
        model: plan.model,
        validation: plan.validation,
        decisions: rows.decisions,
        outcomes: rows.outcomes,
      })
    : null;
  const report = {
    schemaVersion: "PAPER_LEARNING_CONVERSION_V2",
    purpose: "TEST_ONLY",
    status: input ? "INPUT_CREATED_NOT_EVALUATED" : "NO_CONVERTIBLE_DECISIONS",
    sourceExportHash: source.exportHash,
    planHash: hash(plan),
    inputHash: input ? hash(input) : null,
    diagnostics: rows.diagnostics,
    featureChecks: rows.featureChecks,
    sourceDecisions: source.journal.decisions.length,
    convertedDecisions: rows.decisions.length,
    closedOutcomes: rows.outcomes.filter((o) => o.kind === "SIMULATED_CLOSED")
      .length,
    unresolvedOutcomes: rows.outcomes.filter((o) => o.kind === "UNRESOLVED")
      .length,
    featuresRebuiltFromSource: input !== null,
    featureScope: "RVOL_ONLY_SYNTHETIC_NOT_FULL_STRATEGY_VALIDATION",
    automaticPromotion: false,
    liveEnabled: false,
    networkRequests: 0,
  };
  return { input, report: { ...report, reportHash: hash(report) } };
}
