import { minute, type Session } from "./calendar.js";
import { d } from "./math.js";
import { hash, policy, spec } from "./policy.js";
import type { QualityAsset, QualityRecord } from "./market-quality-schema.js";
import type { SignalHistory, HistoryRow } from "./signal-replay-schema.js";
import type { Bar, Split } from "./strategy.js";

export const historyReasons = {
  HISTORY_MISSING: "연결된 시험 이력이 없습니다.",
  HISTORY_IDENTITY_MISMATCH: "이력과 사전점검의 종목·출처가 다릅니다.",
  HISTORY_BASIS_NOT_RAW: "이력은 명시적인 원시 가격이어야 합니다.",
  HISTORY_SESSION_INVALID:
    "세션 시각·겹침·가용 시점 또는 현재 세션이 잘못됐습니다.",
  HISTORY_WARMUP_MISSING: "원본 기준의 완료 세션 이력이 부족합니다.",
  HISTORY_BAR_MISSING: "선언한 이력 구간의 완료 1분봉이 누락됐습니다.",
  HISTORY_REVISION_CONFLICT: "같은 봉의 현재 정정 버전이 서로 다릅니다.",
  HISTORY_BAR_INVALID:
    "원시 봉의 가격·거래량·시점·완료/중단 상태가 잘못됐습니다.",
  HISTORY_WINDOW_MISMATCH:
    "이력과 사전점검의 현재 세션/시간 창/원시 봉이 다릅니다.",
  HISTORY_ACTIONS_UNKNOWN:
    "이력 전체의 기업행동 확인 범위가 부족하거나 미확인입니다.",
  HISTORY_ACTION_CONFLICT: "기업행동 정정이 상충합니다.",
  HISTORY_ACTION_UNSUPPORTED:
    "세션 개장 경계의 확인된 단순 분할 외 기업행동은 보류합니다.",
} as const;
type Reason = keyof typeof historyReasons;

// 공급원/식별은 각 이력 컨테이너에 고정된다. 외부 출처의 진위를 인증하지 않는다.
export function prepareSignalHistory(
  history: SignalHistory | undefined,
  asset: QualityAsset,
  at: number,
  selectedQuality: QualityRecord[],
) {
  const reasons = new Set<Reason>();
  const bars: Bar[] = [],
    sessions: Session[] = [],
    actions: Split[] = [];
  const selectedRows: { sessionId: string; row: HistoryRow }[] = [];
  const actionEvidence: SignalHistory["actions"] = [];
  let current: Session | null = null;
  if (!history) reasons.add("HISTORY_MISSING");
  else {
    if (
      history.assetKey !== asset.assetKey ||
      hash(history.identity) !== hash(asset.identity) ||
      history.sourceId !== asset.sourceId
    )
      reasons.add("HISTORY_IDENTITY_MISMATCH");
    if (history.basis !== "RAW") reasons.add("HISTORY_BASIS_NOT_RAW");
    if (history.sessions.some((s) => s.openAt <= at && s.availableAt > at))
      reasons.add("HISTORY_SESSION_INVALID");
    const visible = history.sessions
      .filter((s) => s.openAt <= at && s.availableAt <= at)
      .sort(
        (a, b) =>
          a.openAt - b.openAt || a.sessionId.localeCompare(b.sessionId, "en"),
      );
    let previousClose = -1;
    let completedSessions = 0;
    for (const s of visible) {
      const length = (s.closeAt - s.openAt) / minute;
      if (
        !Number.isInteger(length) ||
        length <= 0 ||
        length > 1440 ||
        s.openAt < previousClose ||
        s.availableAt > s.openAt
      ) {
        reasons.add("HISTORY_SESSION_INVALID");
        continue;
      }
      previousClose = s.closeAt;
      const session: Session = {
        id: s.sessionId,
        open: s.openAt,
        close: s.closeAt,
        market: asset.identity.market,
        version: "DECLARED_REPLAY_TEST_CALENDAR_V1",
      };
      sessions.push(session);
      if (s.openAt <= at && at < s.closeAt) current = session;
      if (s.closeAt < at) completedSessions++;
      const rows = new Map<number, HistoryRow>();
      const conflicts = new Set<number>();
      for (const r of s.rows) {
        if (r.availableAt > at || s.openAt + (r.offset + 1) * minute > at)
          continue;
        if (r.offset >= length) {
          reasons.add("HISTORY_BAR_INVALID");
          continue;
        }
        const old = rows.get(r.offset);
        if (!old || r.revision > old.revision) {
          rows.set(r.offset, r);
          conflicts.delete(r.offset);
        } else if (r.revision === old.revision && hash(r) !== hash(old))
          conflicts.add(r.offset);
      }
      if (conflicts.size) reasons.add("HISTORY_REVISION_CONFLICT");
      const expected = Math.min(length, Math.floor((at - s.openAt) / minute));
      for (let offset = 0; offset < expected; offset++) {
        const r = rows.get(offset);
        if (!r || conflicts.has(offset)) {
          reasons.add("HISTORY_BAR_MISSING");
          continue;
        }
        selectedRows.push({ sessionId: s.sessionId, row: r });
        const closeAt = s.openAt + (offset + 1) * minute;
        if (
          r.observedAt < closeAt ||
          r.receivedAt < r.observedAt ||
          r.availableAt < r.receivedAt ||
          !r.completed ||
          r.halted !== false ||
          r.o === null ||
          r.h === null ||
          r.l === null ||
          r.c === null ||
          r.v === null ||
          [r.o, r.h, r.l, r.c].some((v) => d(v!).lte(0)) ||
          d(r.v).lt(0) ||
          d(r.h).lt(r.o) ||
          d(r.h).lt(r.c) ||
          d(r.h).lt(r.l) ||
          d(r.l).gt(r.o) ||
          d(r.l).gt(r.c)
        ) {
          reasons.add("HISTORY_BAR_INVALID");
          continue;
        }
        bars.push({
          session: s.sessionId,
          openAt: closeAt - minute,
          closeAt,
          availableAt: r.availableAt,
          revision: r.revision,
          o: r.o,
          h: r.h,
          l: r.l,
          c: r.c,
          v: r.v,
          halted: false,
        });
      }
    }
    if (
      completedSessions <
      Math.max(
        policy.universe.minimum_history_sessions,
        spec.input_contract.warmup_sessions,
      )
    )
      reasons.add("HISTORY_WARMUP_MISSING");
    if (!current) reasons.add("HISTORY_SESSION_INVALID");
    const declared = asset.session;
    if (
      !declared ||
      !current ||
      declared.sessionId !== current.id ||
      Date.parse(declared.openAt) !== current.open ||
      Date.parse(declared.closeAt) !== current.close
    )
      reasons.add("HISTORY_WINDOW_MISMATCH");
    const byOpen = new Map(bars.map((b) => [b.openAt, b]));
    const currentProof = new Map(
      selectedRows
        .filter((r) => r.sessionId === current?.id)
        .map((r) => [r.row.offset, r.row]),
    );
    const qualityBars = selectedQuality.filter((r) => r.kind === "BAR");
    for (const r of qualityBars) {
      const b = byOpen.get(Date.parse(r.openAt));
      if (
        !b ||
        hash({
          session: r.sessionId,
          openAt: Date.parse(r.openAt),
          closeAt: Date.parse(r.closeAt),
          availableAt: Date.parse(r.availableAt),
          revision: r.revision,
          o: r.o,
          h: r.h,
          l: r.l,
          c: r.c,
          v: r.v,
          halted: r.halted,
        }) !== hash(b)
      )
        reasons.add("HISTORY_WINDOW_MISMATCH");
      const proof =
        r.sessionId === current?.id
          ? currentProof.get((Date.parse(r.openAt) - current.open) / minute)
          : undefined;
      if (
        !proof ||
        proof.observedAt !== Date.parse(r.observedAt) ||
        proof.receivedAt !== Date.parse(r.receivedAt) ||
        proof.completed !== r.completed
      )
        reasons.add("HISTORY_WINDOW_MISMATCH");
    }
    if (!qualityBars.length) reasons.add("HISTORY_WINDOW_MISMATCH");
    const coverage = history.actionCoverage;
    if (
      !coverage ||
      coverage.status !== "KNOWN" ||
      coverage.availableAt > at ||
      coverage.from > (sessions[0]?.open ?? at) ||
      coverage.to < at
    )
      reasons.add("HISTORY_ACTIONS_UNKNOWN");
    const events = new Map<string, SignalHistory["actions"][number]>(),
      conflicts = new Set<string>();
    const firstEffective = new Map<string, number>();
    for (const action of history.actions) {
      if (action.availableAt > at || action.announcedAt > at) continue;
      const old = events.get(action.eventId);
      if (!old || action.revision > old.revision) {
        events.set(action.eventId, action);
        conflicts.delete(action.eventId);
        firstEffective.set(action.eventId, action.effectiveAt);
      } else if (
        action.revision === old.revision &&
        hash(action) !== hash(old)
      ) {
        conflicts.add(action.eventId);
        firstEffective.set(
          action.eventId,
          Math.min(firstEffective.get(action.eventId)!, action.effectiveAt),
        );
      }
    }
    for (const a of [...events.values()].sort(
      (a, b) =>
        a.effectiveAt - b.effectiveAt ||
        a.eventId.localeCompare(b.eventId, "en"),
    )) {
      // 아직 효력 없는 사건은 계산에 넣지 않는다. 상충의 효력/취소를 임의 선택하지 않는다.
      if (firstEffective.get(a.eventId)! > at) continue;
      if (conflicts.has(a.eventId)) {
        reasons.add("HISTORY_ACTION_CONFLICT");
        continue;
      }
      if (a.effectiveAt > at) continue;
      if (a.announcedAt > a.availableAt) {
        reasons.add("HISTORY_ACTION_UNSUPPORTED");
        continue;
      }
      if (a.cancelled || a.effectiveAt < (sessions[0]?.open ?? at)) continue;
      actionEvidence.push(a);
      if (
        a.kind !== "SPLIT" ||
        a.ratio === null ||
        d(a.ratio).lte(0) ||
        !sessions.some((s) => s.open === a.effectiveAt) ||
        a.effectiveAt > Date.parse(asset.windowFrom)
      ) {
        reasons.add("HISTORY_ACTION_UNSUPPORTED");
        continue;
      }
      actions.push({
        announcedAt: a.announcedAt,
        availableAt: a.availableAt,
        effectiveAt: a.effectiveAt,
        ratio: a.ratio,
      });
    }
    if (new Set(actions.map((a) => a.effectiveAt)).size !== actions.length)
      reasons.add("HISTORY_ACTION_CONFLICT");
  }
  const evidence = {
    assetKey: asset.assetKey,
    identity: asset.identity,
    sourceId: asset.sourceId,
    datasetId: history?.datasetId ?? null,
    sessions,
    selectedRows,
    actions,
    actionEvidence,
    actionCoverage: history?.actionCoverage ?? null,
  };
  return {
    reasons: [...reasons].sort(),
    bars,
    sessions,
    current,
    actions,
    actionEvidence,
    evidenceHash: hash(evidence),
    counts: {
      sessions: sessions.filter((s) => s.close < at).length,
      bars: bars.length,
      splits: actions.length,
    },
  };
}
