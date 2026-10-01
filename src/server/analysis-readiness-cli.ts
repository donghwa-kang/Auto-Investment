import { fileURLToPath } from "node:url";
import {
  checkReadinessReport,
  collectReadiness,
} from "./analysis-readiness-files.js";
const workspace = fileURLToPath(
  new URL("../../../../", import.meta.url),
).replace(/[\\/]$/, "");
try {
  const args = process.argv.slice(2);
  let result;
  if (args.length === 7 && args[0] === "sample")
    result = await collectReadiness(
      workspace,
      args[1]!,
      args[2]!,
      args[3]!,
      args[4]!,
      args[5]!,
      args[6]!,
    );
  else if (args.length === 4 && args[0] === "check")
    result = checkReadinessReport(workspace, args[1]!, args[2]!, args[3]!);
  else throw new Error("READINESS_SAMPLE_CHECK_ONLY");
  console.log(JSON.stringify(result));
  process.exitCode = 2; // A recorded observation never means OS execution is approved.
} catch {
  console.error(
    JSON.stringify({
      status: "READINESS_OBSERVATION_HOLD",
      executionAllowed: false,
      osChangesApplied: false,
    }),
  );
  process.exitCode = 2;
}
