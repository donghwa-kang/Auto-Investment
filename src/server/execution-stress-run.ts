import { makeSignalReplayFixture } from "../core/signal-replay-fixture.js";
import { portfolioFixture, laterTick } from "../core/portfolio-fixture.js";
import { PortfolioProgram } from "../core/portfolio-program.js";
import { PortfolioPaperEngine } from "./portfolio-engine.js";
import { stressProfiles } from "../core/execution-stress.js";
import { assertOffline, hash, policyHash } from "../core/policy.js";
import { availableCash, caps, equity, fxFor } from "../core/ledger.js";
import { openRisk, notional } from "../core/risk.js";
import { d, sum } from "../core/math.js";
import { terminal } from "../core/types.js";

// 별도 고정 합성 사례. 임의 시세/계좌/학습 데이터 파일을 받지 않는다.
export function runExecutionStressSample(capital: number, market: "KR" | "US") {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  if (
    !Number.isSafeInteger(capital) ||
    capital < 1 ||
    capital > 5000000 ||
    !["KR", "US"].includes(market)
  )
    throw new Error("STRESS_SAMPLE_ARGUMENTS");
  const input = makeSignalReplayFixture(market);
  // 첫 B 프레임 한 개만 평가한다. 미래 P 프레임과 자동 재진입은 사용하지 않는다.
  input.frames = input.frames.slice(0, 1);
  const fixture = portfolioFixture(input);
  fixture.settings.config.capital = capital;
  fixture.settings.config.usdCapitalKrw =
    market === "US" ? Math.floor(capital * 0.4) : 0;
  const program = new PortfolioProgram(input, fixture.settings);
  const initial = program.initial(1),
    base = fixture.ticks[0]!;
  const profiles = stressProfiles();
  const scenarios = {
    CONTROL: profiles.CONTROL,
    DELAY_ONLY: { ...profiles.CONTROL, latencyMs: 500 },
    SPREAD_ONLY: { ...profiles.CONTROL, adverseTicks: 2 },
    ADVERSE: profiles.ADVERSE,
    EXTREME: profiles.EXTREME,
  };
  const results = Object.entries(scenarios).map(([name, stress]) => {
    const engine = new PortfolioPaperEngine(program, ":memory:", {
      executionStress: stress,
    });
    try {
      engine.command("start", { type: "start" });
      engine.command("signal", base);
      const admitted = engine.state();
      const decisions = admitted.decisions.map((x) => ({
        symbol: x.symbol,
        result: x.result,
        quantity: x.quantity,
        reasons: x.reasons,
        approval:
          admitted.orders.find((o) => o.snapshotHash === x.snapshotHash)
            ?.snapshot ?? null,
      }));
      const timeline = [];
      for (let step = 1; step <= 200; step++) {
        // 시나리오가 명시적으로 생성하는 100ms 관측. 실제 1분봉을 보간한 자료가 아니다.
        engine.command(`tick-${step}`, laterTick(base, step / 10));
        if (step === 100)
          engine.command("liquidate", { type: "liquidate", confirm: true });
        const s = engine.state();
        timeline.push({
          at: s.clock,
          status: s.status,
          orders: s.orders.map((o) => ({
            id: o.id,
            status: o.status,
            filled: o.filled,
            value: o.value,
            reservationCash: o.reservationCash,
            cancelFinalAt: o.cancelFinalAt ?? null,
          })),
          remainingQuantity: s.positions.reduce((n, p) => n + p.quantity, 0),
        });
      }
      const state = engine.state();
      const feesKrw = sum(
        state.orders.map((o) => {
          const position = state.positions.find((p) => p.id === o.positionId);
          return position && o.side === "BUY"
            ? d(position.entryFees)
                .plus(position.exitFees)
                .mul(fxFor(state.ledger, o.currency))
            : 0;
        }),
      );
      const pendingOrders = state.orders.filter((o) => !terminal(o)).length;
      const openPositions = state.positions.filter(
        (p) => p.quantity > 0,
      ).length;
      return {
        name,
        stress,
        stressHash: hash(stress),
        exposureStatus:
          pendingOrders || openPositions ? "UNRESOLVED_EXPOSURE" : "FLAT",
        approved: decisions.filter((x) => x.result === "APPROVED").length,
        feasibleQuantity: decisions.reduce((n, x) => n + x.quantity, 0),
        filledBuyQuantity: state.orders
          .filter((o) => o.side === "BUY")
          .reduce((n, o) => n + o.filled, 0),
        firstFillAt: state.positions.length
          ? Math.min(...state.positions.map((p) => p.firstFillAt))
          : null,
        feesKrw: feesKrw.toString(),
        equityKrw: equity(state).toString(),
        equityChangeKrw: equity(state).minus(equity(initial)).toString(),
        closedTradeNetKrw: sum(
          state.positions.filter((p) => p.closedAt).map((p) => p.netPnl!),
        ).toString(),
        availableKRW: availableCash(state, "KRW").toString(),
        availableUSD: availableCash(state, "USD").toString(),
        openRiskKrw: openRisk(state).toString(),
        notionalKrw: notional(state).toString(),
        openPositions,
        pendingOrders,
        caps: caps(state),
        decisions,
        timeline,
        auditEvents: engine.repo.verifyAudit(),
        stateHash: hash(state),
        state,
      };
    } finally {
      engine.close();
    }
  });
  return {
    schemaVersion: "OFFLINE_EXECUTION_STRESS_REPORT_V1",
    purpose: "TEST_ONLY",
    liveEnabled: false,
    performanceQualified: false,
    learningEligible: false,
    capitalKrw: capital,
    market,
    level: "LOW",
    stage: "PILOT",
    policyHash,
    runHash: program.runHash,
    inputHash: hash(input),
    sampleQuoteIntervalMs: 100,
    costMeaning: "FEES_ONCE_SPREAD_EMBEDDED_NO_EXTRA_SLIPPAGE_CHARGE",
    limitations: [
      "SYNTHETIC_FIXED_QUOTES_NOT_MARKET_PROFITABILITY",
      "LATENCY_IS_MINIMUM_FILL_AGE_NOT_MEASURED_NETWORK_DELAY",
      "LEGACY_TWO_STEP_ACK_PRESERVED",
      "QUOTE_STRESS_AFFECTS_ADMISSION_MARK_PROTECTION_AND_FILLS",
      "NO_QUEUE_PRIORITY_OR_SHARED_DEPTH_MODEL",
      "NO_OPERATING_COST_LEARNING_INTEGRATION",
      "NO_SOXL_OR_NEWS_MODEL",
    ],
    results,
  };
}
