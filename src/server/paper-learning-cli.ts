import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { assertOffline, verifyPolicies } from "../core/policy.js";
import { PaperLearningError } from "../core/paper-learning-schema.js";
import { LearningError } from "../core/learning-schema.js";
import { convertPaperLearning } from "../core/paper-learning.js";
import { CatalogError } from "../core/catalog-schema.js";
import { PortfolioProgram } from "../core/portfolio-program.js";
import { PortfolioPaperEngine } from "./portfolio-engine.js";
import { loadPortfolioPlan } from "./portfolio-file.js";
import { readCatalogFile } from "./catalog-file.js";
import { saveLearningJson } from "./learning-files.js";
import { exportPaperLearning } from "./paper-learning-export.js";

let engine: PortfolioPaperEngine | undefined;
try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  verifyPolicies();
  const [command, value, planPath] = process.argv.slice(2);
  if (command === "record" && process.argv.length === 4) {
    const { plan, input } = loadPortfolioPlan(value!);
    const program = new PortfolioProgram(input, plan.settings);
    const root = resolve("data", "paper-learning-runs");
    mkdirSync(root, { recursive: true });
    const databasePath = resolve(
      mkdtempSync(resolve(root, "run-")),
      "paper.sqlite",
    );
    engine = new PortfolioPaperEngine(program, databasePath, {
      captureLearning: true,
    });
    for (const [i, c] of plan.commands.entries())
      engine.command(`plan-${i}`, c);
    engine.close();
    engine = undefined;
    const source = exportPaperLearning(databasePath),
      exportPath = saveLearningJson(source, "paper-learning-exports");
    console.log(
      JSON.stringify({
        result: "PAPER_LEARNING_RECORDED",
        databasePath,
        exportPath,
        sourceDecisions: source.journal.decisions.length,
        fillEvents: source.journal.fills.length,
        closedPositions: source.journal.closures.length,
        purpose: "TEST_ONLY",
        liveEnabled: false,
        networkRequests: 0,
      }),
    );
  } else if (command === "export" && process.argv.length === 4) {
    const source = exportPaperLearning(value!);
    console.log(
      JSON.stringify({
        result: "PAPER_LEARNING_EXPORTED",
        exportPath: saveLearningJson(source, "paper-learning-exports"),
        exportHash: source.exportHash,
        purpose: "TEST_ONLY",
        liveEnabled: false,
        networkRequests: 0,
      }),
    );
  } else if (command === "convert" && process.argv.length === 5) {
    const { input, report } = convertPaperLearning(
      readCatalogFile(value!),
      readCatalogFile(planPath!),
    );
    const inputPath = input ? saveLearningJson(input, "learning-inputs") : null;
    const reportPath = saveLearningJson(report, "paper-learning-conversions");
    console.log(
      JSON.stringify({
        result: "PAPER_LEARNING_CONVERTED",
        status: report.status,
        inputPath,
        reportPath,
        experimentId: input?.experimentId ?? null,
        convertedDecisions: report.convertedDecisions,
        closedOutcomes: report.closedOutcomes,
        purpose: "TEST_ONLY",
        automaticPromotion: false,
        liveEnabled: false,
        networkRequests: 0,
      }),
    );
  } else throw new PaperLearningError("PAPER_LEARNING_ARGUMENTS_INVALID");
} catch (error) {
  console.error(
    error instanceof PaperLearningError ||
      error instanceof LearningError ||
      error instanceof CatalogError
      ? error.code
      : "PAPER_LEARNING_COMMAND_FAILED",
  );
  process.exitCode = 1;
} finally {
  engine?.close();
}
