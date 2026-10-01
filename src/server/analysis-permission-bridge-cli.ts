import { fileURLToPath } from "node:url";
import { checkBridgeRun } from "./analysis-permission-bridge-files.js";
import { runBridgeSample } from "./analysis-permission-bridge-runner.js";
const workspace = fileURLToPath(
  new URL("../../../../", import.meta.url),
).replace(/[\\/]$/, "");
try {
  const args = process.argv.slice(2);
  let result;
  if (args.length === 5 && args[0] === "sample")
    result = await runBridgeSample(
      workspace,
      args[1]!,
      args[2]!,
      args[3]!,
      args[4]!,
    );
  else if (args.length === 4 && args[0] === "check")
    result = checkBridgeRun(workspace, args[1]!, args[2]!, args[3]!);
  else throw new Error("BRIDGE_SAMPLE_CHECK_ONLY");
  console.log(JSON.stringify(result));
  if (result.status === "RECOVERY_HOLD") process.exitCode = 2;
} catch {
  console.error(
    JSON.stringify({
      status: "BRIDGE_HOLD",
      executionAllowed: false,
      osChangesApplied: false,
      osRecoveryVerified: false,
    }),
  );
  process.exitCode = 2;
}
