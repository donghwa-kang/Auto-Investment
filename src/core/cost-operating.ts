import { z } from "zod";
import { hash, policy, policyHash } from "./policy.js";
import { d, min } from "./math.js";
import { completedRiskWindow } from "./calendar.js";
import {
  operatingJournalSchema,
  replayOperatingDeltas,
  OperatingJournalError,
} from "./operating-journal.js";
import type { OperatingJournalView } from "./operating-journal.js";
import type { HandoffConfig } from "./cost-handoff.js";
import type { ReservationState } from "./cost-reservation.js";
import type { FinalizationOptions } from "./cost-finalization.js";
import type { PostCloseOptions } from "./cost-post-close.js";
import type { PartialSettlementOptions } from "./cost-partial-settlement.js";
import type { CostOperatingLoopConfig } from "./cost-loop-schema.js";
import {
  historyAdmissionSchema,
  validateHistoryAdmissionSeed,
} from "./cost-history-admission.js";
import type { HistoryAdmission } from "./cost-history-admission.js";

export const operatingKind = "SYNTHETIC_KRW_OPERATING_LEDGER_V4";
export const operatingContractHash = hash({
  contract: "D6_KRW_OPERATING_LEDGER_V1",
  policyHash,
  scope: "U08-A",
  closePolicy: "U06-A_PENDING_ALLOCATION",
  admission: "EXPLICIT_ZERO_FIXTURE_UNTIL_FIRST_OPERATING_EVENT",
  finalization: "UNIMPLEMENTED_HOLD",
  newSpendingApproved: false,
});
const time = operatingJournalSchema.shape.asOf;
export const operatingConfigSchema = z.strictObject({
  contractHash: z.literal(operatingContractHash),
  periodStart: time,
  periodEnd: time,
  priorMonthIncurredKrw: z.literal("0"),
  priorMonthReservedKrw: z.literal("0"),
});
export const operatingEventSchema = operatingJournalSchema.shape.events.element;
export type OperatingEvent = z.infer<typeof operatingEventSchema>;
export const operatingRawSchema = z
  .string()
  .max(8192)
  .refine(
    (v) => new TextEncoder().encode(v).length <= 8192,
    "OPERATING_INPUT_TOO_LARGE",
  );
export const operatingCommandSchema = z.strictObject({
  kind: z.literal("OPERATING"),
  event: operatingEventSchema,
  rawJson: operatingRawSchema.optional(),
});
export const operatingHoldCommandSchema = z.strictObject({
  kind: z.literal("OPERATING_HOLD"),
  rawJson: operatingRawSchema,
});
export interface OperatingConfig extends Omit<HandoffConfig, "kind"> {
  kind: typeof operatingKind;
  operating: z.infer<typeof operatingConfigSchema>;
  finalization?: FinalizationOptions;
  postClose?: PostCloseOptions;
  partialSettlement?: PartialSettlementOptions;
  operatingLoop?: CostOperatingLoopConfig;
  historyAdmission?: HistoryAdmission;
}
export interface OperatingMetadata {
  historyAdmission?: HistoryAdmission;
  config: z.infer<typeof operatingConfigSchema>;
  runHash: string;
  events: OperatingEvent[];
  rejectedInputs: { rawJson: string; reason: string; recordedAt: number }[];
  effects: Pick<
    OperatingJournalView,
    "incurredKrw" | "paidKrw" | "payableKrw" | "reservedKrw" | "sourceHash"
  >;
  finalNetPnlKrw: null;
  allocationStatus: "HOLD";
  newSpendingApproved: false;
}
export function validateOperatingConfig(c: OperatingConfig) {
  const cfg = operatingConfigSchema.parse(c.operating);
  const start = completedRiskWindow(c.seed.clock).endExclusive;
  if (
    c.kind !== operatingKind ||
    c.seed.config?.market !== "KR" ||
    c.book.sources.length ||
    !d(c.seed.ledger.wallets.USD.cash).eq(0) ||
    cfg.periodStart !== start ||
    cfg.periodEnd !== start + 86400000 ||
    c.horizonEnd >= cfg.periodEnd ||
    c.book.initialAt < cfg.periodStart
  )
    throw Error("OPERATING_KRW_SINGLE_PERIOD_EMPTY_RUN_REQUIRED");
  if ("historyAdmission" in c) {
    historyAdmissionSchema.parse(c.historyAdmission);
    if (!c.operatingLoop || c.postClose || c.partialSettlement)
      throw Error("HISTORY_ADMISSION_OPERATING_LOOP_REQUIRED");
    validateHistoryAdmissionSeed(c.seed);
  }
  return cfg;
}
// Reuse obligation validation, but only shared-account deltas, not a wallet.
export function operatingView(s: ReservationState) {
  if (s.kind !== operatingKind || !s.operating)
    throw Error("OPERATING_V4_REQUIRED");
  return replayOperatingDeltas({
    schemaVersion: "OPERATING_JOURNAL_TEST_V1",
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    liveEnabled: false,
    runHash: s.operating.runHash,
    policyHash,
    startedAt: s.book.initialAt,
    asOf: s.seed.clock,
    startsEmpty: true,
    complete: true,
    events: s.operating.events,
  });
}
export function syncOperating(s: ReservationState) {
  const v = operatingView(s);
  s.operating!.effects = {
    incurredKrw: v.incurredKrw,
    paidKrw: v.paidKrw,
    payableKrw: v.payableKrw,
    reservedKrw: v.reservedKrw,
    sourceHash: v.sourceHash,
  };
}
export function initializeOperating(s: ReservationState, c: OperatingConfig) {
  const config = validateOperatingConfig(c);
  s.operating = {
    ...(c.historyAdmission
      ? { historyAdmission: historyAdmissionSchema.parse(c.historyAdmission) }
      : {}),
    config,
    runHash: hash(c),
    events: [],
    rejectedInputs: [],
    effects: {
      incurredKrw: "0",
      paidKrw: "0",
      payableKrw: "0",
      reservedKrw: "0",
      sourceHash: "",
    },
    finalNetPnlKrw: null,
    allocationStatus: "HOLD",
    newSpendingApproved: false,
  };
  syncOperating(s);
}
export function duplicateOperatingEvent(
  s: ReservationState,
  e: OperatingEvent,
) {
  if (s.kind !== operatingKind || !s.operating)
    throw Error("OPERATING_V4_REQUIRED");
  const prior = s.operating.events.find((v) => v.eventId === e.eventId);
  if (!prior) return false;
  if (hash(prior) !== hash(e)) throw Error("OPERATING_EVENT_ID_CONFLICT");
  return true;
}
export const operatingEventLimit = 100;
function terminalSlots(s: ReservationState) {
  const v = operatingView(s);
  return (
    2 * v.reservations.filter((r) => r.state === "RESERVED").length +
    v.obligations.filter((r) => !r.paid).length
  );
}
export function quarantineOperating(
  s: ReservationState,
  rawJson: string,
  reason = "OPERATING_INVALID_INPUT",
) {
  if (s.kind !== operatingKind || !s.operating || !s.handoff)
    throw Error("OPERATING_V4_REQUIRED");
  operatingRawSchema.parse(rawJson);
  const m = s.operating;
  if (
    m.events.length + m.rejectedInputs.length + 1 + terminalSlots(s) >
    operatingEventLimit
  )
    throw Error("OPERATING_TERMINATION_CAPACITY");
  m.rejectedInputs.push({ rawJson, reason, recordedAt: s.seed.clock });
  if (
    !s.handoff.admissionHolds.includes(
      "OPERATING_INPUT_RECONCILIATION_REQUIRED",
    )
  )
    s.handoff.admissionHolds.push("OPERATING_INPUT_RECONCILIATION_REQUIRED");
}
export function appendOperating(
  s: ReservationState,
  e: OperatingEvent,
  rawJson = JSON.stringify(e),
) {
  const m = s.operating;
  if (s.kind !== operatingKind || !m || !s.handoff)
    throw Error("OPERATING_V4_REQUIRED");
  operatingRawSchema.parse(rawJson);
  if (hash(operatingEventSchema.parse(JSON.parse(rawJson))) !== hash(e))
    throw Error("OPERATING_RAW_EVENT_MISMATCH");
  if (duplicateOperatingEvent(s, e))
    throw Error("OPERATING_DUPLICATE_REQUIRES_STORE");
  if (
    e.availableAt < s.seed.clock ||
    e.occurredAt < s.seed.clock ||
    e.availableAt < (s.loop?.watchdog?.lastPulseAt ?? 0) ||
    e.availableAt >= m.config.periodEnd ||
    e.occurredAt < m.config.periodStart ||
    e.availableAt > s.handoff.horizonEnd
  )
    return quarantineOperating(
      s,
      rawJson,
      "OPERATING_LATE_OR_PERIOD_EVENT_UNSUPPORTED",
    );
  // Keep terminal slots for every reservation (recognize+pay OR release)
  // and every unpaid obligation. Costs cannot consume execution's 5200 slots.
  const oldClock = s.seed.clock;
  s.seed.clock = e.availableAt;
  m.events.push(e);
  let after;
  try {
    after = operatingView(s);
  } catch (error) {
    if (!(error instanceof OperatingJournalError)) throw error;
    m.events.pop();
    s.seed.clock = oldClock;
    return quarantineOperating(s, rawJson, error.code);
  }
  const reservedSlots =
    2 * after.reservations.filter((v) => v.state === "RESERVED").length +
    after.obligations.filter((v) => !v.paid).length;
  if (
    m.events.length + m.rejectedInputs.length + reservedSlots >
    operatingEventLimit
  )
    throw Error("OPERATING_TERMINATION_CAPACITY");
  const cap = min(
    d(s.seed.config!.capital)
      .mul(policy.economic_gate.maximum_incremental_monthly_cost_bps)
      .div(10000),
    policy.economic_gate.maximum_incremental_monthly_cost_krw,
  );
  const total = d(after.incurredKrw).plus(after.reservedKrw);
  if (
    e.kind === "RESERVE" &&
    (total.gt(cap) || d(s.handoff.accounts.KRW.availableCash).lt(e.amountKrw))
  )
    throw Error("OPERATING_RESERVATION_BUDGET_OR_CASH");
  if (e.kind === "PAY") {
    // Paying one's recorded liability replaces payable with paid. It must not
    // consume money reserved for trading or other obligations, nor receivables.
    if (
      d(s.handoff.accounts.KRW.cash)
        .minus(e.amountKrw)
        .lt(
          d(s.handoff.accounts.KRW.payable)
            .minus(e.amountKrw)
            .plus(s.handoff.accounts.KRW.reservedCash),
        )
    )
      throw Error("OPERATING_SHARED_PAYMENT_CASH");
  }
  const hold = (reason: string) => {
    if (!s.handoff!.admissionHolds.includes(reason))
      s.handoff!.admissionHolds.push(reason);
  };
  // An already incurred debt is never deleted to make a spending cap pass.
  if (total.gt(cap)) hold("OPERATING_MONTHLY_BUDGET_EXCEEDED");
  hold("OPERATING_ADMISSION_INTEGRATION_PENDING");
  syncOperating(s);
}
