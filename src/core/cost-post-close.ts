import { z } from "zod";
import { Decimal } from "./math.js";
import { hash, policyHash } from "./policy.js";
import { costJournalConfigSchema, replayCostJournal } from "./cost-journal.js";
import { operatingKind, operatingView } from "./cost-operating.js";
import type { OperatingConfig } from "./cost-operating.js";
import type { ReservationState } from "./cost-reservation.js";
import type { HandoffMetadata } from "./cost-handoff.js";

// No new trading budget: each target requires a pre-close command, bounded
// by the existing 5200 handoff + 100 operating command contract.
export const postCloseTargetLimit = 5300;
export const postCloseContractHash = hash({
  contract: "POST_CLOSE_SETTLEMENT_FIXTURE_V1",
  policyHash,
  base: "D8_ATOMIC_OPERATING_FINALIZATION_V1",
  scope: "NEW_SYNTHETIC_KRW_EXACT_FULL_TARGET_ONLY",
  precision: "60_INTEGER_40_FRACTION_5300_TARGETS_LOCAL_128",
  automaticResumeAllowed: false,
});
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = costJournalConfigSchema.shape.runId;
const opId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const time = z.number().int().safe().min(0).max(8_640_000_000_000_000);
const amount = z
  .string()
  .max(101)
  .regex(/^(0|[1-9]\d{0,59})(\.\d{1,40})?$/);
const integer = z
  .string()
  .max(30)
  .regex(/^(0|[1-9]\d*)$/);
// 100 significant digits + ceil(log10(5300)) < 128. Never mutate global math.
const Exact = Decimal.clone({ precision: 128 });
const exact = (value: string) => new Exact(amount.parse(value));
const canonical = (value: string) => {
  const v = new Exact(value);
  if (!v.isFinite() || v.lt(0) || v.e > 59 || v.decimalPlaces() > 40)
    throw Error("POST_CLOSE_AMOUNT_BOUNDS");
  return amount.parse(v.toFixed());
};
export const postCloseOptionsSchema = z.strictObject({
  contractHash: z.literal(postCloseContractHash),
  followupEndExclusive: time,
});
export type PostCloseOptions = z.infer<typeof postCloseOptionsSchema>;
const payTarget = z.strictObject({
  obligationId: opId,
  costEventId: opId,
  originalHash: sha,
  amountKrw: integer,
});
const fillTarget = z.strictObject({
  runId: id,
  fillId: id,
  postingKey: sha,
  identityHash: sha,
  originalHash: sha,
  receivable: amount,
  payable: amount,
});
const common = {
  contractHash: z.literal(postCloseContractHash),
  purpose: z.literal("TEST_ONLY"),
  provenance: z.literal("SYNTHETIC_FIXTURE"),
  runHash: sha,
  sourceScope: costJournalConfigSchema.shape.sourceScope,
  currency: z.literal("KRW"),
  closeId: id,
  checkpointHash: sha,
  businessEventId: id,
  sourceHash: sha,
  occurredAt: time,
  availableAt: time,
  receivedAt: time,
  postedAt: time,
};
export const postCloseCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("PAY_CLOSED_OBLIGATION"),
    target: payTarget,
  }),
  z.strictObject({
    ...common,
    kind: z.literal("SETTLE_CLOSED_FILL"),
    target: fillTarget,
  }),
]);
export type PostCloseCommand = z.infer<typeof postCloseCommandSchema>;
export type PostCloseTarget =
  | { kind: "PAY_CLOSED_OBLIGATION"; target: z.infer<typeof payTarget> }
  | { kind: "SETTLE_CLOSED_FILL"; target: z.infer<typeof fillTarget> };
export function isPostCloseCommand(command: {
  kind: string;
}): command is PostCloseCommand {
  return (
    command.kind === "PAY_CLOSED_OBLIGATION" ||
    command.kind === "SETTLE_CLOSED_FILL"
  );
}
export function postCloseTargetKey(item: PostCloseTarget) {
  return hash(
    item.kind === "PAY_CLOSED_OBLIGATION"
      ? { kind: item.kind, obligationId: item.target.obligationId }
      : {
          kind: item.kind,
          runId: item.target.runId,
          fillId: item.target.fillId,
        },
  );
}
export function postCloseIdentity(raw: PostCloseCommand) {
  const { availableAt, receivedAt, postedAt, ...business } =
    postCloseCommandSchema.parse(raw);
  // Delivery clocks are excluded; full request identity is stored separately.
  void availableAt;
  void receivedAt;
  void postedAt;
  return hash(business);
}
export interface PostCloseMetadata {
  options: PostCloseOptions;
  configHash: string;
  sourceScope: z.infer<typeof costJournalConfigSchema.shape.sourceScope>;
  basis: null | {
    closeId: string;
    checkpointHash: string;
    revision: number;
    accounts: HandoffMetadata["accounts"];
    operating: { incurredKrw: string; paidKrw: string; payableKrw: string };
    targets: PostCloseTarget[];
  };
  events: PostCloseCommand[];
  currentOperating: null | {
    incurredKrw: string;
    paidKrw: string;
    payableKrw: string;
  };
}
export function initializePostClose(s: ReservationState, c: OperatingConfig) {
  if (!("postClose" in c)) return;
  const options = postCloseOptionsSchema.parse(c.postClose);
  if (
    c.kind !== operatingKind ||
    !c.finalization ||
    !s.finalization ||
    options.followupEndExclusive <= c.operating.periodEnd
  )
    throw Error("POST_CLOSE_EXPLICIT_D8_REQUIRED");
  s.postClose = {
    options,
    configHash: hash(c),
    sourceScope: structuredClone(c.sourceScope),
    basis: null,
    events: [],
    currentOperating: null,
  };
}
function required(s: ReservationState) {
  if (s.kind !== operatingKind || !s.postClose || !s.finalization || !s.handoff)
    throw Error("POST_CLOSE_EXPLICIT_CONTRACT_REQUIRED");
  postCloseOptionsSchema.parse(s.postClose.options);
  return s.postClose;
}
export function capturePostCloseBasis(s: ReservationState) {
  const m = required(s),
    cp = s.finalization!.checkpoint;
  if (!cp || m.basis || cp.appliedAt >= m.options.followupEndExclusive)
    throw Error("POST_CLOSE_BASIS_OR_WINDOW");
  m.basis = buildClosedSettlementBasis(s, m.sourceScope);
  m.currentOperating = { ...m.basis.operating };
  projectPostClose(s);
}
// Shared immutable close-time extraction, not the D9 consumed-target projector.
export function buildClosedSettlementBasis(
  s: ReservationState,
  sourceScope: PostCloseMetadata["sourceScope"],
): NonNullable<PostCloseMetadata["basis"]> {
  const cp = s.finalization?.checkpoint;
  if (!cp || !s.handoff) throw Error("POST_CLOSE_REQUIRES_BASIS");
  const op = operatingView(s);
  const targets: PostCloseTarget[] = op.obligations
    .filter((o) => !o.paid)
    .map((o) => ({
      kind: "PAY_CLOSED_OBLIGATION",
      target: {
        obligationId: o.id,
        costEventId: o.costEventId,
        originalHash: hash(o),
        amountKrw: o.amountKrw,
      },
    }));
  for (const entry of s.book.sources) {
    const v = replayCostJournal(entry.config, entry.events);
    if (
      v.currency !== "KRW" ||
      hash(entry.config.sourceScope) !== hash(sourceScope) ||
      v.quantity !== 0 ||
      !new Exact(v.reservedCash).eq(0)
    )
      throw Error("POST_CLOSE_SOURCE_UNSUPPORTED");
    for (const p of v.postings.filter((p) => p.settledAt === null))
      targets.push({
        kind: "SETTLE_CLOSED_FILL",
        target: {
          runId: entry.config.runId,
          fillId: p.fill.fillId,
          postingKey: p.key,
          identityHash: p.identityHash,
          originalHash: hash(p),
          receivable: canonical(p.receivable),
          payable: canonical(p.payable),
        },
      });
  }
  if (
    targets.length > postCloseTargetLimit ||
    new Set(targets.map(postCloseTargetKey)).size !== targets.length
  )
    throw Error("POST_CLOSE_TARGET_LIMIT_OR_DUPLICATE");
  const accounts = structuredClone(s.handoff!.accounts);
  for (const a of Object.values(accounts)) {
    for (const value of Object.values(a)) canonical(value);
    if (!new Exact(a.reservedCash).eq(0))
      throw Error("POST_CLOSE_RESERVED_BALANCE");
  }
  return {
    closeId: cp.closeId,
    checkpointHash: hash(cp),
    revision: cp.appliedRevision,
    accounts,
    operating: {
      incurredKrw: op.incurredKrw,
      paidKrw: op.paidKrw,
      payableKrw: op.payableKrw,
    },
    targets,
  };
}
const amounts = (t: PostCloseTarget) =>
  t.kind === "PAY_CLOSED_OBLIGATION"
    ? { receivable: "0", payable: t.target.amountKrw }
    : t.target;
// Internal detached-state projector. The Store authenticates by full replay,
// not by trusting this cache, the basis hash, or a caller-provided success flag.
export function projectPostClose(s: ReservationState) {
  const m = required(s),
    b = m.basis;
  if (!b || hash(s.finalization!.checkpoint) !== b.checkpointHash)
    throw Error("POST_CLOSE_CHECKPOINT_MISMATCH");
  if (
    b.targets.length > postCloseTargetLimit ||
    m.events.length > b.targets.length
  )
    throw Error("POST_CLOSE_TARGET_LIMIT");
  const targets = new Map(b.targets.map((t) => [postCloseTargetKey(t), t]));
  if (targets.size !== b.targets.length)
    throw Error("POST_CLOSE_DUPLICATE_TARGET");
  let cash = exact(canonical(b.accounts.KRW.cash)),
    r = new Exact(0),
    p = new Exact(0),
    paid = new Exact(0);
  const consumed = new Set<string>();
  for (const e of m.events) {
    const key = postCloseTargetKey(e);
    if (consumed.has(key)) throw Error("POST_CLOSE_TARGET_ALREADY_SETTLED");
    const target = targets.get(key);
    if (!target || hash(target) !== hash({ kind: e.kind, target: e.target }))
      throw Error("POST_CLOSE_TARGET_MISMATCH");
    consumed.add(key);
    const a = amounts(target);
    cash = cash.plus(exact(a.receivable)).minus(exact(a.payable));
    if (e.kind === "PAY_CLOSED_OBLIGATION")
      paid = paid.plus(exact(e.target.amountKrw));
  }
  let originalR = new Exact(0),
    originalP = new Exact(0);
  for (const target of b.targets) {
    const a = amounts(target);
    originalR = originalR.plus(exact(a.receivable));
    originalP = originalP.plus(exact(a.payable));
    if (!consumed.has(postCloseTargetKey(target))) {
      r = r.plus(exact(a.receivable));
      p = p.plus(exact(a.payable));
    }
  }
  const base = b.accounts.KRW,
    available = cash.minus(p);
  if (
    !originalR.eq(base.receivable) ||
    !originalP.eq(base.payable) ||
    !new Exact(base.cash).minus(base.payable).eq(base.availableCash) ||
    !cash
      .plus(r)
      .minus(p)
      .eq(new Exact(base.cash).plus(base.receivable).minus(base.payable)) ||
    cash.lt(0) ||
    available.lt(0)
  )
    throw Error("POST_CLOSE_ACCOUNT_MISMATCH");
  const account = {
    ...base,
    cash: canonical(cash.toFixed()),
    receivable: canonical(r.toFixed()),
    payable: canonical(p.toFixed()),
    availableCash: canonical(available.toFixed()),
  };
  m.currentOperating = {
    incurredKrw: b.operating.incurredKrw,
    paidKrw: canonical(exact(b.operating.paidKrw).plus(paid).toFixed()),
    payableKrw: canonical(exact(b.operating.payableKrw).minus(paid).toFixed()),
  };
  s.handoff!.accounts = { KRW: account, USD: structuredClone(b.accounts.USD) };
}
export function duplicatePostClose(
  s: ReservationState,
  command: PostCloseCommand,
) {
  const m = required(s);
  const old = m.events.find(
    (e) => e.businessEventId === command.businessEventId,
  );
  if (!old) return false;
  if (postCloseIdentity(old) !== postCloseIdentity(command))
    throw Error("POST_CLOSE_BUSINESS_CONFLICT");
  return true;
}
export function applyPostClose(
  previous: ReservationState,
  raw: unknown,
  epoch: number,
): ReservationState {
  const e = postCloseCommandSchema.parse(raw),
    s = structuredClone(previous),
    m = required(s),
    b = m.basis;
  z.number().int().safe().min(previous.epoch).parse(epoch);
  if (!b || !s.finalization!.checkpoint)
    throw Error("POST_CLOSE_REQUIRES_BASIS");
  if (
    e.runHash !== m.configHash ||
    hash(e.sourceScope) !== hash(m.sourceScope) ||
    e.closeId !== b.closeId ||
    e.checkpointHash !== b.checkpointHash
  )
    throw Error("POST_CLOSE_SCOPE_MISMATCH");
  if (duplicatePostClose(s, e))
    throw Error("POST_CLOSE_DUPLICATE_NOT_NEW_EVENT");
  if (m.events.some((old) => postCloseTargetKey(old) === postCloseTargetKey(e)))
    throw Error("POST_CLOSE_TARGET_ALREADY_SETTLED");
  if (m.events.length >= b.targets.length)
    throw Error("POST_CLOSE_TARGET_LIMIT");
  if (
    e.occurredAt < s.finalization!.checkpoint.appliedAt ||
    e.availableAt < e.occurredAt ||
    e.receivedAt < e.availableAt ||
    e.postedAt < e.receivedAt ||
    e.postedAt < s.seed.clock ||
    e.postedAt >= m.options.followupEndExclusive
  )
    throw Error("POST_CLOSE_TIME_INVALID");
  m.events.push(e);
  projectPostClose(s);
  s.revision++;
  s.epoch = epoch;
  s.seed.epoch = epoch;
  s.seed.clock = e.postedAt;
  s.book.seedHash = hash(s.seed);
  return s;
}
export function postCloseReport(verified: ReservationState, asOf: number) {
  time.parse(asOf);
  const s = structuredClone(verified),
    m = required(s),
    b = m.basis;
  if (!b || asOf < s.seed.clock) throw Error("POST_CLOSE_REPORT_TIME_OR_BASIS");
  projectPostClose(s);
  if (hash(s) !== hash(verified))
    throw Error("POST_CLOSE_REPORT_CACHE_MISMATCH");
  const consumed = new Set(m.events.map(postCloseTargetKey));
  return {
    contractHash: postCloseContractHash,
    configHash: m.configHash,
    stateHash: hash(s),
    asOf,
    checkpoint: s.finalization!.checkpoint,
    accounts: s.handoff!.accounts,
    operating: m.currentOperating,
    targets: b.targets.map((t) => ({
      ...t,
      settled: consumed.has(postCloseTargetKey(t)),
      dueAt: null,
    })),
    unresolvedCount: b.targets.length - consumed.size,
    observationEnded: asOf >= m.options.followupEndExclusive,
    holds: s.handoff!.admissionHolds,
    status: "HOLD" as const,
    orderSubmissionAllowed: false as const,
    learningAllowed: false as const,
    liveEnabled: false as const,
  };
}
