import { z } from "zod";
import { Decimal } from "./math.js";
import { hash, policy, policyHash } from "./policy.js";
import { operatingKind, operatingView } from "./cost-operating.js";
import type { OperatingConfig } from "./cost-operating.js";
import type { ReservationState } from "./cost-reservation.js";
import { replayCostJournal } from "./cost-journal.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().safe().nonnegative();
export const operatingCloseRequestSchema = z.strictObject({
  schemaVersion: z.literal("OPERATING_CLOSE_FIXTURE_REQUEST_V1"),
  purpose: z.literal("TEST_ONLY"),
  provenance: z.literal("SYNTHETIC_FIXTURE"),
  manifest: z.strictObject({
    configHash: sha,
    stateHash: sha,
    recordsHash: sha,
    recordCount: z.number().int().min(0).max(5300),
    periodStart: time,
    periodEnd: time,
    // An independently supplied fixture-author declaration, not a provider
    // completeness proof. A hash of a partial DB cannot establish completeness.
    coverage: z.enum(["FULL_PERIOD_FROM_EMPTY", "INCOMPLETE"]),
    finalizedAt: time,
    availableAt: time,
  }),
  asOf: time,
});
export type OperatingCloseRequest = z.infer<typeof operatingCloseRequestSchema>;

// Exact within the accepted 60 integer + 40 fractional digit bounds, including
// sums of at most ten trades and 100 integer costs. Never alter global Decimal.
const Exact = Decimal.clone({ precision: 128 });
const plainAmount = /^-?\d{1,60}(?:\.\d{1,40})?$/;
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const operatingCloseContractHash = hash({
  contract: "D7_READ_ONLY_OPERATING_CLOSE_V1",
  policyHash,
  allocation: "EQUAL_INTEGER_ASCII_RUN_ID_REMAINDER",
  losses: "CLOSED_AT_THEN_REVISION_ZERO_PRESERVES_STREAK",
  input: "V4_REPLAY_AND_TRUSTED_FULL_PERIOD_SYNTHETIC_MANIFEST",
  counterApplied: false,
});

// Internal projector: only CostReservationStore.operatingClose verifies the
// full command/receipt/audit/index/cache snapshot. Do not accept client states
// here or expose this function as an independently authenticated verifier.
export function projectOperatingClose(
  config: OperatingConfig,
  state: ReservationState,
  records: readonly unknown[],
  raw: unknown,
) {
  const parsed = operatingCloseRequestSchema.safeParse(raw);
  if (!parsed.success) throw Error("OPERATING_CLOSE_REQUEST_INVALID");
  if (
    state.kind !== operatingKind ||
    !state.operating ||
    !state.handoff ||
    !state.outcomes
  )
    throw Error("OPERATING_CLOSE_V4_REQUIRED");
  const input = parsed.data,
    m = input.manifest,
    cfg = config.operating,
    view = operatingView(state),
    configHash = hash(config),
    stateHash = hash(state),
    recordsHash = hash(records),
    reasons: string[] = [];
  const check = (ok: boolean, reason: string) => {
    if (!ok && !reasons.includes(reason)) reasons.push(reason);
  };
  const contains = (at: number) => at >= cfg.periodStart && at < cfg.periodEnd;
  check(
    m.configHash === configHash &&
      m.stateHash === stateHash &&
      m.recordsHash === recordsHash &&
      m.recordCount === records.length &&
      m.periodStart === cfg.periodStart &&
      m.periodEnd === cfg.periodEnd,
    "MANIFEST_SNAPSHOT_MISMATCH",
  );
  check(m.coverage === "FULL_PERIOD_FROM_EMPTY", "PERIOD_COVERAGE_INCOMPLETE");
  if (config.operatingLoop?.closeContract) {
    // A watchdog can advance without changing the financial clock. A close
    // must not precede an already recorded observation on the new contract.
    check(
      Math.max(
        state.loop?.lastTickAt ?? 0,
        state.loop?.watchdog?.lastPulseAt ?? 0,
      ) <= m.finalizedAt,
      "LOOP_CLOSE_EVIDENCE_BEFORE_OBSERVATION",
    );
  }
  check(
    cfg.periodEnd <= m.finalizedAt &&
      m.finalizedAt <= m.availableAt &&
      m.availableAt <= input.asOf &&
      state.seed.clock <= m.finalizedAt,
    "CLOSE_EVIDENCE_NOT_AVAILABLE",
  );
  check(state.operating.rejectedInputs.length === 0, "QUARANTINED_INPUT");
  check(
    !view.reservations.some((r) => r.state === "RESERVED") &&
      !state.approvals.some((a) => a.status === "RESERVED_LOCAL"),
    "UNRESOLVED_RESERVATION",
  );
  check(
    view.obligations.every(
      (c) => contains(c.occurredAt) && c.availableAt <= m.finalizedAt,
    ),
    "OPERATING_COST_OUTSIDE_PERIOD_OR_UNAVAILABLE",
  );
  const completed: string[] = [];
  for (const source of state.book.sources) {
    const v = replayCostJournal(source.config, source.events);
    check(
      source.events.every(
        (e) => contains(e.at) && (e.kind !== "FILL" || contains(e.occurredAt)),
      ),
      "TRADING_EVENT_OUTSIDE_PERIOD",
    );
    check(
      v.quantity === 0 &&
        v.orders.every((o) => ["FILLED", "CANCELLED"].includes(o.status)),
      "OPEN_POSITION_OR_ORDER",
    );
    if (v.postings.some((p) => p.side === "BUY"))
      completed.push(source.config.runId);
  }
  const outcomes = state.outcomes;
  check(
    hash([...completed].sort(compareIds)) ===
      hash(outcomes.map((o) => o.runId).sort(compareIds)) &&
      new Set(outcomes.map((o) => o.closedRevision)).size === outcomes.length &&
      outcomes.every(
        (o) =>
          o.currency === "KRW" &&
          o.netPnlKrw !== null &&
          plainAmount.test(o.netPnlKrw) &&
          contains(o.closedAt) &&
          !o.counterApplied &&
          o.lossStreakAfter === null,
      ) &&
      state.seed.ledger.lossStreak === config.seed.ledger.lossStreak,
    "CLOSED_OUTCOME_OR_COUNTER_MISMATCH",
  );
  const total = view.obligations.reduce((n, o) => n + BigInt(o.amountKrw), 0n),
    count = BigInt(outcomes.length),
    quotient = count ? total / count : 0n,
    remainder = count ? total % count : 0n;
  const allocations = reasons.length
    ? null
    : [...outcomes]
        .sort((a, b) => compareIds(a.runId, b.runId))
        .map((o, i) => {
          const amount = quotient + (BigInt(i) < remainder ? 1n : 0n);
          return {
            tradeId: o.runId,
            closedAt: o.closedAt,
            closedRevision: o.closedRevision,
            tradingNetPnlKrw: o.netPnlKrw!,
            operatingCostKrw: amount.toString(),
            finalNetPnlKrw: new Exact(o.netPnlKrw!)
              .minus(amount.toString())
              .toFixed(),
          };
        });
  let streak = config.seed.ledger.lossStreak;
  const haltAt = policy.risk.consecutive_loss_halt_count;
  let reviewHalt = streak >= haltAt;
  const lossProjection =
    allocations === null
      ? null
      : [...allocations]
          .sort(
            (a, b) =>
              a.closedAt - b.closedAt || a.closedRevision - b.closedRevision,
          )
          .map((a) => {
            const before = streak,
              pnl = new Exact(a.finalNetPnlKrw);
            if (pnl.isNegative()) streak++;
            else if (pnl.isPositive() && !pnl.isZero()) streak = 0;
            const thresholdReached = streak >= haltAt;
            reviewHalt ||= thresholdReached;
            return {
              tradeId: a.tradeId,
              lossStreakBefore: before,
              lossStreakAfter: streak,
              thresholdReached,
            };
          });
  const body = {
    schemaVersion: "OPERATING_CLOSE_FIXTURE_REPORT_V1" as const,
    status: reasons.length
      ? ("HOLD" as const)
      : ("VERIFIED_FIXTURE_PROJECTION" as const),
    purpose: "TEST_ONLY" as const,
    provenance: "SYNTHETIC_FIXTURE" as const,
    contractHash: operatingCloseContractHash,
    policyHash,
    configHash,
    stateHash,
    recordsHash,
    snapshotRevision: state.revision,
    manifest: m,
    asOf: input.asOf,
    reasons,
    totalOperatingKrw: total.toString(),
    allocations,
    unallocatedKrw:
      allocations === null ? null : count === 0n ? total.toString() : "0",
    periodNetPnlKrw:
      allocations === null
        ? null
        : outcomes
            .reduce((n, o) => n.plus(o.netPnlKrw!), new Exact(0))
            .minus(total.toString())
            .toFixed(),
    lossProjection,
    projectedLossStreak: allocations === null ? null : streak,
    projectedConsecutiveLossReviewHalt:
      allocations === null ? null : reviewHalt,
    observed: {
      accounts: state.handoff.accounts,
      operating: state.operating.effects,
      lossStreak: state.seed.ledger.lossStreak,
      admissionHolds: state.handoff.admissionHolds,
      halts: state.seed.ledger.halts,
      cooldowns: state.seed.ledger.cooldowns,
    },
    counterApplied: false as const,
    persistedFinalization: false as const,
    automaticResumeAllowed: false as const,
    accountMutationAllowed: false as const,
    learningAllowed: false as const,
    orderSubmissionAllowed: false as const,
    liveEnabled: false as const,
  };
  return structuredClone({ ...body, reportHash: hash(body) });
}
