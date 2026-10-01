import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { hash } from "../src/core/policy.js";
import { d } from "../src/core/math.js";
import { equity } from "../src/core/ledger.js";
import { reservationExposure } from "../src/core/cost-reservation.js";
import {
  operatingView,
  operatingKind,
  operatingEventSchema,
} from "../src/core/cost-operating.js";
import { applyHandoffCommand } from "../src/core/cost-handoff.js";
import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import {
  operatingConfig,
  openedOperating,
  op,
  record,
} from "./cost-operating-helpers.js";
import {
  handoffConfig,
  transferred,
  managed,
  fill,
  execute,
  settle,
  dumpHandoff,
} from "./cost-handoff-helpers.js";
import {
  proposal,
  observation,
  reservationConfig,
} from "./cost-reservation-helpers.js";
import {
  outcomeConfig,
  beginTrade,
  fillTrade,
  closeTrade,
  journal,
  execute as outcomeExecute,
} from "./cost-outcome-helpers.js";
import type { OperatingConfig } from "../src/core/cost-operating.js";

const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "cost-operating-")), "test.sqlite");
test("OI-01 one capital: obligation lowers E once; pay replaces liability and replay stays equal", () => {
  const { repo, store } = openedOperating();
  try {
    const initial = store.read(),
      capital = initial.seed.ledger.wallets.KRW.cash;
    let s = record(store, op(initial, "RECOGNIZE", "cost"));
    assert.equal(s.handoff!.accounts.KRW.cash, capital);
    assert.equal(s.handoff!.accounts.KRW.payable, "50");
    const projection = reservationExposure(s);
    assert.equal(projection.status, "OK");
    if (projection.status !== "OK") throw Error("projection");
    assert.equal(
      equity(projection.context.state).toString(),
      d(capital).minus(50).toString(),
    );
    assert.equal(
      projection.context.available.KRW,
      d(capital).minus(50).toString(),
    );
    s = record(store, op(s, "PAY", "pay"));
    assert.equal(s.handoff!.accounts.KRW.cash, d(capital).minus(50).toString());
    assert.equal(s.handoff!.accounts.KRW.payable, "0");
    assert.equal(s.operating!.effects.incurredKrw, "50");
    assert.equal(s.operating!.effects.paidKrw, "50");
    const paid = reservationExposure(s);
    assert.equal(paid.status, "OK");
    if (paid.status === "OK")
      assert.equal(
        equity(paid.context.state).toString(),
        d(capital).minus(50).toString(),
      );
    assert.equal(s.seed.ledger.wallets.KRW.cash, capital);
    assert.deepEqual(store.read(), s);
    assert.equal(s.operating!.finalNetPnlKrw, null);
    assert.equal(s.learningAllowed, false);
  } finally {
    repo.close();
  }
});
test("OI-02 recognize A offsets only A, release B does not become expense", () => {
  const { repo, store } = openedOperating();
  try {
    let s = record(store, op(store.read(), "RESERVE", "a", "50", "a"));
    s = record(store, op(s, "RESERVE", "b", "70", "b"));
    assert.equal(s.handoff!.accounts.KRW.reservedCash, "120");
    s = record(store, op(s, "RECOGNIZE", "cost-a", "50", "a", "a"));
    assert.equal(s.operating!.effects.reservedKrw, "70");
    assert.equal(s.operating!.effects.payableKrw, "50");
    const c = reservationExposure(s);
    assert.equal(c.status, "OK");
    if (c.status === "OK")
      assert.equal(c.context.state.ledger.operationsReserved, "70");
    s = record(store, op(s, "RELEASE", "release-b", "0", "b", "b"));
    assert.equal(s.operating!.effects.reservedKrw, "0");
    assert.equal(s.operating!.effects.incurredKrw, "50");
  } finally {
    repo.close();
  }
});
test("OI-02 event ID latch survives fresh command ID and stale expected snapshot; conflict cannot change money", () => {
  const { repo, store } = openedOperating();
  try {
    const old = store.read(),
      e = op(old, "RECOGNIZE", "cost");
    const first = store.operating("first", e, old),
      snapshot = dumpHandoff(repo);
    const duplicate = store.operating("redelivered", e, old);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.receipt, first.receipt);
    assert.deepEqual(dumpHandoff(repo), snapshot);
    assert.throws(
      () =>
        store.operating(
          "conflict",
          operatingEventSchema.parse({ ...e, amountKrw: "51" }),
          old,
        ),
      /ID_CONFLICT/,
    );
    assert.deepEqual(dumpHandoff(repo), snapshot);
    let s = record(store, op(store.read(), "RECOGNIZE", "other-id"));
    assert.match(
      s.operating!.rejectedInputs[0]!.reason,
      /DUPLICATE_OBLIGATION/,
    );
    assert.equal(s.operating!.effects.incurredKrw, "50");
    const paid = record(store, op(s, "PAY", "pay"));
    s = record(store, op(paid, "PAY", "pay-again"));
    assert.match(s.operating!.rejectedInputs[1]!.reason, /PAYMENT_MISMATCH/);
    assert.deepEqual(s.handoff!.accounts, paid.handoff!.accounts);
  } finally {
    repo.close();
  }
});
test("OI-01 trading payable and operating payable share cash without reusing opening capital", () => {
  const { repo, store } = openedOperating();
  try {
    let s = transferred(store);
    const q = s.approvals[0]!.candidate.quantity;
    s = execute(store, s, fill(s, "buy", q));
    const trading = s.handoff!.accounts.KRW.payable;
    s = record(store, op(s, "RECOGNIZE", "cost"));
    assert.equal(
      s.handoff!.accounts.KRW.payable,
      d(trading).plus(50).toString(),
    );
    s = record(store, op(s, "PAY", "pay"));
    assert.equal(s.handoff!.accounts.KRW.payable, trading);
    s = execute(store, s, settle(s, ["buy"]));
    assert.equal(
      s.handoff!.accounts.KRW.cash,
      d(s.seed.ledger.wallets.KRW.cash).minus(trading).minus(50).toString(),
    );
    assert.equal(s.handoff!.accounts.KRW.payable, "0");
    assert.equal(managed(s).config.operatingCosts, "EXPLICIT_ZERO_FIXTURE");
  } finally {
    repo.close();
  }
});
test("OI-02 accepted event retry returns its accepted receipt, not an earlier identical quarantined attempt", () => {
  const { repo, store } = openedOperating();
  try {
    const initial = store.read();
    const a = { ...op(initial, "RECOGNIZE", "a", "50", "a"), sequence: 2 };
    const rejected = store.operating("rejected", a, initial);
    assert.equal(rejected.current.operating!.events.length, 0);
    record(store, op(initial, "RECOGNIZE", "b", "50", "b"));
    const accepted = store.operating("accepted", a, store.read());
    const before = dumpHandoff(repo);
    const duplicate = store.operating("duplicate", a, initial);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.receipt, accepted.receipt);
    assert.notDeepEqual(duplicate.receipt, rejected.receipt);
    assert.deepEqual(dumpHandoff(repo), before);
    assert.equal(duplicate.current.operating!.effects.incurredKrw, "100");
    assert.equal(duplicate.current.operating!.rejectedInputs.length, 1);
    assert.equal(store.context().status, "HOLD");
  } finally {
    repo.close();
  }
});
test("OI-01 incurred debt is kept even beyond cap and cash; existing local reserves cannot be spent", () => {
  const { repo, store } = openedOperating();
  try {
    const p = store.prepare(proposal(store));
    store.reserve("reserve-trade", p);
    let s = store.read();
    const amount = d(s.seed.ledger.wallets.KRW.cash)
      .minus(s.approvals[0]!.reservation.cashNative)
      .plus(1)
      .toString();
    s = record(store, op(s, "RECOGNIZE", "cost", amount));
    assert.equal(s.handoff!.accounts.KRW.availableCash, "-1");
    assert.ok(s.handoff!.admissionHolds.includes("SHARED_CASH_DEFICIT"));
    assert.ok(
      s.handoff!.admissionHolds.includes("OPERATING_MONTHLY_BUDGET_EXCEEDED"),
    );
    assert.ok(s.seed.ledger.halts.includes("DAY_LOSS_HALT"));
    const before = dumpHandoff(repo);
    assert.throws(
      () => record(store, op(s, "PAY", "pay", amount)),
      /SHARED_PAYMENT_CASH/,
    );
    assert.deepEqual(dumpHandoff(repo), before);
    s = store.release("release", "r-FIRST", s).current;
    s = record(store, op(s, "PAY", "pay", amount));
    assert.equal(s.operating!.effects.payableKrw, "0");
    assert.ok(s.seed.ledger.halts.includes("DAY_LOSS_HALT"));
    assert.equal(store.context().status, "HOLD");
  } finally {
    repo.close();
  }
});
test("OI-01 competing operating reservations obey shared monthly cap and latest revision", () => {
  const { repo, store } = openedOperating();
  try {
    const old = store.read(),
      e = op(old, "RESERVE", "a", "10000", "a");
    record(store, e);
    const current = store.read(),
      dump = dumpHandoff(repo);
    assert.throws(
      () => store.operating("b", op(old, "RESERVE", "b", "1", "b"), old),
      /REAPPROVAL/,
    );
    assert.throws(
      () => record(store, op(current, "RESERVE", "b", "1", "b")),
      /BUDGET_OR_CASH/,
    );
    assert.deepEqual(dumpHandoff(repo), dump);
    const reserved = record(
      store,
      op(current, "RECOGNIZE", "cost", "10000", "a", "a"),
    );
    assert.equal(reserved.operating!.effects.reservedKrw, "0");
    assert.equal(reserved.operating!.effects.incurredKrw, "10000");
  } finally {
    repo.close();
  }
});
test("OI-09 operating evidence invalidates prepared entry and reapproval; never defaults known expense to zero", () => {
  const { repo, store } = openedOperating();
  try {
    const p = store.prepare(proposal(store));
    record(store, op(store.read(), "RECOGNIZE", "cost"));
    assert.throws(() => store.reserve("stale", p), /REAPPROVAL/);
    assert.throws(
      () =>
        store.prepare(
          p.input.command.kind === "RESERVE" ? p.input.command.proposal : {},
        ),
      /OPERATING_ADMISSION/,
    );
    assert.throws(() => store.report(), /REQUIRES_OUTCOME_V3/);
    assert.throws(() => store.exportEvidence(), /V3_REQUIRED/);
  } finally {
    repo.close();
  }
});
test("OI-08 observation must not create a gross-of-operating-cost high-water peak", () => {
  const { repo, store } = openedOperating();
  try {
    let s = transferred(store);
    const q = s.approvals[0]!.candidate.quantity;
    s = execute(store, s, fill(s, "buy", q));
    s = record(store, op(s, "RECOGNIZE", "cost", "10000"));
    const before = s.seed.ledger.highNav,
      obs = observation(s);
    obs.observations[0]!.observation.bid = "10100";
    obs.observations[0]!.observation.protectedQuantity = q;
    s = store.observe("refresh", obs, s).current;
    assert.equal(s.operating!.effects.payableKrw, "10000");
    const projected = reservationExposure(s);
    assert.equal(projected.status, "OK");
    if (projected.status === "OK") {
      const E = equity(projected.context.state);
      assert.equal(
        s.seed.ledger.highNav,
        d(before).gt(E.div(5000000)) ? before : E.div(5000000).toString(),
      );
    }
  } finally {
    repo.close();
  }
});
for (const mutate of [
  (e: ReturnType<typeof op>) => ({ ...e, sequence: 2 }),
  (e: ReturnType<typeof op>) => ({ ...e, amountKrw: "-1" }),
  (e: ReturnType<typeof op>) => ({ ...e, currency: "USD" }),
  (e: ReturnType<typeof op>) => ({ ...e, kind: "REFUND" }),
  (e: ReturnType<typeof op>) => ({ ...e, occurredAt: e.occurredAt - 10 }),
  (e: ReturnType<typeof op>) => ({
    ...e,
    availableAt: e.availableAt + 86400000,
  }),
])
  test("OI-09 unsupported input preserves evidence and HOLD without changing financial facts", () => {
    const { repo, store } = openedOperating();
    try {
      const s = store.read(),
        rawJson = JSON.stringify(mutate(op(s, "RECOGNIZE", "cost")));
      const result = store.operatingInput("invalid", rawJson, s).current;
      assert.deepEqual(result.handoff!.accounts, s.handoff!.accounts);
      assert.equal(result.seed.clock, s.seed.clock);
      assert.equal(result.operating!.events.length, 0);
      assert.equal(result.operating!.rejectedInputs[0]!.rawJson, rawJson);
      assert.equal(store.context().status, "HOLD");
      assert.deepEqual(store.read(), result);
    } finally {
      repo.close();
    }
  });
test("OI-06 negative available cash must not block a held-position exit, but oversell stays rejected", () => {
  const { repo, store } = openedOperating();
  try {
    const run = beginTrade(store, "FIRST", 4);
    fillTrade(store, run, "entry", 4);
    const amount = d(store.read().handoff!.accounts.KRW.availableCash)
      .plus(1)
      .toString();
    record(store, op(store.read(), "RECOGNIZE", "cost", amount));
    assert.equal(store.read().handoff!.accounts.KRW.availableCash, "-1");
    const before = dumpHandoff(repo);
    assert.throws(() =>
      outcomeExecute(store, run, {
        kind: "ORDER",
        id: "bad",
        orderId: "bad",
        side: "SELL",
        quantity: 5,
        limit: "10000",
        replaces: null,
      }),
    );
    assert.deepEqual(dumpHandoff(repo), before);
    closeTrade(store, run, "10000");
    const s = outcomeExecute(store, run, {
      kind: "SETTLE",
      id: "settle",
      fillIds: journal(store.read(), run).postings.map((p) => p.fill.fillId),
    });
    assert.equal(journal(s, run).quantity, 0);
    assert.equal(s.handoff!.accounts.KRW.cash, "4999980");
    assert.equal(store.context().status, "HOLD");
  } finally {
    repo.close();
  }
});
test("OI-01 settled trading profit belongs to the shared wallet and can pay recorded operating debt", () => {
  const { repo, store } = openedOperating();
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    closeTrade(store, run, "10100");
    outcomeExecute(store, run, {
      kind: "SETTLE",
      id: "settle",
      fillIds: journal(store.read(), run).postings.map((p) => p.fill.fillId),
    });
    assert.equal(store.read().handoff!.accounts.KRW.cash, "5000080");
    record(store, op(store.read(), "RECOGNIZE", "cost", "5000050"));
    const s = record(store, op(store.read(), "PAY", "pay", "5000050"));
    assert.equal(s.handoff!.accounts.KRW.cash, "30");
    assert.equal(s.handoff!.accounts.KRW.payable, "0");
    assert.equal(s.operating!.effects.incurredKrw, "5000050");
    assert.equal("cashKrw" in operatingView(s), false);
    assert.deepEqual(store.read(), s);
  } finally {
    repo.close();
  }
});
test("OI-09 first late cost during exposure survives reopening; duplicate intake is inert and protection continues", () => {
  const path = fresh(),
    c = operatingConfig();
  let { repo, store } = openedOperating(c, path);
  const run = beginTrade(store);
  fillTrade(store, run);
  const old = store.read(),
    e = op(old, "RECOGNIZE", "late");
  e.occurredAt -= 10;
  const result = store.operating("late", e, old),
    dump = dumpHandoff(repo);
  assert.equal(result.current.operating!.rejectedInputs.length, 1);
  assert.equal(result.current.operating!.effects.incurredKrw, "0");
  assert.equal(store.operating("late", e, old).duplicate, true);
  assert.deepEqual(dumpHandoff(repo), dump);
  repo.close();
  repo = new Repository(path, () => 20000);
  repo.acquire();
  store = new CostReservationStore(repo, c);
  try {
    assert.deepEqual(store.read(), result.current);
    assert.equal(store.context().status, "HOLD");
    const s = closeTrade(store, run, "10000");
    assert.equal(journal(s, run).quantity, 0);
    assert.equal(s.operating!.rejectedInputs[0]!.rawJson, JSON.stringify(e));
    assert.equal(s.operating!.finalNetPnlKrw, null);
  } finally {
    repo.close();
  }
});
test("OI-09 malformed bounded raw input is retained exactly; oversized intake changes nothing", () => {
  const { repo, store } = openedOperating();
  try {
    const raw = ' { "kind": "REFUND" ',
      s = store.read();
    const held = store.operatingInput("invalid-json", raw, s).current;
    assert.equal(held.operating!.rejectedInputs[0]!.rawJson, raw);
    const dump = dumpHandoff(repo);
    assert.throws(() =>
      store.operatingInput("too-large", "가".repeat(2731), held),
    );
    assert.deepEqual(dumpHandoff(repo), dump);
  } finally {
    repo.close();
  }
});
for (const stage of [
  "COMMAND",
  "APPROVALS",
  "FILL_INDEX",
  "STATE",
  "AUDIT",
] as const)
  test(`OI-03 quarantine at ${stage} rolls back evidence and HOLD together`, () => {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    let armed = false;
    const store = new CostReservationStore(repo, operatingConfig(), {
      initialize: true,
      testStage: (s) => {
        if (armed && s === stage) throw Error("INJECTED_FAILURE");
      },
    });
    try {
      const s = store.read(),
        dump = dumpHandoff(repo);
      armed = true;
      assert.throws(
        () => store.operatingInput("raw", "{}", s),
        /INJECTED_FAILURE/,
      );
      assert.deepEqual(dumpHandoff(repo), dump);
      assert.deepEqual(store.read(), s);
    } finally {
      repo.close();
    }
  });
test("OI-03 quarantined inputs cannot consume reserved payment capacity", () => {
  const { repo, store } = openedOperating();
  try {
    let s = record(store, op(store.read(), "RECOGNIZE", "cost"));
    for (let i = 0; i < 98; i++)
      s = applyHandoffCommand(
        s,
        { kind: "OPERATING_HOLD", rawJson: "{}" },
        s.epoch,
      );
    assert.throws(
      () =>
        applyHandoffCommand(
          s,
          { kind: "OPERATING_HOLD", rawJson: "{}" },
          s.epoch,
        ),
      /TERMINATION_CAPACITY/,
    );
    s = applyHandoffCommand(
      s,
      { kind: "OPERATING", event: op(s, "PAY", "pay") },
      s.epoch,
    );
    assert.equal(s.operating!.effects.payableKrw, "0");
    assert.equal(s.handoff!.controlCount, 0);
  } finally {
    repo.close();
  }
});
for (const kind of ["RESERVE", "RECOGNIZE", "PAY"] as const)
  for (const stage of [
    "COMMAND",
    "APPROVALS",
    "FILL_INDEX",
    "STATE",
    "AUDIT",
  ] as const)
    test(`OI-03 ${kind} failure at ${stage} rolls back every table and writer renewal`, () => {
      const repo = new Repository(":memory:", () => 1000);
      repo.acquire();
      let armed = false;
      const store = new CostReservationStore(repo, operatingConfig(), {
        initialize: true,
        testStage: (s) => {
          if (armed && s === stage) throw Error("INJECTED_FAILURE");
        },
      });
      try {
        let s = store.read();
        if (kind !== "RESERVE") s = record(store, op(s, "RESERVE", "reserved"));
        if (kind === "PAY")
          s = record(
            store,
            op(s, "RECOGNIZE", "cost", "50", "debt", "reserved"),
          );
        const dump = dumpHandoff(repo),
          writer = repo.db.prepare("SELECT * FROM writer").get();
        armed = true;
        assert.throws(
          () =>
            record(
              store,
              op(
                s,
                kind,
                "event",
                "50",
                "debt",
                kind === "RECOGNIZE" ? "reserved" : null,
              ),
            ),
          /INJECTED_FAILURE/,
        );
        assert.deepEqual(dumpHandoff(repo), dump);
        assert.deepEqual(repo.db.prepare("SELECT * FROM writer").get(), writer);
      } finally {
        repo.close();
      }
    });
test("OI-03 lease expiry at audit rolls back liability; old owner cannot retry even a duplicate", () => {
  const path = fresh(),
    c = operatingConfig();
  let now = 1000,
    armed = false;
  const repo = new Repository(path, () => now);
  repo.acquire();
  const store = new CostReservationStore(repo, c, {
    initialize: true,
    testStage: (stage) => {
      if (armed && stage === "AUDIT") now = 11000;
    },
  });
  let second: Repository | undefined;
  try {
    const old = store.read(),
      e = op(old, "RECOGNIZE", "cost"),
      dump = dumpHandoff(repo);
    armed = true;
    assert.throws(() => store.operating("cost", e, old), /FENCED_WRITER/);
    assert.deepEqual(dumpHandoff(repo), dump);
    second = new Repository(path, () => now);
    second.acquire();
    const winner = new CostReservationStore(second, c);
    winner.operating("cost", e, winner.read());
    assert.throws(() => store.operating("retry", e, old), /FENCED_WRITER/);
  } finally {
    second?.close();
    repo.close();
  }
});
test("OI-03 reopen with new epoch reproduces reserves, liability and idempotent original receipt", () => {
  const path = fresh(),
    c = operatingConfig();
  let { repo, store } = openedOperating(c, path);
  let s = record(store, op(store.read(), "RESERVE", "r"));
  const e = op(s, "RECOGNIZE", "cost", "50", "debt", "r");
  const original = store.operating("cost", e, s);
  s = original.current;
  repo.close();
  repo = new Repository(path, () => 20000);
  repo.acquire();
  store = new CostReservationStore(repo, c);
  try {
    assert.deepEqual(store.read(), s);
    const retry = store.operating("retry", e, s);
    assert.equal(retry.duplicate, true);
    assert.deepEqual(retry.receipt, original.receipt);
    const paid = record(store, op(s, "PAY", "pay"));
    assert.ok(paid.epoch > s.epoch);
    assert.equal(paid.operating!.effects.incurredKrw, "50");
  } finally {
    repo.close();
  }
});
test("OI-09 cache with recomputed checksum cannot hide a changed operating liability", () => {
  const { repo, store } = openedOperating();
  try {
    const s = record(store, op(store.read(), "RECOGNIZE", "cost"));
    s.operating!.effects.payableKrw = "0";
    repo.db
      .prepare("UPDATE cost_reservation_run SET body=?,checksum=?")
      .run(JSON.stringify(s), hash(s));
    assert.throws(() => store.read(), /STATE_REPLAY_MISMATCH/);
  } finally {
    repo.close();
  }
});
for (const legacy of [reservationConfig(), handoffConfig(), outcomeConfig()])
  test(`OI-09 explicit V4 does not migrate ${legacy.kind}`, () => {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    try {
      const old = new CostReservationStore(repo, legacy, { initialize: true }),
        dump = dumpHandoffSafe(repo);
      const s = old.read();
      assert.throws(
        () =>
          old.operating(
            "cost",
            {
              kind: "RECOGNIZE",
              eventId: "cost",
              sequence: 1,
              occurredAt: s.seed.clock,
              availableAt: s.seed.clock,
              obligationId: "cost",
              reservationId: null,
              amountKrw: "50",
            },
            s,
          ),
        /V4_REQUIRED/,
      );
      assert.throws(
        () => new CostReservationStore(repo, operatingConfig()),
        legacy.kind === "SYNTHETIC_LOCAL_COST_RESERVATIONS_V1"
          ? /MODE_CONFLICT/
          : /CONFIG_MISMATCH/,
      );
      assert.deepEqual(dumpHandoffSafe(repo), dump);
    } finally {
      repo.close();
    }
  });
function dumpHandoffSafe(repo: Repository) {
  return [
    "cost_reservation_run",
    "cost_reservation_commands",
    "cost_reservation_approvals",
    "audit",
  ].map((t) => repo.db.prepare(`SELECT * FROM ${t}`).all());
}
test("OI-09 USD or extra opening capital is not a valid new V4 scope", () => {
  for (const change of [
    (c: ReturnType<typeof operatingConfig>): OperatingConfig => ({
      ...handoffConfig("US"),
      kind: operatingKind,
      operating: c.operating,
    }),
    (c: ReturnType<typeof operatingConfig>) => ({
      ...c,
      operating: { ...c.operating, openingCashKrw: "5000000" },
    }),
    (c: ReturnType<typeof operatingConfig>) => ({
      ...c,
      operating: {
        ...c.operating,
        periodEnd: c.operating.periodEnd + 86400000,
      },
    }),
  ]) {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    try {
      assert.throws(
        () =>
          new CostReservationStore(repo, change(operatingConfig()), {
            initialize: true,
          }),
      );
      assert.equal(
        repo.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='cost_reservation_run'",
          )
          .get(),
        undefined,
      );
    } finally {
      repo.close();
    }
  }
});
test("OI-03 cost event cap reserves payment space and cannot consume execution controls", () => {
  const { repo, store } = openedOperating();
  try {
    let s = store.read();
    for (let i = 0; i < 50; i++)
      s = applyHandoffCommand(
        s,
        { kind: "OPERATING", event: op(s, "RECOGNIZE", `c${i}`, "0", `d${i}`) },
        s.epoch,
      );
    assert.equal(s.operating!.events.length, 50);
    assert.equal(s.handoff!.controlCount, 0);
    assert.throws(
      () =>
        applyHandoffCommand(
          s,
          {
            kind: "OPERATING",
            event: op(s, "RESERVE", "overflow", "0", "extra"),
          },
          s.epoch,
        ),
      /TERMINATION_CAPACITY/,
    );
    for (let i = 0; i < 50; i++)
      s = applyHandoffCommand(
        s,
        { kind: "OPERATING", event: op(s, "PAY", `p${i}`, "0", `d${i}`) },
        s.epoch,
      );
    assert.equal(s.operating!.events.length, 100);
    assert.equal(operatingView(s).obligations.filter((o) => !o.paid).length, 0);
  } finally {
    repo.close();
  }
});
test("OI-06 minimal close guard keeps allocation pending, retains protective excessive-loss halt and allows settlement", () => {
  const { repo, store } = openedOperating();
  try {
    const run = beginTrade(store, "FIRST", 4);
    fillTrade(store, run, "entry", 4);
    record(store, op(store.read(), "RECOGNIZE", "cost"));
    let s = closeTrade(store, run, "1");
    assert.equal(s.outcomes!.length, 1);
    const outcome = s.outcomes![0]!;
    assert.equal(outcome.counterApplied, false);
    assert.equal(outcome.lossStreakAfter, null);
    assert.ok(
      outcome.pendingReasons.includes("OPERATING_ALLOCATION_NOT_FINAL"),
    );
    assert.ok(s.seed.ledger.halts.includes("STOP_LOSS_EXCEEDS_2X"));
    assert.equal(s.seed.ledger.lossStreak, 0);
    assert.equal(s.operating!.finalNetPnlKrw, null);
    assert.equal(s.seed.ledger.cooldowns.FIRST, outcome.closedAt + 3600000);
    const ids = managed(s)
      .events.filter((e) => e.kind === "FILL")
      .map((e) => e.fillId);
    s = outcomeExecute(store, run, {
      kind: "SETTLE",
      id: "settlement",
      fillIds: ids,
    });
    s = record(store, op(s, "PAY", "pay"));
    assert.deepEqual(s.outcomes, [outcome]);
    assert.equal(s.operating!.effects.payableKrw, "0");
    assert.equal(store.context().status, "HOLD");
  } finally {
    repo.close();
  }
});
test("OI-06 unknown order cancellation and late fill evidence remain usable after operating HOLD", () => {
  const { repo, store } = openedOperating();
  try {
    let s = transferred(store, "UNKNOWN");
    s = record(store, op(s, "RECOGNIZE", "cost"));
    s = execute(store, s, fill(s));
    assert.equal(s.operating!.effects.incurredKrw, "50");
    const run = managed(s).config.runId;
    s = outcomeExecute(store, run, {
      kind: "CANCEL_UNKNOWN",
      id: "cancel",
      orderId: "entry",
    });
    assert.ok(
      s.handoff!.admissionHolds.includes(
        "OPERATING_ADMISSION_INTEGRATION_PENDING",
      ),
    );
    assert.equal(s.seed.ledger.entries, 1);
  } finally {
    repo.close();
  }
});
for (const stage of ["STATE", "COMMITTED"] as const)
  test(`OI-03 owned process terminated ${stage}: no partial reservation/debt/payment`, async () => {
    const path = fresh();
    const child = spawn(
      process.execPath,
      ["scripts/cost-operating-crash-fixture.mjs", path, stage],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let errors = "";
    child.stderr?.on("data", (b) => {
      errors += b;
    });
    try {
      const signal = await Promise.race([
        once(child, "message"),
        once(child, "exit").then(() => {
          throw Error(errors);
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(Error("FIXTURE_TIMEOUT")), 30000).unref();
        }),
      ]);
      assert.deepEqual(signal[0], { stage });
      const exited = once(child, "exit");
      child.kill();
      await exited;
      const repo = new Repository(path, () => 20000);
      repo.acquire();
      try {
        const store = new CostReservationStore(repo, operatingConfig()),
          s = store.read();
        assert.equal(s.revision, stage === "COMMITTED" ? 3 : 2);
        assert.equal(s.operating!.effects.incurredKrw, "50");
        assert.equal(
          s.operating!.effects.paidKrw,
          stage === "COMMITTED" ? "50" : "0",
        );
        assert.equal(
          s.operating!.effects.payableKrw,
          stage === "COMMITTED" ? "0" : "50",
        );
        assert.equal(
          s.handoff!.accounts.KRW.cash,
          stage === "COMMITTED" ? "4999950" : "5000000",
        );
        assert.equal(repo.verifyAudit(), s.revision + 1);
      } finally {
        repo.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
