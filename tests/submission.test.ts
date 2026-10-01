import { test } from "node:test";
import assert from "node:assert/strict";
import { configured, run } from "./helpers.js";
import { submissionReasons } from "../src/core/submission.js";
import { bindSnapshot } from "../src/core/policy.js";
test("COMMAND-03 부분 batch 재시도도 원 요청 바인딩 유지", async () => {
  const e = await configured();
  try {
    const id = "interrupted-batch-test";
    e.repo.transact(
      `${id}_batch_intent`,
      { type: "STEP_BATCH_INTENT", command: { type: "step", seconds: 10 } },
      (s) => s!,
    );
    await assert.rejects(
      e.command(id, { type: "step", seconds: 20 }),
      /COMMAND_ID_CONFLICT/,
    );
    await e.command(id, { type: "step", seconds: 10 });
    const clock = e.state().clock;
    await e.command(id, { type: "step", seconds: 10 });
    assert.equal(e.state().clock, clock);
  } finally {
    e.close();
  }
});
test("SUBMIT-01 승인 뒤 수량/FX/비용/epoch/TTL 변조 거절", async () => {
  const e = await configured();
  try {
    await run(e, "start");
    const s = e.state(),
      o = s.orders[0]!;
    const q = {
      ask: o.limit,
      bid: "21400",
      askSize: 10000,
      bidSize: 10000,
      lastMinuteVolume: 40000,
      at: s.clock,
      halted: false,
    };
    assert.deepEqual(submissionReasons(s, o, q), []);
    for (const changed of [
      { ...o, quantity: o.quantity + 1 },
      { ...o, epoch: o.epoch + 1 },
      { ...o, snapshot: { ...o.snapshot, estimated_cost: "999" } },
    ])
      assert.ok(submissionReasons(s, changed, q).length);
    const fx = structuredClone(s);
    fx.ledger.fx = "1400";
    fx.orders[0]!.snapshot!.fx_rate = "2";
    fx.orders[0]!.snapshotHash = bindSnapshot(fx.orders[0]!.snapshot!);
    assert.ok(
      submissionReasons(fx, fx.orders[0]!, q).includes(
        "APPROVAL_INPUT_CHANGED",
      ),
    );
    s.clock += 31000;
    assert.ok(
      submissionReasons(s, o, { ...q, at: s.clock }).includes("SIGNAL_EXPIRED"),
    );
  } finally {
    e.close();
  }
});
test("SUBMIT-02 실제 엔진 접수 전 승인 변조는 주문 거절", async () => {
  const e = await configured();
  try {
    await run(e, "start");
    e.repo.transact("test-alter-snapshot", { test: true }, (s) => {
      s!.orders[0]!.snapshot!.quantity = 999;
      return s!;
    });
    await run(e, "step", { seconds: 2 });
    assert.equal(e.state().orders[0]!.status, "REJECTED");
    assert.equal(e.state().positions.length, 0);
    assert.equal(e.state().orders[0]!.reservationRisk, "0");
  } finally {
    e.close();
  }
});
