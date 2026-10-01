import { fileURLToPath } from "node:url";
import { parseProbeCommand } from "../core/analysis-file-probe.js";
import { selfTestFileProbe } from "./analysis-file-probe-files.js";
try {
  const args = parseProbeCommand(process.argv.slice(2));
  const workspace = fileURLToPath(
    new URL("../../../../", import.meta.url),
  ).replace(/[\\/]$/, "");
  const result = await selfTestFileProbe(
    workspace,
    args.buildId,
    args.buildSha,
  );
  console.log(JSON.stringify(result));
  if (result.status !== "FILE_PROBE_SELF_TEST_PASSED") process.exitCode = 1;
} catch {
  console.error("FILE_PROBE_SELF_TEST_REJECTED");
  process.exitCode = 1;
}
