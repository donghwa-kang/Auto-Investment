import { parentPort, workerData } from "node:worker_threads";
import { makeFixture, evaluateFixture } from "../core/fixture.js";
import { hash, configSchema } from "../core/policy.js";
const config = configSchema.parse(workerData.config);
const f = makeFixture(config);
const at =
  workerData.at ?? f.current.open + (config.scenario === "P" ? 60 : 45) * 60000;
parentPort!.postMessage({
  evaluation: evaluateFixture(f, at),
  session: f.current,
  dataHash: hash({ raw: f.raw, benchmark: f.benchmark }),
  at,
});
