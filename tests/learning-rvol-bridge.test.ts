import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { replayFixture } from "./signal-replay-helpers.js";
import {
  bridgePlan,
  bridgeSandbox,
  resign,
} from "./learning-bridge-helpers.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { PortfolioProgram } from "../src/core/portfolio-program.js";
import { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import { exportPaperLearning } from "../src/server/paper-learning-export.js";
import { convertPaperLearning } from "../src/core/paper-learning.js";
import {
  derivePaperRows,
  legacyEngineFeatureProfile,
} from "../src/core/paper-learning-convert.js";
import { parseLearningInput } from "../src/core/learning-schema.js";
import { evaluateLearning } from "../src/core/learning.js";
import { LearningRegistry } from "../src/server/learning-registry.js";
import { rebuildRvol } from "../src/core/learning-rvol.js";
import { hash } from "../src/core/policy.js";
import { d } from "../src/core/math.js";

const raw = replayFixture(),
  plan = portfolioFixture(raw),
  program = new PortfolioProgram(raw, plan.settings);
const dir = bridgeSandbox(),
  path = join(dir, "paper.sqlite");
const e = new PortfolioPaperEngine(program, path, { captureLearning: true });
for (const [i, c] of plan.commands.entries()) e.command(`plan-${i}`, c);
e.close();
const source = exportPaperLearning(path);
const converted = convertPaperLearning(source, bridgePlan(source));
function signProof(x: typeof source) {
  for (const p of x.journal.featureSources ?? [])
    p.sourceHash = hash(
      Object.fromEntries(Object.entries(p).filter(([k]) => k !== "sourceHash")),
    );
  return resign(x);
}
test("RVOL-BRIDGE-01 B/P의 원본 근거 315봉·trace·주문 바인딩과 V2 플래그", () => {
  assert.equal(source.journal.featureSources!.length, 2);
  for (const signal of ["B", "P"] as const) {
    const { input, report } = convertPaperLearning(source, {
      ...bridgePlan(source),
      signal,
    });
    assert.equal(input!.schemaVersion, "ENGINE_LEARNING_RESEARCH_V2");
    assert.equal(input!.featureProfile.origin, "ENGINE_SOURCE_REBUILT");
    assert.equal(report.featuresRebuiltFromSource, true);
    assert.equal(input!.decisions.length, 1);
    const proof = source.journal.featureSources!.find((p) =>
      source.journal.decisions.some(
        (d) => d.id === p.decisionId && d.strategy === signal,
      ),
    )!;
    const rebuilt = rebuildRvol(proof);
    assert.equal(rebuilt.selectedBarCount, 315);
    assert.equal(input!.decisions[0]!.features[0], Number(rebuilt.value));
    const result = evaluateLearning(input);
    assert.equal(result.featuresRebuiltFromSource, true);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.profitabilityValidated, false);
    assert.equal(result.automaticPromotion, false);
    assert.equal(result.liveEnabled, false);
  }
});
test("RVOL-BRIDGE-02 표시 반올림으로 같아 보여도 trace 원문 불일치 보류", () => {
  const x = structuredClone(source);
  const dec = x.journal.decisions.find(
    (d) => d.strategy === "B" && d.result === "APPROVED",
  )!;
  const t = dec.trace.find((t) => t.predicate_id === "B_RVOL")!;
  const old = String(t.input_values.left);
  t.input_values.left = d(old).plus("0.00000000000000000001").toString();
  assert.equal(Number(t.input_values.left), Number(old));
  const result = convertPaperLearning(resign(x), bridgePlan(x));
  assert.equal(result.input, null);
  assert.ok(
    result.report.diagnostics.some((d) =>
      d.reasons.includes("RVOL_TRACE_REBUILD_MISMATCH"),
    ),
  );
});
test("RVOL-BRIDGE-03 원본 거래량 변경 후 해시 재계산해도 trace 대조로 보류", () => {
  const x = structuredClone(source);
  for (const p of x.journal.featureSources!)
    p.history.sessions.at(-1)!.rows[0]!.v = "999999";
  const result = convertPaperLearning(signProof(x), bridgePlan(x));
  assert.equal(result.input, null);
  assert.ok(
    result.report.diagnostics.some((d) =>
      d.reasons.includes("RVOL_TRACE_REBUILD_MISMATCH"),
    ),
  );
});
test("RVOL-BRIDGE-04 종목·시각·자료 버전·스냅샷 교차 연결은 보류", () => {
  for (const field of ["symbol", "dataVersion", "sourceDataHash"] as const) {
    const x = structuredClone(source);
    for (const p of x.journal.featureSources!)
      p[field] = field === "symbol" ? "KR:wrong" : hash("wrong");
    const result = convertPaperLearning(signProof(x), bridgePlan(x));
    assert.equal(result.input, null);
    assert.ok(
      result.report.diagnostics.some((d) =>
        d.reasons.includes("RVOL_SOURCE_CONTEXT_MISMATCH"),
      ),
    );
  }
  const x = structuredClone(source);
  for (const p of x.journal.featureSources!) p.asOf++;
  assert.equal(convertPaperLearning(signProof(x), bridgePlan(x)).input, null);
});
test("RVOL-BRIDGE-05 근거 없는 과거 내보내기는 재수집 없이 보류", () => {
  const x = structuredClone(source);
  delete x.journal.featureSources;
  resign(x);
  const result = convertPaperLearning(x, bridgePlan(x));
  assert.equal(result.input, null);
  assert.equal(result.report.featuresRebuiltFromSource, false);
  assert.ok(
    result.report.diagnostics.every((d) =>
      d.reasons.includes("RVOL_SOURCE_MISSING_OR_DUPLICATE"),
    ),
  );
});
test("RVOL-BRIDGE-06 과거 V1 학습 입력 호환·새 V2의 거짓 승격/강등 차단", () => {
  const oldSource = structuredClone(source);
  delete oldSource.journal.featureSources;
  resign(oldSource);
  const rows = derivePaperRows(oldSource, "KR", "B", true);
  const legacy = parseLearningInput({
    ...converted.input,
    schemaVersion: "ENGINE_LEARNING_RESEARCH_V1",
    engineSource: oldSource,
    featureProfile: legacyEngineFeatureProfile,
    decisions: rows.decisions,
    outcomes: rows.outcomes,
  });
  assert.equal(evaluateLearning(legacy).featuresRebuiltFromSource, false);
  assert.throws(() =>
    parseLearningInput({
      ...legacy,
      schemaVersion: "ENGINE_LEARNING_RESEARCH_V2",
    }),
  );
  assert.throws(() =>
    parseLearningInput({
      ...converted.input,
      schemaVersion: "ENGINE_LEARNING_RESEARCH_V1",
    }),
  );
  assert.throws(() =>
    parseLearningInput({
      ...converted.input,
      featureProfile: legacyEngineFeatureProfile,
    }),
  );
});
test("RVOL-BRIDGE-07 학습 등록·재조회·입력 변조·근거 플래그 위조 차단", () => {
  const registry = new LearningRegistry(bridgeSandbox());
  try {
    registry.register(converted.input);
    const first = registry.run(converted.input!.experimentId);
    const second = registry.run(converted.input!.experimentId);
    assert.equal(first.report.featuresRebuiltFromSource, true);
    assert.equal(second.reused, true);
    assert.equal(first.report.reportHash, second.report.reportHash);
  } finally {
    registry.close();
  }
  const other = new LearningRegistry(bridgeSandbox());
  try {
    other.register(converted.input);
    assert.throws(
      () =>
        other.run(converted.input!.experimentId, (input) => {
          const r = evaluateLearning(input);
          r.featuresRebuiltFromSource = false;
          r.reportHash = hash(
            Object.fromEntries(
              Object.entries(r).filter(([k]) => k !== "reportHash"),
            ),
          );
          return r;
        }),
      /LEARNING_REPORT_INVALID/,
    );
  } finally {
    other.close();
  }
});
test("RVOL-BRIDGE-08 원본 근거 캡처 오류는 판단·주문·학습 기록 모두 롤백", () => {
  const p = new PortfolioProgram(raw, plan.settings),
    engine = new PortfolioPaperEngine(p, ":memory:", { captureLearning: true });
  try {
    engine.command("start", { type: "start" });
    const before = engine.state();
    p.learningFeatureSource = () => {
      throw new Error("TEST_CAPTURE_FAILURE");
    };
    assert.throws(
      () => engine.command("first", plan.ticks[0]!),
      /TEST_CAPTURE_FAILURE/,
    );
    assert.deepEqual(engine.state(), before);
  } finally {
    engine.close();
  }
});
test("RVOL-BRIDGE-09 반복 재계산·읽기 전용 내보내기는 DB/입력 불변", () => {
  const bytes = readFileSync(path),
    digest = hash(source);
  assert.deepEqual(convertPaperLearning(source, bridgePlan(source)), converted);
  assert.deepEqual(exportPaperLearning(path), source);
  assert.equal(hash(source), digest);
  assert.deepEqual(readFileSync(path), bytes);
});
