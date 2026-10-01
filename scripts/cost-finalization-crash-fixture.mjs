import { Repository } from "../dist/runtime/src/server/repository.js";
import { CostReservationStore } from "../dist/runtime/src/server/cost-reservation-store.js";
import {
  finalizationConfig,
  closedFixture,
  closeRequest,
} from "../dist/runtime/tests/cost-finalization-helpers.js";
const [path, stage] = process.argv.slice(2);
if (!path || !["STATE", "COMMITTED"].includes(stage) || !process.send)
  throw Error("OWNED_FINALIZATION_FIXTURE_ARGUMENTS");
const repo = new Repository(path, () => 1000);
repo.acquire();
let armed = false;
const c = finalizationConfig(),
  store = new CostReservationStore(repo, c, {
    initialize: true,
    testStage: (s) => {
      if (armed && s === stage) {
        process.send({ stage });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    },
  });
const fixture = { repo, store, c };
closedFixture(fixture);
const state = store.read(),
  request = closeRequest(fixture);
armed = true;
store.finalizeOperating("close", "period", request, state);
if (stage === "COMMITTED")
  process.send({ stage }, () =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0),
  );
