import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BrokerControlLab,
  brokerLabData,
} from "../src/server/broker-control-lab.js";
import {
  controlConfig,
  evidenceFor,
  labWithSell,
  labWithBuy,
  request,
} from "./broker-control-helpers.js";
import { sellProgram, sellOrder } from "./sell-unknown-helpers.js";
import { inspectOfflineGraph } from "./network-boundary.js";

const newPath = () =>
  join(mkdtempSync(join(tmpdir(), "broker-control-")), "test.sqlite");
test("D02 REVIEW confirmed write survives restart before transport close", () => {
  const path = newPath();
  const config = controlConfig();
  config.laneCapacity = 2;
  const lab = labWithSell(
    "UNKNOWN",
    path,
    false,
    (lab) => {
      lab.repo.transact("test-working", {}, (s) => {
        assert.ok(s);
        sellOrder(s).status = "WORKING";
        return s;
      });
      const s = lab.state(),
        r = request("restart-origin", "EXIT", s.clock, {
          orderId: sellOrder(s).id,
          timeoutMs: 100,
        });
      lab.command("enqueue", {
        kind: "CONTROL",
        command: { kind: "ENQUEUE", at: s.clock, request: r },
      });
      lab.command("dispatch", {
        kind: "CONTROL",
        command: { kind: "DISPATCH", at: s.clock, worker: "sim-worker" },
      });
      lab.command("timeout", {
        kind: "CONTROL",
        command: { kind: "ADVANCE", at: s.clock + 100 },
      });
      return [r.id];
    },
    config,
  );
  const evidence = evidenceFor(lab, "restart-proof", 2, "FILLED");
  const before = lab.command("confirmed", { kind: "RECONCILE", evidence });
  assert.equal(brokerLabData(before).control.records[0]!.status, "OK");
  assert.equal(
    brokerLabData(before).control.records[0]!.transportClosed,
    false,
  );
  lab.close();
  const resumed = new BrokerControlLab(sellProgram.initial(0), config, path, {
    resume: true,
  });
  try {
    const after = resumed.state(),
      data = brokerLabData(after);
    assert.equal(data.control.records[0]!.status, "OK");
    assert.equal(data.control.records[0]!.transportClosed, true);
    assert.deepEqual(after.orders, before.orders);
    assert.deepEqual(after.ledger, before.ledger);
    const ready = resumed.command("resume", {
      kind: "CONTROL",
      command: { kind: "RESUME", at: after.clock, epoch: data.control.epoch },
    });
    assert.equal(brokerLabData(ready).control.mode, "READY");
    assert.equal(ready.status, "RECONCILING");
  } finally {
    resumed.close();
  }
});
test("D02 entry timeout binds immutable request and consumes reserved receipts exactly once", () => {
  const lab = labWithBuy(
    "UNKNOWN",
    false,
    (lab) => {
      lab.repo.transact("test-working-buy", {}, (s) => {
        assert.ok(s);
        s.orders[0]!.status = "WORKING";
        return s;
      });
      const s = lab.state(),
        r = request("entry-origin", "ENTRY", s.clock, {
          orderId: s.orders[0]!.id,
          timeoutMs: 100,
        });
      lab.command("enqueue-entry", {
        kind: "CONTROL",
        command: { kind: "ENQUEUE", at: s.clock, request: r },
      });
      lab.command("dispatch-entry", {
        kind: "CONTROL",
        command: { kind: "DISPATCH", at: s.clock, worker: "sim-worker" },
      });
      lab.command("timeout-entry", {
        kind: "CONTROL",
        command: { kind: "ADVANCE", at: s.clock + 100 },
      });
      return [r.id];
    },
    controlConfig(4, 0),
  );
  try {
    const at = lab.state().clock;
    assert.throws(
      () =>
        lab.command("steal-reservation", {
          kind: "CONTROL",
          command: {
            kind: "ENQUEUE",
            at,
            request: request("steal", "ORDER_QUERY", at, {
              reservationFor: "sim-entry-origin",
              caseId: null,
            }),
          },
        }),
      /RESERVATION_CASE_MISMATCH/,
    );
    const e = evidenceFor(lab, "entry-proof", 4, "FILLED");
    let s = lab.command("proof", { kind: "RECONCILE", evidence: e });
    const records = brokerLabData(s).control.records;
    assert.equal(records.length, 4);
    assert.equal(
      records.every((r) => r.sentAt !== null),
      true,
    );
    assert.equal(
      records
        .slice(1)
        .every((r) => r.request.reservationFor === "sim-entry-origin"),
      true,
    );
    assert.equal(records[0]!.request.caseId, null);
    assert.equal(records[0]!.status, "OK");
    assert.equal(s.orders[0]!.status, "FILLED");
    assert.equal(s.positions[0]!.quantity, 4);
    assert.throws(
      () =>
        lab.command("premature-resume", {
          kind: "CONTROL",
          command: { kind: "RESUME", at: s.clock, epoch: 0 },
        }),
      /RESUME_UNSAFE/,
    );
    lab.command("transport-ended", {
      kind: "CONTROL",
      command: {
        kind: "TRANSPORT_CLOSED",
        at: s.clock,
        requestId: "sim-entry-origin",
      },
    });
    s = lab.command("resume", {
      kind: "CONTROL",
      command: { kind: "RESUME", at: s.clock, epoch: 0 },
    });
    assert.equal(brokerLabData(s).control.mode, "READY");
    assert.equal(s.status, "RECONCILING");
    const late = lab.command("late-http", {
      kind: "CONTROL",
      command: {
        kind: "RESPONSE",
        at: s.clock + 1,
        requestId: "sim-entry-origin",
        epoch: 0,
        code: "OK",
        retryAfterMs: 0,
      },
    });
    assert.equal(brokerLabData(late).control.records[0]!.status, "OK");
    assert.equal(brokerLabData(late).control.mode, "READY");
  } finally {
    lab.close();
  }
});
test("D02 REVIEW write UNKNOWN -> bound case -> three queries -> explicit resume", () => {
  const lab = labWithSell("UNKNOWN", ":memory:", false, (lab) => {
    lab.repo.transact("test-working-before-wire", {}, (s) => {
      assert.ok(s);
      sellOrder(s).status = "WORKING";
      return s;
    });
    const s = lab.state(),
      r = request("origin", "EXIT", s.clock, { orderId: sellOrder(s).id });
    lab.command("write-enqueue", {
      kind: "CONTROL",
      command: { kind: "ENQUEUE", at: s.clock, request: r },
    });
    lab.command("write-dispatch", {
      kind: "CONTROL",
      command: { kind: "DISPATCH", at: s.clock, worker: "sim-worker" },
    });
    lab.command("write-response", {
      kind: "CONTROL",
      command: {
        kind: "RESPONSE",
        at: s.clock + 1,
        requestId: r.id,
        epoch: 0,
        code: "OK",
        retryAfterMs: 0,
      },
    });
    assert.equal(sellOrder(lab.state()).status, "UNKNOWN");
    assert.equal(
      brokerLabData(lab.state()).control.records[0]!.status,
      "UNKNOWN",
    );
    return [r.id];
  });
  try {
    const original = brokerLabData(lab.state()).control.records[0]!.request;
    const proof = evidenceFor(lab, "bound", 1, "CANCELLED");
    let s = lab.command("proof", { kind: "RECONCILE", evidence: proof });
    assert.equal(brokerLabData(s).control.records[0]!.status, "OK");
    assert.deepEqual(brokerLabData(s).control.records[0]!.request, original);
    s = lab.command("resume", {
      kind: "CONTROL",
      command: { kind: "RESUME", at: s.clock, epoch: 0 },
    });
    assert.equal(brokerLabData(s).control.mode, "READY");
    assert.equal(s.status, "RECONCILING");
    assert.equal(s.orders.length, 2);
    assert.equal(s.positions[0]!.quantity, 1);
  } finally {
    lab.close();
  }
});
test("D02 forged write binding and nonexistent query case fail before durable mutation", () => {
  const lab = new BrokerControlLab(sellProgram.initial(0), controlConfig());
  try {
    const before = lab.state();
    for (const r of [
      request("no-order", "EXIT", before.clock, { orderId: "missing" }),
      request("no-case", "ORDER_QUERY", before.clock, {
        caseId: "sim-missing",
      }),
    ])
      assert.throws(() =>
        lab.command(r.id, {
          kind: "CONTROL",
          command: { kind: "ENQUEUE", at: before.clock, request: r },
        }),
      );
    assert.deepEqual(lab.state(), before);
  } finally {
    lab.close();
  }
});
for (const failure of ["DISK_FULL", "WRITE_FAILURE"] as const)
  test(`D02 ${failure} atomic rollback of dispatch and reconciliation`, () => {
    const lab = labWithSell();
    try {
      const at = lab.state().clock;
      lab.command("enqueue", {
        kind: "CONTROL",
        command: {
          kind: "ENQUEUE",
          at,
          request: request("safety", "ORDER_QUERY", at),
        },
      });
      let before = lab.state(),
        audit = lab.repo.verifyAudit();
      lab.repo.failure = failure;
      assert.throws(
        () =>
          lab.command("dispatch", {
            kind: "CONTROL",
            command: { kind: "DISPATCH", at, worker: "sim-worker" },
          }),
        new RegExp(failure),
      );
      assert.deepEqual(lab.state(), before);
      assert.equal(lab.repo.verifyAudit(), audit);
      lab.repo.failure = null;
      lab.command("dispatch", {
        kind: "CONTROL",
        command: { kind: "DISPATCH", at, worker: "sim-worker" },
      });
      lab.command("response", {
        kind: "CONTROL",
        command: {
          kind: "RESPONSE",
          at,
          requestId: "sim-safety",
          epoch: 0,
          code: "OK",
          retryAfterMs: 0,
        },
      });
      const evidence = evidenceFor(lab, "rollback");
      before = lab.state();
      audit = lab.repo.verifyAudit();
      lab.repo.failure = failure;
      assert.throws(
        () => lab.command("proof", { kind: "RECONCILE", evidence }),
        new RegExp(failure),
      );
      assert.deepEqual(lab.state(), before);
      assert.equal(lab.repo.verifyAudit(), audit);
      lab.repo.failure = null;
      const after = lab.command("proof", { kind: "RECONCILE", evidence });
      assert.equal(sellOrder(after).status, "CANCELLED");
      assert.ok(lab.repo.verifyAudit() > audit);
    } finally {
      lab.close();
    }
  });
test("D02 independent workers serialize latest quota and duplicate command IDs", () => {
  const config = controlConfig(2, 0);
  config.laneCapacity = 2;
  const lab = new BrokerControlLab(sellProgram.initial(0), config);
  try {
    const at = lab.state().clock;
    for (let i = 0; i < 3; i++)
      lab.command(`enqueue-${i}`, {
        kind: "CONTROL",
        command: {
          kind: "ENQUEUE",
          at,
          request: request(`read-${i}`, "ORDER_QUERY", at),
        },
      });
    for (let i = 0; i < 3; i++)
      lab.command(`dispatch-${i}`, {
        kind: "CONTROL",
        command: { kind: "DISPATCH", at, worker: `sim-worker-${i}` },
      });
    const before = lab.state();
    assert.equal(
      brokerLabData(before).control.records.filter((r) => r.sentAt !== null)
        .length,
      2,
    );
    assert.deepEqual(
      lab.command("dispatch-2", {
        kind: "CONTROL",
        command: { kind: "DISPATCH", at, worker: "sim-worker-2" },
      }),
      before,
    );
    assert.throws(
      () =>
        lab.command("dispatch-2", {
          kind: "CONTROL",
          command: { kind: "DISPATCH", at, worker: "sim-other" },
        }),
      /COMMAND_ID_CONFLICT/,
    );
  } finally {
    lab.close();
  }
});
test("D02 SQLite restart keeps debit/order/ledger, fences second writer and rejects stale receipts", () => {
  const path = newPath();
  const lab = labWithSell("CANCEL_UNKNOWN", path, true);
  const evidence = evidenceFor(lab, "old");
  const before = lab.state();
  assert.throws(
    () =>
      new BrokerControlLab(sellProgram.initial(0), controlConfig(), path, {
        resume: true,
      }),
    /WRITER_BUSY/,
  );
  lab.close();
  const restored = new BrokerControlLab(
    sellProgram.initial(0),
    controlConfig(),
    path,
    { resume: true },
  );
  try {
    const after = restored.state();
    assert.deepEqual(after.orders, before.orders);
    assert.deepEqual(after.ledger, before.ledger);
    assert.equal(
      brokerLabData(after).control.epoch,
      brokerLabData(before).control.epoch + 1,
    );
    assert.deepEqual(
      brokerLabData(after).control.records.map((r) => r.sentAt),
      brokerLabData(before).control.records.map((r) => r.sentAt),
    );
    const held = restored.command("old-proof", { kind: "RECONCILE", evidence });
    assert.equal(sellOrder(held).status, "CANCEL_UNKNOWN");
    const fresh = evidenceFor(restored, "fresh", 2, "FILLED");
    const final = restored.command("fresh-proof", {
      kind: "RECONCILE",
      evidence: fresh,
    });
    assert.equal(sellOrder(final).status, "FILLED");
    assert.equal(final.positions[0]!.quantity, 0);
  } finally {
    restored.close();
  }
});
test("D02 expired old writer is fenced after permitted new test writer takes lease", () => {
  const path = newPath();
  const first = new BrokerControlLab(
    sellProgram.initial(0),
    controlConfig(),
    path,
    { now: () => 1000 },
  );
  const next = new BrokerControlLab(
    sellProgram.initial(0),
    controlConfig(),
    path,
    { resume: true, now: () => 11001 },
  );
  try {
    assert.throws(
      () =>
        first.command("stale-write", {
          kind: "CONTROL",
          command: { kind: "ADVANCE", at: first.state().clock },
        }),
      /FENCED_WRITER/,
    );
    const at = next.state().clock;
    next.command("new-write", {
      kind: "CONTROL",
      command: { kind: "ADVANCE", at },
    });
    assert.equal(next.repo.verifyAudit(), 3);
  } finally {
    first.close();
    next.close();
  }
});
test("D02 foreign DB read-only preflight and changed config fail closed", () => {
  const foreign = newPath();
  const db = new DatabaseSync(foreign);
  db.exec(
    "CREATE TABLE unrelated(id INTEGER); INSERT INTO unrelated VALUES(1)",
  );
  db.close();
  const bytes = readFileSync(foreign);
  assert.throws(
    () =>
      new BrokerControlLab(sellProgram.initial(0), controlConfig(), foreign, {
        resume: true,
      }),
    /NOT_A_LAB/,
  );
  assert.deepEqual(readFileSync(foreign), bytes);
  const path = newPath();
  const lab = new BrokerControlLab(
    sellProgram.initial(0),
    controlConfig(),
    path,
  );
  const before = lab.state();
  lab.close();
  assert.throws(
    () => new BrokerControlLab(sellProgram.initial(0), controlConfig(), path),
    /EXISTING_FILE/,
  );
  assert.throws(
    () =>
      new BrokerControlLab(sellProgram.initial(0), controlConfig(9), path, {
        resume: true,
      }),
    /BINDING_MISMATCH/,
  );
  const restored = new BrokerControlLab(
    sellProgram.initial(0),
    controlConfig(),
    path,
    { resume: true },
  );
  try {
    assert.deepEqual(restored.state().orders, before.orders);
    assert.deepEqual(restored.state().ledger, before.ledger);
  } finally {
    restored.close();
  }
});
test("D02 static transitive production graph has no transport/credential dependency", () => {
  const root = resolve("dist/runtime");
  const report = inspectOfflineGraph(
    (id) => {
      const path = resolve(root, id);
      const inside = relative(root, path);
      assert.ok(!inside.startsWith("..") && !isAbsolute(inside));
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    },
    [
      "src/server/broker-control-lab.js",
      "src/core/broker-control.js",
      "src/core/broker-reconciliation.js",
    ],
  );
  assert.deepEqual(report.findings, []);
  assert.ok(report.modules.includes("src/server/repository.js"));
});
