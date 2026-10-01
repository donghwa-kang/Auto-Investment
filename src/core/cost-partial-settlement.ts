import { z } from "zod";
import { Decimal } from "./math.js";
import { hash, policyHash } from "./policy.js";
import { costJournalConfigSchema } from "./cost-journal.js";
import { operatingKind } from "./cost-operating.js";
import type { OperatingConfig } from "./cost-operating.js";
import type { ReservationState } from "./cost-reservation.js";
import {
  buildClosedSettlementBasis,
  postCloseTargetKey,
  postCloseTargetLimit,
} from "./cost-post-close.js";
import type { PostCloseMetadata, PostCloseTarget } from "./cost-post-close.js";

export const partialSettlementEventLimit = 3 * postCloseTargetLimit;
export const partialSettlementContractHash = hash({
  contract: "PARTIAL_CLOSED_SETTLEMENT_FIXTURE_V1",
  policyHash,
  base: "D8_ATOMIC_OPERATING_FINALIZATION_V1",
  evidence: "PINNED_FIXTURE_LIST_STABLE_SOURCE_PAYMENT_LINE_V1",
  capacity: "TWO_NONFINAL_PARTS_PLUS_ONE_FINAL_PER_TARGET",
  precision: "60_INTEGER_40_FRACTION_LOCAL_128",
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
const scopeSchema = costJournalConfigSchema.shape.sourceScope;
const Exact = Decimal.clone({ precision: 128 });
const exact = (value: string) => new Exact(amount.parse(value));
const canonical = (value: Decimal.Value) => {
  const n = new Exact(value);
  if (!n.isFinite() || n.lt(0) || n.e > 59 || n.decimalPlaces() > 40)
    throw Error("PARTIAL_AMOUNT_BOUNDS");
  return amount.parse(n.toFixed());
};
const targetRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("OPERATING"), obligationId: opId }),
  z.strictObject({ kind: z.literal("FILL"), runId: id, fillId: id }),
]);
const action = z.enum(["SETTLE_PARTIAL_TARGET", "CONFIRM_ZERO_TARGET"]);
const evidenceFields = {
  kind: action,
  target: targetRef,
  receivable: amount,
  payable: amount,
  sourceEventKey: sha,
  sourceHash: sha,
  occurredAt: time,
};
export const partialEvidenceSchema = z.strictObject({
  ...evidenceFields,
  paymentId: id,
  lineId: id,
});
export type PartialEvidence = z.infer<typeof partialEvidenceSchema>;
export const partialSettlementOptionsSchema = z.strictObject({
  contractHash: z.literal(partialSettlementContractHash),
  followupEndExclusive: time,
  evidenceHash: sha,
  evidence: z.array(partialEvidenceSchema).max(partialSettlementEventLimit),
});
export type PartialSettlementOptions = z.infer<
  typeof partialSettlementOptionsSchema
>;
export const partialSettlementCommandSchema = z.strictObject({
  ...evidenceFields,
  contractHash: z.literal(partialSettlementContractHash),
  purpose: z.literal("TEST_ONLY"),
  provenance: z.literal("SYNTHETIC_FIXTURE"),
  runHash: sha,
  sourceScope: scopeSchema,
  currency: z.literal("KRW"),
  closeId: id,
  checkpointHash: sha,
  targetKey: sha,
  originalHash: sha,
  businessEventId: id,
  availableAt: time,
  receivedAt: time,
  postedAt: time,
});
export type PartialSettlementCommand = z.infer<
  typeof partialSettlementCommandSchema
>;
export function isPartialSettlementCommand(c: {
  kind: string;
}): c is PartialSettlementCommand {
  return c.kind === "SETTLE_PARTIAL_TARGET" || c.kind === "CONFIRM_ZERO_TARGET";
}
export function partialSourceEventKey(
  scope: z.infer<typeof scopeSchema>,
  paymentId: string,
  lineId: string,
) {
  return hash({
    contract: "STABLE_SOURCE_PAYMENT_LINE_V1",
    sourceScope: scopeSchema.parse(scope),
    paymentId: id.parse(paymentId),
    lineId: id.parse(lineId),
  });
}
export function partialTargetReference(
  t: PostCloseTarget,
): z.infer<typeof targetRef> {
  return t.kind === "PAY_CLOSED_OBLIGATION"
    ? { kind: "OPERATING", obligationId: t.target.obligationId }
    : { kind: "FILL", runId: t.target.runId, fillId: t.target.fillId };
}
function evidenceIdentity(
  e: z.infer<typeof partialEvidenceSchema> | PartialSettlementCommand,
) {
  return hash({
    kind: e.kind,
    target: e.target,
    receivable: canonical(e.receivable),
    payable: canonical(e.payable),
    sourceEventKey: e.sourceEventKey,
    sourceHash: e.sourceHash,
    occurredAt: e.occurredAt,
  });
}
function validateAmounts(
  e: Pick<PartialEvidence, "kind" | "target" | "receivable" | "payable">,
) {
  if (e.target.kind === "OPERATING") {
    integer.parse(e.payable);
    if (!exact(e.receivable).eq(0)) throw Error("PARTIAL_OPERATING_RECEIVABLE");
  }
  const zero = exact(e.receivable).plus(exact(e.payable)).eq(0);
  if (zero !== (e.kind === "CONFIRM_ZERO_TARGET"))
    throw Error("PARTIAL_ZERO_KIND_MISMATCH");
}
export function partialSettlementIdentity(raw: PartialSettlementCommand) {
  const parsed = partialSettlementCommandSchema.parse(raw);
  // Validate target-specific formats before numeric normalization, including retries.
  validateAmounts(parsed);
  const { businessEventId, availableAt, receivedAt, postedAt, ...business } =
    parsed;
  void businessEventId;
  void availableAt;
  void receivedAt;
  void postedAt;
  return hash({
    ...business,
    receivable: canonical(business.receivable),
    payable: canonical(business.payable),
  });
}
export interface PartialTargetProgress {
  targetKey: string;
  originalReceivable: string;
  originalPayable: string;
  settledReceivable: string;
  settledPayable: string;
  remainingReceivable: string;
  remainingPayable: string;
  partialCount: number;
  lastAppliedRevision: number | null;
  status: "OPEN" | "PARTIAL" | "SETTLED";
}
export interface PartialSettlementMetadata {
  options: PartialSettlementOptions;
  configHash: string;
  sourceScope: PostCloseMetadata["sourceScope"];
  basis: PostCloseMetadata["basis"];
  events: { command: PartialSettlementCommand; appliedRevision: number }[];
  progress: PartialTargetProgress[];
  currentOperating: PostCloseMetadata["currentOperating"];
}
export function initializePartialSettlement(
  s: ReservationState,
  c: OperatingConfig,
) {
  const options = partialSettlementOptionsSchema.parse(c.partialSettlement);
  if (
    c.kind !== operatingKind ||
    !c.finalization ||
    !s.finalization ||
    "postClose" in c ||
    s.postClose ||
    options.followupEndExclusive <= c.operating.periodEnd
  )
    throw Error("PARTIAL_EXCLUSIVE_D8_REQUIRED");
  if (options.evidenceHash !== hash(options.evidence))
    throw Error("PARTIAL_EVIDENCE_HASH");
  const keys = new Set<string>();
  for (const e of options.evidence) {
    validateAmounts(e);
    if (
      e.sourceEventKey !==
        partialSourceEventKey(c.sourceScope, e.paymentId, e.lineId) ||
      keys.has(e.sourceEventKey) ||
      e.occurredAt < c.operating.periodEnd ||
      e.occurredAt >= options.followupEndExclusive
    )
      throw Error("PARTIAL_EVIDENCE_INVALID");
    keys.add(e.sourceEventKey);
  }
  s.partialSettlement = {
    options,
    configHash: hash(c),
    sourceScope: structuredClone(c.sourceScope),
    basis: null,
    events: [],
    progress: [],
    currentOperating: null,
  };
}
function required(s: ReservationState) {
  if (
    s.kind !== operatingKind ||
    !s.partialSettlement ||
    s.postClose ||
    !s.finalization ||
    !s.handoff ||
    s.partialSettlement.options.contractHash !== partialSettlementContractHash
  )
    throw Error("PARTIAL_EXPLICIT_CONTRACT_REQUIRED");
  return s.partialSettlement;
}
export function capturePartialSettlementBasis(s: ReservationState) {
  const m = required(s),
    cp = s.finalization!.checkpoint;
  if (!cp || m.basis || cp.appliedAt >= m.options.followupEndExclusive)
    throw Error("PARTIAL_BASIS_OR_WINDOW");
  m.basis = buildClosedSettlementBasis(s, m.sourceScope);
  projectPartialSettlement(s);
}
function validateScope(
  m: PartialSettlementMetadata,
  e: PartialSettlementCommand,
) {
  const b = m.basis;
  if (
    !b ||
    e.runHash !== m.configHash ||
    hash(e.sourceScope) !== hash(m.sourceScope) ||
    e.closeId !== b.closeId ||
    e.checkpointHash !== b.checkpointHash
  )
    throw Error("PARTIAL_SCOPE_MISMATCH");
}
export function duplicatePartialSettlement(
  s: ReservationState,
  raw: PartialSettlementCommand,
) {
  const m = required(s),
    e = partialSettlementCommandSchema.parse(raw);
  validateScope(m, e);
  const matches = m.events.filter(
    ({ command: old }) =>
      old.businessEventId === e.businessEventId ||
      old.sourceEventKey === e.sourceEventKey,
  );
  if (!matches.length) return null;
  if (
    matches.length !== 1 ||
    partialSettlementIdentity(matches[0]!.command) !==
      partialSettlementIdentity(e)
  )
    throw Error("PARTIAL_BUSINESS_OR_SOURCE_CONFLICT");
  return matches[0]!.command;
}
// Detached projector only. Public Store reads verify the entire history first.
export function projectPartialSettlement(s: ReservationState) {
  const m = required(s),
    b = m.basis;
  if (!b || hash(s.finalization!.checkpoint) !== b.checkpointHash)
    throw Error("PARTIAL_CHECKPOINT_MISMATCH");
  if (
    b.targets.length > postCloseTargetLimit ||
    m.events.length > 3 * b.targets.length
  )
    throw Error("PARTIAL_EVENT_LIMIT");
  const targets = new Map(b.targets.map((t) => [postCloseTargetKey(t), t]));
  if (targets.size !== b.targets.length)
    throw Error("PARTIAL_TARGET_DUPLICATE");
  const progress = b.targets.map((t): PartialTargetProgress => {
    const r = t.kind === "PAY_CLOSED_OBLIGATION" ? "0" : t.target.receivable;
    const p =
      t.kind === "PAY_CLOSED_OBLIGATION"
        ? t.target.amountKrw
        : t.target.payable;
    return {
      targetKey: postCloseTargetKey(t),
      originalReceivable: canonical(r),
      originalPayable: canonical(p),
      settledReceivable: "0",
      settledPayable: "0",
      remainingReceivable: canonical(r),
      remainingPayable: canonical(p),
      partialCount: 0,
      lastAppliedRevision: null,
      status: "OPEN",
    };
  });
  const byKey = new Map(progress.map((p) => [p.targetKey, p]));
  const evidence = new Map(
    m.options.evidence.map((e) => [e.sourceEventKey, e]),
  );
  const business = new Set<string>(),
    consumed = new Set<string>();
  const base = b.accounts.KRW;
  let cash = exact(base.cash),
    paid = new Exact(0),
    clock = s.finalization!.checkpoint!.appliedAt,
    revision = b.revision;
  const totalR = progress.reduce(
    (n, p) => n.plus(exact(p.originalReceivable)),
    new Exact(0),
  );
  const totalP = progress.reduce(
    (n, p) => n.plus(exact(p.originalPayable)),
    new Exact(0),
  );
  if (
    !totalR.eq(base.receivable) ||
    !totalP.eq(base.payable) ||
    !exact(base.reservedCash).eq(0) ||
    !cash.minus(totalP).eq(base.availableCash)
  )
    throw Error("PARTIAL_BASIS_ACCOUNTS");
  let r = totalR,
    p = totalP;
  for (const item of m.events) {
    const e = partialSettlementCommandSchema.parse(item.command),
      row = byKey.get(e.targetKey),
      original = targets.get(e.targetKey),
      proof = evidence.get(e.sourceEventKey);
    validateScope(m, e);
    validateAmounts(e);
    if (!proof || evidenceIdentity(e) !== evidenceIdentity(proof))
      throw Error("PARTIAL_EVIDENCE_MISMATCH");
    if (
      !row ||
      !original ||
      hash(e.target) !== hash(partialTargetReference(original)) ||
      e.originalHash !== original.target.originalHash
    )
      throw Error("PARTIAL_TARGET_MISMATCH");
    if (business.has(e.businessEventId) || consumed.has(e.sourceEventKey))
      throw Error("PARTIAL_DUPLICATE_EVENT");
    business.add(e.businessEventId);
    consumed.add(e.sourceEventKey);
    if (
      e.occurredAt < s.finalization!.checkpoint!.appliedAt ||
      e.availableAt < e.occurredAt ||
      e.receivedAt < e.availableAt ||
      e.postedAt < e.receivedAt ||
      e.postedAt < clock ||
      e.postedAt >= m.options.followupEndExclusive ||
      !Number.isSafeInteger(item.appliedRevision) ||
      item.appliedRevision <= revision
    )
      throw Error("PARTIAL_TIME_OR_REVISION");
    clock = e.postedAt;
    revision = item.appliedRevision;
    const dr = exact(e.receivable),
      dp = exact(e.payable);
    if (
      row.status === "SETTLED" ||
      dr.gt(row.remainingReceivable) ||
      dp.gt(row.remainingPayable)
    )
      throw Error("PARTIAL_REMAINDER_EXCEEDED");
    if (
      e.kind === "CONFIRM_ZERO_TARGET" &&
      (!exact(row.originalReceivable).eq(0) ||
        !exact(row.originalPayable).eq(0))
    )
      throw Error("PARTIAL_NONZERO_TARGET");
    const rr = exact(row.remainingReceivable).minus(dr),
      rp = exact(row.remainingPayable).minus(dp),
      complete = rr.eq(0) && rp.eq(0);
    if (!complete && row.partialCount >= 2)
      throw Error("PARTIAL_TERMINATION_SLOT_RESERVED");
    if (!complete) row.partialCount++;
    row.remainingReceivable = canonical(rr);
    row.remainingPayable = canonical(rp);
    row.settledReceivable = canonical(exact(row.settledReceivable).plus(dr));
    row.settledPayable = canonical(exact(row.settledPayable).plus(dp));
    row.status = complete ? "SETTLED" : "PARTIAL";
    row.lastAppliedRevision = item.appliedRevision;
    cash = cash.plus(dr).minus(dp);
    r = r.minus(dr);
    p = p.minus(dp);
    if (original.kind === "PAY_CLOSED_OBLIGATION") paid = paid.plus(dp);
    for (const n of [cash, r, p, cash.minus(p)]) canonical(n);
  }
  if (
    !cash.plus(r).minus(p).eq(exact(base.cash).plus(totalR).minus(totalP)) ||
    cash.lt(0) ||
    cash.minus(p).lt(0)
  )
    throw Error("PARTIAL_ACCOUNT_MISMATCH");
  m.progress = progress;
  m.currentOperating = {
    incurredKrw: b.operating.incurredKrw,
    paidKrw: canonical(exact(b.operating.paidKrw).plus(paid)),
    payableKrw: canonical(exact(b.operating.payableKrw).minus(paid)),
  };
  s.handoff!.accounts = {
    KRW: {
      ...base,
      cash: canonical(cash),
      receivable: canonical(r),
      payable: canonical(p),
      availableCash: canonical(cash.minus(p)),
    },
    USD: structuredClone(b.accounts.USD),
  };
}
export function applyPartialSettlement(
  previous: ReservationState,
  raw: unknown,
  epoch: number,
): ReservationState {
  const e = partialSettlementCommandSchema.parse(raw),
    s = structuredClone(previous),
    m = required(s);
  z.number().int().safe().min(previous.epoch).parse(epoch);
  if (duplicatePartialSettlement(s, e))
    throw Error("PARTIAL_DUPLICATE_NOT_NEW_EVENT");
  if (e.postedAt < s.seed.clock) throw Error("PARTIAL_TIME_REWIND");
  m.events.push({ command: e, appliedRevision: s.revision + 1 });
  projectPartialSettlement(s);
  s.revision++;
  s.epoch = epoch;
  s.seed.epoch = epoch;
  s.seed.clock = e.postedAt;
  s.book.seedHash = hash(s.seed);
  return s;
}
export function partialSettlementReport(
  verified: ReservationState,
  asOf: number,
) {
  time.parse(asOf);
  const s = structuredClone(verified),
    m = required(s);
  if (!m.basis || asOf < s.seed.clock)
    throw Error("PARTIAL_REPORT_TIME_OR_BASIS");
  projectPartialSettlement(s);
  if (hash(s) !== hash(verified)) throw Error("PARTIAL_REPORT_CACHE_MISMATCH");
  return {
    contractHash: partialSettlementContractHash,
    configHash: m.configHash,
    stateHash: hash(s),
    asOf,
    checkpoint: s.finalization!.checkpoint,
    accounts: s.handoff!.accounts,
    operating: m.currentOperating,
    targets: m.basis.targets.map((target, i) => ({
      ...target,
      ...m.progress[i]!,
      dueAt: null,
    })),
    unresolvedCount: m.progress.filter((t) => t.status !== "SETTLED").length,
    observationEnded: asOf >= m.options.followupEndExclusive,
    holds: s.handoff!.admissionHolds,
    status: "HOLD" as const,
    orderSubmissionAllowed: false as const,
    learningAllowed: false as const,
    liveEnabled: false as const,
  };
}
