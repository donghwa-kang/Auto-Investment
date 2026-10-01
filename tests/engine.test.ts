import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configured, run, state, config } from "./helpers.js";
import { Engine } from "../src/server/engine.js";
import { Repository } from "../src/server/repository.js";
import { hash } from "../src/core/policy.js";
import { equity, caps } from "../src/core/ledger.js";
import { openRisk } from "../src/core/risk.js";
import { applyOrderEvent } from "../src/core/simulator.js";
import { terminal, type Position } from "../src/core/types.js";
import type { State } from "../src/core/types.js";
import type { Evaluation } from "../src/core/strategy.js";
test("RESERVE-02 서로 다른 동시 후보의 실제 결정 함수·SQLite 예약 직렬화", async () => {
  const e = await configured();
  try {
    const ready = Reflect.get(e, "prepared") as { evaluation: Evaluation };
    const decide = Reflect.get(e, "decide") as (
      s: State,
      value: Evaluation,
    ) => void;
    await Promise.all(
      ["DEMO-KR-001", "DEMO-KR-002"].map(async (symbol) => {
        e.repo.transact(
          `candidate-${symbol}`,
          { test: "correlated-synthetic-candidate", symbol },
          (s) => {
            const signal = structuredClone(ready.evaluation);
            signal.symbol = symbol;
            s!.status = "RUNNING";
            decide.call(e, s!, signal);
            return s!;
          },
        );
      }),
    );
    const s = e.state();
    assert.equal(s.decisions.length, 2);
    assert.equal(new Set(s.decisions.map((x) => x.id)).size, 2);
    assert.equal(s.orders.length, 1);
    assert.equal(s.decisions[1]!.result, "ABSTAIN");
    assert.ok(s.decisions[1]!.reasons.includes("POSITION_LIMIT"));
    assert.ok(openRisk(s).lte(caps(s).risk));
  } finally {
    e.close();
  }
});
const dbPath = () =>
  join(mkdtempSync(join(tmpdir(), "paper-lab-test-")), "test.sqlite");
test("E2E-CORE-01 합성 120세션 1분봉부터 B 주문·보호·귀속 청산", async () => {
  const e = await configured();
  try {
    await run(e, "start");
    const a = e.state();
    assert.equal(a.decisions[0]!.result, "APPROVED");
    assert.equal(a.decisions[0]!.quantity, 4);
    assert.equal(a.orders[0]!.status, "INTENT_SAVED");
    assert.equal(a.positions.length, 0);
    await run(e, "step", { seconds: 2 });
    assert.equal(e.state().orders[0]!.filled, 1);
    assert.equal(e.state().positions[0]!.protectedQuantity, 1);
    await run(e, "step", { seconds: 8 });
    assert.equal(e.state().positions[0]!.quantity, 4);
    await run(e, "pause");
    assert.equal(e.state().positions[0]!.protection, "WATCHING");
    await run(e, "liquidate", { confirm: true });
    await run(e, "step", { seconds: 10 });
    const end = e.state();
    assert.equal(end.positions[0]!.quantity, 0);
    assert.equal(end.positions[0]!.protection, "CLOSED_RECONCILED");
    assert.ok(end.orders.every(terminal));
    assert.equal(end.ledger.entries, 1);
    assert.equal(end.ledger.intents, 1);
    assert.ok(e.repo.verifyAudit() > 5);
  } finally {
    e.close();
  }
});
test("E2E-CORE-02 예측 없으면 기본 ABSTAIN", async () => {
  const e = await configured({ forecast: "MISSING_PROFILE" });
  try {
    await run(e, "start");
    assert.ok(
      e.state().decisions[0]!.reasons.includes("MISSING_FORECAST_PROFILE"),
    );
    assert.equal(e.state().orders.length, 0);
  } finally {
    e.close();
  }
});
test("E2E-CORE-03 P 원천 경로 및 음성 시나리오", async () => {
  const p = await configured({ scenario: "P" });
  try {
    await run(p, "start");
    assert.equal(p.state().decisions[0]!.strategy, "P");
    assert.equal(p.state().decisions[0]!.result, "APPROVED");
  } finally {
    p.close();
  }
  const n = await configured({ scenario: "NO_SIGNAL" });
  try {
    await run(n, "start");
    assert.equal(n.state().orders.length, 0);
    assert.ok(n.state().decisions[0]!.reasons.includes("CHART_NO_SIGNAL"));
  } finally {
    n.close();
  }
});
test("ORDER-01 같은 명령/동시 후보 예약 중복 없음", async () => {
  const e = await configured();
  try {
    const id = randomUUID();
    await Promise.all([
      e.command(id, { type: "start" }),
      e.command(id, { type: "start" }),
      run(e, "start"),
    ]);
    assert.equal(e.state().orders.length, 1);
    assert.equal(e.state().ledger.intents, 1);
    assert.ok(openRisk(e.state()).lte(caps(e.state()).risk));
    await assert.rejects(e.command(id, { type: "pause" }), /CONFLICT/);
  } finally {
    e.close();
  }
});
test("ORDER-02 부분 체결·취소 중 늦은 체결·예약 확정 해제", async () => {
  const e = await configured({ scenario: "PARTIAL_CANCEL" });
  try {
    await run(e, "start");
    await run(e, "step", { seconds: 2 });
    assert.equal(e.state().orders[0]!.status, "CANCEL_PENDING");
    const reserved = e.state().orders[0]!.reservationRisk;
    assert.notEqual(reserved, "0");
    await run(e, "step", { seconds: 1 });
    assert.equal(e.state().orders[0]!.filled, 2);
    assert.notEqual(e.state().orders[0]!.reservationRisk, "0");
    await run(e, "step", { seconds: 1 });
    assert.equal(e.state().orders[0]!.status, "CANCELLED");
    assert.equal(e.state().orders[0]!.reservationRisk, "0");
    assert.equal(e.state().positions[0]!.quantity, 2);
  } finally {
    e.close();
  }
});
test("ORDER-03 UNKNOWN 예약 유지·재제출/대조 성공 위장 금지", async () => {
  const e = await configured({ scenario: "UNKNOWN" });
  try {
    await run(e, "start");
    await run(e, "step", { seconds: 20 });
    assert.equal(e.state().orders[0]!.status, "UNKNOWN");
    assert.notEqual(e.state().orders[0]!.reservationRisk, "0");
    await assert.rejects(run(e, "reconcile"), /UNKNOWN_UNRESOLVED/);
    await assert.rejects(run(e, "start"), /PREFLIGHT_BLOCKED/);
    assert.equal(e.state().orders.length, 1);
  } finally {
    e.close();
  }
});
test("ORDER-04 중복·역순 체결 누적 감소·이중 비용 없음", async () => {
  const e = await configured();
  try {
    await run(e, "start");
    await run(e, "step", { seconds: 2 });
    const s = e.state(),
      o = s.orders[0]!;
    const before = equity(s).toString(),
      quantity = s.positions[0]!.quantity;
    const ev = {
      id: o.eventIds[0]!,
      version: o.version,
      cumulativeFilled: o.filled,
      cumulativeValue: o.value,
      status: o.status,
    };
    applyOrderEvent(s, o, ev);
    applyOrderEvent(s, o, {
      ...ev,
      id: "older-event",
      version: o.version - 1,
      cumulativeFilled: 0,
      cumulativeValue: "0",
    });
    assert.equal(s.positions[0]!.quantity, quantity);
    assert.equal(equity(s).toString(), before);
    assert.throws(() =>
      applyOrderEvent(s, o, {
        ...ev,
        id: "invalid",
        version: o.version + 1,
        cumulativeFilled: o.quantity + 1,
      }),
    );
  } finally {
    e.close();
  }
});
test("STOP-01 미제출 승인 중지는 체결 없이 즉시 폐기", async () => {
  const e = await configured();
  try {
    await run(e, "start");
    await run(e, "pause");
    await run(e, "step", { seconds: 10 });
    assert.equal(e.state().orders[0]!.status, "CANCELLED");
    assert.equal(e.state().positions.length, 0);
  } finally {
    e.close();
  }
});
test("EXIT-01 갭 손절 지정가 미체결을 완료로 표시하지 않음", async () => {
  const e = await configured({ scenario: "GAP" });
  try {
    await run(e, "start");
    await run(e, "step", { seconds: 25 });
    const s = e.state();
    assert.ok(s.positions[0]!.quantity > 0);
    assert.equal(s.positions[0]!.protection, "EXIT_BLOCKED");
    assert.equal(s.status, "EXIT_BLOCKED");
    assert.notEqual(s.positions[0]!.protection, "CLOSED_RECONCILED");
  } finally {
    e.close();
  }
});
test("EXIT-02 보호 실패 신규 진입 중단", async () => {
  const e = await configured({ scenario: "PROTECTION_FAILURE" });
  try {
    await run(e, "start");
    await run(e, "step", { seconds: 8 });
    assert.ok(e.state().ledger.halts.includes("PROTECTION_FAILURE"));
    assert.notEqual(e.state().status, "RUNNING");
  } finally {
    e.close();
  }
});
test("EXIT-03 수동 귀속 수량 청산 제외·과매도 차단", async () => {
  const e = await configured();
  try {
    await run(e, "start");
    await run(e, "step", { seconds: 10 });
    e.repo.transact(randomUUID(), { test: "manual" }, (s) => {
      const p: Position = {
        ...s!.positions[0]!,
        id: "manual",
        intentId: "manual",
        owner: "MANUAL",
        quantity: 3,
        buyQuantity: 3,
      };
      s!.positions.push(p);
      return s!;
    });
    await run(e, "liquidate", { confirm: true });
    await run(e, "step", { seconds: 20 });
    assert.equal(
      e.state().positions.find((p) => p.id === "manual")!.quantity,
      3,
    );
    assert.equal(
      e.state().positions.find((p) => p.owner === "BOT")!.quantity,
      0,
    );
  } finally {
    e.close();
  }
});
test("LEVEL-01 상향 조건 및 하향 초과 청산 대기/손절 보존", async () => {
  const e = await configured({ level: "HIGH" });
  try {
    await run(e, "start");
    await run(e, "step", { seconds: 10 });
    const stop = e.state().positions[0]!.stop;
    await run(e, "level", { level: "LOW", confirm: true });
    assert.equal(e.state().pendingLevel, "LOW");
    await run(e, "step", { seconds: 2 });
    assert.equal(e.state().status, "REDUCTION_PENDING");
    assert.equal(e.state().positions[0]!.stop, stop);
    await assert.rejects(
      run(e, "level", { level: "HIGH", confirm: true }),
      /RAISE_REQUIRES/,
    );
    await run(e, "step", { seconds: 40 });
    assert.equal(e.state().positions[0]!.quantity, 0);
    assert.equal(e.state().config!.level, "LOW");
    assert.equal(e.state().ledger.intents, 1);
    assert.equal(e.state().epoch, 2);
  } finally {
    e.close();
  }
});
test("RECOVERY-01 저장/의도/부분체결 후 재시작은 RECONCILING", async () => {
  for (const seconds of [0, 1, 2, 10]) {
    const path = dbPath();
    const e = await configured({}, path);
    await run(e, "start");
    if (seconds) await run(e, "step", { seconds });
    const before = e.state();
    e.close();
    const restored = new Engine(path);
    try {
      assert.equal(restored.state().status, "RECONCILING");
      assert.equal(restored.state().ledger.intents, 1);
      assert.equal(
        restored.state().positions.reduce((a, p) => a + p.quantity, 0),
        before.positions.reduce((a, p) => a + p.quantity, 0),
      );
      await assert.rejects(run(restored, "start"), /PREFLIGHT_BLOCKED/);
      assert.ok(restored.repo.verifyAudit() > 0);
    } finally {
      restored.close();
    }
  }
});
test("WRITER-01 두 연결 경쟁 및 fencing 임대 인계", () => {
  let now = 0;
  const path = dbPath(),
    a = new Repository(path, () => now),
    b = new Repository(path, () => now);
  try {
    a.acquire();
    a.transact("initial-1", {}, () => state());
    assert.throws(() => b.acquire(), /WRITER_BUSY/);
    now = 11000;
    b.acquire();
    assert.throws(() => a.transact("stale-writer", {}, (s) => s!), /FENCED/);
    b.transact("new-writer", {}, (s) => s!);
    assert.equal(b.read()!.revision, 3);
  } finally {
    a.close();
    b.close();
  }
});
test("STORAGE-01 쓰기 실패 실제 SQLite 롤백·예약 재사용 안 함", async () => {
  const e = await configured();
  try {
    await run(e, "start");
    const before = hash(e.state());
    e.repo.failure = "DISK_FULL";
    await assert.rejects(run(e, "step", { seconds: 2 }), /DISK_FULL/);
    assert.equal(hash(e.state()), before);
    e.repo.failure = null;
    await run(e, "pause");
    assert.equal(e.state().positions.length, 0);
  } finally {
    e.repo.failure = null;
    e.close();
  }
});
test("STORAGE-02 SQLite 실제 DB lock 및 감사 변조 탐지", () => {
  const path = dbPath(),
    r = new Repository(path);
  r.acquire();
  r.transact("initial-2", {}, () => state());
  const other = new Repository(path);
  try {
    other.db.exec("BEGIN IMMEDIATE");
    assert.throws(() => r.transact("locked-write", {}, (s) => s!), /locked/);
    other.db.exec("ROLLBACK");
    assert.equal(r.read()!.revision, 2);
    r.db
      .prepare("UPDATE audit SET body=? WHERE seq=1")
      .run('{"tampered":true}');
    assert.throws(() => r.verifyAudit(), /AUDIT_CHAIN/);
  } finally {
    other.close();
    r.close();
  }
});
test("REPLAY-01 동일 자료·시계·모형 출력으로 결정/장부 재현", async () => {
  const a = await configured(),
    b = await configured();
  try {
    for (const e of [a, b]) {
      await run(e, "start");
      await run(e, "step", { seconds: 10 });
      await run(e, "liquidate", { confirm: true });
      await run(e, "step", { seconds: 10 });
    }
    assert.equal(hash(a.state().decisions), hash(b.state().decisions));
    assert.equal(hash(a.state().ledger), hash(b.state().ledger));
    assert.equal(hash(a.state().orders), hash(b.state().orders));
  } finally {
    a.close();
    b.close();
  }
});
test("MODE-02 조작 환경변수/가짜 크리덴셜로 LIVE 차단", () => {
  const original = process.env.TRADING_MODE;
  process.env.TRADING_MODE = "LIVE";
  process.env.TOSS_API_KEY = "DUMMY_NOT_A_CREDENTIAL";
  try {
    assert.throws(() => new Engine(":memory:"), /LIVE_LOCKED/);
  } finally {
    if (original === undefined) delete process.env.TRADING_MODE;
    else process.env.TRADING_MODE = original;
    delete process.env.TOSS_API_KEY;
  }
  assert.equal(config.mode, "PAPER");
});
