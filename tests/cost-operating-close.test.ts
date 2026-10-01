import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../src/core/policy.js";
import type { OperatingCloseRequest } from "../src/core/cost-operating-close.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { Repository } from "../src/server/repository.js";
import {
  operatingConfig,
  openedOperating,
  op,
  record,
} from "./cost-operating-helpers.js";
import {
  beginTrade,
  fillTrade,
  closeTrade,
  sellOrder,
  cancelOrder,
  execute,
  journal,
  outcomeConfig,
} from "./cost-outcome-helpers.js";
import { dumpHandoff, handoffConfig } from "./cost-handoff-helpers.js";
import { proposal, reservationConfig } from "./cost-reservation-helpers.js";

type Fixture = ReturnType<typeof openedOperating>;
// TEST AUTHOR ONLY: these fixtures explicitly declare that every event in the
// entire risk day is known, and all unpopulated time intervals are empty.
// This must never be used to infer provider completeness from a live DB.
function request(f: Fixture): OperatingCloseRequest {
  const records = f.repo.db
    .prepare(
      "SELECT id,body,receipt FROM cost_reservation_commands ORDER BY seq",
    )
    .all()
    .map((r) => ({
      id: String(r.id),
      input: JSON.parse(String(r.body)) as unknown,
      receipt: JSON.parse(String(r.receipt)) as unknown,
    }));
  return {
    schemaVersion: "OPERATING_CLOSE_FIXTURE_REQUEST_V1",
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    manifest: {
      configHash: hash(f.c),
      stateHash: hash(f.store.read()),
      recordsHash: hash(records),
      recordCount: records.length,
      periodStart: f.c.operating.periodStart,
      periodEnd: f.c.operating.periodEnd,
      coverage: "FULL_PERIOD_FROM_EMPTY",
      finalizedAt: f.c.operating.periodEnd,
      availableAt: f.c.operating.periodEnd,
    },
    asOf: f.c.operating.periodEnd,
  };
}
const report = (f: Fixture) => f.store.operatingClose(request(f));
const dump = (repo: Repository) => ({
  data: dumpHandoff(repo),
  writer: repo.db.prepare("SELECT * FROM writer").all(),
});
function one(f: Fixture, price = "10100") {
  const run = beginTrade(f.store);
  fillTrade(f.store, run);
  closeTrade(f.store, run, price);
  return run;
}
function debt(f: Fixture, amount = "50") {
  return record(f.store, op(f.store.read(), "RECOGNIZE", "cost", amount));
}
function verified(f: Fixture) {
  const r = report(f);
  assert.equal(r.status, "VERIFIED_FIXTURE_PROJECTION");
  assert.deepEqual(r.reasons, []);
  assert.ok(r.allocations);
  assert.ok(r.lossProjection);
  return r;
}

test("OC-01 unpaid cost: 80 trading profit - 50 = 30, no account/counter writes", () => {
  const f = openedOperating();
  try {
    one(f);
    debt(f);
    const before = dump(f.repo),
      s = f.store.read(),
      r = verified(f);
    assert.equal(r.totalOperatingKrw, "50");
    assert.deepEqual(
      r.allocations!.map((a) => [
        a.tradingNetPnlKrw,
        a.operatingCostKrw,
        a.finalNetPnlKrw,
      ]),
      [["80", "50", "30"]],
    );
    assert.equal(r.periodNetPnlKrw, "30");
    assert.equal(r.observed.operating.payableKrw, "50");
    assert.deepEqual(r.observed.accounts, s.handoff!.accounts);
    assert.deepEqual(r.observed.halts, s.seed.ledger.halts);
    assert.deepEqual(r.observed.cooldowns, s.seed.ledger.cooldowns);
    assert.deepEqual(r.observed.admissionHolds, s.handoff!.admissionHolds);
    assert.equal(s.outcomes![0]!.netPnlKrw, "80");
    assert.equal(s.outcomes![0]!.counterApplied, false);
    assert.equal(s.operating!.allocationStatus, "HOLD");
    assert.deepEqual(dump(f.repo), before);
    for (const flag of [
      r.counterApplied,
      r.persistedFinalization,
      r.automaticResumeAllowed,
      r.accountMutationAllowed,
      r.learningAllowed,
      r.orderSubmissionAllowed,
      r.liveEnabled,
    ])
      assert.equal(flag, false);
  } finally {
    f.repo.close();
  }
});
for (const amount of ["0", "10", "999999999999999999999999999999"]) {
  test(`OC-02 no trades, cost ${amount} is unallocated, never a fabricated losing trade`, () => {
    const f = openedOperating();
    try {
      if (amount !== "0") debt(f, amount);
      const r = verified(f);
      assert.deepEqual(r.allocations, []);
      assert.deepEqual(r.lossProjection, []);
      assert.equal(r.unallocatedKrw, amount);
      assert.equal(r.periodNetPnlKrw, amount === "0" ? "0" : `-${amount}`);
      assert.equal(r.projectedLossStreak, 0);
    } finally {
      f.repo.close();
    }
  });
}
test("OC-03 +2/+2 less 6 operating cost gives -1/-1 and projected halt only", () => {
  const f = openedOperating();
  try {
    const a = beginTrade(f.store, "A"),
      b = beginTrade(f.store, "B");
    fillTrade(f.store, a);
    fillTrade(f.store, b);
    closeTrade(f.store, a, "10022");
    closeTrade(f.store, b, "10022");
    debt(f, "6");
    const r = verified(f);
    assert.deepEqual(
      r.allocations!.map((a) => [
        a.tradingNetPnlKrw,
        a.operatingCostKrw,
        a.finalNetPnlKrw,
      ]),
      [
        ["2", "3", "-1"],
        ["2", "3", "-1"],
      ],
    );
    assert.deepEqual(
      r.lossProjection!.map((a) => a.lossStreakAfter),
      [1, 2],
    );
    assert.equal(r.projectedConsecutiveLossReviewHalt, true);
    assert.equal(f.store.read().seed.ledger.lossStreak, 0);
    assert.equal(r.observed.halts.includes("CONSECUTIVE_LOSSES"), false);
  } finally {
    f.repo.close();
  }
});
test("OC-04 ASCII remainder order differs from close time; loss-zero keeps streak", () => {
  const f = openedOperating();
  try {
    const [a, b] = [beginTrade(f.store, "B"), beginTrade(f.store, "A")].sort();
    assert.ok(a && b);
    assert.ok(a < b);
    fillTrade(f.store, b);
    fillTrade(f.store, a);
    closeTrade(f.store, b, "10021");
    closeTrade(f.store, a, "10023");
    debt(f, "5");
    const r = verified(f);
    assert.deepEqual(
      r.allocations!.map((v) => [
        v.tradeId,
        v.operatingCostKrw,
        v.finalNetPnlKrw,
      ]),
      [
        [a, "3", "0"],
        [b, "2", "-1"],
      ],
    );
    assert.deepEqual(
      r.lossProjection!.map((v) => [v.tradeId, v.lossStreakAfter]),
      [
        [b, 1],
        [a, 1],
      ],
    );
    assert.equal(r.periodNetPnlKrw, "-1");
  } finally {
    f.repo.close();
  }
});
test("OC-05 same close time uses revision; later win cannot erase previously reached halt", () => {
  const c = operatingConfig();
  c.seed.ledger.lossStreak = 1;
  c.book.seedHash = hash(c.seed);
  const f = openedOperating(c);
  try {
    const b = beginTrade(f.store, "B"),
      a = beginTrade(f.store, "A");
    fillTrade(f.store, b);
    fillTrade(f.store, a);
    sellOrder(f.store, b, "10000");
    sellOrder(f.store, a, "10100");
    const at = f.store.read().seed.clock + 1;
    fillTrade(f.store, b, "exit", 1, "10000", at);
    fillTrade(f.store, a, "exit", 1, "10100", at);
    const r = verified(f);
    assert.equal(r.allocations![0]!.closedAt, r.allocations![1]!.closedAt);
    assert.deepEqual(
      r.lossProjection!.map((v) => [v.tradeId, v.lossStreakAfter]),
      [
        [b, 2],
        [a, 0],
      ],
    );
    assert.equal(r.projectedLossStreak, 0);
    assert.equal(r.projectedConsecutiveLossReviewHalt, true);
    assert.equal(r.observed.lossStreak, 1);
  } finally {
    f.repo.close();
  }
});
test("OC-06 zero preserves initial streak, following loss reaches two", () => {
  const c = operatingConfig();
  c.seed.ledger.lossStreak = 1;
  c.book.seedHash = hash(c.seed);
  const f = openedOperating(c);
  try {
    const a = beginTrade(f.store, "A"),
      b = beginTrade(f.store, "B");
    fillTrade(f.store, a);
    fillTrade(f.store, b);
    closeTrade(f.store, a, "10020");
    closeTrade(f.store, b, "10000");
    assert.deepEqual(
      verified(f).lossProjection!.map((v) => v.lossStreakAfter),
      [1, 2],
    );
  } finally {
    f.repo.close();
  }
});
test("OC-07 unchanged repeated read and detached report cannot change DB or lease", () => {
  const f = openedOperating();
  try {
    one(f);
    debt(f);
    const req = request(f),
      before = dump(f.repo);
    f.repo.db.exec("PRAGMA query_only=ON");
    const r = f.store.operatingClose(req),
      expected = structuredClone(r);
    assert.deepEqual(f.store.operatingClose(req), expected);
    r.observed.accounts.KRW.cash = "0";
    r.observed.admissionHolds.length = 0;
    r.manifest.configHash = "0".repeat(64);
    r.allocations![0]!.finalNetPnlKrw = "0";
    assert.deepEqual(f.store.operatingClose(req), expected);
    assert.deepEqual(dump(f.repo), before);
    const { reportHash, ...body } = expected;
    assert.equal(reportHash, hash(body));
  } finally {
    f.repo.db.exec("PRAGMA query_only=OFF");
    f.repo.close();
  }
});
test("OC-08 payment and settlement snapshots alter balances, not allocation or streak", () => {
  const f = openedOperating();
  try {
    const run = one(f);
    debt(f);
    const before = verified(f),
      req = request(f);
    record(f.store, op(f.store.read(), "PAY", "pay"));
    execute(f.store, run, {
      kind: "SETTLE",
      id: "settle",
      fillIds: journal(f.store.read(), run).postings.map((p) => p.fill.fillId),
    });
    const after = verified(f);
    assert.deepEqual(after.allocations, before.allocations);
    assert.deepEqual(after.lossProjection, before.lossProjection);
    assert.equal(after.periodNetPnlKrw, before.periodNetPnlKrw);
    assert.equal(after.observed.operating.payableKrw, "0");
    assert.notEqual(after.reportHash, before.reportHash);
    assert.notDeepEqual(after.observed.accounts, before.observed.accounts);
    assert.ok(
      f.store
        .operatingClose(req)
        .reasons.includes("MANIFEST_SNAPSHOT_MISMATCH"),
    );
  } finally {
    f.repo.close();
  }
});
test("OC-09 fractional trading PnL with very large integer cost is exact", () => {
  const f = openedOperating();
  try {
    one(f, "10020.123456");
    debt(f, "999999999999999999999999999999");
    const r = verified(f);
    assert.equal(r.allocations![0]!.tradingNetPnlKrw, "0.123456");
    assert.equal(
      r.allocations![0]!.finalNetPnlKrw,
      "-999999999999999999999999999998.876544",
    );
    assert.equal(r.periodNetPnlKrw, r.allocations![0]!.finalNetPnlKrw);
  } finally {
    f.repo.close();
  }
});
const mutations: [string, (r: OperatingCloseRequest) => void, string][] = [
  [
    "wrong config",
    (r) => {
      r.manifest.configHash = "0".repeat(64);
    },
    "MANIFEST_SNAPSHOT_MISMATCH",
  ],
  [
    "wrong state",
    (r) => {
      r.manifest.stateHash = "0".repeat(64);
    },
    "MANIFEST_SNAPSHOT_MISMATCH",
  ],
  [
    "omitted commands",
    (r) => {
      r.manifest.recordsHash = hash([]);
    },
    "MANIFEST_SNAPSHOT_MISMATCH",
  ],
  [
    "wrong count",
    (r) => {
      r.manifest.recordCount--;
    },
    "MANIFEST_SNAPSHOT_MISMATCH",
  ],
  [
    "wrong period start",
    (r) => {
      r.manifest.periodStart++;
    },
    "MANIFEST_SNAPSHOT_MISMATCH",
  ],
  [
    "wrong period end",
    (r) => {
      r.manifest.periodEnd++;
    },
    "MANIFEST_SNAPSHOT_MISMATCH",
  ],
  [
    "incomplete",
    (r) => {
      r.manifest.coverage = "INCOMPLETE";
    },
    "PERIOD_COVERAGE_INCOMPLETE",
  ],
  [
    "early finalization",
    (r) => {
      r.manifest.finalizedAt--;
    },
    "CLOSE_EVIDENCE_NOT_AVAILABLE",
  ],
  [
    "future availability",
    (r) => {
      r.manifest.availableAt++;
    },
    "CLOSE_EVIDENCE_NOT_AVAILABLE",
  ],
  [
    "before available",
    (r) => {
      r.asOf--;
    },
    "CLOSE_EVIDENCE_NOT_AVAILABLE",
  ],
  [
    "available before finalized",
    (r) => {
      r.manifest.finalizedAt++;
      r.asOf++;
    },
    "CLOSE_EVIDENCE_NOT_AVAILABLE",
  ],
];
for (const [name, change, reason] of mutations)
  test(`OC-10 ${name}: whole projection HOLD, no allocations or writes`, () => {
    const f = openedOperating();
    try {
      debt(f);
      const req = request(f),
        before = dump(f.repo);
      change(req);
      const r = f.store.operatingClose(req);
      assert.equal(r.status, "HOLD");
      assert.ok(r.reasons.includes(reason));
      assert.equal(r.allocations, null);
      assert.equal(r.lossProjection, null);
      assert.equal(r.periodNetPnlKrw, null);
      assert.equal(r.projectedLossStreak, null);
      assert.equal(r.projectedConsecutiveLossReviewHalt, null);
      assert.deepEqual(dump(f.repo), before);
    } finally {
      f.repo.close();
    }
  });
for (const condition of [
  "ORDER",
  "UNKNOWN",
  "POSITION",
  "LOCAL_RESERVE",
  "OPERATING_RESERVE",
  "QUARANTINE",
] as const)
  test(`OC-11 ${condition} prevents close rather than silently removing denominator`, () => {
    const f = openedOperating();
    try {
      if (condition === "LOCAL_RESERVE") {
        const p = proposal(f.store);
        f.store.reserve("reserve", f.store.prepare(p));
      } else if (condition === "OPERATING_RESERVE")
        record(f.store, op(f.store.read(), "RESERVE", "reserve"));
      else if (condition === "QUARANTINE")
        f.store.operatingInput("bad", '{"kind":"REFUND"}', f.store.read());
      else {
        const run = beginTrade(
          f.store,
          "OPEN",
          1,
          condition === "UNKNOWN" ? "UNKNOWN" : "CONFIRMED",
        );
        if (condition === "POSITION") fillTrade(f.store, run);
      }
      const r = report(f);
      assert.equal(r.status, "HOLD");
      assert.equal(r.allocations, null);
      assert.ok(
        r.reasons.includes(
          condition === "LOCAL_RESERVE" || condition === "OPERATING_RESERVE"
            ? "UNRESOLVED_RESERVATION"
            : condition === "QUARANTINE"
              ? "QUARANTINED_INPUT"
              : "OPEN_POSITION_OR_ORDER",
        ),
      );
    } finally {
      f.repo.close();
    }
  });
test("OC-12 cancelled unfilled intent and released reservation are not expense or fake trade", () => {
  const f = openedOperating();
  try {
    const run = beginTrade(f.store);
    cancelOrder(f.store, run);
    const s = record(f.store, op(f.store.read(), "RESERVE", "reserve"));
    record(f.store, op(s, "RELEASE", "release", "50", "debt", "reserve"));
    const r = verified(f);
    assert.equal(r.totalOperatingKrw, "0");
    assert.deepEqual(r.allocations, []);
  } finally {
    f.repo.close();
  }
});
test("OC-18 one closed trade plus one open trade holds the entire allocation", () => {
  const f = openedOperating();
  try {
    const closed = beginTrade(f.store, "CLOSED"),
      open = beginTrade(f.store, "OPEN");
    fillTrade(f.store, closed);
    fillTrade(f.store, open);
    closeTrade(f.store, closed, "10100");
    debt(f);
    const before = f.store.read(),
      r = report(f);
    assert.equal(before.outcomes!.length, 1);
    assert.equal(r.status, "HOLD");
    assert.ok(r.reasons.includes("OPEN_POSITION_OR_ORDER"));
    assert.equal(r.allocations, null);
    assert.equal(r.unallocatedKrw, null);
    assert.equal(r.projectedLossStreak, null);
    assert.deepEqual(f.store.read(), before);
  } finally {
    f.repo.close();
  }
});
test("OC-19 initial threshold remains a review halt even with no completed trades", () => {
  const c = operatingConfig();
  c.seed.ledger.lossStreak = 2;
  c.book.seedHash = hash(c.seed);
  const f = openedOperating(c);
  try {
    const r = verified(f);
    assert.deepEqual(r.lossProjection, []);
    assert.equal(r.projectedLossStreak, 2);
    assert.equal(r.projectedConsecutiveLossReviewHalt, true);
    assert.equal(f.store.read().seed.ledger.lossStreak, 2);
  } finally {
    f.repo.close();
  }
});
test("OC-13 excessive trading loss and preexisting HOLD/cooldown preserved", () => {
  const f = openedOperating();
  try {
    const run = beginTrade(f.store, "LOSS", 4);
    fillTrade(f.store, run, "entry", 4);
    closeTrade(f.store, run, "1");
    debt(f);
    const r = verified(f);
    assert.ok(r.observed.halts.includes("STOP_LOSS_EXCEEDS_2X"));
    assert.ok(
      r.observed.admissionHolds.includes("OPERATING_ALLOCATION_NOT_FINAL"),
    );
    assert.deepEqual(
      r.observed.cooldowns,
      f.store.read().seed.ledger.cooldowns,
    );
  } finally {
    f.repo.close();
  }
});
for (const make of [reservationConfig, handoffConfig, outcomeConfig])
  test(`OC-14 ${make().kind} is not upgraded to V4`, () => {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    try {
      const store = new CostReservationStore(repo, make(), {
        initialize: true,
      });
      assert.throws(
        () => store.operatingClose({}),
        /OPERATING_CLOSE_V4_REQUIRED/,
      );
    } finally {
      repo.close();
    }
  });
test("OC-15 invalid/extra fields or LIVE provenance rejected with no writes", () => {
  const f = openedOperating();
  try {
    const req = request(f),
      before = dump(f.repo);
    for (const raw of [
      null,
      {},
      { ...req, extra: true },
      { ...req, provenance: "LIVE" },
      { ...req, asOf: NaN },
    ])
      assert.throws(
        () => f.store.operatingClose(raw),
        /OPERATING_CLOSE_REQUEST_INVALID/,
      );
    assert.deepEqual(dump(f.repo), before);
  } finally {
    f.repo.close();
  }
});
for (const tamper of ["command", "audit", "cache"] as const)
  test(`OC-16 ${tamper} corruption fails before report, read transaction rolled back`, () => {
    const f = openedOperating();
    try {
      debt(f);
      const req = request(f);
      if (tamper === "command")
        f.repo.db.exec("DELETE FROM cost_reservation_commands");
      else if (tamper === "audit") f.repo.db.exec("DELETE FROM audit");
      else
        f.repo.db
          .prepare("UPDATE cost_reservation_run SET checksum=?")
          .run("0".repeat(64));
      assert.throws(() => f.store.operatingClose(req), /LOCAL_|AUDIT/);
      f.repo.db.exec("BEGIN");
      f.repo.db.exec("ROLLBACK");
    } finally {
      f.repo.close();
    }
  });
test("OC-17 reopen without acquiring writer reproduces same report and all stored rows", () => {
  const c = operatingConfig(),
    path = join(
      mkdtempSync(join(tmpdir(), "operating-close-")),
      "fixture.sqlite",
    ),
    f = openedOperating(c, path);
  one(f);
  debt(f);
  const req = request(f),
    r = f.store.operatingClose(req);
  f.repo.close();
  const repo = new Repository(path, () => 1000);
  try {
    const store = new CostReservationStore(repo, c),
      before = dump(repo);
    repo.db.exec("PRAGMA query_only=ON");
    assert.deepEqual(store.operatingClose(req), r);
    assert.deepEqual(dump(repo), before);
  } finally {
    repo.db.exec("PRAGMA query_only=OFF");
    repo.close();
  }
});
