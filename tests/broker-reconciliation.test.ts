import { test } from "node:test";
import assert from "node:assert/strict";
import { d } from "../src/core/math.js";
import { fee } from "../src/core/risk.js";
import { checkPortfolioInvariants } from "../src/core/portfolio-invariants.js";
import { brokerLabData } from "../src/server/broker-control-lab.js";
import type { ReconciliationEvidence } from "../src/core/broker-reconciliation.js";
import {
  labWithBuy,
  labWithSell,
  evidenceFor,
  request,
} from "./broker-control-helpers.js";
import { sellOrder, sellProgram } from "./sell-unknown-helpers.js";

for (const status of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  for (const partial of [false, true])
    for (const terminal of ["CANCELLED", "FILLED"] as const)
      test(`D02 SELL ${status} previousPartial=${partial} three receipts -> ${terminal}`, () => {
        const lab = labWithSell(status, ":memory:", partial);
        try {
          const before = lab.state(),
            filled = terminal === "FILLED" ? 2 : 1;
          const e = evidenceFor(lab, "sale", filled, terminal);
          const after = lab.command("proof", {
            kind: "RECONCILE",
            evidence: e,
          });
          const order = sellOrder(after),
            delta = filled - sellOrder(before).filled;
          assert.equal(order.status, terminal);
          assert.equal(order.filled, filled);
          assert.equal(after.positions[0]!.quantity, 2 - filled);
          assert.equal(after.orders.length, before.orders.length);
          const value = d(order.limit).mul(delta).toString();
          assert.equal(
            d(after.ledger.wallets.KRW.receivable)
              .minus(before.ledger.wallets.KRW.receivable)
              .toString(),
            d(value)
              .minus(delta ? fee(value, "SELL") : 0)
              .toString(),
          );
          assert.equal(after.status, "RECONCILING");
          assert.equal(brokerLabData(after).control.mode, "PAUSED");
          assert.equal(
            brokerLabData(after).cases[0]!.status,
            "TERMINAL_CONFIRMED",
          );
          const duplicate = lab.command("duplicate-proof", {
            kind: "RECONCILE",
            evidence: e,
          });
          assert.deepEqual(duplicate.orders, after.orders);
          assert.deepEqual(duplicate.ledger, after.ledger);
          checkPortfolioInvariants(after, sellProgram.initial(0));
        } finally {
          lab.close();
        }
      });
for (const status of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  for (const partial of [false, true])
    test(`D02 BUY ${status} previousPartial=${partial} quantity/reservation and payable`, () => {
      const lab = labWithBuy(status, partial);
      try {
        const before = lab.state();
        const e = evidenceFor(lab, "buy", 2, "CANCELLED");
        const after = lab.command("proof", { kind: "RECONCILE", evidence: e });
        assert.equal(after.orders[0]!.status, "CANCELLED");
        assert.equal(after.orders[0]!.filled, 2);
        assert.equal(after.positions[0]!.quantity, 2);
        assert.equal(after.orders[0]!.reservationCash, "0");
        assert.equal(after.orders[0]!.reservationRisk, "0");
        const value = d(after.orders[0]!.limit)
          .mul(2 - before.orders[0]!.filled)
          .toString();
        assert.equal(
          d(after.ledger.wallets.KRW.payable)
            .minus(before.ledger.wallets.KRW.payable)
            .toString(),
          d(value).plus(fee(value, "BUY")).toString(),
        );
        checkPortfolioInvariants(after, sellProgram.initial(0));
      } finally {
        lab.close();
      }
    });
test("D02 partial receipt does not clear UNKNOWN or permit replacement; later fill wins cancel race", () => {
  const lab = labWithSell("CANCEL_UNKNOWN");
  try {
    let e = evidenceFor(lab, "partial", 1, "PARTIAL");
    const partial = lab.command("partial-proof", {
      kind: "RECONCILE",
      evidence: e,
    });
    assert.equal(sellOrder(partial).status, "CANCEL_UNKNOWN");
    assert.equal(partial.positions[0]!.quantity, 1);
    assert.throws(
      () =>
        lab.command("unsafe-resume", {
          kind: "CONTROL",
          command: {
            kind: "RESUME",
            at: partial.clock,
            epoch: brokerLabData(partial).control.epoch,
          },
        }),
      /UNRESOLVED_CASE/,
    );
    assert.throws(
      () =>
        lab.command("unsafe-replace", {
          kind: "CONTROL",
          command: {
            kind: "ENQUEUE",
            at: partial.clock,
            request: request("replace", "EXIT", partial.clock, {
              orderId: sellOrder(partial).id,
            }),
          },
        }),
      /NO_NEW_OR_REPLACEMENT/,
    );
    e = evidenceFor(lab, "final", 2, "FILLED");
    e.fills.items.reverse();
    e.fills.items.push(structuredClone(e.fills.items[0]!));
    const after = lab.command("final-proof", {
      kind: "RECONCILE",
      evidence: e,
    });
    assert.equal(sellOrder(after).filled, 2);
    assert.equal(after.positions[0]!.quantity, 0);
    assert.equal(after.orders.length, partial.orders.length);
    const resumed = lab.command("explicit-resume", {
      kind: "CONTROL",
      command: {
        kind: "RESUME",
        at: after.clock,
        epoch: brokerLabData(after).control.epoch,
      },
    });
    assert.equal(brokerLabData(resumed).control.mode, "READY");
    assert.equal(resumed.status, "RECONCILING");
  } finally {
    lab.close();
  }
});

const invalid: [string, (e: ReconciliationEvidence) => void][] = [
  [
    "coverage missing",
    (e) => {
      e.fills.complete = false;
    },
  ],
  [
    "coverage starts late",
    (e) => {
      e.fills.coverageFrom++;
    },
  ],
  [
    "cutoff mismatch",
    (e) => {
      e.position.asOf--;
    },
  ],
  [
    "wrong response timestamp",
    (e) => {
      e.order.availableAt++;
    },
  ],
  [
    "order id",
    (e) => {
      e.orderId = "not-the-order";
    },
  ],
  [
    "position id",
    (e) => {
      e.positionId = "not-the-position";
    },
  ],
  [
    "symbol",
    (e) => {
      e.symbol = "OTHER";
    },
  ],
  [
    "wrong route",
    (e) => {
      e.routeId = "sim-us-read";
    },
  ],
  [
    "missing successful query",
    (e) => {
      e.fills.requestId = "sim-never-sent";
    },
  ],
  [
    "reused query",
    (e) => {
      e.fills.requestId = e.order.requestId;
    },
  ],
  [
    "wrong action",
    (e) => {
      const tmp = e.order.requestId;
      e.order.requestId = e.fills.requestId;
      e.fills.requestId = tmp;
    },
  ],
  [
    "position does not reconcile",
    (e) => {
      e.position.quantity++;
    },
  ],
  [
    "fill sum mismatch",
    (e) => {
      e.order.filled++;
    },
  ],
  [
    "value mismatch",
    (e) => {
      e.order.value = "1";
    },
  ],
  [
    "zero execution value",
    (e) => {
      e.fills.items[0]!.value = "0";
    },
  ],
  [
    "sell limit violation",
    (e) => {
      e.fills.items[0]!.value = "1";
      e.order.value = "1";
    },
  ],
  [
    "future fill",
    (e) => {
      e.fills.items[0]!.at = e.asOf + 1;
    },
  ],
  [
    "fill before submission",
    (e) => {
      e.fills.items[0]!.at--;
    },
  ],
  [
    "conflicting duplicate fill",
    (e) => {
      e.fills.items.push({ ...e.fills.items[0]!, value: "999999" });
    },
  ],
  [
    "filled with remainder",
    (e) => {
      e.order.status = "FILLED";
    },
  ],
  [
    "working but filled",
    (e) => {
      e.order.status = "WORKING";
    },
  ],
  [
    "future cutoff",
    (e) => {
      e.asOf += 10000;
    },
  ],
];
for (const [name, mutate] of invalid)
  test(`D02 rejects ${name} without ledger or order mutation`, () => {
    const lab = labWithSell();
    try {
      const e = evidenceFor(lab, "invalid");
      mutate(e);
      const before = lab.state();
      const after = lab.command("bad-proof", {
        kind: "RECONCILE",
        evidence: e,
      });
      assert.deepEqual(after.orders, before.orders);
      assert.deepEqual(after.positions, before.positions);
      assert.deepEqual(after.ledger, before.ledger);
      assert.equal(brokerLabData(after).cases[0]!.status, "UNRESOLVED");
      assert.equal(after.status, "RECONCILING");
    } finally {
      lab.close();
    }
  });
test("D02 stale and failed receipts cannot resolve an order", () => {
  for (const failure of ["STALE", "QUERY_ERROR", "OLD_CONNECTION"] as const) {
    const lab = labWithSell();
    try {
      const e = evidenceFor(lab, "stale");
      if (failure === "STALE")
        lab.command("age", {
          kind: "CONTROL",
          command: { kind: "ADVANCE", at: e.asOf + 5001 },
        });
      else
        lab.repo.transact("test-query-failure", { failure }, (s) => {
          assert.ok(s);
          const data = brokerLabData(s);
          const r = data.control.records[0]!;
          if (failure === "QUERY_ERROR") r.status = "ERROR";
          else data.control.epoch++;
          s.manifest!.brokerControlLab = data;
          return s;
        });
      const before = lab.state(),
        after = lab.command("proof", { kind: "RECONCILE", evidence: e });
      assert.deepEqual(after.orders, before.orders);
      assert.deepEqual(after.ledger, before.ledger);
    } finally {
      lab.close();
    }
  }
});
test("D02 order submission exact boundary supports no-fill cancellation", () => {
  const lab = labWithSell();
  try {
    const e = evidenceFor(lab, "exact", 0);
    e.asOf = sellOrder(lab.state()).submittedAt;
    for (const r of [e.order, e.fills, e.position]) r.asOf = e.asOf;
    const s = lab.command("exact-proof", { kind: "RECONCILE", evidence: e });
    assert.equal(sellOrder(s).status, "CANCELLED");
    assert.equal(s.positions[0]!.quantity, 2);
  } finally {
    lab.close();
  }
});
test("D02 reversed proof and changed confirmed fill history remain held", () => {
  for (const mode of ["REVERSED", "CHANGED_FILL"] as const) {
    const lab = labWithSell();
    try {
      const first = evidenceFor(lab, "first", 1, "PARTIAL");
      lab.command("one", { kind: "RECONCILE", evidence: first });
      const second = evidenceFor(lab, "second", 2, "FILLED");
      if (mode === "REVERSED") second.asOf = first.asOf - 1;
      else {
        second.fills.items[0]!.id = "sim-rewritten";
      }
      const before = lab.state(),
        after = lab.command("two", { kind: "RECONCILE", evidence: second });
      assert.deepEqual(after.orders, before.orders);
      assert.deepEqual(after.ledger, before.ledger);
      assert.equal(brokerLabData(after).cases[0]!.status, "UNRESOLVED");
    } finally {
      lab.close();
    }
  }
});
test("D02 overfill and cumulative regression are held", () => {
  for (const filled of [0, 3]) {
    const lab = labWithSell("UNKNOWN", ":memory:", true);
    try {
      const e = evidenceFor(lab, "qty", filled);
      e.position.quantity = Math.max(0, e.position.quantity);
      const before = lab.state(),
        after = lab.command("proof", { kind: "RECONCILE", evidence: e });
      assert.deepEqual(after.orders, before.orders);
      assert.deepEqual(after.ledger, before.ledger);
    } finally {
      lab.close();
    }
  }
});
