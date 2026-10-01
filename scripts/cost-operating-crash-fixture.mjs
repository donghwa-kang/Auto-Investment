import { Repository } from "../dist/runtime/src/server/repository.js";
import { CostReservationStore } from "../dist/runtime/src/server/cost-reservation-store.js";
import {
  operatingConfig,
  op,
  record,
} from "../dist/runtime/tests/cost-operating-helpers.js";
const [path, stage] = process.argv.slice(2);
if (!path || !["STATE", "COMMITTED"].includes(stage) || !process.send)
  throw Error("OWNED_OPERATING_FIXTURE_ARGUMENTS");
const repo = new Repository(path, () => 1000);
repo.acquire();
let armed = false;
const store = new CostReservationStore(repo, operatingConfig(), {
  initialize: true,
  testStage: (s) => {
    if (armed && s === stage) {
      process.send({ stage });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
});
let s = record(store, op(store.read(), "RESERVE", "reserved"));
s = record(store, op(s, "RECOGNIZE", "cost", "50", "debt", "reserved"));
armed = true;
record(store, op(s, "PAY", "pay"));
if (stage === "COMMITTED")
  process.send({ stage }, () =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0),
  );
