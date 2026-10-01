import { hash, policyHash } from "./policy.js";
import { Decimal } from "./math.js";
import { replayCostJournal } from "./cost-journal.js";
import { operatingKind } from "./cost-operating.js";
import type { OperatingConfig } from "./cost-operating.js";
import type { ReservationState } from "./cost-reservation.js";
import type { OperatingRecord } from "./cost-operating-replay.js";
import { postCloseReport } from "./cost-post-close.js";
import { partialSettlementReport } from "./cost-partial-settlement.js";

const Exact = Decimal.clone({ precision: 128 });
function exact(value: unknown) {
  // Existing amounts are bounded at 60 integer / 40 fractional digits.
  // 21,301 records need fewer than 5 additional integer digits when summed.
  if (
    typeof value !== "string" ||
    !/^-?(?:0|[1-9]\d{0,64})(?:\.\d{1,40})?$/.test(value)
  )
    throw Error("OPERATING_REPORT_AMOUNT");
  return new Exact(value);
}
const sum = (values: string[]) =>
  values.reduce((n, v) => n.plus(exact(v)), new Exact(0));
export const operatingReportPermissions = {
  orderSubmissionAllowed: false,
  learningAllowed: false,
  liveEnabled: false,
  newSpendingAllowed: false,
  automaticResumeAllowed: false,
} as const;

// Internal projection ONLY of a replay-verified, detached single snapshot.
// Untrusted JSON must enter through verifyOperatingEvidence, not this helper.
export function buildOperatingReport(
  c: OperatingConfig,
  verified: ReservationState,
  records: readonly OperatingRecord[],
  asOf = Math.max(
    verified.seed.clock,
    verified.loop?.watchdog?.lastPulseAt ?? 0,
  ),
) {
  if (
    c.kind !== operatingKind ||
    verified.kind !== operatingKind ||
    !verified.operating ||
    !verified.handoff ||
    !verified.outcomes
  )
    throw Error("OPERATING_REPORT_V4_REQUIRED");
  if (
    !Number.isSafeInteger(asOf) ||
    asOf < verified.seed.clock ||
    asOf > 8_640_000_000_000_000 ||
    asOf < (verified.loop?.watchdog?.lastPulseAt ?? 0)
  )
    throw Error("OPERATING_REPORT_TIME");
  const s = structuredClone(verified),
    m = s.handoff!,
    op = s.operating!,
    checkpoint = s.finalization?.checkpoint ?? null;
  const followup = s.postClose?.basis
    ? { kind: "D9" as const, report: postCloseReport(s, asOf) }
    : s.partialSettlement?.basis
      ? { kind: "D10" as const, report: partialSettlementReport(s, asOf) }
      : { kind: "NONE" as const, report: null };
  const current = followup.report?.operating ?? op.effects;
  const operating = {
    current: {
      incurredKrw: exact(current.incurredKrw).toFixed(),
      paidKrw: exact(current.paidKrw).toFixed(),
      payableKrw: exact(current.payableKrw).toFixed(),
      reservedKrw: followup.report
        ? "0"
        : exact(op.effects.reservedKrw).toFixed(),
    },
    preCloseEffects: op.effects,
    events: op.events,
    rejectedInputs: op.rejectedInputs,
  };
  if (
    !exact(operating.current.paidKrw)
      .plus(exact(operating.current.payableKrw))
      .eq(exact(operating.current.incurredKrw))
  )
    throw Error("OPERATING_REPORT_COST_IDENTITY");
  const trades = s.book.sources.map((entry) => {
    const v = replayCostJournal(entry.config, entry.events),
      transfer = m.transfers.find((t) => t.runId === entry.config.runId);
    if (!transfer) throw Error("OPERATING_REPORT_TRANSFER");
    const outcome =
      s.outcomes!.find((o) => o.runId === entry.config.runId) ?? null;
    const buy = sum(
        v.postings.filter((p) => p.side === "BUY").map((p) => p.value),
      ),
      sell = sum(
        v.postings.filter((p) => p.side === "SELL").map((p) => p.value),
      ),
      fees = sum(v.postings.map((p) => p.feeDelta));
    if (
      !fees.eq(exact(v.tradingFees)) ||
      (outcome &&
        (!buy.eq(exact(outcome.buyValue)) ||
          !sell.eq(exact(outcome.sellValue)) ||
          !fees.eq(exact(outcome.tradingFees)) ||
          !sell.minus(buy).minus(fees).eq(exact(outcome.netPnlNative))))
    )
      throw Error("OPERATING_REPORT_TRADE_MISMATCH");
    const allocation =
      checkpoint?.report.allocations?.find(
        (a) => a.tradeId === entry.config.runId,
      ) ?? null;
    return {
      runId: entry.config.runId,
      reservationId: transfer.reservationId,
      symbol: entry.config.execution.instrument,
      currency: v.currency,
      sourceScope: entry.config.sourceScope,
      configHash: v.configHash,
      journalHash: v.journalHash,
      phase: outcome
        ? ("CLOSED" as const)
        : v.postings.length
          ? ("INCOMPLETE_TRADE" as const)
          : ("NO_FILLS" as const),
      quantity: v.quantity,
      reservedSellQuantity: v.reservedSellQuantity,
      orders: v.orders,
      // Post-close progress is in followup, not these historical posting flags.
      historicalPostings: v.postings,
      buyValue: buy.toFixed(),
      sellValue: sell.toFixed(),
      tradingFees: fees.toFixed(),
      tradingNetPnlKrw: outcome?.netPnlKrw ?? null,
      outcome,
      operatingAllocationKrw: allocation?.operatingCostKrw ?? null,
      finalNetPnlKrw: allocation?.finalNetPnlKrw ?? null,
    };
  });
  const currentAccounts = (["KRW", "USD"] as const).map((currency) => {
    const a = m.accounts[currency],
      payable = exact(a.payable).plus(exact(a.unpaidFees));
    if (
      !exact(a.cash)
        .minus(payable)
        .minus(exact(a.reservedCash))
        .eq(exact(a.availableCash)) ||
      !sum(
        trades.filter((t) => t.currency === currency).map((t) => t.tradingFees),
      ).eq(exact(a.tradingFees))
    )
      throw Error("OPERATING_REPORT_ACCOUNT_MISMATCH");
    return {
      currency,
      ...a,
      totalPayable: payable.toFixed(),
      economicCash: exact(a.cash)
        .plus(exact(a.receivable))
        .minus(payable)
        .toFixed(),
      netAssetValue: null,
    };
  });
  const source = {
    contract: s.kind,
    configHash: hash(c),
    policyHash,
    stateHash: hash(s),
    revision: s.revision,
    epoch: s.epoch,
    recordsHash: hash(records),
    recordCount: records.length,
    financialAt: s.seed.clock,
    lastPulseAt: s.loop?.watchdog?.lastPulseAt ?? null,
  };
  const finalization = {
    status: s.finalization?.status ?? "OPEN",
    checkpoint,
    checkpointHash: checkpoint ? hash(checkpoint) : null,
    allocations: checkpoint?.report.allocations ?? null,
    unallocatedKrw: checkpoint?.report.unallocatedKrw ?? null,
    periodNetPnlKrw: checkpoint?.report.periodNetPnlKrw ?? null,
    rejectedInputs: s.finalization?.rejectedInputs ?? [],
  };
  const financialEvidence = {
    currentAccounts,
    trades,
    operating,
    finalization,
    approvals: s.approvals,
    followupBasis: s.postClose ?? s.partialSettlement ?? null,
    lossStreak: s.seed.ledger.lossStreak,
    admissionHolds: m.admissionHolds,
    riskHalts: s.seed.ledger.halts,
  };
  const financialBasisHash = hash({ source, financialEvidence });
  const body = {
    kind: "SYNTHETIC_OPERATING_REPORT_V1" as const,
    purpose: "TEST_ONLY" as const,
    status: "HOLD" as const,
    source,
    asOf,
    financialEvidence,
    financialBasisHash,
    followup,
    diagnostics: {
      allocationPending: checkpoint === null,
      learningReasons: ["V4_TRAINING_NOT_INTEGRATED"],
      loopHolds: s.loop?.holds ?? [],
      watchdogHolds: s.loop?.watchdog?.holds ?? [],
    },
    ...operatingReportPermissions,
  };
  return structuredClone({ ...body, reportHash: hash(body) });
}
export type OperatingReport = ReturnType<typeof buildOperatingReport>;
