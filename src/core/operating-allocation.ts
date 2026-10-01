import { z } from "zod";
import { hash } from "./policy.js";
import { paperId, paperTime } from "./paper-learning-schema.js";
import { paperTerminal, verifyPaperExport } from "./paper-learning-verify.js";
import { replayOperatingJournal } from "./operating-journal.js";

const periodSchema = z.strictObject({
  periodId: paperId,
  startInclusive: paperTime,
  endExclusive: paperTime,
  finalizedAt: paperTime,
  availableAt: paperTime,
  complete: z.literal(true),
});
export const operatingAllocationSchema = z.strictObject({
  schemaVersion: z.literal("OPERATING_ALLOCATION_TEST_V1"),
  purpose: z.literal("TEST_ONLY"),
  provenance: z.literal("SYNTHETIC_FIXTURE"),
  liveEnabled: z.literal(false),
  corrections: z.literal("NONE_DECLARED"),
  period: periodSchema,
  journal: z.unknown(),
  paperExport: z.unknown(),
});
export type OperatingAllocationInput = z.infer<
  typeof operatingAllocationSchema
>;
export class OperatingAllocationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const requireValue = (ok: boolean, code: string) => {
  if (!ok) throw new OperatingAllocationError(code);
};
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// 원본 거래 손익의 소수 정밀도와 큰 원화 정수를 Number/Decimal 반올림 없이 보존한다.
function subtractInteger(value: string, amount: bigint): string {
  const negative = value.startsWith("-"),
    [whole = "0", fraction = ""] = value.replace(/^-/, "").split("."),
    scale = 10n ** BigInt(fraction.length),
    original = BigInt(whole + fraction) * (negative ? -1n : 1n),
    result = original - amount * scale,
    absolute = result < 0 ? -result : result,
    digits = absolute.toString().padStart(fraction.length + 1, "0"),
    decimal = fraction.length
      ? `${digits.slice(0, -fraction.length)}.${digits.slice(-fraction.length)}`
          .replace(/0+$/, "")
          .replace(/\.$/, "")
      : digits;
  return `${result < 0 ? "-" : ""}${decimal}`;
}

// 별도 시험 보고서일 뿐 기존 포트폴리오 원장·손실 래치·학습 정답을 변경하지 않는다.
export function buildOperatingAllocation(raw: unknown) {
  const parsed = operatingAllocationSchema.safeParse(raw);
  if (!parsed.success)
    throw new OperatingAllocationError("OPERATING_ALLOCATION_INPUT_INVALID");
  const input = parsed.data,
    period = input.period,
    journal = replayOperatingJournal(input.journal),
    source = verifyPaperExport(input.paperExport),
    contains = (at: number) =>
      at >= period.startInclusive && at < period.endExclusive;
  requireValue(
    period.startInclusive < period.endExclusive &&
      period.endExclusive <= period.finalizedAt &&
      period.finalizedAt <= period.availableAt &&
      journal.startedAt <= period.startInclusive &&
      source.journal.startedAt <= period.startInclusive &&
      period.endExclusive <= journal.asOf &&
      journal.asOf <= period.finalizedAt &&
      period.endExclusive <= source.asOf &&
      source.asOf <= period.finalizedAt,
    "OPERATING_ALLOCATION_PERIOD_INVALID",
  );
  requireValue(
    journal.runHash === source.journal.runHash &&
      journal.policyHash === source.journal.policyHash,
    "OPERATING_ALLOCATION_BINDING_MISMATCH",
  );
  requireValue(
    source.positions.every((p) => p.market === "KR" && p.currency === "KRW") &&
      source.orders.every(
        (o) =>
          o.currency === "KRW" &&
          (o.side !== "BUY" || o.snapshot?.market === "KR"),
      ) &&
      source.journal.decisions.every((decision) =>
        decision.symbol.startsWith("KR:"),
      ),
    "OPERATING_ALLOCATION_MARKET_UNSUPPORTED",
  );
  requireValue(
    source.costs.length === 0,
    "OPERATING_ALLOCATION_LEGACY_COST_UNSUPPORTED",
  );
  const intentIds = source.orders
    .filter((order) => order.side === "BUY")
    .map((order) => order.intentId);
  requireValue(
    new Set(intentIds).size === intentIds.length &&
      new Set(source.positions.map((p) => p.intentId)).size ===
        source.positions.length,
    "OPERATING_ALLOCATION_DUPLICATE_INTENT",
  );
  // V1 내보내기에는 주문별 종결 가용시각이 없다. 미종결 주문이나 기간을
  // 가로지르는 포지션은 배분 분모에서 조용히 버리지 않고 이번 보고를 보류한다.
  requireValue(
    source.orders.every(
      (order) =>
        order.submittedAt >= period.endExclusive || paperTerminal(order),
    ),
    "OPERATING_ALLOCATION_OPEN_INTENT",
  );
  const trades = source.positions.filter(
    (p) =>
      p.firstFillAt < period.endExclusive &&
      (p.closedAt === null || p.closedAt >= period.startInclusive),
  );
  requireValue(
    trades.every(
      (p) =>
        p.closedAt !== null &&
        contains(p.closedAt) &&
        contains(p.firstFillAt) &&
        p.quantity === 0 &&
        p.buyQuantity > 0 &&
        p.netPnl !== null &&
        source.orders
          .filter((o) => o.positionId === p.id)
          .every((o) => contains(o.submittedAt) && paperTerminal(o)),
    ),
    "OPERATING_ALLOCATION_UNCLOSED_OR_CROSS_PERIOD",
  );
  const costs = journal.obligations
    .filter((obligation) => contains(obligation.occurredAt))
    .sort((a, b) => compareIds(a.costEventId, b.costEventId));
  requireValue(
    costs.every((cost) => cost.availableAt <= period.finalizedAt),
    "OPERATING_ALLOCATION_COST_NOT_AVAILABLE",
  );
  // 예약에는 의무 귀속 예정기간이 없다. 이전부터 이월된 미해결 예약도
  // 이번 기간과 무관하다고 입증할 수 없으므로 확정 보고에서 보류한다.
  requireValue(
    journal.reservations.every(
      (reservation) =>
        reservation.occurredAt >= period.endExclusive ||
        reservation.state !== "RESERVED",
    ),
    "OPERATING_ALLOCATION_RESERVATION_UNRESOLVED",
  );
  const total = costs.reduce(
      (value, cost) => value + BigInt(cost.amountKrw),
      0n,
    ),
    count = BigInt(trades.length),
    quotient = count > 0n ? total / count : 0n,
    remainder = count > 0n ? total % count : 0n,
    allocations = trades
      .sort((a, b) => compareIds(a.id, b.id))
      .map((trade, index) => {
        const amount = quotient + (BigInt(index) < remainder ? 1n : 0n);
        return {
          tradeId: trade.id,
          entryIntentId: trade.intentId,
          closedAt: trade.closedAt!,
          operatingCostKrw: amount.toString(),
          tradingNetPnlKrw: trade.netPnl!,
          netPnlKrw: subtractInteger(trade.netPnl!, amount),
        };
      });
  const body = {
    schemaVersion: "OPERATING_ALLOCATION_REPORT_V1" as const,
    purpose: "TEST_ONLY" as const,
    provenance: "SYNTHETIC_FIXTURE" as const,
    liveEnabled: false as const,
    actualLearningAllowed: false as const,
    accountMutationAllowed: false as const,
    corrections: input.corrections,
    runHash: journal.runHash,
    policyHash: journal.policyHash,
    journalSourceHash: journal.sourceHash,
    paperExportHash: source.exportHash,
    period,
    costEventIds: costs.map((cost) => cost.costEventId),
    totalOperatingKrw: total.toString(),
    completedTrades: trades.length,
    allocations,
    unallocatedKrw: count === 0n ? total.toString() : "0",
  };
  return { ...body, reportHash: hash(body) };
}
export type OperatingAllocationReport = ReturnType<
  typeof buildOperatingAllocation
>;

// 보고서 숫자를 신뢰하지 않고 원자료부터 재계산한다. AVAILABLE은 시험
// 근거의 시간 적격성만 뜻하며 기존 학습 변환/모델 승격 권한을 열지 않는다.
export function assessOperatingAllocationAvailability(
  raw: unknown,
  expectedReportHash: string,
  asOf: number,
) {
  const report = buildOperatingAllocation(raw);
  requireValue(
    /^[a-f0-9]{64}$/.test(expectedReportHash) &&
      expectedReportHash === report.reportHash,
    "OPERATING_ALLOCATION_REPORT_MISMATCH",
  );
  requireValue(
    paperTime.safeParse(asOf).success &&
      report.period.availableAt <= asOf &&
      report.period.finalizedAt <= asOf,
    "OPERATING_ALLOCATION_NOT_AVAILABLE",
  );
  return {
    status: "AVAILABLE_TEST_ONLY" as const,
    actualLearningAllowed: false as const,
    liveEnabled: false as const,
    report,
  };
}
