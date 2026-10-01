import { Repository } from "../dist/runtime/src/server/repository.js";
import { CostReservationStore } from "../dist/runtime/src/server/cost-reservation-store.js";
import {
  outcomeConfig,
  beginTrade,
  fillTrade,
  sellOrder,
  fillEvent,
} from "../dist/runtime/tests/cost-outcome-helpers.js";
const [path, stage] = process.argv.slice(2);
if (
  !path ||
  !["FILL_INDEX", "STATE", "AUDIT", "COMMITTED"].includes(stage) ||
  !process.send
)
  throw Error("OWNED_OUTCOME_FIXTURE_ARGUMENTS");
const repo = new Repository(path, () => 1000);
repo.acquire();
let armed = false;
const store = new CostReservationStore(repo, outcomeConfig(), {
  initialize: true,
  testStage: (s) => {
    if (armed && s === stage) {
      process.send({ stage });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
});
const run = beginTrade(store);
fillTrade(store, run);
const s = sellOrder(store, run, "10000"),
  e = fillEvent(s, run, "exit");
armed = true;
store.execute("close", run, e, s);
if (stage === "COMMITTED")
  process.send({ stage }, () =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0),
  );
