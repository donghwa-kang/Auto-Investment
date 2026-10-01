import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LearningRegistry } from "../src/server/learning-registry.js";
import { createLearningSample } from "../src/core/learning-sample.js";
import { evaluateLearning } from "../src/core/learning.js";
import { hash } from "../src/core/policy.js";

const sandbox = () => mkdtempSync(join(tmpdir(), "learning-registry-"));
test("LEARN-STORE-01 등록·실행·재시작·모델/원시 기록 보존·재실행은 조회만", () => {
  const directory = sandbox(),
    input = createLearningSample();
  let registry = new LearningRegistry(directory);
  assert.equal(registry.register(input).state, "REGISTERED");
  const first = registry.run(input.experimentId);
  assert.equal(first.reused, false);
  assert.equal(registry.status(input.experimentId).state, "COMPLETE");
  const path = registry.path;
  registry.close();
  registry = new LearningRegistry(directory, false);
  const second = registry.run(input.experimentId, () => {
    throw new Error("MUST_NOT_RETRAIN");
  });
  assert.equal(second.reused, true);
  assert.deepEqual(second.report, first.report);
  registry.close();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT input_json FROM experiments").get() as {
      input_json: string;
    };
    assert.deepEqual(JSON.parse(row.input_json), input);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n,
      3,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM exposures").get() as { n: number })
        .n,
      2,
    );
  } finally {
    db.close();
  }
});
test("LEARN-STORE-02 등록 멱등·동일 ID의 자료/설정 변경 금지", () => {
  const registry = new LearningRegistry(sandbox()),
    input = createLearningSample();
  try {
    assert.deepEqual(registry.register(input), registry.register(input));
    input.model.lambda = 2;
    assert.throws(
      () => registry.register(input),
      /LEARNING_EXPERIMENT_CONFLICT/,
    );
    assert.equal(registry.status(input.experimentId).state, "REGISTERED");
  } finally {
    registry.close();
  }
});
test("LEARN-STORE-03 실험 ID/모델/기호를 바꿔도 노출된 같은 시장 시험 구간은 재사용 거절", () => {
  const registry = new LearningRegistry(sandbox()),
    first = createLearningSample("first"),
    second = createLearningSample("second");
  second.model.lambda = 3;
  for (const d of second.decisions) d.instrumentId = "DIFFERENT-SYNTHETIC";
  for (let i = 0; i < second.outcomes.length; i++)
    second.outcomes[i]!.decisionHash = hash(second.decisions[i]);
  try {
    registry.register(first);
    registry.register(second);
    registry.run("first");
    assert.throws(
      () => registry.run("second"),
      /LEARNING_EVALUATION_WINDOW_USED/,
    );
    assert.equal(registry.status("second").state, "REGISTERED");
  } finally {
    registry.close();
  }
});
test("LEARN-STORE-04 오류가 나도 시도·노출 보존, 자동 재학습 금지", () => {
  const registry = new LearningRegistry(sandbox());
  try {
    registry.register(createLearningSample());
    assert.throws(
      () =>
        registry.run("learning-demo-v1", () => {
          throw new Error("FAKE_PRIVATE_FAULT");
        }),
      /^Error: LEARNING_EVALUATION_FAILED$/,
    );
    assert.equal(registry.status("learning-demo-v1").state, "FAILED");
    assert.throws(
      () => registry.run("learning-demo-v1"),
      /LEARNING_REVIEW_REQUIRED/,
    );
    registry.register(createLearningSample("other"));
    assert.throws(
      () => registry.run("other"),
      /LEARNING_EVALUATION_WINDOW_USED/,
    );
  } finally {
    registry.close();
  }
});
test("LEARN-STORE-05 SQLite 보고서 저장 실패는 완료 상태를 남기지 않음", () => {
  const registry = new LearningRegistry(sandbox());
  registry.register(createLearningSample());
  const db = new DatabaseSync(registry.path);
  db.exec(
    "CREATE TRIGGER fail_report BEFORE UPDATE OF report_json ON experiments WHEN NEW.report_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'TEST_SAVE_FAULT'); END;",
  );
  db.close();
  try {
    assert.throws(
      () => registry.run("learning-demo-v1"),
      /LEARNING_STORE_FAILED/,
    );
    assert.equal(registry.status("learning-demo-v1").state, "FAILED");
    assert.equal(registry.status("learning-demo-v1").reportHash, null);
  } finally {
    registry.close();
  }
});
test("LEARN-STORE-06 hash를 다시 계산해도 거래/검증 활성화 보고서는 거절", () => {
  const registry = new LearningRegistry(sandbox());
  registry.register(createLearningSample());
  try {
    assert.throws(
      () =>
        registry.run("learning-demo-v1", (input) => {
          const r = evaluateLearning(input);
          r.forecastValidated = true;
          const { reportHash: old, ...content } = r;
          assert.notEqual(old, hash(content));
          r.reportHash = hash(content);
          return r;
        }),
      /LEARNING_REPORT_INVALID/,
    );
    assert.equal(registry.status("learning-demo-v1").state, "FAILED");
  } finally {
    registry.close();
  }
});
test("LEARN-STORE-07 감사 체인 변조 탐지·자동 복원 없음", () => {
  const directory = sandbox(),
    registry = new LearningRegistry(directory);
  registry.register(createLearningSample());
  const path = registry.path;
  registry.close();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE audit SET event_hash=? WHERE seq=1").run("0".repeat(64));
  db.close();
  assert.throws(
    () => new LearningRegistry(directory),
    /LEARNING_REGISTRY_INTEGRITY/,
  );
});
test("LEARN-STORE-08 시험 노출 삭제로 재사용 차단을 우회하지 못함", () => {
  const directory = sandbox(),
    registry = new LearningRegistry(directory);
  registry.register(createLearningSample());
  registry.run("learning-demo-v1");
  const path = registry.path;
  registry.close();
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM exposures");
  db.close();
  assert.throws(
    () => new LearningRegistry(directory),
    /LEARNING_REGISTRY_INTEGRITY/,
  );
});
test("LEARN-STORE-09 다른 SQLite 파일을 수정하지 않고 거절", () => {
  const directory = sandbox(),
    root = join(directory, "data", "learning-lab");
  mkdirSync(root, { recursive: true });
  const path = join(root, "registry.sqlite"),
    db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES('KEEP');",
  );
  db.close();
  const before = readFileSync(path);
  assert.throws(
    () => new LearningRegistry(directory),
    /LEARNING_REGISTRY_INTEGRITY/,
  );
  assert.deepEqual(readFileSync(path), before);
});
test("LEARN-STORE-10 샘플 부족 보고서는 저장 가능하나 합격/모델 교체는 아님", () => {
  const registry = new LearningRegistry(sandbox()),
    input = createLearningSample();
  input.validation.minTrainRows = 100;
  try {
    registry.register(input);
    const { report } = registry.run(input.experimentId);
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.selectedModel, null);
    assert.equal(registry.status(input.experimentId).state, "COMPLETE");
  } finally {
    registry.close();
  }
});
