import { fileURLToPath } from "node:url";
import { runBridgeSample } from "../dist/runtime/src/server/analysis-permission-bridge-runner.js";
const workspace = fileURLToPath(new URL("../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const [runId, planHash, buildId, buildHash, phase] = process.argv.slice(2);
if (
  process.argv.length !== 7 ||
  !["READY", "BEFORE_ACK", "AFTER_WRITE", "AFTER_ACK"].includes(phase) ||
  !process.send
)
  throw new Error("BRIDGE_CRASH_WORKER_ARGUMENTS");
await runBridgeSample(
  workspace,
  runId,
  planHash,
  buildId,
  buildHash,
  async (point, context, step) => {
    if (point === phase && step === 0) {
      process.send({ point, context });
      // Parent kills only this owned worker. The native peer has its own 5-second input deadline.
      await new Promise(() => {});
    }
  },
);
