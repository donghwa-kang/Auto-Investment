import { hash } from "./policy.js";
import { buildLearningData } from "./learning-data.js";
import { fitRidge, predictRidge } from "./learning-model.js";
import { LearningError, parseLearningInput } from "./learning-schema.js";

const round = (n: number) => {
  if (!Number.isFinite(n))
    throw new LearningError("LEARNING_METRIC_NUMERIC_FAILURE");
  return Number(n.toFixed(12));
};
const average = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
export function predictionMetrics(actual: number[], predicted: number[]) {
  if (!actual.length || actual.length !== predicted.length) return null;
  if ([...actual, ...predicted].some((n) => !Number.isFinite(n)))
    throw new LearningError("LEARNING_METRIC_NUMERIC_FAILURE");
  const errors = actual.map((a, i) => predicted[i]! - a);
  const mse = average(errors.map((e) => e * e));
  return {
    rows: actual.length,
    maeR: round(average(errors.map(Math.abs))),
    rmseR: round(Math.sqrt(mse)),
    biasR: round(average(errors)),
  };
}
// 모델 평가일 뿐 신호·경제성 심사·주문·수익성 승격 함수를 호출하지 않는다.
export function evaluateLearning(raw: unknown) {
  const input = parseLearningInput(raw),
    data = buildLearningData(input);
  const folds = input.validation.folds.map((fold) => {
    // 각 학습 시점에 실제로 사용 가능했던 라벨만 재구성한다. 현재의 정정으로 과거를 소급하지 않는다.
    const trainingData = buildLearningData({ ...input, asOf: fold.trainTo });
    const train = trainingData.rows.filter(
      (r) =>
        r.status === "ELIGIBLE" &&
        Date.parse(r.decision.decisionAt) >= Date.parse(fold.trainFrom) &&
        Date.parse(r.decision.decisionAt) < Date.parse(fold.trainTo) &&
        Date.parse(r.labelAvailableAt!) < Date.parse(fold.trainTo) &&
        Date.parse(r.closedAt!) < Date.parse(fold.trainTo),
    );
    const test = data.rows.filter(
      (r) =>
        r.status === "ELIGIBLE" &&
        Date.parse(r.decision.decisionAt) >= Date.parse(fold.testFrom) &&
        Date.parse(r.decision.decisionAt) < Date.parse(fold.testTo),
    );
    const excludedTrainingIds = trainingData.rows
      .filter(
        (r) =>
          Date.parse(r.decision.decisionAt) >= Date.parse(fold.trainFrom) &&
          Date.parse(r.decision.decisionAt) < Date.parse(fold.trainTo) &&
          !train.includes(r),
      )
      .map((r) => r.decision.id);
    const reasons: string[] = [];
    if (
      train.length <
      Math.max(
        input.validation.minTrainRows,
        input.featureProfile.fields.length + 2,
      )
    )
      reasons.push("INSUFFICIENT_TRAIN_ROWS");
    if (test.length < input.validation.minTestRows)
      reasons.push("INSUFFICIENT_TEST_ROWS");
    if (data.orphanOutcomeIds.length) reasons.push("ORPHAN_OUTCOME");
    const model =
      reasons.includes("INSUFFICIENT_TRAIN_ROWS") ||
      reasons.includes("ORPHAN_OUTCOME")
        ? null
        : fitRidge(
            train.map((r) => r.decision.features),
            train.map((r) => r.netR!),
            input.model.lambda,
          );
    const predictions = model
      ? test.map((r) => ({
          decisionId: r.decision.id,
          decisionAt: r.decision.decisionAt,
          actualNetR: r.netR!,
          baselineNetR: model.intercept,
          predictedNetR: predictRidge(model, r.decision.features),
          outsideTrainRange: r.decision.features.some(
            (v, i) => v < model.minimums[i]! || v > model.maximums[i]!,
          ),
          netPnlQ05: null,
          calibrated: false,
          orderAuthorized: false,
        }))
      : [];
    const actual = predictions.map((p) => p.actualNetR);
    const baseline = predictionMetrics(
      actual,
      predictions.map((p) => p.baselineNetR),
    );
    const candidate = predictionMetrics(
      actual,
      predictions.map((p) => p.predictedNetR),
    );
    return {
      ...fold,
      status: reasons.length ? "BLOCKED" : "RESEARCH_EVALUATED",
      reasons,
      trainRows: train.length,
      testRows: test.length,
      trainDecisionIds: train.map((r) => r.decision.id),
      excludedTrainingIds,
      trainingDataHash: hash(train),
      featureProfileHash: hash(input.featureProfile),
      model,
      baseline,
      candidate,
      maeImprovementR:
        baseline && candidate ? round(baseline.maeR - candidate.maeR) : null,
      extrapolationCount: predictions.filter((p) => p.outsideTrainRange).length,
      predictions,
    };
  });
  const labels = data.rows.filter((r) => r.status === "ELIGIBLE");
  const net = labels.map((r) => r.netR!).sort((a, b) => a - b);
  const report = {
    schemaVersion: "LEARNING_RESEARCH_REPORT_V1",
    purpose: input.purpose,
    dataOrigin: input.dataOrigin,
    experimentId: input.experimentId,
    asOf: input.asOf,
    inputHash: hash(input),
    policyHash: input.policyHash,
    strategyHash: input.strategyHash,
    modelConfigHash: hash(input.model),
    featureProfileHash: hash(input.featureProfile),
    status: folds.some((f) => f.status === "BLOCKED")
      ? "BLOCKED"
      : "RESEARCH_EVALUATED",
    realDataReady: false,
    featuresRebuiltFromSource:
      input.schemaVersion === "ENGINE_LEARNING_RESEARCH_V2",
    forecastValidated: false,
    profitabilityValidated: false,
    finalHoldoutEvaluated: false,
    operatingCostAllocationValidated: false,
    accountPerformance: null,
    selectedModel: null,
    automaticPromotion: false,
    strategyEvaluated: false,
    paperOrdersEnabled: false,
    liveEnabled: false,
    networkRequests: 0,
    dataset: {
      ...data,
      observedLabels: labels.length
        ? {
            meanGrossR: round(average(labels.map((r) => r.grossR!))),
            meanCostR: round(average(labels.map((r) => r.costR!))),
            meanNetR: round(average(net)),
            empiricalNetQ05R: round(net[Math.ceil(0.05 * net.length) - 1]!),
            interpretation:
              "DECLARED_LABEL_DISTRIBUTION_NOT_PREDICTED_TAIL_OR_ACCOUNT_PNL",
          }
        : null,
    },
    folds,
    limitations: [
      "SYNTHETIC_ONLY",
      input.dataOrigin === "ENGINE_RECORDED_SYNTHETIC"
        ? "LOCAL_ENGINE_RECORDS_RECONCILED_NOT_EXTERNAL_SOURCE_AUTHENTICATED"
        : "FEATURES_AND_EXECUTIONS_DECLARED_NOT_VERIFIED",
      input.schemaVersion === "ENGINE_LEARNING_RESEARCH_V2"
        ? "RVOL_ONLY_REBUILT_FROM_CAPTURED_SYNTHETIC_BARS_NOT_FULL_STRATEGY_VALIDATION"
        : "FEATURES_NOT_REBUILT_FROM_SOURCE_IN_LEARNING_PATH",
      "PREDICTION_ERROR_NOT_INVESTMENT_PERFORMANCE",
      "NO_FINAL_HOLDOUT_OR_MULTIPLE_TEST_CORRECTION",
      "NO_REAL_FORECAST_CALIBRATION",
      "NO_AUTOMATIC_MODEL_SELECTION",
      "NO_ZERO_TRADE_DAY_ACCOUNT_COST_RECONCILIATION",
      "NO_PROFIT_OR_SAFETY_GUARANTEE",
    ],
  };
  return { ...report, reportHash: hash(report) };
}
export type LearningReport = ReturnType<typeof evaluateLearning>;
