import { hash } from "./policy.js";
import { LearningError } from "./learning-schema.js";

// 소규모 연구용 ridge. 금액 장부의 decimal 산술이나 거래 프로필로 사용하지 않는다.
export interface RidgeModel {
  kind: "RIDGE_V1";
  lambda: number;
  means: number[];
  scales: number[];
  minimums: number[];
  maximums: number[];
  weights: number[];
  intercept: number;
  modelHash: string;
}
const finite = (x: number) => {
  if (!Number.isFinite(x)) throw new LearningError("MODEL_NUMERIC_FAILURE");
  return x;
};
export function fitRidge(
  x: number[][],
  y: number[],
  lambda: number,
): RidgeModel {
  const n = x.length,
    p = x[0]?.length ?? 0;
  if (
    n < 2 ||
    n > 5000 ||
    !p ||
    p > 8 ||
    y.length !== n ||
    !Number.isFinite(lambda) ||
    lambda <= 0 ||
    x.some((r) => r.length !== p || r.some((v) => !Number.isFinite(v))) ||
    y.some((v) => !Number.isFinite(v))
  )
    throw new LearningError("MODEL_INPUT_INVALID");
  const means = Array.from(
    { length: p },
    (_, j) => x.reduce((s, r) => s + r[j]!, 0) / n,
  );
  const scales = means.map(
    (m, j) => Math.sqrt(x.reduce((s, r) => s + (r[j]! - m) ** 2, 0) / n) || 1,
  );
  const z = x.map((r) => r.map((v, j) => (v - means[j]!) / scales[j]!));
  const intercept = y.reduce((s, v) => s + v, 0) / n;
  const matrix = Array.from({ length: p }, (_, j) =>
    Array.from({ length: p }, (_, k) =>
      finite(
        z.reduce((s, r) => s + r[j]! * r[k]!, 0) / n + (j === k ? lambda : 0),
      ),
    ),
  );
  const rhs = means.map((_, j) =>
    finite(z.reduce((s, r, i) => s + r[j]! * (y[i]! - intercept), 0) / n),
  );
  // 양의 정부호 행렬의 Cholesky 분해. 비정상 피벗은 보류하고 임의 계수로 대체하지 않는다.
  const l = Array.from({ length: p }, () => Array<number>(p).fill(0));
  for (let j = 0; j < p; j++)
    for (let k = 0; k <= j; k++) {
      let sum = matrix[j]![k]!;
      for (let q = 0; q < k; q++) sum -= l[j]![q]! * l[k]![q]!;
      if (j === k && !(sum > 0))
        throw new LearningError("MODEL_NUMERIC_FAILURE");
      l[j]![k] = finite(j === k ? Math.sqrt(sum) : sum / l[k]![k]!);
    }
  const a = Array<number>(p).fill(0),
    weights = Array<number>(p).fill(0);
  for (let j = 0; j < p; j++) {
    let sum = rhs[j]!;
    for (let k = 0; k < j; k++) sum -= l[j]![k]! * a[k]!;
    a[j] = finite(sum / l[j]![j]!);
  }
  for (let j = p - 1; j >= 0; j--) {
    let sum = a[j]!;
    for (let k = j + 1; k < p; k++) sum -= l[k]![j]! * weights[k]!;
    weights[j] = finite(sum / l[j]![j]!);
  }
  const model = {
    kind: "RIDGE_V1" as const,
    lambda,
    means,
    scales,
    minimums: means.map((_, j) => Math.min(...x.map((r) => r[j]!))),
    maximums: means.map((_, j) => Math.max(...x.map((r) => r[j]!))),
    weights,
    intercept,
  };
  return { ...model, modelHash: hash(model) };
}
export function predictRidge(model: RidgeModel, x: number[]) {
  const { modelHash, ...content } = model;
  if (
    hash(content) !== modelHash ||
    x.length !== model.means.length ||
    x.some((v) => !Number.isFinite(v))
  )
    throw new LearningError("MODEL_BINDING_INVALID");
  return finite(
    model.intercept +
      x.reduce(
        (s, v, j) =>
          s + ((v - model.means[j]!) / model.scales[j]!) * model.weights[j]!,
        0,
      ),
  );
}
