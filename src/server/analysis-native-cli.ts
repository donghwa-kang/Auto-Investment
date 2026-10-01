import { fileURLToPath } from "node:url";
import { parseNativeCommand } from "../core/analysis-native-contract.js";
import { checkPreparedNative } from "./analysis-native-runner.js";

try {
  const command = parseNativeCommand(process.argv.slice(2));
  const workspace = fileURLToPath(
    new URL("../../../../", import.meta.url),
  ).replace(/[\\/]$/, "");
  console.log(
    JSON.stringify(
      await checkPreparedNative(
        workspace,
        command.buildId,
        command.buildSha,
        command.runId,
        command.manifestSha,
      ),
    ),
  );
} catch {
  console.error("ANALYSIS_NATIVE_CHECK_REJECTED");
  process.exitCode = 1;
}
