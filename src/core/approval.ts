import { bindSnapshot, hash, policy, policyHash } from "./policy.js";
import type { State, Quote, Decision } from "./types.js";
import { caps, fxFor } from "./ledger.js";
import { economic, guards, profile, size, costFor } from "./risk.js";
import { d } from "./math.js";
import { roundedEntry, type Evaluation } from "./strategy.js";
import { minute } from "./calendar.js";
import {
  MissingForecast,
  SyntheticForecast,
  validateForecast,
} from "./providers.js";

export interface ApprovalContext {
  quote: Quote;
  market: "KR" | "US";
  sessionClose: number;
  dataHash: string;
  decisionId: string;
  reasons?: string[];
  snapshotContext?: Record<string, unknown>;
  // 오프라인 합성 시험 전용. 현재 UI/저장소에서 수집하거나 복원하지 않는다.
  operatingHistory?: unknown;
}
// 호출자의 동일 DB 트랜잭션에서 판단과 예약을 함께 확정한다.
// 차트 평가/정책 수치는 기존 엔진과 공유하고 외부 주문을 호출하지 않는다.
export function approveEvaluation(
  s: State,
  e: Evaluation,
  context: ApprovalContext,
) {
  const signalAt = e.current?.closeAt ?? s.clock;
  const decisionId = context.decisionId;
  const q = context.quote,
    trace = structuredClone(e.trace);
  const reasons = [
    ...guards(s, q, signalAt, e.symbol, context.operatingHistory),
    ...(context.reasons ?? []),
  ];
  const id = e.strategies.length === 1 ? e.strategies[0]! : null;
  if (!id)
    reasons.push(
      e.strategies.length
        ? "SIMULTANEOUS_NO_VALIDATED_PRIORITY"
        : "CHART_NO_SIGNAL",
    );
  const record: Decision = {
    id: decisionId,
    at: s.clock,
    symbol: e.symbol,
    strategy: id,
    result: "ABSTAIN",
    reasons,
    trace,
    quantity: 0,
  };
  for (const t of trace) {
    t.risk_level = s.config!.level;
    t.effective_caps_hash = hash(caps(s));
  }
  if (id) {
    const { P, S, valid } = roundedEntry(
      e,
      id,
      q.ask,
      profile.ticks[context.market],
    );
    if (!valid) reasons.push("ROUNDED_PRICE_OR_STOP_DISTANCE");
    const currency = context.market === "KR" ? "KRW" : "USD";
    const sized = size(s, P, S, q, currency, context.operatingHistory);
    reasons.push(...sized.operating.reasons);
    if (!sized.quantity) reasons.push("NO_FEASIBLE_LOT");
    const R0 = d(P)
      .minus(S)
      .mul(sized.quantity)
      .mul(fxFor(s.ledger, currency))
      .toString();
    const horizon = Math.min(
      policy.exit_policy.maximum_holding_minutes,
      (context.sessionClose -
        policy.exit_policy.close_buffer_minutes * minute -
        s.clock) /
        minute,
    );
    if (horizon < policy.exit_policy.minimum_planned_holding_minutes)
      reasons.push("HOLDING_WINDOW");
    const input = {
      quantity: sized.quantity,
      R0,
      cost: sized.cost,
      at: s.clock,
      deadline: signalAt + 30000,
      horizon,
      inputHash: hash({
        P,
        S,
        quantity: sized.quantity,
        fx: s.ledger.fx,
        epoch: s.epoch,
        signal: signalAt,
        policyHash,
        cost: sized.cost,
        operating: sized.operating.binding,
      }),
    };
    const provider =
      s.config!.forecast === "TEST_ONLY"
        ? new SyntheticForecast()
        : new MissingForecast();
    const output = provider.forecast(input);
    if (!output) reasons.push("MISSING_FORECAST_PROFILE");
    let forecast = null;
    if (output && sized.quantity) {
      try {
        forecast = validateForecast(output, input);
        if (
          !economic(
            forecast.gross,
            forecast.cost,
            R0,
            forecast.q05,
            caps(s).trade,
          )
        )
          reasons.push("ECONOMIC_GATE");
      } catch {
        reasons.push("INVALID_FORECAST");
      }
    }
    if (reasons.length === 0 && forecast) {
      const snapshot: Record<string, unknown> = {
        ...context.snapshotContext,
        instrument_id: e.symbol,
        account_alias: "LOCAL_SYNTHETIC",
        strategy_version: `${id}:1.0`,
        signal_id: record.id,
        policy_hash: policyHash,
        market: context.market,
        mode: s.config!.mode,
        policy_version: policy.version,
        selection_version: "NOT_APPLICABLE",
        model_version: "SYNTHETIC_FORECAST_V1",
        data_version: e.dataVersion,
        dossier_version: "NOT_APPLICABLE",
        quote_at: q.at,
        entry_price: P,
        stop_price: S,
        target_price: d(P).plus(d(P).minus(S).mul(2)).toString(),
        quantity: sized.quantity,
        fx_rate: fxFor(s.ledger, currency),
        cost_model_version: profile.version,
        estimated_cost: sized.cost,
        operating_cost_binding: sized.operating.binding,
        estimated_operating_cost_krw: sized.operating.amount,
        expected_gross_pnl: forecast.gross,
        expected_net_pnl: d(forecast.gross).minus(forecast.cost).toString(),
        net_pnl_q05: forecast.q05,
        model_output_hash: hash(forecast),
        evidence_snapshot_hash: hash({
          fixture: profile.id,
          at: s.clock,
          calendar: "KNOWN_NO_EVENT_TEST_ONLY",
        }),
        order_type: "LIMIT",
        holding_horizon: horizon,
        reservation_version: s.revision,
        strategy_definition_hash:
          policy.shared_strategy_contract.definition_sha256,
        evaluator_version: "DECIMAL40_V1",
        execution_model_hash: hash(profile.execution),
        forecast_profile_hash: hash(profile.forecast),
        variant_id: profile.variant,
        counter_review_mode: "OFF",
        counter_review_profile_hash: "NOT_APPLICABLE",
        counter_review_input_hash: "NOT_APPLICABLE",
        counter_review_output_hash: "NOT_APPLICABLE",
        risk_level: s.config!.level,
        risk_config_epoch: s.epoch,
        risk_level_profile_hash: hash({
          level: s.config!.level,
          stage: s.config!.stage,
        }),
        effective_caps_hash: hash(caps(s)),
        chart_variant_id: `${id}_BASE`,
        chart_research_definition_hash: "NOT_APPLICABLE",
        initial_budget: sized.budget,
        signal_at: signalAt,
        signal_price: e.current!.c,
        forecast_output: forecast,
        source_data_hash: context.dataHash,
      };
      const snapshotHash = bindSnapshot(snapshot);
      const orderId = `buy-${record.id}`;
      const costs = costFor(sized.quantity, P, S, fxFor(s.ledger, currency));
      s.orders.push({
        id: orderId,
        intentId: orderId,
        positionId: `position-${orderId}`,
        side: "BUY",
        quantity: sized.quantity,
        filled: 0,
        value: "0",
        limit: P,
        currency,
        status: "INTENT_SAVED",
        version: 0,
        submittedAt: s.clock,
        lastProgressAt: s.clock,
        reservationRisk: sized.risk,
        reservationCash: d(P).mul(sized.quantity).plus(costs.entry).toString(),
        snapshot,
        snapshotHash,
        epoch: s.epoch,
        eventIds: [],
      });
      s.ledger.intents++;
      record.result = "APPROVED";
      record.quantity = sized.quantity;
      record.snapshotHash = snapshotHash;
    }
  }
  s.decisions.push(record);
  if (s.decisions.length > 500) throw new Error("DECISION_BUFFER_FULL");
}
