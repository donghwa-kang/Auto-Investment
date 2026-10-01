import { existsSync } from "node:fs";
import { Repository } from "../dist/runtime/src/server/repository.js";
import { CostReservationStore } from "../dist/runtime/src/server/cost-reservation-store.js";
import { finalizationConfig } from "../dist/runtime/tests/cost-finalization-helpers.js";

const [path, role] = process.argv.slice(2);
if (!process.send || !path || !["OWNER", "CONTENDER"].includes(role))
  throw Error("TEST_IPC_REQUIRED");
const repo = new Repository(path, () => (role === "OWNER" ? 20000 : 40000));
let block = false;
const send = (message) => process.send(message);
if (role === "OWNER") repo.acquire();
let store =
  role === "OWNER"
    ? new CostReservationStore(repo, finalizationConfig(), {
        testStage: (stage) => {
          if (block && stage === "STATE") {
            send({ tag: "LOCKED" });
            const deadline = Date.now() + 30000,
              gate = new Int32Array(new SharedArrayBuffer(4));
            while (!existsSync(`${path}.release`)) {
              if (Date.now() >= deadline) throw Error("TEST_RELEASE_TIMEOUT");
              Atomics.wait(gate, 0, 0, 25);
            }
          }
        },
      })
    : null;
process.on("message", (message) => {
  try {
    if (role === "CONTENDER" && message.tag === "CONTEND") {
      repo.acquire();
      send({ tag: message.tag, acquired: true });
      return;
    }
    if (role === "CONTENDER" && message.tag === "TAKEOVER") {
      repo.acquire();
      store = new CostReservationStore(repo, finalizationConfig());
    }
    if (!store) throw Error("TEST_STORE_NOT_READY");
    if (message.tag === "INSPECT") {
      const s = store.read();
      send({
        tag: message.tag,
        revision: s.revision,
        lossStreak: s.seed.ledger.lossStreak,
        auditCount: repo.verifyAudit(),
        inTransaction: repo.db.isTransaction,
        closeCount: repo.db
          .prepare(
            "SELECT COUNT(*) AS n FROM cost_reservation_commands WHERE json_extract(body,'$.command.kind')='FINALIZE_OPERATING'",
          )
          .get().n,
      });
      return;
    }
    block = message.block === true;
    const result = store.finalizeOperating(
      message.commandId,
      message.closeId,
      message.request,
      message.expected,
    );
    if (message.loseResponse) send({ tag: "RESPONSE_DROPPED" });
    else
      send({
        tag: message.tag,
        duplicate: result.duplicate,
        receipt: result.receipt,
      });
  } catch (error) {
    send({
      tag: message.tag,
      error: String(error.message),
      errcode: error.errcode ?? null,
    });
  }
});
send({ tag: "READY" });
