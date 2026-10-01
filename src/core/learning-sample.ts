import { hash, policyHash, spec } from "./policy.js";
import { parseLearningInput, type LearningInput } from "./learning-schema.js";

// 관계식으로 만든 가상 학습 자료다. 실제 가격·B/P 거래·시장 수익률이 아니다.
export function createLearningSample(
  experimentId = "learning-demo-v1",
): LearningInput {
  const start = Date.parse("2026-08-03T14:00:00Z"),
    minute = 60000;
  const decisions: LearningInput["decisions"] = [],
    outcomes: LearningInput["outcomes"] = [];
  for (let i = 0; i < 96; i++) {
    const at = start + i * 5 * minute;
    const x = (((i * 7) % 19) - 9) / 10,
      y = (((i * 11) % 17) - 8) / 10;
    const d: LearningInput["decisions"][number] = {
      id: `decision-${String(i).padStart(3, "0")}`,
      instrumentId: "US-SYNTHETIC-TEST",
      market: "US",
      currency: "USD",
      signal: "B",
      action: "PAPER_ENTRY",
      decisionAt: new Date(at).toISOString(),
      sourceAsOf: new Date(at - minute).toISOString(),
      availableAt: new Date(at - 1000).toISOString(),
      evidenceHash: hash({ synthetic: true, index: i }),
      features: [x, y],
      riskUnit: "10",
    };
    decisions.push(d);
    outcomes.push({
      id: `outcome-${String(i).padStart(3, "0")}`,
      decisionId: d.id,
      decisionHash: hash(d),
      kind: "SIMULATED_CLOSED",
      closedAt: new Date(at + 2 * minute).toISOString(),
      availableAt: new Date(at + 3 * minute).toISOString(),
      currency: "USD",
      grossPnl: (
        10 *
        (0.15 + 0.8 * x - 0.4 * y + ((i % 3) - 1) * 0.02)
      ).toFixed(4),
      costs: {
        commission: "0.1",
        tax: "0.01",
        slippage: "0.05",
        fx: "0.01",
        operation: "0.03",
      },
    });
  }
  return parseLearningInput({
    schemaVersion: "LEARNING_RESEARCH_V1",
    purpose: "TEST_ONLY",
    dataOrigin: "DECLARED_SYNTHETIC",
    experimentId,
    asOf: "2026-08-04T00:00:00Z",
    policyHash,
    strategyHash: hash(spec),
    market: "US",
    signal: "B",
    featureProfile: {
      id: "synthetic-features-v1",
      version: 1,
      origin: "DECLARED_NOT_REBUILT",
      fields: [
        { id: "synthetic_trend", unit: "DIMENSIONLESS" },
        { id: "synthetic_volume", unit: "DIMENSIONLESS" },
      ],
    },
    model: {
      kind: "RIDGE_V1",
      lambda: 0.1,
      numericProfile: "JS_FLOAT64_RESEARCH_V1",
    },
    validation: {
      minTrainRows: 24,
      minTestRows: 8,
      embargoMinutes: 5,
      folds: [
        {
          id: "fold-1",
          trainFrom: "2026-08-03T14:00:00Z",
          trainTo: "2026-08-03T17:20:00Z",
          testFrom: "2026-08-03T17:25:00Z",
          testTo: "2026-08-03T19:00:00Z",
        },
        {
          id: "fold-2",
          trainFrom: "2026-08-03T14:00:00Z",
          trainTo: "2026-08-03T19:00:00Z",
          testFrom: "2026-08-03T19:05:00Z",
          testTo: "2026-08-03T22:00:00Z",
        },
      ],
    },
    decisions,
    outcomes,
  });
}
