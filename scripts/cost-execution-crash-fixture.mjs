import { CostExecutionStore } from "../dist/runtime/src/server/cost-execution-store.js";
import {
  executionConfig,
  executionEvents,
} from "../dist/runtime/tests/cost-execution-helpers.js";
const [path, rawPrefix] = process.argv.slice(2);
const prefix = Number(rawPrefix);
if (!path || ![3, 5].includes(prefix) || !process.send) {
  throw Error("OWNED_COST_FIXTURE_ARGUMENTS");
}
const store = new CostExecutionStore(executionConfig(), path);
for (const event of executionEvents().slice(0, prefix)) store.append(event);
process.send(store.read());
// Keep only this owned test process alive until its parent kills it.
setInterval(() => {}, 1000);
