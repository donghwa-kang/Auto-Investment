import { Repository } from "../dist/runtime/src/server/repository.js";
import { CostReservationStore } from "../dist/runtime/src/server/cost-reservation-store.js";
import {
  handoffConfig,
  transferred,
  fill,
  execute,
} from "../dist/runtime/tests/cost-handoff-helpers.js";
const [path, stage] = process.argv.slice(2);
if (
  !path ||
  !["FILL_INDEX", "STATE", "COMMITTED"].includes(stage) ||
  !process.send
)
  throw Error("OWNED_HANDOFF_FIXTURE_ARGUMENTS");
const repo = new Repository(path, () => 1000);
repo.acquire();
let armed = false;
const store = new CostReservationStore(repo, handoffConfig(), {
  initialize: true,
  testStage: (s) => {
    if (armed && s === stage) {
      process.send({ stage });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
});
const s = transferred(store);
armed = true;
execute(store, s, fill(s));
if (stage === "COMMITTED")
  process.send({ stage }, () =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0),
  );
