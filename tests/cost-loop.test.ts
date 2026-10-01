import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostSignalProgram } from "../src/server/cost-signal-bridge.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { Repository } from "../src/server/repository.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { replayFixture } from "./signal-replay-helpers.js";
import { costProfile } from "./transaction-cost-helpers.js";
import { hash, policy } from "../src/core/policy.js";
import { replayCostJournal } from "../src/core/cost-journal.js";
import { verifyCostOutcomeExport } from "../src/core/cost-outcome-export.js";
import { execute } from "./cost-outcome-helpers.js";
import type { CostLoopTick } from "../src/core/cost-loop-schema.js";
import type { CostJournalEvent } from "../src/core/cost-journal.js";
import { costLoopStressFixtures } from "./cost-loop-stress-fixtures.js";
import type { StressExpected } from "./cost-loop-stress-fixtures.js";

function fixture(optIn = true, unit: "ORDER" | "FILL" = "ORDER") {
  const input = replayFixture(),
    settings = portfolioFixture(input).settings,
    at = Date.parse(input.frames[0]!.asOf),
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
      catalogKey: "KR:REPLAY-KR-B",
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
    optIn ? { executionLoop: true } : {},
  );
  return { program, at };
}
function open(f = fixture(), path = ":memory:", initialize = true) {
  const repo = new Repository(path, () => 1000);
  repo.acquire();
  const store = new CostReservationStore(repo, f.program.config(), {
    initialize,
  });
  if (initialize) {
    store.reserve("reserve", f.program.prepareEntry(store));
    store.handoff(
      "handoff",
      store.prepareHandoff(f.program.reservationId, "CONFIRMED"),
    );
  }
  const command = (
    offset: number,
    overrides: Partial<CostLoopTick["quote"]> = {},
  ): CostLoopTick => ({
    kind: "COST_LOOP_TICK",
    purpose: "TEST_ONLY",
    instrument: "REPLAY-KR-B",
    at: f.at + offset,
    quote: {
      at: f.at + offset,
      bid: "21399",
      ask: "21400",
      bidSize: 1000,
      askSize: 1000,
      halted: false,
      ...overrides,
    },
  });
  return {
    ...f,
    repo,
    store,
    command,
    tick: (offset: number, overrides: Partial<CostLoopTick["quote"]> = {}) =>
      store.tick(`tick-${offset}`, command(offset, overrides)).current,
    view: () => {
      const s = store.read().book.sources[0]!;
      return replayCostJournal(s.config, s.events);
    },
  };
}
function buyAll(t: ReturnType<typeof open>) {
  const quantity = t.view().orders[0]!.quantity;
  for (let i = 1; i <= quantity; i++) t.tick(i * 1000);
  return quantity;
}
function exitAll(t: ReturnType<typeof open>, bid: string, start = 20000) {
  t.tick(start, { bid, ask: bid, askSize: 0 });
  t.tick(start + 1000, { bid, ask: bid, askSize: 0 });
  const quantity = t.view().quantity;
  for (let i = 1; i <= quantity + 1; i++)
    t.tick(start + 1000 + i * 1000, { bid, ask: bid, askSize: 0 });
}

for (const unit of ["ORDER", "FILL"] as const)
  test(`CL-01 automatic target exit and ${unit} costs share one journal/report basis`, () => {
    const t = open(fixture(true, unit));
    try {
      const quantity = buyAll(t);
      assert.ok(quantity > 1);
      assert.equal(t.view().quantity, quantity);
      // Fixture stop 21121: 21400 + 2 * (21400 - 21121) = 21958.
      assert.equal(t.store.read().loop!.target, "21958");
      exitAll(t, "22000");
      const s = t.store.read(),
        v = t.view();
      assert.equal(v.quantity, 0);
      assert.equal(s.loop!.status, "CLOSED");
      assert.equal(s.outcomes!.length, 1);
      const fees = unit === "ORDER" ? 20n : 20n * BigInt(quantity);
      assert.equal(v.tradingFees, String(fees));
      assert.equal(
        s.outcomes![0]!.netPnlNative,
        String(600n * BigInt(quantity) - fees),
      );
      assert.equal(v.wallet.payable, "0");
      assert.equal(v.wallet.receivable, "0");
      assert.equal(v.reservedCash, "0");
      const evidence = t.program.evidence(t.store).cost;
      assert.doesNotThrow(() =>
        verifyCostOutcomeExport(JSON.stringify(evidence), {
          config: t.program.config(),
          exportHash: evidence.exportHash,
        }),
      );
      assert.equal(evidence.learningAllowed, false);
      assert.equal(evidence.orderSubmissionAllowed, false);
      assert.equal(evidence.liveEnabled, false);
    } finally {
      t.repo.close();
    }
  });

test("CL-02 partial fills, stop suspicion and cancellation precede any exit", () => {
  const t = open();
  try {
    t.tick(1000);
    const stop = t.store.read().approvals[0]!.candidate.stop;
    t.tick(2000, { bid: stop, askSize: 0 });
    assert.equal(t.store.read().loop!.reason, "STOP");
    assert.equal(
      t.store.read().book.sources[0]!.observation.protection,
      "TRIGGER_SUSPECTED",
    );
    assert.equal(t.view().orders.length, 1);
    t.tick(3000, { bid: stop, askSize: 0 });
    assert.equal(t.view().orders[0]!.status, "CANCEL_PENDING");
    assert.equal(
      t.store.read().book.sources[0]!.observation.protection,
      "TRIGGERED",
    );
    assert.ok(Number(t.view().reservedCash) > 0);
    t.tick(4000, { bid: stop }); // valid fill during cancellation latency
    assert.equal(t.view().quantity, 2);
    assert.equal(t.view().orders.length, 1);
    t.tick(5000, { bid: stop });
    assert.equal(t.view().orders[0]!.status, "CANCELLED");
    assert.equal(t.view().orders[1]!.quantity, 2);
    // Entry remainder is released; the newly submitted SELL reserves its fee.
    assert.equal(t.view().orders[0]!.reservedCash, "0");
    assert.equal(t.view().reservedCash, "10");
    t.tick(6000, { bid: stop });
    t.tick(7000, { bid: stop });
    t.tick(8000, { bid: stop });
    assert.equal(t.view().quantity, 0);
    assert.equal(t.store.read().outcomes!.length, 1);
  } finally {
    t.repo.close();
  }
});

test("CL-03 time exit is 90 minutes from first fill, not signal; no AI dependency", () => {
  const t = open();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw Error("NETWORK_MUST_NOT_RUN");
  };
  try {
    buyAll(t);
    const deadline =
      t.at + 1000 + policy.exit_policy.maximum_holding_minutes * 60000;
    assert.equal(t.store.read().loop!.deadline, deadline);
    t.tick(deadline - t.at - 1);
    assert.equal(t.view().orders.length, 1);
    t.tick(deadline - t.at);
    assert.equal(t.store.read().loop!.reason, "TIME");
    assert.equal(t.view().orders[1]!.side, "SELL");
    assert.equal(t.view().orders[1]!.filled, 0);
    assert.ok(t.program.config().horizonEnd > deadline);
  } finally {
    globalThis.fetch = oldFetch;
    t.repo.close();
  }
});

for (const kind of ["UNKNOWN", "CANCEL_UNKNOWN"] as const)
  test(`CL-04 ${kind} cannot be cleared by ticks/time, reservation retained`, () => {
    const t = open();
    try {
      t.tick(1000);
      const runId = t.store.read().book.sources[0]!.config.runId;
      if (kind === "CANCEL_UNKNOWN")
        execute(t.store, runId, {
          kind: "CANCEL_REQUEST",
          id: "cancel",
          orderId: "entry",
        });
      execute(t.store, runId, { kind, id: "unknown", orderId: "entry" });
      const reserve = t.view().reservedCash;
      t.tick(600000);
      t.tick(5500000);
      assert.equal(t.view().orders[0]!.status, kind);
      assert.equal(t.view().orders.length, 1);
      assert.equal(t.view().quantity, 1);
      assert.equal(t.view().reservedCash, reserve);
      assert.ok(
        t.store.read().loop!.holds.includes("ORDER_RECONCILIATION_REQUIRED"),
      );
    } finally {
      t.repo.close();
    }
  });

test("CL-05 fresh quote required; malformed/future/wrong instrument rejected without writes", () => {
  const t = open();
  try {
    t.tick(1000, { at: t.at });
    t.tick(2000, { halted: true });
    assert.equal(t.view().quantity, 0);
    assert.equal(t.store.read().loop!.status, "HOLD");
    const before = hash(t.store.read());
    for (const command of [
      { ...t.command(3000), instrument: "OTHER" },
      t.command(3000, { at: t.at + 4000 }),
      t.command(3000, { bid: "21500" }),
      { ...t.command(3000), purpose: "LIVE" },
    ])
      assert.throws(() => t.store.tick("invalid", command));
    assert.equal(hash(t.store.read()), before);
    t.tick(3000);
    assert.equal(t.view().quantity, 1);
  } finally {
    t.repo.close();
  }
});

test("CL-06 exact tick retry recovers original receipt after cold reopen; conflict rejects", () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), "cost-loop-")), "test.sqlite");
  const t = open(f, path);
  const original = t.store.tick("one", t.command(1000));
  t.repo.close();
  const resumed = open(f, path, false);
  try {
    const retry = resumed.store.tick("one", resumed.command(1000));
    assert.equal(retry.duplicate, true);
    assert.deepEqual(retry.receipt, original.receipt);
    assert.equal(resumed.view().quantity, 1);
    assert.throws(
      () => resumed.store.tick("one", resumed.command(2000)),
      /LOCAL_COMMAND_ID_CONFLICT/,
    );
    resumed.tick(2000);
    assert.equal(resumed.view().quantity, 2);
  } finally {
    resumed.repo.close();
  }
});

test("CL-07 failed commit rolls back fill, fees, reservation, loop and audit; retry once", () => {
  const t = open();
  try {
    const before = t.store.exportEvidence();
    t.repo.failure = "DISK_FULL";
    assert.throws(() => t.tick(1000));
    t.repo.failure = null;
    assert.deepEqual(t.store.exportEvidence(), before);
    t.tick(1000);
    assert.equal(t.view().quantity, 1);
    assert.equal(t.store.read().revision, 3);
    assert.equal(t.store.read().loop!.ticks, 1);
    assert.equal(t.view().tradingFees, "10");
  } finally {
    t.repo.close();
  }
});

test("CL-08 existing V3 runs cannot silently enable the loop", () => {
  const t = open(fixture(false));
  try {
    assert.throws(() => t.tick(1000), /COST_LOOP_OPT_IN_REQUIRED/);
  } finally {
    t.repo.close();
  }
});

test("CL-09 later partial fill recalculates VWAP target, never the approved stop", () => {
  const t = open();
  try {
    t.tick(1000);
    const stop = t.store.read().approvals[0]!.candidate.stop;
    t.tick(2000, { bid: "21299", ask: "21300" });
    // (21400 + 21300)/2 + 2*((21400 + 21300)/2 - 21121)
    assert.equal(t.store.read().loop!.target, "21808");
    assert.equal(t.store.read().book.sources[0]!.observation.stop, stop);
    assert.equal(t.view().tradingFees, "10");
  } finally {
    t.repo.close();
  }
});

test("CL-10 entry TTL uses explicit synthetic cancellation, not instant release", () => {
  const t = open();
  try {
    t.tick(10000, { askSize: 0 });
    assert.equal(t.view().orders[0]!.status, "CANCEL_PENDING");
    assert.notEqual(t.view().reservedCash, "0");
    t.tick(11000, { askSize: 0 });
    assert.equal(t.view().orders[0]!.status, "CANCEL_PENDING");
    t.tick(12000, { askSize: 0 });
    assert.equal(t.view().orders[0]!.status, "CANCELLED");
    assert.equal(t.view().reservedCash, "0");
    assert.equal(t.view().quantity, 0);
    assert.equal(t.store.read().outcomes!.length, 0);
  } finally {
    t.repo.close();
  }
});

test("CL-11 no-progress replacement requires confirmed cancellation, max two", () => {
  const t = open();
  try {
    buyAll(t);
    t.tick(20000, { bid: "22000", ask: "22000", bidSize: 0 });
    t.tick(21000, { bid: "22000", ask: "22000", bidSize: 0 });
    t.tick(23000, { bid: "21900", ask: "21900", bidSize: 0 });
    assert.equal(t.view().orders.at(-1)!.status, "CANCEL_PENDING");
    t.tick(24000, { bid: "21900", ask: "21900", bidSize: 0 });
    assert.equal(t.view().orders.length, 2);
    for (const at of [25000, 27000, 29000, 31000])
      t.tick(at, { bid: "21900", ask: "21900", bidSize: 0 });
    assert.equal(t.view().orders.filter((o) => o.side === "SELL").length, 3);
    assert.equal(t.store.read().loop!.exitBlocked, true);
    t.tick(33000, { bid: "23000", ask: "23000", bidSize: 0 });
    assert.equal(t.store.read().loop!.status, "HOLD");
    assert.equal(t.view().orders.length, 4);
    assert.equal(t.view().quantity, t.view().orders[0]!.quantity);
  } finally {
    t.repo.close();
  }
});

test("CL-12 unknown SELL cannot timeout into a duplicate replacement", () => {
  const t = open();
  try {
    buyAll(t);
    t.tick(20000, { bid: "22000", ask: "22000" });
    t.tick(21000, { bid: "22000", ask: "22000" });
    const runId = t.store.read().book.sources[0]!.config.runId;
    execute(t.store, runId, {
      kind: "UNKNOWN",
      id: "sell-unknown",
      orderId: "loop-exit-0",
    });
    t.tick(60000, { bid: "22000", ask: "22000" });
    assert.equal(t.view().orders.length, 2);
    assert.equal(t.view().orders[1]!.status, "UNKNOWN");
    assert.equal(t.view().orders[1]!.filled, 0);
    assert.equal(t.store.read().loop!.status, "HOLD");
  } finally {
    t.repo.close();
  }
});

test("CL-13 confirmed adverse fills remain recorded beyond loss budget; remaining exits continue", () => {
  const t = open();
  try {
    const quantity = buyAll(t),
      runId = t.store.read().book.sources[0]!.config.runId;
    execute(t.store, runId, {
      kind: "ORDER",
      id: "adverse-exit",
      orderId: "adverse-exit",
      side: "SELL",
      quantity,
      limit: "20000",
      replaces: null,
    });
    for (let i = 0; i < quantity; i++)
      t.tick(20000 + 1000 * i, { bid: "20000", ask: "20001", askSize: 0 });
    const s = t.store.read();
    assert.equal(t.view().quantity, 0);
    assert.equal(
      t.view().postings.filter((p) => p.side === "SELL").length,
      quantity,
    );
    assert.equal(
      s.outcomes![0]!.netPnlNative,
      String(-1400n * BigInt(quantity) - 20n),
    );
    assert.ok(s.handoff!.admissionHolds.includes("EXECUTION_BUDGET_EXCEEDED"));
    assert.equal(s.loop!.status, "HOLD");
    assert.equal(s.orderSubmissionAllowed, false);
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
  test(`CL-14 rollback at ${stage} does not leave half a tick`, () => {
    const t = open();
    try {
      const before = t.store.exportEvidence();
      const failing = new CostReservationStore(t.repo, t.program.config(), {
        testStage: (value) => {
          if (value === stage) throw Error("INJECTED_STAGE_FAILURE");
        },
      });
      assert.throws(
        () => failing.tick("tick", t.command(1000)),
        /INJECTED_STAGE_FAILURE/,
      );
      assert.deepEqual(t.store.exportEvidence(), before);
      t.tick(1000);
      assert.equal(t.view().quantity, 1);
      assert.equal(t.store.read().revision, 3);
    } finally {
      t.repo.close();
    }
  });

test("CL-15 same timestamp new ID is rejected; exhausted horizon preserves open exposure", () => {
  const t = open();
  try {
    t.tick(1000);
    assert.throws(
      () => t.store.tick("alias", t.command(1000)),
      /COST_LOOP_TIME_OR_HORIZON/,
    );
    const horizon = t.program.config().horizonEnd;
    t.tick(horizon - t.at, { halted: true });
    assert.equal(t.view().quantity, 1);
    assert.ok(
      t.store.read().loop!.holds.includes("OBSERVATION_HORIZON_EXHAUSTED"),
    );
    const before = hash(t.store.read());
    assert.throws(
      () => t.tick(horizon - t.at + 1),
      /COST_LOOP_TIME_OR_HORIZON/,
    );
    assert.equal(hash(t.store.read()), before);
  } finally {
    t.repo.close();
  }
});

// Oracle is restricted to this fixture's integer KRW, 21400 entry and
// minimum 10/order (1bp remains below the minimum). No production fee/risk
// calculator or observed fill list is used to derive expected money.
function assertStress(
  t: ReturnType<typeof open>,
  e: StressExpected,
  label: string,
) {
  const s = t.store.read(),
    source = s.book.sources[0]!,
    v = replayCostJournal(source.config, source.events),
    b = BigInt(e.buys),
    x = BigInt(e.sells),
    pb = BigInt(e.paidBuys),
    rx = BigInt(e.receivedSells),
    price = BigInt(e.sellPrice ?? "0");
  const buyFee = b > 0n ? 10n : 0n,
    sellFee = x > 0n ? 10n : 0n;
  const cash =
    5000000n -
    pb * 21400n -
    (pb > 0n ? buyFee : 0n) +
    rx * price -
    (rx > 0n ? sellFee : 0n);
  const payable = (b - pb) * 21400n + (pb === 0n ? buyFee : 0n);
  const receivable = (x - rx) * price - (rx === 0n ? sellFee : 0n);
  assert.deepEqual(
    {
      quantity: v.quantity,
      cash: v.wallet.cash,
      payable: v.wallet.payable,
      receivable: v.wallet.receivable,
      fees: v.tradingFees,
      reserved: v.reservedCash,
      available: v.availableCash,
    },
    {
      quantity: e.buys - e.sells,
      cash: String(cash),
      payable: String(payable),
      receivable: String(receivable),
      fees: String(buyFee + sellFee),
      reserved: e.reserved,
      available: String(cash - payable - BigInt(e.reserved)),
    },
    label,
  );
  assert.equal(
    v.postings.filter((p) => p.side === "BUY").length,
    e.buys,
    label,
  );
  assert.equal(
    v.postings.filter((p) => p.side === "SELL").length,
    e.sells,
    label,
  );
  assert.deepEqual(
    v.orders.map((o) => [o.id, o.status, o.quantity, o.filled, o.limit]),
    e.orders,
    label,
  );
  const account = s.handoff!.accounts.KRW;
  assert.deepEqual(
    account,
    {
      cash: String(cash),
      receivable: String(receivable),
      payable: String(payable),
      unpaidFees: "0",
      reservedCash: e.reserved,
      availableCash: String(cash - payable - BigInt(e.reserved)),
      tradingFees: String(buyFee + sellFee),
    },
    label,
  );
  assert.equal(
    s.outcomes!.length,
    e.buys > 0 && e.buys === e.sells ? 1 : 0,
    label,
  );
  if (e.reason !== undefined) assert.equal(s.loop!.reason, e.reason, label);
  if (e.holds !== undefined)
    assert.deepEqual([...s.loop!.holds].sort(), [...e.holds].sort(), label);
  if (e.status !== undefined) assert.equal(s.loop!.status, e.status, label);
  if (e.pnl !== undefined) {
    assert.equal(s.outcomes!.length, 1, label);
    assert.equal(s.outcomes![0]!.netPnlNative, e.pnl, label);
    assert.equal(
      e.pnl,
      String(x * price - b * 21400n - buyFee - sellFee),
      label,
    );
  }
  if (e.lossStreak !== undefined)
    assert.equal(s.seed.ledger.lossStreak, e.lossStreak, label);
  if (e.deadlineOffset !== undefined)
    assert.equal(s.loop!.deadline, t.at + e.deadlineOffset, label);
}

for (const scenario of costLoopStressFixtures)
  test(`${scenario.id} ${scenario.description}`, () => {
    const f = fixture(),
      path = join(
        mkdtempSync(join(tmpdir(), "cost-loop-stress-")),
        "test.sqlite",
      );
    let t = open(f, path);
    const beforeFixture = hash(scenario);
    const deliveries = new Map<
      string,
      {
        tick?: CostLoopTick;
        event?: CostJournalEvent;
        receipt: { revision: number; stateHash: string };
      }
    >();
    try {
      assert.equal(
        t.view().orders[0]!.quantity,
        4,
        "explicit oracle precondition",
      );
      assert.equal(t.store.read().approvals[0]!.candidate.stop, "21121");
      for (const step of scenario.steps) {
        const before = t.store.read(),
          label = `${scenario.id}/${step.id}`;
        if (step.kind === "tick") {
          const command = t.command(step.at, step.quote);
          const result = t.store.tick(step.id, command);
          deliveries.set(step.id, { tick: command, receipt: result.receipt });
          assert.equal(result.current.revision, before.revision + 1, label);
        } else if (step.kind === "event") {
          const event: CostJournalEvent = {
            ...step.event,
            id: step.id,
            seq: before.book.sources[0]!.events.length + 1,
            at: f.at + step.at,
          };
          if (event.kind === "FILL") event.occurredAt += f.at;
          if (event.kind === "CANCEL_CONFIRMED") event.evidenceAt += f.at;
          const result = t.store.execute(
            step.id,
            before.book.sources[0]!.config.runId,
            event,
            before,
          );
          deliveries.set(step.id, { event, receipt: result.receipt });
        } else if (step.kind === "restart") {
          t.repo.close();
          t = open(f, path, false);
          assert.equal(hash(t.store.read()), hash(before), label);
        } else if (step.kind === "silence") {
          assert.ok(f.at + step.until > before.seed.clock);
          // Characterize the missing scheduler; no tick/clock is injected here.
          assert.equal(hash(t.store.read()), hash(before), label);
          assert.equal(t.view().orders.length, 1, label);
          assert.equal(before.loop!.reason, null, label);
        } else {
          const original = deliveries.get(step.ref)!;
          if (original.tick) {
            assert.equal(step.kind, "retry");
            const retry = t.store.tick(step.ref, original.tick);
            assert.equal(retry.duplicate, true, label);
            assert.deepEqual(retry.receipt, original.receipt, label);
          } else {
            const event = {
              ...original.event!,
              id: step.id,
              seq: before.book.sources[0]!.events.length + 1,
              at: before.seed.clock + 1,
            };
            assert.equal(event.kind, "FILL");
            if (step.kind === "fill-conflict" && event.kind === "FILL")
              event.price = "21399";
            const submit = () =>
              t.store.execute(
                step.id,
                before.book.sources[0]!.config.runId,
                event,
                before,
              );
            if (step.kind === "fill-conflict")
              assert.throws(submit, /HANDOFF_FILL_ID_CONFLICT/, label);
            else {
              const retry = submit();
              assert.equal(retry.duplicate, true, label);
              assert.deepEqual(retry.receipt, original.receipt, label);
            }
          }
          assert.equal(hash(t.store.read()), hash(before), label);
        }
        if (step.expect) assertStress(t, step.expect, label);
      }
      const beforeExport = hash(t.store.read()),
        evidence = t.program.evidence(t.store).cost;
      assert.doesNotThrow(() =>
        verifyCostOutcomeExport(JSON.stringify(evidence), {
          config: t.program.config(),
          exportHash: evidence.exportHash,
        }),
      );
      assert.equal(hash(t.store.read()), beforeExport);
      assert.equal(hash(scenario), beforeFixture);
      assert.equal(evidence.orderSubmissionAllowed, false);
      assert.equal(evidence.learningAllowed, false);
      assert.equal(evidence.liveEnabled, false);
    } finally {
      t.repo.close();
    }
  });
