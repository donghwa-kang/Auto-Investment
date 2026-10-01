import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { hash } from "../src/core/policy.js";
import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import {
  finalizationContractHash,
  postCloseInputLimit,
  applyFinalization,
} from "../src/core/cost-finalization.js";
import { applyHandoffCommand } from "../src/core/cost-handoff.js";
import { applyReservationCommand } from "../src/core/cost-reservation.js";
import {
  finalizationConfig,
  closedFixture,
  closeRequest,
} from "./cost-finalization-helpers.js";
import type { FinalizationFixture } from "./cost-finalization-helpers.js";
import {
  operatingConfig,
  openedOperating,
  op,
  record,
} from "./cost-operating-helpers.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";
import {
  beginTrade,
  fillTrade,
  closeTrade,
  sellOrder,
  journal,
} from "./cost-outcome-helpers.js";
import { observation, proposal } from "./cost-reservation-helpers.js";

const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "cost-finalization-")), "fixture.sqlite");
const opened = () => openedOperating(finalizationConfig());
const dump = (repo: Repository) => ({
  data: dumpHandoff(repo),
  writer: repo.db.prepare("SELECT * FROM writer").all(),
});
const finalize = (f: FinalizationFixture) =>
  f.store.finalizeOperating(
    "close",
    "period-close",
    closeRequest(f),
    f.store.read(),
  );

test("CF-01 result, checkpoint, counter and audit commit without double charging funds", () => {
  const f = opened();
  try {
    closedFixture(f);
    const s = f.store.read(),
      req = closeRequest(f),
      expected = f.store.operatingClose(req),
      result = finalize(f),
      n = result.current;
    assert.equal(n.finalization!.status, "FINALIZED");
    const c = n.finalization!.checkpoint!;
    assert.equal(n.finalization!.contractHash, finalizationContractHash);
    assert.deepEqual(c.report, expected);
    assert.equal(c.report.periodNetPnlKrw, "-1");
    assert.equal(c.initialLossStreak, 0);
    assert.equal(c.appliedLossStreak, 1);
    assert.equal(c.counterApplied, true);
    assert.equal(n.seed.ledger.lossStreak, 1);
    assert.equal(c.appliedRevision, s.revision + 1);
    assert.equal(c.epoch, f.repo.epoch);
    assert.equal(c.appliedAt, req.asOf);
    assert.equal(n.seed.clock, req.asOf);
    assert.deepEqual(n.handoff!.accounts, s.handoff!.accounts);
    assert.deepEqual(n.operating, s.operating);
    assert.deepEqual(n.outcomes, s.outcomes);
    assert.deepEqual(n.book.sources, s.book.sources);
    assert.deepEqual(n.seed.ledger.wallets, s.seed.ledger.wallets);
    assert.deepEqual(n.seed.ledger.cooldowns, s.seed.ledger.cooldowns);
    for (const hold of s.handoff!.admissionHolds)
      assert.ok(n.handoff!.admissionHolds.includes(hold));
    assert.ok(
      n.handoff!.admissionHolds.includes("FINALIZED_MANUAL_REVIEW_REQUIRED"),
    );
    assert.equal(n.learningAllowed, false);
    assert.equal(n.orderSubmissionAllowed, false);
    assert.equal(n.liveEnabled, false);
    assert.equal(f.repo.verifyAudit(), n.revision + 1);
    assert.deepEqual(f.store.read(), n);
  } finally {
    f.repo.close();
  }
});
test("CF-02 final losses follow close time/revision, not ID; crossed halt survives later profit", () => {
  const c = finalizationConfig();
  c.seed.ledger.lossStreak = 1;
  c.book.seedHash = hash(c.seed);
  const f = openedOperating(c);
  try {
    const [a, b] = [beginTrade(f.store, "A"), beginTrade(f.store, "B")].sort();
    assert.ok(a && b);
    fillTrade(f.store, a);
    fillTrade(f.store, b);
    sellOrder(f.store, b, "10000");
    sellOrder(f.store, a, "10100");
    const at = f.store.read().seed.clock + 1;
    fillTrade(f.store, b, "exit", 1, "10000", at);
    fillTrade(f.store, a, "exit", 1, "10100", at);
    const s = finalize(f).current;
    assert.equal(s.seed.ledger.lossStreak, 0);
    assert.deepEqual(
      s.finalization!.checkpoint!.report.lossProjection!.map((r) => [
        r.tradeId,
        r.lossStreakAfter,
      ]),
      [
        [b, 2],
        [a, 0],
      ],
    );
    assert.ok(s.seed.ledger.halts.includes("CONSECUTIVE_LOSSES"));
    assert.equal(s.seed.status, "HALTED");
  } finally {
    f.repo.close();
  }
});
test("CF-03 +2/+2 becomes -1/-1 and atomically latches two losses", () => {
  const f = opened();
  try {
    const a = beginTrade(f.store, "A"),
      b = beginTrade(f.store, "B");
    fillTrade(f.store, a);
    fillTrade(f.store, b);
    closeTrade(f.store, a, "10022");
    closeTrade(f.store, b, "10022");
    record(f.store, op(f.store.read(), "RECOGNIZE", "cost", "6"));
    const s = finalize(f).current;
    assert.equal(s.seed.ledger.lossStreak, 2);
    assert.ok(s.seed.ledger.halts.includes("CONSECUTIVE_LOSSES"));
    assert.deepEqual(
      s.finalization!.checkpoint!.report.allocations!.map(
        (a) => a.finalNetPnlKrw,
      ),
      ["-1", "-1"],
    );
  } finally {
    f.repo.close();
  }
});
test("CF-04 zero PnL preserves initial loss and N=0 cost never makes fake trade", () => {
  for (const trade of [false, true]) {
    const c = finalizationConfig();
    c.seed.ledger.lossStreak = 1;
    c.book.seedHash = hash(c.seed);
    const f = openedOperating(c);
    try {
      if (trade) closedFixture(f, "10023");
      else record(f.store, op(f.store.read(), "RECOGNIZE", "cost", "3"));
      const n = finalize(f).current;
      assert.equal(n.seed.ledger.lossStreak, 1);
      assert.equal(
        n.finalization!.checkpoint!.report.periodNetPnlKrw,
        trade ? "0" : "-3",
      );
      assert.equal(
        n.finalization!.checkpoint!.report.unallocatedKrw,
        trade ? "0" : "3",
      );
    } finally {
      f.repo.close();
    }
  }
});
test("CF-05 same close ID/payload retries return original receipt even with new command ID", () => {
  const f = opened();
  try {
    closedFixture(f);
    const s = f.store.read(),
      req = closeRequest(f),
      first = f.store.finalizeOperating("close", "period", req, s),
      before = dumpHandoff(f.repo);
    for (const id of ["close", "retry"]) {
      const next = f.store.finalizeOperating(id, "period", req, first.current);
      assert.equal(next.duplicate, true);
      assert.deepEqual(next.receipt, first.receipt);
      assert.deepEqual(next.current, first.current);
    }
    assert.deepEqual(dumpHandoff(f.repo), before);
  } finally {
    f.repo.close();
  }
});
test("CF-06 close ID/payload and unrelated command ID collisions cannot change result", () => {
  const f = opened();
  try {
    closedFixture(f);
    const req = closeRequest(f),
      s = f.store.read();
    f.store.finalizeOperating("close", "period", req, s);
    const before = dump(f.repo);
    assert.throws(
      () => f.store.finalizeOperating("new", "other", req, s),
      /ID_OR_CONTENT_CONFLICT/,
    );
    assert.throws(
      () =>
        f.store.finalizeOperating(
          "close",
          "period",
          { ...req, asOf: req.asOf + 1 },
          s,
        ),
      /ID_OR_CONTENT_CONFLICT/,
    );
    assert.throws(
      () => f.store.finalizeOperating("cost", "period", req, s),
      /LOCAL_COMMAND_ID_CONFLICT/,
    );
    assert.deepEqual(dump(f.repo), before);
  } finally {
    f.repo.close();
  }
});
for (const variant of [
  "stale-state",
  "stale-manifest",
  "incomplete",
  "not-available",
  "open",
  "reserve",
  "quarantine",
] as const)
  test(`CF-07 ${variant} cannot partially commit a checkpoint`, () => {
    const f = opened();
    try {
      if (variant === "open") beginTrade(f.store);
      if (variant === "reserve")
        record(f.store, op(f.store.read(), "RESERVE", "r"));
      if (variant === "quarantine")
        f.store.operatingInput("bad", '{"kind":"REFUND"}', f.store.read());
      let s = f.store.read();
      const req = closeRequest(f);
      if (variant === "stale-state" || variant === "stale-manifest")
        record(f.store, op(s, "RECOGNIZE", "cost", "3"));
      if (variant !== "stale-state") s = f.store.read();
      if (variant === "incomplete") req.manifest.coverage = "INCOMPLETE";
      if (variant === "not-available") req.asOf--;
      const before = dump(f.repo);
      assert.throws(
        () => f.store.finalizeOperating("close", "period", req, s),
        /FINALIZATION_HOLD|LOCAL_REAPPROVAL_REQUIRED/,
      );
      assert.deepEqual(dump(f.repo), before);
      assert.equal(f.store.read().finalization!.checkpoint, null);
    } finally {
      f.repo.close();
    }
  });
for (const stage of [
  "COMMAND",
  "APPROVALS",
  "FILL_INDEX",
  "STATE",
  "AUDIT",
] as const)
  for (const kind of ["CLOSE", "RAW"] as const)
    test(`CF-08 ${kind} failure at ${stage} rolls back all rows and lease`, () => {
      const repo = new Repository(":memory:", () => 1000);
      repo.acquire();
      let armed = false;
      const c = finalizationConfig(),
        store = new CostReservationStore(repo, c, {
          initialize: true,
          testStage: (s) => {
            if (armed && s === stage) throw Error("INJECTED");
          },
        }),
        f = { repo, store, c };
      try {
        closedFixture(f);
        if (kind === "RAW") finalize(f);
        const s = store.read(),
          req = kind === "CLOSE" ? closeRequest(f) : null,
          before = dump(repo);
        armed = true;
        assert.throws(
          () =>
            kind === "CLOSE"
              ? store.finalizeOperating("close", "period", req, s)
              : store.postCloseInput("raw", "{}", s.seed.clock + 1, s),
          /INJECTED/,
        );
        assert.deepEqual(dump(repo), before);
        assert.deepEqual(store.read(), s);
      } finally {
        repo.close();
      }
    });
for (const failure of ["DISK_FULL", "WRITE_FAILURE"] as const)
  test(`CF-09 ${failure} never saves half a counter`, () => {
    const f = opened();
    try {
      closedFixture(f);
      const s = f.store.read(),
        req = closeRequest(f),
        before = dump(f.repo);
      f.repo.failure = failure;
      assert.throws(
        () => f.store.finalizeOperating("close", "period", req, s),
        new RegExp(failure),
      );
      assert.deepEqual(dump(f.repo), before);
    } finally {
      f.repo.close();
    }
  });
test("CF-10 lease expiration and competing writer fence finalization and retries", () => {
  const path = fresh(),
    c = finalizationConfig();
  let now = 1000,
    armed = false;
  const repo = new Repository(path, () => now);
  repo.acquire();
  const store = new CostReservationStore(repo, c, {
      initialize: true,
      testStage: (s) => {
        if (armed && s === "AUDIT") now = 11000;
      },
    }),
    f = { repo, store, c };
  let other: Repository | undefined;
  try {
    closedFixture(f);
    const s = store.read(),
      req = closeRequest(f),
      before = dump(repo);
    armed = true;
    assert.throws(
      () => store.finalizeOperating("close", "period", req, s),
      /FENCED_WRITER/,
    );
    assert.deepEqual(dump(repo), before);
    other = new Repository(path, () => now);
    other.acquire();
    const winner = new CostReservationStore(other, c);
    const result = winner.finalizeOperating("close", "period", req, s);
    assert.equal(result.current.finalization!.checkpoint!.epoch, other.epoch);
    assert.throws(
      () => store.finalizeOperating("retry", "period", req, s),
      /FENCED_WRITER/,
    );
  } finally {
    other?.close();
    repo.close();
  }
});
test("CF-11 reopening/new epoch retries preserve original result and never increment twice", () => {
  const path = fresh(),
    c = finalizationConfig();
  let { repo, store } = openedOperating(c, path);
  const f = { repo, store, c };
  closedFixture(f);
  const s = store.read(),
    req = closeRequest(f),
    result = store.finalizeOperating("close", "period", req, s);
  repo.close();
  repo = new Repository(path, () => 20000);
  repo.acquire();
  store = new CostReservationStore(repo, c);
  try {
    assert.deepEqual(store.read(), result.current);
    const again = store.finalizeOperating("close", "period", req, s);
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.receipt, result.receipt);
    assert.deepEqual(again.current, result.current);
    assert.equal(again.current.seed.ledger.lossStreak, 1);
  } finally {
    repo.close();
  }
});
test("CF-12 post-close payment/settlement intake preserves raw, debt and original result", () => {
  const f = opened();
  try {
    const run = closedFixture(f),
      req = closeRequest(f),
      result = finalize(f),
      s = result.current,
      before = dump(f.repo),
      payment = op(s, "PAY", "pay", "3");
    assert.throws(
      () => f.store.operating("pay", payment, s),
      /FINALIZED_FINANCIAL_MUTATION_BLOCKED/,
    );
    assert.throws(
      () =>
        f.store.execute(
          "settle",
          run,
          {
            kind: "SETTLE",
            id: "settle",
            seq: s.book.sources[0]!.events.length + 1,
            at: s.seed.clock + 1,
            fillIds: journal(s, run).postings.map((p) => p.fill.fillId),
          },
          s,
        ),
      /FINALIZED_FINANCIAL_MUTATION_BLOCKED/,
    );
    assert.throws(
      () => f.store.observe("observe", observation(s), s),
      /FINALIZED_FINANCIAL_MUTATION_BLOCKED/,
    );
    assert.throws(
      () => f.store.prepare(proposal(f.store)),
      /FINALIZED_MANUAL_REVIEW_REQUIRED|OPERATING_/,
    );
    assert.throws(
      () => f.store.operatingClose(req),
      /FINALIZATION_ALREADY_APPLIED/,
    );
    assert.deepEqual(dump(f.repo), before);
    const raw = JSON.stringify(payment),
      held = f.store.postCloseInput("raw", raw, s.seed.clock + 1, s).current;
    assert.equal(held.finalization!.status, "RECONCILING");
    assert.equal(held.finalization!.rejectedInputs[0]!.rawJson, raw);
    assert.deepEqual(held.finalization!.checkpoint, s.finalization!.checkpoint);
    assert.deepEqual(held.handoff!.accounts, s.handoff!.accounts);
    assert.deepEqual(held.operating, s.operating);
    assert.equal(held.seed.ledger.lossStreak, 1);
    assert.equal(held.operating!.effects.paidKrw, "0");
    assert.ok(
      held.handoff!.admissionHolds.includes(
        "POST_CLOSE_RECONCILIATION_REQUIRED",
      ),
    );
    const retry = f.store.finalizeOperating("retry", "period-close", req, s);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.current.finalization!.status, "RECONCILING");
  } finally {
    f.repo.close();
  }
});
test("CF-13 raw input rejects time rewind/oversize and requires an existing checkpoint", () => {
  const f = opened();
  try {
    const initial = f.store.read();
    assert.throws(
      () => f.store.postCloseInput("early", "{}", initial.seed.clock, initial),
      /REQUIRES_CHECKPOINT/,
    );
    const s = finalize(f).current,
      before = dump(f.repo);
    assert.throws(
      () => f.store.postCloseInput("rewind", "{}", s.seed.clock - 1, s),
      /TIME_REWIND/,
    );
    assert.throws(() =>
      f.store.postCloseInput("large", "가".repeat(2731), s.seed.clock, s),
    );
    assert.deepEqual(dump(f.repo), before);
  } finally {
    f.repo.close();
  }
});
test("CF-14 post-close raw input capacity is bounded without discarding checkpoint", () => {
  const f = opened();
  try {
    let s = finalize(f).current;
    for (let i = 0; i < postCloseInputLimit; i++)
      s = applyFinalization(
        s,
        f.c,
        [],
        { kind: "POST_CLOSE_INPUT", rawJson: "{}", observedAt: s.seed.clock },
        s.epoch,
      );
    assert.throws(
      () =>
        applyFinalization(
          s,
          f.c,
          [],
          { kind: "POST_CLOSE_INPUT", rawJson: "{}", observedAt: s.seed.clock },
          s.epoch,
        ),
      /POST_CLOSE_INPUT_LIMIT/,
    );
    assert.equal(s.finalization!.checkpoint!.counterApplied, true);
  } finally {
    f.repo.close();
  }
});
test("CF-15 unextended V4 cannot finalize; old config cannot open an extended run", () => {
  const f = openedOperating();
  try {
    const before = dump(f.repo);
    assert.throws(() => finalize(f));
    assert.equal(f.store.read().finalization, undefined);
    assert.deepEqual(dump(f.repo), before);
    assert.throws(
      () => new CostReservationStore(f.repo, finalizationConfig()),
      /CONFIG_MISMATCH/,
    );
  } finally {
    f.repo.close();
  }
  const g = opened();
  try {
    assert.throws(
      () => new CostReservationStore(g.repo, operatingConfig()),
      /CONFIG_MISMATCH/,
    );
  } finally {
    g.repo.close();
  }
});
test("CF-16 invalid extension contract cannot initialize any money tables", () => {
  const repo = new Repository(":memory:", () => 1000);
  repo.acquire();
  try {
    const c = finalizationConfig();
    c.finalization.contractHash = "0".repeat(64);
    assert.throws(
      () => new CostReservationStore(repo, c, { initialize: true }),
    );
    assert.equal(
      repo.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'cost_reservation_%'",
        )
        .all().length,
      0,
    );
  } finally {
    repo.close();
  }
});
for (const target of ["counter", "checkpoint", "command", "audit"] as const)
  test(`CF-17 ${target} tampering is rejected by complete replay`, () => {
    const f = opened();
    try {
      closedFixture(f);
      finalize(f);
      if (target === "command")
        f.repo.db.exec(
          "DELETE FROM cost_reservation_commands WHERE id='close'",
        );
      else if (target === "audit")
        f.repo.db.exec(
          "DELETE FROM audit WHERE seq=(SELECT MAX(seq) FROM audit)",
        );
      else {
        const s = f.store.read();
        if (target === "counter") s.seed.ledger.lossStreak = 99;
        else s.finalization!.checkpoint!.report.periodNetPnlKrw = "999";
        f.repo.db
          .prepare("UPDATE cost_reservation_run SET body=?,checksum=?")
          .run(JSON.stringify(s), hash(s));
      }
      assert.throws(() => f.store.read(), /LOCAL_|AUDIT/);
    } finally {
      f.repo.close();
    }
  });
test("CF-18 finalized source cannot be sent directly back through financial reducers", () => {
  const f = opened();
  try {
    const s = finalize(f).current;
    assert.throws(
      () => applyHandoffCommand(s, observation(s), s.epoch),
      /FINALIZED_FINANCIAL_MUTATION_BLOCKED/,
    );
    assert.throws(
      () => applyReservationCommand(s, observation(s), s.epoch),
      /FINALIZED_FINANCIAL_MUTATION_BLOCKED/,
    );
  } finally {
    f.repo.close();
  }
});
for (const stage of ["STATE", "COMMITTED"])
  test(`CF-19 owned child termination at ${stage}: whole checkpoint or none`, async () => {
    const path = fresh();
    const child = spawn(
      process.execPath,
      ["scripts/cost-finalization-crash-fixture.mjs", path, stage],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr!.on("data", (v) => {
      stderr += v;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error(`CHILD_TIMEOUT:${stderr}`)),
          30000,
        );
        child.once("message", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(Error(`EARLY_EXIT:${code}:${stderr}`));
        });
      });
      const exited = once(child, "exit");
      child.kill();
      await exited;
      const repo = new Repository(path, () => 20000);
      repo.acquire();
      const c = finalizationConfig(),
        store = new CostReservationStore(repo, c);
      try {
        const s = store.read();
        assert.equal(
          s.finalization!.checkpoint !== null,
          stage === "COMMITTED",
        );
        assert.equal(s.seed.ledger.lossStreak, stage === "COMMITTED" ? 1 : 0);
        const req =
          s.finalization!.checkpoint?.request ??
          closeRequest({ repo, store, c });
        const r = store.finalizeOperating("close", "period", req, s);
        assert.equal(r.duplicate, stage === "COMMITTED");
        assert.equal(r.current.seed.ledger.lossStreak, 1);
        assert.equal(repo.verifyAudit(), r.current.revision + 1);
      } finally {
        repo.close();
      }
    } finally {
      if (child.exitCode === null && !child.killed) child.kill();
    }
  });
