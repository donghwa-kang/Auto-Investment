import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal } from "../src/core/math.js";
import { hash } from "../src/core/policy.js";
import {
  applyPostClose,
  initializePostClose,
  postCloseContractHash,
  postCloseTargetLimit,
  projectPostClose,
} from "../src/core/cost-post-close.js";
import { applyFinalization } from "../src/core/cost-finalization.js";
import { reservationExposure } from "../src/core/cost-reservation.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { Repository } from "../src/server/repository.js";
import {
  finalizationConfig,
  closedFixture,
} from "./cost-finalization-helpers.js";
import { openedOperating, op, record } from "./cost-operating-helpers.js";
import {
  closedPostClose,
  postCloseConfig,
  finishPostClose,
  paymentCommand,
  targetCommand,
} from "./cost-post-close-helpers.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";
import { beginTrade, fillTrade, closeTrade } from "./cost-outcome-helpers.js";
const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "post-close-")), "fixture.sqlite");
const dump = (r: Repository) => ({
  data: dumpHandoff(r),
  writer: r.db.prepare("SELECT * FROM writer").all(),
});

test("PC-01 initial read, config, command and report objects cannot mutate the Store", () => {
  const config = postCloseConfig(),
    f = openedOperating(config);
  try {
    const before = f.store.read(),
      rows = dump(f.repo);
    const output = f.store.read();
    output.postClose!.sourceScope.account = "consumer-copy-only";
    output.postClose!.options.followupEndExclusive++;
    config.sourceScope.account = "constructor-input-only";
    assert.deepEqual(f.store.read(), before);
    assert.deepEqual(dump(f.repo), rows);

    const directConfig = postCloseConfig(),
      untouched = structuredClone(directConfig);
    const detached = structuredClone(before);
    initializePostClose(detached, directConfig);
    detached.postClose!.sourceScope.account = "direct-output-only";
    assert.deepEqual(directConfig, untouched);

    // The fixture author builds its manifest from the original configuration.
    config.sourceScope = structuredClone(before.postClose!.sourceScope);
    record(f.store, op(f.store.read(), "RECOGNIZE", "cost"));
    const closed = finishPostClose(f).current,
      command = paymentCommand(closed);
    const result = f.store.settlePostClose("pay", command, closed);
    const expected = f.store.read(),
      stored = dump(f.repo);
    const report = f.store.postCloseReport(expected.seed.clock);
    command.sourceScope.account = "command-input-only";
    command.target.originalHash = hash("changed-after-submit");
    closed.postClose!.sourceScope.account = "expected-input-only";
    result.current.handoff!.accounts.KRW.cash = "0";
    report.accounts.KRW.cash = "0";
    report.targets[0]!.target.originalHash = hash("changed-report");
    assert.deepEqual(f.store.read(), expected);
    assert.deepEqual(dump(f.repo), stored);
  } finally {
    f.repo.close();
  }
});

test("PC-01 explicit new D9 config; legacy D8 snapshots remain identical and deny D9", () => {
  const f = openedOperating(finalizationConfig());
  try {
    const s = finishPostClose(f).current,
      before = dump(f.repo);
    assert.equal(s.postClose, undefined);
    assert.throws(
      () => new CostReservationStore(f.repo, postCloseConfig()),
      /CONFIG_MISMATCH/,
    );
    assert.deepEqual(dump(f.repo), before);
  } finally {
    f.repo.close();
  }
  for (const mode of ["hash", "window", "no-d8", "extra"] as const) {
    const c = postCloseConfig();
    if (mode === "hash") c.postClose.contractHash = "0".repeat(64);
    if (mode === "window")
      c.postClose.followupEndExclusive = c.operating.periodEnd;
    if (mode === "no-d8") Reflect.deleteProperty(c, "finalization");
    if (mode === "extra") Reflect.set(c.postClose, "liveEnabled", true);
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
  }
});
for (const value of ["50", "0"])
  test(`PC-02 next-day full operating payment ${value} never reapplies cost`, () => {
    const f = closedPostClose(":memory:", value);
    try {
      const s = f.store.read(),
        e = paymentCommand(s),
        result = f.store.settlePostClose("pay", e, s);
      assert.equal(result.duplicate, false);
      const after = result.current;
      assert.equal(
        after.handoff!.accounts.KRW.cash,
        new Decimal(s.handoff!.accounts.KRW.cash).minus(value).toString(),
      );
      assert.equal(after.handoff!.accounts.KRW.payable, "0");
      assert.equal(
        after.handoff!.accounts.KRW.availableCash,
        s.handoff!.accounts.KRW.availableCash,
      );
      assert.deepEqual(after.finalization, s.finalization);
      assert.deepEqual(after.operating, s.operating);
      assert.deepEqual(after.book.sources, s.book.sources);
      assert.equal(after.seed.ledger.lossStreak, s.seed.ledger.lossStreak);
      assert.equal(after.postClose!.currentOperating!.paidKrw, value);
      assert.equal(after.postClose!.currentOperating!.incurredKrw, value);
      assert.equal(
        f.store.postCloseReport(after.seed.clock).unresolvedCount,
        0,
      );
    } finally {
      f.repo.close();
    }
  });

for (const price of ["10022", "0.000001"])
  test(`PC-03 actual trade postings settle exactly including SELL deficit at ${price}`, () => {
    const f = openedOperating(postCloseConfig());
    try {
      const run = beginTrade(f.store);
      fillTrade(f.store, run);
      closeTrade(f.store, run, price);
      const s = finishPostClose(f).current;
      assert.equal(s.postClose!.basis!.targets.length, 2);
      const base = s.handoff!.accounts.KRW,
        equity = new Decimal(base.cash)
          .plus(base.receivable)
          .minus(base.payable)
          .toString();
      const targets = s.postClose!.basis!.targets;
      if (price === "0.000001")
        assert.ok(
          targets.every(
            (t) =>
              t.kind === "SETTLE_CLOSED_FILL" && t.target.receivable === "0",
          ),
        );
      let state = s;
      for (const [i, t] of targets.entries()) {
        state = f.store.settlePostClose(
          `settle-${i}`,
          targetCommand(state, t, `s-${i}`, state.seed.clock + 1),
          state,
        ).current;
        const a = state.handoff!.accounts.KRW;
        assert.equal(
          new Decimal(a.cash).plus(a.receivable).minus(a.payable).toString(),
          equity,
        );
        assert.deepEqual(
          state.finalization!.checkpoint,
          s.finalization!.checkpoint,
        );
      }
      assert.equal(state.handoff!.accounts.KRW.cash, equity);
      assert.equal(state.handoff!.accounts.KRW.payable, "0");
      assert.equal(state.handoff!.accounts.KRW.receivable, "0");
      assert.deepEqual(state.book.sources, s.book.sources);
    } finally {
      f.repo.close();
    }
  });

test("PC-03/13 bounded pure projection preserves 60+40 digits and maximum target count", () => {
  const f = closedPostClose();
  try {
    const s = f.store.read(),
      b = s.postClose!.basis!,
      large = "1" + "0".repeat(59),
      tiny = "0." + "0".repeat(39) + "1";
    const Exact = Decimal.clone({ precision: 128 });
    b.targets = Array.from({ length: postCloseTargetLimit }, (_, i) => ({
      kind: "SETTLE_CLOSED_FILL" as const,
      target: {
        runId: `r${i}`,
        fillId: `f${i}`,
        postingKey: hash(i),
        identityHash: hash(i),
        originalHash: hash(i),
        receivable: tiny,
        payable: "0",
      },
    }));
    const total = new Exact(tiny).mul(postCloseTargetLimit).toFixed();
    b.accounts.KRW = {
      ...b.accounts.KRW,
      cash: large,
      receivable: total,
      payable: "0",
      availableCash: large,
    };
    const beforePrecision = Decimal.precision;
    // Constructed detached state: this checks arithmetic bounds, NOT Store authentication or max-history load.
    s.postClose!.events = b.targets.map((t, i) =>
      targetCommand(s, t, `e${i}`, s.seed.clock + 1),
    );
    projectPostClose(s);
    assert.equal(
      s.handoff!.accounts.KRW.cash,
      new Exact(large).plus(total).toFixed(),
    );
    assert.equal(s.handoff!.accounts.KRW.receivable, "0");
    assert.equal(Decimal.precision, beforePrecision);
  } finally {
    f.repo.close();
  }
});

test("PC-04 full request and business dedup differ; consumed target cannot be paid again", () => {
  const f = closedPostClose();
  try {
    const s = f.store.read(),
      e = paymentCommand(s),
      first = f.store.settlePostClose("pay", e, s),
      rows = dump(f.repo);
    assert.equal(f.store.settlePostClose("pay", e, s).duplicate, true);
    const delivery = {
      ...e,
      receivedAt: e.receivedAt + 1,
      postedAt: f.c.postClose.followupEndExclusive + 1,
    };
    const again = f.store.settlePostClose("new-delivery", delivery, s);
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.receipt, first.receipt);
    assert.throws(
      () => f.store.settlePostClose("pay", delivery, s),
      /LOCAL_COMMAND_ID_CONFLICT/,
    );
    assert.throws(
      () =>
        f.store.settlePostClose(
          "mutated",
          { ...e, sourceHash: hash("wrong") },
          first.current,
        ),
      /BUSINESS_CONFLICT/,
    );
    assert.throws(
      () =>
        f.store.settlePostClose(
          "another",
          { ...e, businessEventId: "another" },
          first.current,
        ),
      /TARGET_ALREADY_SETTLED/,
    );
    assert.deepEqual(dump(f.repo), rows);
  } finally {
    f.repo.close();
  }
});

test("PC-05 distinct targets require refreshed expected state and apply once each", () => {
  const f = openedOperating(postCloseConfig());
  try {
    for (const name of ["a", "b"])
      record(f.store, op(f.store.read(), "RECOGNIZE", name, "5", name));
    const s = finishPostClose(f).current,
      a = paymentCommand(s, 0),
      b = paymentCommand(s, 1);
    const first = f.store.settlePostClose("pay-a", a, s);
    const before = dump(f.repo);
    assert.throws(() => f.store.settlePostClose("pay-b", b, s), /REAPPROVAL/);
    assert.deepEqual(dump(f.repo), before);
    const last = f.store.settlePostClose("pay-b", b, first.current);
    assert.equal(last.current.postClose!.currentOperating!.paidKrw, "10");
    assert.equal(last.current.postClose!.events.length, 2);
  } finally {
    f.repo.close();
  }
});

for (const mode of [
  "partial",
  "extra",
  "unknown",
  "currency",
  "scope",
  "close",
  "hash",
  "preclose",
  "future",
  "order",
  "metadata",
  "oversize",
] as const)
  test(`PC-06/07 unsupported ${mode} leaves all rows unchanged`, () => {
    const f = closedPostClose();
    try {
      const s = f.store.read(),
        e = paymentCommand(s),
        raw: Record<string, unknown> = structuredClone(e),
        before = dump(f.repo);
      if (mode === "partial" || mode === "extra")
        raw.target = {
          ...e.target,
          amountKrw: mode === "partial" ? "49" : "51",
        };
      if (mode === "unknown")
        raw.target = { ...e.target, obligationId: "missing" };
      if (mode === "currency") raw.currency = "USD";
      if (mode === "scope")
        raw.sourceScope = { ...e.sourceScope, account: "wrong" };
      if (mode === "close") raw.closeId = "wrong";
      if (mode === "hash") raw.checkpointHash = hash("wrong");
      if (mode === "preclose")
        raw.occurredAt = s.finalization!.checkpoint!.appliedAt - 1;
      if (mode === "future") raw.postedAt = f.c.postClose.followupEndExclusive;
      if (mode === "order") raw.receivedAt = e.occurredAt - 1;
      if (mode === "metadata") raw.liveEnabled = true;
      if (mode === "oversize") raw.businessEventId = "x".repeat(8193);
      assert.throws(() => f.store.settlePostClose("bad", raw, s));
      assert.deepEqual(dump(f.repo), before);
    } finally {
      f.repo.close();
    }
  });

test("PC-07 raw time poison is rejected; near-end raw permits equal-clock late payment", () => {
  const f = closedPostClose();
  try {
    const s = f.store.read(),
      end = f.c.postClose.followupEndExclusive,
      before = dump(f.repo);
    assert.throws(
      () => f.store.postCloseInput("future", "{}", end, s),
      /POST_CLOSE_TIME_INVALID/,
    );
    assert.throws(
      () =>
        applyFinalization(
          s,
          f.c,
          [],
          { kind: "POST_CLOSE_INPUT", rawJson: "{}", observedAt: end },
          s.epoch,
        ),
      /POST_CLOSE_TIME_INVALID/,
    );
    assert.deepEqual(dump(f.repo), before);
    const held = f.store.postCloseInput("near", "{}", end - 1, s).current;
    const e = { ...paymentCommand(s), postedAt: end - 1 };
    const result = f.store.settlePostClose("pay", e, held).current;
    assert.equal(result.finalization!.status, "RECONCILING");
    assert.equal(result.handoff!.accounts.KRW.payable, "0");
    assert.deepEqual(
      result.handoff!.admissionHolds,
      held.handoff!.admissionHolds,
    );
    assert.equal(f.store.postCloseReport(end).observationEnded, true);
  } finally {
    f.repo.close();
  }
});

test("PC-07 out-of-order occurred times keep facts and monotonic posting times", () => {
  const f = openedOperating(postCloseConfig());
  try {
    for (const name of ["a", "b"])
      record(f.store, op(f.store.read(), "RECOGNIZE", name, "5", name));
    const s = finishPostClose(f).current,
      a = paymentCommand(s, 0, "a", s.seed.clock + 20),
      b = paymentCommand(s, 1, "b", s.seed.clock + 10);
    const next = f.store.settlePostClose("pay-a", a, s).current;
    const after = f.store.settlePostClose(
      "pay-b",
      { ...b, postedAt: a.postedAt },
      next,
    ).current;
    assert.equal(after.postClose!.events[1]!.occurredAt, b.occurredAt);
    assert.equal(after.seed.clock, a.postedAt);
  } finally {
    f.repo.close();
  }
});

test("PC-08/14 report beyond window preserves pending; legacy report/export reject D9", () => {
  const f = closedPostClose();
  try {
    const s = f.store.read(),
      rows = dump(f.repo);
    const report = f.store.postCloseReport(
      f.c.postClose.followupEndExclusive + 86400000,
    );
    assert.equal(report.unresolvedCount, 1);
    assert.equal(report.accounts.KRW.payable, "50");
    assert.equal(report.targets[0]!.dueAt, null);
    assert.equal(report.status, "HOLD");
    assert.equal(report.learningAllowed, false);
    assert.equal(report.orderSubmissionAllowed, false);
    assert.throws(() => f.store.report(), /REQUIRES_OUTCOME_V3/);
    assert.throws(() => f.store.exportEvidence(), /V3_REQUIRED/);
    assert.throws(
      () => f.store.operating("old-pay", op(s, "PAY", "pay"), s),
      /FINALIZED_FINANCIAL_MUTATION_BLOCKED/,
    );
    assert.deepEqual(dump(f.repo), rows);
    const paid = f.store.settlePostClose("pay", paymentCommand(s), s);
    assert.deepEqual(reservationExposure(paid.current), {
      status: "HOLD",
      reasons: ["POST_CLOSE_REPORT_REQUIRED"],
      orderSubmissionAllowed: false,
      learningAllowed: false,
      liveEnabled: false,
    });
    const close = f.store.finalizeOperating(
      "retry-close",
      "period",
      s.finalization!.checkpoint!.request,
      s,
    );
    assert.deepEqual(close.current, paid.current);
    assert.equal(
      close.receipt.revision,
      s.finalization!.checkpoint!.appliedRevision,
    );
    assert.equal(
      close.current.seed.ledger.lossStreak,
      s.seed.ledger.lossStreak,
    );
    assert.notDeepEqual(dump(f.repo), rows);
  } finally {
    f.repo.close();
  }
});

test("PC-11 lease expiry rollback; new epoch restores original request receipt", () => {
  const path = fresh(),
    c = postCloseConfig();
  let now = 1000,
    armed = false;
  const r = new Repository(path, () => now);
  r.acquire();
  const store = new CostReservationStore(r, c, {
    initialize: true,
    testStage: (stage) => {
      if (armed && stage === "AUDIT") now = 11000;
    },
  });
  let other: Repository | undefined;
  try {
    record(store, op(store.read(), "RECOGNIZE", "cost"));
    const s = finishPostClose({ repo: r, store, c }).current,
      e = paymentCommand(s),
      rows = dump(r);
    armed = true;
    assert.throws(() => store.settlePostClose("pay", e, s), /FENCED_WRITER/);
    assert.deepEqual(dump(r), rows);
    other = new Repository(path, () => 20000);
    other.acquire();
    const second = new CostReservationStore(other, c),
      first = second.settlePostClose("pay", e, s);
    assert.equal(first.duplicate, false);
    assert.throws(() => store.settlePostClose("pay", e, s), /FENCED_WRITER/);
    other.close();
    other = new Repository(path, () => 40000);
    other.acquire();
    const third = new CostReservationStore(other, c),
      retry = third.settlePostClose("pay", e, s);
    assert.equal(retry.duplicate, true);
    assert.deepEqual(retry.receipt, first.receipt);
  } finally {
    other?.close();
    r.close();
  }
});

for (const area of [
  "basis",
  "checkpoint",
  "events",
  "accounts",
  "command",
  "audit",
  "fill-index",
] as const)
  test(`PC-12 ${area} tampering is rejected by complete replay`, () => {
    const f = openedOperating(postCloseConfig());
    try {
      closedFixture(f);
      const s = finishPostClose(f).current;
      const next = f.store.settlePostClose("pay", paymentCommand(s), s).current;
      if (area === "command")
        f.repo.db
          .prepare(
            "UPDATE cost_reservation_commands SET input_hash=? WHERE id='pay'",
          )
          .run(hash("bad"));
      else if (area === "audit")
        f.repo.db.exec(
          "UPDATE audit SET body='{}' WHERE seq=(SELECT max(seq) FROM audit)",
        );
      else if (area === "fill-index")
        f.repo.db.exec("DELETE FROM cost_reservation_fills");
      else {
        if (area === "basis") next.postClose!.basis!.targets = [];
        if (area === "checkpoint")
          next.finalization!.checkpoint!.appliedLossStreak++;
        if (area === "events") next.postClose!.events = [];
        if (area === "accounts") next.handoff!.accounts.KRW.cash = "1";
        f.repo.db
          .prepare("UPDATE cost_reservation_run SET body=?,checksum=?")
          .run(JSON.stringify(next), hash(next));
      }
      assert.throws(() => f.store.read(), /LOCAL_|AUDIT|HANDOFF_/);
    } finally {
      f.repo.close();
    }
  });

test(
  "PC-13 actual raw saturation keeps all M financial slots and cannot erase holds",
  { timeout: 120000 },
  () => {
    const f = openedOperating(postCloseConfig());
    try {
      for (let i = 0; i < 3; i++)
        record(
          f.store,
          op(f.store.read(), "RECOGNIZE", `cost-${i}`, `${i}`, `debt-${i}`),
        );
      const closed = finishPostClose(f).current;
      let state = closed;
      for (let i = 0; i < 100; i++)
        state = f.store.postCloseInput(
          `raw-${i}`,
          "{}",
          state.seed.clock,
          state,
        ).current;
      const before = dump(f.repo);
      assert.throws(
        () => f.store.postCloseInput("excess", "{}", state.seed.clock, state),
        /INPUT_LIMIT/,
      );
      assert.deepEqual(dump(f.repo), before);
      const held = state;
      for (let i = 0; i < 3; i++)
        state = f.store.settlePostClose(
          `pay-${i}`,
          paymentCommand(held, i),
          state,
        ).current;
      assert.equal(state.postClose!.events.length, 3);
      assert.equal(
        f.store.postCloseReport(state.seed.clock).unresolvedCount,
        0,
      );
      assert.deepEqual(
        state.finalization!.checkpoint,
        closed.finalization!.checkpoint,
      );
      assert.equal(state.finalization!.rejectedInputs.length, 100);
      assert.deepEqual(
        state.handoff!.admissionHolds,
        held.handoff!.admissionHolds,
      );
      const rows = dump(f.repo);
      assert.throws(
        () =>
          f.store.settlePostClose(
            "excess-pay",
            paymentCommand(held, 0, "new-business"),
            state,
          ),
        /TARGET_ALREADY_SETTLED/,
      );
      assert.equal(
        f.store.settlePostClose("retry", paymentCommand(held), held).duplicate,
        true,
      );
      assert.deepEqual(dump(f.repo), rows);
    } finally {
      f.repo.close();
    }
  },
);

test("PC-14 direct reducer never authorizes an unknown version or absent basis", () => {
  const f = closedPostClose();
  try {
    const s = f.store.read(),
      e = paymentCommand(s);
    delete s.postClose;
    assert.throws(() => applyPostClose(s, e, s.epoch), /EXPLICIT_CONTRACT/);
    const fresh = openedOperating(postCloseConfig());
    try {
      assert.throws(
        () => fresh.store.settlePostClose("early", e, fresh.store.read()),
        /REQUIRES_BASIS/,
      );
    } finally {
      fresh.repo.close();
    }
    assert.equal(postCloseContractHash.length, 64);
  } finally {
    f.repo.close();
  }
});
