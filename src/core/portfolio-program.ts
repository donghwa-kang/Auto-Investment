import { approveEvaluation } from "./approval.js";
import { emptyLedger } from "./ledger.js";
import { d } from "./math.js";
import { hash, policy, policyHash, verifyPolicies } from "./policy.js";
import { profile } from "./risk.js";
import { runSignalReplay } from "./signal-replay.js";
import { parseSignalReplay } from "./signal-replay-schema.js";
import {
  portfolioSettingsSchema,
  type PortfolioTick,
} from "./portfolio-schema.js";
import type { QualityAsset } from "./market-quality-schema.js";
import type { Quote, State } from "./types.js";
import { terminal } from "./types.js";
import { createRvolSource } from "./learning-rvol.js";
import { stressQuote, type ExecutionStress } from "./execution-stress.js";

export class PortfolioProgram {
  readonly #input;
  readonly #settings;
  readonly #report;
  readonly #assets = new Map<string, QualityAsset>();
  readonly runHash: string;
  constructor(raw: unknown, settings: unknown) {
    verifyPolicies();
    this.#input = parseSignalReplay(raw);
    this.#settings = portfolioSettingsSchema.parse(settings);
    this.#report = runSignalReplay(this.#input);
    for (const f of this.#input.frames)
      for (const a of f.market?.assets ?? []) {
        if (a.role !== "INSTRUMENT") continue;
        const key = `${a.identity.market}:${a.identity.instrumentId}`;
        const old = this.#assets.get(key);
        // 1 실행은 종목별 1 세션. 다일/기업행동 중 보유 이월은 아직 지원하지 않는다.
        if (
          old &&
          hash([old.identity, old.sourceId, old.session]) !==
            hash([a.identity, a.sourceId, a.session])
        )
          throw new Error("PORTFOLIO_ASSET_CONTEXT_CHANGED");
        this.#assets.set(key, a);
      }
    const order = this.#settings.candidateOrder;
    if (
      order &&
      (new Set(order).size !== order.length ||
        order.length !== this.#assets.size ||
        order.some((k) => !this.#assets.has(k)))
    )
      throw new Error("PORTFOLIO_CANDIDATE_ORDER_INVALID");
    this.runHash = hash({
      input: this.#report.inputHash,
      settings: this.#settings,
      policyHash,
    });
  }
  report() {
    return structuredClone(this.#report);
  }
  assets() {
    return [...this.#assets].map(([key, asset]) => ({
      key,
      asset: structuredClone(asset),
    }));
  }
  asset(key: string) {
    return structuredClone(this.#assets.get(key));
  }
  learningFeatureSource(decision: State["decisions"][number]) {
    if (decision.result !== "APPROVED") return null;
    const frame = this.#report.frames.find((f) =>
      f.items.some(
        (item) =>
          item.catalogKey === decision.symbol &&
          item.evaluation &&
          decision.trace.some(
            (t) =>
              t.data_version === item.evaluation!.dataVersion &&
              t.as_of === item.evaluation!.at,
          ),
      ),
    );
    const item = frame?.items.find((i) => i.catalogKey === decision.symbol);
    const history = this.#input.histories.find(
      (h) => h.assetKey === item?.assetKey,
    );
    if (
      !frame ||
      !item?.evaluation?.current ||
      !item.historyEvidence ||
      !history
    )
      throw new Error("RVOL_CAPTURE_CONTEXT_MISSING");
    return createRvolSource(history, {
      decisionId: decision.id,
      symbol: decision.symbol,
      asOf: item.evaluation.at,
      signalAt: item.evaluation.current.closeAt,
      dataVersion: item.evaluation.dataVersion,
      sourceDataHash: hash({
        frame: frame.decisionHash,
        history: item.historyEvidence,
      }),
      historyEvidenceHash: item.historyEvidence.instrument,
    });
  }
  private knownActions(at: number, key: string) {
    const asset = this.#assets.get(key);
    const history = this.#input.histories.find(
      (h) => h.assetKey === asset?.assetKey,
    );
    const visible = new Map<
      string,
      NonNullable<typeof history>["actions"][number]
    >();
    for (const action of history?.actions ?? []) {
      if (action.availableAt > at || action.announcedAt > at) continue;
      const old = visible.get(action.eventId);
      if (!old || action.revision > old.revision)
        visible.set(action.eventId, action);
    }
    return [...visible.values()].filter((a) => !a.cancelled);
  }
  actionBlocked(s: State, at: number, key: string) {
    return this.knownActions(at, key).some(
      (a) =>
        !a.cancelled &&
        a.effectiveAt <= at &&
        (s.positions.some(
          (p) =>
            p.symbol === key && p.quantity > 0 && p.firstFillAt < a.effectiveAt,
        ) ||
          s.orders.some(
            (o) =>
              !terminal(o) &&
              o.side === "BUY" &&
              o.snapshot?.instrument_id === key &&
              o.submittedAt < a.effectiveAt,
          )),
    );
  }
  initial(epoch: number): State {
    const config = structuredClone(this.#settings.config);
    const at =
      Math.min(...this.#input.frames.map((f) => Date.parse(f.asOf))) - 1;
    return {
      version: 1,
      revision: 0,
      config,
      status: "STOPPED",
      clock: at,
      sessionOpen: at,
      sessionClose: Math.max(
        ...this.#input.frames.map((f) => Date.parse(f.asOf)),
      ),
      cursor: 0,
      epoch,
      pendingLevel: null,
      ledger: emptyLedger(
        at,
        String(config.capital),
        d(config.usdCapitalKrw).div(profile.fxKrwPerUsd).toString(),
        profile.fxKrwPerUsd,
      ),
      positions: [],
      orders: [],
      decisions: [],
      notices: [],
      lastSignalAt: 0,
      manifest: {
        kind: "OFFLINE_PORTFOLIO_PAPER_V1",
        purpose: "TEST_ONLY",
        runHash: this.runHash,
        processedSignals: [],
      },
      manifestHistory: [],
      fault: null,
      cleanShutdown: false,
    };
  }
  quoteReasons(t: PortfolioTick, key: string): string[] {
    const a = this.#assets.get(key),
      row = t.quotes.find((q) => q.catalogKey === key);
    if (!a || !row || !a.session) return ["PORTFOLIO_QUOTE_MISSING"];
    const q = row.quote;
    if (
      row.sourceId !== a.sourceId ||
      q.at > row.availableAt ||
      row.availableAt > t.at ||
      q.at > t.at ||
      t.at - q.at > policy.execution.maximum_quote_age_seconds * 1000 ||
      q.halted ||
      Date.parse(a.session.availableAt) > t.at ||
      t.at < Date.parse(a.session.openAt) ||
      t.at >= Date.parse(a.session.closeAt)
    )
      return ["PORTFOLIO_QUOTE_OR_SESSION_INVALID"];
    return [];
  }
  evaluate(
    s: State,
    t: PortfolioTick,
    commonReasons: string[],
    stress?: ExecutionStress,
  ) {
    if (t.frameAsOf === null) return;
    const frame = this.#report.frames.find(
      (f) => Date.parse(f.asOf) === t.frameAsOf,
    );
    if (!frame) throw new Error("PORTFOLIO_FRAME_UNKNOWN");
    const processed = s.manifest!.processedSignals as string[];
    const order = this.#settings.candidateOrder;
    const sorted = [...frame.items].sort((a, b) =>
      order
        ? order.indexOf(a.catalogKey) - order.indexOf(b.catalogKey)
        : a.catalogKey.localeCompare(b.catalogKey, "en"),
    );
    for (const item of sorted) {
      // 시그널/봉 단위 중복 방지: epoch나 명령 ID 변경으로 재승인할 수 없다.
      const signalAt = item.evaluation?.current?.closeAt ?? t.at;
      const decisionId = `portfolio-${hash([item.catalogKey, signalAt])}`;
      if (processed.includes(decisionId)) continue;
      processed.push(decisionId);
      const a = this.#assets.get(item.catalogKey);
      const reasons = [
        ...commonReasons,
        ...item.reasons,
        ...this.quoteReasons(t, item.catalogKey),
      ];
      if (!order) reasons.push("MISSING_TEST_CANDIDATE_ORDER");
      if (
        this.knownActions(t.at, item.catalogKey).some(
          (action) =>
            !action.cancelled &&
            action.effectiveAt > t.at &&
            a?.session &&
            action.effectiveAt < Date.parse(a.session.closeAt),
        )
      )
        reasons.push("PORTFOLIO_ACTION_WINDOW_UNSUPPORTED");
      if (this.#settings.syntheticProfileHash !== hash(profile))
        reasons.push("MISSING_OR_CHANGED_TEST_EXECUTION_PROFILE");
      if (
        s.positions.some(
          (p) => p.symbol === item.catalogKey && p.quantity > 0,
        ) ||
        s.orders.some(
          (o) =>
            o.side === "BUY" &&
            !terminal(o) &&
            o.snapshot?.instrument_id === item.catalogKey,
        )
      )
        reasons.push("EXISTING_INSTRUMENT_EXPOSURE");
      const row = t.quotes.find((q) => q.catalogKey === item.catalogKey);
      const quality = frame.preflight.stageReports.market?.items.find(
        (i) => i.assetKey === item.assetKey,
      );
      const records = quality?.selected.map((r) => r.record) ?? [];
      const qr = records.find((r) => r.kind === "QUOTE");
      const bars = records
        .filter((r) => r.kind === "BAR")
        .sort((a, b) => Date.parse(a.closeAt) - Date.parse(b.closeAt));
      const bar = bars.at(-1);
      const originalQuote =
        qr?.kind === "QUOTE" && qr.bid !== null && qr.ask !== null && bar
          ? {
              bid: qr.bid,
              ask: qr.ask,
              bidSize: Number(qr.bidSize),
              askSize: Number(qr.askSize),
              at: Date.parse(qr.observedAt),
              lastMinuteVolume: Number(bar.v),
              halted: false,
            }
          : null;
      const expectedQuote =
        originalQuote && stress && a
          ? stressQuote(originalQuote, a.identity.market, stress)
          : originalQuote;
      if (
        !row ||
        !qr ||
        qr.kind !== "QUOTE" ||
        !bar ||
        !expectedQuote ||
        hash([
          row.quote.bid,
          row.quote.ask,
          row.quote.bidSize,
          row.quote.askSize,
          row.quote.at,
          row.quote.lastMinuteVolume,
        ]) !==
          hash([
            expectedQuote.bid,
            expectedQuote.ask,
            expectedQuote.bidSize,
            expectedQuote.askSize,
            expectedQuote.at,
            expectedQuote.lastMinuteVolume,
          ])
      )
        reasons.push("ENTRY_QUOTE_PREFLIGHT_MISMATCH");
      if (
        !item.evaluation ||
        !a?.session ||
        !row ||
        item.status !== "CHART_SIGNAL"
      ) {
        s.decisions.push({
          id: decisionId,
          at: s.clock,
          symbol: item.catalogKey,
          strategy: null,
          result: "ABSTAIN",
          quantity: 0,
          reasons: [...new Set([...reasons, item.status])],
          trace: structuredClone(item.evaluation?.trace ?? []),
        });
        continue;
      }
      approveEvaluation(
        s,
        { ...item.evaluation, symbol: item.catalogKey },
        {
          quote: row.quote as Quote,
          market: a.identity.market,
          sessionClose: Date.parse(a.session.closeAt),
          dataHash: hash({
            frame: frame.decisionHash,
            history: item.historyEvidence,
          }),
          decisionId,
          reasons: [...new Set(reasons)],
          snapshotContext: {
            session_close: Date.parse(a.session.closeAt),
            portfolio_run_hash: this.runHash,
            catalog_key: item.catalogKey,
            display_symbol: item.symbol,
            test_sequence: order,
            selection_disclaimer: "TEST_ONLY_NOT_INVESTMENT_RANKING",
            ...(stress ? { execution_stress_hash: hash(stress) } : {}),
          },
        },
      );
    }
  }
}
