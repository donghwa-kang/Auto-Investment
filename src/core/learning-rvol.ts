import replayProfile from "../../profiles/signal-replay-v1.json" with { type: "json" };
import { minute } from "./calendar.js";
import { d, Decimal } from "./math.js";
import { hash, spec } from "./policy.js";
import type { SignalHistory, HistoryRow } from "./signal-replay-schema.js";
import {
  rvolSourceSchema,
  RvolSourceError,
  type RvolContext,
  type RvolSource,
} from "./learning-rvol-schema.js";

const requireSource = (ok: boolean, code: string) => {
  if (!ok) throw new RvolSourceError(code);
};
// 전략 평가기/aggregate/indicators/median을 호출하지 않는 독립 RVOL 계산 경로.
function selectSource(history: SignalHistory, at: number, signalAt: number) {
  requireSource(history.basis === "RAW", "RVOL_SOURCE_NOT_RAW");
  const width = spec.input_contract.signal_bar_minutes,
    references = spec.indicators.relative_volume.reference_sessions;
  requireSource(width === 15 && references === 20, "RVOL_DEFINITION_CHANGED");
  const sessions = history.sessions
    .filter((s) => s.openAt <= at && s.availableAt <= at)
    .sort((a, b) => a.openAt - b.openAt);
  const ids = new Set<string>();
  let lastClose = -1;
  for (const s of sessions) {
    const length = (s.closeAt - s.openAt) / minute;
    requireSource(
      !ids.has(s.sessionId) &&
        Number.isInteger(length) &&
        length > 0 &&
        length <= 1440 &&
        s.openAt >= lastClose &&
        s.availableAt <= s.openAt,
      "RVOL_SESSION_INVALID",
    );
    ids.add(s.sessionId);
    lastClose = s.closeAt;
  }
  requireSource(
    !history.sessions.some((s) => s.openAt <= at && s.availableAt > at),
    "RVOL_SESSION_UNAVAILABLE",
  );
  const current = sessions.find((s) => s.openAt <= at && at < s.closeAt);
  requireSource(!!current && signalAt <= at, "RVOL_SIGNAL_TIME_INVALID");
  const offset = (signalAt - current!.openAt) / minute - width;
  requireSource(
    offset >= 0 &&
      Number.isInteger(offset / width) &&
      signalAt <= current!.closeAt &&
      Math.floor((at - current!.openAt) / (width * minute)) * width * minute +
        current!.openAt ===
        signalAt,
    "RVOL_SIGNAL_TIME_INVALID",
  );
  const prior = sessions
    .filter(
      (s) =>
        s.closeAt <= current!.openAt &&
        s.closeAt - s.openAt >= (offset + width) * minute,
    )
    .slice(-references);
  requireSource(prior.length === references, "RVOL_REFERENCE_SESSIONS_MISSING");
  const required = new Set([...prior, current!].map((s) => s.sessionId));
  const selected = sessions.map((s) => {
    const rows: HistoryRow[] = [];
    if (required.has(s.sessionId)) {
      for (let i = offset; i < offset + width; i++) {
        const visible = s.rows.filter(
          (r) =>
            r.offset === i &&
            r.availableAt <= at &&
            s.openAt + (i + 1) * minute <= at,
        );
        const revision = Math.max(-1, ...visible.map((r) => r.revision));
        const latest = visible.filter((r) => r.revision === revision);
        requireSource(latest.length > 0, "RVOL_REQUIRED_BAR_MISSING");
        requireSource(
          new Set(latest.map((r) => hash(r))).size === 1,
          "RVOL_REVISION_CONFLICT",
        );
        const r = latest[0]!;
        requireSource(
          r.observedAt >= s.openAt + (i + 1) * minute &&
            r.receivedAt >= r.observedAt &&
            r.availableAt >= r.receivedAt &&
            r.completed &&
            r.halted === false &&
            [r.o, r.h, r.l, r.c, r.v].every((v) => v !== null) &&
            d(r.v!).gte(0) &&
            d(r.l!).gt(0) &&
            d(r.h!).gte(r.l!) &&
            d(r.h!).gte(r.o!) &&
            d(r.h!).gte(r.c!) &&
            d(r.l!).lte(r.o!) &&
            d(r.l!).lte(r.c!),
          "RVOL_REQUIRED_BAR_INVALID",
        );
        rows.push(structuredClone(r));
      }
    }
    return { ...s, rows };
  });
  const coverage = history.actionCoverage;
  requireSource(
    !!coverage &&
      coverage.status === "KNOWN" &&
      coverage.availableAt <= at &&
      coverage.from <= sessions[0]!.openAt &&
      coverage.to >= at,
    "RVOL_ACTIONS_UNKNOWN",
  );
  const actions = new Map<string, SignalHistory["actions"][number]>();
  for (const a of history.actions) {
    if (a.availableAt > at || a.announcedAt > at) continue;
    const old = actions.get(a.eventId);
    if (!old || a.revision > old.revision) actions.set(a.eventId, a);
  }
  for (const a of actions.values()) {
    requireSource(
      !history.actions.some(
        (b) =>
          b.eventId === a.eventId &&
          b.revision === a.revision &&
          b.availableAt <= at &&
          b.announcedAt <= at &&
          hash(b) !== hash(a),
      ),
      "RVOL_ACTION_CONFLICT",
    );
  }
  const effective = [...actions.values()]
    .filter(
      (a) =>
        a.effectiveAt <= at &&
        !a.cancelled &&
        a.effectiveAt >= sessions[0]!.openAt,
    )
    .sort(
      (a, b) =>
        a.effectiveAt - b.effectiveAt ||
        a.eventId.localeCompare(b.eventId, "en"),
    );
  requireSource(
    new Set(effective.map((a) => a.effectiveAt)).size === effective.length,
    "RVOL_ACTION_CONFLICT",
  );
  for (const a of effective)
    requireSource(
      a.kind === "SPLIT" &&
        a.ratio !== null &&
        d(a.ratio).gt(0) &&
        a.announcedAt <= a.availableAt &&
        sessions.some((s) => s.openAt === a.effectiveAt),
      "RVOL_ACTION_UNSUPPORTED",
    );
  return {
    ...history,
    sessions: selected,
    actions: structuredClone(effective),
    actionCoverage: { ...coverage!, to: at },
  };
}

export function createRvolSource(
  history: SignalHistory,
  context: RvolContext,
): RvolSource {
  const body = {
    schemaVersion: "LEARNING_RVOL_SOURCE_V1" as const,
    purpose: "TEST_ONLY" as const,
    ...context,
    strategyHash: hash(spec),
    replayProfileHash: hash(replayProfile),
    numericProfile: "DECIMAL40_V1" as const,
    history: selectSource(history, context.asOf, context.signalAt),
  };
  return rvolSourceSchema.parse({ ...body, sourceHash: hash(body) });
}

export function rebuildRvol(raw: unknown) {
  const parsed = rvolSourceSchema.safeParse(raw);
  requireSource(parsed.success, "RVOL_SOURCE_SCHEMA_INVALID");
  const source = parsed.data!;
  const { sourceHash, ...body } = source;
  requireSource(hash(body) === sourceHash, "RVOL_SOURCE_HASH_MISMATCH");
  requireSource(
    source.strategyHash === hash(spec) &&
      source.replayProfileHash === hash(replayProfile) &&
      Decimal.precision === 40 &&
      Decimal.rounding === Decimal.ROUND_HALF_EVEN,
    "RVOL_PROFILE_MISMATCH",
  );
  const h = selectSource(source.history, source.asOf, source.signalAt);
  requireSource(hash(h) === hash(source.history), "RVOL_SOURCE_NOT_CANONICAL");
  const windows = h.sessions
    .filter((s) => s.rows.length > 0)
    .map((s) => {
      let volume = d(0);
      for (const r of s.rows) {
        let v = d(r.v!);
        for (const a of h.actions)
          if (s.openAt + (r.offset + 1) * minute <= a.effectiveAt)
            v = v.mul(a.ratio!);
        volume = volume.plus(v);
      }
      return { sessionId: s.sessionId, volume: volume.toString() };
    });
  const current = windows.at(-1)!,
    refs = windows.slice(0, -1);
  const sorted = refs.map((r) => d(r.volume)).sort((a, b) => a.cmp(b));
  const median = sorted[9]!.plus(sorted[10]!).div(2);
  requireSource(median.gt(0), "RVOL_ZERO_DENOMINATOR");
  return {
    value: d(current.volume).div(median).toString(),
    numerator: current.volume,
    denominator: median.toString(),
    referenceWindows: refs,
    currentSessionId: current.sessionId,
    selectedBarCount: h.sessions.reduce((n, s) => n + s.rows.length, 0),
    sourceHash,
  };
}
