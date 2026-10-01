import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal } from "../src/core/math.js";
import { hash } from "../src/core/policy.js";
import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { reservationExposure } from "../src/core/cost-reservation.js";
import {
  applyPartialSettlement,
  projectPartialSettlement,
  partialTargetReference,
  partialSourceEventKey,
  partialSettlementEventLimit,
} from "../src/core/cost-partial-settlement.js";
import { postCloseTargetKey } from "../src/core/cost-post-close.js";
import {
  closedPartial,
  partialCommand,
  partialConfig,
} from "./cost-partial-settlement-helpers.js";
import {
  postCloseConfig,
  closedPostClose,
  finishPostClose,
  paymentCommand,
} from "./cost-post-close-helpers.js";
import { openedOperating, op, record } from "./cost-operating-helpers.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";
import { beginTrade, fillTrade, closeTrade } from "./cost-outcome-helpers.js";
const dump = (repo: Repository) => ({
  data: dumpHandoff(repo),
  writer: repo.db.prepare("SELECT * FROM writer").all(),
});
const history = (s: ReturnType<CostReservationStore["read"]>) => ({
  finalization: s.finalization,
  operating: s.operating,
  sources: s.book.sources,
  ledger: s.seed.ledger,
});

test("SA-01/02 partial 20 + remaining 30 preserves equity, historical costs and detached returns", () => {
  const f = closedPartial();
  try {
    const before = f.store.read(),
      h = history(before),
      start = BigInt(before.handoff!.accounts.KRW.cash);
    const e = partialCommand(before),
      first = f.store.settlePartial("part", e, before);
    const p = first.current.partialSettlement!.progress[0]!;
    assert.deepEqual(
      [p.status, p.settledPayable, p.remainingPayable, p.partialCount],
      ["PARTIAL", "20", "30", 1],
    );
    assert.equal(first.current.handoff!.accounts.KRW.cash, String(start - 20n));
    assert.equal(
      first.current.handoff!.accounts.KRW.availableCash,
      before.handoff!.accounts.KRW.availableCash,
    );
    assert.deepEqual(history(first.current), h);
    assert.deepEqual(first.current.partialSettlement!.currentOperating, {
      incurredKrw: "50",
      paidKrw: "20",
      payableKrw: "30",
    });
    const s = f.store.read(),
      second = f.store.settlePartial("remainder", partialCommand(s, 1), s);
    const report = f.store.partialSettlementReport(second.current.seed.clock);
    assert.equal(report.targets[0]!.status, "SETTLED");
    assert.equal(report.unresolvedCount, 0);
    assert.equal(report.accounts.KRW.cash, String(start - 50n));
    assert.equal(report.accounts.KRW.payable, "0");
    assert.deepEqual(history(second.current), h);
    assert.equal(report.status, "HOLD");
    assert.equal(
      report.orderSubmissionAllowed ||
        report.learningAllowed ||
        report.liveEnabled,
      false,
    );
    first.current.partialSettlement!.options.evidence[0]!.payable = "500";
    before.partialSettlement!.sourceScope.account = "changed";
    e.sourceScope.account = "changed";
    report.targets[0]!.remainingPayable = "900";
    second.current.partialSettlement!.basis!.accounts.KRW.cash = "1";
    f.c.partialSettlement.evidence[0]!.payable = "900";
    assert.equal(
      f.store.read().partialSettlement!.options.evidence[0]!.payable,
      "20",
    );
    assert.equal(
      f.store.partialSettlementReport(report.asOf).accounts.KRW.cash,
      String(start - 50n),
    );
  } finally {
    f.repo.close();
  }
});

test("SA-01 initial returned metadata and constructor config do not alias private config", () => {
  const c = partialConfig(),
    f = openedOperating(c);
  try {
    const s = f.store.read();
    s.partialSettlement!.sourceScope.account = "x";
    s.partialSettlement!.options.evidence[0]!.payable = "99";
    c.partialSettlement.evidence[0]!.payable = "99";
    assert.equal(
      f.store.read().partialSettlement!.options.evidence[0]!.payable,
      "20",
    );
  } finally {
    f.repo.close();
  }
});
for (const mode of [
  "both",
  "hash",
  "evidence-hash",
  "duplicate-proof",
  "key",
  "no-d8",
  "window",
  "extra",
  "too-many",
])
  test(`SA-01 invalid config ${mode} creates no tables`, () => {
    const c = partialConfig();
    if (mode === "both") c.postClose = postCloseConfig().postClose;
    if (mode === "hash") c.partialSettlement.contractHash = "0".repeat(64);
    if (mode === "evidence-hash")
      c.partialSettlement.evidenceHash = "0".repeat(64);
    if (mode === "duplicate-proof")
      c.partialSettlement.evidence.push(c.partialSettlement.evidence[0]!);
    if (mode === "key")
      c.partialSettlement.evidence[0]!.sourceEventKey = hash("wrong");
    if (mode === "no-d8") Reflect.deleteProperty(c, "finalization");
    if (mode === "window")
      c.partialSettlement.followupEndExclusive = c.operating.periodEnd;
    if (mode === "extra") Reflect.set(c.partialSettlement, "live", true);
    if (mode === "too-many")
      c.partialSettlement.evidence = Array.from(
        { length: partialSettlementEventLimit + 1 },
        () => c.partialSettlement.evidence[0]!,
      );
    if (["duplicate-proof", "key", "too-many"].includes(mode))
      c.partialSettlement.evidenceHash = hash(c.partialSettlement.evidence);
    const r = new Repository(":memory:", () => 1000);
    r.acquire();
    try {
      assert.throws(() => new CostReservationStore(r, c, { initialize: true }));
      assert.equal(
        r.db
          .prepare(
            "SELECT count(*) n FROM sqlite_master WHERE name LIKE 'cost_reservation_%'",
          )
          .get()!.n,
        0,
      );
    } finally {
      r.close();
    }
  });
test("SA-01/09 no legacy migration, old APIs blocked and original close remains recoverable", () => {
  const old = closedPostClose(),
    f = closedPartial();
  try {
    const before = dump(old.repo);
    assert.throws(
      () => new CostReservationStore(old.repo, partialConfig()),
      /CONFIG_MISMATCH/,
    );
    assert.deepEqual(dump(old.repo), before);
    const s = f.store.read();
    assert.throws(() =>
      f.store.settlePostClose("old", paymentCommand(old.store.read()), s),
    );
    assert.throws(() => f.store.postCloseReport(s.seed.clock));
    assert.throws(() => f.store.report());
    assert.throws(() => f.store.exportEvidence());
    assert.equal(reservationExposure(s).status, "HOLD");
    assert.throws(
      () => f.store.operating("new", op(s, "RECOGNIZE", "new"), s),
      /FINALIZED/,
    );
    const a = f.store.settlePartial("part", partialCommand(s), s);
    const restored = f.store.finalizeOperating(
      "close-retry",
      s.finalization!.checkpoint!.closeId,
      s.finalization!.checkpoint!.request,
      s,
    );
    assert.equal(restored.duplicate, true);
    assert.deepEqual(restored.current, a.current);
    assert.equal(
      restored.receipt.revision,
      s.finalization!.checkpoint!.appliedRevision,
    );
  } finally {
    old.repo.close();
    f.repo.close();
  }
});
test("SA-04 command, business and stable source identities prevent double payment", () => {
  const f = closedPartial();
  try {
    const s = f.store.read(),
      e = partialCommand(s),
      a = f.store.settlePartial("part", e, s),
      before = dump(f.repo);
    assert.deepEqual(f.store.settlePartial("part", e, s).receipt, a.receipt);
    const dup = f.store.settlePartial(
      "alias",
      {
        ...e,
        businessEventId: "other",
        receivedAt: e.receivedAt + 1,
        postedAt: e.postedAt + 1,
      },
      s,
    );
    assert.equal(dup.originalCommandId, "part");
    assert.equal(dup.originalBusinessEventId, e.businessEventId);
    assert.equal(dup.duplicate, true);
    assert.deepEqual(dump(f.repo), before);
    assert.throws(() =>
      f.store.settlePartial(
        "integer-format-alias",
        { ...e, payable: "20.0" },
        a.current,
      ),
    );
    assert.deepEqual(dump(f.repo), before);
    assert.throws(
      () =>
        f.store.settlePartial("part", { ...e, postedAt: e.postedAt + 1 }, s),
      /ID_CONFLICT/,
    );
    assert.throws(
      () => f.store.settlePartial("bad", { ...e, payable: "21" }, a.current),
      /CONFLICT/,
    );
    assert.throws(
      () =>
        f.store.settlePartial(
          "bad-source",
          { ...e, sourceHash: hash("changed") },
          a.current,
        ),
      /CONFLICT/,
    );
    const e2 = partialCommand(a.current, 1);
    assert.throws(
      () =>
        f.store.settlePartial(
          "cross",
          { ...e2, businessEventId: e.businessEventId },
          a.current,
        ),
      /CONFLICT/,
    );
    const b = f.store.settlePartial("rest", e2, a.current);
    assert.throws(
      () =>
        f.store.settlePartial(
          "cross-two",
          { ...e, businessEventId: e2.businessEventId },
          b.current,
        ),
      /CONFLICT/,
    );
    assert.equal(
      f.store.settlePartial(
        "alias-after",
        {
          ...e,
          businessEventId: "new",
          postedAt: f.c.partialSettlement.followupEndExclusive + 1,
        },
        s,
      ).duplicate,
      true,
    );
  } finally {
    f.repo.close();
  }
});
test("SA-04 equal amount separate source payments are not deduplicated", () => {
  const f = closedPartial(":memory:", "40", ["20", "20"]);
  try {
    let s = f.store.read();
    for (let i = 0; i < 2; i++)
      s = f.store.settlePartial(`p${i}`, partialCommand(s, i), s).current;
    assert.equal(s.partialSettlement!.events.length, 2);
    assert.equal(s.handoff!.accounts.KRW.payable, "0");
  } finally {
    f.repo.close();
  }
});
for (const change of [
  "negative",
  "zero",
  "extra",
  "unknown-source",
  "currency",
  "scope",
  "target",
  "original",
  "close",
  "preclose",
  "rewind",
  "end",
  "availability",
  "oversize",
  "cumulative",
])
  test(`SA-03/07 unsupported ${change} leaves financial rows and clock unchanged`, () => {
    const f = closedPartial();
    try {
      const s = f.store.read(),
        e = structuredClone(partialCommand(s)),
        before = dump(f.repo);
      if (change === "negative") e.payable = "-1";
      if (change === "zero") e.payable = "0";
      if (change === "extra") Reflect.set(e, "deltaEquity", "1");
      if (change === "unknown-source")
        e.sourceEventKey = hash("not-in-fixture");
      if (change === "currency") Reflect.set(e, "currency", "USD");
      if (change === "scope") e.sourceScope.account = "another";
      if (change === "target") e.targetKey = hash("unknown");
      if (change === "original") e.originalHash = hash("changed");
      if (change === "close") e.closeId = "another";
      if (change === "preclose") e.occurredAt = s.seed.clock - 1;
      if (change === "rewind") e.postedAt = s.seed.clock - 1;
      if (change === "end")
        e.postedAt = f.c.partialSettlement.followupEndExclusive;
      if (change === "availability") e.availableAt = e.occurredAt - 1;
      if (change === "oversize") e.payable = "1".repeat(102);
      if (change === "cumulative") e.payable = "50";
      assert.throws(() => f.store.settlePartial("bad", e, s));
      assert.deepEqual(dump(f.repo), before);
    } finally {
      f.repo.close();
    }
  });
test("SA-03/05 pinned overpayment cannot be truncated after stale refresh", () => {
  const f = closedPartial(":memory:", "100", ["60", "60"]);
  try {
    const s = f.store.read(),
      a = f.store.settlePartial("a", partialCommand(s), s),
      e = partialCommand(s, 1),
      before = dump(f.repo);
    assert.throws(() => f.store.settlePartial("b", e, s), /REAPPROVAL/);
    assert.throws(
      () => f.store.settlePartial("b", e, a.current),
      /REMAINDER_EXCEEDED/,
    );
    assert.deepEqual(dump(f.repo), before);
    assert.equal(
      a.current.partialSettlement!.progress[0]!.remainingPayable,
      "40",
    );
  } finally {
    f.repo.close();
  }
});
test("SA-03 zero original target needs explicit proof exactly once", () => {
  const f = closedPartial(":memory:", "0", ["0", "0"]);
  try {
    const s = f.store.read(),
      a = f.store.settlePartial("zero", partialCommand(s), s);
    assert.equal(a.current.partialSettlement!.progress[0]!.status, "SETTLED");
    assert.equal(
      a.current.handoff!.accounts.KRW.cash,
      s.handoff!.accounts.KRW.cash,
    );
    assert.throws(
      () =>
        f.store.settlePartial("zero2", partialCommand(a.current, 1), a.current),
      /REMAINDER_EXCEEDED/,
    );
  } finally {
    f.repo.close();
  }
});
test("SA-06/07 two partial slots plus final survive 100 raw inputs and reopening", () => {
  const f = closedPartial(":memory:", "50", ["10", "10", "5", "30"]);
  try {
    let s = f.store.read();
    for (let i = 0; i < 100; i++)
      s = f.store.postCloseInput(`raw-${i}`, "{}", s.seed.clock, s).current;
    for (let i = 0; i < 2; i++)
      s = f.store.settlePartial(`part-${i}`, partialCommand(s, i), s).current;
    const reopened = new CostReservationStore(f.repo, f.c),
      before = dump(f.repo);
    assert.throws(
      () => reopened.settlePartial("third-part", partialCommand(s, 2), s),
      /TERMINATION_SLOT/,
    );
    assert.throws(
      () => reopened.postCloseInput("raw-over", "{}", s.seed.clock, s),
      /INPUT_LIMIT/,
    );
    assert.deepEqual(dump(f.repo), before);
    const a = reopened.settlePartial("final", partialCommand(s, 3), s).current;
    assert.equal(a.partialSettlement!.events.length, 3);
    assert.equal(a.partialSettlement!.progress[0]!.status, "SETTLED");
    assert.equal(a.finalization!.status, "RECONCILING");
    assert.ok(
      a.handoff!.admissionHolds.includes("POST_CLOSE_RECONCILIATION_REQUIRED"),
    );
  } finally {
    f.repo.close();
  }
});
test("SA-07 out of order source facts, equal posting clock and end report preserve residuals", () => {
  const f = closedPartial();
  try {
    const s = f.store.read(),
      end = f.c.partialSettlement.followupEndExclusive;
    assert.throws(
      () => f.store.postCloseInput("future", "{}", end, s),
      /TIME_INVALID/,
    );
    let a = f.store.postCloseInput("near-end", "{}", end - 1, s).current;
    a = f.store.settlePartial("later-source", partialCommand(a, 1), a).current;
    const report = f.store.partialSettlementReport(end + 100);
    assert.equal(report.observationEnded, true);
    assert.equal(report.targets[0]!.remainingPayable, "20");
    a = f.store.settlePartial(
      "earlier-source",
      partialCommand(a, 0),
      a,
    ).current;
    assert.equal(a.seed.clock, end - 1);
    assert.equal(a.partialSettlement!.events.length, 2);
  } finally {
    f.repo.close();
  }
});
test("SA-05/08 lease expiry inside commit rolls back; takeover fences old writer and retains receipt", () => {
  let clock = 1000,
    armed = false;
  const path = join(
    mkdtempSync(join(tmpdir(), "partial-epoch-")),
    "test.sqlite",
  );
  const c = partialConfig(),
    r = new Repository(path, () => clock);
  r.acquire();
  const store = new CostReservationStore(r, c, {
    initialize: true,
    testStage: (stage) => {
      if (armed && stage === "AUDIT") clock = 11000;
    },
  });
  let other: Repository | undefined;
  try {
    record(store, op(store.read(), "RECOGNIZE", "cost"));
    const s = finishPostClose({ repo: r, store, c }).current,
      e = partialCommand(s),
      rows = dump(r);
    armed = true;
    assert.throws(() => store.settlePartial("p", e, s), /FENCED_WRITER/);
    assert.deepEqual(dump(r), rows);
    other = new Repository(path, () => 20000);
    other.acquire();
    const second = new CostReservationStore(other, c),
      a = second.settlePartial("p", e, s);
    assert.equal(a.duplicate, false);
    assert.throws(() => store.settlePartial("p", e, s), /FENCED_WRITER/);
    other.close();
    other = new Repository(path, () => 40000);
    other.acquire();
    const third = new CostReservationStore(other, c);
    assert.deepEqual(third.settlePartial("p", e, s).receipt, a.receipt);
  } finally {
    other?.close();
    r.close();
  }
});
for (const field of [
  "basis",
  "progress",
  "evidence",
  "events",
  "checkpoint",
  "command",
  "audit",
  "fill-index",
])
  test(`SA-09 ${field} tampering rejected by complete replay`, () => {
    const f = closedPartial();
    try {
      const s = f.store.read();
      f.store.settlePartial("part", partialCommand(s), s);
      if (field === "command")
        f.repo.db.exec(
          "UPDATE cost_reservation_commands SET input_hash='broken' WHERE id='part'",
        );
      else if (field === "audit")
        f.repo.db.exec("UPDATE audit SET checksum='broken' WHERE seq=1");
      else if (field === "fill-index")
        f.repo.db.exec(
          "INSERT INTO cost_reservation_fills VALUES('fake','fake','fake','fake')",
        );
      else {
        const row = f.repo.db
            .prepare("SELECT body FROM cost_reservation_run")
            .get()!,
          state = JSON.parse(String(row.body));
        if (field === "basis")
          state.partialSettlement.basis.accounts.KRW.cash = "1";
        if (field === "progress")
          state.partialSettlement.progress[0].remainingPayable = "0";
        if (field === "evidence")
          state.partialSettlement.options.evidence[0].payable = "99";
        if (field === "events")
          state.partialSettlement.events[0].command.sourceEventKey =
            hash("changed");
        if (field === "checkpoint")
          state.finalization.checkpoint.appliedLossStreak = 999;
        f.repo.db
          .prepare("UPDATE cost_reservation_run SET body=?,checksum=?")
          .run(JSON.stringify(state), hash(state));
      }
      assert.throws(() => f.store.read());
      assert.throws(() => f.store.partialSettlementReport(s.seed.clock + 1000));
    } finally {
      f.repo.close();
    }
  });
test("SA-10 detached exact fractional projection and normalization do not change global precision", () => {
  const f = closedPartial();
  try {
    const precision = Decimal.precision,
      s = f.store.read(),
      m = s.partialSettlement!,
      b = m.basis!,
      tiny = "0." + "0".repeat(39) + "1",
      large = "9".repeat(60);
    const target = {
      kind: "SETTLE_CLOSED_FILL" as const,
      target: {
        runId: "r",
        fillId: "f",
        postingKey: hash("p"),
        identityHash: hash("i"),
        originalHash: hash("o"),
        receivable: tiny,
        payable: "0",
      },
    };
    b.targets = [target];
    b.operating = { incurredKrw: "0", paidKrw: "0", payableKrw: "0" };
    b.accounts.KRW = {
      ...b.accounts.KRW,
      cash: large,
      receivable: tiny,
      payable: "0",
      availableCash: large,
    };
    m.options.evidence = [
      {
        kind: "SETTLE_PARTIAL_TARGET",
        target: partialTargetReference(target),
        receivable: tiny,
        payable: "0.0",
        sourceEventKey: partialSourceEventKey(m.sourceScope, "x", "1"),
        sourceHash: hash("x"),
        paymentId: "x",
        lineId: "1",
        occurredAt: s.seed.clock + 1,
      },
    ];
    m.options.evidenceHash = hash(m.options.evidence);
    projectPartialSettlement(s);
    const e = partialCommand(s),
      a = applyPartialSettlement(s, e, s.epoch);
    assert.equal(
      a.handoff!.accounts.KRW.cash,
      large + "." + "0".repeat(39) + "1",
    );
    assert.equal(a.partialSettlement!.progress[0]!.remainingReceivable, "0");
    assert.equal(Decimal.precision, precision);
    assert.equal(postCloseTargetKey(target), e.targetKey);
  } finally {
    f.repo.close();
  }
});

// Detached arithmetic fixtures deliberately replace the close basis. They are
// not evidence that a Store accepts fabricated or maximum-size persisted runs.
function detachedFill(
  receivable: string,
  payable: string,
  parts: { receivable: string; payable: string }[],
  cash = "1000",
) {
  const f = closedPartial();
  try {
    const s = f.store.read(),
      m = s.partialSettlement!,
      b = m.basis!;
    b.targets = [
      {
        kind: "SETTLE_CLOSED_FILL",
        target: {
          runId: "r",
          fillId: "f",
          postingKey: hash("p"),
          identityHash: hash("i"),
          originalHash: hash("o"),
          receivable,
          payable,
        },
      },
    ];
    b.operating = { incurredKrw: "0", paidKrw: "0", payableKrw: "0" };
    const Exact = Decimal.clone({ precision: 128 });
    b.accounts.KRW = {
      ...b.accounts.KRW,
      cash,
      receivable,
      payable,
      availableCash: new Exact(cash).minus(payable).toFixed(),
    };
    m.options.evidence = partialConfig(
      parts.map((part) => ({
        ...part,
        target: { kind: "FILL", runId: "r", fillId: "f" },
      })),
    ).partialSettlement.evidence;
    m.options.evidenceHash = hash(m.options.evidence);
    projectPartialSettlement(s);
    return s;
  } finally {
    f.repo.close();
  }
}
for (const example of [
  {
    r: "100",
    p: "0",
    parts: [
      { receivable: "99", payable: "0" },
      { receivable: "1", payable: "0" },
    ],
    firstCash: "1099",
    firstR: "1",
    firstP: "0",
    finalCash: "1100",
  },
  {
    r: "0",
    p: "0.4",
    parts: [
      { receivable: "0", payable: "0.1" },
      { receivable: "0", payable: "0.3" },
    ],
    firstCash: "999.9",
    firstR: "0",
    firstP: "0.3",
    finalCash: "999.6",
  },
])
  test(`SA-02 independent detached ${example.r}/${example.p} partial arithmetic`, () => {
    let s = detachedFill(example.r, example.p, example.parts);
    const old = history(s);
    s = applyPartialSettlement(s, partialCommand(s), s.epoch);
    assert.deepEqual(
      [
        s.handoff!.accounts.KRW.cash,
        s.handoff!.accounts.KRW.receivable,
        s.handoff!.accounts.KRW.payable,
      ],
      [example.firstCash, example.firstR, example.firstP],
    );
    s = applyPartialSettlement(s, partialCommand(s, 1), s.epoch);
    assert.deepEqual(
      [
        s.handoff!.accounts.KRW.cash,
        s.handoff!.accounts.KRW.receivable,
        s.handoff!.accounts.KRW.payable,
      ],
      [example.finalCash, "0", "0"],
    );
    assert.deepEqual(history(s), old);
  });
test("SA-10 cash result exceeding 60 digits is rejected without changing input", () => {
  const s = detachedFill(
      "1",
      "0",
      [{ receivable: "1", payable: "0" }],
      "9".repeat(60),
    ),
    before = structuredClone(s);
  assert.throws(
    () => applyPartialSettlement(s, partialCommand(s), s.epoch),
    /PARTIAL_AMOUNT_BOUNDS/,
  );
  assert.deepEqual(s, before);
});
test("SA-06/10 detached maximum M and 3M events reserve final slot and preserve exact totals", () => {
  const s = detachedFill("3", "0", [{ receivable: "1", payable: "0" }]);
  const m = s.partialSettlement!,
    b = m.basis!,
    original = b.targets[0]!,
    template = partialCommand(s),
    count = partialSettlementEventLimit / 3;
  assert.equal(original.kind, "SETTLE_CLOSED_FILL");
  if (original.kind !== "SETTLE_CLOSED_FILL") throw Error("TEST_FILL");
  b.targets = Array.from({ length: count }, (_, i) => ({
    ...original,
    target: {
      ...original.target,
      fillId: `f${i}`,
      originalHash: hash(`o${i}`),
    },
  }));
  b.accounts.KRW.receivable = String(BigInt(count) * 3n);
  m.options.evidence = [];
  m.events = [];
  for (const target of b.targets)
    for (let part = 0; part < 3; part++) {
      const i = m.events.length,
        paymentId = `payment${i}`;
      const proof = {
        kind: "SETTLE_PARTIAL_TARGET" as const,
        target: partialTargetReference(target),
        receivable: "1",
        payable: "0",
        sourceEventKey: partialSourceEventKey(m.sourceScope, paymentId, "1"),
        sourceHash: hash(paymentId),
        occurredAt: template.occurredAt,
        paymentId,
        lineId: "1",
      };
      m.options.evidence.push(proof);
      m.events.push({
        command: {
          ...template,
          target: proof.target,
          sourceEventKey: proof.sourceEventKey,
          sourceHash: proof.sourceHash,
          targetKey: postCloseTargetKey(target),
          originalHash: target.target.originalHash,
          businessEventId: `event${i}`,
        },
        appliedRevision: b.revision + i + 1,
      });
    }
  m.options.evidenceHash = hash(m.options.evidence);
  const precision = Decimal.precision;
  projectPartialSettlement(s);
  assert.equal(m.events.length, 15900);
  assert.equal(m.progress.length, 5300);
  assert.ok(
    m.progress.every(
      (p) =>
        p.status === "SETTLED" &&
        p.partialCount === 2 &&
        p.remainingReceivable === "0",
    ),
  );
  assert.equal(
    s.handoff!.accounts.KRW.cash,
    String(1000n + BigInt(count) * 3n),
  );
  assert.equal(s.handoff!.accounts.KRW.receivable, "0");
  assert.equal(Decimal.precision, precision);
  const extraTarget = structuredClone(s);
  extraTarget.partialSettlement!.basis!.targets.push(original);
  assert.throws(
    () => projectPartialSettlement(extraTarget),
    /PARTIAL_EVENT_LIMIT/,
  );
  m.events.push(structuredClone(m.events[0]!));
  assert.throws(() => projectPartialSettlement(s), /PARTIAL_EVENT_LIMIT/);
});

// IDs/amounts for real Store trade tests are pinned from a separate D9 fixture;
// acceptance amounts are checked independently below, not copied as expectations.
for (const price of ["10022", "0.000001"])
  test(`SA-02 actual closed trade partial settlements at ${price}`, () => {
    const reference = openedOperating(postCloseConfig());
    try {
      const run = beginTrade(reference.store);
      fillTrade(reference.store, run);
      closeTrade(reference.store, run, price);
      const base = finishPostClose(reference).current;
      const Exact = Decimal.clone({ precision: 128 });
      const plan = base.postClose!.basis!.targets.flatMap((t) => {
        assert.equal(t.kind, "SETTLE_CLOSED_FILL");
        if (t.kind !== "SETTLE_CLOSED_FILL") throw Error("TEST_FILL");
        return ["0.25", "0.75"].map((fraction) => ({
          target: partialTargetReference(t),
          receivable: new Exact(t.target.receivable).mul(fraction).toFixed(),
          payable: new Exact(t.target.payable).mul(fraction).toFixed(),
        }));
      });
      const c = partialConfig(plan),
        f = openedOperating(c);
      try {
        const actual = beginTrade(f.store);
        assert.equal(actual, run);
        fillTrade(f.store, actual);
        closeTrade(f.store, actual, price);
        let s = finishPostClose(f).current;
        const old = history(s),
          a = s.handoff!.accounts.KRW,
          equity = new Exact(a.cash).plus(a.receivable).minus(a.payable);
        for (let i = 0; i < plan.length; i++) {
          const event = partialCommand(s, i),
            first = f.store.settlePartial(`p${i}`, event, s);
          s = first.current;
          const normalized = {
            ...event,
            payable: event.payable.includes(".")
              ? `${event.payable}0`
              : `${event.payable}.0`,
          };
          assert.deepEqual(
            f.store.settlePartial(`alias${i}`, normalized, s).receipt,
            first.receipt,
          );
          assert.throws(
            () => f.store.settlePartial(`p${i}`, normalized, s),
            /ID_CONFLICT/,
          );
          const v = s.handoff!.accounts.KRW;
          assert.equal(
            new Exact(v.cash).plus(v.receivable).minus(v.payable).toFixed(),
            equity.toFixed(),
          );
        }
        assert.equal(s.handoff!.accounts.KRW.cash, equity.toFixed());
        assert.equal(s.handoff!.accounts.KRW.payable, "0");
        assert.equal(s.handoff!.accounts.KRW.receivable, "0");
        assert.deepEqual(history(s), old);
      } finally {
        f.repo.close();
      }
    } finally {
      reference.repo.close();
    }
  });
