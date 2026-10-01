import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { hash } from "../src/core/policy.js";
import {
  partialConfig,
  closedPartial,
  partialCommand,
} from "./cost-partial-settlement-helpers.js";
import { openedOperating, op, record } from "./cost-operating-helpers.js";
import { finishPostClose } from "./cost-post-close-helpers.js";
import { tradePartialConfig } from "./cost-partial-settlement-helpers.js";
import { closedFixture } from "./cost-finalization-helpers.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";
const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "post-close-failure-")), "fixture.sqlite");
const dump = (repo: Repository) => ({
  data: dumpHandoff(repo),
  writer: repo.db.prepare("SELECT * FROM writer").all(),
});
for (const kind of ["PAY", "FILL"] as const)
  for (const stage of [
    "COMMAND",
    "APPROVALS",
    "FILL_INDEX",
    "STATE",
    "AUDIT",
  ] as const)
    test(`SA-08 ${kind}/${stage} rollback -> success -> duplicate equals one application`, () => {
      const c = kind === "FILL" ? tradePartialConfig() : partialConfig(),
        repo = new Repository(":memory:", () => 1000);
      repo.acquire();
      let armed = false;
      const store = new CostReservationStore(repo, c, {
        initialize: true,
        testStage: (s) => {
          if (armed && s === stage) throw Error("INJECTED_POST_CLOSE");
        },
      });
      const golden = openedOperating(c);
      try {
        const f = { repo, store, c };
        for (const fixture of [f, golden]) {
          if (kind === "FILL") closedFixture(fixture);
          else
            record(
              fixture.store,
              op(fixture.store.read(), "RECOGNIZE", "cost"),
            );
        }
        const s = finishPostClose(f).current;
        const goldenState = finishPostClose(golden).current;
        assert.deepEqual(s, goldenState);
        const index = 0;
        const e = partialCommand(s, index),
          before = dump(repo);
        const goldenResult = golden.store.settlePartial("pay", e, goldenState);
        armed = true;
        assert.throws(
          () => store.settlePartial("pay", e, s),
          /INJECTED_POST_CLOSE/,
        );
        assert.deepEqual(dump(repo), before);
        assert.deepEqual(store.read(), s);
        armed = false;
        const success = store.settlePartial("pay", e, s),
          onceOnly = dump(repo);
        assert.deepEqual(success, goldenResult);
        assert.deepEqual(dumpHandoff(repo), dumpHandoff(golden.repo));
        for (let i = 0; i < 3; i++) {
          const retry = store.settlePartial("pay", e, s);
          assert.deepEqual(retry.receipt, success.receipt);
          assert.deepEqual(retry.current, success.current);
        }
        assert.deepEqual(dump(repo), onceOnly);
        assert.equal(repo.verifyAudit(), success.current.revision + 1);
      } finally {
        repo.close();
        golden.repo.close();
      }
    });

test("SA-08 real SQLite FULL at partial state write retains primary error and exact retry", () => {
  const c = partialConfig(),
    repo = new Repository(fresh(), () => 1000);
  repo.acquire();
  let armed = false;
  const store = new CostReservationStore(repo, c, {
    initialize: true,
    testStage: (s) => {
      if (armed && s === "STATE")
        repo.db.exec("INSERT INTO fault_space VALUES(zeroblob(1048576))");
    },
  });
  try {
    record(store, op(store.read(), "RECOGNIZE", "cost"));
    const s = finishPostClose({ repo, store, c }).current,
      e = partialCommand(s);
    repo.db.exec("CREATE TABLE fault_space(body BLOB)");
    const limit = Number(
      repo.db.prepare("PRAGMA max_page_count").get()!.max_page_count,
    );
    const pages = Number(
      repo.db.prepare("PRAGMA page_count").get()!.page_count,
    );
    repo.db.exec(`PRAGMA max_page_count=${pages + 16}`);
    const before = dump(repo);
    armed = true;
    assert.throws(() => store.settlePartial("pay", e, s), {
      code: "ERR_SQLITE_ERROR",
      errcode: 13,
    });
    assert.equal(repo.db.isTransaction, false);
    assert.deepEqual(dump(repo), before);
    assert.equal(
      repo.db.prepare("SELECT count(*) n FROM fault_space").get()!.n,
      0,
    );
    armed = false;
    repo.db.exec(`PRAGMA max_page_count=${limit}`);
    const success = store.settlePartial("pay", e, s);
    assert.equal(success.current.partialSettlement!.events.length, 1);
    assert.equal(store.settlePartial("pay", e, s).duplicate, true);
  } finally {
    repo.close();
  }
});

interface Message {
  tag: string;
  error?: string;
  errcode?: number;
  duplicate?: boolean;
  count?: number;
  receipt?: { revision: number; stateHash: string };
  checkpointHash?: string;
  accounts?: {
    KRW: {
      cash: string;
      receivable: string;
      payable: string;
      availableCash: string;
    };
  };
}
function child(packet: string, mode: string) {
  const processChild = spawn(
    process.execPath,
    ["scripts/cost-partial-settlement-process-fixture.mjs", packet, mode],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  let terminalReceived = false;
  processChild.stderr!.on("data", (v) => {
    stderr += v;
  });
  const messages: Message[] = [],
    waiters: ((m: Message) => void)[] = [];
  processChild.on("message", (m) => {
    const value = m as Message;
    if (value.tag === "RESULT" || value.tag === "ERROR")
      terminalReceived = true;
    const resolve = waiters.shift();
    if (resolve) resolve(value);
    else messages.push(value);
  });
  const next = () =>
    new Promise<Message>((resolve, reject) => {
      const queued = messages.shift();
      if (queued) return resolve(queued);
      const timeout = setTimeout(
        () => reject(Error(`CHILD_TIMEOUT:${stderr}`)),
        30000,
      );
      waiters.push((m) => {
        clearTimeout(timeout);
        resolve(m);
      });
      processChild.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      processChild.once("exit", (code) => {
        clearTimeout(timeout);
        reject(Error(`CHILD_EARLY_EXIT:${code}:${stderr}`));
      });
    });
  const stop = async () => {
    if (processChild.exitCode === null && processChild.signalCode === null) {
      const done = once(processChild, "exit");
      // RESULT/ERROR precede the child's finally/lease release. Do not kill
      // that cleanup; only the deliberate STATE/COMMITTED pause is killed.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        processChild.kill();
      }, 5000);
      try {
        if (!terminalReceived) processChild.kill();
        await done;
        assert.equal(timedOut, false, `CHILD_CLEANUP_TIMEOUT:${stderr}`);
      } finally {
        clearTimeout(timer);
      }
    }
  };
  return { process: processChild, next, stop };
}
function packet() {
  const path = fresh(),
    f = closedPartial(path),
    expected = f.store.read();
  const request = {
    commandId: "pay",
    command: partialCommand(expected),
    expected,
  };
  const packetPath = `${path}.outbox.json`;
  // File-level durable fixture, not a product HTTP outbox implementation.
  writeFileSync(
    packetPath,
    JSON.stringify({ path, config: f.c, request, requestHash: hash(request) }),
    { flag: "wx", flush: true },
  );
  f.repo.close();
  return packetPath;
}
for (const stage of ["STATE", "COMMITTED"] as const)
  test(`SA-08 cold client/server restart after ${stage} recovers request from disk`, async () => {
    const file = packet(),
      first = child(file, stage);
    try {
      assert.equal((await first.next()).tag, stage);
      await first.stop();
      // New child knows only the outbox filename; no original request IPC/memory.
      const second = child(file, "RETRY");
      try {
        const result = await second.next();
        assert.equal(result.tag, "RESULT", JSON.stringify(result));
        assert.equal(result.duplicate, stage === "COMMITTED");
        assert.equal(result.count, 1);
        if (stage === "COMMITTED")
          assert.deepEqual(
            result.receipt,
            JSON.parse(readFileSync(`${file}.receipt`, "utf8")),
          );
      } finally {
        await second.stop();
      }
    } finally {
      await first.stop();
    }
  });

test("SA-04/05 actual competing processes serialize payment and reject conflicting takeover", async () => {
  const file = packet(),
    owner = child(file, "LOCK");
  try {
    assert.equal((await owner.next()).tag, "LOCKED");
    const contender = child(file, "PROBE");
    try {
      const result = await contender.next();
      assert.equal(result.tag, "ERROR");
      assert.equal(result.errcode, 5);
    } finally {
      await contender.stop();
    }
    writeFileSync(`${file}.release`, "release", { flag: "wx", flush: true });
    const first = await owner.next();
    assert.equal(first.tag, "RESULT", JSON.stringify(first));
    await owner.stop();
    const retry = child(file, "RETRY");
    try {
      const result = await retry.next();
      assert.equal(result.duplicate, true, JSON.stringify(result));
      assert.deepEqual(result.receipt, first.receipt);
    } finally {
      await retry.stop();
    }
    const conflict = child(file, "CONFLICT");
    try {
      const result = await conflict.next();
      assert.equal(result.tag, "ERROR");
      assert.match(result.error!, /BUSINESS_OR_SOURCE_CONFLICT/);
    } finally {
      await conflict.stop();
    }
  } finally {
    await owner.stop();
  }
});

for (const sameTarget of [false, true])
  test(`SA-05 actual payment processes contend; ${sameTarget ? "60+60 cannot exceed 100" : "each target settles once"}`, async () => {
    const path = fresh(),
      f = openedOperating(
        partialConfig(
          ["a", "b"].map((obligationId) => ({
            target: {
              kind: "OPERATING",
              obligationId: sameTarget ? "debt" : obligationId,
            },
            receivable: "0",
            payable: sameTarget ? "60" : "5",
          })),
        ),
        path,
      );
    for (const name of sameTarget ? ["debt"] : ["a", "b"])
      record(
        f.store,
        op(f.store.read(), "RECOGNIZE", name, sameTarget ? "100" : "5", name),
      );
    const expected = finishPostClose(f).current;
    const files = [0, 1].map((index) => {
      const file = `${path}.outbox-${index}.json`;
      const request = {
        commandId: `pay-${index}`,
        command: partialCommand(expected, index),
        expected,
      };
      writeFileSync(
        file,
        JSON.stringify({
          path,
          config: f.c,
          request,
          requestHash: hash(request),
        }),
        { flag: "wx", flush: true },
      );
      return file;
    });
    f.repo.close();
    const owner = child(files[0]!, "LOCK");
    try {
      assert.equal((await owner.next()).tag, "LOCKED");
      const contender = child(files[1]!, "PROBE");
      try {
        const result = await contender.next();
        assert.equal(result.tag, "ERROR");
        assert.equal(result.errcode, 5);
      } finally {
        await contender.stop();
      }
      writeFileSync(`${files[0]}.release`, "release", {
        flag: "wx",
        flush: true,
      });
      const first = await owner.next();
      assert.equal(first.tag, "RESULT", JSON.stringify(first));
      assert.equal(first.count, 1);
      await owner.stop();
      const stale = child(files[1]!, "RETRY");
      try {
        const result = await stale.next();
        assert.equal(result.tag, "ERROR");
        assert.match(result.error!, /REAPPROVAL/);
      } finally {
        await stale.stop();
      }
      const refreshed = child(files[1]!, "REFRESH");
      try {
        const result = await refreshed.next();
        if (sameTarget) {
          assert.equal(result.tag, "ERROR", JSON.stringify(result));
          assert.match(result.error!, /REMAINDER_EXCEEDED/);
        } else {
          assert.equal(result.tag, "RESULT", JSON.stringify(result));
          assert.equal(result.duplicate, false);
          assert.equal(result.count, 2);
          assert.deepEqual(result.accounts!.KRW, {
            ...expected.handoff!.accounts.KRW,
            cash: expected.handoff!.accounts.KRW.availableCash,
            payable: "0",
          });
          assert.equal(
            result.checkpointHash,
            hash(expected.finalization!.checkpoint),
          );
        }
      } finally {
        await refreshed.stop();
      }
      if (sameTarget) {
        const reader = new Repository(path, () => 60000);
        try {
          const state = new CostReservationStore(reader, f.c).read();
          assert.equal(state.partialSettlement!.events.length, 1);
          assert.equal(
            state.partialSettlement!.progress[0]!.remainingPayable,
            "40",
          );
          assert.equal(
            state.handoff!.accounts.KRW.cash,
            String(BigInt(expected.handoff!.accounts.KRW.cash) - 60n),
          );
          assert.deepEqual(
            state.finalization!.checkpoint,
            expected.finalization!.checkpoint,
          );
        } finally {
          reader.close();
        }
      }
    } finally {
      await owner.stop();
    }
  });
