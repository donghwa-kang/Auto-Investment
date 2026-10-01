import { fileURLToPath } from "node:url";
import { parseLaunchCommand } from "../core/analysis-launch-plan.js";
import {
  checkAnalysisLaunch,
  prepareAnalysisLaunch,
} from "./analysis-launch-files.js";

try {
  // 임의 경로/execute/approve/setup는 파일 작업 전에 거절. 네이티브 호출 경로는 없다.
  const command = parseLaunchCommand(process.argv.slice(2));
  const workspace = fileURLToPath(
    new URL("../../../../", import.meta.url),
  ).replace(/[\\/]$/, "");
  const result =
    command.action === "prepare"
      ? prepareAnalysisLaunch(workspace)
      : checkAnalysisLaunch(workspace, command.runId, command.manifestSha256);
  console.log(JSON.stringify(result));
} catch {
  console.error("ANALYSIS_LAUNCH_PREPARATION_REJECTED");
  process.exitCode = 1;
}
