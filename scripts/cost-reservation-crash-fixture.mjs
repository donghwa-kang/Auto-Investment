import { Repository } from "../dist/runtime/src/server/repository.js";
import { CostReservationStore } from "../dist/runtime/src/server/cost-reservation-store.js";
import {
  reservationConfig,
  proposal,
} from "../dist/runtime/tests/cost-reservation-helpers.js";
const [path, stage] = process.argv.slice(2);
if (
  !path ||
  !["COMMAND", "APPROVALS", "STATE", "AUDIT", "COMMITTED"].includes(stage) ||
  !process.send
)
  throw Error("OWNED_RESERVATION_FIXTURE_ARGUMENTS");
const repo = new Repository(path, () => 1000);
repo.acquire();
let armed = false;
const store = new CostReservationStore(repo, reservationConfig(), {
  initialize: true,
  testStage: (s) => {
    if (armed && s === stage) {
      process.send({ stage });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
});
armed = true;
store.reserve("a", store.prepare(proposal(store)));
if (stage === "COMMITTED")
  process.send({ stage }, () =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0),
  );
