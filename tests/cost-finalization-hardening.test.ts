import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Serializable } from "node:child_process";
import { once } from "node:events";
import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import type { ReservationWriteStage } from "../src/server/cost-reservation-store.js";
import { hash } from "../src/core/policy.js";
import { postCloseInputLimit } from "../src/core/cost-finalization.js";
import {
  finalizationConfig,
  closedFixture,
  closeRequest,
} from "./cost-finalization-helpers.js";
import { openedOperating, op } from "./cost-operating-helpers.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";

const fresh = () =>
  join(
    mkdtempSync(join(tmpdir(), "finalization-hardening-")),
    "fixture.sqlite",
  );
const dump = (repo: Repository) => ({
  data: dumpHandoff(repo),
  writer: repo.db.prepare("SELECT * FROM writer").all(),
});
type Kind = "RECOGNIZE" | "PAY" | "CLOSE" | "RAW";
function fixture(kind: Kind, stage?: ReservationWriteStage) {
  const c = finalizationConfig(),
    repo = new Repository(":memory:", () => 1000);
  repo.acquire();
  let armed = false;
  const store = new CostReservationStore(repo, c, {
    initialize: true,
    testStage: (s) => {
      if (armed && s === stage) throw Error("INJECTED_RETRY_FAILURE");
    },
  });
  const f = { repo, store, c };
  closedFixture(f);
  if (kind === "RECOGNIZE")
    store.operating(
      "extra-reserve",
      op(store.read(), "RESERVE", "extra-reserve", "3", "extra-debt"),
      store.read(),
    );
  if (kind === "RAW")
    store.finalizeOperating("close", "period", closeRequest(f), store.read());
  const before = store.read(),
    request = kind === "CLOSE" ? closeRequest(f) : null;
  const event = op(
    before,
    kind === "PAY" ? "PAY" : "RECOGNIZE",
    "event",
    "3",
    kind === "PAY" ? "debt" : "extra-debt",
    kind === "RECOGNIZE" ? "extra-reserve" : null,
  );
  const attempt = () =>
    kind === "CLOSE"
      ? store.finalizeOperating("retry-test", "period", request, before)
      : kind === "RAW"
        ? store.postCloseInput("retry-test", "{}", before.seed.clock, before)
        : store.operating("retry-test", event, before);
  return {
    ...f,
    before,
    attempt,
    arm: (value: boolean) => {
      armed = value;
    },
  };
}
for (const kind of ["RECOGNIZE", "PAY", "CLOSE", "RAW"] as const)
  for (const stage of [
    "COMMAND",
    "APPROVALS",
    "FILL_INDEX",
    "STATE",
    "AUDIT",
  ] as const)
    test(`FH-01 ${kind}/${stage} failure -> success -> duplicate equals single success`, () => {
      const actual = fixture(kind, stage),
        golden = fixture(kind);
      try {
        const before = dump(actual.repo);
        actual.arm(true);
        assert.throws(actual.attempt, /INJECTED_RETRY_FAILURE/);
        assert.deepEqual(dump(actual.repo), before);
        actual.arm(false);
        const success = actual.attempt(),
          expected = golden.attempt();
        assert.equal(success.duplicate, false);
        assert.deepEqual(success, expected);
        assert.deepEqual(dumpHandoff(actual.repo), dumpHandoff(golden.repo));
        const onceOnly = dump(actual.repo);
        for (let i = 0; i < 3; i++) {
          const retry = actual.attempt();
          assert.equal(retry.duplicate, true);
          assert.deepEqual(retry.receipt, success.receipt);
          assert.deepEqual(retry.current, success.current);
        }
        assert.deepEqual(dump(actual.repo), onceOnly);
        assert.equal(actual.repo.verifyAudit(), success.current.revision + 1);
      } finally {
        actual.repo.close();
        golden.repo.close();
      }
    });

test("FH-02 real SQLite FULL preserves the primary error, rolls back, and permits exact retry", () => {
  const c = finalizationConfig(),
    repo = new Repository(fresh(), () => 1000);
  repo.acquire();
  let armed = false;
  const store = new CostReservationStore(repo, c, {
    initialize: true,
    testStage: (stage) => {
      if (armed && stage === "STATE")
        repo.db.exec("INSERT INTO fault_space VALUES(zeroblob(1048576))");
    },
  });
  try {
    const f = { repo, store, c };
    closedFixture(f);
    repo.db.exec("CREATE TABLE fault_space(body BLOB)");
    const limit = Number(
      repo.db.prepare("PRAGMA max_page_count").get()!.max_page_count,
    );
    const pages = Number(
      repo.db.prepare("PRAGMA page_count").get()!.page_count,
    );
    repo.db.exec(`PRAGMA max_page_count=${pages + 16}`);
    const before = store.read(),
      request = closeRequest(f),
      rows = dump(repo);
    armed = true;
    assert.throws(
      () => store.finalizeOperating("close", "period", request, before),
      { code: "ERR_SQLITE_ERROR", errcode: 13 },
    );
    assert.equal(repo.db.isTransaction, false);
    assert.deepEqual(dump(repo), rows);
    assert.equal(
      repo.db.prepare("SELECT COUNT(*) AS n FROM fault_space").get()!.n,
      0,
    );
    armed = false;
    repo.db.exec(`PRAGMA max_page_count=${limit}`);
    const result = store.finalizeOperating("close", "period", request, before);
    assert.equal(result.duplicate, false);
    assert.equal(result.current.seed.ledger.lossStreak, 1);
    const replay = store.finalizeOperating("close", "period", request, before);
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.receipt, result.receipt);
  } finally {
    repo.close();
  }
});

test(
  "FH-03 actual Store saturation and rejection preserve money, rows and DB/WAL size",
  { timeout: 120000 },
  (t) => {
    const path = fresh(),
      f = openedOperating(finalizationConfig(), path);
    try {
      const req = closeRequest(f),
        closed = f.store.finalizeOperating(
          "close",
          "period",
          req,
          f.store.read(),
        ).current;
      let state = closed;
      const raw = "가".repeat(2728) + "12345678";
      assert.equal(Buffer.byteLength(raw), 8192);
      const start = performance.now();
      let lastBefore = state;
      for (let i = 0; i < postCloseInputLimit; i++) {
        lastBefore = state;
        state = f.store.postCloseInput(
          `raw-${i}`,
          raw,
          state.seed.clock,
          state,
        ).current;
      }
      const fillMs = performance.now() - start;
      assert.equal(state.finalization!.rejectedInputs.length, 100);
      assert.deepEqual(
        state.finalization!.checkpoint,
        closed.finalization!.checkpoint,
      );
      assert.deepEqual(state.handoff!.accounts, closed.handoff!.accounts);
      assert.deepEqual(state.operating, closed.operating);
      assert.equal(state.seed.ledger.lossStreak, closed.seed.ledger.lossStreak);
      const rows = dump(f.repo),
        sizes = () =>
          [path, `${path}-wal`].map((p) =>
            existsSync(p) ? statSync(p).size : 0,
          );
      const beforeSizes = sizes(),
        rejectStart = performance.now();
      for (let i = 0; i < 128; i++)
        assert.throws(
          () =>
            f.store.postCloseInput(
              `overflow-${i}`,
              raw,
              state.seed.clock,
              state,
            ),
          /POST_CLOSE_INPUT_LIMIT/,
        );
      const rejectMs = performance.now() - rejectStart;
      assert.deepEqual(dump(f.repo), rows);
      assert.deepEqual(sizes(), beforeSizes);
      // Existing receipt is still recoverable even when the intake is full.
      const retry = f.store.postCloseInput(
        "raw-99",
        raw,
        lastBefore.seed.clock,
        lastBefore,
      );
      assert.equal(retry.duplicate, true);
      assert.equal(retry.receipt.stateHash, hash(state));
      assert.deepEqual(
        f.store.finalizeOperating("close-retry", "period", req, closed).current,
        state,
      );
      assert.deepEqual(f.store.read(), state);
      const reopened = new Repository(path, () => 20000);
      reopened.acquire();
      try {
        const store = new CostReservationStore(reopened, f.c);
        assert.deepEqual(store.read(), state);
        assert.throws(
          () =>
            store.postCloseInput("after-restart", raw, state.seed.clock, state),
          /POST_CLOSE_INPUT_LIMIT/,
        );
        const persisted = dump(reopened);
        // Fast rejection is not acceptance of an unverified cache. Reads and
        // historical receipt recovery must still fail on checksum corruption.
        reopened.db.exec("UPDATE cost_reservation_run SET checksum='corrupt'");
        assert.throws(() => store.read(), /LOCAL_/);
        assert.throws(
          () =>
            store.postCloseInput(
              "raw-99",
              raw,
              lastBefore.seed.clock,
              lastBefore,
            ),
          /LOCAL_/,
        );
        assert.throws(
          () =>
            store.postCloseInput(
              "corrupt-overflow",
              raw,
              state.seed.clock,
              state,
            ),
          /POST_CLOSE_INPUT_LIMIT/,
        );
        assert.deepEqual(dump(reopened).data.slice(1), persisted.data.slice(1));
      } finally {
        reopened.close();
      }
      t.diagnostic(
        JSON.stringify({
          fillMs,
          rejected: 128,
          rejectMs,
          dbBytes: beforeSizes[0],
          walBytes: beforeSizes[1],
        }),
      );
    } finally {
      f.repo.close();
    }
  },
);

// Local IPC only. Each child and DB belongs to this test; no broker or HTTP API.
function peer(path: string, role: string) {
  const child = spawn(
    process.execPath,
    ["scripts/cost-finalization-contention-fixture.mjs", path, role],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr!.on("data", (b) => {
    stderr += b;
  });
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const messages = new Map<string, unknown>();
  child.on("message", (raw) => {
    const m = raw as { tag: string };
    const waiter = pending.get(m.tag);
    if (waiter) {
      pending.delete(m.tag);
      waiter.resolve(raw);
    } else messages.set(m.tag, raw);
  });
  const fail = (e: Error) => {
    for (const w of pending.values()) w.reject(e);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code) => fail(Error(`CHILD_EXIT:${code}:${stderr}`)));
  return {
    child,
    send: (message: Serializable) => child.send(message),
    wait: async (tag: string) => {
      if (messages.has(tag))
        return messages.get(tag) as Record<string, unknown>;
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(tag);
          reject(Error(`CHILD_TIMEOUT:${tag}:${stderr}`));
        }, 30000);
        pending.set(tag, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      });
      return result as Record<string, unknown>;
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    },
  };
}

test(
  "FH-04 real process lock contention plus queued identical/altered close requests apply once",
  { timeout: 60000 },
  async () => {
    const path = fresh(),
      f = openedOperating(finalizationConfig(), path);
    closedFixture(f);
    const expected = f.store.read(),
      request = closeRequest(f),
      revision = expected.revision;
    f.repo.close();
    const owner = peer(path, "OWNER"),
      competitor = peer(path, "CONTENDER");
    try {
      await Promise.all([owner.wait("READY"), competitor.wait("READY")]);
      const input = {
        commandId: "close",
        closeId: "period",
        request,
        expected,
      };
      owner.send({ tag: "FIRST", ...input, block: true });
      await owner.wait("LOCKED");
      owner.send({
        tag: "DUPLICATE",
        ...input,
        commandId: "same-close-new-command",
      });
      owner.send({
        tag: "ALTERED",
        ...input,
        request: { ...request, asOf: request.asOf + 1 },
      });
      competitor.send({ tag: "CONTEND" });
      const blocked = await competitor.wait("CONTEND");
      assert.equal(blocked.errcode, 5);
      writeFileSync(`${path}.release`, "test-owned lock release", {
        flag: "wx",
      });
      const first = await owner.wait("FIRST"),
        duplicate = await owner.wait("DUPLICATE"),
        altered = await owner.wait("ALTERED");
      assert.equal(first.duplicate, false);
      assert.equal(duplicate.duplicate, true);
      assert.deepEqual(duplicate.receipt, first.receipt);
      assert.match(
        String(altered.error),
        /FINALIZATION_ID_OR_CONTENT_CONFLICT/,
      );
      owner.send({ tag: "INSPECT" });
      const result = await owner.wait("INSPECT");
      assert.equal(result.revision, revision + 1);
      assert.equal(result.closeCount, 1);
      assert.equal(result.lossStreak, 1);
      assert.equal(result.auditCount, revision + 2);
      assert.equal(result.inTransaction, false);
      competitor.send({ tag: "TAKEOVER", ...input });
      const taken = await competitor.wait("TAKEOVER");
      assert.equal(taken.duplicate, true);
      assert.deepEqual(taken.receipt, first.receipt);
      competitor.send({
        tag: "NEW_OWNER_ALTERED",
        ...input,
        request: { ...request, asOf: request.asOf + 1 },
      });
      assert.match(
        String((await competitor.wait("NEW_OWNER_ALTERED")).error),
        /FINALIZATION_ID_OR_CONTENT_CONFLICT/,
      );
      owner.send({ tag: "FENCED_RETRY", ...input });
      assert.match(
        String((await owner.wait("FENCED_RETRY")).error),
        /FENCED_WRITER/,
      );
      competitor.send({ tag: "INSPECT" });
      assert.deepEqual(await competitor.wait("INSPECT"), result);
    } finally {
      await Promise.all([owner.stop(), competitor.stop()]);
    }
  },
);

test(
  "FH-05 caller-retained request survives lost response and process restart",
  { timeout: 60000 },
  async () => {
    const path = fresh(),
      f = openedOperating(finalizationConfig(), path);
    closedFixture(f);
    const expected = f.store.read(),
      request = closeRequest(f);
    // The caller keeps these BEFORE dispatch, never rebuilding asOf/manifest/ID.
    const original = JSON.parse(JSON.stringify({ expected, request })) as {
      expected: typeof expected;
      request: typeof request;
    };
    f.repo.close();
    const owner = peer(path, "OWNER");
    try {
      await owner.wait("READY");
      owner.send({
        tag: "LOST",
        commandId: "close",
        closeId: "period",
        ...original,
        loseResponse: true,
      });
      // Test-only commit marker contains no receipt or financial state.
      assert.deepEqual(await owner.wait("RESPONSE_DROPPED"), {
        tag: "RESPONSE_DROPPED",
      });
    } finally {
      await owner.stop();
    }
    const repo = new Repository(path, () => 40000);
    repo.acquire();
    const store = new CostReservationStore(repo, finalizationConfig());
    try {
      const storedReceipt = JSON.parse(
        String(
          repo.db
            .prepare(
              "SELECT receipt FROM cost_reservation_commands WHERE id='close'",
            )
            .get()!.receipt,
        ),
      ) as unknown;
      const rows = dumpHandoff(repo);
      for (const commandId of ["close", "fresh-delivery"]) {
        const recovered = store.finalizeOperating(
          commandId,
          "period",
          original.request,
          original.expected,
        );
        assert.equal(recovered.duplicate, true);
        assert.deepEqual(recovered.receipt, storedReceipt);
        assert.equal(recovered.current.seed.ledger.lossStreak, 1);
        assert.equal(recovered.current.revision, expected.revision + 1);
      }
      assert.deepEqual(dumpHandoff(repo), rows);
    } finally {
      repo.close();
    }
  },
);

for (const boundary of ["acquire", "legacy"] as const)
  test(`FH-06 ${boundary} automatic rollback preserves cause and recovers`, () => {
    const repo = new Repository(":memory:", () => 1000);
    try {
      const table = boundary === "acquire" ? "writer" : "aggregate";
      if (boundary === "legacy") repo.acquire();
      repo.db.exec(
        `CREATE TRIGGER automatic_rollback BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ROLLBACK,'TEST_AUTO_ROLLBACK'); END`,
      );
      const attempt = () =>
        boundary === "acquire"
          ? repo.acquire()
          : repo.transact("test", {}, () =>
              structuredClone(finalizationConfig().seed),
            );
      assert.throws(attempt, /TEST_AUTO_ROLLBACK/);
      assert.equal(repo.db.isTransaction, false);
      assert.equal(
        repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
        0,
      );
      repo.db.exec("DROP TRIGGER automatic_rollback");
      attempt();
      assert.equal(
        repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
        1,
      );
    } finally {
      repo.close();
    }
  });
