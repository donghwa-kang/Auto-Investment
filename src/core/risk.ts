import profile from "../../profiles/synthetic-v1.json" with { type: "json" };
import { policy } from "./policy.js";
import { d, ceil, floor, min, max, sum } from "./math.js";
import { caps, equity, fxFor, availableCash, foreignNet } from "./ledger.js";
import { resolveOperatingCost } from "./operating-cost.js";
import type { State, Quote, Currency } from "./types.js";
import { terminal } from "./types.js";
import { eventGate } from "./events.js";
export { profile };
export function fee(value: string, side: "BUY" | "SELL") {
  return d(value)
    .mul(side === "BUY" ? profile.fees.entryBps : profile.fees.exitBps)
    .div(10000);
}
export function costFor(q: number, P: string, S: string, fx: string) {
  const entry = fee(d(P).mul(q).toString(), "BUY");
  const exit = fee(d(S).mul(q).toString(), "SELL");
  const adverse = d(S).mul(q).mul(profile.fees.exitAdverseBps).div(10000);
  return {
    entry: entry.toString(),
    stop: ceil(entry.plus(exit).plus(adverse).mul(fx)),
    // 거래 비용만 반환한다. 운영비는 경제성 비용에서 한 번만 합성한다.
    total: ceil(entry.plus(exit).plus(adverse).mul(fx)),
  };
}
export function openRisk(s: State) {
  return sum(
    s.positions
      .filter((p) => p.quantity > 0)
      .map((p) =>
        max(0, d(p.bid).minus(p.stop))
          .mul(p.quantity)
          .plus(fee(d(p.bid).mul(p.quantity).toString(), "SELL"))
          .plus(
            d(p.bid)
              .mul(p.quantity)
              .mul(profile.fees.exitAdverseBps)
              .div(10000),
          )
          .mul(fxFor(s.ledger, p.currency)),
      ),
  ).plus(
    sum(
      s.orders
        .filter((o) => o.side === "BUY" && !terminal(o))
        .map((o) => o.reservationRisk),
    ),
  );
}
export function notional(s: State) {
  return sum(
    s.positions.map((p) =>
      d(p.bid).mul(p.quantity).mul(fxFor(s.ledger, p.currency)),
    ),
  ).plus(
    sum(
      s.orders
        .filter((o) => o.side === "BUY" && !terminal(o))
        .map((o) => d(o.reservationCash).mul(fxFor(s.ledger, o.currency))),
    ),
  );
}
export function remainingRisk(s: State) {
  return remainingRiskForExposure(s, openRisk(s).toString());
}
// Explicit synthetic cost projections reuse the policy headroom formula, not
// the legacy proportional-cost exposure estimate. This does not approve orders.
export function remainingRiskForExposure(s: State, openRiskKrw: string) {
  if (!d(openRiskKrw).isFinite() || d(openRiskKrw).lt(0))
    throw new Error("INVALID_OPEN_RISK");
  const c = caps(s),
    R = d(openRiskKrw),
    E = equity(s);
  const X = max(0, foreignNet(s))
    .mul(profile.fxCashStressBps)
    .div(10000)
    .plus(s.ledger.operationsReserved);
  const head = (key: "day" | "week" | "month", bps: number) => {
    const p = s.ledger.periods[key];
    return max(
      0,
      min(s.config!.capital, p.startEquity)
        .mul(bps)
        .div(10000)
        .minus(max(0, d(p.startEquity).plus(p.flows).minus(E))),
    );
  };
  const dd = max(
    0,
    E.minus(
      d(s.ledger.units)
        .mul(s.ledger.highNav)
        .mul(d(1).minus(d(policy.risk.drawdown_halt_bps).div(10000))),
    ),
  );
  return floor(
    max(
      0,
      min(
        c.trade,
        d(c.risk).minus(R),
        d(c.group).minus(R),
        head("day", policy.risk.daily_loss_bps).minus(R).minus(X),
        head("week", policy.risk.weekly_loss_bps).minus(R).minus(X),
        head("month", policy.risk.monthly_loss_bps).minus(R).minus(X),
        dd.minus(R).minus(X),
      ),
    ),
  );
}
export interface Forecast {
  purpose: "TEST_ONLY";
  quantity: number;
  currency: "KRW";
  horizon: number;
  inputHash: string;
  profileHash: string;
  asOf: number;
  validUntil: number;
  gross: string;
  q05: string;
  cost: string;
}
export function economic(
  gross: string,
  cost: string,
  R0: string,
  q05: string,
  tradeBudget: string,
) {
  return (
    d(R0).gt(0) &&
    d(cost).gte(0) &&
    d(gross)
      .minus(cost)
      .gte(d(R0).mul(policy.economic_gate.minimum_expected_net_r)) &&
    d(gross).gte(
      d(cost).mul(policy.economic_gate.minimum_expected_gross_to_cost_ratio),
    ) &&
    max(0, d(q05).neg()).lte(
      d(tradeBudget).mul(
        policy.economic_gate.maximum_q05_loss_to_trade_budget_ratio,
      ),
    )
  );
}
export function size(
  s: State,
  P: string,
  S: string,
  q: Quote,
  currency: Currency,
  operatingHistory?: unknown,
) {
  const operating = resolveOperatingCost(s, operatingHistory);
  if (operating.amount === null)
    return { quantity: 0, budget: "0", cost: "0", risk: "0", operating };
  const c = caps(s),
    FX = fxFor(s.ledger, currency),
    budget = remainingRisk(s);
  const cash = availableCash(s, currency);
  const price = d(P);
  if (price.lte(S) || d(S).lte(0))
    return { quantity: 0, budget, cost: "0", risk: "0", operating };
  const bounds = [
    d(c.position).div(price.mul(FX)),
    max(0, d(c.notional).minus(notional(s))).div(price.mul(FX)),
    cash.div(price),
    d(q.askSize)
      .mul(policy.execution.maximum_best_ask_size_participation_bps)
      .div(10000),
    d(q.lastMinuteVolume)
      .mul(policy.execution.maximum_last_minute_volume_participation_bps)
      .div(10000),
  ];
  let n = min(...bounds)
    .floor()
    .toNumber();
  for (; n > 0; n--) {
    const costs = costFor(n, P, S, FX),
      risk = ceil(d(P).minus(S).mul(n).mul(FX).plus(costs.stop)),
      paid = d(P).mul(n).plus(costs.entry);
    const afterE = equity(s).minus(d(costs.entry).mul(FX));
    const afterForeign =
      currency === "USD"
        ? foreignNet(s).minus(d(costs.entry).mul(FX))
        : foreignNet(s);
    const foreignCap = floor(
      max(0, min(s.config!.capital, afterE, s.ledger.periods.day.startEquity))
        .mul(policy.risk.foreign_currency_assets_bps)
        .div(10000),
    );
    if (
      d(risk).lte(budget) &&
      paid.lte(cash) &&
      paid.mul(FX).lte(c.position) &&
      paid.mul(FX).plus(notional(s)).lte(c.notional) &&
      afterForeign.lte(foreignCap)
    )
      return {
        quantity: n,
        budget,
        cost: d(costs.total).plus(operating.amount).toString(),
        risk,
        operating,
      };
  }
  return { quantity: 0, budget, cost: "0", risk: "0", operating };
}
export function guards(
  s: State,
  q: Quote,
  signalAt: number,
  symbol: string,
  operatingHistory?: unknown,
) {
  const operating = resolveOperatingCost(s, operatingHistory);
  const reasons: string[] = [...operating.reasons];
  const at = s.clock;
  if (s.status !== "RUNNING") reasons.push("ENTRY_NOT_RUNNING");
  if (s.ledger.halts.length) reasons.push(...s.ledger.halts);
  if (s.pendingLevel) reasons.push("LEVEL_CHANGE_RECONCILING");
  if (
    at - signalAt >
      policy.execution.signal_valid_seconds_after_bar_close * 1000 ||
    at < signalAt
  )
    reasons.push("SIGNAL_EXPIRED");
  for (const [name, time, ttl] of [
    ["QUOTE", q.at, policy.execution.maximum_quote_age_seconds],
    [
      "ACCOUNT",
      s.ledger.accountAt,
      policy.execution.maximum_account_snapshot_age_seconds,
    ],
    ["FX", s.ledger.fxAt, policy.execution.maximum_fx_age_seconds],
  ] as const) {
    if (at < time || at - time > ttl * 1000) reasons.push(`${name}_STALE`);
  }
  if (q.halted || d(q.bid).lte(0) || d(q.ask).lt(q.bid))
    reasons.push("BAD_QUOTE");
  if (
    d(q.ask)
      .minus(q.bid)
      .div(d(q.ask).plus(q.bid).div(2))
      .mul(10000)
      .gt(policy.universe.maximum_spread_bps)
  )
    reasons.push("SPREAD");
  if (
    s.ledger.entries >= policy.risk.max_entries_per_risk_day ||
    s.ledger.intents >= policy.risk.max_entry_intents_per_risk_day ||
    (s.ledger.symbolEntries[symbol] ?? 0) >=
      policy.risk.max_entries_per_symbol_per_risk_day
  )
    reasons.push("ENTRY_COUNT");
  if ((s.ledger.cooldowns[symbol] ?? 0) > at) reasons.push("COOLDOWN");
  const active = new Set([
    ...s.positions.filter((p) => p.quantity > 0).map((p) => p.symbol),
    ...s.orders
      .filter((o) => o.side === "BUY" && !terminal(o))
      .map((o) => String(o.snapshot?.instrument_id ?? o.positionId)),
  ]);
  if (
    active.size >=
    (s.config?.stage === "PILOT"
      ? policy.risk.pilot_max_positions
      : policy.risk.standard_max_positions)
  )
    reasons.push("POSITION_LIMIT");
  if (
    s.positions.some(
      (p) =>
        p.quantity > 0 &&
        (p.protection !== "WATCHING" ||
          p.protectedQuantity < p.quantity ||
          d(p.bid).lte(p.stop)),
    )
  )
    reasons.push("PROTECTION_OR_STOP_PENDING");
  // 미분류 원장의 합산은 생략하되 위 비용 보류와 다른 안전 사유는 유지한다.
  const monthCost =
    operating.amount === null
      ? d(0)
      : sum(
          s.ledger.costs
            .filter(
              (e) =>
                new Date(e.at).toISOString().slice(0, 7) ===
                s.ledger.periods.month.key,
            )
            .map((e) => e.amount),
        ).plus(s.ledger.operationsReserved);
  if (
    monthCost.gt(
      min(
        d(s.config!.capital)
          .mul(policy.economic_gate.maximum_incremental_monthly_cost_bps)
          .div(10000),
        policy.economic_gate.maximum_incremental_monthly_cost_krw,
      ),
    )
  )
    reasons.push("MONTHLY_COST");
  if (s.fault) reasons.push(s.fault);
  if (!eventGate(s.clock, profile.eventCalendar.events))
    reasons.push("EVENT_BLOCK");
  return [...new Set(reasons)];
}
