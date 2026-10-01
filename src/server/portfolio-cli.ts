import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertOffline, hash, verifyPolicies } from "../core/policy.js";
import { PortfolioProgram } from "../core/portfolio-program.js";
import { terminal } from "../core/types.js";
import { equity, availableCash } from "../core/ledger.js";
import { openRisk, notional } from "../core/risk.js";
import { loadPortfolioPlan } from "./portfolio-file.js";
import { PortfolioPaperEngine } from "./portfolio-engine.js";

let engine: PortfolioPaperEngine | undefined;
let directory: string | undefined;
try {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  verifyPolicies();
  if (process.argv.length !== 3) throw new Error("ONE_PORTFOLIO_PLAN_REQUIRED");
  const { plan, input } = loadPortfolioPlan(process.argv[2]!);
  // 수 초 이상 걸리는 원시 이력 계산은 DB lease 획득 전에 완료한다.
  const program = new PortfolioProgram(input, plan.settings);
  const root = resolve("data", "portfolio-paper-runs");
  mkdirSync(root, { recursive: true });
  directory = mkdtempSync(resolve(root, "run-"));
  const databasePath = resolve(directory, "paper.sqlite");
  engine = new PortfolioPaperEngine(program, databasePath);
  for (const [i, c] of plan.commands.entries()) engine.command(`plan-${i}`, c);
  const state = engine.state(),
    auditEvents = engine.repo.verifyAudit();
  const summary = {
    result: "OFFLINE_PORTFOLIO_COMPLETE",
    purpose: "TEST_ONLY",
    liveEnabled: false,
    realDataReady: false,
    performanceQualified: false,
    investmentSelectionImplemented: false,
    simulatedOrders: state.orders.length,
    approved: state.decisions.filter((d) => d.result === "APPROVED").length,
    abstained: state.decisions.filter((d) => d.result === "ABSTAIN").length,
    openPositions: state.positions.filter((p) => p.quantity > 0).length,
    pendingOrders: state.orders.filter((o) => !terminal(o)).length,
    equityKrw: equity(state).toString(),
    availableKRW: availableCash(state, "KRW").toString(),
    availableUSD: availableCash(state, "USD").toString(),
    openRiskKrw: openRisk(state).toString(),
    notionalKrw: notional(state).toString(),
    stateHash: hash(state),
    auditEvents,
    databasePath,
    reportPath: resolve(directory, "report.json"),
  };
  writeFileSync(
    summary.reportPath,
    JSON.stringify(
      {
        summary,
        planHash: hash(plan),
        runHash: program.runHash,
        replay: program.report(),
        state,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(JSON.stringify(summary));
} catch {
  // 실패 이후 자동 재시도/청산/실 API fallback은 없다. 마지막 커밋된 노출을 보존한다.
  if (directory) {
    try {
      writeFileSync(
        resolve(directory, "failure.json"),
        JSON.stringify({
          result: "PORTFOLIO_RUN_FAILED",
          purpose: "TEST_ONLY",
          liveEnabled: false,
          reconciliationRequired: true,
          state: engine?.state() ?? null,
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch {
      /* DB/디스크 실패를 성공으로 바꾸지 않는다. */
    }
  }
  console.error("PORTFOLIO_RUN_FAILED");
  process.exitCode = 1;
} finally {
  engine?.close();
}
