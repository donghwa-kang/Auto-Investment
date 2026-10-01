import { z } from "zod";
import { PortfolioProgram } from "../core/portfolio-program.js";
import { portfolioSettingsSchema } from "../core/portfolio-schema.js";
import { parseSignalReplay } from "../core/signal-replay-schema.js";
import { costSizingRequestSchema } from "../core/cost-aware-sizing.js";
import type { CostSizingRequest } from "../core/cost-aware-sizing.js";
import { costProfileSchema } from "../core/transaction-cost.js";
import { costJournalConfigSchema } from "../core/cost-journal.js";
import { emptyLedger } from "../core/ledger.js";
import { hash, policy, policyHash } from "../core/policy.js";
import { profile } from "../core/risk.js";
import { roundedEntry } from "../core/strategy.js";
import { d } from "../core/math.js";
import { minute, completedRiskWindow } from "../core/calendar.js";
import { outcomeKind } from "../core/cost-reservation.js";
import type { OutcomeConfig } from "../core/cost-outcome.js";
import type { CostReservationStore } from "./cost-reservation-store.js";
import {
  operatingKind,
  operatingContractHash,
} from "../core/cost-operating.js";
import type { OperatingConfig } from "../core/cost-operating.js";
import { finalizationContractHash } from "../core/cost-finalization.js";
import { costLoopCloseContract } from "../core/cost-loop-schema.js";
import { historyAdmissionHash } from "../core/cost-history-admission.js";

export const costSignalSelectionSchema = z.strictObject({
  kind: z.literal("SYNTHETIC_COST_SIGNAL_SELECTION_V1"),
  purpose: z.literal("TEST_ONLY"),
  frameAsOf: costJournalConfigSchema.shape.horizonEnd,
  catalogKey: z.string().min(1).max(163),
  profile: costProfileSchema,
  forecast: costSizingRequestSchema.shape.forecast,
  adverseExitTicks: costSizingRequestSchema.shape.adverseExitTicks,
});

function hold(code: string): never {
  throw Error(`COST_SIGNAL_HOLD:${code}`);
}
function shares(raw: string | null) {
  if (raw === null || !d(raw).isInteger() || d(raw).lt(0) || d(raw).gt(1e9))
    hold("INVALID_QUOTE_QUANTITY");
  // Only bounded integral share counts become numbers, never prices/ATR.
  return d(raw).toNumber();
}

// Narrow developer-only bridge. No broker, database lifecycle, fill generator,
// second financial writer, or mutation of an existing PortfolioPaperEngine.
export class CostSignalProgram {
  readonly #config: OutcomeConfig;
  readonly #selection;
  readonly #evidence;
  readonly #frame;
  readonly #request: Omit<CostSizingRequest, "stateHash">;
  readonly signalBasisHash: string;
  readonly reservationId: string;

  constructor(
    rawReplay: unknown,
    rawSettings: unknown,
    rawSelection: unknown,
    rawOptions: unknown = {},
  ) {
    const options = z
      .strictObject({
        executionLoop: z.literal(true).optional(),
        watchdog: z.literal(true).optional(),
      })
      .parse(rawOptions);
    if (options.watchdog && !options.executionLoop)
      hold("WATCHDOG_REQUIRES_LOOP");
    const input = parseSignalReplay(rawReplay),
      settings = portfolioSettingsSchema.parse(rawSettings),
      selection = costSignalSelectionSchema.parse(rawSelection),
      program = new PortfolioProgram(input, settings),
      report = program.report(),
      at = selection.frameAsOf,
      frame = report.frames.find((f) => Date.parse(f.asOf) === at),
      item = frame?.items.find((i) => i.catalogKey === selection.catalogKey),
      asset = program.asset(selection.catalogKey);
    if (
      settings.config.usdCapitalKrw !== 0 ||
      settings.config.forecast !== "TEST_ONLY" ||
      settings.syntheticProfileHash !== hash(profile) ||
      !settings.candidateOrder?.includes(selection.catalogKey)
    )
      hold("TEST_SETTINGS_REQUIRED");
    if (
      !frame ||
      !item ||
      !asset?.session ||
      asset.identity.market !== "KR" ||
      asset.identity.currency !== "KRW"
    )
      hold("SINGLE_KRW_TARGET_REQUIRED");
    const e = item.evaluation;
    if (
      item.status !== "CHART_SIGNAL" ||
      !e?.current ||
      e.strategies.length !== 1
    )
      hold("SINGLE_VALIDATED_CHART_SIGNAL_REQUIRED");
    const facts = frame.preflight.stageReports.enrichment.items.find(
      (i) => i.key === item.catalogKey,
    )?.facts;
    const product =
      facts?.kind === "STOCK" && facts.leveraged === false
        ? "EQUITY"
        : facts?.kind === "ETF" && facts.leveraged !== null
          ? facts.leveraged
            ? "LEVERAGED_ETF"
            : "ETF"
          : null;
    if (
      !product ||
      hash(selection.profile.scope) !==
        hash({ market: "KR", currency: "KRW", product })
    )
      hold("COST_PRODUCT_SCOPE_MISMATCH");
    const records =
      frame.preflight.stageReports.market?.items
        .find((i) => i.assetKey === item.assetKey)
        ?.selected.map((r) => r.record) ?? [];
    const quote = records.find((r) => r.kind === "QUOTE"),
      bar = records
        .filter((r) => r.kind === "BAR")
        .sort((a, b) => Date.parse(a.closeAt) - Date.parse(b.closeAt))
        .at(-1);
    if (
      !quote ||
      quote.bid === null ||
      quote.ask === null ||
      !bar ||
      !e.current.atr
    )
      hold("SELECTED_QUOTE_OR_BAR_MISSING");
    const q = {
      bid: quote.bid,
      ask: quote.ask,
      bidSize: shares(quote.bidSize),
      askSize: shares(quote.askSize),
      lastMinuteVolume: shares(bar.v),
      at: Date.parse(quote.observedAt),
      halted: false,
    };
    const quoteReasons = program.quoteReasons(
      {
        type: "tick",
        at,
        accountAt: at,
        fx: { rate: profile.fxKrwPerUsd, at },
        frameAsOf: at,
        quotes: [
          {
            catalogKey: item.catalogKey,
            sourceId: quote.sourceId,
            availableAt: Date.parse(quote.availableAt),
            quote: q,
          },
        ],
      },
      item.catalogKey,
    );
    if (quoteReasons.length) hold(quoteReasons.join(","));
    const sessionClose = Date.parse(asset.session.closeAt),
      horizonEnd = Math.min(
        sessionClose - policy.exit_policy.close_buffer_minutes * minute,
        at + policy.exit_policy.maximum_holding_minutes * minute,
      );
    if (
      horizonEnd - at <
      policy.exit_policy.minimum_planned_holding_minutes * minute
    )
      hold("HOLDING_WINDOW");
    if (
      selection.profile.effectiveTo <= horizonEnd ||
      selection.profile.effectiveFrom > at ||
      selection.profile.availableAt > at
    )
      hold("COST_PROFILE_HORIZON");
    const actions = new Map<
      string,
      (typeof input.histories)[number]["actions"][number]
    >();
    for (const a of input.histories.find((h) => h.assetKey === item.assetKey)
      ?.actions ?? []) {
      if (a.availableAt > at || a.announcedAt > at) continue;
      const old = actions.get(a.eventId);
      if (!old || a.revision > old.revision) actions.set(a.eventId, a);
    }
    if (
      [...actions.values()].some(
        (a) =>
          !a.cancelled && a.effectiveAt > at && a.effectiveAt < sessionClose,
      )
    )
      hold("PORTFOLIO_ACTION_WINDOW_UNSUPPORTED");
    const strategy = e.strategies[0]!,
      rounded = roundedEntry(e, strategy, q.ask, profile.ticks.KR);
    if (!rounded.valid) hold("ROUNDED_PRICE_OR_STOP_DISTANCE");
    this.#selection = selection;
    this.#frame = frame;
    this.#evidence = {
      replayInputHash: report.inputHash,
      portfolioRunHash: program.runHash,
      frameHash: frame.decisionHash,
      policyHash,
      selection,
      identity: asset.identity,
      evaluation: e,
      historyEvidence: item.historyEvidence,
      quoteRecordHash: hash(quote),
      volumeRecordHash: hash(bar),
    };
    this.signalBasisHash = hash(this.#evidence);
    this.reservationId = `signal-${this.signalBasisHash}`;
    this.#request = costSizingRequestSchema.omit({ stateHash: true }).parse({
      purpose: "TEST_ONLY",
      provenance: "SYNTHETIC_FIXTURE",
      policyHash,
      profileHash: hash(selection.profile),
      product,
      strategy,
      symbol: asset.identity.instrumentId,
      signalAt: e.current.closeAt,
      quote: q,
      tickSize: profile.ticks.KR,
      stop: rounded.S,
      atr: e.current.atr,
      signalClose: e.current.c,
      forecast: selection.forecast,
      executionModel: "ONE_ORDER_PER_SIDE_ONE_SHARE_FILLS",
      adverseExitTicks: selection.adverseExitTicks,
    });
    const seed = program.initial(1);
    // This is a NEW explicitly started synthetic account, never imported cash.
    seed.clock = at;
    seed.status = "RUNNING";
    seed.sessionOpen = Date.parse(asset.session.openAt);
    seed.sessionClose = sessionClose;
    seed.ledger = emptyLedger(
      at,
      String(settings.config.capital),
      "0",
      profile.fxKrwPerUsd,
    );
    seed.manifest = {
      kind: "SYNTHETIC_COST_SIGNAL_V1",
      purpose: "TEST_ONLY",
      signalBasisHash: this.signalBasisHash,
    };
    this.#config = {
      kind: outcomeKind,
      runId: this.reservationId,
      seed,
      book: {
        kind: "SYNTHETIC_COST_RISK_BOOK_V1",
        policyHash,
        seedHash: hash(seed),
        initialAt: at,
        openingFx: profile.fxKrwPerUsd,
        riskEvidence: "EXPLICIT_SYNTHETIC_SNAPSHOT_NOT_CONTINUOUS_HISTORY",
        sources: [],
      },
      sourceScope: {
        provider: "SYNTHETIC",
        account: "cost-signal-test",
        namespace: this.reservationId,
      },
      horizonEnd: options.executionLoop
        ? Math.min(sessionClose, selection.profile.effectiveTo - 1)
        : horizonEnd,
      ...(options.executionLoop
        ? {
            executionLoop: {
              kind: "SYNTHETIC_COST_LOOP_V1" as const,
              purpose: "TEST_ONLY" as const,
              cancelLatencyMs: 2000 as const,
              ...(options.watchdog ? { watchdog: true as const } : {}),
            },
          }
        : {}),
    };
  }
  config() {
    return structuredClone(this.#config);
  }
  signalEvidence() {
    return structuredClone(this.#evidence);
  }
  // Pure source comparison for offline consumers; never issues an approval.
  proposalForEvidence(stateHash: string) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(stateHash);
    return this.proposal(stateHash);
  }
  frameForEvidence() {
    return structuredClone(this.#frame);
  }
  // Explicit new-run adapter. Does not change this program's V3 config/evidence
  // or expose a pretend V4 report. The same source signal and proposal are used.
  operatingLoop(rawOptions: unknown = {}) {
    const options = z
      .strictObject({
        finalization: z.literal(true).optional(),
        historyAdmission: z.literal(true).optional(),
      })
      .parse(rawOptions);
    const { executionLoop, ...base } = this.#config;
    if (!executionLoop) hold("OPERATING_LOOP_REQUIRES_LOOP");
    const periodStart = completedRiskWindow(base.seed.clock).endExclusive;
    const config: OperatingConfig = {
      ...structuredClone(base),
      kind: operatingKind,
      ...(options.historyAdmission
        ? {
            historyAdmission: {
              contractHash: historyAdmissionHash,
              purpose: "TEST_ONLY" as const,
              priorUnresolvedCarry: "NONE_SYNTHETIC_DECLARATION" as const,
            },
          }
        : {}),
      operating: {
        contractHash: operatingContractHash,
        periodStart,
        periodEnd: periodStart + 86400000,
        priorMonthIncurredKrw: "0",
        priorMonthReservedKrw: "0",
      },
      operatingLoop: {
        ...executionLoop,
        kind: "SYNTHETIC_COST_OPERATING_LOOP_V1",
        signalBasisHash: this.signalBasisHash,
        ...(options.finalization
          ? { closeContract: costLoopCloseContract }
          : {}),
      },
      ...(options.finalization
        ? { finalization: { contractHash: finalizationContractHash } }
        : {}),
    };
    return {
      config: () => structuredClone(config),
      signalEvidence: () => this.signalEvidence(),
      signalBasisHash: this.signalBasisHash,
      reservationId: this.reservationId,
      prepareEntry: (
        store: CostReservationStore,
        operatingHistory?: unknown,
      ) => {
        if (!options.historyAdmission && operatingHistory !== undefined)
          hold("HISTORY_ADMISSION_OPT_IN_REQUIRED");
        const state = store.read();
        for (const a of state.approvals) {
          const signalProposal = structuredClone(a.proposal);
          if (options.historyAdmission) delete signalProposal.operatingHistory;
          if (
            hash(signalProposal) !==
            hash(this.proposal(a.proposal.request.stateHash))
          )
            hold("SIGNAL_APPROVAL_MISMATCH");
        }
        const context = store.context();
        if (context.status !== "OK") hold(context.reasons.join(","));
        const prepared = store.prepare({
          ...this.proposal(context.context.stateHash),
          ...(options.historyAdmission ? { operatingHistory } : {}),
        });
        // Issuance is in-memory only. Reject a different Store before returning
        // a usable approval; reserve() also checks this pinned run hash.
        if (prepared.runHash !== hash(config)) hold("STORE_BINDING_MISMATCH");
        return prepared;
      },
      orderSubmissionAllowed: false as const,
      learningAllowed: false as const,
      liveEnabled: false as const,
    };
  }
  private proposal(stateHash: string) {
    return {
      reservationId: this.reservationId,
      profile: structuredClone(this.#selection.profile),
      request: { ...structuredClone(this.#request), stateHash },
    };
  }
  private checkedExport(store: CostReservationStore) {
    const cost = store.exportEvidence();
    if (cost.configHash !== hash(this.#config)) hold("STORE_BINDING_MISMATCH");
    for (const r of cost.records) {
      const c = r.input.command;
      if (
        c.kind === "RESERVE" &&
        hash(c.proposal) !== hash(this.proposal(c.proposal.request.stateHash))
      )
        hold("SIGNAL_APPROVAL_MISMATCH");
    }
    return cost;
  }
  prepareEntry(store: CostReservationStore) {
    this.checkedExport(store);
    const context = store.context();
    if (context.status !== "OK") hold(context.reasons.join(","));
    return store.prepare(this.proposal(context.context.stateHash));
  }
  evidence(store: CostReservationStore) {
    const cost = this.checkedExport(store);
    const body = {
      kind: "SYNTHETIC_COST_SIGNAL_EVIDENCE_V1",
      purpose: "TEST_ONLY",
      signalBasisHash: this.signalBasisHash,
      signalEvidence: this.signalEvidence(),
      cost,
      financialBasisHash: cost.report.financialBasisHash,
      orderSubmissionAllowed: false,
      learningAllowed: false,
      liveEnabled: false,
    } as const;
    return { ...body, evidenceHash: hash(body) };
  }
}
