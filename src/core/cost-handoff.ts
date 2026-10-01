import { z } from "zod";
import { hash, policy, policyHash } from "./policy.js";
import { d, max, ceil } from "./math.js";
import { fxFor } from "./ledger.js";
import { riskKeys } from "./calendar.js";
import { estimateFeeBound } from "./cost-kernel.js";
import { withExecutionRiskFloors } from "./cost-risk-context.js";
import { recordClosedOutcomes } from "./cost-outcome.js";
import type { OutcomeConfig } from "./cost-outcome.js";
import {
  costJournalConfigSchema,
  costJournalEventSchema,
  replayCostJournal,
  journalFillIdentity,
} from "./cost-journal.js";
import {
  handoffKind,
  outcomeKind,
  reservationKind,
  reservationCommandSchema,
  initialReservations,
  reservationExposure,
  evaluateLocalProposal,
  applyReservationCommand,
} from "./cost-reservation.js";
import type {
  ReservationConfig,
  ReservationState,
} from "./cost-reservation.js";
import type { CostJournalEvent, CostJournalView } from "./cost-journal.js";
import {
  operatingKind,
  operatingCommandSchema,
  operatingHoldCommandSchema,
  quarantineOperating,
  initializeOperating,
  operatingView,
  syncOperating,
  appendOperating,
  operatingEventLimit,
} from "./cost-operating.js";
import type { OperatingConfig } from "./cost-operating.js";
import {
  costLoopConfigSchema,
  costLoopTickSchema,
  costLoopPulseSchema,
  costOperatingLoopConfigSchema,
} from "./cost-loop-schema.js";
import { applyCostLoopTick } from "./cost-loop.js";
import { applyCostWatchdog } from "./cost-watchdog.js";
import { admissionHistorySchema } from "./cost-history-admission.js";

const id = costJournalConfigSchema.shape.runId;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const handoffCommandSchema = z.union([
  costLoopTickSchema,
  costLoopPulseSchema,
  reservationCommandSchema,
  z
    .object({
      kind: z.literal("HANDOFF"),
      reservationId: id,
      acknowledgement: z.enum(["CONFIRMED", "UNKNOWN"]),
      basisHash: sha,
      operatingHistory: admissionHistorySchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("EXECUTION"),
      runId: id,
      event: costJournalEventSchema,
    })
    .strict(),
]);
export type HandoffCommand = z.infer<typeof handoffCommandSchema>;
export const extendedHandoffCommandSchema = z.union([
  handoffCommandSchema,
  operatingCommandSchema,
  operatingHoldCommandSchema,
]);
export type ExtendedHandoffCommand = z.infer<
  typeof extendedHandoffCommandSchema
>;
export interface HandoffConfig extends Omit<ReservationConfig, "kind"> {
  kind: typeof handoffKind;
  sourceScope: z.infer<typeof costJournalConfigSchema.shape.sourceScope>;
  horizonEnd: number;
}
interface Account {
  cash: string;
  receivable: string;
  payable: string;
  unpaidFees: "0";
  reservedCash: string;
  availableCash: string;
  tradingFees: string;
}
export interface HandoffMetadata {
  sourceScope: HandoffConfig["sourceScope"];
  horizonEnd: number;
  transfers: {
    reservationId: string;
    runId: string;
    acknowledgement: "CONFIRMED" | "UNKNOWN";
  }[];
  controlCount: number;
  admissionHolds: string[];
  accounts: Record<"KRW" | "USD", Account>;
}
export const handoffCommandLimit = 5200;
// B's immutable 500-event contract is a resource bound, not a trading policy.
// Reserve one fill and one settlement event per possible remaining share on
// both sides, plus bounded cancel/unknown/confirmation and SELL replacements.
// Repeated non-financial notifications may use only the unreserved remainder.
export function requiredHandoffEventSlots(v: CostJournalView) {
  const active = v.orders.filter(
    (o) => !["FILLED", "CANCELLED"].includes(o.status),
  );
  const remainingBuy = active
    .filter((o) => o.side === "BUY")
    .reduce((n, o) => n + o.quantity - o.filled, 0);
  const futureFills = 2 * remainingBuy + v.quantity;
  const unsettled = v.postings.filter((p) => p.settledAt === null).length;
  const futureSells =
    remainingBuy + v.quantity > 0
      ? policy.execution.emergency_exit.maximum_replacements +
        1 -
        v.orders.filter((o) => o.side === "SELL").length
      : 0;
  const cancellation = active.reduce(
    (n, o) =>
      n +
      (o.status === "CANCEL_UNKNOWN"
        ? 1
        : o.status === "UNKNOWN" || o.status === "CANCEL_PENDING"
          ? 2
          : 3),
    0,
  );
  return 2 * futureFills + unsettled + 4 * futureSells + cancellation;
}
function assertEventCapacity(v: CostJournalView, count: number) {
  if (count + requiredHandoffEventSlots(v) > 500)
    throw Error("HANDOFF_TERMINATION_CAPACITY");
}
function metadata(s: ReservationState) {
  if (
    ![handoffKind, outcomeKind, operatingKind].includes(s.kind) ||
    !s.handoff ||
    ([outcomeKind, operatingKind].includes(s.kind) && !s.outcomes) ||
    (s.kind === operatingKind && !s.operating)
  )
    throw Error("HANDOFF_V2_OR_OUTCOME_V3_REQUIRED");
  return s.handoff;
}
function financialAccounts(s: ReservationState): HandoffMetadata["accounts"] {
  const accounts = {} as HandoffMetadata["accounts"];
  for (const currency of ["KRW", "USD"] as const) {
    let cash = d(s.seed.ledger.wallets[currency].cash),
      receivable = d(0),
      payable = d(0),
      reserved = d(0),
      fees = d(0);
    for (const source of s.book.sources) {
      const v = replayCostJournal(source.config, source.events);
      if (v.currency !== currency) continue;
      cash = cash.plus(
        d(v.wallet.cash).minus(source.config.execution.initialCash),
      );
      receivable = receivable.plus(v.wallet.receivable);
      payable = payable.plus(v.wallet.payable);
      reserved = reserved.plus(v.reservedCash);
      fees = fees.plus(v.tradingFees);
    }
    for (const a of s.approvals.filter(
      (a) =>
        a.status === "RESERVED_LOCAL" && a.reservation.currency === currency,
    ))
      reserved = reserved.plus(a.reservation.cashNative);
    if (s.kind === operatingKind && currency === "KRW") {
      const op = operatingView(s);
      cash = cash.minus(op.paidKrw);
      payable = payable.plus(op.payableKrw);
      reserved = reserved.plus(op.reservedKrw);
    }
    accounts[currency] = {
      cash: cash.toString(),
      receivable: receivable.toString(),
      payable: payable.toString(),
      unpaidFees: "0",
      reservedCash: reserved.toString(),
      availableCash: cash.minus(payable).minus(reserved).toString(),
      tradingFees: fees.toString(),
    };
  }
  return accounts;
}
export function initialHandoff(
  c: HandoffConfig | OutcomeConfig | OperatingConfig,
  epoch: number,
): ReservationState {
  if (![handoffKind, outcomeKind, operatingKind].includes(c.kind))
    throw Error("HANDOFF_V2_OR_OUTCOME_V3_REQUIRED");
  if (c.kind !== operatingKind && "historyAdmission" in c)
    throw Error("HISTORY_ADMISSION_OPT_IN_REQUIRED");
  if ([outcomeKind, operatingKind].includes(c.kind) && c.book.sources.length)
    throw Error("OUTCOME_V3_REQUIRES_EMPTY_SOURCES");
  const scope = costJournalConfigSchema.shape.sourceScope.parse(c.sourceScope);
  costJournalConfigSchema.shape.horizonEnd.parse(c.horizonEnd);
  if (
    c.horizonEnd < c.book.initialAt ||
    c.seed.clock > c.horizonEnd ||
    c.book.sources.some((v) => hash(v.config.sourceScope) !== hash(scope))
  )
    throw Error("HANDOFF_SCOPE_OR_HORIZON");
  const s = initialReservations(
    { kind: reservationKind, runId: c.runId, seed: c.seed, book: c.book },
    epoch,
  );
  s.kind = c.kind;
  if ([outcomeKind, operatingKind].includes(c.kind)) s.outcomes = [];
  if (c.kind === outcomeKind && c.executionLoop !== undefined) {
    if (
      c.book.sources.length ||
      c.seed.manifest?.kind !== "SYNTHETIC_COST_SIGNAL_V1"
    )
      throw Error("COST_LOOP_NEW_SIGNAL_RUN_REQUIRED");
    s.loop = {
      config: costLoopConfigSchema.parse(c.executionLoop),
      lastTickAt: null,
      ticks: 0,
      reason: null,
      triggeredAt: null,
      referenceBid: null,
      target: null,
      deadline: null,
      status: "WAITING",
      holds: [],
      exitBlocked: false,
      ...(c.executionLoop.watchdog
        ? {
            watchdog: {
              lastQuoteAt: null,
              lastPulseAt: null,
              pulses: 0,
              holds: [],
            },
          }
        : {}),
    };
  }
  if (c.kind === operatingKind) initializeOperating(s, c);
  if (c.kind === operatingKind && c.operatingLoop !== undefined) {
    const config = costOperatingLoopConfigSchema.parse(c.operatingLoop);
    // Only the new S8-C opt-in admits D8. Legacy S7 and D9/D10 combinations
    // retain their original boundary; no existing run is reinterpreted.
    if (
      (c.finalization !== undefined) !== (config.closeContract !== undefined) ||
      c.postClose !== undefined ||
      c.partialSettlement !== undefined ||
      "executionLoop" in c
    )
      throw Error("COST_OPERATING_LOOP_EXTENSION_UNSUPPORTED");
    if (
      c.seed.manifest?.kind !== "SYNTHETIC_COST_SIGNAL_V1" ||
      c.seed.manifest.signalBasisHash !== config.signalBasisHash
    )
      throw Error("COST_OPERATING_LOOP_SIGNAL_REQUIRED");
    s.loop = {
      config,
      lastTickAt: null,
      ticks: 0,
      reason: null,
      triggeredAt: null,
      referenceBid: null,
      target: null,
      deadline: null,
      status: "WAITING",
      holds: [],
      exitBlocked: false,
      ...(config.watchdog
        ? {
            watchdog: {
              lastQuoteAt: null,
              lastPulseAt: null,
              pulses: 0,
              holds: [],
            },
          }
        : {}),
    };
  }
  s.handoff = {
    sourceScope: scope,
    horizonEnd: c.horizonEnd,
    transfers: [],
    controlCount: 0,
    admissionHolds: [],
    accounts: financialAccounts(s),
  };
  fillIndex(s);
  return s;
}
export function handoffExposure(
  s: ReservationState,
  epoch = s.epoch,
): ReturnType<typeof reservationExposure> {
  const m = metadata(s);
  const hold = (reasons: string[]) => ({
    status: "HOLD" as const,
    reasons,
    orderSubmissionAllowed: false as const,
    learningAllowed: false as const,
    liveEnabled: false as const,
  });
  if (m.admissionHolds.length) return hold([...m.admissionHolds]);
  const built = reservationExposure(s, epoch);
  if (built.status !== "OK") return built;
  const floors = m.transfers.map((t) => {
    const a = s.approvals.find((a) => a.id === t.reservationId)!;
    const src = s.book.sources.find((v) => v.config.runId === t.runId)!;
    const v = replayCostJournal(src.config, src.events),
      p = a.proposal.profile;
    const adverse = d(a.proposal.request.tickSize).mul(
      a.proposal.request.adverseExitTicks,
    );
    const exitPrice = max(
      "0.00000001",
      d(a.candidate.stop).minus(adverse),
    ).toString();
    const exits = policy.execution.emergency_exit.maximum_replacements + 1;
    let risk = d(0);
    if (v.quantity > 0)
      risk = max(0, d(src.observation.bid).minus(a.candidate.stop))
        .plus(adverse)
        .mul(v.quantity)
        .plus(
          estimateFeeBound(
            p,
            "SELL",
            v.quantity,
            exitPrice,
            s.seed.clock,
            exits,
          ),
        );
    for (const o of v.orders.filter(
      (o) => o.side === "BUY" && !["FILLED", "CANCELLED"].includes(o.status),
    )) {
      const remaining = o.quantity - o.filled;
      risk = risk
        .plus(d(o.limit).minus(a.candidate.stop).plus(adverse).mul(remaining))
        .plus(max(0, d(o.reservedCash).minus(d(o.limit).mul(remaining))))
        .plus(
          estimateFeeBound(
            p,
            "SELL",
            remaining,
            exitPrice,
            s.seed.clock,
            exits,
          ),
        );
    }
    return {
      symbol: a.proposal.request.symbol,
      riskKrw: ceil(risk.mul(fxFor(s.seed.ledger, p.scope.currency))),
    };
  });
  return {
    status: "OK",
    context: withExecutionRiskFloors(built.context, floors),
  };
}
export function evaluateHandoff(
  s: ReservationState,
  reservationId: string,
  acknowledgement: "CONFIRMED" | "UNKNOWN",
  epoch = s.epoch,
  currentHistory?: unknown,
) {
  const m = metadata(s);
  id.parse(reservationId);
  z.enum(["CONFIRMED", "UNKNOWN"]).parse(acknowledgement);
  const a = s.approvals.find((a) => a.id === reservationId);
  if (!a || a.status !== "RESERVED_LOCAL")
    throw Error("LOCAL_RESERVATION_NOT_ACTIVE");
  if (
    s.book.sources.length >= 10 ||
    s.book.sources.some(
      (v) => v.config.execution.instrument === a.proposal.request.symbol,
    )
  )
    throw Error("HANDOFF_SOURCE_CAPACITY");
  // Remove only this never-sent reservation and its already-counted intent for
  // revalidation. This does not mutate the durable counter or refresh evidence.
  const checking = structuredClone(s);
  checking.approvals = checking.approvals.filter((v) => v.id !== reservationId);
  checking.seed.ledger.intents--;
  checking.book.seedHash = hash(checking.seed);
  const context = handoffExposure(checking, epoch);
  if (context.status !== "OK")
    throw Error(`HANDOFF_ADMISSION_HOLD:${context.reasons.join(",")}`);
  const proposal = structuredClone(a.proposal);
  if (s.operating?.historyAdmission) {
    if (a.issuedEpoch !== epoch) throw Error("HISTORY_ADMISSION_EPOCH_CHANGED");
    if (currentHistory === undefined)
      throw Error("HISTORY_ADMISSION_CURRENT_INPUT_REQUIRED");
    proposal.operatingHistory = admissionHistorySchema.parse(currentHistory);
  } else if (currentHistory !== undefined || "operatingHistory" in proposal) {
    throw Error("HISTORY_ADMISSION_OPT_IN_REQUIRED");
  }
  proposal.request.stateHash = context.context.stateHash;
  const checked = evaluateLocalProposal(
    checking,
    proposal,
    epoch,
    handoffExposure,
  );
  if (
    s.operating?.historyAdmission &&
    (!a.operatingBinding ||
      hash(checked.operatingBinding) !== hash(a.operatingBinding) ||
      checked.candidate.operatingEstimateKrw !==
        a.candidate.operatingEstimateKrw)
  )
    throw Error("HISTORY_ADMISSION_REAPPROVAL_REQUIRED");
  if (
    checked.candidate.quantity < a.candidate.quantity ||
    checked.candidate.entry !== a.candidate.entry ||
    checked.candidate.stop !== a.candidate.stop
  )
    throw Error("HANDOFF_REAPPROVAL_REQUIRED");
  const runId = `handoff-${hash({ reservationId }).slice(0, 32)}`;
  const config = costJournalConfigSchema.parse({
    kind: "SYNTHETIC_COST_JOURNAL_V1",
    runId,
    sourceScope: m.sourceScope,
    settlement: "SYNTHETIC_EXPLICIT_NEXT_EVENT",
    operatingCosts: "EXPLICIT_ZERO_FIXTURE",
    horizonEnd: m.horizonEnd,
    execution: {
      kind: "SYNTHETIC_COST_EXECUTION_V1",
      purpose: "TEST_ONLY",
      provenance: "SYNTHETIC_FIXTURE",
      liveEnabled: false,
      policyHash,
      instrument: a.proposal.request.symbol,
      initialAt: s.book.initialAt,
      initialCash: s.seed.ledger.wallets[a.reservation.currency].cash,
      settlement: "SYNTHETIC_IMMEDIATE",
      profile: a.proposal.profile,
    },
  });
  const events: CostJournalEvent[] = [
    {
      kind: "ORDER",
      id: "handoff-order",
      seq: 1,
      at: s.seed.clock,
      orderId: "entry",
      side: "BUY",
      quantity: a.candidate.quantity,
      limit: a.candidate.entry,
      replaces: null,
    },
  ];
  if (acknowledgement === "UNKNOWN")
    events.push({
      kind: "UNKNOWN",
      id: "handoff-unknown",
      seq: 2,
      at: s.seed.clock,
      orderId: "entry",
    });
  assertEventCapacity(replayCostJournal(config, events), events.length);
  return {
    config,
    events,
    ...(s.operating?.historyAdmission
      ? { operatingHistory: proposal.operatingHistory }
      : {}),
    basisHash: hash({
      kind: s.kind,
      state: hash(s),
      epoch,
      approval: a,
      acknowledgement,
      recheck: checked.basisHash,
    }),
  };
}
export interface HandoffFill {
  key: string;
  identityHash: string;
  runId: string;
  fillId: string;
}
export function fillIndex(s: ReservationState): HandoffFill[] {
  metadata(s);
  const seen = new Set<string>(),
    rows: HandoffFill[] = [];
  for (const source of s.book.sources)
    for (const p of replayCostJournal(source.config, source.events).postings) {
      const key = hash({
        sourceScope: source.config.sourceScope,
        fillId: p.fill.fillId,
      });
      if (seen.has(key)) throw Error("HANDOFF_FILL_SCOPE_CONFLICT");
      seen.add(key);
      rows.push({
        key,
        identityHash: p.identityHash,
        runId: source.config.runId,
        fillId: p.fill.fillId,
      });
    }
  return rows.sort((a, b) => a.key.localeCompare(b.key, "en"));
}
export function duplicateHandoffFill(
  s: ReservationState,
  command: ExtendedHandoffCommand,
) {
  if (command.kind !== "EXECUTION" || command.event.kind !== "FILL")
    return false;
  const m = metadata(s),
    e = command.event;
  const key = hash({ sourceScope: m.sourceScope, fillId: e.fillId });
  const prior = fillIndex(s).find((v) => v.key === key);
  if (!prior) return false;
  if (
    prior.runId !== command.runId ||
    prior.identityHash !== journalFillIdentity(e)
  )
    throw Error("HANDOFF_FILL_ID_CONFLICT");
  const source = s.book.sources.find((v) => v.config.runId === command.runId)!;
  const delivery = source.events.find((v) => v.id === e.id);
  if (delivery && hash(delivery) !== hash(e))
    throw Error("HANDOFF_EVENT_ID_CONFLICT");
  return true;
}
function maintainRisk(s: ReservationState, execution: boolean) {
  const m = metadata(s);
  m.accounts = financialAccounts(s);
  const hold = (reason: string) => {
    if (!m.admissionHolds.includes(reason)) m.admissionHolds.push(reason);
  };
  const deficit = Object.values(m.accounts).some((w) =>
    d(w.availableCash).lt(0),
  );
  if (deficit) hold("SHARED_CASH_DEFICIT");
  // Admission overlays may throw for overreserved cash. A valid journal fact
  // must still commit its actual debit/credit and a persistent admission hold.
  const c = deficit && s.kind !== operatingKind ? null : reservationExposure(s);
  if (c?.status === "OK") {
    s.seed.ledger.highNav = c.context.state.ledger.highNav;
    s.seed.ledger.drawdownReduced = c.context.state.ledger.drawdownReduced;
    s.seed.ledger.halts = [...c.context.state.ledger.halts];
    s.seed.status = c.context.state.status;
  } else if (
    execution ||
    s.book.sources.some(
      (v) => replayCostJournal(v.config, v.events).quantity > 0,
    )
  ) {
    hold("RISK_HISTORY_RECONCILIATION_REQUIRED");
  }
  // V2's persisted contract remains unchanged. Only explicit V3 records closes.
  for (const t of s.kind === handoffKind ? m.transfers : []) {
    const source = s.book.sources.find((v) => v.config.runId === t.runId)!;
    const v = replayCostJournal(source.config, source.events);
    if (
      v.postings.some((p) => p.side === "BUY") &&
      v.quantity === 0 &&
      v.orders.every((o) => ["FILLED", "CANCELLED"].includes(o.status))
    )
      hold("CLOSED_OUTCOME_RECONCILIATION_REQUIRED");
  }
  s.book.seedHash = hash(s.seed);
}
export function applyHandoffCommand(
  previous: ReservationState,
  raw: unknown,
  epoch: number,
): ReservationState {
  if (previous.finalization?.checkpoint)
    throw Error("FINALIZED_FINANCIAL_MUTATION_BLOCKED");
  const command =
    previous.kind === operatingKind
      ? extendedHandoffCommandSchema.parse(raw)
      : handoffCommandSchema.parse(raw);
  if (command.kind === "COST_LOOP_PULSE")
    return applyCostWatchdog(previous, command, epoch);
  if (command.kind === "COST_LOOP_TICK") {
    const s = applyCostLoopTick(previous, command, epoch, (state, step) =>
      applyHandoffStep(state, step, epoch, previous.revision + 1),
    );
    // Substeps are not observable snapshots. Finalize against the coherent
    // post-fill quantity/mark once, before the single atomic store commit.
    recordClosedOutcomes(s);
    maintainRisk(s, true);
    fillIndex(s);
    for (const reason of s.handoff!.admissionHolds)
      if (!s.loop!.holds.includes(reason)) s.loop!.holds.push(reason);
    if (s.loop!.holds.length) s.loop!.status = "HOLD";
    return s;
  }
  return applyHandoffStep(previous, command, epoch);
}
function applyHandoffStep(
  previous: ReservationState,
  command: Exclude<
    ExtendedHandoffCommand,
    { kind: "COST_LOOP_TICK" | "COST_LOOP_PULSE" }
  >,
  epoch: number,
  commitRevision?: number,
): ReservationState {
  // Nested effects spend one outer command slot, not one slot per substep.
  // Keep the pre-commit revision for capacity checks; every result below is
  // still stamped with the same private commitRevision before returning.
  if (commitRevision !== undefined)
    previous = { ...previous, revision: commitRevision - 1 };
  const m = metadata(previous);
  if (previous.loop && command.kind === "RESERVE" && previous.approvals.length)
    throw Error("COST_LOOP_SINGLE_APPROVAL_REQUIRED");
  z.number().int().safe().min(previous.epoch).parse(epoch);
  if (
    previous.revision -
      (previous.operating?.events.length ?? 0) -
      (previous.operating?.rejectedInputs.length ?? 0) >=
      handoffCommandLimit &&
    command.kind !== "OPERATING" &&
    command.kind !== "OPERATING_HOLD"
  )
    throw Error("HANDOFF_COMMAND_LIMIT");
  const control =
    commitRevision === undefined &&
    command.kind !== "EXECUTION" &&
    command.kind !== "RELEASE_LOCAL" &&
    command.kind !== "OPERATING" &&
    command.kind !== "OPERATING_HOLD";
  if (control && m.controlCount >= 100) throw Error("HANDOFF_CONTROL_LIMIT");
  let s = structuredClone(previous);
  if (
    command.kind === "RESERVE" ||
    command.kind === "RELEASE_LOCAL" ||
    command.kind === "OBSERVE"
  ) {
    if (command.kind === "OBSERVE")
      for (const t of m.transfers) {
        const a = s.approvals.find((a) => a.id === t.reservationId)!;
        if (
          command.observations.find((v) => v.runId === t.runId)?.observation
            .stop !== a.candidate.stop
        )
          throw Error("HANDOFF_APPROVED_STOP_IMMUTABLE");
      }
    s = applyReservationCommand(s, command, epoch, {
      project: handoffExposure,
      maximumCommands:
        handoffCommandLimit +
        (s.kind === operatingKind ? operatingEventLimit : 0),
    });
  } else if (command.kind === "OPERATING_HOLD") {
    quarantineOperating(s, command.rawJson);
    s.revision++;
  } else if (command.kind === "OPERATING") {
    appendOperating(s, command.event, command.rawJson);
    s.revision++;
  } else if (command.kind === "HANDOFF") {
    if (!s.operating?.historyAdmission && "operatingHistory" in command)
      throw Error("HISTORY_ADMISSION_OPT_IN_REQUIRED");
    const checked = evaluateHandoff(
      s,
      command.reservationId,
      command.acknowledgement,
      epoch,
      command.operatingHistory,
    );
    if (checked.basisHash !== command.basisHash)
      throw Error("HANDOFF_REAPPROVAL_REQUIRED");
    const a = s.approvals.find((a) => a.id === command.reservationId)!;
    s.book.sources.push({
      config: checked.config,
      events: checked.events,
      observation: {
        at: a.proposal.request.quote.at,
        bid: a.proposal.request.quote.bid,
        stop: a.candidate.stop,
        protection: "WATCHING",
        protectedQuantity: 0,
      },
    });
    a.status = "TRANSFERRED_SYNTHETIC";
    metadata(s).transfers.push({
      reservationId: a.id,
      runId: checked.config.runId,
      acknowledgement: command.acknowledgement,
    });
    s.revision++;
  } else {
    const source = s.book.sources.find((v) => v.config.runId === command.runId);
    if (!source || !m.transfers.some((t) => t.runId === command.runId))
      throw Error("HANDOFF_SOURCE_NOT_MANAGED");
    const e = command.event;
    if (s.loop?.watchdog && e.at < (s.loop.watchdog.lastPulseAt ?? 0))
      throw Error("COST_WATCHDOG_EVENT_TIME_REGRESSION");
    if (
      e.at < s.seed.clock ||
      hash(riskKeys(e.at)) !== hash(riskKeys(s.seed.clock))
    )
      throw Error("HANDOFF_EVENT_TIME_OR_PERIOD");
    if (e.kind === "ORDER" && e.side === "BUY")
      throw Error("HANDOFF_BUY_REQUIRES_APPROVAL");
    if (duplicateHandoffFill(s, command))
      throw Error("HANDOFF_DUPLICATE_REQUIRES_STORE");
    const before = replayCostJournal(source.config, source.events);
    source.events.push(e);
    const after = replayCostJournal(source.config, source.events);
    assertEventCapacity(after, source.events.length);
    if (
      !before.postings.some((p) => p.side === "BUY") &&
      after.postings.some((p) => p.side === "BUY")
    ) {
      s.seed.ledger.entries++;
      const symbol = source.config.execution.instrument;
      s.seed.ledger.symbolEntries[symbol] =
        (s.seed.ledger.symbolEntries[symbol] ?? 0) + 1;
    }
    s.seed.clock = e.at;
    s.revision++;
  }
  s.epoch = epoch;
  // All nested effects belong to ONE persisted command/revision, including
  // outcome hashes. This private override cannot be supplied by a caller.
  if (commitRevision !== undefined) s.revision = commitRevision;
  s.seed.epoch = epoch;
  s.book.seedHash = hash(s.seed);
  if (control) metadata(s).controlCount++;
  if (
    (command.kind === "HANDOFF" ||
      (command.kind === "EXECUTION" &&
        command.event.kind === "ORDER" &&
        // B already validated held quantity and the cancel/replacement chain.
        // A shared cash deficit must not prevent a risk-reducing V4 sale.
        !(
          (s.kind === operatingKind || s.loop) &&
          command.event.side === "SELL"
        ))) &&
    Object.values(financialAccounts(s)).some((w) => d(w.availableCash).lt(0))
  )
    throw Error("HANDOFF_SHARED_CASH_DEFICIT");
  if (s.kind === operatingKind) syncOperating(s);
  if (commitRevision === undefined) {
    if ([outcomeKind, operatingKind].includes(s.kind)) recordClosedOutcomes(s);
    maintainRisk(s, command.kind === "EXECUTION");
    fillIndex(s);
  }
  return s;
}
