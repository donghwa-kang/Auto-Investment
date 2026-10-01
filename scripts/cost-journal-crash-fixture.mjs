import { Repository } from "../dist/runtime/src/server/repository.js";
import { CostJournal } from "../dist/runtime/src/server/cost-journal.js";
import {
  journalConfig,
  journalEvents,
} from "../dist/runtime/tests/cost-journal-helpers.js";
const [path, stage] = process.argv.slice(2);
if (
  !path ||
  !["EVENT", "FILL_INDEX", "STATE", "AUDIT", "COMMITTED"].includes(stage) ||
  !process.send
)
  throw Error("OWNED_JOURNAL_FIXTURE_ARGUMENTS");
const repo = new Repository(path, () => 1000);
repo.acquire();
let armed = false;
function stop() {
  process.send({ stage }, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
}
const store = new CostJournal(repo, journalConfig(), {
  initialize: true,
  testStage: (s) => {
    if (armed && s === stage) {
      // Signal the named stage, then freeze with its transaction still open.
      // The parent verifies receipt (or times out) and kills only this child.
      process.send({ stage });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
});
store.append(journalEvents()[0]);
armed = true;
store.append(journalEvents()[1]);
if (stage === "COMMITTED") stop();
