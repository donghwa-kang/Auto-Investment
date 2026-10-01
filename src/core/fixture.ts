import { d, tick, min, max } from "./math.js";
import { session, minute, type Session } from "./calendar.js";
import {
  indicators,
  dailyTrend,
  evaluateFeatures,
  type Bar,
} from "./strategy.js";
import type { Config } from "./policy.js";
import type { Quote } from "./types.js";
import { profile } from "./risk.js";
export interface Fixture {
  raw: Bar[];
  benchmark: Bar[];
  sessions: Session[];
  current: Session;
  symbol: string;
  version: string;
}
// 비상장 합성 식별자만 사용. 실제 기업·휴장·체결 통계를 표현하지 않는다.
export function makeFixture(
  config: Pick<Config, "market" | "scenario">,
  endDate = "2026-08-31",
): Fixture {
  const dates: string[] = [];
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
    !Number.isFinite(end) ||
    new Date(end).toISOString().slice(0, 10) !== endDate
  )
    throw Error("INVALID_SYNTHETIC_FIXTURE_DATE");
  for (let at = end; dates.length < 121; at -= 86400000) {
    const date = new Date(at);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
      dates.unshift(date.toISOString().slice(0, 10));
  }
  const sessions = dates.map((date) => session(date, config.market)!);
  const raw: Bar[] = [],
    benchmark: Bar[] = [];
  const scale = config.market === "KR" ? "1" : "0.01";
  for (let day = 0; day < sessions.length; day++) {
    const s = sessions[day]!,
      isCurrent = day === 120;
    for (let m = 0; m < (s.close - s.open) / minute; m++) {
      const slot = Math.floor(m / 15),
        within = m % 15;
      const base = 20000 + day * 10;
      let c = base + slot * 2,
        h = c + 140,
        l = c - 160,
        v = 20000;
      if (isCurrent) {
        c = base + slot * 5;
        h = c + 60;
        l = c - 140;
        if (config.scenario !== "NO_SIGNAL" && config.scenario !== "P") {
          if (slot === 0) {
            c = 21220;
            h = 21320;
            l = 21100;
          }
          if (slot === 1) {
            c = 21260;
            h = 21350;
            l = 21150;
          }
          if (slot === 2) {
            c = 21400;
            h = 21420;
            l = 21180;
            v = 40000;
          }
        }
        if (config.scenario === "P") {
          const shapes = [
            [21230, 21320, 21100],
            [21200, 21250, 21100],
            [21210, 21260, 21100],
            [21300, 21340, 21120],
          ];
          if (slot < 4) {
            [c, h, l] = shapes[slot] as [number, number, number];
            v = slot === 3 ? 30000 : 20000;
          }
        }
      }
      const make = (
        close: number,
        high: number,
        low: number,
        volume: number,
      ): Bar => ({
        session: s.id,
        openAt: s.open + m * minute,
        closeAt: s.open + (m + 1) * minute,
        availableAt: s.open + (m + 1) * minute,
        revision: 1,
        o: d(close).mul(scale).toString(),
        h: d(high).mul(scale).toString(),
        l: d(low).mul(scale).toString(),
        c: d(close).mul(scale).toString(),
        v: String(volume),
      });
      let row = make(c, h, l, v);
      const anchorMinutes = config.scenario === "P" ? 60 : 45;
      if (isCurrent && m >= anchorMinutes) {
        const anchor = s.open + anchorMinutes * minute;
        const seedPrice = d(
          config.scenario === "P"
            ? "21300"
            : config.scenario === "NO_SIGNAL"
              ? "21210"
              : "21400",
        )
          .mul(scale)
          .toString();
        const times = [
          row.openAt,
          row.closeAt,
          ...[anchor + 9000, anchor + 13000].filter(
            (t) => t >= row.openAt && t <= row.closeAt,
          ),
        ];
        const quotes = times.map((t) =>
          fixtureQuote(config, t, seedPrice, anchor),
        );
        row = {
          ...row,
          o: quotes[0]!.bid,
          c: quotes[1]!.bid,
          h: max(...quotes.map((q) => q.ask)).toString(),
          l: min(...quotes.map((q) => q.bid)).toString(),
          v: "40000",
        };
      }
      raw.push(row);
      const bc = base + slot * 5 + within;
      benchmark.push(make(bc, bc + 5, bc - 20, 20000));
    }
  }
  return {
    raw,
    benchmark,
    sessions,
    current: sessions.at(-1)!,
    symbol: `DEMO-${config.market}-001`,
    version: "SYNTHETIC_V1",
  };
}
export function evaluateFixture(f: Fixture, at: number) {
  return evaluateFeatures(
    indicators(f.raw, f.sessions, at),
    indicators(f.benchmark, f.sessions, at),
    dailyTrend(f.raw, f.sessions, at),
    dailyTrend(f.benchmark, f.sessions, at),
    f.current,
    at,
    f.symbol,
  );
}
export function fixtureQuote(
  config: Pick<Config, "market" | "scenario">,
  at: number,
  signalPrice: string,
  start: number,
): Quote {
  const unit = profile.ticks[config.market];
  const seconds = Math.max(0, Math.floor((at - start) / 1000));
  let ask = d(signalPrice).plus(unit);
  if (seconds > 15) ask = ask.plus(d(unit).mul(Math.min(seconds - 15, 600)));
  if (config.scenario === "GAP" && seconds > 8)
    ask = d(signalPrice).mul(seconds > 12 ? ".94" : ".97");
  const bid = tick(ask.minus(unit), unit);
  return {
    ask: tick(ask, unit, true),
    bid,
    askSize: 10000,
    bidSize: 10000,
    lastMinuteVolume: 40000,
    at,
    halted: false,
  };
}
