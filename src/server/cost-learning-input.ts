import { z } from "zod";
import { hash } from "../core/policy.js";
import { Decimal } from "../core/math.js";
import { parseSignalReplay } from "../core/signal-replay-schema.js";
import { portfolioSettingsSchema } from "../core/portfolio-schema.js";
import { createRvolSource, rebuildRvol } from "../core/learning-rvol.js";
import { verifyOperatingEvidence } from "../core/cost-operating-evidence.js";
import type { OperatingEvidenceAnchor } from "../core/cost-operating-evidence.js";
import {
  CostSignalProgram,
  costSignalSelectionSchema,
} from "./cost-signal-bridge.js";

export const costLearningInputKind = "SYNTHETIC_COST_LEARNING_INPUT_V1";
export const costLearningInputLimits = Object.freeze({
  bytes: 64 * 1024 * 1024,
  depth: 64,
  nodes: 1_000_000,
  batch: 16,
} as const);
export const costLearningPermissions = Object.freeze({
  populationQualified: false,
  performanceQualified: false,
  learningAllowed: false,
  modelRegistrationAllowed: false,
  modelPromotionAllowed: false,
  orderSubmissionAllowed: false,
  liveEnabled: false,
  newSpendingAllowed: false,
  automaticResumeAllowed: false,
} as const);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const envelopeSchema = z.strictObject({
  kind: z.literal(costLearningInputKind),
  purpose: z.literal("TEST_ONLY"),
  asOf: z.number().int().safe().nonnegative().max(8_640_000_000_000_000),
  replay: z.unknown(),
  settings: z.unknown(),
  selection: z.unknown(),
  operatingEvidenceText: z.string(),
});
export interface CostLearningInputAnchor {
  inputHash: string;
  operating: OperatingEvidenceAnchor;
}
export class CostLearningInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CostLearningInputError";
  }
}
function requireInput(ok: boolean, code: string): asserts ok {
  if (!ok) throw new CostLearningInputError(code);
}
function boundedParse(text: string) {
  requireInput(
    typeof text === "string" &&
      text.length <= costLearningInputLimits.bytes &&
      Buffer.byteLength(text, "utf8") <= costLearningInputLimits.bytes,
    "COST_LEARNING_SIZE_LIMIT",
  );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CostLearningInputError("COST_LEARNING_JSON_INVALID");
  }
  // JSON objects are data, never commands. Inspect before any replay work.
  const pending = [{ value: raw, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    requireInput(
      ++nodes <= costLearningInputLimits.nodes &&
        depth <= costLearningInputLimits.depth,
      "COST_LEARNING_STRUCTURE_LIMIT",
    );
    requireInput(
      typeof value !== "number" || Number.isFinite(value),
      "COST_LEARNING_NONFINITE",
    );
    if (value !== null && typeof value === "object")
      for (const child of Object.values(value))
        pending.push({ value: child, depth: depth + 1 });
  }
  const parsed = envelopeSchema.safeParse(raw);
  requireInput(parsed.success, "COST_LEARNING_SCHEMA_INVALID");
  const inputHash = hash(raw);
  requireInput(inputHash === hash(parsed.data), "COST_LEARNING_SCHEMA_INVALID");
  return { envelope: parsed.data, inputHash };
}

// Captures supplied raw JSON only. The hash must be pinned independently by the
// trusted caller; neither this helper nor a hash proves economic correctness.
export function createCostLearningInput(raw: unknown) {
  const text = JSON.stringify(raw);
  const parsed = boundedParse(text);
  return { text, inputHash: parsed.inputHash };
}

// Match the existing V4 report bounds. No monetary Number conversion or new
// rounding rule: 128 significant digits cover bounded sums/differences exactly.
const Exact = Decimal.clone({ precision: 128 });
function exact(value: string) {
  requireInput(
    /^-?(?:0|[1-9]\d{0,64})(?:\.\d{1,40})?$/.test(value),
    "COST_LEARNING_AMOUNT_INVALID",
  );
  return new Exact(value);
}
const unique = (values: string[]) => [...new Set(values)].sort();
function verifyParsed(
  parsed: ReturnType<typeof boundedParse>,
  anchor: CostLearningInputAnchor,
) {
  requireInput(
    !!anchor && sha.safeParse(anchor.inputHash).success && !!anchor.operating,
    "COST_LEARNING_ANCHOR_REQUIRED",
  );
  const { envelope: input, inputHash } = parsed;
  requireInput(inputHash === anchor.inputHash, "COST_LEARNING_HASH_MISMATCH");
  const verified = verifyOperatingEvidence(
      input.operatingEvidenceText,
      anchor.operating,
    ),
    report = verified.report,
    financial = report.financialEvidence,
    replay = parseSignalReplay(input.replay),
    settings = portfolioSettingsSchema.parse(input.settings),
    selection = costSignalSelectionSchema.parse(input.selection),
    program = new CostSignalProgram(replay, settings, selection, {
      executionLoop: true,
      watchdog: true,
    }),
    config = program
      .operatingLoop({ historyAdmission: true, finalization: true })
      .config();
  requireInput(
    hash(config) === hash(anchor.operating.config),
    "COST_LEARNING_SIGNAL_CONFIG_MISMATCH",
  );
  // The full verifier already replays candidate/history bindings, costs and CAS.
  // Independently bind its approvals to this original chart/forecast proposal.
  for (const approval of financial.approvals) {
    const proposal = structuredClone(approval.proposal);
    delete proposal.operatingHistory;
    requireInput(
      hash(proposal) ===
        hash(program.proposalForEvidence(proposal.request.stateHash)),
      "COST_LEARNING_APPROVAL_MISMATCH",
    );
  }
  requireInput(
    financial.approvals.length <= 1 && financial.trades.length <= 1,
    "COST_LEARNING_SINGLE_INTENT_REQUIRED",
  );
  const approval = financial.approvals[0] ?? null,
    trade = financial.trades[0] ?? null,
    evidence = program.signalEvidence(),
    frame = program.frameForEvidence();
  const e = evidence.evaluation,
    history = replay.histories.find(
      (h) =>
        h.assetKey ===
        frame.items.find((i) => i.catalogKey === selection.catalogKey)!
          .assetKey,
    )!;
  requireInput(
    !!e.current && !!evidence.historyEvidence,
    "COST_LEARNING_FEATURE_SOURCE_REQUIRED",
  );
  const signalAt = e.current.closeAt,
    featureAsOf = selection.frameAsOf,
    decisionAt = approval?.issuedAt ?? config.seed.clock,
    strategy = e.strategies[0]!;
  requireInput(
    signalAt <= featureAsOf && featureAsOf <= decisionAt,
    "COST_LEARNING_DECISION_TIME_MISMATCH",
  );
  const source = createRvolSource(history, {
    decisionId: approval?.id ?? program.reservationId,
    symbol: evidence.identity.instrumentId,
    asOf: featureAsOf,
    signalAt,
    dataVersion: e.dataVersion,
    sourceDataHash: hash({
      frame: frame.decisionHash,
      history: evidence.historyEvidence,
    }),
    historyEvidenceHash: evidence.historyEvidence.instrument,
  });
  const rvol = rebuildRvol(source),
    trace = e.trace.filter((t) => t.predicate_id === `${strategy}_RVOL`);
  requireInput(
    trace.length === 1 &&
      trace[0]!.input_values.left === rvol.value &&
      trace[0]!.as_of === featureAsOf &&
      trace[0]!.data_version === e.dataVersion &&
      e.current.rvol === rvol.value,
    "COST_LEARNING_RVOL_MISMATCH",
  );
  const intent = {
    market: evidence.identity.market,
    instrumentId: evidence.identity.instrumentId,
    currency: evidence.identity.currency,
    sessionId: rvol.currentSessionId,
    strategy,
    signalAt,
    side: "BUY" as const,
  };
  if (trade)
    requireInput(
      trade.reservationId === program.reservationId &&
        trade.symbol === intent.instrumentId &&
        trade.currency === "KRW" &&
        approval?.status === "TRANSFERRED_SYNTHETIC",
      "COST_LEARNING_TRADE_BINDING_MISMATCH",
    );
  const population = {
    scope: "DECLARED_FRAME_POPULATION" as const,
    frameAsOf: featureAsOf,
    frameHash: frame.decisionHash,
    items: frame.items
      .map((item) => ({
        catalogKey: item.catalogKey,
        status: item.status,
        reasons: item.reasons,
        evaluated: item.strategyEvaluated,
        selected: item.catalogKey === selection.catalogKey,
        costDecision:
          item.catalogKey === selection.catalogKey && approval
            ? "RECORDED"
            : "NOT_RECORDED",
        executionEvidence:
          item.catalogKey === selection.catalogKey && trade
            ? "RECORDED"
            : item.catalogKey === selection.catalogKey
              ? "NOT_RECORDED"
              : "NOT_SELECTED_NO_EXECUTION_EVIDENCE",
      }))
      .sort((a, b) => a.catalogKey.localeCompare(b.catalogKey, "en")),
  };
  const decisionContext = approval
    ? {
        approvedCandidate: approval.candidate,
        operatingHistory: approval.proposal.operatingHistory,
        operatingBinding: approval.operatingBinding,
        forecast: approval.proposal.request.forecast,
      }
    : null;
  const decisionBasisHash = hash({
    intent,
    featureAsOf,
    features: { rvol: rvol.value },
    frameHash: frame.decisionHash,
    dataVersion: e.dataVersion,
    request: approval
      ? { ...approval.proposal.request, stateHash: null }
      : null,
    candidate: approval?.candidate ?? null,
    operatingBinding: approval?.operatingBinding ?? null,
    operatingHistoryHash: approval?.proposal.operatingHistory
      ? hash(approval.proposal.operatingHistory)
      : null,
  });
  const reasons: string[] = [];
  if (!approval || approval.status !== "TRANSFERRED_SYNTHETIC")
    reasons.push("ENTRY_NOT_TRANSFERRED");
  if (!trade || trade.phase !== "CLOSED" || !trade.outcome)
    reasons.push("TRADE_NOT_CLOSED");
  if (
    trade &&
    (trade.quantity !== 0 ||
      trade.reservedSellQuantity !== 0 ||
      !trade.orders.length ||
      trade.orders.some(
        (o) =>
          !["FILLED", "CANCELLED"].includes(o.status) ||
          !exact(o.reservedCash).eq(0),
      ))
  )
    reasons.push("OPEN_ORDER_OR_RESERVATION");
  if (financial.approvals.some((a) => a.status === "RESERVED_LOCAL"))
    reasons.push("OPEN_LOCAL_RESERVATION");
  const close = financial.finalization,
    checkpoint = close.checkpoint;
  if (
    close.status !== "FINALIZED" ||
    !checkpoint ||
    !close.checkpointHash ||
    close.allocations?.length !== 1 ||
    !exact(close.unallocatedKrw ?? "1").eq(0)
  )
    reasons.push("OPERATING_NOT_FINALIZED");
  if (
    financial.operating.rejectedInputs.length ||
    close.rejectedInputs.length ||
    financial.followupBasis
  )
    reasons.push("UNRESOLVED_OR_POST_CLOSE_INPUT");
  if (report.asOf > input.asOf) reasons.push("FINANCIAL_EXPORT_AFTER_AS_OF");
  // Availability, not import/export wall-clock time, sets the label boundary.
  const labelAvailableAt =
    checkpoint && trade?.outcome
      ? Math.max(
          checkpoint.appliedAt,
          checkpoint.request.manifest.availableAt,
          ...trade.historicalPostings.map((p) => p.fill.at),
          ...trade.orders.map((o) => o.lastAt),
          ...financial.operating.events.map((event) => event.availableAt),
        )
      : null;
  if (
    labelAvailableAt === null ||
    labelAvailableAt > input.asOf ||
    (trade?.outcome && trade.outcome.closedAt > labelAvailableAt)
  )
    reasons.push("LABEL_NOT_AVAILABLE");
  const components = { COMMISSION: "0", TAX: "0", EXCHANGE: "0", FX: "0" };
  for (const posting of trade?.historicalPostings ?? [])
    for (const line of posting.lines)
      components[line.component] = exact(components[line.component])
        .plus(exact(line.amountDelta))
        .toFixed();
  const fees = Object.values(components).reduce(
    (n, v) => n.plus(exact(v)),
    new Exact(0),
  );
  if (trade)
    requireInput(
      fees.eq(exact(trade.tradingFees)),
      "COST_LEARNING_COMPONENT_MISMATCH",
    );
  const gross = trade
    ? exact(trade.sellValue).minus(exact(trade.buyValue))
    : null;
  const label =
    !reasons.length && trade && checkpoint && labelAvailableAt !== null
      ? {
          kind: "SIMULATED_CLOSED_COST_FINAL" as const,
          currency: "KRW" as const,
          grossPnlKrw: gross!.toFixed(),
          components,
          operatingAllocationKrw: trade.operatingAllocationKrw!,
          finalNetPnlKrw: gross!
            .minus(fees)
            .minus(exact(trade.operatingAllocationKrw!))
            .toFixed(),
          closedAt: trade.outcome!.closedAt,
          labelAvailableAt,
          checkpointHash: close.checkpointHash!,
        }
      : null;
  if (label)
    requireInput(
      label.finalNetPnlKrw === trade!.finalNetPnlKrw &&
        gross!.minus(fees).eq(exact(trade!.tradingNetPnlKrw!)),
      "COST_LEARNING_LABEL_MISMATCH",
    );
  const labelBasisHash = label
    ? hash({
        label,
        fills: trade!.historicalPostings.map((p) => ({
          side: p.side,
          quantity: p.fill.quantity,
          price: p.fill.price,
          occurredAt: p.fill.occurredAt,
          availableAt: p.fill.at,
          feeDelta: p.feeDelta,
        })),
      })
    : null;
  const body = {
    kind: "SYNTHETIC_COST_LEARNING_RESULT_V1" as const,
    purpose: "TEST_ONLY" as const,
    status: label ? ("SYNTHETIC_INPUT_ELIGIBLE" as const) : ("HOLD" as const),
    inputHash,
    intentKey: hash(intent),
    decisionBasisHash,
    labelBasisHash,
    asOf: input.asOf,
    decisionAt,
    featureAsOf,
    signalAt,
    features: { numericProfile: "DECIMAL40_V1" as const, rvol: rvol.value },
    decisionContext,
    population,
    reasons: unique(reasons),
    trainingLabel: label,
    audit: {
      signalBasisHash: program.signalBasisHash,
      rvolSource: source,
      rvol,
      financialExportHash: verified.exportHash,
      financialReport: report,
      settlementPending:
        !!trade?.historicalPostings.some((p) => p.settledAt === null) ||
        financial.currentAccounts.some(
          (a) => !exact(a.totalPayable).eq(0) || !exact(a.receivable).eq(0),
        ),
    },
    ...costLearningPermissions,
  };
  return structuredClone({ ...body, resultHash: hash(body) });
}
export type CostLearningResult = ReturnType<typeof verifyParsed>;

export function verifyCostLearningInput(
  text: string,
  anchor: CostLearningInputAnchor,
): CostLearningResult {
  return verifyParsed(boundedParse(text), anchor);
}

// Off-tick, read-only batch operation. Validate EVERY unique input before any
// result is returned. No persistent registry, training or winner selection.
export function verifyCostLearningBatch(
  entries: readonly { text: string; anchor: CostLearningInputAnchor }[],
) {
  requireInput(
    Array.isArray(entries) &&
      entries.length >= 1 &&
      entries.length <= costLearningInputLimits.batch,
    "COST_LEARNING_BATCH_LIMIT",
  );
  let bytes = 0;
  for (const entry of entries) {
    requireInput(
      typeof entry?.text === "string",
      "COST_LEARNING_SCHEMA_INVALID",
    );
    bytes += Buffer.byteLength(entry.text, "utf8");
    requireInput(
      bytes <= costLearningInputLimits.bytes,
      "COST_LEARNING_BATCH_BYTES_LIMIT",
    );
  }
  const inputs = entries.map((entry) => ({
      parsed: boundedParse(entry.text),
      anchor: entry.anchor,
    })),
    distinct = new Map<
      string,
      { row: CostLearningResult; duplicateCount: number; anchorHash: string }
    >();
  for (const input of inputs) {
    const old = distinct.get(input.parsed.inputHash);
    if (old) {
      requireInput(
        old.anchorHash === hash(input.anchor),
        "COST_LEARNING_DUPLICATE_ANCHOR_MISMATCH",
      );
      old.duplicateCount++;
    } else
      distinct.set(input.parsed.inputHash, {
        row: verifyParsed(input.parsed, input.anchor),
        duplicateCount: 0,
        anchorHash: hash(input.anchor),
      });
  }
  const counts = new Map<string, number>();
  for (const { row } of distinct.values())
    counts.set(row.intentKey, (counts.get(row.intentKey) ?? 0) + 1);
  const rows = [...distinct.values()]
    .map(({ row, duplicateCount }) => {
      const { resultHash: originalResultHash, ...original } = row,
        conflicting = counts.get(row.intentKey)! > 1,
        body = {
          ...original,
          duplicateCount,
          originalResultHash,
          ...(conflicting
            ? {
                status: "HOLD" as const,
                reasons: unique([...row.reasons, "INTENT_INPUT_CONFLICT"]),
                trainingLabel: null,
                labelBasisHash: null,
              }
            : {}),
        };
      return { ...body, resultHash: hash(body) };
    })
    .sort((a, b) => a.inputHash.localeCompare(b.inputHash, "en"));
  const body = {
    kind: "SYNTHETIC_COST_LEARNING_BATCH_V1" as const,
    purpose: "TEST_ONLY" as const,
    rows,
    receivedCount: entries.length,
    uniqueCount: rows.length,
    ...costLearningPermissions,
  };
  return structuredClone({ ...body, batchHash: hash(body) });
}
