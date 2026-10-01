import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PortfolioProgram } from "../src/core/portfolio-program.js";
import { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { exportPaperLearning } from "../src/server/paper-learning-export.js";
import { AnalysisRecordSources } from "../src/server/analysis-record-source.js";
import { replayFixture } from "./signal-replay-helpers.js";
import { learningJournal } from "../src/core/paper-learning-capture.js";

const input = replayFixture();
const fixture = portfolioFixture(input);
const program = new PortfolioProgram(input, fixture.settings);
export function recordedAnalysisFixture(stopAfterFirstFill = false) {
  const root = mkdtempSync(resolve(tmpdir(), "record-analysis-")),
    runsRoot = resolve(root, "runs"),
    runId = "run-TEST01";
  const folder = resolve(runsRoot, runId);
  mkdirSync(folder, { recursive: true });
  const path = resolve(folder, "paper.sqlite"),
    engine = new PortfolioPaperEngine(program, path, { captureLearning: true });
  try {
    for (const [i, command] of fixture.commands.entries()) {
      engine.command(`record-${i}`, command);
      if (stopAfterFirstFill && learningJournal(engine.state())!.fills.length)
        break;
    }
  } finally {
    engine.close();
  }
  const sources = new AnalysisRecordSources(runsRoot, resolve(root, "sources")),
    source = exportPaperLearning(path);
  const period = {
    from: new Date(source.journal.startedAt).toISOString(),
    to: new Date(source.asOf).toISOString(),
  };
  return { root, runsRoot, runId, path, sources, source, period };
}
