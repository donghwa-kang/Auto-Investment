import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { replayCostJournal } from "../src/core/cost-journal.js";
import { d, ceil } from "../src/core/math.js";
import { hash, policy } from "../src/core/policy.js";
import { caps } from "../src/core/ledger.js";
import {
  applyHandoffCommand,
  requiredHandoffEventSlots,
} from "../src/core/cost-handoff.js";
import { reservationKind } from "../src/core/cost-reservation.js";
import { proposal, observation } from "./cost-reservation-helpers.js";
import {
  handoffConfig,
  openedHandoff,
  transferred,
  managed,
  fill,
  execute,
  settle,
  dumpHandoff,
} from "./cost-handoff-helpers.js";

const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "cost-handoff-")), "test.sqlite");

test("CH-17 insufficient per-source termination capacity refuses handoff without resizing or releasing approval", () => {
  const { repo, store } = openedHandoff(handoffConfig("US"));
  try {
    const p = proposal(store);
    Object.assign(p.request, {
      tickSize: "0.01",
      stop: "0.99",
      atr: "0.01",
      signalClose: "1",
    });
    Object.assign(p.request.quote, {
      bid: "1",
      ask: "1",
      askSize: Math.ceil(
        (10000 * 200) /
          policy.execution.maximum_best_ask_size_participation_bps,
      ),
    });
    Object.assign(p.request.forecast, { expectedExit: "1.2", q05Exit: "0.99" });
    store.reserve("reserve", store.prepare(p));
    const s = store.read(),
      snapshot = dumpHandoff(repo);
    assert.equal(s.approvals[0]!.candidate.quantity, 200);
    assert.throws(
      () => store.prepareHandoff("r-FIRST", "CONFIRMED"),
      /TERMINATION_CAPACITY/,
    );
    assert.deepEqual(dumpHandoff(repo), snapshot);
    assert.equal(
      store.release("release", "r-FIRST", s).current.approvals[0]!.status,
      "RELEASED_LOCAL",
    );
  } finally {
    repo.close();
  }
});
test("CH-18 repetitive unknown notifications preserve slots for one-share fills, two replacements and settlement", () => {
  const { repo, store } = openedHandoff();
  try {
    const p = proposal(store);
    p.request.quote.askSize = Math.ceil(
      30000 / policy.execution.maximum_best_ask_size_participation_bps,
    );
    store.reserve("reserve", store.prepare(p));
    let s = store.handoff(
      "handoff",
      store.prepareHandoff("r-FIRST", "UNKNOWN"),
    ).current;
    const source = managed(s);
    s = applyHandoffCommand(
      s,
      {
        kind: "EXECUTION",
        runId: source.config.runId,
        event: {
          kind: "CANCEL_UNKNOWN",
          id: "unknown",
          seq: source.events.length + 1,
          at: s.seed.clock + 1,
          orderId: "entry",
        },
      },
      s.epoch,
    );
    const boundarySource = managed(s);
    const remaining = requiredHandoffEventSlots(
      replayCostJournal(boundarySource.config, boundarySource.events),
    );
    // Construct one independently replayed, non-financial prefix fixture.
    // This tests the source boundary, not 475 repeated full-store replays/SLA.
    while (boundarySource.events.length < 500 - remaining) {
      boundarySource.events.push({
        kind: "CANCEL_UNKNOWN",
        id: `repeat-${boundarySource.events.length}`,
        seq: boundarySource.events.length + 1,
        at: s.seed.clock,
        orderId: "entry",
      });
      s.revision++;
    }
    const vAtBoundary = replayCostJournal(
      boundarySource.config,
      boundarySource.events,
    );
    assert.equal(vAtBoundary.uniqueEvents, boundarySource.events.length);
    assert.equal(
      boundarySource.events.length + requiredHandoffEventSlots(vAtBoundary),
      500,
    );
    assert.throws(
      () =>
        applyHandoffCommand(
          s,
          {
            kind: "EXECUTION",
            runId: boundarySource.config.runId,
            event: {
              kind: "CANCEL_UNKNOWN",
              id: "overflow",
              seq: boundarySource.events.length + 1,
              at: s.seed.clock,
              orderId: "entry",
            },
          },
          s.epoch,
        ),
      /TERMINATION_CAPACITY/,
    );
    const q = s.approvals[0]!.candidate.quantity;
    // Each remaining share may need its own fill and explicit settlement.
    for (let i = 0; i < q; i++) {
      s = applyHandoffCommand(
        s,
        {
          kind: "EXECUTION",
          runId: managed(s).config.runId,
          event: fill(s, `tail-${i}`),
        },
        s.epoch,
      );
      s = applyHandoffCommand(
        s,
        {
          kind: "EXECUTION",
          runId: managed(s).config.runId,
          event: settle(s, [`tail-${i}`]),
        },
        s.epoch,
      );
    }
    const seq = managed(s).events.length + 1;
    s = applyHandoffCommand(
      s,
      {
        kind: "EXECUTION",
        runId: managed(s).config.runId,
        event: {
          kind: "ORDER",
          id: "sell",
          seq,
          at: s.seed.clock + 1,
          orderId: "exit",
          side: "SELL",
          quantity: q,
          limit: "10100",
          replaces: null,
        },
      },
      s.epoch,
    );
    let exitId = "exit";
    for (let replacement = 1; replacement <= 2; replacement++) {
      for (const kind of [
        "CANCEL_REQUEST",
        "CANCEL_UNKNOWN",
        "CANCEL_CONFIRMED",
      ] as const) {
        const at = s.seed.clock + 1;
        const event = {
          kind,
          id: `${kind}-${replacement}`,
          seq: managed(s).events.length + 1,
          at,
          orderId: exitId,
          ...(kind === "CANCEL_CONFIRMED"
            ? { cumulativeQuantity: 0, cumulativeValue: "0", evidenceAt: at }
            : {}),
        };
        s = applyHandoffCommand(
          s,
          { kind: "EXECUTION", runId: managed(s).config.runId, event },
          s.epoch,
        );
      }
      const previousExit = exitId;
      exitId = `exit-${replacement}`;
      s = applyHandoffCommand(
        s,
        {
          kind: "EXECUTION",
          runId: managed(s).config.runId,
          event: {
            kind: "ORDER",
            id: `replacement-${replacement}`,
            seq: managed(s).events.length + 1,
            at: s.seed.clock + 1,
            orderId: exitId,
            side: "SELL",
            quantity: q,
            limit: "10100",
            replaces: previousExit,
          },
        },
        s.epoch,
      );
    }
    for (let i = 0; i < q; i++) {
      s = applyHandoffCommand(
        s,
        {
          kind: "EXECUTION",
          runId: managed(s).config.runId,
          event: fill(s, `sell-${i}`, 1, exitId, "10100"),
        },
        s.epoch,
      );
      s = applyHandoffCommand(
        s,
        {
          kind: "EXECUTION",
          runId: managed(s).config.runId,
          event: settle(s, [`sell-${i}`]),
        },
        s.epoch,
      );
    }
    const v = replayCostJournal(managed(s).config, managed(s).events);
    assert.equal(v.quantity, 0);
    assert.equal(v.wallet.payable, "0");
    assert.equal(v.wallet.receivable, "0");
    assert.equal(requiredHandoffEventSlots(v), 0);
    assert.ok(managed(s).events.length <= 500);
  } finally {
    repo.close();
  }
});
test("CH-19 two managed sources cannot create SELL reservation by double-counting their common opening USD", () => {
  const c = handoffConfig("US");
  c.seed.ledger.wallets.USD.cash = "80.03";
  c.seed.ledger.wallets.KRW.cash = d(5000000)
    .minus(d("80.03").mul(1300))
    .toString();
  c.book.seedHash = hash(c.seed);
  const { repo, store } = openedHandoff(c);
  try {
    for (const name of ["FIRST", "SECOND"]) {
      const p = proposal(store, name);
      p.request.quote.askSize = Math.ceil(
        10000 / policy.execution.maximum_best_ask_size_participation_bps,
      );
      const approved = store.prepare(p);
      assert.equal(approved.candidate.quantity, 1);
      store.reserve(`reserve-${name}`, approved);
      store.handoff(
        `handoff-${name}`,
        store.prepareHandoff(`r-${name}`, "CONFIRMED"),
      );
    }
    let s = store.read();
    assert.equal(s.handoff!.accounts.USD.cash, "80.03");
    assert.equal(s.handoff!.accounts.USD.reservedCash, "80.02");
    for (let i = 0; i < 2; i++) {
      const source = s.book.sources[i]!,
        at = s.seed.clock + 1;
      s = store.execute(
        `fill-${i}`,
        source.config.runId,
        {
          kind: "FILL",
          id: `fill-${i}`,
          seq: source.events.length + 1,
          at,
          occurredAt: at,
          orderId: "entry",
          fillId: `fill-${i}`,
          quantity: 1,
          price: "40",
        },
        s,
      ).current;
      s = store.execute(
        `settle-${i}`,
        source.config.runId,
        {
          kind: "SETTLE",
          id: `settle-${i}`,
          seq: s.book.sources[i]!.events.length + 1,
          at: s.seed.clock + 1,
          fillIds: [`fill-${i}`],
        },
        s,
      ).current;
    }
    assert.equal(s.handoff!.accounts.USD.cash, "0.01");
    assert.equal(s.seed.ledger.entries, 2);
    assert.equal(s.seed.ledger.intents, 2);
    for (let i = 0; i < 2; i++) {
      const source = s.book.sources[i]!,
        event = {
          kind: "ORDER" as const,
          id: `sell-${i}`,
          seq: source.events.length + 1,
          at: s.seed.clock + 1,
          orderId: "exit",
          side: "SELL" as const,
          quantity: 1,
          limit: "40.3",
          replaces: null,
        };
      if (i === 0)
        s = store.execute(`sell-${i}`, source.config.runId, event, s).current;
      else {
        const snapshot = dumpHandoff(repo);
        assert.throws(
          () => store.execute(`sell-${i}`, source.config.runId, event, s),
          /SHARED_CASH_DEFICIT/,
        );
        assert.deepEqual(dumpHandoff(repo), snapshot);
      }
    }
    assert.equal(store.read().handoff!.accounts.USD.availableCash, "0");
  } finally {
    repo.close();
  }
});

test("CH-14 two sources share capital and adverse risk; a pre-handoff second candidate requires reapproval", () => {
  const { repo, store } = openedHandoff();
  try {
    const first = proposal(store, "FIRST");
    first.request.stop = "9900";
    first.request.atr = "100";
    first.request.forecast.expectedExit = "10300";
    first.request.forecast.q05Exit = "9900";
    first.request.adverseExitTicks = 3;
    store.reserve("first", store.prepare(first));
    const second = store.prepare(proposal(store, "SECOND"));
    const s = store.handoff(
      "handoff",
      store.prepareHandoff("r-FIRST", "CONFIRMED"),
    ).current;
    assert.throws(() => store.reserve("old-second", second), /REAPPROVAL/);
    const next = store.prepare(proposal(store, "SECOND"));
    store.reserve("second", next);
    const context = store.context();
    assert.equal(context.status, "OK");
    if (context.status === "OK") {
      assert.ok(
        d(context.context.openRiskKrw).lte(caps(context.context.state).group),
      );
      assert.equal(
        context.context.available.KRW,
        d(s.seed.ledger.wallets.KRW.cash)
          .minus(s.handoff!.accounts.KRW.reservedCash)
          .minus(next.candidate.reservationCashNative!)
          .toString(),
      );
    }
  } finally {
    repo.close();
  }
});
test("CH-15 lease expiry before COMMIT rolls back a fill and fences the previous writer", () => {
  const path = fresh(),
    c = handoffConfig();
  let now = 1000,
    armed = false;
  const repo = new Repository(path, () => now);
  repo.acquire();
  const store = new CostReservationStore(repo, c, {
    initialize: true,
    testStage: (stage) => {
      if (armed && stage === "AUDIT") now += 10001;
    },
  });
  try {
    const s = transferred(store),
      snapshot = dumpHandoff(repo),
      event = fill(s);
    armed = true;
    assert.throws(() => execute(store, s, event), /LEASE|WRITER|FENC/i);
    assert.deepEqual(dumpHandoff(repo), snapshot);
    const owner = new Repository(path, () => now);
    owner.acquire();
    try {
      const resumed = new CostReservationStore(owner, c);
      const next = execute(resumed, resumed.read(), event);
      assert.equal(next.seed.ledger.entries, 1);
      assert.throws(() => execute(store, s, event), /LEASE|WRITER|FENC/i);
    } finally {
      owner.close();
    }
  } finally {
    repo.close();
  }
});
test("CH-16 bounded file-backed real-clock replay completes without altering lease semantics", () => {
  const repo = new Repository(fresh());
  repo.acquire();
  const store = new CostReservationStore(repo, handoffConfig(), {
    initialize: true,
  });
  try {
    let s = transferred(store);
    for (let i = 0; i < 12; i++)
      s = store.observe(`sample-${i}`, observation(s), s).current;
    s = execute(store, s, fill(s));
    s = execute(store, s, settle(s, ["fill-1"]));
    assert.equal(s.handoff!.accounts.KRW.payable, "0");
    assert.deepEqual(store.read(), s);
  } finally {
    repo.close();
  }
});
for (const market of ["KR", "US"] as const)
  test(`CH-01 ${market} approval transfers once, fills and settlement conserve shared native cash`, () => {
    const { repo, store } = openedHandoff(handoffConfig(market));
    try {
      const currency = market === "KR" ? "KRW" : "USD",
        initial = store.read().seed.ledger.wallets[currency].cash;
      let s = transferred(store);
      assert.equal(s.approvals[0]!.status, "TRANSFERRED_SYNTHETIC");
      assert.equal(s.seed.ledger.intents, 1);
      assert.equal(s.seed.ledger.entries, 0);
      assert.equal(s.handoff!.accounts[currency].cash, initial);
      assert.equal(
        s.handoff!.accounts[currency].reservedCash,
        s.approvals[0]!.reservation.cashNative,
      );
      assert.throws(() => store.release("release", "r-FIRST", s), /NOT_ACTIVE/);
      const q = s.approvals[0]!.candidate.quantity;
      s = execute(store, s, fill(s, "f-1", 1));
      assert.equal(s.seed.ledger.entries, 1);
      assert.equal(s.seed.ledger.symbolEntries.FIRST, 1);
      const v = replayCostJournal(managed(s).config, managed(s).events),
        w = s.handoff!.accounts[currency];
      assert.equal(w.cash, initial);
      assert.equal(w.payable, v.postings[0]!.payable);
      assert.equal(w.unpaidFees, "0");
      assert.equal(
        w.availableCash,
        d(initial).minus(w.payable).minus(w.reservedCash).toString(),
      );
      if (q > 1) s = execute(store, s, fill(s, "f-2", q - 1));
      assert.equal(s.seed.ledger.entries, 1);
      assert.equal(s.seed.ledger.intents, 1);
      assert.equal(s.handoff!.accounts[currency].reservedCash, "0");
      const payable = s.handoff!.accounts[currency].payable;
      s = execute(store, s, settle(s, q > 1 ? ["f-1", "f-2"] : ["f-1"]));
      assert.equal(
        s.handoff!.accounts[currency].cash,
        d(initial).minus(payable).toString(),
      );
      assert.equal(s.handoff!.accounts[currency].payable, "0");
      assert.deepEqual(store.read(), s);
      assert.equal(s.liveEnabled, false);
      assert.equal(s.orderSubmissionAllowed, false);
      assert.equal(s.learningAllowed, false);
    } finally {
      repo.close();
    }
  });
test("CH-02 duplicate fill with new delivery is no-op; conflicting fill or delivery fails before writing", () => {
  const { repo, store } = openedHandoff();
  try {
    const before = transferred(store),
      e = fill(before),
      first = store.execute("fill", managed(before).config.runId, e, before),
      snapshot = dumpHandoff(repo);
    const repeated = { ...e, id: "redelivered", seq: e.seq + 1, at: e.at + 1 };
    const retry = store.execute(
      "fill-retry",
      managed(before).config.runId,
      repeated,
      before,
    );
    assert.equal(retry.duplicate, true);
    assert.deepEqual(retry.receipt, first.receipt);
    assert.deepEqual(dumpHandoff(repo), snapshot);
    assert.throws(
      () =>
        store.execute(
          "conflict",
          managed(before).config.runId,
          { ...repeated, price: "9999" },
          first.current,
        ),
      /FILL_ID_CONFLICT/,
    );
    assert.throws(
      () =>
        store.execute(
          "delivery-conflict",
          managed(before).config.runId,
          { ...repeated, id: e.id },
          first.current,
        ),
      /EVENT_ID_CONFLICT/,
    );
    assert.throws(
      () =>
        store.execute("scope-conflict", "another-run", repeated, first.current),
      /FILL_ID_CONFLICT/,
    );
    assert.deepEqual(dumpHandoff(repo), snapshot);
  } finally {
    repo.close();
  }
});
test("CH-03 explicit UNKNOWN handoff, late partial fill and cancellation keep remainder until exact confirmation", () => {
  const { repo, store } = openedHandoff();
  try {
    let s = transferred(store, "UNKNOWN");
    let v = replayCostJournal(managed(s).config, managed(s).events);
    assert.equal(v.orders[0]!.status, "UNKNOWN");
    const c = store.context();
    assert.equal(c.status, "OK");
    if (c.status === "OK")
      assert.ok(c.context.entryBlockReasons.includes("UNRESOLVED_EXECUTION"));
    s = execute(store, s, fill(s));
    v = replayCostJournal(managed(s).config, managed(s).events);
    assert.equal(v.orders[0]!.status, "UNKNOWN");
    assert.ok(d(v.reservedCash).gt(0));
    s = execute(store, s, {
      kind: "CANCEL_UNKNOWN",
      id: "cancel-unknown",
      seq: managed(s).events.length + 1,
      at: s.seed.clock + 1,
      orderId: "entry",
    });
    const snapshot = dumpHandoff(repo),
      bad = {
        kind: "CANCEL_CONFIRMED" as const,
        id: "cancel",
        seq: managed(s).events.length + 1,
        at: s.seed.clock + 1,
        orderId: "entry",
        cumulativeQuantity: 0,
        cumulativeValue: "0",
        evidenceAt: s.seed.clock + 1,
      };
    assert.throws(() => execute(store, s, bad));
    assert.deepEqual(dumpHandoff(repo), snapshot);
    s = execute(store, s, {
      ...bad,
      cumulativeQuantity: 1,
      cumulativeValue: s.approvals[0]!.candidate.entry,
    });
    assert.equal(s.handoff!.accounts.KRW.reservedCash, "0");
    assert.ok(d(s.handoff!.accounts.KRW.payable).gt(0));
    s = execute(store, s, settle(s, ["fill-1"]));
    assert.equal(s.handoff!.accounts.KRW.payable, "0");
  } finally {
    repo.close();
  }
});
test("CH-04 stale quote/account cannot reapprove or refresh the original candidate implicitly", () => {
  const { repo, store } = openedHandoff();
  try {
    store.reserve("reserve", store.prepare(proposal(store)));
    const old = store.prepareHandoff("r-FIRST", "CONFIRMED");
    const s = store.read();
    store.observe(
      "age",
      observation(s, policy.execution.maximum_quote_age_seconds * 1000 + 1),
      s,
    );
    const snapshot = dumpHandoff(repo);
    assert.throws(() => store.handoff("old", old), /REAPPROVAL/);
    assert.throws(() => store.prepareHandoff("r-FIRST", "CONFIRMED"), /STALE/);
    assert.deepEqual(dumpHandoff(repo), snapshot);
  } finally {
    repo.close();
  }
});
test("CH-05 prepared receipt is object-bound; profile, stop, price, adverse and quantity are not caller replacements", () => {
  const { repo, store } = openedHandoff();
  try {
    store.reserve("reserve", store.prepare(proposal(store)));
    const p = store.prepareHandoff("r-FIRST", "CONFIRMED"),
      snapshot = dumpHandoff(repo);
    assert.throws(() => store.handoff("copy", structuredClone(p)), /UNISSUED/);
    assert.throws(() =>
      store.handoff("inject", {
        ...p,
        input: { ...p.input, command: { ...p.input.command, quantity: 999 } },
      } as never),
    );
    if (p.input.command.kind === "HANDOFF")
      p.input.command.acknowledgement = "UNKNOWN";
    assert.throws(() => store.handoff("changed", p), /UNISSUED/);
    assert.deepEqual(dumpHandoff(repo), snapshot);
    const a = store.read().approvals[0]!;
    const valid = store.prepareHandoff(a.id, "CONFIRMED");
    const s = store.handoff("ok", valid).current;
    assert.deepEqual(managed(s).config.execution.profile, a.proposal.profile);
    assert.equal(managed(s).observation.stop, a.candidate.stop);
    const o = observation(s);
    o.observations[0]!.observation.stop = "1";
    assert.throws(() => store.observe("stop-change", o, s), /IMMUTABLE/);
    assert.throws(
      () =>
        execute(store, s, {
          kind: "ORDER",
          id: "extra-buy",
          seq: 2,
          at: s.seed.clock + 1,
          orderId: "buy2",
          side: "BUY",
          quantity: 1,
          limit: "10000",
          replaces: null,
        }),
      /BUY_REQUIRES_APPROVAL/,
    );
  } finally {
    repo.close();
  }
});
test("CH-06 transferred adverse tick risk is retained instead of silently falling to legacy bps", () => {
  const { repo, store } = openedHandoff();
  try {
    const s = transferred(store, "CONFIRMED", 3),
      c = store.context();
    assert.equal(c.status, "OK");
    if (c.status === "OK")
      assert.ok(
        d(c.context.openRiskKrw).gte(
          ceil(d(s.approvals[0]!.reservation.riskNative)),
        ),
      );
    const f = execute(store, s, fill(s));
    const fresh = observation(f);
    fresh.observations[0]!.observation.protectedQuantity = 1;
    store.observe("protected", fresh, f);
    const after = store.context();
    assert.equal(after.status, "OK");
    if (after.status === "OK") assert.ok(d(after.context.openRiskKrw).gt(0));
  } finally {
    repo.close();
  }
});
test("CH-07 stale fill is durably accounted; fresh observations cannot erase the unobserved risk-history hold", () => {
  const { repo, store } = openedHandoff();
  try {
    const before = transferred(store),
      e = fill(before);
    e.at += policy.execution.maximum_quote_age_seconds * 1000 + 1;
    e.occurredAt = e.at;
    const s = execute(store, before, e);
    assert.ok(d(s.handoff!.accounts.KRW.payable).gt(0));
    assert.ok(
      s.handoff!.admissionHolds.includes(
        "RISK_HISTORY_RECONCILIATION_REQUIRED",
      ),
    );
    const next = store.observe("fresh", observation(s), s).current;
    assert.equal(store.context().status, "HOLD");
    assert.ok(next.handoff!.admissionHolds.length > 0);
    const settled = execute(store, next, settle(next, ["fill-1"]));
    assert.equal(settled.handoff!.accounts.KRW.payable, "0");
    assert.throws(() => store.prepare(proposal(store, "NEXT")), /HISTORY/);
  } finally {
    repo.close();
  }
});
test("CH-08 full sell survives protection mismatch; receivable is unavailable until explicit settlement; closed outcome holds entry", () => {
  const { repo, store } = openedHandoff();
  try {
    let s = transferred(store);
    const q = s.approvals[0]!.candidate.quantity;
    s = execute(store, s, fill(s, "buy", q));
    s = execute(store, s, settle(s, ["buy"]));
    const obs = observation(s);
    obs.observations[0]!.observation.protectedQuantity = q;
    s = store.observe("protection", obs, s).current;
    s = execute(store, s, {
      kind: "ORDER",
      id: "sell",
      seq: managed(s).events.length + 1,
      at: s.seed.clock + 1,
      orderId: "exit",
      side: "SELL",
      quantity: q,
      limit: "10100",
      replaces: null,
    });
    s = execute(store, s, fill(s, "sold", q, "exit", "10100"));
    const w = s.handoff!.accounts.KRW;
    assert.ok(d(w.receivable).gt(0));
    assert.equal(
      w.availableCash,
      d(w.cash).minus(w.payable).minus(w.reservedCash).toString(),
    );
    assert.ok(
      s.handoff!.admissionHolds.includes(
        "RISK_HISTORY_RECONCILIATION_REQUIRED",
      ),
    );
    assert.ok(
      s.handoff!.admissionHolds.includes(
        "CLOSED_OUTCOME_RECONCILIATION_REQUIRED",
      ),
    );
    const next = execute(store, s, settle(s, ["sold"]));
    assert.equal(next.handoff!.accounts.KRW.receivable, "0");
    assert.equal(
      next.handoff!.accounts.KRW.cash,
      d(w.cash).plus(w.receivable).toString(),
    );
    assert.equal(store.context().status, "HOLD");
  } finally {
    repo.close();
  }
});
for (const operation of ["HANDOFF", "FILL", "SETTLE"] as const)
  for (const stage of [
    "COMMAND",
    "APPROVALS",
    "FILL_INDEX",
    "STATE",
    "AUDIT",
  ] as const)
    test(`CH-09 ${operation} ${stage} failure rolls back event, reserves, fill latch, accounts and audit`, () => {
      const repo = new Repository(":memory:", () => 1000);
      repo.acquire();
      let armed = false;
      const store = new CostReservationStore(repo, handoffConfig(), {
        initialize: true,
        testStage: (s) => {
          if (armed && s === stage) throw Error("ATOMIC_FAIL");
        },
      });
      try {
        store.reserve("reserve", store.prepare(proposal(store)));
        const p = store.prepareHandoff("r-FIRST", "UNKNOWN");
        let s = store.read();
        if (operation !== "HANDOFF") s = store.handoff("handoff", p).current;
        if (operation === "SETTLE") s = execute(store, s, fill(s));
        const snapshot = dumpHandoff(repo);
        armed = true;
        assert.throws(
          () =>
            operation === "HANDOFF"
              ? store.handoff("handoff", p)
              : execute(
                  store,
                  s,
                  operation === "FILL" ? fill(s) : settle(s, ["fill-1"]),
                ),
          /ATOMIC_FAIL/,
        );
        assert.deepEqual(dumpHandoff(repo), snapshot);
        assert.deepEqual(store.read(), s);
      } finally {
        repo.close();
      }
    });
test("CH-10 V1/V2 are separate explicit modes; cache and fill-index corruption are detected", () => {
  const c = handoffConfig(),
    { repo, store } = openedHandoff(c);
  try {
    assert.throws(
      () =>
        new CostReservationStore(repo, {
          kind: reservationKind,
          runId: c.runId,
          seed: c.seed,
          book: c.book,
        }),
      /MODE_CONFLICT/,
    );
    const s = transferred(store);
    execute(store, s, fill(s));
    repo.db
      .prepare("UPDATE cost_reservation_fills SET identity_hash=?")
      .run("0".repeat(64));
    assert.throws(() => store.read(), /FILL_INDEX_REPLAY_MISMATCH/);
  } finally {
    repo.close();
  }
});
test("CH-11 re-open with new epoch replays same money; duplicate old handoff does not resurrect anything", () => {
  const path = fresh(),
    c = handoffConfig();
  let repo = new Repository(path, () => 1000);
  repo.acquire();
  let store = new CostReservationStore(repo, c, { initialize: true });
  store.reserve("reserve", store.prepare(proposal(store)));
  const p = store.prepareHandoff("r-FIRST", "CONFIRMED");
  let s = store.handoff("handoff", p).current;
  s = execute(store, s, fill(s));
  repo.close();
  repo = new Repository(path, () => 20000);
  repo.acquire();
  store = new CostReservationStore(repo, c);
  try {
    assert.deepEqual(store.read(), s);
    assert.equal(store.handoff("handoff", structuredClone(p)).duplicate, true);
    const next = execute(store, s, settle(s, ["fill-1"]));
    assert.ok(next.epoch > s.epoch);
    assert.equal(next.handoff!.accounts.KRW.payable, "0");
  } finally {
    repo.close();
  }
});
test("CH-12 exhausted observation controls still permit cancellation, late fills, settlement and local release", () => {
  const { repo, store } = openedHandoff();
  try {
    let s = transferred(store);
    store.reserve("other", store.prepare(proposal(store, "SECOND")));
    s = store.read();
    for (let i = 3; i < 100; i++)
      s = store.observe(`obs-${i}`, observation(s), s).current;
    assert.equal(s.handoff!.controlCount, 100);
    assert.throws(
      () => store.observe("overflow", observation(s), s),
      /CONTROL_LIMIT/,
    );
    s = store.release("release-other", "r-SECOND", s).current;
    s = execute(store, s, {
      kind: "CANCEL_REQUEST",
      id: "cancel-request",
      seq: managed(s).events.length + 1,
      at: s.seed.clock + 1,
      orderId: "entry",
    });
    s = execute(store, s, fill(s));
    s = execute(store, s, {
      kind: "CANCEL_CONFIRMED",
      id: "cancel-confirm",
      seq: managed(s).events.length + 1,
      at: s.seed.clock + 1,
      orderId: "entry",
      cumulativeQuantity: 1,
      cumulativeValue: s.approvals[0]!.candidate.entry,
      evidenceAt: s.seed.clock + 1,
    });
    s = execute(store, s, settle(s, ["fill-1"]));
    assert.equal(s.handoff!.accounts.KRW.reservedCash, "0");
    assert.equal(s.handoff!.accounts.KRW.payable, "0");
    assert.ok(s.revision > 100);
  } finally {
    repo.close();
  }
});
for (const stage of ["FILL_INDEX", "STATE", "COMMITTED"] as const)
  test(`CH-13 owned child stopped at ${stage}: restart gives all-or-none fill`, async () => {
    const path = fresh();
    const child = spawn(
      process.execPath,
      ["scripts/cost-handoff-crash-fixture.mjs", path, stage],
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
          const t = setTimeout(() => reject(Error("FIXTURE_TIMEOUT")), 30000);
          t.unref();
        }),
      ]);
      assert.deepEqual(signal[0], { stage });
      const exited = once(child, "exit");
      child.kill();
      await exited;
      const repo = new Repository(path, () => 20000);
      repo.acquire();
      try {
        const store = new CostReservationStore(repo, handoffConfig());
        const s = store.read();
        assert.equal(s.revision, stage === "COMMITTED" ? 3 : 2);
        assert.equal(s.seed.ledger.entries, stage === "COMMITTED" ? 1 : 0);
        assert.equal(
          repo.db
            .prepare("SELECT COUNT(*) AS n FROM cost_reservation_fills")
            .get()!.n,
          stage === "COMMITTED" ? 1 : 0,
        );
        assert.equal(
          d(s.handoff!.accounts.KRW.payable).gt(0),
          stage === "COMMITTED",
        );
        assert.equal(hash(store.read()), hash(s));
      } finally {
        repo.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
