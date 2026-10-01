import template from "../../fixtures/multi-preflight-v1.json" with { type: "json" };
import { makeFixture } from "./fixture.js";
import { minute } from "./calendar.js";
import { hash, policy, policyHash } from "./policy.js";
import { classifyCatalog } from "./catalog.js";
import { enrichCatalog } from "./catalog-enrichment.js";
import { parseMultiPreflight } from "./multi-preflight-schema.js";
import type { QualityInput } from "./market-quality-schema.js";
import {
  parseSignalReplay,
  type SignalHistory,
  type SignalReplayInput,
} from "./signal-replay-schema.js";
import { replayProfileHash } from "./signal-replay.js";

// 별도 샘플 생성 명령에서만 호출한다. 사용자 이력의 누락을 자동 보충하는 공급기가 아니다.
export function makeSignalReplayFixture(
  market: "KR" | "US" = "KR",
  endDate = "2026-08-31",
): SignalReplayInput {
  const b = makeFixture({ market, scenario: "B" }, endDate),
    p = makeFixture({ market, scenario: "P" }, endDate);
  const histories: SignalHistory[] = [b.raw, p.raw, b.benchmark].map(
    (raw, i) => {
      const assetKey = `REPLAY-${market}-${["B", "P", "BENCH"][i]}`;
      const bySession = new Map<string, typeof raw>();
      for (const row of raw) {
        const rows = bySession.get(row.session) ?? [];
        rows.push(row);
        bySession.set(row.session, rows);
      }
      return {
        schemaVersion: "OFFLINE_SIGNAL_HISTORY_V1",
        purpose: "TEST_ONLY",
        datasetId: "SYNTHETIC_REPLAY_SAMPLE_V1",
        assetKey,
        identity: {
          instrumentId: assetKey,
          symbol: assetKey,
          market,
          venue: `TEST-${market}`,
          currency: market === "KR" ? "KRW" : "USD",
        },
        sourceId: "TEST-FEED",
        basis: "RAW",
        sessions: b.sessions.map((s) => ({
          sessionId: s.id.replaceAll(":", "-"),
          openAt: s.open,
          closeAt: s.close,
          availableAt: s.open - minute,
          rows: bySession.get(s.id)!.map((r) => ({
            offset: (r.openAt - s.open) / minute,
            observedAt: r.closeAt,
            receivedAt: r.availableAt,
            availableAt: r.availableAt,
            revision: r.revision,
            o: r.o,
            h: r.h,
            l: r.l,
            c: r.c,
            v: r.v,
            completed: true,
            halted: false,
          })),
        })),
        actionCoverage: {
          from: b.sessions[0]!.open,
          to: b.current.close,
          availableAt: b.current.open - minute,
          status: "KNOWN",
        },
        actions: [],
      };
    },
  );
  const frames = [45, 60].map((m) => {
    const at = b.current.open + m * minute,
      iso = (n: number) => new Date(n).toISOString(),
      asOf = iso(at);
    const frame = parseMultiPreflight(structuredClone(template));
    frame.asOf = asOf;
    const catalog = frame.enrichment.catalog;
    catalog.asOf = asOf;
    const base = catalog.records[1]!;
    catalog.records = histories.map((h) => ({
      ...base,
      ...h.identity,
      observedAt: iso(b.current.open - minute),
      receivedAt: iso(b.current.open - minute),
      availableAt: iso(b.current.open - minute),
      effectiveAt: iso(b.current.open - minute),
    }));
    frame.enrichment.evidence = [];
    const assets: QualityInput["assets"] = histories.map((h, i) => ({
      assetKey: h.assetKey,
      identity: h.identity,
      sourceId: h.sourceId,
      role: i === 2 ? "BENCHMARK" : "INSTRUMENT",
      benchmarkKey: i === 2 ? null : histories[2]!.assetKey,
      session: {
        sessionId: b.current.id.replaceAll(":", "-"),
        openAt: iso(b.current.open),
        closeAt: iso(b.current.close),
        availableAt: iso(b.current.open - minute),
      },
      windowFrom: iso(b.current.open),
      windowTo: iso(at),
      actionContext: {
        status: "NO_ACTIONS_IN_WINDOW",
        availableAt: iso(b.current.open - minute),
      },
    }));
    const records: QualityInput["records"] = [];
    for (const h of histories) {
      const rows = h.sessions.at(-1)!.rows.filter((r) => r.offset < m);
      for (const r of rows)
        records.push({
          kind: "BAR",
          recordId: `${h.assetKey}-${r.offset}`,
          assetKey: h.assetKey,
          sourceId: h.sourceId,
          identity: h.identity,
          revision: r.revision,
          observedAt: iso(r.observedAt),
          receivedAt: iso(r.receivedAt),
          availableAt: iso(r.availableAt),
          basis: "RAW",
          sessionId: b.current.id.replaceAll(":", "-"),
          openAt: iso(b.current.open + r.offset * minute),
          closeAt: iso(b.current.open + (r.offset + 1) * minute),
          completed: true,
          halted: false,
          o: r.o,
          h: r.h,
          l: r.l,
          c: r.c,
          v: r.v,
        });
      if (h.assetKey === histories[2]!.assetKey) continue;
      const common = {
        assetKey: h.assetKey,
        sourceId: h.sourceId,
        identity: h.identity,
        revision: 1,
        observedAt: asOf,
        receivedAt: asOf,
        availableAt: asOf,
        basis: "RAW" as const,
      };
      const price = rows.at(-1)!.c;
      records.push({
        ...common,
        recordId: `${h.assetKey}-PRICE`,
        kind: "PRICE",
        price,
      });
      records.push({
        ...common,
        recordId: `${h.assetKey}-QUOTE`,
        kind: "QUOTE",
        bid: price,
        ask: price,
        bidSize: "10000",
        askSize: "10000",
      });
    }
    frame.market = {
      schemaVersion: "OFFLINE_MARKET_QUALITY_V1",
      purpose: "TEST_ONLY",
      asOf,
      profile: {
        profileId: "TEST-REPLAY-QUALITY",
        purpose: "TEST_ONLY",
        lastPriceMaxAgeMs: 2000,
        windowEndMaxAgeMs: 2000,
      },
      sources: [{ sourceId: "TEST-FEED", kinds: ["BAR", "PRICE", "QUOTE"] }],
      assets,
      records,
    };
    const classified = classifyCatalog(catalog),
      enriched = enrichCatalog(frame.enrichment);
    frame.bindings = assets.map((a) => ({
      assetKey: a.assetKey,
      market: a.identity.market,
      instrumentId: a.identity.instrumentId,
      baseRecordHash: classified.items.find(
        (c) => c.key === `${market}:${a.assetKey}`,
      )!.recordHash,
      enrichedItemHash: hash(
        enriched.items.find((c) => c.key === `${market}:${a.assetKey}`)!,
      ),
      qualityAssetHash: hash(a),
    }));
    return frame;
  });
  return parseSignalReplay({
    schemaVersion: "OFFLINE_SIGNAL_REPLAY_V1",
    purpose: "TEST_ONLY",
    experimentId: `SYNTHETIC-${market}-SIGNAL-REPLAY-V1`,
    profileHash: replayProfileHash,
    policyHash,
    strategyDefinitionHash: policy.shared_strategy_contract.definition_sha256,
    frames,
    histories,
  });
}
