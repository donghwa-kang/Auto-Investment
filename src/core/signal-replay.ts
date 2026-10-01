import replayProfile from "../../profiles/signal-replay-v1.json" with { type: "json" };
import { Decimal } from "./math.js";
import { hash, policy, policyHash } from "./policy.js";
import { runMultiPreflight } from "./multi-preflight.js";
import { parseSignalReplay } from "./signal-replay-schema.js";
import { prepareSignalHistory } from "./signal-history.js";
import {
  asOfBars,
  indicators,
  dailyTrend,
  evaluateFeatures,
} from "./strategy.js";
export { replayProfile };
export const replayProfileHash = hash(replayProfile);
export const replayReasons = {
  REPLAY_PROFILE_MISSING_OR_CHANGED:
    "등록된 시험 프로필·정책·전략 버전이 없거나 다릅니다.",
  REPLAY_PREFLIGHT_BLOCKED: "해당 시점의 통합 사전점검을 통과하지 못했습니다.",
  REPLAY_BENCHMARK_HISTORY_BLOCKED: "벤치마크의 이력이 보류됐습니다.",
  REPLAY_FEATURES_MISSING: "전략 판단에 필요한 지표 또는 연속 봉이 부족합니다.",
  REPLAY_EVALUATION_FAILED:
    "지표 계산을 완료하지 못했습니다. 해당 종목 판단을 보류합니다.",
} as const;

export function runSignalReplay(raw: unknown) {
  const input = parseSignalReplay(raw);
  const profileValid =
    input.profileHash === replayProfileHash &&
    input.policyHash === policyHash &&
    input.strategyDefinitionHash ===
      policy.shared_strategy_contract.definition_sha256 &&
    Decimal.precision === replayProfile.precision.digits &&
    Decimal.rounding === Decimal.ROUND_HALF_EVEN;
  const histories = new Map(input.histories.map((h) => [h.assetKey, h]));
  const frames = [...input.frames]
    .sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf))
    .map((frame) => {
      const preflight = runMultiPreflight(frame),
        at = Date.parse(frame.asOf);
      const assets = new Map(
        frame.market?.assets.map((a) => [a.assetKey, a]) ?? [],
      );
      const prepared = new Map<
        string,
        ReturnType<typeof prepareSignalHistory>
      >();
      // 같은 벤치마크는 시점당 한 번만 계산. 다른 재생 실행/정정에는 캐시를 승계하지 않는다.
      const computed = new Map<
        string,
        {
          features: ReturnType<typeof indicators>;
          trend: ReturnType<typeof dailyTrend>;
        }
      >();
      const prepare = (assetKey: string) => {
        if (!prepared.has(assetKey)) {
          const a = assets.get(assetKey)!;
          const quality = preflight.stageReports.market?.items.find(
            (x) => x.assetKey === assetKey,
          );
          prepared.set(
            assetKey,
            prepareSignalHistory(
              histories.get(assetKey),
              a,
              at,
              quality?.selected.map((s) => s.record) ?? [],
            ),
          );
        }
        return prepared.get(assetKey)!;
      };
      const compute = (assetKey: string) => {
        if (!computed.has(assetKey)) {
          const h = prepare(assetKey);
          computed.set(assetKey, {
            features: indicators(h.bars, h.sessions, at, h.actions),
            // 일봉도 같은 판단 시점의 split-only 단위를 사용한다. 분할을 두 번 적용하지 않는다.
            trend: dailyTrend(asOfBars(h.bars, at, h.actions), h.sessions, at),
          });
        }
        return computed.get(assetKey)!;
      };
      const items = preflight.items
        .filter((i) => i.role !== "BENCHMARK")
        .map((item) => {
          const reasons: string[] = [];
          if (!profileValid) reasons.push("REPLAY_PROFILE_MISSING_OR_CHANGED");
          if (item.status !== "TEST_PREFLIGHT_PASS")
            reasons.push("REPLAY_PREFLIGHT_BLOCKED");
          let evaluation: ReturnType<typeof evaluateFeatures> | null = null;
          let historyEvidence: {
            instrument: string;
            benchmark: string;
          } | null = null;
          let historyCounts: {
            instrument: ReturnType<typeof prepareSignalHistory>["counts"];
            benchmark: ReturnType<typeof prepareSignalHistory>["counts"];
          } | null = null;
          const benchmarkKey = item.assetKey
            ? assets.get(item.assetKey)?.benchmarkKey
            : null;
          if (!reasons.length && item.assetKey && benchmarkKey) {
            const own = prepare(item.assetKey),
              bench = prepare(benchmarkKey);
            historyEvidence = {
              instrument: own.evidenceHash,
              benchmark: bench.evidenceHash,
            };
            historyCounts = { instrument: own.counts, benchmark: bench.counts };
            reasons.push(...own.reasons);
            if (bench.reasons.length)
              reasons.push(
                "REPLAY_BENCHMARK_HISTORY_BLOCKED",
                ...bench.reasons.map((r) => `BENCHMARK:${r}`),
              );
            if (!reasons.length) {
              try {
                const a = compute(item.assetKey),
                  b = compute(benchmarkKey);
                evaluation = evaluateFeatures(
                  a.features,
                  b.features,
                  a.trend,
                  b.trend,
                  own.current!,
                  at,
                  item.symbol ?? item.catalogKey,
                );
                const dataVersion = hash({
                  historyEvidence,
                  profileHash: replayProfileHash,
                  preflight: preflight.decisionHash,
                });
                // 레거시 평가기의 합성 출처 태그만 실제 시험 입력 해시로 감싼다. 산식/판정은 그대로다.
                evaluation = {
                  ...evaluation,
                  dataVersion,
                  trace: evaluation.trace.map((t) => ({
                    ...t,
                    data_version: dataVersion,
                  })),
                };
                if (
                  !evaluation.strategies.length &&
                  evaluation.trace.some((t) => t.result === "MISSING")
                )
                  reasons.push("REPLAY_FEATURES_MISSING");
              } catch {
                reasons.push("REPLAY_EVALUATION_FAILED");
              }
            }
          }
          const status = reasons.length
            ? "BLOCKED"
            : evaluation?.strategies.length
              ? "CHART_SIGNAL"
              : "NO_CHART_SIGNAL";
          return {
            catalogKey: item.catalogKey,
            assetKey: item.assetKey,
            symbol: item.symbol,
            status,
            reasons: [...new Set(reasons)].sort(),
            preflightStatus: item.status,
            preflightReasons: item.reasons,
            strategyEvaluated: evaluation !== null,
            historyEvidence,
            historyCounts,
            evaluation,
            strategyPriorityResolved: false,
            orderApproved: false,
          };
        });
      const decision = {
        asOf: frame.asOf,
        preflightHash: preflight.decisionHash,
        items,
      };
      return { ...decision, decisionHash: hash(decision), preflight };
    });
  const items = frames.flatMap((f) => f.items);
  const decision = {
    schemaVersion: "OFFLINE_SIGNAL_REPLAY_RESULT_V1",
    purpose: "TEST_ONLY",
    experimentId: input.experimentId,
    stage: "CHART_SIGNAL_ONLY_NOT_ORDER_APPROVAL",
    policyHash,
    strategyDefinitionHash: policy.shared_strategy_contract.definition_sha256,
    profileHash: replayProfileHash,
    requestedProfile: {
      profileHash: input.profileHash,
      policyHash: input.policyHash,
      strategyDefinitionHash: input.strategyDefinitionHash,
    },
    evaluator: "EXISTING_SHARED_BP_V1_WITH_REPLAY_INPUT_GATES",
    sourceAuthentication: "UNVERIFIED_TEST_INPUT",
    realDataReady: false,
    performanceQualified: false,
    selectionPerformed: false,
    riskEvaluated: false,
    economicEvaluated: false,
    paperOrdersEnabled: false,
    liveEnabled: false,
    counts: {
      frames: frames.length,
      instrumentDecisions: items.length,
      evaluated: items.filter((i) => i.strategyEvaluated).length,
      signals: items.filter((i) => i.status === "CHART_SIGNAL").length,
      noSignals: items.filter((i) => i.status === "NO_CHART_SIGNAL").length,
      blocked: items.filter((i) => i.status === "BLOCKED").length,
    },
    frameDecisionHashes: frames.map((f) => f.decisionHash),
  };
  return {
    ...decision,
    decisionHash: hash(decision),
    inputHash: hash(input),
    historyInputHashes: input.histories
      .map((h) => ({ assetKey: h.assetKey, hash: hash(h) }))
      .sort((a, b) => a.assetKey.localeCompare(b.assetKey, "en")),
    frames,
  };
}
