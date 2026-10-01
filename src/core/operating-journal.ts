import { z } from "zod";
import { hash, policyHash } from "./policy.js";

const amount = z
  .string()
  .max(30)
  .regex(/^(0|[1-9][0-9]*)$/);
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().safe().min(0).max(8_640_000_000_000_000);
const common = {
  eventId: id,
  sequence: z.number().int().min(1).max(10_000),
  occurredAt: time,
  availableAt: time,
};
const event = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("RESERVE"),
    obligationId: id,
    amountKrw: amount,
  }),
  z.strictObject({
    ...common,
    kind: z.literal("RECOGNIZE"),
    obligationId: id,
    reservationId: id.nullable(),
    amountKrw: amount,
  }),
  z.strictObject({
    ...common,
    kind: z.literal("PAY"),
    obligationId: id,
    amountKrw: amount,
  }),
  z.strictObject({ ...common, kind: z.literal("RELEASE"), reservationId: id }),
]);

// 새로운 원화 비용 전용 합성 보조장부다. 기존 계좌·매매 장부를 받아 변경하지 않는다.
export const operatingJournalSchema = z.strictObject({
  schemaVersion: z.literal("OPERATING_JOURNAL_TEST_V1"),
  purpose: z.literal("TEST_ONLY"),
  provenance: z.literal("SYNTHETIC_FIXTURE"),
  liveEnabled: z.literal(false),
  runHash: digest,
  // 기존 원본 정책의 고정 바이트 해시는 대문자, 새 내용 해시는 소문자다.
  policyHash: z.string().regex(/^[A-F0-9]{64}$/),
  startedAt: time,
  asOf: time,
  openingCashKrw: amount,
  startsEmpty: z.literal(true),
  complete: z.literal(true),
  events: z.array(event).max(10_000),
});
export type OperatingJournal = z.infer<typeof operatingJournalSchema>;
export class OperatingJournalError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new OperatingJournalError(code);
}
export interface OperatingObligation {
  id: string;
  costEventId: string;
  amountKrw: string;
  occurredAt: number;
  availableAt: number;
  reservationId: string | null;
  paid: boolean;
  paymentId: string | null;
}
export interface OperatingReservation {
  id: string;
  obligationId: string;
  amountKrw: string;
  occurredAt: number;
  availableAt: number;
  state: "RESERVED" | "CONVERTED" | "RELEASED";
}
export interface OperatingJournalView {
  schemaVersion: "OPERATING_JOURNAL_VIEW_V1";
  purpose: "TEST_ONLY";
  liveEnabled: false;
  newSpendingApproved: false;
  runHash: string;
  policyHash: string;
  startedAt: number;
  asOf: number;
  sourceHash: string;
  openingCashKrw: string;
  cashKrw: string;
  payableKrw: string;
  incurredKrw: string;
  paidKrw: string;
  reservedKrw: string;
  netEquityKrw: string;
  availableAfterReservationsKrw: string;
  obligations: OperatingObligation[];
  reservations: OperatingReservation[];
}

export function replayOperatingJournal(raw: unknown): OperatingJournalView {
  try {
    return replay(raw);
  } catch (error) {
    if (error instanceof OperatingJournalError) throw error;
    throw new OperatingJournalError("OPERATING_JOURNAL_INVALID");
  }
}
// Integrated accounts own the cash balance. This delta-only view must not
// expose an independent wallet or limit payment to the initial cash seed.
export type OperatingDeltaView = Pick<
  OperatingJournalView,
  | "sourceHash"
  | "incurredKrw"
  | "paidKrw"
  | "payableKrw"
  | "reservedKrw"
  | "obligations"
  | "reservations"
>;
export function replayOperatingDeltas(
  raw: Omit<OperatingJournal, "openingCashKrw">,
): OperatingDeltaView {
  try {
    const v = replay({ ...raw, openingCashKrw: "0" }, true);
    return {
      sourceHash: v.sourceHash,
      incurredKrw: v.incurredKrw,
      paidKrw: v.paidKrw,
      payableKrw: v.payableKrw,
      reservedKrw: v.reservedKrw,
      obligations: v.obligations,
      reservations: v.reservations,
    };
  } catch (error) {
    if (error instanceof OperatingJournalError) throw error;
    throw new OperatingJournalError("OPERATING_JOURNAL_INVALID");
  }
}
function replay(raw: unknown, accountOwnsCash = false): OperatingJournalView {
  const input = operatingJournalSchema.parse(raw);
  if (input.policyHash !== policyHash)
    fail("OPERATING_JOURNAL_POLICY_MISMATCH");
  if (input.asOf < input.startedAt) fail("OPERATING_JOURNAL_TIME_INVALID");
  const byEvent = new Map<string, OperatingJournal["events"][number]>();
  for (const e of input.events) {
    const old = byEvent.get(e.eventId);
    if (old && hash(old) !== hash(e)) fail("OPERATING_JOURNAL_EVENT_CONFLICT");
    byEvent.set(e.eventId, e);
  }
  const events = [...byEvent.values()].sort((a, b) => a.sequence - b.sequence);
  const obligations = new Map<string, OperatingObligation>();
  const reservations = new Map<string, OperatingReservation>();
  const reservedObligations = new Map<string, string>();
  let cash = BigInt(input.openingCashKrw),
    payable = 0n,
    incurred = 0n,
    paid = 0n,
    reserved = 0n;
  let occurredAt = input.startedAt,
    availableAt = input.startedAt;
  for (const [index, e] of events.entries()) {
    if (e.sequence !== index + 1) fail("OPERATING_JOURNAL_SEQUENCE_INVALID");
    if (
      e.occurredAt < occurredAt ||
      e.availableAt < availableAt ||
      e.availableAt < e.occurredAt ||
      e.availableAt > input.asOf
    )
      fail("OPERATING_JOURNAL_TIME_OR_LATE_EVENT_UNSUPPORTED");
    occurredAt = e.occurredAt;
    availableAt = e.availableAt;
    if (e.kind === "RESERVE") {
      if (
        obligations.has(e.obligationId) ||
        reservedObligations.has(e.obligationId)
      )
        fail("OPERATING_JOURNAL_OBLIGATION_ALREADY_LINKED");
      reservedObligations.set(e.obligationId, e.eventId);
      reservations.set(e.eventId, {
        id: e.eventId,
        obligationId: e.obligationId,
        amountKrw: e.amountKrw,
        occurredAt: e.occurredAt,
        availableAt: e.availableAt,
        state: "RESERVED",
      });
      reserved += BigInt(e.amountKrw);
    } else if (e.kind === "RECOGNIZE") {
      if (obligations.has(e.obligationId))
        fail("OPERATING_JOURNAL_DUPLICATE_OBLIGATION");
      if (e.reservationId !== null) {
        const reservation = reservations.get(e.reservationId);
        if (
          !reservation ||
          reservation.state !== "RESERVED" ||
          reservation.obligationId !== e.obligationId ||
          reservation.amountKrw !== e.amountKrw
        )
          fail("OPERATING_JOURNAL_RESERVATION_MISMATCH");
        reservation.state = "CONVERTED";
        reserved -= BigInt(reservation.amountKrw);
      } else if (
        reservations.get(reservedObligations.get(e.obligationId) ?? "")
          ?.state === "RESERVED"
      )
        fail("OPERATING_JOURNAL_RESERVATION_LINK_REQUIRED");
      obligations.set(e.obligationId, {
        id: e.obligationId,
        costEventId: e.eventId,
        amountKrw: e.amountKrw,
        occurredAt: e.occurredAt,
        availableAt: e.availableAt,
        reservationId: e.reservationId,
        paid: false,
        paymentId: null,
      });
      incurred += BigInt(e.amountKrw);
      payable += BigInt(e.amountKrw);
    } else if (e.kind === "PAY") {
      const obligation = obligations.get(e.obligationId);
      if (
        !obligation ||
        obligation.paid ||
        obligation.amountKrw !== e.amountKrw
      )
        fail("OPERATING_JOURNAL_PAYMENT_MISMATCH");
      const value = BigInt(e.amountKrw);
      if (!accountOwnsCash && value > cash)
        fail("OPERATING_JOURNAL_INSUFFICIENT_CASH");
      cash -= value;
      payable -= value;
      paid += value;
      obligation.paid = true;
      obligation.paymentId = e.eventId;
    } else {
      const reservation = reservations.get(e.reservationId);
      if (!reservation || reservation.state !== "RESERVED")
        fail("OPERATING_JOURNAL_RELEASE_MISMATCH");
      reservation.state = "RELEASED";
      reserved -= BigInt(reservation.amountKrw);
    }
  }
  const obligationRows = [...obligations.values()];
  const reservationRows = [...reservations.values()];
  const total = <T>(rows: T[], value: (r: T) => string) =>
    rows.reduce((sum, r) => sum + BigInt(value(r)), 0n);
  // 상태 누적값과 ID별 증거를 별도로 대조한다. 지급은 비용 총액을 바꾸지 않는다.
  if (
    incurred !== total(obligationRows, (r) => r.amountKrw) ||
    paid !==
      total(
        obligationRows.filter((r) => r.paid),
        (r) => r.amountKrw,
      ) ||
    payable !==
      total(
        obligationRows.filter((r) => !r.paid),
        (r) => r.amountKrw,
      ) ||
    reserved !==
      total(
        reservationRows.filter((r) => r.state === "RESERVED"),
        (r) => r.amountKrw,
      ) ||
    cash !== BigInt(input.openingCashKrw) - paid ||
    payable + paid !== incurred
  )
    fail("OPERATING_JOURNAL_RECONCILIATION_FAILED");
  return {
    schemaVersion: "OPERATING_JOURNAL_VIEW_V1",
    purpose: "TEST_ONLY",
    liveEnabled: false,
    newSpendingApproved: false,
    runHash: input.runHash,
    policyHash: input.policyHash,
    startedAt: input.startedAt,
    asOf: input.asOf,
    sourceHash: hash({ ...input, events }),
    openingCashKrw: input.openingCashKrw,
    cashKrw: String(cash),
    payableKrw: String(payable),
    incurredKrw: String(incurred),
    paidKrw: String(paid),
    reservedKrw: String(reserved),
    netEquityKrw: String(cash - payable),
    availableAfterReservationsKrw: String(cash - payable - reserved),
    obligations: obligationRows,
    reservations: reservationRows,
  };
}

// 저장된 합계/성공 표시를 신뢰하지 않고 동일 원자료에서 다시 만든다.
export function verifyOperatingJournalView(
  raw: unknown,
  claimed: unknown,
): OperatingJournalView {
  const rebuilt = replayOperatingJournal(raw);
  try {
    if (hash(claimed) === hash(rebuilt)) return rebuilt;
  } catch {
    /* 고정 오류로 보류 */
  }
  return fail("OPERATING_JOURNAL_VIEW_MISMATCH");
}
