import { d, median, percentile, sum, min, max, tick, Decimal } from "./math.js";
import { policy, spec } from "./policy.js";
import { minute, entryWindow, type Session } from "./calendar.js";
import type { Trace } from "./types.js";
export interface Bar {
  session: string;
  openAt: number;
  closeAt: number;
  availableAt: number;
  revision: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  halted?: boolean;
}
export interface Split {
  announcedAt: number;
  availableAt: number;
  effectiveAt: number;
  ratio: string;
}
export interface Feature extends Bar {
  slot: number;
  atr: string | null;
  ema: string | null;
  vwap: string | null;
  rvol: string | null;
  orh: string | null;
  volCeiling: string | null;
}
export interface Evaluation {
  at: number;
  symbol: string;
  strategies: ("B" | "P")[];
  stops: Partial<Record<"B" | "P", string>>;
  trace: Trace[];
  current: Feature | null;
  dataVersion: string;
}
export function asOfBars(raw: Bar[], at: number, actions: Split[] = []) {
  const map = new Map<number, Bar>();
  for (const b of raw) {
    if (
      b.closeAt > at ||
      b.availableAt > at ||
      b.closeAt - b.openAt !== minute ||
      b.halted
    )
      continue;
    const old = map.get(b.openAt);
    if (!old || b.revision > old.revision) map.set(b.openAt, b);
  }
  return [...map.values()]
    .sort((a, b) => a.openAt - b.openAt)
    .map((b) => {
      let out = { ...b };
      for (const a of actions) {
        if (
          a.announcedAt <= at &&
          a.availableAt <= at &&
          a.effectiveAt <= at &&
          b.closeAt <= a.effectiveAt
        ) {
          if (d(a.ratio).lte(0)) throw new Error("INVALID_SPLIT");
          out = {
            ...out,
            o: d(out.o).div(a.ratio).toString(),
            h: d(out.h).div(a.ratio).toString(),
            l: d(out.l).div(a.ratio).toString(),
            c: d(out.c).div(a.ratio).toString(),
            v: d(out.v).mul(a.ratio).toString(),
          };
        }
      }
      if (
        d(out.l).lte(0) ||
        d(out.h).lt(max(out.o, out.c, out.l)) ||
        d(out.l).gt(min(out.o, out.c)) ||
        d(out.v).lt(0)
      )
        throw new Error("INVALID_OHLCV");
      return out;
    });
}
export function aggregate(
  raw: Bar[],
  sessions: Session[],
  at: number,
  actions: Split[] = [],
) {
  const source = asOfBars(raw, at, actions),
    bySession = new Map<string, Bar[]>();
  for (const b of source) {
    const a = bySession.get(b.session) ?? [];
    a.push(b);
    bySession.set(b.session, a);
  }
  const bars: Bar[] = [];
  for (const s of sessions) {
    const rows = bySession.get(s.id) ?? [];
    const index = new Map(rows.map((b) => [b.openAt, b]));
    for (
      let start = s.open;
      start + 15 * minute <= Math.min(s.close, at);
      start += 15 * minute
    ) {
      const window = Array.from({ length: 15 }, (_, i) =>
        index.get(start + i * minute),
      );
      if (window.some((b) => !b)) continue;
      const w = window as Bar[];
      bars.push({
        session: s.id,
        openAt: start,
        closeAt: start + 15 * minute,
        availableAt: Math.max(...w.map((b) => b.availableAt)),
        revision: Math.max(...w.map((b) => b.revision)),
        o: w[0]!.o,
        h: max(...w.map((b) => b.h)).toString(),
        l: min(...w.map((b) => b.l)).toString(),
        c: w[14]!.c,
        v: sum(w.map((b) => b.v)).toString(),
      });
    }
  }
  return { source, bars };
}
export function indicators(
  raw: Bar[],
  sessions: Session[],
  at: number,
  actions: Split[] = [],
) {
  const { source, bars } = aggregate(raw, sessions, at, actions);
  const sourceMap = new Map<string, Bar[]>();
  for (const b of source) {
    const rows = sourceMap.get(b.session) ?? [];
    rows.push(b);
    sourceMap.set(b.session, rows);
  }
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const features: Feature[] = [];
  let atr: Decimal | null = null,
    ema: Decimal | null = null;
  const trs: Decimal[] = [];
  const closes: Decimal[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!,
      prev = bars[i - 1];
    const tr = prev
      ? max(
          d(b.h).minus(b.l),
          d(b.h).minus(prev.c).abs(),
          d(b.l).minus(prev.c).abs(),
        )
      : d(b.h).minus(b.l);
    trs.push(tr);
    closes.push(d(b.c));
    if (i === spec.indicators.atr.period - 1)
      atr = sum(trs).div(spec.indicators.atr.period);
    else if (atr)
      atr = atr
        .mul(spec.indicators.atr.period - 1)
        .plus(tr)
        .div(spec.indicators.atr.period);
    if (i === spec.indicators.ema.period - 1)
      ema = sum(closes).div(spec.indicators.ema.period);
    else if (ema) {
      const alpha = d(spec.indicators.ema.alpha_numerator).div(
        spec.indicators.ema.alpha_denominator,
      );
      ema = d(b.c)
        .mul(alpha)
        .plus(ema.mul(d(1).minus(alpha)));
    }
    const s = sessionMap.get(b.session)!;
    const slot = (b.openAt - s.open) / (15 * minute);
    const mins = (sourceMap.get(b.session) ?? []).filter(
      (m) => m.closeAt <= b.closeAt,
    );
    const continuous = mins.length === (b.closeAt - s.open) / minute;
    const V = sum(mins.map((m) => m.v));
    const vwap =
      continuous && V.gt(0)
        ? sum(mins.map((m) => d(m.h).plus(m.l).plus(m.c).div(3).mul(m.v)))
            .div(V)
            .toString()
        : null;
    const opening = mins.filter(
      (m) =>
        m.closeAt <= s.open + spec.indicators.opening_range.minutes * minute,
    );
    const orh =
      opening.length === 30 ? max(...opening.map((m) => m.h)).toString() : null;
    const prior = features.filter(
      (f) => f.session !== b.session && f.slot === slot,
    );
    const volumes = prior.slice(
      -spec.indicators.relative_volume.reference_sessions,
    );
    const denom =
      volumes.length === 20 ? median(volumes.map((f) => f.v)) : null;
    const ratioRefs = prior
      .filter((f) => f.atr !== null && d(f.c).gt(0))
      .slice(-spec.indicators.volatility_ceiling.lookback_sessions);
    features.push({
      ...b,
      slot,
      atr: atr?.toString() ?? null,
      ema: ema?.toString() ?? null,
      vwap,
      rvol: denom && denom.gt(0) ? d(b.v).div(denom).toString() : null,
      orh,
      volCeiling:
        ratioRefs.length === 60
          ? percentile(
              ratioRefs.map((f) => d(f.atr!).div(f.c)),
              spec.indicators.volatility_ceiling.percentile,
            ).toString()
          : null,
    });
  }
  return features;
}
export function dailyTrend(raw: Bar[], sessions: Session[], at: number) {
  const data = asOfBars(raw, at);
  const grouped = new Map<string, Bar[]>();
  for (const b of data) {
    const arr = grouped.get(b.session) ?? [];
    arr.push(b);
    grouped.set(b.session, arr);
  }
  const daily = sessions
    .filter((s) => s.close < at)
    .map((s) => {
      const rows = grouped.get(s.id) ?? [];
      return { s, rows };
    })
    .filter(
      ({ s, rows }) =>
        rows.length === (s.close - s.open) / minute &&
        rows.at(-1)?.closeAt === s.close,
    )
    .map(({ rows }) => ({
      close: rows.at(-1)!.c,
      turnover: sum(rows.map((b) => d(b.c).mul(b.v))).toString(),
    }));
  if (daily.length < policy.universe.minimum_history_sessions) return null;
  const close = daily.at(-1)!.close;
  return {
    close,
    sma20: sum(daily.slice(-20).map((x) => x.close))
      .div(20)
      .toString(),
    sma60: sum(daily.slice(-60).map((x) => x.close))
      .div(60)
      .toString(),
    turnover: median(daily.slice(-20).map((x) => x.turnover)).toString(),
    count: daily.length,
  };
}
export function evaluateFeatures(
  features: Feature[],
  benchmark: Feature[],
  trend: ReturnType<typeof dailyTrend>,
  benchTrend: ReturnType<typeof dailyTrend>,
  s: Session,
  at: number,
  symbol: string,
): Evaluation {
  const t = features.at(-1) ?? null;
  const trace: Trace[] = [];
  const emit = (
    id: string,
    values: Trace["input_values"],
    threshold: string,
    op: string,
    result: boolean | null,
  ) => {
    trace.push({
      predicate_id: id,
      input_values: values,
      threshold,
      operator: op,
      result: result === null ? "MISSING" : result ? "PASS" : "FAIL",
      reason:
        result === null
          ? "REQUIRED_INPUT_MISSING"
          : result
            ? "CONDITION_MET"
            : "CONDITION_NOT_MET",
      strategy_version: spec.version,
      indicator_version: "DECIMAL40_V1",
      data_version: "SYNTHETIC_V1",
      as_of: at,
    });
    return result === true;
  };
  const valid = emit(
    "COMMON_HISTORY",
    { sessions: trend?.count ?? null },
    String(policy.universe.minimum_history_sessions),
    ">=",
    trend !== null && benchTrend !== null,
  );
  const window = emit(
    "COMMON_WINDOW",
    { at: t?.closeAt ?? null },
    `${s.open + 45 * minute}..${s.close - 100 * minute}`,
    "INCLUSIVE",
    t
      ? entryWindow(
          t.closeAt,
          s,
          policy.execution.entry_start_minutes_after_open,
          policy.execution.entry_end_minutes_before_close,
        )
      : null,
  );
  const timely = emit(
    "COMMON_TTL",
    { age: t ? at - t.closeAt : null },
    String(policy.execution.signal_valid_seconds_after_bar_close * 1000),
    "<=",
    t ? at >= t.closeAt && at - t.closeAt <= 30000 : null,
  );
  const daily = emit(
    "COMMON_DAILY",
    {
      close: trend?.close ?? null,
      sma20: trend?.sma20 ?? null,
      sma60: trend?.sma60 ?? null,
    },
    "close>SMA60 AND SMA20>SMA60",
    ">",
    trend
      ? d(trend.close).gt(trend.sma60) && d(trend.sma20).gt(trend.sma60)
      : null,
  );
  const b = benchmark.at(-1);
  const bench = emit(
    "COMMON_BENCHMARK",
    {
      close: b?.c ?? null,
      vwap: b?.vwap ?? null,
      previous: benchTrend?.close ?? null,
    },
    "previous>SMA60 AND C>VWAP",
    ">",
    b?.vwap && benchTrend
      ? b.closeAt === t?.closeAt &&
          d(benchTrend.close).gt(benchTrend.sma60) &&
          d(b.c).gt(b.vwap)
      : null,
  );
  const vol = emit(
    "COMMON_VOL_CEILING",
    {
      atr: t?.atr ?? null,
      close: t?.c ?? null,
      ceiling: t?.volCeiling ?? null,
    },
    "prior 60 same-slot 95th percentile",
    "<=",
    t?.atr && t.volCeiling ? d(t.atr).div(t.c).lte(t.volCeiling) : null,
  );
  const liquid = emit(
    "COMMON_LIQUIDITY",
    { price: t?.c ?? null, turnover: trend?.turnover ?? null },
    `${policy.universe.minimum_price[s.market]};${policy.universe.minimum_median_turnover[s.market]}`,
    ">=",
    t && trend
      ? d(t.c).gte(policy.universe.minimum_price[s.market]) &&
          d(trend.turnover).gte(
            policy.universe.minimum_median_turnover[s.market],
          )
      : null,
  );
  const result: Evaluation = {
    at,
    symbol,
    strategies: [],
    stops: {},
    trace,
    current: t,
    dataVersion: "SYNTHETIC_V1",
  };
  for (const strategy of spec.strategies) {
    const id = strategy.id as "B" | "P",
      p = strategy.parameters;
    const needed = id === "B" ? 2 : 4;
    const rows = features.slice(-needed);
    const contiguous =
      t &&
      rows.length === needed &&
      rows.every(
        (r, i) =>
          r.session === s.id &&
          r.closeAt === t.closeAt - (needed - i - 1) * 15 * minute,
      );
    let passed = emit(
      `${id}_CONTIGUOUS`,
      { bars: rows.length },
      `${needed} consecutive same-session`,
      "=",
      Boolean(contiguous),
    );
    if (!t || !contiguous || !t.atr || !t.ema || !t.rvol || !t.vwap || !t.orh) {
      emit(`${id}_FEATURES`, {}, "ATR/EMA/RVOL/VWAP/ORH", "DEFINED", null);
      continue;
    }
    const prev = rows.at(-2)!;
    const A = d(t.atr),
      C = d(t.c);
    const check = (
      name: string,
      left: Decimal.Value,
      right: Decimal.Value,
      op: ">" | ">=" | "<=",
    ) => {
      const a = d(left),
        z = d(right);
      const ok = op === ">" ? a.gt(z) : op === ">=" ? a.gte(z) : a.lte(z);
      const out = emit(
        `${id}_${name}`,
        { left: a.toString(), right: z.toString() },
        z.toString(),
        op,
        ok,
      );
      passed = passed && out;
    };
    if (id === "B") {
      check("PREVIOUS_RANGE", prev.c, t.orh, "<=");
      check("BREAKOUT", C, d(t.orh).plus(A.mul(p.breakout_atr_buffer!)), ">");
      check("VWAP_POSITIVE", C.minus(t.vwap), 0, ">");
      check(
        "VWAP_DISTANCE",
        C.minus(t.vwap),
        A.mul(p.vwap_distance_atr_max!),
        "<=",
      );
    } else {
      const old = rows[0]!;
      if (!old.ema || rows.some((r) => !r.atr || !r.ema)) {
        emit("P_HISTORY_FEATURES", {}, "all EMA/ATR", "DEFINED", null);
        continue;
      }
      check("EMA_SLOPE", t.ema, old.ema, ">");
      const pull = rows
        .slice(0, -1)
        .some(
          (r) =>
            d(r.l).lte(
              d(r.ema!).plus(d(r.atr!).mul(p.pullback_low_atr_max!)),
            ) &&
            d(r.c).gte(
              d(r.ema!).plus(d(r.atr!).mul(p.pullback_close_atr_min!)),
            ),
        );
      const pullResult = emit(
        "P_PULLBACK",
        { matched: pull },
        "exists prior 1/2/3 both inequalities",
        "EXISTS",
        pull,
      );
      passed = passed && pullResult;
      check("PREVIOUS_HIGH", C, prev.h, ">");
      check("ABOVE_EMA", C, t.ema, ">");
      check("ABOVE_VWAP", C, t.vwap, ">");
      check(
        "EMA_DISTANCE",
        C.minus(t.ema),
        A.mul(p.ema_distance_atr_max!),
        "<=",
      );
    }
    check("RVOL", t.rvol, p.rvol_min, ">=");
    result.stops[id] = min(...rows.map((r) => r.l))
      .minus(A.mul(p.stop_atr_buffer))
      .toString();
    if (
      [valid, window, timely, daily, bench, vol, liquid, passed].every(Boolean)
    )
      result.strategies.push(id);
  }
  return result;
}
export function roundedEntry(
  signal: Evaluation,
  id: "B" | "P",
  ask: string,
  unit: string,
) {
  const t = signal.current!,
    parameters = spec.strategies.find((s) => s.id === id)!.parameters;
  const P = tick(ask, unit, true),
    S = tick(signal.stops[id]!, unit);
  const distance = d(P).minus(S);
  return {
    P,
    S,
    valid:
      d(P).lte(
        d(t.c).plus(d(t.atr!).mul(policy.execution.maximum_entry_premium_atr)),
      ) &&
      distance.gte(d(t.atr!).mul(parameters.stop_distance_atr_min)) &&
      distance.lte(d(t.atr!).mul(parameters.stop_distance_atr_max)),
  };
}
