import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { CostSignalProgram } from "../src/server/cost-signal-bridge.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { CostLoopRuntime } from "../src/server/cost-loop-runtime.js";
import type {
  CostLoopClock,
  CostLoopTimer,
} from "../src/server/cost-loop-runtime.js";
import { Repository } from "../src/server/repository.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { replayFixture } from "./signal-replay-helpers.js";
import { costProfile } from "./transaction-cost-helpers.js";
import { execute } from "./cost-outcome-helpers.js";
import { hash } from "../src/core/policy.js";
import { replayCostJournal } from "../src/core/cost-journal.js";
import {
  applyCostWatchdog,
  costWatchdogNeedsPulse,
} from "../src/core/cost-watchdog.js";
import { verifyCostOutcomeExport } from "../src/core/cost-outcome-export.js";
import type { CostLoopTick } from "../src/core/cost-loop-schema.js";
import type { ReservationState } from "../src/core/cost-reservation.js";

function fixture(watchdog = true) {
  const input = replayFixture(),
    settings = portfolioFixture(input).settings,
    at = Date.parse(input.frames[0]!.asOf),
    p = costProfile();
  p.availableAt = p.effectiveFrom = at - 100000;
  p.effectiveTo = at + 7200000;
  const selection = {
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
  };
  const program = new CostSignalProgram(input, settings, selection, {
    executionLoop: true,
    ...(watchdog ? { watchdog: true } : {}),
  });
  return { program, at, input, settings, selection };
}
function open(
  f = fixture(),
  path = ":memory:",
  initialize = true,
  leaseNow = () => 1000,
) {
  const repo = new Repository(path, leaseNow);
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
    quote: Partial<CostLoopTick["quote"]> = {},
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
      ...quote,
    },
  });
  const pulse = (offset: number) => ({
    kind: "COST_LOOP_PULSE" as const,
    purpose: "TEST_ONLY" as const,
    instrument: "REPLAY-KR-B",
    at: f.at + offset,
  });
  return {
    ...f,
    repo,
    store,
    command,
    pulse,
    tick: (offset: number, quote: Partial<CostLoopTick["quote"]> = {}) =>
      store.tick(`tick-${offset}`, command(offset, quote)).current,
    view: () => {
      const s = store.read().book.sources[0]!;
      return replayCostJournal(s.config, s.events);
    },
  };
}
function buy(t: ReturnType<typeof open>) {
  for (const ms of [1000, 2000, 3000, 4000]) t.tick(ms);
}
function finances(s: ReservationState) {
  return hash({
    book: s.book.sources,
    accounts: s.handoff!.accounts,
    approvals: s.approvals,
    ledger: s.seed.ledger,
    clock: s.seed.clock,
    outcomes: s.outcomes,
    orderSubmissionAllowed: s.orderSubmissionAllowed,
  });
}
function verified(t: ReturnType<typeof open>) {
  const e = t.store.exportEvidence();
  verifyCostOutcomeExport(JSON.stringify(e), {
    config: t.program.config(),
    exportHash: e.exportHash,
  });
  assert.equal(e.liveEnabled, false);
  assert.equal(e.orderSubmissionAllowed, false);
  assert.equal(e.learningAllowed, false);
}
class ManualTime implements CostLoopClock, CostLoopTimer {
  wall: number;
  mono = 0;
  pending: (() => void) | null = null;
  history: (() => void)[] = [];
  constructor(at: number) {
    this.wall = at;
  }
  wallNow() {
    return this.wall;
  }
  monotonicNow() {
    return this.mono;
  }
  advance(ms: number) {
    this.wall += ms;
    this.mono += ms;
  }
  schedule(_delay: number, callback: () => void) {
    assert.equal(this.pending, null, "only one outstanding wakeup");
    this.pending = callback;
    this.history.push(callback);
    return () => {
      if (this.pending === callback) this.pending = null;
    };
  }
  fire() {
    const callback = this.pending;
    assert.ok(callback);
    this.pending = null;
    callback();
  }
}

test("WD-01 explicit new run opt-in; legacy replay unchanged and implicit enable rejected", () => {
  const f = fixture(false),
    t = open(f);
  try {
    const before = hash(t.store.read());
    assert.throws(
      () => t.store.pulse("pulse", t.pulse(1000)),
      /COST_WATCHDOG_OPT_IN_REQUIRED/,
    );
    assert.equal(hash(t.store.read()), before);
    assert.equal(t.store.read().loop!.watchdog, undefined);
    assert.throws(
      () =>
        new CostSignalProgram(f.input, f.settings, f.selection, {
          watchdog: true,
        }),
      /WATCHDOG_REQUIRES_LOOP/,
    );
    t.tick(1000);
    verified(t);
  } finally {
    t.repo.close();
  }
});

test("WD-02 stale boundary and independent unpaid cash oracle; timer is not settlement", () => {
  const t = open();
  try {
    t.tick(1000);
    const s = t.store.read(),
      before = finances(s);
    assert.equal(costWatchdogNeedsPulse(s, t.pulse(3000)), false);
    assert.equal(costWatchdogNeedsPulse(s, t.pulse(3001)), true);
    assert.throws(
      () => t.store.pulse("noop", t.pulse(3000)),
      /COST_WATCHDOG_NO_CHANGE/,
    );
    t.store.pulse("lost", t.pulse(3001));
    const v = t.view();
    assert.equal(finances(t.store.read()), before);
    assert.equal(v.quantity, 1);
    assert.equal(v.wallet.cash, "5000000");
    assert.equal(v.wallet.payable, String(21400n + 10n));
    assert.equal(v.reservedCash, String(3n * 21400n));
    assert.equal(v.availableCash, String(5000000n - 4n * 21400n - 10n));
    assert.deepEqual(t.store.read().loop!.watchdog!.holds, [
      "WATCHDOG_INPUT_STALE",
    ]);
    assert.ok(
      t.store
        .read()
        .handoff!.admissionHolds.includes("WATCHDOG_REVIEW_REQUIRED"),
    );
    verified(t);
  } finally {
    t.repo.close();
  }
});

test("WD-03 entry TTL intent does not acknowledge cancellation or release any reservation", () => {
  const t = open();
  try {
    const before = finances(t.store.read());
    t.store.pulse("ttl", t.pulse(10000));
    assert.equal(finances(t.store.read()), before);
    assert.ok(
      t.store
        .read()
        .loop!.watchdog!.holds.includes("WATCHDOG_ENTRY_CANCEL_REQUIRED"),
    );
    assert.equal(t.view().orders[0]!.status, "WORKING");
    assert.equal(t.view().reservedCash, "85610");
    const run = t.store.read().book.sources[0]!.config.runId;
    execute(
      t.store,
      run,
      { kind: "CANCEL_REQUEST", id: "cancel", orderId: t.view().orders[0]!.id },
      t.at + 10001,
    );
    execute(
      t.store,
      run,
      {
        kind: "CANCEL_UNKNOWN",
        id: "unknown",
        orderId: t.view().orders[0]!.id,
      },
      t.at + 10002,
    );
    const pending = finances(t.store.read());
    t.store.pulse("unknown-check", t.pulse(90000));
    assert.equal(finances(t.store.read()), pending);
    assert.equal(t.view().orders[0]!.status, "CANCEL_UNKNOWN");
    assert.equal(t.view().reservedCash, "85610");
    verified(t);
  } finally {
    t.repo.close();
  }
});

test("WD-04 no quote at 90 minute boundary; repeated alarms neither close nor grow journal", () => {
  const t = open();
  try {
    buy(t);
    const before = finances(t.store.read());
    t.store.pulse("before", t.pulse(5400999));
    assert.equal(t.store.read().loop!.reason, null);
    t.store.pulse("deadline", t.pulse(5401000));
    const s = t.store.read();
    assert.equal(s.loop!.reason, "TIME");
    assert.equal(s.loop!.deadline, t.at + 5401000);
    assert.equal(s.loop!.status, "HOLD");
    assert.equal(s.outcomes!.length, 0);
    assert.equal(finances(s), before);
    const stateHash = hash(s),
      count = t.store.exportEvidence().records.length;
    for (let i = 1; i <= 20; i++) {
      assert.equal(costWatchdogNeedsPulse(s, t.pulse(5401000 + i)), false);
      assert.throws(
        () => t.store.pulse(`repeat-${i}`, t.pulse(5401000 + i)),
        /COST_WATCHDOG_NO_CHANGE/,
      );
    }
    assert.equal(t.store.exportEvidence().records.length, count);
    assert.equal(hash(t.store.read()), stateHash);
    verified(t);
  } finally {
    t.repo.close();
  }
});

test("WD-05 runtime detects input loss before recovery quote and cannot silently reset HOLD", () => {
  const t = open(),
    time = new ManualTime(t.at + 4000),
    runtime = new CostLoopRuntime(t.store, { clock: time, timer: time });
  try {
    buy(t);
    runtime.start();
    time.advance(3000);
    const before = hash(t.store.read());
    assert.throws(() => t.tick(7000), /COST_WATCHDOG_CHECK_REQUIRED/);
    assert.equal(hash(t.store.read()), before);
    runtime.quote("recovery", t.command(7000));
    assert.ok(
      t.store.read().loop!.watchdog!.holds.includes("WATCHDOG_INPUT_STALE"),
    );
    assert.equal(t.store.read().loop!.status, "HOLD");
    assert.ok(
      t.store
        .read()
        .handoff!.admissionHolds.includes("WATCHDOG_REVIEW_REQUIRED"),
    );
    assert.equal(t.view().quantity, 4);
    const receipt = runtime.quote("recovery", t.command(7000));
    assert.equal(receipt.current.revision, t.store.read().revision);
    verified(t);
  } finally {
    runtime.stop();
    t.repo.close();
  }
});

for (const timerFirst of [true, false])
  test(`WD-06 same-time quote/timer single exit (${timerFirst})`, () => {
    const t = open(),
      time = new ManualTime(t.at + 4000),
      runtime = new CostLoopRuntime(t.store, { clock: time, timer: time });
    try {
      buy(t);
      runtime.start();
      time.advance(5397000);
      if (timerFirst) time.fire();
      runtime.quote("at-deadline", t.command(5401000));
      if (!timerFirst) time.fire();
      assert.equal(t.store.read().loop!.reason, "TIME");
      assert.equal(t.view().orders.filter((o) => o.side === "SELL").length, 1);
      assert.equal(t.view().quantity, 4);
      assert.equal(t.store.read().loop!.watchdog!.pulses, 1);
      const before = t.store.read().revision;
      runtime.quote("at-deadline", t.command(5401000));
      assert.equal(t.store.read().revision, before);
      assert.equal(runtime.status().phase, "RUNNING");
    } finally {
      runtime.stop();
      t.repo.close();
    }
  });

test("WD-07 persistent pulse receipt, deadline and HOLD across reopen with newer epoch", () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), "cost-watchdog-")), "test.sqlite");
  let t = open(f, path);
  try {
    t.tick(1000);
    const receipt = t.store.pulse("lost-response", t.pulse(5401000));
    const before = finances(t.store.read()),
      deadline = t.store.read().loop!.deadline;
    t.repo.close();
    t = open(f, path, false);
    const replay = t.store.pulse("lost-response", t.pulse(5401000));
    assert.deepEqual(replay.receipt, receipt.receipt);
    assert.equal(finances(t.store.read()), before);
    const time = new ManualTime(t.at + 5402000),
      runtime = new CostLoopRuntime(t.store, { clock: time, timer: time });
    try {
      runtime.start();
      assert.equal(t.store.read().loop!.deadline, deadline);
      assert.equal(t.store.read().loop!.reason, "TIME");
      assert.equal(t.view().quantity, 1);
      assert.equal(t.store.read().loop!.watchdog!.pulses, 1);
    } finally {
      runtime.stop();
    }
    const stable = hash(t.store.read());
    assert.throws(
      () => t.store.pulse("lost-response", t.pulse(5401001)),
      /LOCAL_COMMAND_ID_CONFLICT/,
    );
    assert.equal(hash(t.store.read()), stable);
    verified(t);
  } finally {
    t.repo.close();
  }
});

test("WD-08 delayed earlier fill shortens deadline without a quote; receipt time cannot backdate pulse", () => {
  const t = open();
  try {
    t.tick(2000);
    const run = t.store.read().book.sources[0]!.config.runId,
      order = t.view().orders[0]!.id;
    execute(
      t.store,
      run,
      {
        kind: "FILL",
        id: "earlier",
        fillId: "earlier",
        orderId: order,
        quantity: 1,
        price: "21400",
        occurredAt: t.at + 1500,
      },
      t.at + 3000,
    );
    const before = finances(t.store.read());
    t.store.pulse("earliest", t.pulse(3000));
    assert.equal(t.store.read().loop!.deadline, t.at + 5401500);
    assert.equal(finances(t.store.read()), before);
    t.store.pulse("silence", t.pulse(5000));
    assert.throws(
      () =>
        execute(
          t.store,
          run,
          {
            kind: "FILL",
            id: "backdate",
            fillId: "backdate",
            orderId: order,
            quantity: 1,
            price: "21400",
            occurredAt: t.at + 4000,
          },
          t.at + 4000,
        ),
      /COST_WATCHDOG_EVENT_TIME_REGRESSION/,
    );
    assert.equal(finances(t.store.read()), before);
    verified(t);
  } finally {
    t.repo.close();
  }
});

test("WD-09 callback backlog coalesced; cancelled callbacks fenced after stop/restart", () => {
  const t = open(),
    time = new ManualTime(t.at),
    runtime = new CostLoopRuntime(t.store, { clock: time, timer: time });
  try {
    runtime.start();
    const initial = runtime.status().checks;
    assert.throws(() => runtime.start(), /ALREADY_RUNNING/);
    assert.throws(
      () => new CostLoopRuntime(t.store, { clock: time, timer: time }).start(),
      /ALREADY_RUNNING/,
    );
    time.advance(5000);
    time.fire();
    assert.equal(runtime.status().checks, initial + 1);
    assert.equal(runtime.status().lastLagMs, 4750);
    assert.equal(t.store.read().loop!.watchdog!.pulses, 1);
    const callback = time.pending!,
      before = hash(t.store.read());
    runtime.stop();
    callback();
    assert.equal(hash(t.store.read()), before);
    assert.equal(time.pending, null);
    runtime.start();
    const pending = time.pending;
    callback();
    assert.equal(time.pending, pending);
    assert.equal(t.store.read().loop!.watchdog!.pulses, 1);
  } finally {
    runtime.stop();
    t.repo.close();
  }
});

for (const kind of ["wall", "mono", "startup"] as const)
  test(`WD-10 clock regression fails closed (${kind})`, () => {
    const t = open(),
      time = new ManualTime(t.at + 1000),
      runtime = new CostLoopRuntime(t.store, { clock: time, timer: time });
    try {
      t.tick(1000);
      const before = hash(t.store.read());
      if (kind === "startup") {
        time.wall = t.at;
        assert.throws(() => runtime.start(), /TIME_REGRESSION/);
      } else {
        runtime.start();
        time.advance(1000);
        time.fire();
        if (kind === "wall") time.wall--;
        else time.mono--;
        time.fire();
        assert.match(runtime.status().error!, /CLOCK_REGRESSION/);
      }
      assert.equal(runtime.status().phase, "FAULT");
      assert.equal(runtime.status().timerPending, false);
      assert.equal(hash(t.store.read()), before);
      assert.throws(
        () => runtime.quote("forbidden", t.command(1001)),
        /NOT_RUNNING/,
      );
      assert.throws(() => runtime.start(), /RECONCILIATION_REQUIRED/);
    } finally {
      runtime.stop();
      t.repo.close();
    }
  });

test(
  "WD-11 real Node timer detects silence without quote calls and stops cleanly",
  { timeout: 20000 },
  async () => {
    const t = open();
    let runtime: CostLoopRuntime | null = null;
    try {
      t.tick(1000);
      const financial = finances(t.store.read()),
        started = performance.now();
      runtime = new CostLoopRuntime(t.store, {
        intervalMs: 100,
        clock: {
          wallNow: () => t.at + 1000 + Math.floor(performance.now() - started),
          monotonicNow: () => performance.now(),
        },
      });
      runtime.start();
      const timeout = performance.now() + 12000;
      // Bounded, real event-loop delay in this isolated test process only.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
      await delay(0);
      assert.ok(runtime.status().lastLagMs >= 100);
      while (
        runtime.status().pulses === 0 &&
        runtime.status().phase === "RUNNING" &&
        performance.now() < timeout
      )
        await delay(50);
      assert.equal(
        runtime.status().phase,
        "RUNNING",
        runtime.status().error ?? "",
      );
      assert.ok(runtime.status().checks >= 2);
      assert.ok(
        t.store.read().loop!.watchdog!.holds.includes("WATCHDOG_INPUT_STALE"),
      );
      assert.equal(finances(t.store.read()), financial);
      runtime.stop();
      const stopped = hash(t.store.read());
      await delay(200);
      assert.equal(hash(t.store.read()), stopped);
      assert.equal(runtime.status().timerPending, false);
      verified(t);
    } finally {
      runtime?.stop();
      t.repo.close();
    }
  },
);

test("WD-12 expired lease cannot be renewed or reacquired automatically", () => {
  let leaseNow = 1000;
  const t = open(fixture(), ":memory:", true, () => leaseNow),
    time = new ManualTime(t.at),
    runtime = new CostLoopRuntime(t.store, { clock: time, timer: time });
  try {
    runtime.start();
    const before = hash(t.store.read());
    leaseNow = 11001;
    time.advance(5000);
    time.fire();
    assert.equal(runtime.status().phase, "FAULT");
    assert.equal(runtime.status().error, "FENCED_WRITER");
    assert.equal(hash(t.store.read()), before);
    assert.equal(t.repo.epoch, 1);
  } finally {
    runtime.stop();
    t.repo.close();
  }
});

for (const stage of [
  "COMMAND",
  "APPROVALS",
  "FILL_INDEX",
  "STATE",
  "AUDIT",
  "COMMIT",
] as const)
  test(`WD-13 pulse rollback, exact retry and replay (${stage})`, () => {
    const t = open();
    try {
      t.tick(1000);
      const before = t.store.exportEvidence();
      const failing = new CostReservationStore(t.repo, t.program.config(), {
        testStage: (value) => {
          if (value === stage) throw Error("INJECTED_PULSE_FAILURE");
        },
      });
      if (stage === "COMMIT") t.repo.failure = "DISK_FULL";
      assert.throws(
        () => failing.pulse("pulse", t.pulse(3001)),
        /INJECTED_PULSE_FAILURE|DISK_FULL/,
      );
      t.repo.failure = null;
      assert.deepEqual(t.store.exportEvidence(), before);
      const receipt = t.store.pulse("pulse", t.pulse(3001));
      assert.deepEqual(
        t.store.pulse("pulse", t.pulse(3001)).receipt,
        receipt.receipt,
      );
      assert.equal(t.store.read().loop!.watchdog!.pulses, 1);
      verified(t);
    } finally {
      t.repo.failure = null;
      t.repo.close();
    }
  });

test("WD-14 unavailable storage faults runtime without claiming a durable HOLD", () => {
  const t = open(),
    time = new ManualTime(t.at + 1000),
    runtime = new CostLoopRuntime(t.store, { clock: time, timer: time });
  try {
    t.tick(1000);
    runtime.start();
    const before = hash(t.store.read());
    t.repo.failure = "WRITE_FAILURE";
    time.advance(3000);
    time.fire();
    assert.equal(runtime.status().phase, "FAULT");
    assert.equal(runtime.status().error, "WRITE_FAILURE");
    assert.ok(runtime.failure instanceof Error);
    assert.equal(hash(t.store.read()), before);
    assert.equal(runtime.status().timerPending, false);
    assert.equal(t.store.read().loop!.watchdog!.pulses, 0);
  } finally {
    t.repo.failure = null;
    runtime.stop();
    t.repo.close();
  }
});

test("WD-15 elapsed horizon records an alarm at actual check time, not a forged close", () => {
  const t = open(),
    time = new ManualTime(t.at + 1000),
    runtime = new CostLoopRuntime(t.store, { clock: time, timer: time });
  try {
    t.tick(1000);
    runtime.start();
    const before = finances(t.store.read());
    time.advance(t.program.config().horizonEnd - time.wall + 1000);
    time.fire();
    assert.equal(runtime.status().error, "COST_RUNTIME_HORIZON_EXHAUSTED");
    assert.equal(t.store.read().loop!.watchdog!.lastPulseAt, time.wall);
    assert.ok(
      t.store
        .read()
        .loop!.watchdog!.holds.includes("WATCHDOG_HORIZON_EXHAUSTED"),
    );
    assert.equal(finances(t.store.read()), before);
    assert.equal(t.store.read().outcomes!.length, 0);
    verified(t);
  } finally {
    runtime.stop();
    t.repo.close();
  }
});

test("WD-16 invalid inputs, foreign scope, stale epoch and resource cap rejected without mutation", () => {
  const t = open();
  try {
    t.tick(1000);
    const s = t.store.read(),
      before = hash(s);
    for (const raw of [
      { ...t.pulse(3001), purpose: "LIVE" },
      { ...t.pulse(3001), at: NaN },
      { ...t.pulse(3001), quote: t.command(3001).quote },
      { ...t.pulse(3001), instrument: "OTHER" },
    ])
      assert.throws(() => t.store.pulse("invalid", raw));
    assert.throws(
      () => applyCostWatchdog(s, t.pulse(3001), 0),
      /COST_LOOP_EPOCH/,
    );
    const cap = structuredClone(s);
    cap.loop!.watchdog!.pulses = 64;
    assert.throws(
      () => applyCostWatchdog(cap, t.pulse(3001), cap.epoch),
      /COST_WATCHDOG_COMMAND_LIMIT/,
    );
    assert.equal(hash(t.store.read()), before);
  } finally {
    t.repo.close();
  }
});

test("WD-17 idle runner cannot release another runner's local ownership", () => {
  const t = open(),
    time = new ManualTime(t.at),
    running = new CostLoopRuntime(t.store, { clock: time, timer: time }),
    idle = new CostLoopRuntime(t.store, {
      clock: time,
      timer: new ManualTime(t.at),
    });
  try {
    running.start();
    idle.stop();
    assert.throws(() => idle.start(), /COST_RUNTIME_ALREADY_RUNNING/);
    assert.equal(running.status().phase, "RUNNING");
  } finally {
    running.stop();
    idle.stop();
    t.repo.close();
  }
});

test("WD-18 clock failure while arming a timer leaves FAULT, not a phantom RUNNING state", () => {
  const t = open(),
    time = new ManualTime(t.at);
  let samples = 0;
  const runtime = new CostLoopRuntime(t.store, {
    timer: time,
    clock: {
      wallNow: () => time.wall,
      monotonicNow: () => {
        if (++samples === 2) throw Error("CLOCK_UNAVAILABLE");
        return 0;
      },
    },
  });
  try {
    assert.throws(() => runtime.start(), /CLOCK_UNAVAILABLE/);
    assert.equal(runtime.status().phase, "FAULT");
    assert.equal(runtime.status().timerPending, false);
  } finally {
    runtime.stop();
    t.repo.close();
  }
});

test("WD-19 monotonic elapsed time keeps checking when wall clock stops advancing", () => {
  const t = open(),
    time = new ManualTime(t.at + 1000),
    runtime = new CostLoopRuntime(t.store, { clock: time, timer: time });
  try {
    t.tick(1000);
    runtime.start();
    time.mono += 2500;
    time.fire();
    assert.equal(runtime.status().lastCheckedAt, t.at + 3500);
    assert.equal(runtime.status().phase, "RUNNING");
    assert.ok(
      t.store.read().loop!.watchdog!.holds.includes("WATCHDOG_INPUT_STALE"),
    );
    assert.equal(t.view().quantity, 1);
  } finally {
    runtime.stop();
    t.repo.close();
  }
});

test("WD-20 time HOLD allows confirmed risk reduction but not automatic permission recovery", () => {
  const t = open(),
    time = new ManualTime(t.at + 4000),
    runtime = new CostLoopRuntime(t.store, { clock: time, timer: time });
  try {
    buy(t);
    runtime.start();
    time.advance(5397000);
    time.fire();
    runtime.quote("exit-request", t.command(5401000));
    for (const offset of [5402000, 5403000, 5404000, 5405000, 5406000]) {
      time.advance(1000);
      runtime.quote(`exit-${offset}`, t.command(offset));
    }
    const s = t.store.read(),
      v = t.view();
    assert.equal(v.quantity, 0);
    assert.equal(v.tradingFees, "20");
    assert.equal(
      v.wallet.cash,
      String(5000000n - 4n * 21400n + 4n * 21399n - 20n),
    );
    assert.equal(v.wallet.payable, "0");
    assert.equal(v.wallet.receivable, "0");
    assert.equal(v.reservedCash, "0");
    assert.equal(s.outcomes!.length, 1);
    assert.equal(s.outcomes![0]!.netPnlNative, "-24");
    assert.equal(s.seed.ledger.lossStreak, 1);
    assert.equal(s.loop!.status, "HOLD");
    assert.ok(s.handoff!.admissionHolds.includes("WATCHDOG_REVIEW_REQUIRED"));
    assert.equal(s.orderSubmissionAllowed, false);
    verified(t);
  } finally {
    runtime.stop();
    t.repo.close();
  }
});

test("WD-21 unknown exit remains reserved after no-progress alarm and fresh quote", () => {
  const t = open(),
    time = new ManualTime(t.at + 4000),
    runtime = new CostLoopRuntime(t.store, { clock: time, timer: time });
  try {
    buy(t);
    runtime.start();
    time.advance(5397000);
    time.fire();
    runtime.quote("exit-request", t.command(5401000));
    const run = t.store.read().book.sources[0]!.config.runId;
    execute(
      t.store,
      run,
      { kind: "UNKNOWN", id: "lost-sell", orderId: "loop-exit-0" },
      t.at + 5401001,
    );
    const before = finances(t.store.read());
    time.advance(3000);
    time.fire();
    assert.equal(finances(t.store.read()), before);
    assert.ok(
      t.store
        .read()
        .loop!.watchdog!.holds.includes("WATCHDOG_EXIT_REVIEW_REQUIRED"),
    );
    runtime.quote("fresh-but-unknown", t.command(5404000));
    assert.equal(t.view().orders.filter((o) => o.side === "SELL").length, 1);
    assert.equal(t.view().orders.at(-1)!.status, "UNKNOWN");
    assert.equal(t.view().quantity, 4);
    assert.equal(t.view().reservedSellQuantity, 4);
    assert.equal(t.view().reservedCash, "10");
    verified(t);
  } finally {
    runtime.stop();
    t.repo.close();
  }
});
