import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostSignalProgram } from "../src/server/cost-signal-bridge.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { CostLoopRuntime } from "../src/server/cost-loop-runtime.js";
import { Repository } from "../src/server/repository.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { replayCostJournal } from "../src/core/cost-journal.js";
import { applyHandoffCommand } from "../src/core/cost-handoff.js";
import { hash } from "../src/core/policy.js";
import type { CostLoopTick } from "../src/core/cost-loop-schema.js";
import type { ReservationState } from "../src/core/cost-reservation.js";
import { replayFixture } from "./signal-replay-helpers.js";
import { costProfile } from "./transaction-cost-helpers.js";
import { op, operatingConfig } from "./cost-operating-helpers.js";
import { execute, fillEvent } from "./cost-outcome-helpers.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";

const fixtures = new Map<string, ReturnType<typeof makeFixture>>();
function makeFixture(
  strategy: "B" | "P",
  unit: "ORDER" | "FILL",
  watchdog: boolean,
) {
  const input = replayFixture(),
    settings = portfolioFixture(input).settings;
  const at = Date.parse(input.frames[strategy === "B" ? 0 : 1]!.asOf),
    p = costProfile();
  p.availableAt = p.effectiveFrom = at - 100000;
  p.effectiveTo = at + 7200000;
  for (const r of p.rules) r.unit = unit;
  const program = new CostSignalProgram(
    input,
    settings,
    {
      kind: "SYNTHETIC_COST_SIGNAL_SELECTION_V1",
      purpose: "TEST_ONLY",
      frameAsOf: at,
      catalogKey: `KR:REPLAY-KR-${strategy}`,
      profile: p,
      forecast: {
        model: "SYNTHETIC_POINT_SCENARIO",
        expectedExit: "22000",
        q05Exit: "21400",
        availableAt: at,
        validUntil: at + 30000,
      },
      adverseExitTicks: 0,
    },
    { executionLoop: true, ...(watchdog ? { watchdog: true } : {}) },
  );
  return {
    program,
    adapter: program.operatingLoop(),
    at,
    symbol: `REPLAY-KR-${strategy}`,
  };
}
function fixture(
  strategy: "B" | "P" = "B",
  unit: "ORDER" | "FILL" = "ORDER",
  watchdog = false,
) {
  const key = `${strategy}-${unit}-${watchdog}`;
  if (!fixtures.has(key))
    fixtures.set(key, makeFixture(strategy, unit, watchdog));
  return fixtures.get(key)!;
}
function open(
  f = fixture(),
  path = ":memory:",
  initialize = true,
  leaseNow = () => 1000,
) {
  const repo = new Repository(path, leaseNow);
  repo.acquire();
  const store = new CostReservationStore(repo, f.adapter.config(), {
    initialize,
  });
  if (initialize) {
    store.reserve("reserve", f.adapter.prepareEntry(store));
    store.handoff(
      "handoff",
      store.prepareHandoff(f.adapter.reservationId, "CONFIRMED"),
    );
  }
  const command = (
    ms: number,
    quote: Partial<CostLoopTick["quote"]> = {},
  ): CostLoopTick => ({
    kind: "COST_LOOP_TICK",
    purpose: "TEST_ONLY",
    instrument: f.symbol,
    at: f.at + ms,
    quote: {
      at: f.at + ms,
      bid: "21399",
      ask: "21400",
      bidSize: 1000,
      askSize: 1000,
      halted: false,
      ...quote,
    },
  });
  return {
    ...f,
    repo,
    store,
    command,
    tick: (ms: number, quote: Partial<CostLoopTick["quote"]> = {}) =>
      store.tick(`tick-${ms}`, command(ms, quote)).current,
    view: () => {
      const source = store.read().book.sources[0]!;
      return replayCostJournal(source.config, source.events);
    },
    pulse: (ms: number) => ({
      kind: "COST_LOOP_PULSE" as const,
      purpose: "TEST_ONLY" as const,
      instrument: f.symbol,
      at: f.at + ms,
    }),
  };
}
function cost(t: ReturnType<typeof open>, amount = "50") {
  const s = t.store.read(),
    e = op(s, "RECOGNIZE", "expense", amount);
  return t.store.operating("expense", e, s);
}
function buy(t: ReturnType<typeof open>) {
  for (const ms of [1000, 2000, 3000, 4000]) t.tick(ms);
}
function exit(t: ReturnType<typeof open>, price = "22000") {
  for (const ms of [5000, 6000, 7000, 8000, 9000, 10000, 11000])
    t.tick(ms, { bid: price, ask: price, askSize: 0 });
}
function locked(s: ReservationState) {
  assert.equal(s.orderSubmissionAllowed, false);
  assert.equal(s.learningAllowed, false);
  assert.equal(s.liveEnabled, false);
  assert.equal(s.operating!.finalNetPnlKrw, null);
  assert.equal(s.operating!.newSpendingApproved, false);
  assert.equal(s.operating!.allocationStatus, "HOLD");
}
function financial(s: ReservationState) {
  return hash({
    book: s.book.sources,
    accounts: s.handoff!.accounts,
    ledger: s.seed.ledger,
    operating: s.operating,
    approvals: s.approvals,
    outcomes: s.outcomes,
    clock: s.seed.clock,
  });
}

for (const strategy of ["B", "P"] as const)
  test(`OL-01 ${strategy} signal binding is explicit; V3 config and report remain unchanged`, () => {
    const f = fixture(strategy),
      before = hash(f.program.config()),
      repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    try {
      const store = new CostReservationStore(repo, f.adapter.config(), {
        initialize: true,
      });
      const prepared = f.adapter.prepareEntry(store);
      assert.equal(prepared.input.command.kind, "RESERVE");
      assert.equal(prepared.input.command.proposal.request.strategy, strategy);
      assert.equal(prepared.runHash, hash(f.adapter.config()));
      assert.equal(
        f.adapter.config().operatingLoop!.signalBasisHash,
        f.program.signalBasisHash,
      );
      assert.equal(hash(f.program.config()), before);
      assert.deepEqual(f.adapter.signalEvidence(), f.program.signalEvidence());
      assert.equal(store.read().revision, 0);
      assert.throws(() => store.report(), /COST_REPORT_REQUIRES_OUTCOME_V3/);
      assert.throws(() => store.exportEvidence(), /COST_EXPORT_V3_REQUIRED/);
      locked(store.read());
    } finally {
      repo.close();
    }
    const legacy = new Repository(":memory:", () => 1000);
    legacy.acquire();
    try {
      const store = new CostReservationStore(legacy, f.program.config(), {
        initialize: true,
      });
      assert.doesNotThrow(() => store.report());
      const old = dumpHandoff(legacy);
      assert.throws(
        () => f.adapter.prepareEntry(store),
        /STORE_BINDING_MISMATCH/,
      );
      assert.deepEqual(dumpHandoff(legacy), old);
    } finally {
      legacy.close();
    }
  });

for (const unit of ["ORDER", "FILL"] as const)
  test(`OL-02 ${unit} partial buy, reservation/expense, auto target and payment never double charge`, () => {
    const t = open(fixture("B", unit));
    try {
      assert.equal(t.view().orders[0]!.quantity, 4);
      let s = t.tick(1000);
      assert.equal(s.handoff!.accounts.KRW.payable, "21410");
      assert.equal(s.handoff!.accounts.KRW.cash, "5000000");
      s = t.store.operating(
        "op-reserve",
        op(s, "RESERVE", "op-reserve"),
        s,
      ).current;
      const recognize = op(
        s,
        "RECOGNIZE",
        "expense",
        "50",
        "debt",
        "op-reserve",
      );
      s = t.store.operating("expense", recognize, s).current;
      assert.equal(s.handoff!.accounts.KRW.payable, "21460");
      assert.equal(s.operating!.effects.reservedKrw, "0");
      assert.equal(s.operating!.effects.incurredKrw, "50");
      assert.throws(
        () => t.adapter.prepareEntry(t.store),
        /OPERATING_ADMISSION_INTEGRATION_PENDING/,
      );
      for (const ms of [2000, 3000, 4000]) t.tick(ms);
      exit(t);
      s = t.store.read();
      const fee = unit === "ORDER" ? 20n : 80n,
        pnl = 4n * 600n - fee;
      assert.equal(s.handoff!.accounts.KRW.cash, String(5000000n + pnl));
      assert.equal(
        s.handoff!.accounts.KRW.availableCash,
        String(5000000n + pnl - 50n),
      );
      assert.equal(s.handoff!.accounts.KRW.payable, "50");
      assert.equal(s.handoff!.accounts.KRW.receivable, "0");
      assert.equal(s.handoff!.accounts.KRW.reservedCash, "0");
      assert.equal(s.handoff!.accounts.KRW.tradingFees, String(fee));
      assert.equal(t.view().quantity, 0);
      assert.equal(s.outcomes![0]!.netPnlNative, String(pnl));
      assert.equal(s.outcomes![0]!.counterApplied, false);
      assert.equal(s.outcomes![0]!.lossStreakAfter, null);
      assert.ok(
        s.outcomes![0]!.pendingReasons.includes(
          "OPERATING_ALLOCATION_NOT_FINAL",
        ),
      );
      const outcomes = hash(s.outcomes),
        e = op(s, "PAY", "pay");
      const paid = t.store.operating("pay", e, s);
      assert.equal(
        paid.current.handoff!.accounts.KRW.cash,
        String(5000000n + pnl - 50n),
      );
      assert.equal(paid.current.handoff!.accounts.KRW.payable, "0");
      assert.equal(paid.current.operating!.effects.incurredKrw, "50");
      assert.equal(hash(paid.current.outcomes), outcomes);
      assert.equal(t.store.operating("pay-again", e, s).duplicate, true);
      assert.deepEqual(t.store.read(), paid.current);
      assert.ok(
        paid.current.handoff!.admissionHolds.includes(
          "OPERATING_ADMISSION_INTEGRATION_PENDING",
        ),
      );
      locked(paid.current);
    } finally {
      t.repo.close();
    }
  });

test("OL-03 operating HOLD preserves stop, partial cancel and subsequent sale", () => {
  const t = open();
  try {
    t.tick(1000);
    cost(t);
    const stop = t.store.read().approvals[0]!.candidate.stop;
    t.tick(2000, { bid: stop, askSize: 0 });
    assert.equal(t.store.read().loop!.reason, "STOP");
    t.tick(3000, { bid: stop, askSize: 0 });
    assert.equal(t.view().orders[0]!.status, "CANCEL_PENDING");
    t.tick(4000, { bid: stop });
    assert.equal(t.view().quantity, 2);
    t.tick(5000, { bid: stop, askSize: 0 });
    assert.equal(t.view().orders[0]!.status, "CANCELLED");
    for (const ms of [6000, 7000, 8000]) t.tick(ms, { bid: stop, askSize: 0 });
    const s = t.store.read();
    assert.equal(t.view().quantity, 0);
    assert.equal(
      s.handoff!.accounts.KRW.cash,
      String(5000000n + 2n * (BigInt(stop) - 21400n) - 20n),
    );
    assert.equal(s.handoff!.accounts.KRW.payable, "50");
    assert.equal(s.handoff!.accounts.KRW.reservedCash, "0");
    assert.equal(s.seed.ledger.lossStreak, 0);
    locked(s);
  } finally {
    t.repo.close();
  }
});

test("OL-04 watchdog time exit/late input keeps finance unchanged then allows a fresh-quote exit", () => {
  const t = open(fixture("B", "ORDER", true));
  try {
    buy(t);
    cost(t);
    const before = t.store.read(),
      deadline = before.loop!.deadline!;
    const pulse = t.pulse(deadline - t.at);
    const checked = t.store.pulse("deadline", pulse).current;
    assert.equal(financial(checked), financial(before));
    assert.ok(checked.loop!.holds.includes("WATCHDOG_TIME_EXIT_REQUIRED"));
    assert.ok(checked.loop!.holds.includes("WATCHDOG_INPUT_STALE"));
    const late = op(checked, "PAY", "late-pay");
    const held = t.store.operating("late-pay", late, checked).current;
    assert.equal(held.operating!.effects.paidKrw, "0");
    assert.equal(held.operating!.rejectedInputs.length, 1);
    assert.equal(
      held.operating!.rejectedInputs[0]!.rawJson,
      JSON.stringify(late),
    );
    assert.equal(
      held.handoff!.accounts.KRW.payable,
      checked.handoff!.accounts.KRW.payable,
    );
    for (let i = 0; i <= 5; i++) t.tick(deadline - t.at + i * 1000);
    const done = t.store.read();
    assert.equal(t.view().quantity, 0);
    assert.ok(done.loop!.holds.includes("WATCHDOG_TIME_EXIT_REQUIRED"));
    assert.equal(done.handoff!.accounts.KRW.payable, "50");
    assert.equal(done.outcomes![0]!.counterApplied, false);
    locked(done);
  } finally {
    t.repo.close();
  }
});

for (const side of ["BUY", "SELL"] as const)
  test(`OL-05 ${side} UNKNOWN plus operating debt cannot be resolved by quotes or time`, () => {
    const t = open();
    try {
      if (side === "BUY") t.tick(1000);
      else {
        buy(t);
        t.tick(5000, { bid: "22000", ask: "22000" });
        t.tick(6000, { bid: "22000", ask: "22000" });
      }
      cost(t);
      const run = t.store.read().book.sources[0]!.config.runId;
      execute(t.store, run, {
        kind: "UNKNOWN",
        id: "uncertain",
        orderId: side === "BUY" ? "entry" : "loop-exit-0",
      });
      const before = t.view();
      t.tick(60000, { bid: "22000", ask: "22000" });
      const after = t.view();
      assert.equal(after.orders.length, before.orders.length);
      assert.equal(after.quantity, before.quantity);
      assert.equal(
        after.orders.find((o) => o.side === side)!.status,
        "UNKNOWN",
      );
      assert.equal(
        after.orders.find((o) => o.side === side)!.reservedCash,
        before.orders.find((o) => o.side === side)!.reservedCash,
      );
      assert.ok(
        t.store.read().loop!.holds.includes("ORDER_RECONCILIATION_REQUIRED"),
      );
      locked(t.store.read());
    } finally {
      t.repo.close();
    }
  });

test("OL-06 incurred cash deficit must not erase exposure or block a risk-reducing sale", () => {
  const t = open();
  try {
    buy(t);
    cost(t, "5000001");
    assert.ok(BigInt(t.store.read().handoff!.accounts.KRW.availableCash) < 0n);
    const unpaid = t.store.read();
    assert.throws(
      () =>
        t.store.operating(
          "unfunded",
          op(unpaid, "PAY", "unfunded", "5000001"),
          unpaid,
        ),
      /OPERATING_SHARED_PAYMENT_CASH/,
    );
    assert.deepEqual(t.store.read(), unpaid);
    exit(t);
    const s = t.store.read();
    assert.equal(t.view().quantity, 0);
    assert.equal(s.handoff!.accounts.KRW.payable, "5000001");
    assert.equal(s.operating!.effects.incurredKrw, "5000001");
    assert.ok(
      s.handoff!.admissionHolds.includes("OPERATING_MONTHLY_BUDGET_EXCEEDED"),
    );
    assert.ok(s.handoff!.admissionHolds.includes("SHARED_CASH_DEFICIT"));
    locked(s);
  } finally {
    t.repo.close();
  }
});

test("OL-07 owned DB reopen retains tick/fill/expense receipts and pending final costs", () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), "cost-op-loop-")), "lab.sqlite");
  let t = open(f, path);
  const original = t.store.tick("tick", t.command(1000)),
    expense = cost(t),
    before = t.store.read();
  const source = before.book.sources[0]!,
    fill = source.events.find((e) => e.kind === "FILL")!;
  t.repo.close();
  t = open(f, path, false, () => 20000);
  try {
    assert.deepEqual(t.store.read(), before);
    const retry = t.store.tick("tick", t.command(1000));
    assert.equal(retry.duplicate, true);
    assert.deepEqual(retry.receipt, original.receipt);
    const oldExpense = before.operating!.events[0]!;
    assert.deepEqual(
      t.store.operating("expense-retry", oldExpense, before).receipt,
      expense.receipt,
    );
    const duplicateFill = t.store.execute(
      "fill-retry",
      source.config.runId,
      fill,
      before,
    );
    assert.equal(duplicateFill.duplicate, true);
    assert.deepEqual(duplicateFill.receipt, original.receipt);
    assert.throws(
      () => t.store.tick("tick", t.command(1000, { ask: "21401" })),
      /CONFLICT/,
    );
    assert.throws(
      () =>
        t.store.execute(
          "fill-conflict",
          source.config.runId,
          { ...fill, price: "21401" },
          before,
        ),
      /CONFLICT/,
    );
    assert.deepEqual(t.store.read(), before);
    const e = op(before, "PAY", "pay");
    t.store.operating("pay", e, before);
    assert.throws(
      () => t.store.operating("stale", op(before, "RESERVE", "stale"), before),
      /STALE|REAPPROVAL/,
    );
    for (const ms of [2000, 3000, 4000]) t.tick(ms);
    exit(t);
    const done = t.store.read();
    assert.equal(done.handoff!.accounts.KRW.cash, "5002330");
    assert.equal(done.handoff!.accounts.KRW.payable, "0");
    assert.equal(done.outcomes![0]!.counterApplied, false);
    assert.ok(done.epoch > before.epoch);
    locked(done);
  } finally {
    t.repo.close();
  }
});

for (const stage of [
  "COMMAND",
  "APPROVALS",
  "FILL_INDEX",
  "STATE",
  "AUDIT",
] as const)
  test(`OL-08 ${stage} failure keeps operating debt, fill index and tick atomic`, () => {
    const t = open();
    try {
      t.tick(1000);
      cost(t);
      const before = dumpHandoff(t.repo),
        writer = t.repo.db.prepare("SELECT * FROM writer").get();
      const failing = new CostReservationStore(t.repo, t.adapter.config(), {
        testStage: (s) => {
          if (s === stage) throw Error("INJECTED_S7_FAILURE");
        },
      });
      assert.throws(
        () => failing.tick("failed-tick", t.command(2000)),
        /INJECTED_S7_FAILURE/,
      );
      assert.deepEqual(dumpHandoff(t.repo), before);
      assert.deepEqual(t.repo.db.prepare("SELECT * FROM writer").get(), writer);
      const result = t.store.tick("failed-tick", t.command(2000));
      assert.equal(t.view().quantity, 2);
      assert.equal(result.current.operating!.effects.incurredKrw, "50");
      assert.deepEqual(
        t.store.tick("failed-tick", t.command(2000)).receipt,
        result.receipt,
      );
    } finally {
      t.repo.close();
    }
  });

test("OL-09 commit failure and expired lease cannot partially change combined accounting", () => {
  let now = 1000;
  const t = open(fixture(), ":memory:", true, () => now);
  try {
    t.tick(1000);
    cost(t);
    const before = dumpHandoff(t.repo);
    t.repo.failure = "DISK_FULL";
    assert.throws(() => t.tick(2000), /DISK_FULL/);
    t.repo.failure = null;
    assert.deepEqual(dumpHandoff(t.repo), before);
    now = 11000;
    assert.throws(() => t.tick(2000), /FENCED_WRITER/);
    assert.deepEqual(dumpHandoff(t.repo), before);
  } finally {
    t.repo.close();
  }
});

test("OL-10 invalid contract/signal and unaccepted close combinations never initialize a ledger", () => {
  const f = fixture();
  const base = f.adapter.config();
  for (const c of [
    {
      ...base,
      operatingLoop: {
        ...base.operatingLoop!,
        signalBasisHash: "f".repeat(64),
      },
    },
    { ...base, operatingLoop: { ...base.operatingLoop!, cancelLatencyMs: 1 } },
    { ...base, executionLoop: f.program.config().executionLoop },
    { ...base, finalization: {} },
    { ...base, seed: { ...base.seed, manifest: null } },
  ]) {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    try {
      // Deliberately malformed external input; constructor must validate at runtime.
      assert.throws(
        () =>
          new CostReservationStore(repo, c as typeof base, {
            initialize: true,
          }),
      );
      assert.equal(
        repo.db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'cost_reservation_%'",
          )
          .get()!.n,
        0,
      );
      assert.equal(repo.verifyAudit(), 0);
    } finally {
      repo.close();
    }
  }
  const repo = new Repository(":memory:", () => 1000);
  repo.acquire();
  try {
    const store = new CostReservationStore(repo, operatingConfig(), {
      initialize: true,
    });
    const before = store.read();
    assert.equal(before.loop, undefined);
    assert.throws(
      () =>
        store.tick("invalid", {
          kind: "COST_LOOP_TICK",
          purpose: "TEST_ONLY",
          instrument: "SYNTHETIC",
          at: before.seed.clock,
          quote: {
            at: before.seed.clock,
            bid: "100",
            ask: "100",
            bidSize: 1,
            askSize: 1,
            halted: false,
          },
        }),
      /COST_LOOP_OPT_IN_REQUIRED/,
    );
    assert.deepEqual(store.read(), before);
  } finally {
    repo.close();
  }
});

test("OL-11 runtime timer during operating HOLD records no fake fills or payments", () => {
  const t = open(fixture("B", "ORDER", true));
  let wall = t.at + 1002,
    mono = 0,
    pending: (() => void) | null = null;
  let runtime: CostLoopRuntime | undefined;
  try {
    t.tick(1000);
    cost(t);
    const before = t.store.read();
    runtime = new CostLoopRuntime(t.store, {
      clock: { wallNow: () => wall, monotonicNow: () => mono },
      timer: {
        schedule: (_ms, callback) => {
          pending = callback;
          return () => {
            pending = null;
          };
        },
      },
    });
    runtime.start();
    wall += 10000;
    mono += 10000;
    const callback = pending;
    assert.ok(callback);
    (callback as () => void)();
    assert.equal(runtime.status().phase, "RUNNING");
    assert.ok(runtime.status().holds.includes("WATCHDOG_INPUT_STALE"));
    assert.equal(financial(t.store.read()), financial(before));
    runtime.quote("fresh", t.command(wall - t.at));
    assert.ok(t.store.read().loop!.holds.includes("WATCHDOG_INPUT_STALE"));
    assert.equal(t.store.read().operating!.effects.payableKrw, "50");
    runtime.stop();
    assert.equal(pending, null);
    locked(t.store.read());
  } finally {
    runtime?.stop();
    t.repo.close();
  }
});

test("OL-12 late actual adverse fill remains a fact and excessive-loss halt survives operating wait", () => {
  const t = open();
  try {
    buy(t);
    cost(t);
    const run = t.store.read().book.sources[0]!.config.runId;
    execute(t.store, run, {
      kind: "ORDER",
      id: "adverse",
      orderId: "adverse",
      side: "SELL",
      quantity: 4,
      limit: "20000",
      replaces: null,
    });
    const s = t.store.read(),
      e = fillEvent(s, run, "adverse", 4, "20000");
    t.store.execute(e.id, run, e, s);
    t.tick(6000, { bid: "20000", ask: "20001", askSize: 0 });
    const done = t.store.read();
    assert.equal(done.outcomes![0]!.netPnlNative, "-5620");
    assert.ok(done.seed.ledger.halts.includes("STOP_LOSS_EXCEEDS_2X"));
    assert.equal(done.outcomes![0]!.counterApplied, false);
    assert.equal(done.operating!.effects.payableKrw, "50");
    locked(done);
  } finally {
    t.repo.close();
  }
});

test("OL-13 V3 loop fills also retain their exact parent tick receipt on individual redelivery", () => {
  const f = fixture(),
    repo = new Repository(":memory:", () => 1000);
  repo.acquire();
  try {
    const store = new CostReservationStore(repo, f.program.config(), {
      initialize: true,
    });
    store.reserve("reserve", f.program.prepareEntry(store));
    store.handoff(
      "handoff",
      store.prepareHandoff(f.program.reservationId, "CONFIRMED"),
    );
    const receipts = [1000, 2000].map(
      (ms) =>
        store.tick(`tick-${ms}`, {
          kind: "COST_LOOP_TICK",
          purpose: "TEST_ONLY",
          instrument: f.symbol,
          at: f.at + ms,
          quote: {
            at: f.at + ms,
            bid: "21399",
            ask: "21400",
            bidSize: 1000,
            askSize: 1000,
            halted: false,
          },
        }).receipt,
    );
    const state = store.read(),
      source = state.book.sources[0]!,
      before = dumpHandoff(repo);
    const fills = source.events.filter((e) => e.kind === "FILL");
    assert.equal(fills.length, 2);
    for (const [i, fill] of fills.entries()) {
      const retry = store.execute(
        `redelivery-${i}`,
        source.config.runId,
        fill,
        state,
      );
      assert.equal(retry.duplicate, true);
      assert.deepEqual(retry.receipt, receipts[i]);
    }
    assert.throws(
      () =>
        store.execute(
          "changed",
          source.config.runId,
          { ...fills[1]!, price: "21401" },
          state,
        ),
      /HANDOFF_FILL_ID_CONFLICT/,
    );
    assert.deepEqual(dumpHandoff(repo), before);
    assert.equal(store.report().kind, "SYNTHETIC_COST_REPORT_V1");
    const bounded = structuredClone(state);
    bounded.revision = 5199;
    const boundaryTick: CostLoopTick = {
      kind: "COST_LOOP_TICK",
      purpose: "TEST_ONLY",
      instrument: f.symbol,
      at: f.at + 3000,
      quote: {
        at: f.at + 3000,
        bid: "21399",
        ask: "21400",
        bidSize: 1000,
        askSize: 1000,
        halted: false,
      },
    };
    assert.equal(
      applyHandoffCommand(bounded, boundaryTick, bounded.epoch).revision,
      5200,
    );
    bounded.revision = 5200;
    assert.throws(
      () => applyHandoffCommand(bounded, boundaryTick, bounded.epoch),
      /COST_LOOP_COMMAND_LIMIT/,
    );
  } finally {
    repo.close();
  }
});

for (const kind of ["PULSE", "OPERATING"] as const)
  test(`OL-14 ${kind} commit failure preserves the combined snapshot and successful retry`, () => {
    const t = open(fixture("B", "ORDER", true));
    try {
      t.tick(1000);
      cost(t);
      const state = t.store.read(),
        before = dumpHandoff(t.repo);
      const command = () =>
        kind === "PULSE"
          ? t.store.pulse("retry", t.pulse(3001))
          : t.store.operating("retry", op(state, "PAY", "pay"), state);
      t.repo.failure = "DISK_FULL";
      assert.throws(command, /DISK_FULL/);
      t.repo.failure = null;
      assert.deepEqual(dumpHandoff(t.repo), before);
      const accepted = command();
      assert.deepEqual(command().receipt, accepted.receipt);
      assert.equal(t.store.read().operating!.effects.incurredKrw, "50");
      assert.equal(
        t.store.read().operating!.effects.paidKrw,
        kind === "PULSE" ? "0" : "50",
      );
      locked(t.store.read());
    } finally {
      t.repo.failure = null;
      t.repo.close();
    }
  });

for (const kind of ["TICK", "PULSE"] as const)
  test(`OL-15 ${kind} reducer command boundary excludes reserved operating slots without raising execution limit`, () => {
    const t = open(fixture("B", "ORDER", true));
    try {
      t.tick(1000);
      cost(t);
      const state = t.store.read();
      // Isolated reducer boundary only; not a forged persisted replay or an
      // end-to-end 5,200-command performance test.
      state.revision = 5200;
      const command = kind === "TICK" ? t.command(2000) : t.pulse(3001);
      const next = applyHandoffCommand(state, command, state.epoch);
      assert.equal(next.revision, 5201);
      state.revision = 5201;
      assert.throws(
        () => applyHandoffCommand(state, command, state.epoch),
        /COST_(LOOP|WATCHDOG)_COMMAND_LIMIT/,
      );
      assert.equal(t.store.read().revision, 4);
    } finally {
      t.repo.close();
    }
  });
