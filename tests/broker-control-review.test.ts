import { test } from "node:test";
import assert from "node:assert/strict";
import { labWithSell, evidenceFor, request } from "./broker-control-helpers.js";
import { brokerLabData } from "../src/server/broker-control-lab.js";
import { sellOrder } from "./sell-unknown-helpers.js";

test("D02 REVIEW queued exit rechecks latest unresolved order at dispatch", () => {
  const lab = labWithSell("UNKNOWN", ":memory:", false, (lab) => {
    const s = lab.state();
    lab.command("queued-exit", {
      kind: "CONTROL",
      command: {
        kind: "ENQUEUE",
        at: s.clock,
        request: request("queued-exit", "EXIT", s.clock, {
          orderId: sellOrder(s).id,
        }),
      },
    });
  });
  try {
    const before = lab.state();
    const after = lab.command("dispatch-old-exit", {
      kind: "CONTROL",
      command: { kind: "DISPATCH", at: before.clock, worker: "sim-worker" },
    });
    assert.equal(brokerLabData(after).control.records[0]!.sentAt, null);
    assert.deepEqual(after.orders, before.orders);
    assert.deepEqual(after.ledger, before.ledger);
    const e = evidenceFor(lab, "queued-final", 1, "CANCELLED");
    lab.command("queued-confirm", { kind: "RECONCILE", evidence: e });
    const final = lab.command("dispatch-after-confirm", {
      kind: "CONTROL",
      command: {
        kind: "DISPATCH",
        at: lab.state().clock,
        worker: "sim-worker",
      },
    });
    assert.equal(brokerLabData(final).control.records[0]!.sentAt, null);
    assert.equal(brokerLabData(final).control.records[0]!.status, "DROPPED");
  } finally {
    lab.close();
  }
});

test("D02 REVIEW evidence before order creation cannot confirm cancellation", () => {
  const lab = labWithSell();
  try {
    const e = evidenceFor(lab, "old", 0);
    e.asOf = sellOrder(lab.state()).submittedAt - 1;
    for (const receipt of [e.order, e.fills, e.position]) receipt.asOf = e.asOf;
    const before = lab.state();
    const after = lab.command("old-evidence", {
      kind: "RECONCILE",
      evidence: e,
    });
    assert.deepEqual(after.orders, before.orders);
    assert.equal(brokerLabData(after).cases[0]!.status, "UNRESOLVED");
  } finally {
    lab.close();
  }
});

test("D02 REVIEW unknown evidence fields are rejected before durable audit", () => {
  const lab = labWithSell();
  try {
    const e = evidenceFor(lab, "fields");
    const before = lab.state(),
      events = lab.repo.events();
    assert.throws(() =>
      lab.command("extra-field", {
        kind: "RECONCILE",
        evidence: { ...e, appSecret: "SYNTHETIC_REJECT_ME" },
      }),
    );
    assert.deepEqual(lab.state(), before);
    assert.deepEqual(lab.repo.events(), events);
  } finally {
    lab.close();
  }
});
