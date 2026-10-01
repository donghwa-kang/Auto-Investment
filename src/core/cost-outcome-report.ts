import { hash, policyHash } from "./policy.js";
import { d, sum } from "./math.js";
import { replayCostJournal } from "./cost-journal.js";
import type { CostPosting } from "./cost-journal.js";
import { outcomeKind } from "./cost-reservation.js";
import type { ReservationState } from "./cost-reservation.js";
import type { CostLine } from "./transaction-cost.js";

export const costOutcomeReportKind = "SYNTHETIC_COST_REPORT_V1";
type Components = Record<Exclude<CostLine["component"], "FX">, string>;
function itemized(postings: CostPosting[]): Components {
  const totals: Components = { COMMISSION: "0", TAX: "0", EXCHANGE: "0" };
  for (const p of postings)
    for (const line of p.lines) {
      if (line.component === "FX")
        throw Error("COST_REPORT_FX_COST_UNSUPPORTED");
      totals[line.component] = d(totals[line.component])
        .plus(line.amountDelta)
        .toString();
    }
  if (!sum(Object.values(totals)).eq(sum(postings.map((p) => p.feeDelta))))
    throw Error("COST_REPORT_COMPONENT_MISMATCH");
  return totals;
}

// Internal projection of a detached, replay-verified Store snapshot. Not an
// untrusted JSON/file importer, source authenticator, or training input.
export function buildCostOutcomeReport(
  verified: ReservationState,
  configHash: string,
) {
  if (verified.kind !== outcomeKind || !verified.handoff || !verified.outcomes)
    throw Error("COST_REPORT_REQUIRES_OUTCOME_V3");
  const s = structuredClone(verified),
    metadata = s.handoff!,
    outcomes = s.outcomes!;
  const source = {
    contract: s.kind,
    configHash,
    policyHash,
    stateHash: hash(s),
    revision: s.revision,
    epoch: s.epoch,
    asOf: s.seed.clock,
  };
  const trades = s.book.sources.map((entry) => {
    const v = replayCostJournal(entry.config, entry.events),
      transfer = metadata.transfers.find((t) => t.runId === entry.config.runId),
      outcome = outcomes.find((o) => o.runId === entry.config.runId) ?? null;
    if (!transfer) throw Error("COST_REPORT_TRANSFER_MISSING");
    const buyValue = sum(
        v.postings.filter((p) => p.side === "BUY").map((p) => p.value),
      ).toString(),
      sellValue = sum(
        v.postings.filter((p) => p.side === "SELL").map((p) => p.value),
      ).toString();
    // Cross-check only. Closed PnL/FX/counters remain persisted facts, never
    // restated using a later quote, settlement, or observation.
    if (
      outcome &&
      (outcome.buyValue !== buyValue ||
        outcome.sellValue !== sellValue ||
        outcome.tradingFees !== v.tradingFees ||
        !d(sellValue)
          .minus(buyValue)
          .minus(v.tradingFees)
          .eq(outcome.netPnlNative))
    )
      throw Error("COST_REPORT_OUTCOME_MISMATCH");
    const phase = outcome
      ? ("CLOSED" as const)
      : v.postings.length
        ? ("INCOMPLETE_TRADE" as const)
        : ("NO_FILLS" as const);
    return {
      runId: entry.config.runId,
      reservationId: transfer.reservationId,
      symbol: entry.config.execution.instrument,
      currency: v.currency,
      sourceScope: entry.config.sourceScope,
      configHash: v.configHash,
      profileHash: hash(entry.config.execution.profile),
      journalHash: v.journalHash,
      phase,
      quantity: v.quantity,
      reservedSellQuantity: v.reservedSellQuantity,
      orders: v.orders,
      postings: v.postings,
      buyValue,
      sellValue,
      tradingFees: v.tradingFees,
      components: itemized(v.postings),
      unsettledFillCount: v.postings.filter((p) => p.settledAt === null).length,
      outcome,
    };
  });
  const accounts = (["KRW", "USD"] as const).map((currency) => {
    const account = metadata.accounts[currency],
      postings = trades
        .filter((t) => t.currency === currency)
        .flatMap((t) => t.postings);
    if (!sum(postings.map((p) => p.feeDelta)).eq(account.tradingFees))
      throw Error("COST_REPORT_ACCOUNT_FEES_MISMATCH");
    return {
      currency,
      ...account,
      economicCash: d(account.cash)
        .plus(account.receivable)
        .minus(account.payable)
        .minus(account.unpaidFees)
        .toString(),
      components: itemized(postings),
    };
  });
  const financialEvidence = {
    approvals: s.approvals,
    accounts,
    trades,
    admissionHolds: metadata.admissionHolds,
    riskHalts: s.seed.ledger.halts,
    operatingCosts: {
      fixture: "EXPLICIT_ZERO_FIXTURE" as const,
      actualCosts: "UNVERIFIED" as const,
      allocation: "UNSUPPORTED" as const,
    },
  };
  const financialBasisHash = hash({ source, financialEvidence });
  const currencies = accounts.map((a) => {
    const selected = trades.filter((t) => t.currency === a.currency),
      closed = selected.flatMap((t) => (t.outcome ? [t.outcome] : [])),
      known = closed.filter((o) => o.netPnlKrw !== null),
      closedPostings = selected
        .filter((t) => t.outcome)
        .flatMap((t) => t.postings);
    return {
      currency: a.currency,
      tradeCount: selected.length,
      closedCount: closed.length,
      incompleteCount: selected.filter((t) => t.phase === "INCOMPLETE_TRADE")
        .length,
      noFillCount: selected.filter((t) => t.phase === "NO_FILLS").length,
      unsettledFillCount: selected.reduce(
        (n, t) => n + t.unsettledFillCount,
        0,
      ),
      allFillFees: a.tradingFees,
      allFillComponents: a.components,
      closedTradingFees: sum(closed.map((o) => o.tradingFees)).toString(),
      closedComponents: itemized(closedPostings),
      closedTradingNetPnlNative: sum(
        closed.map((o) => o.netPnlNative),
      ).toString(),
      knownKrwCount: known.length,
      pendingKrwCount: closed.length - known.length,
      closedNetPnlKrwKnownSubtotal: sum(
        known.map((o) => o.netPnlKrw!),
      ).toString(),
      closedNetPnlKrw:
        known.length === closed.length
          ? sum(known.map((o) => o.netPnlKrw!)).toString()
          : null,
      netPnlAfterOperatingCosts: null,
    };
  });
  const reasons = [
    "OPERATING_COST_ALLOCATION_UNSUPPORTED",
    "V3_TRAINING_CONTRACT_NOT_INTEGRATED",
  ];
  const body = {
    kind: costOutcomeReportKind,
    purpose: "TEST_ONLY" as const,
    source,
    financialEvidence,
    financialBasisHash,
    report: { financialBasisHash, currencies },
    learningEvidence: {
      kind: "SYNTHETIC_COST_LEARNING_HOLD_V1" as const,
      status: "HOLD" as const,
      financialBasisHash,
      reasons,
      records: s.approvals.map((a) => {
        const trade = trades.find((t) => t.reservationId === a.id),
          outcome = trade?.outcome;
        return {
          reservationId: a.id,
          runId: trade?.runId ?? null,
          currency: a.reservation.currency,
          approvalBasisHash: a.basisHash,
          financialBasisHash,
          status: "HOLD" as const,
          reasons: [
            ...reasons,
            ...(trade
              ? outcome
                ? outcome.pendingReasons
                : [trade.phase]
              : [a.status]),
            ...metadata.admissionHolds,
            ...s.seed.ledger.halts,
          ].filter((r, i, all) => all.indexOf(r) === i),
          components: trade?.components ?? null,
          tradingFees: trade?.tradingFees ?? null,
          tradingNetPnlNative: outcome?.netPnlNative ?? null,
          tradingNetPnlKrw: outcome?.netPnlKrw ?? null,
          outcomeBasisHash: outcome?.basisHash ?? null,
          trainingLabel: null,
        };
      }),
    },
    orderSubmissionAllowed: false as const,
    learningAllowed: false as const,
    liveEnabled: false as const,
  };
  return { ...body, reportHash: hash(body) };
}
export type CostOutcomeReport = ReturnType<typeof buildCostOutcomeReport>;
