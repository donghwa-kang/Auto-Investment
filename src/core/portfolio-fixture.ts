import { hash } from "./policy.js";
import { profile } from "./risk.js";
import type { SignalReplayInput } from "./signal-replay-schema.js";
import type { PortfolioSettings, PortfolioTick } from "./portfolio-schema.js";

// 생성 명령에서만 사용하는, 가격 경로를 명시한 합성 체결 입력. 실제 시장/성과 자료가 아니다.
export function portfolioFixture(input: SignalReplayInput) {
  const keys = [
    ...new Set(
      input.frames.flatMap(
        (f) =>
          f.market?.assets
            .filter((a) => a.role === "INSTRUMENT")
            .map((a) => `${a.identity.market}:${a.identity.instrumentId}`) ??
          [],
      ),
    ),
  ].sort();
  const settings: PortfolioSettings = {
    purpose: "TEST_ONLY",
    syntheticProfileHash: hash(profile),
    candidateOrder: keys,
    candidateOrderMeaning: "TEST_SEQUENCE_NOT_INVESTMENT_RANKING",
    config: {
      capital: 5000000,
      usdCapitalKrw: 0,
      level: "LOW",
      mode: "PAPER",
      forecast: "TEST_ONLY",
      stage: "PILOT",
      scenario: "B",
      market: "KR",
    },
  };
  const ticks = input.frames
    .map((f): PortfolioTick => {
      const at = Date.parse(f.asOf);
      return {
        type: "tick",
        at,
        accountAt: at,
        fx: { rate: profile.fxKrwPerUsd, at },
        frameAsOf: at,
        quotes: f
          .market!.assets.filter((a) => a.role === "INSTRUMENT")
          .map((a) => {
            const rows = f.market!.records.filter(
              (r) => r.assetKey === a.assetKey,
            );
            const q = rows.find((r) => r.kind === "QUOTE")!;
            const b = rows
              .filter((r) => r.kind === "BAR")
              .sort((a, b) => Date.parse(a.closeAt) - Date.parse(b.closeAt))
              .at(-1)!;
            if (q.kind !== "QUOTE" || q.bid === null || q.ask === null)
              throw new Error("SAMPLE_QUOTE_MISSING");
            return {
              catalogKey: `${a.identity.market}:${a.identity.instrumentId}`,
              sourceId: a.sourceId!,
              availableAt: at,
              quote: {
                bid: q.bid,
                ask: q.ask,
                bidSize: Number(q.bidSize),
                askSize: Number(q.askSize),
                lastMinuteVolume: Number(b.v),
                at,
                halted: false,
              },
            };
          }),
      };
    })
    .sort((a, b) => a.at - b.at);
  const commands: unknown[] = [{ type: "start" }];
  for (const base of ticks) {
    if (commands.length > 1)
      commands.push({ type: "reconcile" }, { type: "start" });
    commands.push(base);
    for (let i = 1; i <= 20; i++) {
      if (i === 10) commands.push({ type: "liquidate", confirm: true });
      commands.push(laterTick(base, i));
    }
  }
  return { settings, ticks, commands };
}
export function laterTick(base: PortfolioTick, seconds: number): PortfolioTick {
  const tick = structuredClone(base),
    at = base.at + seconds * 1000;
  tick.at = at;
  tick.accountAt = at;
  tick.fx.at = at;
  tick.frameAsOf = null;
  for (const row of tick.quotes) {
    row.availableAt = at;
    row.quote.at = at;
  }
  return tick;
}
