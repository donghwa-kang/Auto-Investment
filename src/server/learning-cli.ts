import { randomUUID } from "node:crypto";
import { assertOffline, verifyPolicies } from "../core/policy.js";
import { createLearningSample } from "../core/learning-sample.js";
import {
  learningId,
  LearningError,
  parseLearningInput,
} from "../core/learning-schema.js";
import { CatalogError } from "../core/catalog-schema.js";
import { readCatalogFile } from "./catalog-file.js";
import { saveLearningJson } from "./learning-files.js";
import { LearningRegistry } from "./learning-registry.js";

let registry: LearningRegistry | undefined;
try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  verifyPolicies();
  const [command, value] = process.argv.slice(2);
  if (command === "sample" && process.argv.length === 3) {
    const input = createLearningSample(`learning-${randomUUID()}`);
    console.log(
      JSON.stringify({
        result: "LEARNING_SAMPLE_CREATED",
        experimentId: input.experimentId,
        inputPath: saveLearningJson(input, "learning-inputs"),
        purpose: "TEST_ONLY",
        liveEnabled: false,
      }),
    );
  } else if (command === "register" && process.argv.length === 4) {
    const input = parseLearningInput(readCatalogFile(value!));
    registry = new LearningRegistry();
    console.log(
      JSON.stringify({
        result: "LEARNING_REGISTERED",
        ...registry.register(input),
        databasePath: registry.path,
        purpose: "TEST_ONLY",
        automaticPromotion: false,
        liveEnabled: false,
      }),
    );
  } else if (
    (command === "run" || command === "status") &&
    process.argv.length === 4 &&
    learningId.safeParse(value).success
  ) {
    registry = new LearningRegistry(process.cwd(), false);
    if (command === "status")
      console.log(
        JSON.stringify({
          result: "LEARNING_STATUS",
          ...registry.status(value!),
          liveEnabled: false,
        }),
      );
    else {
      const { report, reused } = registry.run(value!);
      console.log(
        JSON.stringify({
          result: "LEARNING_RESEARCH_COMPLETE",
          experimentId: value,
          status: report.status,
          reused,
          reportHash: report.reportHash,
          reportPath: saveLearningJson(report, "learning-reports"),
          eligible: report.dataset.eligible,
          excluded: report.dataset.excluded,
          folds: report.folds.length,
          purpose: "TEST_ONLY",
          forecastValidated: false,
          profitabilityValidated: false,
          automaticPromotion: false,
          paperOrdersEnabled: false,
          liveEnabled: false,
          networkRequests: 0,
        }),
      );
    }
  } else throw new LearningError("LEARNING_ARGUMENTS_INVALID");
} catch (error) {
  console.error(
    error instanceof LearningError || error instanceof CatalogError
      ? error.code
      : "LEARNING_COMMAND_FAILED",
  );
  process.exitCode = 1;
} finally {
  registry?.close();
}
