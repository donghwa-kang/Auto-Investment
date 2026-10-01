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
import {
  replayCostJournal,
  replayCostJournalTrace,
  journalFillKey,
} from "../src/core/cost-journal.js";
import {
  replayCostExecutions,
  replayCostExecutionFrames,
} from "../src/core/cost-execution.js";
import type { CostJournalEvent } from "../src/core/cost-journal.js";
import { hash } from "../src/core/policy.js";
import { d } from "../src/core/math.js";
import { journalConfig, journalEvents } from "./cost-journal-helpers.js";
import { executionEvents } from "./cost-execution-helpers.js";
import { costAt } from "./transaction-cost-helpers.js";

test("CJ-26 real wall clock accepts 32 partial fills without expiring the writer lease", (t) => {
  const c = journalConfig("FILL"),
    repo = new Repository(":memory:");
  repo.acquire();
  try {
    const store = new CostJournal(repo, c, { initialize: true });
    const at = c.execution.initialAt;
    let maxMs = 0;
    store.append({
      kind: "ORDER",
      id: "b32",
      orderId: "b32",
      seq: 1,
      at: at + 1,
      side: "BUY",
      quantity: 32,
      limit: "1",
      replaces: null,
    });
    for (let i = 0; i < 32; i++) {
      repo.heartbeat();
      const start = performance.now();
      store.append({
        kind: "FILL",
        id: `e${i}`,
        fillId: `f${i}`,
        orderId: "b32",
        seq: i + 2,
        at: at + i + 2,
        occurredAt: at + i + 2,
        quantity: 1,
        price: "1",
      });
      maxMs = Math.max(maxMs, performance.now() - start);
    }
    const v = store.read();
    assert.equal(v.revision, 33);
    assert.equal(v.projection.wallet.payable, "352");
    assert.equal(v.projection.quantity, 32);
    assert.equal(
      v.projection.postings.reduce((n, p) => n + p.lines.length, 0),
      96,
    );
    t.diagnostic(
      `32 fills in memory, real clock, observed max append ${maxMs.toFixed(2)}ms; not a latency SLA`,
    );
  } finally {
    repo.close();
  }
});

test("CJ-25 single-pass prefix hashes and detached lifecycle frames equal independent replays", () => {
  const c = journalConfig("FILL"),
    events = journalEvents(),
    before = hash({ c, events });
  const trace = replayCostJournalTrace(c, events);
  for (let i = 0; i <= events.length; i++)
    assert.equal(
      trace.projectionHashes[i],
      hash(replayCostJournal(c, events.slice(0, i))),
    );
  const e = executionEvents(),
    frames = replayCostExecutionFrames(c.execution, e);
  assert.deepEqual(frames.result, replayCostExecutions(c.execution, e));
  for (let i = 0; i <= e.length; i++)
    assert.deepEqual(
      frames.frames[i],
      replayCostExecutions(c.execution, e.slice(0, i)),
    );
  frames.frames[1]!.orders[0]!.quantity = 99;
  assert.notEqual(frames.frames[2]!.orders[0]!.quantity, 99);
  assert.deepEqual(frames.result, replayCostExecutions(c.execution, e));
  assert.equal(hash({ c, events }), before);
});

test("CJ-24 native async callback is refused before invocation, not after rollback", async () => {
  const { repo } = opened();
  let invoked = false;
  try {
    const before = dump(repo);
    const callback = async () => {
      invoked = true;
      await Promise.resolve();
      repo.db
        .prepare("INSERT INTO commands VALUES(?,?)")
        .run("escaped", "test");
    };
    assert.throws(
      () => Reflect.apply(repo.writerTransaction, repo, [callback]),
      /ASYNC_WRITER_TRANSACTION/,
    );
    await Promise.resolve();
    assert.equal(invoked, false);
    assert.deepEqual(dump(repo), before);
  } finally {
    repo.close();
  }
});

test("CJ-20 duplicate fast path must recheck lease immediately before commit", () => {
  let armed = false,
    checks = 0;
  const { repo, store } = opened(journalConfig(), ":memory:", () =>
    armed && ++checks > 1 ? 11000 : 1000,
  );
  try {
    store.append(journalEvents()[0]!);
    store.append(journalEvents()[1]!);
    const before = dump(repo);
    armed = true;
    assert.throws(
      () => store.append({ ...journalEvents()[1], id: "redelivery" }),
      /FENCED_WRITER/,
    );
    assert.deepEqual(dump(repo), before);
  } finally {
    repo.close();
  }
});
test("CJ-21 SQL fill primary and event unique constraints are persistent latches", () => {
  const { repo, store } = opened();
  try {
    for (const e of journalEvents().slice(0, 2)) store.append(e);
    const before = dump(repo);
    assert.throws(
      () =>
        repo.writerTransaction(() =>
          repo.db.exec(
            "INSERT INTO cost_journal_fills SELECT fill_key,99,identity_hash,body,checksum FROM cost_journal_fills",
          ),
        ),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        repo.writerTransaction(() =>
          repo.db.exec(
            "INSERT INTO cost_journal_fills SELECT 'another-key',event_seq,identity_hash,body,checksum FROM cost_journal_fills",
          ),
        ),
      /UNIQUE/,
    );
    assert.deepEqual(dump(repo), before);
  } finally {
    repo.close();
  }
});
test("CJ-22 settlement updates and initialization also roll back on storage failure", () => {
  const repo = new Repository(":memory:", () => 1000);
  repo.acquire();
  repo.failure = "WRITE_FAILURE";
  try {
    assert.throws(
      () => new CostJournal(repo, journalConfig(), { initialize: true }),
      /WRITE_FAILURE/,
    );
    assert.equal(
      repo.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='cost_journal_run'")
        .get(),
      undefined,
    );
    repo.failure = null;
    const store = new CostJournal(repo, journalConfig(), { initialize: true });
    for (const e of journalEvents().slice(0, 6)) store.append(e);
    const before = dump(repo);
    repo.failure = "DISK_FULL";
    assert.throws(() => store.append(journalEvents()[6]!), /DISK_FULL/);
    assert.deepEqual(dump(repo), before);
    repo.failure = null;
    assert.equal(
      store.append(journalEvents()[6]!).projection.wallet.cash,
      "97990",
    );
  } finally {
    repo.close();
  }
});
function partitions(n: number): number[][] {
  return n === 0
    ? [[]]
    : Array.from({ length: n }, (_, i) =>
        partitions(n - i - 1).map((rest) => [i + 1, ...rest]),
      ).flat();
}
for (const rounding of ["UP", "DOWN", "HALF_EVEN"] as const)
  test(`CJ-23 ${rounding} deferred SELL reserve covers all partitions and positive deficits without reusing gains`, () => {
    let positiveDeficits = 0;
    for (const orderUnit of ["ORDER", "FILL"] as const)
      for (const parts of partitions(4)) {
        const c = journalConfig();
        c.execution.profile.rules.forEach((r) => {
          r.minimum = "0";
          r.fixed = "0";
          r.rounding = rounding;
          r.quantum = "0.3";
          r.tiers = [{ upTo: null, rate: "0" }];
        });
        const fee = c.execution.profile.rules.find(
          (r) => r.side === "SELL" && r.component === "COMMISSION",
        )!;
        fee.unit = orderUnit;
        fee.minimum = "1500.1";
        fee.fixed = "0.2";
        fee.tiers = [
          { upTo: "1500", rate: "0" },
          { upTo: null, rate: "5000" },
        ];
        const tax = c.execution.profile.rules.find(
          (r) => r.side === "SELL" && r.component === "TAX",
        )!;
        tax.unit = "FILL";
        tax.basis = "SHARES";
        tax.fixed = "1200";
        tax.tiers = [
          { upTo: "1", rate: "0.1" },
          { upTo: null, rate: "500" },
        ];
        const e: CostJournalEvent[] = [
          {
            kind: "ORDER",
            id: "b",
            orderId: "b",
            seq: 1,
            at: costAt + 1,
            side: "BUY",
            quantity: 4,
            limit: "1",
            replaces: null,
          },
          {
            kind: "FILL",
            id: "bf",
            orderId: "b",
            fillId: "bf",
            seq: 2,
            at: costAt + 2,
            occurredAt: costAt + 2,
            quantity: 4,
            price: "1",
          },
          { kind: "SETTLE", id: "bs", seq: 3, at: costAt + 3, fillIds: ["bf"] },
          {
            kind: "ORDER",
            id: "s",
            orderId: "s",
            seq: 4,
            at: costAt + 4,
            side: "SELL",
            quantity: 4,
            limit: "1000",
            replaces: null,
          },
        ];
        for (const [i, quantity] of parts.entries())
          e.push({
            kind: "FILL",
            id: `sf${i}`,
            orderId: "s",
            fillId: `sf${i}`,
            seq: 5 + i,
            at: costAt + 5 + i,
            occurredAt: costAt + 5 + i,
            quantity,
            price: i % 2 === 0 ? "5000" : "1000",
          });
        const initial = replayCostJournal(c, e.slice(0, 4));
        for (let prefix = 4; prefix < e.length; prefix++) {
          const before = replayCostJournal(c, e.slice(0, prefix));
          for (let later = prefix + 1; later <= e.length; later++) {
            const after = replayCostJournal(c, e.slice(0, later));
            const liabilities = d(after.wallet.payable).minus(
              before.wallet.payable,
            );
            if (prefix > 4 && liabilities.gt(0)) positiveDeficits++;
            assert.ok(
              d(before.reservedCash).gte(liabilities.plus(after.reservedCash)),
              JSON.stringify({ orderUnit, parts, prefix, later }),
            );
            assert.ok(d(after.wallet.cash).eq(initial.wallet.cash));
            assert.ok(d(after.availableCash).lte(initial.wallet.cash));
          }
        }
      }
    assert.ok(positiveDeficits > 0);
  });

const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "cost-journal-owned-")), "test.sqlite");
function opened(
  c = journalConfig(),
  path = ":memory:",
  clock: () => number = () => 1000,
) {
  const repo = new Repository(path, clock);
  repo.acquire();
  return { repo, store: new CostJournal(repo, c, { initialize: true }) };
}
const dump = (r: Repository) =>
  Object.fromEntries(
    [
      "cost_journal_run",
      "cost_journal_events",
      "cost_journal_fills",
      "audit",
      "writer",
    ].map((t) => [t, r.db.prepare(`SELECT * FROM ${t}`).all()]),
  );
for (const market of ["KR", "US"] as const)
  for (const unit of ["ORDER", "FILL"] as const)
    test(`CJ-01 ${market} ${unit} partial fill costs, pending cash, settlement and held learning`, () => {
      const c = journalConfig(unit, market),
        e = journalEvents(),
        { repo, store } = opened(c);
      try {
        const v1 = store.append(e[0]!).projection;
        assert.ok(d(v1.reservedCash).gte(4000));
        const p = store.append(e[1]!).projection;
        assert.equal(p.wallet.cash, "100000");
        assert.equal(p.wallet.payable, "1010");
        assert.equal(p.wallet.receivable, "0");
        assert.equal(p.quantity, 1);
        assert.equal(p.postings[0]!.feeDelta, "10");
        for (const event of e.slice(2, 6)) store.append(event);
        const buy = store.read().projection;
        assert.equal(buy.wallet.payable, unit === "ORDER" ? "2010" : "2020");
        assert.equal(buy.reservedCash, "0");
        const settled = store.append(e[6]!).projection;
        assert.equal(settled.wallet.payable, "0");
        assert.equal(settled.economicCash, buy.economicCash);
        assert.equal(settled.availableCash, buy.availableCash);
        store.append(e[7]!);
        const sell = store.append(e[8]!).projection;
        assert.equal(sell.wallet.receivable, "1090");
        assert.equal(sell.wallet.cash, settled.wallet.cash);
        assert.ok(d(sell.availableCash).lte(settled.wallet.cash));
        for (const event of e.slice(9)) store.append(event);
        const final = store.read();
        assert.deepEqual(final.projection, replayCostJournal(c, e));
        assert.equal(
          final.projection.wallet.cash,
          unit === "ORDER" ? "100170" : "100160",
        );
        assert.equal(final.projection.wallet.receivable, "0");
        assert.equal(final.projection.wallet.payable, "0");
        assert.equal(final.projection.learningAllowed, false);
        assert.equal(final.projection.orderSubmissionAllowed, false);
        assert.equal(final.projection.liveEnabled, false);
        assert.equal(repo.verifyAudit(), e.length + 1);
      } finally {
        repo.close();
      }
    });
test("CJ-02 same timestamp fills remain distinct and preserve per-fill minimum", () => {
  const c = journalConfig("FILL"),
    e = journalEvents().slice(0, 3);
  e[2] = {
    ...e[2]!,
    at: e[1]!.at,
    ...(e[2]!.kind === "FILL" ? { occurredAt: e[1]!.at } : {}),
  };
  const v = replayCostJournal(c, e);
  assert.equal(v.postings.length, 2);
  assert.equal(v.tradingFees, "20");
  assert.equal(v.wallet.payable, "2020");
});
test("CJ-03 duplicate delivery, alternate delivery ID/time, post-settlement replay never change money", () => {
  const { repo, store } = opened(),
    e = journalEvents();
  try {
    for (const x of e) store.append(x);
    const before = dump(repo),
      state = store.read();
    assert.deepEqual(store.append(e[1]!), state);
    assert.deepEqual(
      store.append({ ...e[1], id: "retry", seq: 15, at: costAt + 15 }),
      state,
    );
    assert.deepEqual(dump(repo), before);
    assert.throws(
      () =>
        store.append({
          ...e[1],
          id: "conflict",
          seq: 15,
          at: costAt + 15,
          quantity: 2,
        }),
      /FILL_ID_CONFLICT/,
    );
    assert.throws(
      () => store.append({ ...e[1], price: "999" }),
      /EVENT_ID_CONFLICT/,
    );
    assert.throws(
      () => store.append({ ...e[1], id: "cross-order", orderId: "sell" }),
      /FILL_ID_CONFLICT/,
    );
    assert.deepEqual(dump(repo), before);
  } finally {
    repo.close();
  }
});
test("CJ-04 source scope is immutable and fill key is scoped, no lossy ID conversion", () => {
  const c = journalConfig(),
    other = structuredClone(c);
  other.sourceScope.namespace = "other-session";
  assert.notEqual(journalFillKey(c, "f1"), journalFillKey(other, "f1"));
  const { repo, store } = opened(c);
  try {
    const before = dump(repo);
    assert.throws(() => new CostJournal(repo, other), /CONFIG_MISMATCH/);
    assert.throws(() =>
      store.append({ ...journalEvents()[0], orderId: "broker:id" }),
    );
    assert.deepEqual(dump(repo), before);
  } finally {
    repo.close();
  }
});
test("CJ-05 UNKNOWN late partial fill preserves uncertainty/reservation until exact cancel evidence", () => {
  const e: CostJournalEvent[] = executionEvents().slice(0, 2);
  e.push({ id: "u", seq: 3, at: costAt + 3, kind: "UNKNOWN", orderId: "buy" });
  e.push({ ...executionEvents()[2]!, id: "late", seq: 4, at: costAt + 4 });
  const v = replayCostJournal(journalConfig(), e);
  assert.equal(v.orders[0]!.status, "UNKNOWN");
  assert.equal(v.orders[0]!.filled, 2);
  assert.ok(d(v.reservedCash).gte(2000));
  assert.throws(
    () =>
      replayCostJournal(journalConfig(), [
        ...e,
        { ...executionEvents()[6]!, seq: 5 },
      ]),
    /UNRESOLVED/,
  );
  assert.throws(
    () =>
      replayCostJournal(journalConfig(), [
        ...e,
        { ...executionEvents()[5]!, seq: 5, cumulativeQuantity: 1 },
      ]),
    /CANCEL_EVIDENCE/,
  );
  const cancelled = replayCostJournal(journalConfig(), [
    ...e,
    { ...executionEvents()[5]!, seq: 5 },
  ]);
  assert.equal(cancelled.reservedCash, "0");
  assert.equal(cancelled.wallet.payable, "2010");
});
test("CJ-06 cancel pending partial fill, confirmation and replacement do not reuse unconfirmed quantity", () => {
  const e = journalEvents().slice(0, 10);
  e.push({
    kind: "FILL",
    id: "race",
    seq: 11,
    at: costAt + 11,
    occurredAt: costAt + 11,
    orderId: "sell",
    fillId: "race-fill",
    quantity: 1,
    price: "1100",
  });
  const v = replayCostJournal(journalConfig(), e);
  assert.equal(v.quantity, 0);
  assert.equal(v.orders[1]!.status, "FILLED");
  assert.throws(
    () =>
      replayCostJournal(journalConfig(), [
        ...e,
        { ...journalEvents()[10]!, seq: 12, at: costAt + 12 },
      ]),
    /TERMINAL/,
  );
});
for (const change of [
  { fillIds: ["absent"] },
  { fillIds: ["buy-fill1", "buy-fill1"] },
  { at: costAt + 2 },
  { seq: 99 },
] as const)
  test(`CJ-07 rejects malformed/early settlement ${JSON.stringify(change)}`, () => {
    const { repo, store } = opened();
    try {
      store.append(journalEvents()[0]!);
      store.append(journalEvents()[1]!);
      const before = dump(repo);
      assert.throws(() =>
        store.append({
          kind: "SETTLE",
          id: "s",
          seq: 3,
          at: costAt + 3,
          fillIds: ["buy-fill1"],
          ...change,
        }),
      );
      assert.deepEqual(dump(repo), before);
    } finally {
      repo.close();
    }
  });
test("CJ-08 second settlement ID cannot pay the same fill twice", () => {
  const { repo, store } = opened();
  try {
    for (const e of journalEvents().slice(0, 7)) store.append(e);
    const before = dump(repo);
    assert.throws(
      () =>
        store.append({
          ...journalEvents()[6],
          id: "again",
          seq: 8,
          at: costAt + 8,
        }),
      /INVALID_SETTLEMENT/,
    );
    assert.deepEqual(dump(repo), before);
  } finally {
    repo.close();
  }
});
for (const bad of ["horizon", "profile-expiry", "real", "operating", "unit"])
  test(`CJ-09 rejects unsupported config before creating journal tables: ${bad}`, () => {
    const c = journalConfig();
    let raw: unknown = c;
    if (bad === "horizon") c.horizonEnd = c.execution.initialAt - 1;
    if (bad === "profile-expiry")
      c.horizonEnd = c.execution.profile.effectiveTo;
    if (bad === "real")
      raw = { ...c, sourceScope: { ...c.sourceScope, provider: "LIVE" } };
    if (bad === "operating") raw = { ...c, operatingCosts: "UNKNOWN" };
    if (bad === "unit") c.execution.profile.rules[0]!.unit = "DAY";
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    try {
      assert.throws(() => new CostJournal(repo, raw, { initialize: true }));
      assert.equal(
        repo.db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='cost_journal_run'")
          .get(),
        undefined,
      );
    } finally {
      repo.close();
    }
  });
for (const stage of ["EVENT", "FILL_INDEX", "STATE", "AUDIT"] as const)
  test(`CJ-10 rollback at ${stage} removes all partial writes; retry charges once`, () => {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    let fail = false;
    const store = new CostJournal(repo, journalConfig(), {
      initialize: true,
      testStage: (s) => {
        if (fail && s === stage) throw Error("INJECTED");
      },
    });
    try {
      store.append(journalEvents()[0]!);
      const before = dump(repo);
      fail = true;
      assert.throws(() => store.append(journalEvents()[1]!), /INJECTED/);
      assert.deepEqual(dump(repo), before);
      fail = false;
      const v = store.append(journalEvents()[1]!);
      assert.equal(v.projection.wallet.payable, "1010");
      assert.equal(v.projection.postings.length, 1);
    } finally {
      repo.close();
    }
  });
test("CJ-11 lease expiry during transaction rolls back, including duplicate fast path", () => {
  let now = 1000,
    expire = false;
  const repo = new Repository(":memory:", () => now);
  repo.acquire();
  const store = new CostJournal(repo, journalConfig(), {
    initialize: true,
    testStage: (s) => {
      if (expire && s === "AUDIT") now += 10000;
    },
  });
  try {
    store.append(journalEvents()[0]!);
    const before = dump(repo);
    expire = true;
    assert.throws(() => store.append(journalEvents()[1]!), /FENCED/);
    assert.deepEqual(dump(repo), before);
    assert.throws(() => store.append(journalEvents()[0]!), /FENCED/);
    assert.deepEqual(dump(repo), before);
    repo.acquire();
    expire = false;
    assert.equal(store.append(journalEvents()[1]!).epoch, 2);
  } finally {
    repo.close();
  }
});
test("CJ-12 second connection sees no uncommitted state and cannot acquire active writer", () => {
  const path = fresh(),
    a = new Repository(path, () => 1000);
  a.acquire();
  let inspected = false,
    armed = false;
  const store = new CostJournal(a, journalConfig(), {
    initialize: true,
    testStage: (stage) => {
      if (stage === "FILL_INDEX" && armed) {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          const row = db.prepare("SELECT body FROM cost_journal_run").get()!;
          assert.equal(JSON.parse(String(row.body)).revision, 1);
          assert.equal(
            db.prepare("SELECT COUNT(*) AS n FROM cost_journal_events").get()!
              .n,
            1,
          );
          assert.equal(
            db.prepare("SELECT COUNT(*) AS n FROM cost_journal_fills").get()!.n,
            0,
          );
          inspected = true;
        } finally {
          db.close();
        }
      }
    },
  });
  const b = new Repository(path, () => 1000);
  try {
    assert.throws(() => b.acquire(), /WRITER_BUSY/);
    store.append(journalEvents()[0]!);
    armed = true;
    store.append(journalEvents()[1]!);
    assert.ok(inspected);
    assert.equal(new CostJournal(b, journalConfig()).read().revision, 2);
  } finally {
    b.close();
    a.close();
  }
});
test("CJ-13 expired writer is fenced after takeover, including retransmitted fill", () => {
  let now = 1000;
  const path = fresh(),
    { repo: a, store } = opened(journalConfig(), path, () => now);
  store.append(journalEvents()[0]!);
  store.append(journalEvents()[1]!);
  now += 10001;
  const b = new Repository(path, () => now);
  b.acquire();
  const resumed = new CostJournal(b, journalConfig());
  try {
    const before = dump(b);
    assert.throws(() => store.append(journalEvents()[1]!), /FENCED/);
    assert.deepEqual(dump(b), before);
    const v = resumed.append(journalEvents()[2]!);
    assert.equal(v.epoch, 2);
    assert.equal(v.projection.wallet.payable, "2010");
  } finally {
    a.close();
    b.close();
  }
});
test("CJ-14 legacy data cannot be adopted, new journal cannot be read/written as legacy", () => {
  const repo = new Repository(":memory:", () => 1000);
  repo.acquire();
  try {
    repo.db.prepare("INSERT INTO commands VALUES(?,?)").run("old", hash("old"));
    assert.throws(
      () => new CostJournal(repo, journalConfig(), { initialize: true }),
      /EMPTY_REPOSITORY/,
    );
    assert.equal(
      repo.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='cost_journal_run'")
        .get(),
      undefined,
    );
  } finally {
    repo.close();
  }
  const { repo: r, store } = opened();
  try {
    const before = dump(r);
    assert.throws(() => r.read(), /VERSIONED_READER/);
    assert.throws(
      () =>
        r.transact("legacy", {}, () => {
          throw Error("CALLBACK_MUST_NOT_RUN");
        }),
      /VERSIONED_READER/,
    );
    assert.deepEqual(dump(r), before);
    assert.equal(store.read().revision, 0);
  } finally {
    r.close();
  }
});
for (const sql of [
  "UPDATE cost_journal_fills SET identity_hash='bad'",
  "DELETE FROM cost_journal_fills",
  "UPDATE cost_journal_events SET epoch=9",
  "UPDATE cost_journal_run SET checksum='bad'",
  "UPDATE audit SET previous='bad' WHERE seq=2",
])
  test(`CJ-15 replay rejects corruption ${sql}`, () => {
    const { repo, store } = opened();
    try {
      for (const e of journalEvents().slice(0, 2)) store.append(e);
      repo.db.exec(sql);
      assert.throws(() => store.read());
      assert.throws(() => store.append(journalEvents()[2]!));
    } finally {
      repo.close();
    }
  });
test("CJ-16 orderly restart retains ID latch and replays identical settlement state", () => {
  const path = fresh(),
    c = journalConfig(),
    openedRun = opened(c, path);
  for (const e of journalEvents().slice(0, 7)) openedRun.store.append(e);
  const before = openedRun.store.read();
  openedRun.repo.close();
  const repo = new Repository(path, () => 1000);
  repo.acquire();
  const store = new CostJournal(repo, c);
  try {
    assert.deepEqual(store.read(), before);
    assert.deepEqual(
      store.append({ ...journalEvents()[1], id: "retry" }),
      before,
    );
    for (const e of journalEvents().slice(7)) store.append(e);
    assert.equal(store.read().projection.wallet.cash, "100170");
  } finally {
    repo.close();
  }
});

// A slow or expensive fee tier must never be financed by uncollected proceeds.
for (const market of ["KR", "US"] as const)
  test(`CJ-17 ${market} favorable first SELL price cannot inflate deferred reserve or fund later liabilities`, () => {
    const c = journalConfig("ORDER", market);
    c.execution.initialCash = "100";
    c.execution.profile.rules.forEach((r) => {
      r.minimum = "0";
      r.fixed = "0";
      r.quantum = "0.01";
      r.tiers = [{ upTo: null, rate: "0" }];
    });
    c.execution.profile.rules.find(
      (r) => r.side === "SELL" && r.component === "COMMISSION",
    )!.tiers = [
      { upTo: "10000", rate: "0" },
      { upTo: null, rate: "5000" },
    ];
    const e: CostJournalEvent[] = [
      {
        kind: "ORDER",
        id: "b",
        orderId: "b",
        seq: 1,
        at: costAt + 1,
        side: "BUY",
        quantity: 2,
        limit: "1",
        replaces: null,
      },
      {
        kind: "FILL",
        id: "bf",
        orderId: "b",
        fillId: "bf",
        seq: 2,
        at: costAt + 2,
        occurredAt: costAt + 2,
        quantity: 2,
        price: "1",
      },
      { kind: "SETTLE", id: "bs", seq: 3, at: costAt + 3, fillIds: ["bf"] },
      {
        kind: "ORDER",
        id: "s",
        orderId: "s",
        seq: 4,
        at: costAt + 4,
        side: "SELL",
        quantity: 2,
        limit: "1",
        replaces: null,
      },
      {
        kind: "FILL",
        id: "sf1",
        orderId: "s",
        fillId: "sf1",
        seq: 5,
        at: costAt + 5,
        occurredAt: costAt + 5,
        quantity: 1,
        price: "5000",
      },
      {
        kind: "FILL",
        id: "sf2",
        orderId: "s",
        fillId: "sf2",
        seq: 6,
        at: costAt + 6,
        occurredAt: costAt + 6,
        quantity: 1,
        price: "1",
      },
    ];
    const before = replayCostJournal(c, e.slice(0, 4)),
      after = replayCostJournal(c, e.slice(0, 5));
    assert.equal(after.wallet.cash, "98");
    assert.equal(after.wallet.receivable, "5000");
    assert.ok(d(after.reservedCash).lte(before.reservedCash));
    assert.ok(d(after.availableCash).lte("98"));
    const final = replayCostJournal(c, e);
    assert.equal(final.wallet.cash, "98");
    assert.equal(final.wallet.receivable, "5001");
  });
for (const market of ["KR", "US"] as const)
  test(`CJ-18 ${market} SELL fee shortfall becomes nonnegative payable once, reservation released on settlement`, () => {
    const c = journalConfig("FILL", market);
    c.execution.profile.rules.find(
      (r) => r.side === "SELL" && r.component === "COMMISSION",
    )!.minimum = "1500";
    const e = journalEvents(),
      v = replayCostJournal(c, e.slice(0, 9));
    assert.equal(v.wallet.receivable, "0");
    assert.equal(v.wallet.payable, "400");
    assert.ok(d(v.reservedCash).gte(400));
    assert.equal(v.postings.at(-1)!.feeDelta, "1500");
    const final = replayCostJournal(c, e);
    assert.equal(final.wallet.payable, "0");
    assert.equal(final.wallet.cash, "97180");
    assert.equal(final.reservedCash, "0");
  });

for (const stage of [
  "EVENT",
  "FILL_INDEX",
  "STATE",
  "AUDIT",
  "COMMITTED",
] as const)
  test(`CJ-19 owned child kill at ${stage}: rollback-or-whole-commit and retry exactly once`, async () => {
    const path = fresh();
    const child = spawn(
      process.execPath,
      ["scripts/cost-journal-crash-fixture.mjs", path, stage],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr!.on("data", (b) => {
      stderr += String(b);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(Error("JOURNAL_CHILD_TIMEOUT"));
        }, 30000);
        child.once("message", (message) => {
          clearTimeout(timer);
          try {
            assert.deepEqual(message, { stage });
          } catch (error) {
            reject(error);
            return;
          }
          resolve();
        });
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(Error(stderr || "JOURNAL_CHILD_EARLY_EXIT"));
        });
      });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      // Injected lease time advances; this is not a real ten-second expiry test.
      const repo = new Repository(path, () => 20001);
      repo.acquire();
      const store = new CostJournal(repo, journalConfig());
      try {
        const committed = stage === "COMMITTED",
          v = store.read();
        assert.equal(v.revision, committed ? 2 : 1);
        assert.equal(v.projection.postings.length, committed ? 1 : 0);
        assert.equal(v.projection.wallet.payable, committed ? "1010" : "0");
        assert.equal(repo.verifyAudit(), committed ? 3 : 2);
        store.append(journalEvents()[1]!);
        assert.equal(store.read().projection.wallet.payable, "1010");
        assert.equal(store.read().projection.postings.length, 1);
        for (const e of journalEvents().slice(2)) store.append(e);
        assert.equal(store.read().projection.wallet.cash, "100170");
      } finally {
        repo.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  });
