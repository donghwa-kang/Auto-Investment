import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Repository } from "../src/server/repository.js";
import { CostJournal } from "../src/server/cost-journal.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import {
  reservationConfig,
  proposal,
  observation,
  usdCash,
} from "./cost-reservation-helpers.js";
import { journalConfig } from "./cost-journal-helpers.js";
import { source, observe } from "./cost-admission-helpers.js";
import { hash, policy } from "../src/core/policy.js";
import { d, ceil } from "../src/core/math.js";
import { caps } from "../src/core/ledger.js";
import { state } from "./helpers.js";

const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "cost-reservation-")), "test.sqlite");
function opened(c = reservationConfig(), path = ":memory:") {
  const repo = new Repository(path, () => 1000);
  repo.acquire();
  const store = new CostReservationStore(repo, c, { initialize: true });
  return { repo, store, c };
}
function dump(repo: Repository) {
  return [
    "cost_reservation_run",
    "cost_reservation_commands",
    "cost_reservation_approvals",
    "audit",
  ].map((table) => repo.db.prepare(`SELECT * FROM ${table}`).all());
}

test("CR-18 command capacity keeps a slot for every outstanding local release", () => {
  const { repo, store } = opened();
  try {
    let current = store.reserve(
      "reserve",
      store.prepare(proposal(store)),
    ).current;
    for (let i = 0; i < 98; i++)
      current = store.observe(
        `obs-${i}`,
        observation(current),
        current,
      ).current;
    assert.equal(current.revision, 99);
    const before = dump(repo);
    assert.throws(
      () => store.observe("overflow", observation(current), current),
      /LOCAL_RELEASE_CAPACITY/,
    );
    assert.deepEqual(dump(repo), before);
    const released = store.release("release", "r-FIRST", current);
    assert.equal(released.current.revision, 100);
    assert.equal(released.current.approvals[0]!.status, "RELEASED_LOCAL");
    assert.equal(store.release("release", "r-FIRST", current).duplicate, true);
  } finally {
    repo.close();
  }
});

test("CR-19 shared risk, not cash or position count, reduces the next candidate", () => {
  const { repo, store } = opened();
  const riskProposal = (name: string) => {
    const p = proposal(store, name);
    p.request.stop = "9900";
    p.request.atr = "100";
    p.request.forecast.expectedExit = "10200";
    p.request.forecast.q05Exit = "9900";
    return p;
  };
  try {
    const first = store.prepare(riskProposal("A")),
      second = store.prepare(riskProposal("B"));
    const initial = store.context();
    assert.equal(initial.status, "OK");
    if (initial.status !== "OK") return;
    const group = caps(initial.context.state).group;
    assert.ok(
      d(first.candidate.riskKrw).plus(second.candidate.riskKrw).gt(group),
    );
    store.reserve("a", first);
    const before = store.read();
    assert.throws(() => store.reserve("old-b", second), /REAPPROVAL/);
    const updated = store.prepare(riskProposal("B"));
    assert.ok(updated.candidate.quantity < second.candidate.quantity);
    const ctx = store.context();
    assert.equal(ctx.status, "OK");
    if (ctx.status !== "OK") return;
    assert.ok(
      d(ctx.context.available.KRW).gt(second.candidate.reservationCashNative!),
    );
    assert.ok(
      ctx.context.state.orders.length < policy.risk.standard_max_positions,
    );
    assert.ok(
      d(updated.candidate.riskKrw).lte(d(group).minus(first.candidate.riskKrw)),
    );
    const after = store.reserve("new-b", updated).current;
    assert.deepEqual(after.approvals[0], before.approvals[0]);
    const final = store.context();
    assert.equal(final.status, "OK");
    if (final.status === "OK")
      assert.ok(d(final.context.openRiskKrw).lte(group));
  } finally {
    repo.close();
  }
});

for (const stage of ["COMMAND", "APPROVALS", "STATE", "AUDIT"] as const)
  test(`CR-20 ${stage} release failure retains reservation and intent count atomically`, () => {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    let armed = false;
    const store = new CostReservationStore(repo, reservationConfig(), {
      initialize: true,
      testStage: (s) => {
        if (armed && s === stage) throw Error("RELEASE_FAIL");
      },
    });
    try {
      const current = store.reserve(
        "reserve",
        store.prepare(proposal(store)),
      ).current;
      const before = dump(repo);
      armed = true;
      assert.throws(
        () => store.release("release", "r-FIRST", current),
        /RELEASE_FAIL/,
      );
      assert.deepEqual(dump(repo), before);
      armed = false;
      const after = store.release("release", "r-FIRST", current).current;
      assert.equal(after.approvals[0]!.status, "RELEASED_LOCAL");
      assert.equal(after.seed.ledger.intents, current.seed.ledger.intents);
    } finally {
      repo.close();
    }
  });

test("CR-21 real wall clock lease survives one held source, reservation and 32 observations through release", (t) => {
  const c = reservationConfig();
  c.book.sources = [source(c.seed, "HELD", "KR", 2, 2)];
  observe(c.seed, c.book);
  const repo = new Repository(fresh());
  repo.acquire();
  try {
    const store = new CostReservationStore(repo, c, { initialize: true });
    let current = store.reserve(
      "reserve",
      store.prepare(proposal(store)),
    ).current;
    let maximumMs = 0;
    for (let i = 0; i < 32; i++) {
      const start = performance.now();
      current = store.observe(
        `obs-${i}`,
        observation(current),
        current,
      ).current;
      maximumMs = Math.max(maximumMs, performance.now() - start);
    }
    const start = performance.now();
    const released = store.release("release", "r-FIRST", current).current;
    const releaseMs = performance.now() - start;
    maximumMs = Math.max(maximumMs, releaseMs);
    assert.equal(released.revision, 34);
    assert.equal(released.approvals[0]!.status, "RELEASED_LOCAL");
    assert.equal(repo.verifyAudit(), 35);
    assert.ok(maximumMs < 10000);
    assert.equal(store.read().revision, 34);
    t.diagnostic(
      JSON.stringify({
        sourceEvents: 2,
        observations: 32,
        maximumMs,
        releaseMs,
        scope: "LOCAL_SAMPLE_NOT_CAPACITY_OR_SLA",
      }),
    );
  } finally {
    repo.close();
  }
});

test("CR-22 a recomputed cache checksum cannot replace command-derived reservation truth", () => {
  const { repo, store } = opened();
  try {
    const current = store.reserve(
      "reserve",
      store.prepare(proposal(store)),
    ).current;
    current.approvals[0]!.reservation.riskNative = "0";
    repo.db
      .prepare("UPDATE cost_reservation_run SET body=?,checksum=?")
      .run(JSON.stringify(current), hash(current));
    assert.throws(() => store.read(), /REPLAY_MISMATCH/);
    assert.throws(
      () => store.release("release", "r-FIRST", current),
      /REPLAY_MISMATCH/,
    );
  } finally {
    repo.close();
  }
});

for (const market of ["KR", "US"] as const)
  test(`CR-01 ${market} atomic local approval reserves cash/risk without a working order or debit`, () => {
    const { repo, store } = opened(reservationConfig(market));
    try {
      const before = store.read(),
        c0 = store.context();
      assert.equal(c0.status, "OK");
      const p = store.prepare(proposal(store)),
        r = store.reserve("reserve-one", p),
        s = r.current;
      assert.equal(r.duplicate, false);
      assert.equal(s.revision, 1);
      assert.equal(s.approvals.length, 1);
      const a = s.approvals[0]!;
      assert.equal(a.status, "RESERVED_LOCAL");
      assert.equal(s.seed.ledger.intents, before.seed.ledger.intents + 1);
      assert.deepEqual(s.seed.ledger.wallets, before.seed.ledger.wallets);
      assert.deepEqual(s.book.sources, before.book.sources);
      assert.equal(s.seed.orders.length, 0);
      const c1 = store.context();
      assert.equal(c1.status, "OK");
      if (c0.status !== "OK" || c1.status !== "OK") return;
      assert.equal(
        c1.context.available[a.reservation.currency],
        d(c0.context.available[a.reservation.currency])
          .minus(a.reservation.cashNative)
          .toString(),
      );
      assert.equal(
        c1.context.openRiskKrw,
        ceil(d(a.reservation.riskNative).mul(market === "KR" ? 1 : 1300)),
      );
      assert.equal(c1.context.state.orders[0]!.status, "INTENT_SAVED");
      assert.equal(s.orderSubmissionAllowed, false);
      assert.equal(s.learningAllowed, false);
      assert.equal(s.liveEnabled, false);
      assert.equal(repo.verifyAudit(), 2);
      assert.equal(store.read().revision, 1);
    } finally {
      repo.close();
    }
  });
test("CR-02 two individually feasible candidates cannot spend the same USD cash", () => {
  const { repo, store } = opened(usdCash(reservationConfig("US"), "90"));
  try {
    const a = store.prepare(proposal(store, "A")),
      b = store.prepare(proposal(store, "B"));
    assert.equal(a.candidate.quantity, 2);
    assert.equal(b.candidate.quantity, 2);
    store.reserve("a", a);
    const before = dump(repo);
    assert.throws(() => store.reserve("b", b), /REAPPROVAL/);
    assert.deepEqual(dump(repo), before);
    assert.throws(
      () => store.prepare(proposal(store, "B")),
      /NO_INTEGER_QUANTITY|NO_FEASIBLE_QUANTITY/,
    );
    assert.equal(store.read().approvals.length, 1);
  } finally {
    repo.close();
  }
});
test("CR-03 active symbols and position limits count local unsent reservations", () => {
  const { repo, store } = opened();
  try {
    store.reserve("a", store.prepare(proposal(store, "A")));
    assert.throws(() => store.prepare(proposal(store, "A")), /EXISTING_SYMBOL/);
    for (let i = 1; i < policy.risk.standard_max_positions; i++)
      store.reserve(`r${i}`, store.prepare(proposal(store, `B${i}`)));
    assert.throws(
      () => store.prepare(proposal(store, "OVER")),
      /POSITION_LIMIT/,
    );
  } finally {
    repo.close();
  }
});
test("CR-04 duplicate, altered ID and cancelled-old-approval retry do not change money", () => {
  const { repo, store } = opened();
  try {
    const p = store.prepare(proposal(store)),
      first = store.reserve("a", p),
      before = dump(repo);
    const copy = structuredClone(p);
    assert.equal(store.reserve("a", copy).duplicate, true);
    assert.deepEqual(dump(repo), before);
    if (copy.input.command.kind === "RESERVE")
      copy.input.command.proposal.request.quote.at++;
    assert.throws(() => store.reserve("a", copy), /ID_CONFLICT/);
    const release = store.release("release", "r-FIRST", first.current);
    assert.equal(release.current.approvals[0]!.status, "RELEASED_LOCAL");
    assert.equal(release.current.seed.ledger.intents, 1);
    const retry = store.reserve("a", structuredClone(p));
    assert.equal(retry.duplicate, true);
    assert.equal(retry.receipt.revision, 1);
    assert.equal(retry.current.revision, 2);
    assert.equal(retry.current.approvals[0]!.status, "RELEASED_LOCAL");
    assert.equal(
      store.release("release", "r-FIRST", first.current).duplicate,
      true,
    );
    const next = store.prepare(proposal(store, "SECOND"));
    store.reserve("second", next);
    assert.equal(store.read().seed.ledger.intents, 2);
  } finally {
    repo.close();
  }
});
test("CR-05 unissued and edited research receipts never create reservations", () => {
  const { repo, store } = opened();
  try {
    const p = store.prepare(proposal(store)),
      before = dump(repo);
    assert.throws(() => store.reserve("a", structuredClone(p)), /UNISSUED/);
    p.candidate.quantity++;
    assert.throws(() => store.reserve("a", p), /UNISSUED/);
    assert.deepEqual(dump(repo), before);
  } finally {
    repo.close();
  }
});
test("CR-06 observations invalidate previews and revalue native reserves without FX trades", () => {
  const { repo, store } = opened(reservationConfig("US"));
  try {
    const a = store.prepare(proposal(store, "A")),
      oldB = store.prepare(proposal(store, "B"));
    store.reserve("a", a);
    const before = store.read(),
      v = observation(before);
    v.fx = "1301";
    store.observe("obs", v, before);
    const after = store.read(),
      ctx = store.context();
    assert.equal(ctx.status, "OK");
    if (ctx.status !== "OK") return;
    assert.deepEqual(after.seed.ledger.wallets, before.seed.ledger.wallets);
    assert.equal(
      ctx.context.openRiskKrw,
      ceil(d(after.approvals[0]!.reservation.riskNative).mul(1301)),
    );
    assert.throws(() => store.reserve("b", oldB), /REAPPROVAL/);
  } finally {
    repo.close();
  }
});
test("CR-07 stale evidence HOLD retains reservations and permits only explicit local release", () => {
  const { repo, store } = opened();
  try {
    const p = proposal(store);
    p.profile.effectiveTo = store.read().seed.clock + 5;
    p.request.profileHash = hash(p.profile);
    store.reserve("a", store.prepare(p));
    const before = store.read();
    store.observe("obs", observation(before, 6), before);
    const after = store.read();
    assert.equal(after.approvals[0]!.status, "RESERVED_LOCAL");
    assert.equal(store.context().status, "HOLD");
    store.release("release", "r-FIRST", after);
    assert.equal(store.context().status, "OK");
    assert.equal(store.read().seed.ledger.intents, 1);
  } finally {
    repo.close();
  }
});
test("CR-08 quote/config/time changes cannot reuse the old candidate", () => {
  const { repo, store } = opened();
  try {
    const p = store.prepare(proposal(store));
    const s = store.read();
    store.observe("obs", observation(s), s);
    assert.throws(() => store.reserve("a", p), /REAPPROVAL/);
    const after = store.read(),
      v = observation(after, -1);
    assert.throws(() => store.observe("back", v, after), /TIME_OR_PERIOD/);
    assert.throws(
      () => store.observe("period", observation(after, 86400000), after),
      /TIME_OR_PERIOD/,
    );
    assert.throws(() =>
      store.observe(
        "inject",
        { ...observation(after), seed: state() } as never,
        after,
      ),
    );
    assert.equal(store.read().revision, 1);
  } finally {
    repo.close();
  }
});
test("CR-09 B source facts cannot be replaced by observation; loss latch survives recovery", () => {
  const c = reservationConfig();
  c.book.sources = [source(c.seed, "HELD", "KR", 2, 2)];
  observe(c.seed, c.book);
  const { repo, store } = opened(c);
  try {
    const before = store.read(),
      v = observation(before);
    v.observations[0]!.observation.bid = "200000";
    store.observe("peak", v, before);
    const peak = store.read();
    const down = observation(peak);
    down.observations[0]!.observation.bid = "10000";
    store.observe("down", down, peak);
    const halted = store.read();
    assert.equal(halted.seed.status, "HALTED");
    assert.ok(halted.seed.ledger.halts.includes("DRAWDOWN_HALT"));
    const up = observation(halted);
    up.observations[0]!.observation.bid = "200000";
    store.observe("up", up, halted);
    const last = store.read();
    assert.equal(last.seed.status, "HALTED");
    assert.equal(last.seed.ledger.highNav, peak.seed.ledger.highNav);
    assert.deepEqual(
      last.book.sources[0]!.events,
      before.book.sources[0]!.events,
    );
    assert.deepEqual(last.seed.ledger.wallets, before.seed.ledger.wallets);
    const missing = observation(last);
    missing.observations = [];
    assert.throws(
      () => store.observe("missing", missing, last),
      /COMPLETENESS/,
    );
  } finally {
    repo.close();
  }
});

for (const stage of ["COMMAND", "APPROVALS", "STATE", "AUDIT"] as const)
  test(`CR-10 ${stage} exception rolls back the entire reservation`, () => {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    let armed = false;
    const store = new CostReservationStore(repo, reservationConfig(), {
      initialize: true,
      testStage: (s) => {
        if (armed && s === stage) throw Error("INJECTED");
      },
    });
    try {
      const p = store.prepare(proposal(store)),
        before = dump(repo);
      armed = true;
      assert.throws(() => store.reserve("a", p), /INJECTED/);
      assert.deepEqual(dump(repo), before);
      armed = false;
      assert.equal(store.reserve("a", p).current.approvals.length, 1);
    } finally {
      repo.close();
    }
  });
test("CR-11 writer lease expiry rolls back and rejects duplicate fast path", () => {
  let now = 1000,
    expire = false;
  const repo = new Repository(":memory:", () => now);
  repo.acquire();
  const store = new CostReservationStore(repo, reservationConfig(), {
    initialize: true,
    testStage: (s) => {
      if (expire && s === "AUDIT") now += 10000;
    },
  });
  try {
    const p = store.prepare(proposal(store)),
      before = dump(repo);
    expire = true;
    assert.throws(() => store.reserve("a", p), /FENCED/);
    assert.deepEqual(dump(repo), before);
    expire = false;
    repo.acquire();
    assert.throws(() => store.reserve("a", p), /REAPPROVAL/);
    const q = store.prepare(proposal(store));
    store.reserve("a", q);
    now += 10000;
    assert.throws(() => store.reserve("a", q), /FENCED/);
  } finally {
    repo.close();
  }
});
test("CR-12 takeover keeps old reserves but invalidates old previews", () => {
  const path = fresh();
  let now = 1000;
  const a = new Repository(path, () => now);
  a.acquire();
  const config = reservationConfig(),
    first = new CostReservationStore(a, config, { initialize: true });
  const p = first.prepare(proposal(first));
  first.reserve("a", p);
  const old = first.prepare(proposal(first, "B"));
  const b = new Repository(path, () => now);
  try {
    assert.throws(() => b.acquire(), /WRITER_BUSY/);
    now += 10000;
    b.acquire();
    const second = new CostReservationStore(b, config);
    assert.equal(second.read().approvals[0]!.status, "RESERVED_LOCAL");
    assert.throws(() => first.reserve("a", p), /FENCED/);
    assert.throws(() => second.reserve("b", old), /UNISSUED|REAPPROVAL/);
    const retry = second.reserve("a", structuredClone(p));
    assert.equal(retry.duplicate, true);
    assert.equal(retry.current.approvals.length, 1);
    second.release("release", "r-FIRST", second.read());
    assert.equal(second.read().epoch, 2);
  } finally {
    b.close();
    a.close();
  }
});
test("CR-13 concurrent read sees only committed tables during reservation", () => {
  const path = fresh(),
    repo = new Repository(path, () => 1000);
  repo.acquire();
  let armed = false,
    checked = false;
  const store = new CostReservationStore(repo, reservationConfig(), {
    initialize: true,
    testStage: (s) => {
      if (armed && s === "STATE") {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          assert.equal(
            db
              .prepare("SELECT COUNT(*) n FROM cost_reservation_approvals")
              .get()!.n,
            0,
          );
          assert.equal(
            JSON.parse(
              String(
                db.prepare("SELECT body FROM cost_reservation_run").get()!.body,
              ),
            ).revision,
            0,
          );
          checked = true;
        } finally {
          db.close();
        }
      }
    },
  });
  try {
    const p = store.prepare(proposal(store));
    armed = true;
    store.reserve("a", p);
    assert.ok(checked);
  } finally {
    repo.close();
  }
});
for (const table of [
  "cost_reservation_run",
  "cost_reservation_commands",
  "cost_reservation_approvals",
  "audit",
])
  test(`CR-14 ${table} corruption is rejected by replay`, () => {
    const { repo, store } = opened();
    try {
      store.reserve("a", store.prepare(proposal(store)));
      repo.db.prepare(`UPDATE ${table} SET body='{}'`).run();
      assert.throws(() => store.read());
    } finally {
      repo.close();
    }
  });
test("CR-15 bidirectional legacy/B mode guards and partial-schema rejection", () => {
  const { repo, store } = opened();
  try {
    assert.throws(() => repo.read(), /VERSIONED_READER/);
    assert.throws(
      () => repo.transact("legacy", {}, () => state()),
      /VERSIONED_READER/,
    );
    assert.throws(
      () => new CostJournal(repo, journalConfig()),
      /MODE_CONFLICT/,
    );
    assert.throws(
      () => new CostJournal(repo, journalConfig(), { initialize: true }),
      /MODE_CONFLICT/,
    );
    const before = dump(repo);
    assert.throws(
      () =>
        new CostReservationStore(repo, reservationConfig(), {
          initialize: true,
        }),
      /EMPTY/,
    );
    assert.deepEqual(dump(repo), before);
    assert.equal(store.read().revision, 0);
  } finally {
    repo.close();
  }
  for (const mode of ["legacy", "B", "partial"]) {
    const r = new Repository(":memory:", () => 1000);
    r.acquire();
    try {
      if (mode === "legacy") r.transact("legacy", {}, () => state());
      else if (mode === "B")
        new CostJournal(r, journalConfig(), { initialize: true });
      else r.db.exec("CREATE TABLE cost_reservation_run(id INTEGER)");
      assert.throws(
        () =>
          new CostReservationStore(r, reservationConfig(), {
            initialize: true,
          }),
        /EMPTY/,
      );
      assert.throws(
        () => new CostReservationStore(r, reservationConfig()),
        /MODE_CONFLICT/,
      );
    } finally {
      r.close();
    }
  }
});
test("CR-16 initialization failure removes schema and permits a clean retry", () => {
  const repo = new Repository(":memory:", () => 1000);
  repo.acquire();
  try {
    assert.throws(
      () =>
        new CostReservationStore(repo, reservationConfig(), {
          initialize: true,
          testStage: (s) => {
            if (s === "AUDIT") throw Error("INIT_FAIL");
          },
        }),
      /INIT_FAIL/,
    );
    assert.equal(
      repo.db
        .prepare(
          "SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'cost_reservation_%'",
        )
        .get()!.n,
      0,
    );
    assert.equal(
      new CostReservationStore(repo, reservationConfig(), {
        initialize: true,
      }).read().revision,
      0,
    );
  } finally {
    repo.close();
  }
});
for (const stage of [
  "COMMAND",
  "APPROVALS",
  "STATE",
  "AUDIT",
  "COMMITTED",
] as const)
  test(
    `CR-17 owned child crash at ${stage} restores all-or-none reservation`,
    { timeout: 30000 },
    async () => {
      const path = fresh(),
        child = spawn(
          process.execPath,
          ["scripts/cost-reservation-crash-fixture.mjs", path, stage],
          { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
        );
      let errors = "";
      child.stderr!.on("data", (b) => {
        errors += b;
      });
      const exited = once(child, "exit");
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 15000);
      try {
        const [message] = await once(child, "message", {
          signal: controller.signal,
        });
        assert.deepEqual(message, { stage });
      } catch (e) {
        throw Error(`${String(e)} ${errors}`);
      } finally {
        clearTimeout(timer);
        child.kill();
        await exited;
      }
      const repo = new Repository(path, () => 12000);
      repo.acquire();
      try {
        const store = new CostReservationStore(repo, reservationConfig()),
          s = store.read(),
          committed = stage === "COMMITTED";
        assert.equal(s.revision, committed ? 1 : 0);
        assert.equal(s.approvals.length, committed ? 1 : 0);
        assert.equal(repo.verifyAudit(), committed ? 2 : 1);
        if (!committed) store.reserve("a", store.prepare(proposal(store)));
        assert.equal(store.read().approvals.length, 1);
      } finally {
        repo.close();
      }
    },
  );
