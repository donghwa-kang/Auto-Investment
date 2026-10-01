import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import type { ReservationWriteStage } from "../src/server/cost-reservation-store.js";
import { hash } from "../src/core/policy.js";
import { d } from "../src/core/math.js";
import { guards } from "../src/core/risk.js";
import { handoffKind, reservationKind } from "../src/core/cost-reservation.js";
import { applyHandoffCommand } from "../src/core/cost-handoff.js";
import { costRequest } from "./transaction-cost-helpers.js";
import { observation, proposal } from "./cost-reservation-helpers.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";
import {
  outcomeConfig,
  openedOutcome,
  beginTrade,
  source,
  journal,
  execute,
  fillEvent,
  fillTrade,
  sellOrder,
  closeTrade,
  cancelOrder,
} from "./cost-outcome-helpers.js";

const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "cost-outcome-")), "test.sqlite");
const record = (store: CostReservationStore) => store.read().outcomes![0]!;

test("CO-20 USD result uses known close FX, not entry FX or later FX", () => {
  const { repo, store } = openedOutcome(outcomeConfig("US"));
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    let s = store.read();
    const obs = observation(s);
    obs.fx = "1500";
    store.observe("close-fx", obs, s);
    s = closeTrade(store, run, "40.3");
    const o = record(store);
    assert.equal(o.fx, "1500");
    assert.equal(o.fxAt, obs.fxAt);
    assert.equal(o.netPnlNative, "0.28");
    assert.equal(o.netPnlKrw, "420");
    const later = observation(s);
    later.fx = "1600";
    store.observe("later", later, s);
    assert.deepEqual(record(store), o);
  } finally {
    repo.close();
  }
});

test("CO-21 close time is evidence acceptance, not fill occurrence or settlement", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    const s = sellOrder(store, run, "10000");
    const e = fillEvent(s, run, "exit", 1, "10000", s.seed.clock + 10);
    e.occurredAt = s.seed.clock;
    store.execute("close", run, e, s);
    assert.equal(record(store).closedAt, e.at);
    assert.equal(record(store).cooldownUntil, e.at + 3600000);
  } finally {
    repo.close();
  }
});

test("CO-22 future FX observation is rejected with unchanged financial and outcome records", () => {
  const { repo, store } = openedOutcome(outcomeConfig("US"));
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    const s = store.read(),
      obs = observation(s),
      before = dumpHandoff(repo);
    obs.fxAt = obs.at + 1;
    assert.throws(
      () => store.observe("future", obs, s),
      /OBSERVATION_SOURCE_TIME/,
    );
    assert.deepEqual(dumpHandoff(repo), before);
    closeTrade(store, run, "40.3");
    assert.equal(record(store).netPnlKrw, "364");
  } finally {
    repo.close();
  }
});

test("CO-23 overreported protection at close holds admission without deleting actual PnL", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    let s = store.read();
    const obs = observation(s);
    obs.observations[0]!.observation.protectedQuantity = 1;
    store.observe("protected", obs, s);
    s = closeTrade(store, run, "10000");
    assert.equal(record(store).netPnlKrw, "-20");
    assert.equal(s.seed.ledger.lossStreak, 1);
    assert.ok(
      s.handoff!.admissionHolds.includes(
        "RISK_HISTORY_RECONCILIATION_REQUIRED",
      ),
    );
    const corrected = observation(s);
    corrected.observations[0]!.observation.protectedQuantity = 0;
    s = store.observe("corrected", corrected, s).current;
    assert.ok(
      s.handoff!.admissionHolds.includes(
        "RISK_HISTORY_RECONCILIATION_REQUIRED",
      ),
    );
    assert.equal(s.outcomes!.length, 1);
  } finally {
    repo.close();
  }
});

test("CO-24 known excessive loss latches even after earlier unresolved FX close", () => {
  const c = outcomeConfig("US");
  c.seed.ledger.lossStreak = 1;
  c.book.seedHash = hash(c.seed);
  const { repo, store } = openedOutcome(c);
  try {
    const early = beginTrade(store, "EARLY"),
      late = beginTrade(store, "LATE");
    fillTrade(store, early);
    fillTrade(store, late);
    sellOrder(store, early, "40.3");
    fillTrade(
      store,
      early,
      "exit",
      1,
      "40.3",
      store.read().seed.ledger.fxAt + 60001,
    );
    let s = store.read();
    store.observe("fresh", observation(s), s);
    s = closeTrade(store, late, "20");
    assert.equal(s.outcomes![1]!.counterApplied, false);
    assert.equal(s.outcomes![1]!.netPnlKrw, "-26026");
    assert.equal(s.seed.ledger.lossStreak, 1);
    assert.ok(
      d(s.outcomes![1]!.netPnlKrw!)
        .neg()
        .gt(d(s.outcomes![1]!.initialBudgetKrw).mul(2)),
    );
    assert.ok(s.seed.ledger.halts.includes("STOP_LOSS_EXCEEDS_2X"));
    assert.equal(s.seed.status, "HALTED");
  } finally {
    repo.close();
  }
});

test("CO-25 trading costs include tax and exchange charges, not only commission", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store, "FIRST", 1, "CONFIRMED", (p) => {
      for (const rule of p.rules)
        if (rule.component !== "COMMISSION") rule.minimum = "1";
    });
    fillTrade(store, run);
    const s = closeTrade(store, run, "10100");
    assert.equal(record(store).tradingFees, "24");
    assert.equal(record(store).netPnlKrw, "76");
    assert.equal(
      journal(s, run)
        .postings.flatMap((p) => p.lines)
        .every((l) => d(l.amountDelta).gt(0)),
      true,
    );
  } finally {
    repo.close();
  }
});

for (const market of ["KR", "US"] as const)
  test(`CO-01 ${market}: closed native journal PnL/cooldown once before settlement`, () => {
    const { repo, store } = openedOutcome(outcomeConfig(market));
    try {
      const run = beginTrade(store);
      fillTrade(store, run);
      const s = closeTrade(store, run, market === "KR" ? "10100" : "40.3");
      const o = record(store),
        v = journal(s, run);
      assert.equal(o.netPnlNative, market === "KR" ? "80" : "0.28");
      assert.equal(o.netPnlKrw, market === "KR" ? "80" : "364");
      assert.equal(o.tradingFees, market === "KR" ? "20" : "0.02");
      assert.equal(o.closedAt, s.seed.clock);
      assert.equal(o.closedRevision, s.revision);
      assert.equal(o.initialBudgetKrw, s.approvals[0]!.candidate.budgetKrw);
      assert.equal(o.cooldownUntil, o.closedAt + 3600000);
      assert.equal(s.seed.ledger.cooldowns.FIRST, o.cooldownUntil);
      assert.equal(o.counterApplied, true);
      assert.equal(o.lossStreakAfter, 0);
      assert.deepEqual(o.pendingReasons, []);
      assert.equal(
        v.postings.every((p) => p.settledAt === null),
        true,
      );
      assert.equal(d(v.wallet.receivable).gt(0), true);
      assert.equal(d(v.wallet.payable).gt(0), true);
      assert.equal(
        d(v.economicCash)
          .minus(source(s, run).config.execution.initialCash)
          .toString(),
        o.netPnlNative,
      );
      assert.deepEqual(s.handoff!.admissionHolds, []);
      assert.equal(store.context().status, "OK");
      assert.equal(s.learningAllowed, false);
      assert.equal(s.orderSubmissionAllowed, false);
      assert.equal(s.liveEnabled, false);
      const settled = execute(store, run, {
        kind: "SETTLE",
        id: "settle",
        fillIds: v.postings.map((p) => p.fill.fillId),
      });
      assert.deepEqual(settled.outcomes, s.outcomes);
      assert.equal(journal(settled, run).wallet.receivable, "0");
      assert.equal(journal(settled, run).wallet.payable, "0");
      assert.equal(
        d(journal(settled, run).wallet.cash)
          .minus(source(s, run).config.execution.initialCash)
          .toString(),
        o.netPnlNative,
      );
      assert.throws(
        () => store.prepare(proposal(store, "FIRST")),
        /EXISTING_SYMBOL_REENTRY_UNSUPPORTED/,
      );
      assert.ok(store.prepare(proposal(store, "NEXT")).candidate.quantity > 0);
    } finally {
      repo.close();
    }
  });

for (const unit of ["ORDER", "FILL"] as const)
  test(`CO-02 ${unit}: split fills and replacement fees are counted exactly once`, () => {
    const { repo, store } = openedOutcome();
    try {
      const run = beginTrade(store, "FIRST", 3, "CONFIRMED", (p) => {
        for (const r of p.rules) r.unit = unit;
      });
      fillTrade(store, run);
      fillTrade(store, run, "entry", 2);
      sellOrder(store, run, "10100");
      fillTrade(store, run, "exit");
      assert.deepEqual(store.read().outcomes, []);
      cancelOrder(store, run, "exit");
      sellOrder(store, run, "10100", "replacement", "exit");
      fillTrade(store, run, "replacement");
      const s = fillTrade(store, run, "replacement");
      assert.equal(s.outcomes!.length, 1);
      assert.equal(record(store).quantity, 3);
      assert.equal(record(store).tradingFees, unit === "ORDER" ? "30" : "50");
      assert.equal(
        record(store).netPnlNative,
        unit === "ORDER" ? "270" : "250",
      );
      assert.equal(record(store).tradingFees, journal(s, run).tradingFees);
    } finally {
      repo.close();
    }
  });

test("CO-03 unfilled cancellation is not a trade; unknown partial fill closes only after all terminals", () => {
  const { repo, store } = openedOutcome();
  try {
    const empty = beginTrade(store, "EMPTY");
    cancelOrder(store, empty);
    assert.deepEqual(store.read().outcomes, []);
    assert.deepEqual(store.read().seed.ledger.cooldowns, {});
    const run = beginTrade(store, "PARTIAL", 3, "UNKNOWN");
    fillTrade(store, run);
    assert.equal(journal(store.read(), run).orders[0]!.status, "UNKNOWN");
    assert.deepEqual(store.read().outcomes, []);
    cancelOrder(store, run);
    const s = closeTrade(store, run, "10000");
    assert.equal(s.outcomes!.length, 1);
    assert.equal(record(store).symbol, "PARTIAL");
    assert.equal(record(store).quantity, 1);
    assert.equal(record(store).netPnlKrw, "-20");
    assert.equal(s.seed.ledger.lossStreak, 1);
  } finally {
    repo.close();
  }
});

for (const middle of ["10020", "10021"] as const)
  test(`CO-04 loss then ${middle === "10020" ? "zero" : "profit"} then loss preserves original streak rule`, () => {
    const { repo, store } = openedOutcome();
    try {
      // Default entry is 10000; use 10020 for exactly zero after 20 costs.
      for (const [i, price] of ["10000", middle, "10000"].entries()) {
        const run = beginTrade(store, `TRADE${i}`);
        fillTrade(store, run);
        closeTrade(store, run, price);
      }
      const s = store.read();
      assert.deepEqual(
        s.outcomes!.map((o) => o.lossStreakAfter),
        middle === "10020" ? [1, 1, 2] : [1, 0, 1],
      );
      assert.equal(
        s.seed.ledger.halts.includes("CONSECUTIVE_LOSSES"),
        middle === "10020",
      );
      if (middle === "10020")
        assert.throws(
          () => store.prepare(proposal(store, "NEXT")),
          /ENTRY_NOT_RUNNING,CONSECUTIVE_LOSSES/,
        );
    } finally {
      repo.close();
    }
  });

for (const above of [false, true])
  test(`CO-05 loss ${above ? "above" : "exactly"} twice original approved budget`, () => {
    const { repo, store } = openedOutcome();
    try {
      const run = beginTrade(store, "FIRST", 4);
      const a = store.read().approvals[0]!;
      assert.equal(a.candidate.quantity, 4);
      fillTrade(store, run, "entry", 4);
      const price = d(a.candidate.entry)
        .mul(4)
        .minus(d(a.candidate.budgetKrw).mul(2))
        .plus(20)
        .div(4)
        .minus(above ? "0.25" : 0)
        .toString();
      const s = closeTrade(store, run, price);
      assert.equal(
        record(store).netPnlKrw,
        d(a.candidate.budgetKrw)
          .mul(-2)
          .minus(above ? 1 : 0)
          .toString(),
      );
      assert.equal(s.seed.ledger.halts.includes("STOP_LOSS_EXCEEDS_2X"), above);
      assert.notEqual(a.candidate.budgetKrw, a.candidate.riskKrw);
    } finally {
      repo.close();
    }
  });

test("CO-06 loss halt remains latched after later existing position closes profitably", () => {
  const c = outcomeConfig();
  c.seed.ledger.lossStreak = 1;
  c.book.seedHash = hash(c.seed);
  const { repo, store } = openedOutcome(c);
  try {
    const loss = beginTrade(store, "LOSS"),
      win = beginTrade(store, "WIN");
    fillTrade(store, loss);
    fillTrade(store, win);
    closeTrade(store, loss, "10000");
    assert.equal(store.read().seed.status, "HALTED");
    const s = closeTrade(store, win, "10100");
    assert.equal(s.seed.ledger.lossStreak, 0);
    assert.equal(s.seed.status, "HALTED");
    assert.ok(s.seed.ledger.halts.includes("CONSECUTIVE_LOSSES"));
  } finally {
    repo.close();
  }
});

test("CO-07 equal close timestamps follow committed execution order, not transfer name/order", () => {
  const c = outcomeConfig();
  c.seed.ledger.lossStreak = 1;
  c.book.seedHash = hash(c.seed);
  const { repo, store } = openedOutcome(c);
  try {
    const loss = beginTrade(store, "ALOSS"),
      win = beginTrade(store, "ZWIN");
    fillTrade(store, loss);
    fillTrade(store, win);
    sellOrder(store, loss, "10000");
    sellOrder(store, win, "10100");
    const at = store.read().seed.clock + 1;
    fillTrade(store, win, "exit", 1, "10100", at);
    const s = fillTrade(store, loss, "exit", 1, "10000", at);
    assert.deepEqual(
      s.outcomes!.map((o) => [o.symbol, o.closedAt, o.lossStreakAfter]),
      [
        ["ZWIN", at, 0],
        ["ALOSS", at, 1],
      ],
    );
    assert.ok(s.outcomes![0]!.closedRevision < s.outcomes![1]!.closedRevision);
    assert.equal(s.seed.ledger.halts.includes("CONSECUTIVE_LOSSES"), false);
  } finally {
    repo.close();
  }
});

for (const age of [60000, 60001])
  test(`CO-08 USD close FX age ${age}ms boundary and no retroactive restatement`, () => {
    const { repo, store } = openedOutcome(outcomeConfig("US"));
    try {
      const run = beginTrade(store);
      fillTrade(store, run);
      sellOrder(store, run, "40.3");
      let s = store.read();
      const at = s.seed.ledger.fxAt + age;
      const obs = observation(s, at - s.seed.clock - 1);
      obs.fxAt = s.seed.ledger.fxAt;
      store.observe("before-close", obs, s);
      s = fillTrade(store, run, "exit", 1, "40.3", at);
      const o = record(store);
      assert.equal(o.netPnlNative, "0.28");
      assert.equal(o.netPnlKrw, age === 60000 ? "364" : null);
      assert.equal(o.counterApplied, age === 60000);
      assert.equal(o.fx, age === 60000 ? "1300" : null);
      assert.equal(o.cooldownUntil, at + 3600000);
      const next = observation(s);
      next.fx = "1500";
      s = store.observe("new-fx", next, s).current;
      assert.deepEqual(record(store), o);
      if (age > 60000) {
        assert.ok(
          s.handoff!.admissionHolds.includes(
            "CLOSE_FX_RECONCILIATION_REQUIRED",
          ),
        );
        assert.equal(store.context().status, "HOLD");
      }
    } finally {
      repo.close();
    }
  });

test("CO-09 unresolved earlier close prevents later fresh win resetting loss history", () => {
  const c = outcomeConfig("US");
  c.seed.ledger.lossStreak = 1;
  c.book.seedHash = hash(c.seed);
  const { repo, store } = openedOutcome(c);
  try {
    const early = beginTrade(store, "EARLY"),
      late = beginTrade(store, "LATE");
    fillTrade(store, early);
    fillTrade(store, late);
    sellOrder(store, early, "40.3");
    const at = store.read().seed.ledger.fxAt + 60001;
    fillTrade(store, early, "exit", 1, "40.3", at);
    let s = store.read();
    store.observe("fresh", observation(s), s);
    s = closeTrade(store, late, "40.3");
    assert.equal(s.seed.ledger.lossStreak, 1);
    assert.equal(s.outcomes![1]!.netPnlKrw, "364");
    assert.equal(s.outcomes![1]!.lossStreakAfter, null);
    assert.ok(
      s.outcomes![1]!.pendingReasons.includes(
        "CLOSE_SEQUENCE_RECONCILIATION_REQUIRED",
      ),
    );
    assert.equal(store.context().status, "HOLD");
  } finally {
    repo.close();
  }
});

test("CO-10 KRW close still records known outcome under stale FX/risk-history hold", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    sellOrder(store, run, "10000");
    const s = fillTrade(
      store,
      run,
      "exit",
      1,
      "10000",
      store.read().seed.ledger.fxAt + 60001,
    );
    assert.equal(record(store).netPnlKrw, "-20");
    assert.equal(s.seed.ledger.lossStreak, 1);
    assert.ok(
      s.handoff!.admissionHolds.includes(
        "RISK_HISTORY_RECONCILIATION_REQUIRED",
      ),
    );
    assert.equal(record(store).fx, "1");
    assert.equal(record(store).fxAt, null);
  } finally {
    repo.close();
  }
});

test("CO-11 cooldown guard has original exact 60 minute boundary, not autonomous reentry", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    closeTrade(store, run, "10100");
    const s = store.read().seed,
      until = record(store).cooldownUntil;
    // Isolated original guard test; V3 does not support a one-hour live session
    // or same-symbol round-trip migration merely because cooldown elapsed.
    for (const offset of [-1, 0]) {
      s.clock = until + offset;
      s.ledger.fxAt = s.clock;
      s.ledger.accountAt = s.clock;
      const quote = {
        ...costRequest(s, store.read().approvals[0]!.proposal.profile).quote,
        at: s.clock,
      };
      assert.equal(
        guards(s, quote, s.clock, "FIRST").includes("COOLDOWN"),
        offset < 0,
      );
    }
  } finally {
    repo.close();
  }
});

test("CO-12 duplicate final fill, settlement, observation, reopen and new epoch do not recount", () => {
  const path = fresh(),
    c = outcomeConfig();
  let { repo, store } = openedOutcome(c, path);
  const run = beginTrade(store);
  fillTrade(store, run);
  const before = sellOrder(store, run, "10000"),
    e = fillEvent(before, run, "exit");
  const original = store.execute("close", run, e, before),
    closed = original.current;
  repo.close();
  repo = new Repository(path, () => 20000);
  repo.acquire();
  store = new CostReservationStore(repo, c);
  try {
    assert.deepEqual(store.read(), closed);
    const retry = { ...e, id: "redelivery", seq: e.seq + 1, at: e.at + 1 };
    const dup = store.execute("retry", run, retry, store.read());
    assert.equal(dup.duplicate, true);
    assert.deepEqual(dup.receipt, original.receipt);
    assert.deepEqual(dup.current, closed);
    const conflicting = { ...retry, price: "10001" },
      snapshot = dumpHandoff(repo);
    assert.throws(
      () => store.execute("conflict", run, conflicting, closed),
      /FILL_ID_CONFLICT/,
    );
    assert.deepEqual(dumpHandoff(repo), snapshot);
    let s = execute(store, run, {
      kind: "SETTLE",
      id: "settle",
      fillIds: journal(closed, run).postings.map((p) => p.fill.fillId),
    });
    s = store.observe("refresh", observation(s), s).current;
    assert.ok(s.epoch > closed.epoch);
    assert.deepEqual(s.outcomes, closed.outcomes);
    assert.equal(s.seed.ledger.lossStreak, 1);
    assert.deepEqual(s.seed.ledger.cooldowns, closed.seed.ledger.cooldowns);
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
  test(`CO-13 ${stage} exception rolls back closing fill/outcome/counters/cash/audit`, () => {
    const c = outcomeConfig(),
      repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    let armed = false;
    const store = new CostReservationStore(repo, c, {
      initialize: true,
      testStage: (s) => {
        if (armed && s === stage) throw Error("FAILPOINT");
      },
    });
    try {
      const run = beginTrade(store);
      fillTrade(store, run);
      const s = sellOrder(store, run, "10000"),
        e = fillEvent(s, run, "exit"),
        before = dumpHandoff(repo);
      armed = true;
      assert.throws(() => store.execute("close", run, e, s), /FAILPOINT/);
      assert.deepEqual(dumpHandoff(repo), before);
      assert.equal(store.read().outcomes!.length, 0);
      armed = false;
      assert.equal(
        store.execute("close", run, e, s).current.seed.ledger.lossStreak,
        1,
      );
    } finally {
      repo.close();
    }
  });

test("CO-14 expired lease at closing audit cannot commit an outcome or renew authority", () => {
  let now = 1000,
    armed = false;
  const repo = new Repository(":memory:", () => now);
  repo.acquire();
  const store = new CostReservationStore(repo, outcomeConfig(), {
    initialize: true,
    testStage: (s) => {
      if (armed && s === "AUDIT") now += 10000;
    },
  });
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    const s = sellOrder(store, run, "10000"),
      e = fillEvent(s, run, "exit"),
      before = dumpHandoff(repo);
    armed = true;
    assert.throws(() => store.execute("close", run, e, s), /FENCED_WRITER/);
    assert.deepEqual(dumpHandoff(repo), before);
  } finally {
    repo.close();
  }
});

test("CO-15 closed outcome forgery with recomputed snapshot checksum fails command replay", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    const s = closeTrade(store, run, "10000");
    s.outcomes![0]!.netPnlKrw = "999";
    s.seed.ledger.lossStreak = 0;
    s.book.seedHash = hash(s.seed);
    repo.db
      .prepare("UPDATE cost_reservation_run SET body=?,checksum=?")
      .run(JSON.stringify(s), hash(s));
    assert.throws(() => store.read(), /STATE_REPLAY_MISMATCH/);
  } finally {
    repo.close();
  }
});

test("CO-16 V3 requires fresh sources and cannot reinterpret V1/V2 configuration", () => {
  const { repo, store, c } = openedOutcome();
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    const s = closeTrade(store, run, "10000");
    for (const kind of [reservationKind, handoffKind] as const)
      assert.throws(
        () => new CostReservationStore(repo, { ...c, kind }),
        /MODE_CONFLICT|CONFIG_MISMATCH/,
      );
    assert.throws(() => repo.read(), /REQUIRES_VERSIONED_READER/);
    const imported = { ...c, book: { ...c.book, sources: s.book.sources } };
    const other = new Repository(":memory:", () => 1000);
    other.acquire();
    try {
      assert.throws(
        () => new CostReservationStore(other, imported, { initialize: true }),
        /REQUIRES_EMPTY_SOURCES/,
      );
    } finally {
      other.close();
    }
  } finally {
    repo.close();
  }
});

test("CO-17 pure handoff reducer cannot bypass V3 outcome integration and leaves input unchanged", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    const s = sellOrder(store, run, "10000"),
      original = structuredClone(s),
      e = fillEvent(s, run, "exit");
    const next = applyHandoffCommand(
      s,
      { kind: "EXECUTION", runId: run, event: e },
      s.epoch,
    );
    assert.deepEqual(s, original);
    assert.equal(next.outcomes!.length, 1);
    assert.equal(next.seed.ledger.lossStreak, 1);
    assert.deepEqual(next, store.execute("close", run, e, s).current);
  } finally {
    repo.close();
  }
});

test("CO-18 second connection sees no partially committed close at every SQL stage", () => {
  const path = fresh(),
    c = outcomeConfig(),
    repo = new Repository(path, () => 1000);
  repo.acquire();
  const reader = new DatabaseSync(path);
  let armed = false;
  const stages: ReservationWriteStage[] = [];
  const store = new CostReservationStore(repo, c, {
    initialize: true,
    testStage: (stage) => {
      if (!armed) return;
      stages.push(stage);
      const old = JSON.parse(
        String(
          reader.prepare("SELECT body FROM cost_reservation_run").get()!.body,
        ),
      );
      assert.equal(old.outcomes.length, 0);
      assert.equal(old.seed.ledger.lossStreak, 0);
      assert.equal(
        reader
          .prepare("SELECT COUNT(*) AS n FROM cost_reservation_fills")
          .get()!.n,
        1,
      );
    },
  });
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    const s = sellOrder(store, run, "10000"),
      e = fillEvent(s, run, "exit");
    armed = true;
    store.execute("close", run, e, s);
    assert.deepEqual(stages, [
      "COMMAND",
      "APPROVALS",
      "FILL_INDEX",
      "STATE",
      "AUDIT",
    ]);
    const closed = JSON.parse(
      String(
        reader.prepare("SELECT body FROM cost_reservation_run").get()!.body,
      ),
    );
    assert.equal(closed.outcomes.length, 1);
    assert.equal(closed.seed.ledger.lossStreak, 1);
  } finally {
    reader.close();
    repo.close();
  }
});

for (const stage of ["FILL_INDEX", "STATE", "AUDIT", "COMMITTED"] as const)
  test(`CO-19 owned child terminated at ${stage}: closing money/outcome all or none`, async () => {
    const path = fresh();
    const child = spawn(
      process.execPath,
      ["scripts/cost-outcome-crash-fixture.mjs", path, stage],
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
          const timer = setTimeout(
            () => reject(Error("FIXTURE_TIMEOUT")),
            30000,
          );
          timer.unref();
        }),
      ]);
      assert.deepEqual(signal[0], { stage });
      const exit = once(child, "exit");
      child.kill();
      await exit;
      const repo = new Repository(path, () => 20000);
      repo.acquire();
      try {
        const store = new CostReservationStore(repo, outcomeConfig()),
          s = store.read(),
          committed = stage === "COMMITTED";
        assert.equal(s.outcomes!.length, committed ? 1 : 0);
        assert.equal(s.seed.ledger.lossStreak, committed ? 1 : 0);
        assert.equal(
          repo.db
            .prepare("SELECT COUNT(*) AS n FROM cost_reservation_fills")
            .get()!.n,
          committed ? 2 : 1,
        );
        assert.equal(d(s.handoff!.accounts.KRW.receivable).gt(0), committed);
        assert.equal(
          Object.keys(s.seed.ledger.cooldowns).length,
          committed ? 1 : 0,
        );
        assert.equal(hash(store.read()), hash(s));
      } finally {
        repo.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
