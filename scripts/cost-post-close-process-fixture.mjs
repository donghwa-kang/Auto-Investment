import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Repository } from "../dist/runtime/src/server/repository.js";
import { CostReservationStore } from "../dist/runtime/src/server/cost-reservation-store.js";
import { hash } from "../dist/runtime/src/core/policy.js";
const [packetPath, mode] = process.argv.slice(2);
if (
  !process.send ||
  !packetPath ||
  ![
    "STATE",
    "COMMITTED",
    "LOCK",
    "PROBE",
    "RETRY",
    "CONFLICT",
    "REFRESH",
  ].includes(mode)
)
  throw Error("OWNED_POST_CLOSE_FIXTURE_ARGUMENTS");
// Original request persisted by the test caller BEFORE dispatch. Recovery
// loads this file in a new process, never the failed client's memory.
const packet = JSON.parse(readFileSync(packetPath, "utf8"));
if (hash(packet.request) !== packet.requestHash)
  throw Error("TEST_OUTBOX_CORRUPT");
const repo = new Repository(packet.path, () =>
  ["STATE", "COMMITTED", "LOCK"].includes(mode) ? 20000 : 40000,
);
const pause = () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  throw Error("TEST_KILL_TIMEOUT");
};
try {
  repo.acquire();
  const store = new CostReservationStore(repo, packet.config, {
    testStage: (stage) => {
      if (stage !== "STATE") return;
      if (mode === "STATE") {
        process.send({ tag: "STATE" });
        pause();
      }
      if (mode === "LOCK") {
        process.send({ tag: "LOCKED" });
        const deadline = Date.now() + 30000;
        while (!existsSync(`${packetPath}.release`)) {
          if (Date.now() >= deadline) throw Error("TEST_RELEASE_TIMEOUT");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
    },
  });
  const { commandId, command, expected } = packet.request;
  const result = store.settlePostClose(
    mode === "CONFLICT" ? "conflict" : commandId,
    mode === "CONFLICT"
      ? { ...command, sourceHash: hash("modified") }
      : command,
    mode === "REFRESH" ? store.read() : expected,
  );
  if (["COMMITTED", "LOCK"].includes(mode))
    writeFileSync(`${packetPath}.receipt`, JSON.stringify(result.receipt), {
      flag: "wx",
      flush: true,
    });
  if (mode === "COMMITTED") {
    process.send({ tag: "COMMITTED" });
    pause();
  }
  process.send({
    tag: "RESULT",
    duplicate: result.duplicate,
    receipt: result.receipt,
    count: result.current.postClose.events.length,
    checkpointHash: hash(result.current.finalization.checkpoint),
    accounts: result.current.handoff.accounts,
  });
} catch (error) {
  process.send({
    tag: "ERROR",
    error: error.message,
    errcode: error.errcode ?? null,
  });
} finally {
  repo.close();
  process.disconnect();
}
