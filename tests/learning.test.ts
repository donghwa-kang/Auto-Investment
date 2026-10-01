import { test } from "node:test";
import assert from "node:assert/strict";
import { hash } from "../src/core/policy.js";
import { createLearningSample } from "../src/core/learning-sample.js";
import { buildLearningData } from "../src/core/learning-data.js";
import { fitRidge, predictRidge } from "../src/core/learning-model.js";
import { evaluateLearning, predictionMetrics } from "../src/core/learning.js";
import {
  parseLearningInput,
  type LearningInput,
} from "../src/core/learning-schema.js";

const sample = createLearningSample;
const row = (s: LearningInput, index = 0) =>
  buildLearningData(s).rows.find(
    (r) => r.decision.id === s.decisions[index]!.id,
  )!;
const refresh = (s: LearningInput, index = 0) => {
  s.outcomes[index]!.decisionHash = hash(s.decisions[index]);
};
const reason = (s: LearningInput, expected: string, index = 0) => {
  assert.equal(row(s, index).status, "EXCLUDED");
  assert.ok(
    row(s, index).reasons.includes(expected),
    JSON.stringify(row(s, index).reasons),
  );
};
const close = (actual: number, expected: number, tolerance = 1e-10) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );

test("LEARN-01 기준 샘플 실제 학습·순방향 두 구간·거래 승격 없음", () => {
  const s = sample(),
    before = structuredClone(s),
    r = evaluateLearning(s);
  assert.equal(r.status, "RESEARCH_EVALUATED");
  assert.equal(r.dataset.eligible, 96);
  assert.equal(r.dataset.excluded, 0);
  assert.deepEqual(
    r.folds.map((f) => [f.trainRows, f.testRows]),
    [
      [40, 19],
      [60, 35],
    ],
  );
  for (const f of r.folds) {
    assert.ok(f.model);
    assert.ok(f.candidate!.maeR < f.baseline!.maeR);
    assert.equal(f.predictions.length, f.testRows);
  }
  for (const value of [
    r.realDataReady,
    r.forecastValidated,
    r.profitabilityValidated,
    r.finalHoldoutEvaluated,
    r.automaticPromotion,
    r.paperOrdersEnabled,
    r.liveEnabled,
    r.strategyEvaluated,
    r.operatingCostAllocationValidated,
  ])
    assert.equal(value, false);
  assert.equal(r.accountPerformance, null);
  assert.equal(r.selectedModel, null);
  assert.equal(r.networkRequests, 0);
  assert.ok(
    r.folds[0]!.predictions.every(
      (p) => p.netPnlQ05 === null && !p.calibrated && !p.orderAuthorized,
    ),
  );
  const { reportHash, ...content } = r;
  assert.equal(hash(content), reportHash);
  assert.equal(evaluateLearning(s).reportHash, reportHash);
  assert.deepEqual(s, before);
});
test("LEARN-02 명시 비용 5종을 정확히 합산한 순 R", () => {
  const s = sample();
  s.outcomes[0]!.grossPnl = "10.1";
  s.outcomes[0]!.costs = {
    commission: "0.1",
    tax: "0.2",
    slippage: "0.3",
    fx: "0.4",
    operation: "0.5",
  };
  close(row(s).grossR!, 1.01);
  close(row(s).costR!, 0.15);
  close(row(s).netR!, 0.86);
});
test("LEARN-03 자료 목적·출처·정책·알 수 없는 필드 거절", () => {
  for (const [key, value] of [
    ["purpose", "LIVE"],
    ["dataOrigin", "REAL"],
    ["policyHash", "0".repeat(64)],
    ["api_key", "FAKE_PRIVATE_VALUE"],
    ["extra", true],
  ]) {
    const s = { ...sample(), [String(key)]: value };
    assert.throws(() => parseLearningInput(s), /LEARNING_INPUT_INVALID/);
  }
});
test("LEARN-04 숫자·차원·중복 ID·자원 상한 거절", () => {
  for (const mutate of [
    (s: LearningInput) => {
      s.decisions[0]!.features = [NaN, 0];
    },
    (s: LearningInput) => {
      s.decisions[0]!.features = [1];
    },
    (s: LearningInput) => {
      s.decisions[0]!.riskUnit = "0";
    },
    (s: LearningInput) => {
      s.decisions[1]!.id = s.decisions[0]!.id;
    },
    (s: LearningInput) => {
      s.model.lambda = 0;
    },
    (s: LearningInput) => {
      s.outcomes[0]!.costs!.tax = "-1";
    },
    (s: LearningInput) => {
      s.decisions = Array.from({ length: 5001 }, () => s.decisions[0]!);
    },
  ]) {
    const s = sample();
    mutate(s);
    assert.throws(() => parseLearningInput(s), /LEARNING_INPUT_INVALID/);
  }
});
test("LEARN-05 시각 역전·시험 겹침·엠바고 부족은 실행 전 거절", () => {
  for (const mutate of [
    (s: LearningInput) => {
      s.validation.folds[0]!.trainTo = s.validation.folds[0]!.trainFrom;
    },
    (s: LearningInput) => {
      s.validation.folds[0]!.testFrom = s.validation.folds[0]!.trainTo;
    },
    (s: LearningInput) => {
      s.validation.folds[1]!.testFrom = s.validation.folds[0]!.testFrom;
    },
    (s: LearningInput) => {
      s.validation.folds[1]!.testTo = "2027-01-01T00:00:00Z";
    },
  ]) {
    const s = sample();
    mutate(s);
    assert.throws(() => evaluateLearning(s), /LEARNING_INPUT_INVALID/);
  }
});
test("LEARN-06 특징 원천/수신이 판단 이후이면 학습 제외", () => {
  const s = sample();
  s.decisions[0]!.sourceAsOf = "2026-08-03T14:00:01Z";
  refresh(s);
  reason(s, "FEATURE_NOT_AVAILABLE_AT_DECISION");
  const other = sample();
  other.decisions[0]!.availableAt = "2026-08-03T14:00:01Z";
  refresh(other);
  reason(other, "FEATURE_NOT_AVAILABLE_AT_DECISION");
});
test("LEARN-07 hash·시장·통화·전략 불일치 제외", () => {
  const s = sample();
  s.decisions[0]!.features[0] = 12;
  reason(s, "DECISION_HASH_MISMATCH");
  const market = sample();
  market.decisions[0]!.market = "KR";
  refresh(market);
  reason(market, "MARKET_CURRENCY_MISMATCH");
  const currency = sample();
  currency.outcomes[0]!.currency = "KRW";
  reason(currency, "OUTCOME_CURRENCY_MISMATCH");
  const strategy = sample();
  strategy.decisions[0]!.signal = "P";
  refresh(strategy);
  reason(strategy, "NOT_REGISTERED_ENTRY");
});
test("LEARN-08 미거래·가상 가정 결과·미확정·비용 누락을 확정 손익으로 쓰지 않음", () => {
  const abstain = sample();
  abstain.decisions[0]!.action = "ABSTAIN";
  refresh(abstain);
  reason(abstain, "NOT_REGISTERED_ENTRY");
  for (const kind of ["COUNTERFACTUAL", "UNRESOLVED"] as const) {
    const s = sample();
    s.outcomes[0]!.kind = kind;
    reason(s, "UNCONFIRMED_OR_COUNTERFACTUAL");
  }
  const costs = sample();
  costs.outcomes[0]!.costs = null;
  reason(costs, "COST_OR_PNL_MISSING");
  const missing = sample();
  missing.outcomes.shift();
  reason(missing, "OUTCOME_NOT_AVAILABLE");
});
test("LEARN-09 결과 종료/수신 시각과 미래 라벨 제외", () => {
  const s = sample();
  s.outcomes[0]!.closedAt = s.decisions[0]!.decisionAt;
  reason(s, "LABEL_TIME_INVALID");
  const future = sample();
  future.outcomes[0]!.availableAt = "2026-08-05T00:00:00Z";
  reason(future, "OUTCOME_NOT_AVAILABLE");
  const lateClose = sample();
  lateClose.outcomes[0]!.closedAt = "2026-08-05T00:00:00Z";
  reason(lateClose, "LABEL_TIME_INVALID");
});
test("LEARN-10 동일 결과 중복 보존·상충 버전은 제외", () => {
  const s = sample(),
    o = structuredClone(s.outcomes[0]!);
  o.id = "duplicate";
  s.outcomes.push(o);
  assert.equal(row(s).status, "ELIGIBLE");
  assert.equal(row(s).outcomeIds.length, 2);
  o.grossPnl = "999";
  reason(s, "OUTCOME_CONFLICT");
  assert.equal(row(s).outcomeIds.length, 2);
});
test("LEARN-11 같은 종목/전략/시점의 이중 판단과 고아 결과 탐지", () => {
  const s = sample(),
    d = structuredClone(s.decisions[0]!);
  d.id = "copy";
  s.decisions.push(d);
  reason(s, "DECISION_KEY_CONFLICT");
  const orphan = sample();
  orphan.outcomes[0]!.decisionId = "MISSING";
  const r = evaluateLearning(orphan);
  assert.equal(r.status, "BLOCKED");
  assert.deepEqual(r.dataset.orphanOutcomeIds, ["outcome-000"]);
});
test("LEARN-12 나중 정정은 과거 학습 모델·학습 해시에 영향 없음", () => {
  const s = sample(),
    original = evaluateLearning(s).folds[0]!;
  const correction = structuredClone(s.outcomes[0]!);
  correction.id = "later-correction";
  correction.availableAt = "2026-08-03T20:00:00Z";
  correction.grossPnl = "999";
  s.outcomes.push(correction);
  const changed = evaluateLearning(s).folds[0]!;
  assert.equal(changed.model!.modelHash, original.model!.modelHash);
  assert.equal(changed.trainingDataHash, original.trainingDataHash);
  reason(s, "OUTCOME_CONFLICT");
});
test("LEARN-13 학습 경계에 걸친/늦게 확정된 라벨 제거", () => {
  const s = sample();
  s.outcomes[39]!.availableAt = s.validation.folds[0]!.trainTo;
  const f = evaluateLearning(s).folds[0]!;
  assert.equal(f.trainRows, 39);
  assert.ok(f.excludedTrainingIds.includes("decision-039"));
  assert.ok(!f.trainDecisionIds.includes("decision-040"));
});
test("LEARN-14 시험 특징·손익 변경이 이전 표준화/계수에 영향 없음", () => {
  const s = sample(),
    before = evaluateLearning(s).folds[0]!;
  s.decisions[45]!.features = [900000, -900000];
  refresh(s, 45);
  s.outcomes[45]!.grossPnl = "12345";
  const after = evaluateLearning(s).folds[0]!;
  assert.deepEqual(after.model, before.model);
  assert.equal(after.trainingDataHash, before.trainingDataHash);
  assert.equal(after.extrapolationCount, 1);
  assert.notEqual(after.candidate!.maeR, before.candidate!.maeR);
});
test("LEARN-15 표본 부족은 점수 0이나 합격으로 바뀌지 않음", () => {
  const s = sample();
  s.validation.minTrainRows = 100;
  const r = evaluateLearning(s);
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.folds[0]!.model, null);
  assert.equal(r.folds[0]!.candidate, null);
  const other = sample();
  other.validation.minTestRows = 100;
  const f = evaluateLearning(other).folds[0]!;
  assert.equal(f.status, "BLOCKED");
  assert.ok(f.model);
});
test("LEARN-16 입력 순서 변경에도 시간 정렬 모델은 재현", () => {
  const s = sample(),
    original = evaluateLearning(s);
  s.decisions.reverse();
  s.outcomes.reverse();
  const changed = evaluateLearning(s);
  assert.deepEqual(changed.folds, original.folds);
  assert.notEqual(changed.inputHash, original.inputHash);
});
test("LEARN-MODEL-01 1특징 ridge 해석적 정답과 일치", () => {
  const model = fitRidge([[-1], [1]], [-2, 2], 1);
  close(model.intercept, 0);
  close(model.means[0]!, 0);
  close(model.scales[0]!, 1);
  close(model.weights[0]!, 1);
  close(predictRidge(model, [3]), 3);
});
test("LEARN-MODEL-02 상수 특징·공선성·상수 목표에서 유한한 결과", () => {
  const constant = fitRidge([[1], [1], [1]], [2, 2, 2], 0.1);
  close(predictRidge(constant, [1]), 2);
  close(constant.weights[0]!, 0);
  const collinear = fitRidge(
    [
      [-1, -1],
      [1, 1],
    ],
    [-2, 2],
    1,
  );
  close(collinear.weights[0]!, 2 / 3);
  close(collinear.weights[1]!, 2 / 3);
});
test("LEARN-MODEL-03 잘못된 행/숫자/계수 해시 거절", () => {
  for (const args of [
    [[], [], 1],
    [[[1], [2, 3]], [1, 2], 1],
    [[[1], [NaN]], [1, 2], 1],
    [[[1], [2]], [1, 2], 0],
  ] as [number[][], number[], number][])
    assert.throws(() => fitRidge(...args), /MODEL_INPUT_INVALID/);
  const m = fitRidge([[1], [2]], [2, 3], 1);
  m.weights[0] = 10;
  assert.throws(() => predictRidge(m, [1]), /MODEL_BINDING_INVALID/);
});
test("LEARN-MODEL-04 오차 지표 단위와 빈 자료 처리", () => {
  assert.deepEqual(predictionMetrics([1, 3], [2, 2]), {
    rows: 2,
    maeR: 1,
    rmseR: 1,
    biasR: 0,
  });
  assert.equal(predictionMetrics([], []), null);
});
test("LEARN-MODEL-05 직교 2특징·절편 ridge의 해석적 정답", () => {
  const x = [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ],
    y = x.map(([a, b]) => 3 + 2 * a! - 4 * b!);
  const m = fitRidge(x, y, 1);
  close(m.intercept, 3);
  close(m.weights[0]!, 1);
  close(m.weights[1]!, -2);
  close(predictRidge(m, [0.5, -0.5]), 4.5);
});
test("LEARN-17 같은 순간의 시각 표기 차이는 이중 판단을 숨기지 못함", () => {
  const s = sample(),
    d = structuredClone(s.decisions[0]!);
  d.id = "same-instant";
  d.decisionAt = d.decisionAt.replace(".000Z", "Z");
  s.decisions.push(d);
  reason(s, "DECISION_KEY_CONFLICT");
});
test("LEARN-MODEL-06 오차 제곱의 overflow를 null/성공 지표로 직렬화하지 않음", () => {
  assert.throws(
    () => predictionMetrics([0], [1e200]),
    /LEARNING_METRIC_NUMERIC_FAILURE/,
  );
  assert.throws(
    () => predictionMetrics([1], [Infinity]),
    /LEARNING_METRIC_NUMERIC_FAILURE/,
  );
});
