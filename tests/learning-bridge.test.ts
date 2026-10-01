import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PortfolioProgram } from "../src/core/portfolio-program.js";
import { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import { portfolioFixture, laterTick } from "../src/core/portfolio-fixture.js";
import { learningJournal } from "../src/core/paper-learning-capture.js";
import { exportPaperLearning } from "../src/server/paper-learning-export.js";
import { derivePaperRows } from "../src/core/paper-learning-convert.js";
import { verifyPaperExport } from "../src/core/paper-learning-verify.js";
import { convertPaperLearning } from "../src/core/paper-learning.js";
import { parseLearningInput } from "../src/core/learning-schema.js";
import { evaluateLearning } from "../src/core/learning.js";
import { buildLearningData } from "../src/core/learning-data.js";
import { bindSnapshot, hash } from "../src/core/policy.js";
import { d, sum } from "../src/core/math.js";
import { replayFixture } from "./signal-replay-helpers.js";
import { bridgePlan, resign } from "./learning-bridge-helpers.js";
import { makeSignalReplayFixture } from "../src/core/signal-replay-fixture.js";
import { minute } from "../src/core/calendar.js";

const input = replayFixture(),
  fixture = portfolioFixture(input),
  program = new PortfolioProgram(input, fixture.settings),
  base = fixture.ticks[0]!;
function create(capture = true) {
  const path = join(
    mkdtempSync(join(tmpdir(), "bridge-core-")),
    "paper.sqlite",
  );
  return {
    path,
    e: new PortfolioPaperEngine(program, path, { captureLearning: capture }),
  };
}
const completed = create();
for (const [i, c] of fixture.commands.entries())
  completed.e.command(`plan-${i}`, c);
completed.e.close();
const source = exportPaperLearning(completed.path);

test("BRIDGE-01 실제 엔진 부분 체결·판단·수수료·청산 연결", () => {
  assert.equal(source.journal.decisions.length, 4);
  assert.equal(source.journal.closures.length, 2);
  assert.ok(source.journal.fills.length > 4);
  assert.ok(source.journal.fills.every((f) => f.quantity === 1));
  const { input: learning, report } = convertPaperLearning(
    source,
    bridgePlan(source),
  );
  assert.equal(report.convertedDecisions, 1);
  assert.equal(report.closedOutcomes, 1);
  assert.equal(report.diagnostics.length, 4);
  const pInput = convertPaperLearning(source, {
    ...bridgePlan(source),
    signal: "P",
  }).input!;
  assert.equal(pInput.decisions.length, 1);
  assert.equal(pInput.decisions[0]!.signal, "P");
  assert.equal(learning!.dataOrigin, "ENGINE_RECORDED_SYNTHETIC");
  const data = buildLearningData(learning!);
  assert.equal(data.eligible, 1);
  for (const r of data.rows) {
    const p = source.positions.find(
      (p) => hash(p.symbol) === r.decision.instrumentId,
    )!;
    assert.equal(
      r.netR,
      d(p.exitValue)
        .minus(p.buyValue)
        .minus(p.entryFees)
        .minus(p.exitFees)
        .div(r.decision.riskUnit)
        .toNumber(),
    );
  }
  const result = evaluateLearning(learning);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.folds.every((f) => f.model === null));
  assert.equal(result.profitabilityValidated, false);
});
test("BRIDGE-02 읽기 전용 반복 내보내기와 기록 미활성 원본 보존", () => {
  const bytes = readFileSync(completed.path),
    a = exportPaperLearning(completed.path),
    b = exportPaperLearning(completed.path);
  assert.deepEqual(a, b);
  assert.deepEqual(readFileSync(completed.path), bytes);
  const { e, path } = create(false);
  e.close();
  const old = readFileSync(path);
  assert.throws(() => exportPaperLearning(path), /CAPTURE_NOT_ENABLED/);
  assert.throws(
    () =>
      new PortfolioPaperEngine(program, path, {
        resume: true,
        captureLearning: true,
      }),
    /NEW_RUN_REQUIRED/,
  );
  assert.deepEqual(readFileSync(path), old);
});
test("BRIDGE-03 명령 멱등·실패 롤백 후 재시도는 기록도 한 번", () => {
  const { e } = create();
  try {
    e.command("start", { type: "start" });
    e.command("frame", base);
    e.command("t1", laterTick(base, 1));
    const before = e.state();
    e.repo.failure = "DISK_FULL";
    assert.throws(() => e.command("t2", laterTick(base, 2)), /DISK_FULL/);
    assert.deepEqual(e.state(), before);
    e.repo.failure = null;
    e.command("t2", laterTick(base, 2));
    const after = e.state();
    e.command("t2", laterTick(base, 2));
    assert.deepEqual(e.state(), after);
    assert.equal(learningJournal(after)!.fills.length, 1);
  } finally {
    e.repo.failure = null;
    e.close();
  }
});
test("BRIDGE-04 부분 체결·취소 중 체결·미청산은 미확정 결과", () => {
  const { e, path } = create();
  try {
    e.command("start", { type: "start" });
    e.command("frame", base);
    e.command("t1", laterTick(base, 1));
    e.command("t2", laterTick(base, 2));
    e.command("pause", { type: "pause" });
    e.command("t3", laterTick(base, 3));
    e.command("t4", laterTick(base, 4));
    const rows = derivePaperRows(exportPaperLearning(path), "KR", "B");
    assert.equal(rows.outcomes[0]!.kind, "UNRESOLVED");
    assert.equal(rows.outcomes[0]!.grossPnl, null);
    assert.equal(rows.outcomes[0]!.costs, null);
    assert.equal(learningJournal(e.state())!.fills.length, 2);
  } finally {
    e.close();
  }
});
test("BRIDGE-05 승인 후 무체결 취소는 손익 0의 완료 거래가 아님", () => {
  const { e, path } = create();
  try {
    e.command("start", { type: "start" });
    e.command("frame", base);
    e.command("pause", { type: "pause" });
    const rows = derivePaperRows(exportPaperLearning(path), "KR", "B");
    assert.equal(rows.outcomes[0]!.kind, "UNRESOLVED");
    assert.ok(
      rows.diagnostics.some((d) => d.reasons.includes("ENTRY_NOT_FILLED")),
    );
  } finally {
    e.close();
  }
});
test("BRIDGE-06 기록 재시작 후 보존·중복 없이 청산 대조", () => {
  const created = create();
  let e = created.e;
  e.command("start", { type: "start" });
  e.command("frame", base);
  e.command("t1", laterTick(base, 1));
  e.command("t2", laterTick(base, 2));
  const before = learningJournal(e.state())!;
  e.close();
  e = new PortfolioPaperEngine(program, created.path, { resume: true });
  try {
    assert.deepEqual(learningJournal(e.state()), before);
    for (let i = 3; i <= 4; i++) e.command(`t${i}`, laterTick(base, i));
    e.command("liq", { type: "liquidate", confirm: true });
    for (let i = 5; i <= 14; i++) e.command(`t${i}`, laterTick(base, i));
    const x = exportPaperLearning(created.path);
    assert.equal(x.journal.closures.length, 1);
    assert.equal(
      derivePaperRows(x, "KR", "B").outcomes[0]!.kind,
      "SIMULATED_CLOSED",
    );
  } finally {
    e.close();
  }
});
test("BRIDGE-07 JSON 해시를 다시 계산해도 수량·금액·비용·연결 오류 거절", () => {
  const changes = [
    (x: typeof source) => {
      x.journal.fills[0]!.quantity++;
    },
    (x: typeof source) => {
      x.journal.fills[0]!.fee = "0";
    },
    (x: typeof source) => {
      x.orders[0]!.value = "1";
    },
    (x: typeof source) => {
      x.positions[0]!.exitFees = "0";
    },
    (x: typeof source) => {
      x.journal.fills[0]!.currency = "USD";
    },
    (x: typeof source) => {
      x.journal.closures[0]!.netPnlKrw = "999";
    },
    (x: typeof source) => {
      x.journal.fills.push(x.journal.fills[0]!);
    },
  ];
  for (const change of changes) {
    const x = structuredClone(source);
    change(x);
    assert.throws(() => verifyPaperExport(resign(x)));
  }
});
test("BRIDGE-08 미래 특징/체결·누락 청산·원본 프로필 변경 거절", () => {
  for (const change of [
    (x: typeof source) => {
      x.journal.decisions[0]!.trace[0]!.as_of = x.asOf + 1;
    },
    (x: typeof source) => {
      x.journal.fills[0]!.at = x.asOf + 1;
    },
    (x: typeof source) => {
      x.journal.closures = [];
    },
    (x: typeof source) => {
      x.journal.profileHash = "a".repeat(64);
    },
    (x: typeof source) => {
      x.journal.fills.pop();
    },
  ]) {
    const x = structuredClone(source);
    change(x);
    assert.throws(() => verifyPaperExport(resign(x)));
  }
});
test("BRIDGE-09 RVOL 누락은 임의 특징/위험 값 없이 제외 사유 보존", () => {
  const x = structuredClone(source);
  for (const dec of x.journal.decisions)
    dec.trace = dec.trace.filter((t) => !t.predicate_id.endsWith("_RVOL"));
  const converted = convertPaperLearning(resign(x), bridgePlan(x));
  assert.equal(converted.input, null);
  assert.equal(converted.report.diagnostics.length, 4);
  assert.ok(
    converted.report.diagnostics.some((d) =>
      d.reasons.includes("RVOL_FEATURE_MISSING_OR_INVALID"),
    ),
  );
});
test("BRIDGE-10 엔진 증거와 파생 학습 행 불일치/출처 강등 거절", () => {
  const original = convertPaperLearning(source, bridgePlan(source)).input!;
  for (const change of [
    (x: typeof original) => {
      x.decisions[0]!.features[0] = 999;
    },
    (x: typeof original) => {
      x.outcomes[0]!.grossPnl = "999";
    },
    (x: typeof original) => {
      x.decisions[0]!.riskUnit = "1";
    },
    (x: typeof original) => {
      delete x.engineSource;
    },
    (x: typeof original) => {
      x.schemaVersion = "LEARNING_RESEARCH_V1";
    },
    (x: typeof original) => {
      x.dataOrigin = "DECLARED_SYNTHETIC";
    },
  ]) {
    const x = structuredClone(original);
    change(x);
    assert.throws(() => parseLearningInput(x), /INPUT_INVALID/);
  }
});
test("BRIDGE-11 비배분 운영 비용은 누락 비용 0으로 승격하지 않음", () => {
  const x = structuredClone(source);
  x.costs.push({ id: "research-test", at: x.asOf, amount: "1", paid: false });
  const rows = derivePaperRows(resign(x), "KR", "B");
  assert.ok(
    rows.outcomes.every((o) => o.kind === "UNRESOLVED" && o.costs === null),
  );
});
for (const estimatedOperating of ["0", "2"] as const) {
  test(`BRIDGE-16 명시 시험 이력 추정 ${estimatedOperating}원은 빈 비용 원장에서도 확정 학습으로 승격하지 않음`, () => {
    const x = structuredClone(source);
    assert.equal(x.costs.length, 0);
    const order = x.orders.find(
      (o) =>
        o.side === "BUY" &&
        o.snapshot?.market === "KR" &&
        o.snapshot.strategy_version === "B:1.0",
    )!;
    assert.ok(order?.snapshot);
    const binding = order.snapshot.operating_cost_binding;
    assert.ok(binding && typeof binding === "object");
    assert.equal((binding as { source: unknown }).source, "SYNTHETIC_ZERO");
    // 합성 내보내기의 표식만 변경한다. 승인 이력/발생 의무/확정 배분을
    // 생성했다는 의미가 아니며, 미지원 표식의 보수적 변환 경계를 시험한다.
    order.snapshot.operating_cost_binding = {
      ...binding,
      source: "EXPLICIT_TEST_HISTORY",
      evidenceHash: hash(["BRIDGE-16", estimatedOperating]),
    };
    order.snapshot.estimated_operating_cost_krw = estimatedOperating;
    order.snapshotHash = bindSnapshot(order.snapshot);
    const decision = x.journal.decisions.find(
      (entry) => entry.id === order.snapshot!.signal_id,
    )!;
    assert.ok(decision);
    decision.snapshotHash = order.snapshotHash;
    const signed = resign(x);
    assert.doesNotThrow(() => verifyPaperExport(signed));
    const rows = derivePaperRows(signed, "KR", "B");
    assert.equal(rows.decisions.length, 1);
    assert.equal(rows.outcomes.length, 1);
    assert.equal(rows.outcomes[0]!.kind, "UNRESOLVED");
    assert.equal(rows.outcomes[0]!.grossPnl, null);
    assert.equal(rows.outcomes[0]!.costs, null);
    assert.equal(rows.outcomes[0]!.closedAt, null);
    assert.ok(
      rows.diagnostics.some(
        (entry) =>
          entry.sourceDecisionId === decision.id &&
          entry.reasons.includes("OPERATING_COST_ALLOCATION_UNSUPPORTED"),
      ),
    );
    // 수정되지 않은 기존 합성 무비용 원본은 여전히 완료 결과를 제공한다.
    const baseline = derivePaperRows(source, "KR", "B");
    assert.equal(baseline.outcomes[0]!.kind, "SIMULATED_CLOSED");
    assert.equal(baseline.outcomes[0]!.costs!.operation, "0");
    assert.equal(source.costs.length, 0);
  });
}
test("BRIDGE-17 새 비용 표식의 누락·구조·버전·위험일 변조는 보류", () => {
  for (const mode of [
    "binding-only",
    "amount-only",
    "source-only",
    "unknown-version",
    "wrong-window",
    "bad-hash",
    "legacy",
  ] as const) {
    const x = structuredClone(source);
    const order = x.orders.find(
      (o) =>
        o.side === "BUY" &&
        o.snapshot?.market === "KR" &&
        o.snapshot.strategy_version === "B:1.0",
    )!;
    const snap = order.snapshot!;
    if (mode === "binding-only" || mode === "legacy")
      delete snap.estimated_operating_cost_krw;
    if (mode === "amount-only" || mode === "legacy")
      delete snap.operating_cost_binding;
    if (mode === "source-only")
      snap.operating_cost_binding = { source: "SYNTHETIC_ZERO" };
    const binding = snap.operating_cost_binding as Record<string, unknown>;
    if (mode === "unknown-version") binding.contract = "UNKNOWN";
    if (mode === "bad-hash") binding.evidenceHash = "missing";
    if (mode === "wrong-window")
      (binding.window as { endExclusive: number }).endExclusive += 1;
    order.snapshotHash = bindSnapshot(snap);
    x.journal.decisions.find(
      (entry) => entry.id === snap.signal_id,
    )!.snapshotHash = order.snapshotHash;
    const signed = resign(x);
    assert.doesNotThrow(() => verifyPaperExport(signed));
    const rows = derivePaperRows(signed, "KR", "B");
    assert.equal(
      rows.outcomes[0]!.kind,
      mode === "legacy" ? "SIMULATED_CLOSED" : "UNRESOLVED",
      mode,
    );
    if (mode !== "legacy")
      assert.ok(
        rows.diagnostics.some((entry) =>
          entry.reasons.includes("OPERATING_COST_ALLOCATION_UNSUPPORTED"),
        ),
        mode,
      );
  }
});
test("BRIDGE-12 데이터/감사 꼬리 변경 및 다른 DB 거절·읽기 전용", () => {
  const { e, path } = create();
  e.command("start", { type: "start" });
  e.close();
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM audit WHERE seq=(SELECT max(seq) FROM audit)");
  db.close();
  const bytes = readFileSync(path);
  assert.throws(() => exportPaperLearning(path), /AUDIT_INVALID/);
  assert.deepEqual(readFileSync(path), bytes);
  const alien = join(
      mkdtempSync(join(tmpdir(), "bridge-alien-")),
      "paper.sqlite",
    ),
    a = new DatabaseSync(alien);
  a.exec("CREATE TABLE kept(id TEXT)");
  a.close();
  const kept = readFileSync(alien);
  assert.throws(() => exportPaperLearning(alien));
  assert.deepEqual(readFileSync(alien), kept);
});
test("BRIDGE-13 계획 위험은 체결 수량 변경으로 재정의하지 않음", () => {
  const rows = derivePaperRows(source, "KR", "B");
  for (const row of rows.decisions) {
    const p = source.positions.find(
        (p) => hash(p.symbol) === row.instrumentId,
      )!,
      o = source.orders.find((o) => o.id === p.intentId)!;
    assert.equal(
      row.riskUnit,
      d(o.limit)
        .minus(String(o.snapshot!.stop_price))
        .mul(o.quantity)
        .toString(),
    );
    assert.ok(
      sum(
        source.journal.fills
          .filter((f) => f.positionId === p.id)
          .map((f) => f.fee),
      ).eq(d(p.entryFees).plus(p.exitFees)),
    );
  }
});
test("BRIDGE-14 미국 체결의 달러 순손익과 원화 장부 값 분리", () => {
  const us = makeSignalReplayFixture("US");
  for (const h of us.histories)
    for (const s of h.sessions.slice(0, -1)) {
      s.closeAt = s.openAt + 60 * minute;
      s.rows = s.rows.filter((r) => r.offset < 60);
    }
  const f = portfolioFixture(us);
  f.settings.config.usdCapitalKrw = 2000000;
  f.settings.config.level = "MEDIUM";
  f.settings.config.stage = "STANDARD";
  const p = new PortfolioProgram(us, f.settings),
    path = join(mkdtempSync(join(tmpdir(), "bridge-us-")), "paper.sqlite"),
    e = new PortfolioPaperEngine(p, path, { captureLearning: true });
  try {
    for (const [i, c] of f.commands.entries()) e.command(`us-${i}`, c);
    const x = exportPaperLearning(path),
      converted = convertPaperLearning(x, bridgePlan(x, "US"));
    assert.equal(converted.input!.decisions.length, 1);
    const outcome = converted.input!.outcomes[0]!,
      native = d(outcome.grossPnl!).minus(outcome.costs!.commission),
      position = x.positions.find(
        (p) => hash(p.symbol) === converted.input!.decisions[0]!.instrumentId,
      )!;
    assert.equal(outcome.currency, "USD");
    assert.ok(
      native
        .mul(x.journal.closures.find((c) => c.positionId === position.id)!.fx)
        .eq(position.netPnl!),
    );
    assert.ok(!native.eq(position.netPnl!));
    assert.deepEqual(
      { ...outcome.costs, commission: "ignored" },
      {
        commission: "ignored",
        tax: "0",
        slippage: "0",
        fx: "0",
        operation: "0",
      },
    );
    assert.equal(derivePaperRows(x, "KR", "B").decisions.length, 0);
  } finally {
    e.close();
  }
});
test("BRIDGE-15 기록 활성화는 기존 모의 판단/주문/장부의 계산을 바꾸지 않음", () => {
  const { e } = create(false);
  try {
    for (const [i, c] of fixture.commands.entries()) e.command(`plan-${i}`, c);
    const expected = e.state(),
      db = new DatabaseSync(completed.path, { readOnly: true });
    let actual;
    try {
      actual = JSON.parse(
        String(db.prepare("SELECT body FROM aggregate WHERE id=1").get()!.body),
      );
    } finally {
      db.close();
    }
    delete actual.manifest.learningJournal;
    assert.deepEqual(actual, expected);
  } finally {
    e.close();
  }
});
