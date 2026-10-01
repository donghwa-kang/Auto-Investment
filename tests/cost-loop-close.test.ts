import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { hash } from "../src/core/policy.js";
import { costLoopCloseContract } from "../src/core/cost-loop-schema.js";
import { finalizationContractHash } from "../src/core/cost-finalization.js";
import { verifyOperatingEvidence } from "../src/core/cost-operating-evidence.js";
import { applyCostLoopTick } from "../src/core/cost-loop.js";
import { applyCostWatchdog } from "../src/core/cost-watchdog.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { CostLoopRuntime } from "../src/server/cost-loop-runtime.js";
import { Repository } from "../src/server/repository.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";
import { op, record } from "./cost-operating-helpers.js";
import { finalizationConfig } from "./cost-finalization-helpers.js";
import { postCloseOptionsSchema } from "../src/core/cost-post-close.js";
import { partialSettlementOptionsSchema } from "../src/core/cost-partial-settlement.js";
import type { OperatingConfig } from "../src/core/cost-operating.js";
import type { OperatingCloseRequest } from "../src/core/cost-operating-close.js";
import type { ReservationState } from "../src/core/cost-reservation.js";
import {
  loopCloseProgram,
  loopCloseFixture,
  finishLoop,
  manualRuntime,
} from "./cost-loop-close-helpers.js";

const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "cost-loop-close-")), "fixture.sqlite");
const dump = (repo: Repository) => ({
  rows: dumpHandoff(repo),
  writer: repo.db.prepare("SELECT * FROM writer").all(),
});
const verify = (store: CostReservationStore) => {
  const exported = store.exportOperatingEvidence();
  const checked = verifyOperatingEvidence(JSON.stringify(exported), {
    config: exported.config,
    exportHash: exported.exportHash,
  });
  assert.deepEqual(checked.report, exported.report);
  return exported;
};

test("LC-01 new close contract is explicit; legacy configs/unsupported extensions cannot migrate", () => {
  const program = loopCloseProgram(),
    old = program.operatingLoop().config(),
    before = hash(program.config()),
    next = program.operatingLoop({ finalization: true }).config();
  assert.equal(old.operatingLoop!.closeContract, undefined);
  assert.equal(next.operatingLoop!.closeContract, costLoopCloseContract);
  assert.equal(hash(program.config()), before);
  assert.deepEqual(program.operatingLoop().config(), old);
  for (const raw of [
    { finalization: false },
    { finalization: true, postClose: true },
    null,
  ])
    assert.throws(() => program.operatingLoop(raw));
  for (const c of [
    { ...old, finalization: { contractHash: finalizationContractHash } },
    { ...next, finalization: undefined },
    {
      ...next,
      postClose: {
        contractHash: postCloseOptionsSchema.shape.contractHash.value,
        followupEndExclusive: next.operating.periodEnd + 1,
      },
    },
    {
      ...next,
      partialSettlement: {
        contractHash: partialSettlementOptionsSchema.shape.contractHash.value,
        followupEndExclusive: next.operating.periodEnd + 1,
        evidence: [],
        evidenceHash: hash([]),
      },
    },
  ]) {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    try {
      assert.throws(
        () => new CostReservationStore(repo, c, { initialize: true }),
        /COST_OPERATING_LOOP_EXTENSION_UNSUPPORTED/,
      );
      assert.equal(
        repo.db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'cost_reservation_%'",
          )
          .get()!.n,
        0,
      );
    } finally {
      repo.close();
    }
  }
});

for (const price of ["22000", "21121"])
  test(`LC-02 ${price} automatic fills + operating cost + atomic close agree with exact arithmetic`, () => {
    const f = loopCloseFixture();
    try {
      finishLoop(f, price);
      const s = f.store.read(),
        v = f.view(),
        request = f.request();
      assert.equal(v.quantity, 0);
      assert.equal(v.reservedCash, "0");
      assert.ok(
        v.orders.every((o) => ["FILLED", "CANCELLED"].includes(o.status)),
      );
      const pnl = (BigInt(price) - 21400n) * 4n - 20n - 50n;
      const close = f.store.finalizeOperating("close", "period", request, s),
        cp = close.current.finalization!.checkpoint!;
      assert.equal(cp.report.periodNetPnlKrw, pnl.toString());
      assert.equal(cp.report.allocations![0]!.operatingCostKrw, "50");
      assert.equal(close.current.seed.ledger.lossStreak, pnl < 0n ? 1 : 0);
      assert.deepEqual(close.current.handoff!.accounts, s.handoff!.accounts);
      assert.deepEqual(close.current.book.sources, s.book.sources);
      assert.deepEqual(close.current.operating, s.operating);
      assert.equal(close.current.outcomes![0]!.counterApplied, false);
      const e = verify(f.store);
      assert.equal(
        e.config.operatingLoop!.closeContract,
        costLoopCloseContract,
      );
      assert.equal(
        e.report.financialEvidence.finalization.periodNetPnlKrw,
        pnl.toString(),
      );
      assert.equal(e.report.status, "HOLD");
      assert.equal(e.orderSubmissionAllowed, false);
      assert.equal(e.learningAllowed, false);
      assert.equal(e.liveEnabled, false);
      assert.equal(e.automaticResumeAllowed, false);
      assert.equal(f.repo.verifyAudit(), close.current.revision + 1);
      const once = dump(f.repo);
      for (const id of ["close", "retry-new-id"]) {
        const retry = f.store.finalizeOperating(id, "period", request, s);
        assert.equal(retry.duplicate, true);
        assert.deepEqual(retry.receipt, close.receipt);
      }
      assert.deepEqual(dump(f.repo), once);
      assert.throws(
        () =>
          f.store.finalizeOperating(
            "other",
            "period",
            { ...request, asOf: request.asOf + 1 },
            s,
          ),
        /FINALIZATION_ID_OR_CONTENT_CONFLICT/,
      );
      assert.throws(
        () => f.store.finalizeOperating("other", "different", request, s),
        /FINALIZATION_ID_OR_CONTENT_CONFLICT/,
      );
    } finally {
      f.repo.close();
    }
  });

test("LC-03 N=0 with cost closes without invented trades or a loss streak", () => {
  const f = loopCloseFixture({ handoff: "NONE" });
  try {
    f.expense();
    const s = f.close().current,
      cp = s.finalization!.checkpoint!;
    assert.deepEqual(cp.report.allocations, []);
    assert.equal(cp.report.unallocatedKrw, "50");
    assert.equal(cp.report.periodNetPnlKrw, "-50");
    assert.equal(s.seed.ledger.lossStreak, 0);
    verify(f.store);
  } finally {
    f.repo.close();
  }
});

for (const stage of [
  "RESERVED",
  "UNKNOWN",
  "OPEN_ORDER",
  "PARTIAL_BUY",
] as const)
  test(`LC-04 ${stage} stop is not liquidation and cannot authorize close`, () => {
    const f = loopCloseFixture({
      handoff:
        stage === "RESERVED"
          ? "NONE"
          : stage === "UNKNOWN"
            ? "UNKNOWN"
            : "CONFIRMED",
    });
    try {
      if (stage === "RESERVED")
        f.store.reserve("reserve", f.adapter.prepareEntry(f.store));
      if (stage === "PARTIAL_BUY") {
        f.tick(1000);
        f.tick(2000);
      }
      const before = dump(f.repo),
        s = f.store.read();
      new CostLoopRuntime(f.store).stop();
      assert.deepEqual(dump(f.repo), before);
      assert.throws(
        () => f.store.finalizeOperating("close", "period", f.request(), s),
        /FINALIZATION_HOLD/,
      );
      assert.deepEqual(dump(f.repo), before);
    } finally {
      f.repo.close();
    }
  });

test("LC-05 reservation, quarantine, incomplete/future/stale evidence deny close without writes", () => {
  const f = loopCloseFixture();
  try {
    finishLoop(f);
    const valid = f.request(),
      s = f.store.read(),
      before = dump(f.repo);
    for (const request of [
      { ...valid, manifest: { ...valid.manifest, coverage: "INCOMPLETE" } },
      { ...valid, asOf: valid.asOf - 1 },
      {
        ...valid,
        manifest: { ...valid.manifest, recordsHash: "f".repeat(64) },
      },
    ])
      assert.throws(
        () => f.store.finalizeOperating("close", "period", request, s),
        /FINALIZATION_HOLD/,
      );
    assert.deepEqual(dump(f.repo), before);
    record(f.store, op(s, "RESERVE", "pending", "3", "pending-debt"));
    const reserved = dump(f.repo);
    assert.throws(() => f.close(), /UNRESOLVED_RESERVATION/);
    assert.deepEqual(dump(f.repo), reserved);
    record(
      f.store,
      op(f.store.read(), "RELEASE", "release", "3", "pending-debt", "pending"),
    );
    f.store.operatingInput("invalid", "{}", f.store.read());
    const quarantined = dump(f.repo);
    assert.throws(() => f.close(), /QUARANTINED_INPUT/);
    assert.deepEqual(dump(f.repo), quarantined);
  } finally {
    f.repo.close();
  }
});

test("LC-06 tick before close invalidates CAS/manifest; close before tick/pulse rejects new mutations", () => {
  const f = loopCloseFixture();
  try {
    finishLoop(f);
    const s = f.store.read(),
      request = f.request();
    f.tick(12000, "22000");
    const before = dump(f.repo);
    assert.throws(
      () => f.store.finalizeOperating("close", "period", request, s),
      /LOCAL_REAPPROVAL_REQUIRED/,
    );
    assert.throws(
      () =>
        f.store.finalizeOperating("close", "period", request, f.store.read()),
      /MANIFEST_SNAPSHOT_MISMATCH/,
    );
    assert.deepEqual(dump(f.repo), before);
    f.close();
    const closed = f.store.read(),
      once = dump(f.repo);
    assert.throws(() => f.tick(13000), /FINALIZED_FINANCIAL_MUTATION_BLOCKED/);
    assert.throws(
      () => f.store.pulse("pulse", f.pulse(14000)),
      /FINALIZED_FINANCIAL_MUTATION_BLOCKED/,
    );
    assert.throws(
      () =>
        applyCostLoopTick(closed, f.quote(13000), closed.epoch, () => {
          throw Error("UNREACHABLE");
        }),
      /FINALIZED_FINANCIAL_MUTATION_BLOCKED/,
    );
    assert.throws(
      () => applyCostWatchdog(closed, f.pulse(14000), closed.epoch),
      /FINALIZED_FINANCIAL_MUTATION_BLOCKED/,
    );
    // A receipt lookup of a previously committed tick is not a new execution.
    assert.equal(
      f.store.tick("tick-12000", f.quote(12000, "22000")).duplicate,
      true,
    );
    assert.deepEqual(dump(f.repo), once);
  } finally {
    f.repo.close();
  }
});

test("LC-07 runtime stops before close; stale callbacks/restart cannot mutate a checkpoint", () => {
  const f = loopCloseFixture();
  try {
    finishLoop(f);
    const m = manualRuntime(f, 11000);
    m.runtime.start();
    assert.equal(m.runtime.status().timerPending, true);
    f.close();
    const once = dump(f.repo);
    assert.equal(m.runtime.status().phase, "STOPPED");
    assert.equal(m.runtime.status().timerPending, false);
    assert.equal(m.cancels(), 1);
    m.advance(12000);
    for (const callback of m.callbacks) callback();
    assert.throws(() => m.runtime.start(), /COST_RUNTIME_FINALIZED/);
    assert.throws(
      () => new CostLoopRuntime(f.store).start(),
      /COST_RUNTIME_FINALIZED/,
    );
    assert.deepEqual(dump(f.repo), once);
  } finally {
    f.repo.close();
  }
});

test("LC-08 failed close leaves runtime stopped, unresolved position and evidence intact", () => {
  const f = loopCloseFixture();
  try {
    f.tick(1000);
    f.tick(2000);
    const m = manualRuntime(f, 2000);
    m.runtime.start();
    const before = dump(f.repo);
    assert.throws(() => f.close(), /OPEN_POSITION_OR_ORDER/);
    assert.equal(m.runtime.status().phase, "STOPPED");
    assert.deepEqual(dump(f.repo), before);
    assert.equal(f.view().quantity, 2);
    m.advance(3000);
    m.callbacks[0]!();
    assert.deepEqual(dump(f.repo), before);
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
  test(`LC-09 ${stage} close rollback preserves the entire combined ledger and exact retry`, () => {
    let armed = false;
    const f = loopCloseFixture({
      testStage: (at) => {
        if (armed && at === stage) throw Error("LC_INJECTED_FAILURE");
      },
    });
    try {
      finishLoop(f, "21121");
      const s = f.store.read(),
        request = f.request(),
        before = dump(f.repo);
      armed = true;
      assert.throws(
        () => f.store.finalizeOperating("close", "period", request, s),
        /LC_INJECTED_FAILURE/,
      );
      assert.deepEqual(dump(f.repo), before);
      armed = false;
      const result = f.store.finalizeOperating("close", "period", request, s);
      assert.equal(result.current.seed.ledger.lossStreak, 1);
      assert.deepEqual(
        f.store.finalizeOperating("retry", "period", request, s).receipt,
        result.receipt,
      );
      verify(f.store);
    } finally {
      f.repo.close();
    }
  });

test("LC-10 pre-commit failure and expired lease cannot partially persist close", () => {
  let now = 1000;
  const f = loopCloseFixture({ leaseNow: () => now });
  try {
    finishLoop(f);
    const before = dump(f.repo),
      s = f.store.read(),
      request = f.request();
    f.repo.failure = "DISK_FULL";
    assert.throws(
      () => f.store.finalizeOperating("close", "period", request, s),
      /DISK_FULL/,
    );
    f.repo.failure = null;
    assert.deepEqual(dump(f.repo), before);
    now = 11000;
    assert.throws(
      () => f.store.finalizeOperating("close", "period", request, s),
      /FENCED_WRITER/,
    );
    assert.deepEqual(dump(f.repo), before);
  } finally {
    f.repo.close();
  }
});

test("LC-11 normal cold reopen recovers a committed receipt; immutable checkpoint survives raw input", () => {
  const path = fresh(),
    f = loopCloseFixture({ path });
  finishLoop(f, "21121");
  const expected = f.store.read(),
    request = f.request(),
    receipt = f.close().receipt,
    checkpoint = hash(f.store.read().finalization!.checkpoint);
  const evidence = verify(f.store);
  f.repo.close();
  const reopened = loopCloseFixture({ path, initialize: false });
  try {
    const result = reopened.store.finalizeOperating(
      "retry",
      "period",
      request,
      expected,
    );
    assert.equal(result.duplicate, true);
    assert.deepEqual(result.receipt, receipt);
    assert.equal(result.current.seed.ledger.lossStreak, 1);
    reopened.store.postCloseInput(
      "raw",
      '{"pending":true}',
      request.asOf + 1,
      result.current,
    );
    assert.equal(
      hash(reopened.store.read().finalization!.checkpoint),
      checkpoint,
    );
    assert.equal(reopened.store.read().finalization!.status, "RECONCILING");
    assert.equal(
      verify(reopened.store).report.financialEvidence.finalization
        .periodNetPnlKrw,
      "-1186",
    );
    assert.deepEqual(
      verifyOperatingEvidence(JSON.stringify(evidence), {
        config: f.c,
        exportHash: evidence.exportHash,
      }).report,
      evidence.report,
    );
  } finally {
    reopened.repo.close();
  }
});

test("LC-12 runtime reentrant close is rejected before writing", () => {
  const f = loopCloseFixture();
  try {
    finishLoop(f);
    let armed = false;
    const request = f.request(),
      expected = f.store.read();
    const runtime = new CostLoopRuntime(f.store, {
      clock: {
        wallNow: () => {
          if (armed)
            f.store.finalizeOperating("close", "period", request, expected);
          return f.at + 11000;
        },
        monotonicNow: () => 11000,
      },
      timer: { schedule: () => () => {} },
    });
    runtime.start();
    const before = dump(f.repo);
    armed = true;
    assert.throws(
      () => runtime.quote("extra", f.quote(11000)),
      /COST_RUNTIME_REENTRANT/,
    );
    assert.equal(runtime.status().phase, "FAULT");
    assert.deepEqual(dump(f.repo), before);
  } finally {
    f.repo.close();
  }
});

test("LC-13 recorded pulse invalidates close evidence; remaining receivable is never auto-settled", () => {
  const f = loopCloseFixture();
  try {
    f.tick(1000);
    f.expense();
    for (const ms of [2000, 3000, 4000]) f.tick(ms);
    for (const ms of [5000, 6000, 7000, 8000, 9000, 10000]) f.tick(ms, "22000");
    assert.equal(f.view().quantity, 0);
    assert.equal(f.view().wallet.receivable, "22000");
    const expected = f.store.read(),
      stale = f.request(),
      observedAt = f.c.operating.periodEnd + 1;
    f.store.pulse("late-pulse", f.pulse(observedAt - f.at));
    const snapshot = dump(f.repo),
      after = f.store.read();
    assert.equal(after.seed.clock, expected.seed.clock);
    assert.equal(after.loop!.watchdog!.lastPulseAt, observedAt);
    assert.throws(
      () => f.store.finalizeOperating("close", "period", stale, expected),
      /LOCAL_REAPPROVAL_REQUIRED/,
    );
    assert.throws(() => f.close(), /LOOP_CLOSE_EVIDENCE_BEFORE_OBSERVATION/);
    assert.deepEqual(dump(f.repo), snapshot);
    const request = f.request();
    request.manifest.finalizedAt =
      request.manifest.availableAt =
      request.asOf =
        observedAt;
    f.store.finalizeOperating("close", "period", request, after);
    const e = verify(f.store);
    assert.equal(
      e.report.financialEvidence.currentAccounts[0]!.receivable,
      "22000",
    );
    assert.equal(
      e.report.financialEvidence.finalization.periodNetPnlKrw,
      "2330",
    );
    assert.deepEqual(f.store.read().handoff!.accounts, after.handoff!.accounts);
  } finally {
    f.repo.close();
  }
});

test("LC-14 second Store handle is fenced by persisted close even with another runtime owner", () => {
  const f = loopCloseFixture();
  try {
    finishLoop(f);
    const m = manualRuntime(f, 11000);
    m.runtime.start();
    const other = new CostReservationStore(f.repo, f.c);
    other.finalizeOperating("close", "period", f.request(), f.store.read());
    const before = dump(f.repo);
    m.advance(12000);
    m.callbacks[0]!();
    assert.equal(m.runtime.status().phase, "FAULT");
    assert.equal(m.runtime.status().error, "COST_RUNTIME_FINALIZED");
    assert.equal(m.runtime.status().timerPending, false);
    assert.deepEqual(dump(f.repo), before);
  } finally {
    f.repo.close();
  }
});

test("LC-15 real SQLite page limit rolls back close; recovery applies one counter only", () => {
  let armed = false;
  const f = loopCloseFixture({
    path: fresh(),
    testStage: (stage) => {
      if (armed && stage === "STATE")
        f.repo.db.exec("INSERT INTO fault_space VALUES(zeroblob(1048576))");
    },
  });
  try {
    finishLoop(f, "21121");
    f.repo.db.exec("CREATE TABLE fault_space(body BLOB)");
    const limit = Number(
        f.repo.db.prepare("PRAGMA max_page_count").get()!.max_page_count,
      ),
      pages = Number(f.repo.db.prepare("PRAGMA page_count").get()!.page_count);
    f.repo.db.exec(`PRAGMA max_page_count=${pages + 16}`);
    const request = f.request(),
      expected = f.store.read(),
      before = dump(f.repo);
    armed = true;
    assert.throws(
      () => f.store.finalizeOperating("close", "period", request, expected),
      { code: "ERR_SQLITE_ERROR", errcode: 13 },
    );
    assert.equal(f.repo.db.isTransaction, false);
    assert.deepEqual(dump(f.repo), before);
    assert.equal(
      f.repo.db.prepare("SELECT count(*) AS n FROM fault_space").get()!.n,
      0,
    );
    armed = false;
    f.repo.db.exec(`PRAGMA max_page_count=${limit}`);
    const result = f.store.finalizeOperating(
      "close",
      "period",
      request,
      expected,
    );
    assert.equal(result.current.seed.ledger.lossStreak, 1);
    assert.deepEqual(
      f.store.finalizeOperating("retry", "period", request, expected).receipt,
      result.receipt,
    );
    verify(f.store);
  } finally {
    f.repo.close();
  }
});

for (const stage of ["STATE", "COMMITTED"] as const)
  test(
    `LC-16 owned process terminated at ${stage}: persisted request recovers whole close or none`,
    { timeout: 120000 },
    async () => {
      const path = fresh(),
        f = loopCloseFixture({ path });
      finishLoop(f, "21121");
      const intent = {
        config: f.c,
        commandId: "close",
        closeId: "period",
        request: f.request(),
        expected: f.store.read(),
      };
      // Test-only durable outbox; not a new product file/HTTP interface.
      writeFileSync(`${path}.intent.json`, JSON.stringify(intent), {
        flag: "wx",
      });
      f.repo.close();
      const child = spawn(
        process.execPath,
        [
          "scripts/cost-loop-close-crash-fixture.mjs",
          path,
          stage,
          new URL("../src/server/", import.meta.url).href,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr += chunk;
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
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(Error(`EARLY_EXIT:${code}:${stderr}`));
          });
        });
        const exited = once(child, "exit");
        child.kill();
        await exited;
        const repo = new Repository(path, () => 40000);
        repo.acquire();
        const saved = JSON.parse(
          readFileSync(`${path}.intent.json`, "utf8"),
        ) as {
          config: OperatingConfig;
          commandId: string;
          closeId: string;
          request: OperatingCloseRequest;
          expected: ReservationState;
        };
        const store = new CostReservationStore(repo, saved.config);
        try {
          assert.equal(
            store.read().finalization!.checkpoint !== null,
            stage === "COMMITTED",
          );
          assert.equal(
            store.read().seed.ledger.lossStreak,
            stage === "COMMITTED" ? 1 : 0,
          );
          const result = store.finalizeOperating(
            saved.commandId,
            saved.closeId,
            saved.request,
            saved.expected,
          );
          assert.equal(result.duplicate, stage === "COMMITTED");
          assert.equal(result.current.seed.ledger.lossStreak, 1);
          assert.equal(repo.verifyAudit(), result.current.revision + 1);
          const snapshot = dump(repo);
          assert.deepEqual(
            store.finalizeOperating(
              "retry",
              saved.closeId,
              saved.request,
              saved.expected,
            ).receipt,
            result.receipt,
          );
          assert.deepEqual(dump(repo), snapshot);
          verify(store);
        } finally {
          repo.close();
        }
      } finally {
        if (child.exitCode === null && !child.killed) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
      }
    },
  );

test("LC-17 legacy DB and standalone D8 cannot be reopened as the new contract", () => {
  const next = loopCloseProgram()
    .operatingLoop({ finalization: true })
    .config();
  for (const old of [
    loopCloseProgram().operatingLoop().config(),
    finalizationConfig(),
  ]) {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    try {
      const store = new CostReservationStore(repo, old, { initialize: true }),
        before = dump(repo),
        state = store.read();
      assert.throws(() => new CostReservationStore(repo, next).read());
      assert.deepEqual(dump(repo), before);
      assert.deepEqual(store.read(), state);
    } finally {
      repo.close();
    }
  }
});
