import { d, sum, max, floor, ceil, min } from "./math.js";
import { policy, type Config } from "./policy.js";
import type { Ledger, State, Currency } from "./types.js";
import { terminal } from "./types.js";
import { riskKeys } from "./calendar.js";
export function emptyLedger(
  at: number,
  capital = "0",
  usd = "0",
  fx = "1300",
): Ledger {
  const w = (cash: string) => ({
    cash,
    receivable: "0",
    payable: "0",
    unpaidFees: "0",
  });
  const keys = riskKeys(at);
  return {
    wallets: {
      KRW: w(d(capital).minus(d(usd).mul(fx)).toString()),
      USD: w(usd),
    },
    fx,
    fxAt: at,
    accountAt: at,
    units: capital,
    highNav: "1",
    drawdownReduced: false,
    halts: [],
    periods: {
      day: { key: keys.day, startEquity: capital, flows: "0" },
      week: { key: keys.week, startEquity: capital, flows: "0" },
      month: { key: keys.month, startEquity: capital, flows: "0" },
    },
    costs: [],
    operationsReserved: "0",
    entries: 0,
    intents: 0,
    symbolEntries: {},
    lossStreak: 0,
    cooldowns: {},
  };
}
export const fxFor = (l: Ledger, c: Currency) => (c === "KRW" ? "1" : l.fx);
export function foreignNet(s: State) {
  const w = s.ledger.wallets.USD;
  return d(w.cash)
    .plus(w.receivable)
    .minus(w.payable)
    .minus(w.unpaidFees)
    .plus(
      sum(
        s.positions
          .filter((p) => p.currency === "USD")
          .map((p) => d(p.bid).mul(p.quantity)),
      ),
    )
    .mul(s.ledger.fx);
}
export function equity(s: State) {
  return sum(
    (["KRW", "USD"] as const).map((c) => {
      const w = s.ledger.wallets[c];
      return d(w.cash)
        .plus(w.receivable)
        .minus(w.payable)
        .minus(w.unpaidFees)
        .plus(
          sum(
            s.positions
              .filter((p) => p.currency === c)
              .map((p) => d(p.bid).mul(p.quantity)),
          ),
        )
        .mul(fxFor(s.ledger, c));
    }),
  );
}
export function availableCash(s: State, c: Currency) {
  const w = s.ledger.wallets[c];
  return max(
    0,
    d(w.cash)
      .minus(w.payable)
      .minus(w.unpaidFees)
      .minus(
        sum(
          s.orders
            .filter((o) => o.currency === c && !terminal(o) && o.side === "BUY")
            .map((o) => o.reservationCash),
        ),
      ),
  );
}
export function latch(s: State, reason: string) {
  if (!s.ledger.halts.includes(reason)) s.ledger.halts.push(reason);
  s.status = "HALTED";
}
export function mark(s: State) {
  if (!s.config) return;
  const E = equity(s);
  const l = s.ledger;
  const keys = riskKeys(s.clock);
  for (const k of ["day", "week", "month"] as const) {
    if (keys[k] !== l.periods[k].key) {
      l.periods[k] = { key: keys[k], startEquity: E.toString(), flows: "0" };
      if (k === "day") {
        l.entries = 0;
        l.intents = 0;
        l.symbolEntries = {};
      } /* 중지 래치는 날짜 변경으로 해제하지 않는다. */
    }
  }
  if (d(l.units).gt(0)) {
    const nav = E.div(l.units);
    l.highNav = max(l.highNav, nav).toString();
    const dd = d(1).minus(nav.div(l.highNav)).mul(10000);
    if (dd.gte(policy.risk.drawdown_reduce_bps)) l.drawdownReduced = true;
    if (dd.gte(policy.risk.drawdown_halt_bps)) latch(s, "DRAWDOWN_HALT");
  }
  for (const [k, bps] of [
    ["day", policy.risk.daily_loss_bps],
    ["week", policy.risk.weekly_loss_bps],
    ["month", policy.risk.monthly_loss_bps],
  ] as const) {
    const p = l.periods[k];
    const loss = d(p.startEquity).plus(p.flows).minus(E);
    if (loss.gte(d(min(s.config.capital, p.startEquity)).mul(bps).div(10000)))
      latch(s, `${k.toUpperCase()}_LOSS_HALT`);
  }
  l.accountAt = s.clock;
}
export function externalFlow(
  s: State,
  c: Currency,
  amount: string,
  id: string,
) {
  if (s.ledger.costs.some((x) => x.id === `flow:${id}`)) return;
  const E = equity(s);
  if (E.lte(0) || d(s.ledger.units).lte(0)) throw new Error("INVALID_NAV");
  const v = d(amount).mul(fxFor(s.ledger, c));
  if (E.plus(v).lte(0) || d(s.ledger.wallets[c].cash).plus(amount).lt(0))
    throw new Error("INSUFFICIENT_FLOW_BALANCE");
  s.ledger.units = d(s.ledger.units)
    .plus(v.div(E.div(s.ledger.units)))
    .toString();
  s.ledger.wallets[c].cash = d(s.ledger.wallets[c].cash)
    .plus(amount)
    .toString();
  for (const p of Object.values(s.ledger.periods))
    p.flows = d(p.flows).plus(v).toString();
  s.ledger.costs.push({
    id: `flow:${id}`,
    amount: "0",
    at: s.clock,
    paid: true,
  });
  mark(s);
}
export function recognizeCost(s: State, id: string, amount: string) {
  if (d(amount).lt(0)) throw new Error("NEGATIVE_COST");
  if (s.ledger.costs.some((x) => x.id === id)) return;
  s.ledger.costs.push({ id, amount, at: s.clock, paid: false });
  s.ledger.wallets.KRW.unpaidFees = d(s.ledger.wallets.KRW.unpaidFees)
    .plus(amount)
    .toString();
  s.ledger.operationsReserved = max(
    0,
    d(s.ledger.operationsReserved).minus(amount),
  ).toString();
  mark(s);
}
export function payCost(s: State, id: string) {
  const c = s.ledger.costs.find((x) => x.id === id);
  if (!c || c.paid) return;
  if (d(s.ledger.wallets.KRW.cash).lt(c.amount))
    throw new Error("INSUFFICIENT_CASH");
  s.ledger.wallets.KRW.cash = d(s.ledger.wallets.KRW.cash)
    .minus(c.amount)
    .toString();
  s.ledger.wallets.KRW.unpaidFees = d(s.ledger.wallets.KRW.unpaidFees)
    .minus(c.amount)
    .toString();
  c.paid = true;
  mark(s);
}
export function settle(s: State, c: Currency) {
  const w = s.ledger.wallets[c];
  w.cash = d(w.cash).plus(w.receivable).minus(w.payable).toString();
  w.receivable = "0";
  w.payable = "0";
}
export function estimateOperating(
  total: string,
  trades: number,
  daily: string | null,
) {
  if (d(total).lt(0) || trades < 0) throw new Error("INVALID_COST");
  if (trades) return ceil(d(total).div(trades));
  if (daily === null) return null;
  return max(total, daily).toString();
}
export function allocateOperating(total: number, ids: string[]) {
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    new Set(ids).size !== ids.length
  )
    throw new Error("INVALID_ALLOCATION");
  const sorted = [...ids].sort();
  const n = ids.length;
  return {
    unallocated: n ? 0 : total,
    allocations: Object.fromEntries(
      sorted.map((id, i) => [
        id,
        Math.floor(total / n) + (i < total % n ? 1 : 0),
      ]),
    ),
  };
}
export function caps(s: State) {
  const c = s.config!;
  const K = max(0, min(c.capital, equity(s), s.ledger.periods.day.startEquity));
  return effectiveCaps(K.toString(), c, s.ledger.drawdownReduced);
}
export function effectiveCaps(
  K: string,
  c: Pick<Config, "level" | "stage">,
  reduced: boolean,
) {
  const level = policy.risk_level_contract.levels.find((l) => l.id === c.level);
  if (!level) throw new Error("UNKNOWN_LEVEL");
  const mult = d(level.numerator)
    .div(level.denominator)
    .mul(
      c.stage === "PILOT"
        ? d(policy.risk.pilot_multiplier.numerator).div(
            policy.risk.pilot_multiplier.denominator,
          )
        : 1,
    )
    .mul(
      reduced
        ? d(policy.risk.drawdown_multiplier.numerator).div(
            policy.risk.drawdown_multiplier.denominator,
          )
        : 1,
    );
  const limit = (bps: number) => floor(d(K).mul(bps).div(10000).mul(mult));
  return {
    K,
    trade: limit(policy.risk.trade_risk_bps),
    position: limit(policy.risk.position_notional_bps),
    notional: limit(policy.risk.total_notional_bps),
    risk: limit(policy.risk.total_open_risk_bps),
    group: limit(policy.risk.correlated_group_risk_bps),
    foreign: floor(
      d(K).mul(policy.risk.foreign_currency_assets_bps).div(10000),
    ),
  };
}
