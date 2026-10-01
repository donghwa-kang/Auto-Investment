import { fileURLToPath } from "node:url";
import { parseProvisionCommand } from "../core/analysis-provision.js";
import {
  prepareProvision,
  checkProvision,
} from "./analysis-provision-files.js";
try {
  const command = parseProvisionCommand(process.argv.slice(2));
  const workspace = fileURLToPath(
    new URL("../../../../", import.meta.url),
  ).replace(/[\\/]$/, "");
  const result =
    command.action === "prepare"
      ? await prepareProvision(
          workspace,
          command.buildId,
          command.buildSha,
          command.probeBuildId,
          command.probeBuildSha,
        )
      : checkProvision(workspace, command.runId, command.manifestSha);
  console.log(JSON.stringify(result));
} catch {
  console.error("PROVISION_PREPARATION_REJECTED");
  process.exitCode = 1;
}
