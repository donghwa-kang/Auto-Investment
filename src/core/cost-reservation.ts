import { z } from "zod";
import { hash, policy, policyHash } from "./policy.js";
import { d, ceil } from "./math.js";
import { fxFor } from "./ledger.js";
import { riskKeys } from "./calendar.js";
import {
  costProfileSchema,
  positiveCostAmountSchema,
} from "./transaction-cost.js";
import {
  costSizingRequestSchema,
  evaluateCostSizing,
} from "./cost-aware-sizing.js";
import type { CostCandidate } from "./cost-aware-sizing.js";
import { estimateFeeBound } from "./cost-kernel.js";
import {
  buildCostExposure,
  costRiskBookSchema,
  withLocalCostReservations,
} from "./cost-risk-context.js";
import type {
  CostRiskBook,
  LocalCostReservation,
} from "./cost-risk-context.js";
import type { State } from "./types.js";
import type { HandoffMetadata } from "./cost-handoff.js";
import type { ClosedCostOutcome } from "./cost-outcome.js";
import { operatingKind, operatingView } from "./cost-operating.js";
import type { OperatingMetadata } from "./cost-operating.js";
import type { FinalizationMetadata } from "./cost-finalization.js";
import type { PostCloseMetadata } from "./cost-post-close.js";
import type { PartialSettlementMetadata } from "./cost-partial-settlement.js";
import type { CostLoopState } from "./cost-loop-schema.js";
import {
  admissionHistorySchema,
  assessAdmissionHistory,
} from "./cost-history-admission.js";
import type { OperatingCostBinding } from "./operating-cost.js";

export const reservationKind = "SYNTHETIC_LOCAL_COST_RESERVATIONS_V1";
export const handoffKind = "SYNTHETIC_COST_HANDOFF_V2";
export const outcomeKind = "SYNTHETIC_COST_OUTCOMES_V3";
const id = costRiskBookSchema.shape.sources.element.shape.config.shape.runId;
const time = costRiskBookSchema.shape.initialAt;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const localProposalSchema = z
  .object({
    reservationId: id,
    profile: costProfileSchema,
    request: costSizingRequestSchema,
    operatingHistory: admissionHistorySchema.optional(),
  })
  .strict();
export const reservationCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("RESERVE"),
      proposal: localProposalSchema,
      basisHash: sha,
    })
    .strict(),
  z.object({ kind: z.literal("RELEASE_LOCAL"), reservationId: id }).strict(),
  z
    .object({
      kind: z.literal("OBSERVE"),
      at: time,
      fx: positiveCostAmountSchema,
      fxAt: time,
      accountAt: time,
      observations: z
        .array(
          z
            .object({
              runId: id,
              observation:
                costRiskBookSchema.shape.sources.element.shape.observation,
            })
            .strict(),
        )
        .max(10),
    })
    .strict(),
]);
export type ReservationCommand = z.infer<typeof reservationCommandSchema>;
export interface ReservationConfig {
  kind: typeof reservationKind;
  runId: string;
  seed: State;
  book: CostRiskBook;
}
export interface LocalApproval {
  operatingBinding?: OperatingCostBinding;
  id: string;
  status: "RESERVED_LOCAL" | "RELEASED_LOCAL" | "TRANSFERRED_SYNTHETIC";
  issuedAt: number;
  issuedEpoch: number;
  issuedRevision: number;
  releasedAt: number | null;
  proposal: z.infer<typeof localProposalSchema>;
  candidate: CostCandidate;
  basisHash: string;
  reservation: LocalCostReservation;
}
export interface ReservationState {
  kind:
    | typeof reservationKind
    | typeof handoffKind
    | typeof outcomeKind
    | typeof operatingKind;
  revision: number;
  epoch: number;
  seed: State;
  book: CostRiskBook;
  approvals: LocalApproval[];
  orderSubmissionAllowed: false;
  learningAllowed: false;
  liveEnabled: false;
  handoff?: HandoffMetadata;
  outcomes?: ClosedCostOutcome[];
  operating?: OperatingMetadata;
  finalization?: FinalizationMetadata;
  postClose?: PostCloseMetadata;
  partialSettlement?: PartialSettlementMetadata;
  loop?: CostLoopState;
}
export function reservationExposure(s: ReservationState, epoch = s.epoch) {
  // The pre-close book does not include D9 cash movements. Never expose it
  // as a current trading context, even if older time guards also hold it.
  if (s.postClose?.basis || s.partialSettlement?.basis)
    return {
      status: "HOLD" as const,
      reasons: ["POST_CLOSE_REPORT_REQUIRED"],
      orderSubmissionAllowed: false as const,
      learningAllowed: false as const,
      liveEnabled: false as const,
    };
  const seed = structuredClone(s.seed);
  seed.epoch = epoch;
  const book = structuredClone(s.book);
  book.seedHash = hash(seed);
  const built = buildCostExposure(
    seed,
    book,
    s.kind === operatingKind ? operatingView(s) : undefined,
  );
  if (built.status !== "OK") return built;
  if (
    s.approvals.some(
      (a) =>
        a.status === "RESERVED_LOCAL" &&
        (seed.clock >= a.proposal.profile.effectiveTo ||
          seed.clock < a.proposal.profile.effectiveFrom),
    )
  )
    return {
      status: "HOLD" as const,
      reasons: ["LOCAL_RESERVED_COST_EVIDENCE_EXPIRED"],
      orderSubmissionAllowed: false as const,
      learningAllowed: false as const,
      liveEnabled: false as const,
    };
  const context = withLocalCostReservations(
    built.context,
    s.approvals
      .filter((a) => a.status === "RESERVED_LOCAL")
      .map((a) => a.reservation),
    s.kind === operatingKind,
  );
  return { status: "OK" as const, context };
}
export function initialReservations(
  raw: ReservationConfig,
  epoch: number,
): ReservationState {
  if (raw.kind !== reservationKind) throw Error("INVALID_RESERVATION_KIND");
  if ("historyAdmission" in raw)
    throw Error("HISTORY_ADMISSION_OPT_IN_REQUIRED");
  id.parse(raw.runId);
  z.number().int().safe().min(1).parse(epoch);
  const seed = structuredClone(raw.seed),
    book = costRiskBookSchema.parse(raw.book);
  const check = buildCostExposure(seed, book);
  if (check.status !== "OK") throw Error(check.reasons.join(","));
  seed.epoch = epoch;
  book.seedHash = hash(seed);
  const state: ReservationState = {
    kind: reservationKind,
    revision: 0,
    epoch,
    seed,
    book,
    approvals: [],
    orderSubmissionAllowed: false,
    learningAllowed: false,
    liveEnabled: false,
  };
  preserveMarks(state);
  return state;
}
function preserveMarks(s: ReservationState) {
  const c =
    s.kind === operatingKind
      ? reservationExposure(s)
      : buildCostExposure(s.seed, s.book);
  if (c.status !== "OK") return;
  // Wallets remain the immutable opening balance. Only observed policy latches
  // are persisted; C1's State-shaped accounting projection is never stored.
  s.seed.ledger.highNav = c.context.state.ledger.highNav;
  s.seed.ledger.drawdownReduced = c.context.state.ledger.drawdownReduced;
  s.seed.ledger.halts = [...c.context.state.ledger.halts];
  s.seed.status = c.context.state.status;
  s.book.seedHash = hash(s.seed);
}
export function evaluateLocalProposal(
  s: ReservationState,
  raw: unknown,
  epoch = s.epoch,
  project = reservationExposure,
) {
  const proposal = localProposalSchema.parse(raw);
  if (!s.operating?.historyAdmission && "operatingHistory" in proposal)
    throw Error("HISTORY_ADMISSION_OPT_IN_REQUIRED");
  const built = project(s, epoch);
  if (built.status !== "OK")
    throw Error(`LOCAL_ADMISSION_HOLD:${built.reasons.join(",")}`);
  const c = built.context;
  const history = s.operating?.historyAdmission
    ? assessAdmissionHistory(c.state, proposal.operatingHistory)
    : undefined;
  const sizing = evaluateCostSizing(
    c.state,
    proposal.profile,
    proposal.request,
    history?.history,
    c,
  );
  if (sizing.status !== "RESEARCH_CANDIDATE" || !sizing.candidate)
    throw Error(`LOCAL_ADMISSION_HOLD:${sizing.reasons.join(",")}`);
  return {
    proposal,
    ...(history ? { operatingBinding: history.binding } : {}),
    candidate: sizing.candidate,
    basisHash: hash({
      contract: s.kind,
      policyHash,
      sourceHash: c.sourceHash,
      stateHash: c.stateHash,
      revision: s.revision,
      epoch,
      proposal,
      sizing,
    }),
  };
}
export function applyReservationCommand(
  previous: ReservationState,
  raw: unknown,
  epoch: number,
  options: {
    project?: typeof reservationExposure;
    maximumCommands?: number;
  } = {},
): ReservationState {
  if (previous.finalization?.checkpoint)
    throw Error("FINALIZED_FINANCIAL_MUTATION_BLOCKED");
  z.number().int().safe().min(previous.epoch).parse(epoch);
  const command = reservationCommandSchema.parse(raw),
    s = structuredClone(previous);
  const maximumCommands = options.maximumCommands ?? 100;
  const project = options.project ?? reservationExposure;
  if (s.revision >= maximumCommands) throw Error("LOCAL_COMMAND_LIMIT");
  // Bounded replay must not strand never-sent money reservations at the cap.
  // Each active reservation retains one command slot for explicit release.
  const futureActive =
    s.approvals.filter((a) => a.status === "RESERVED_LOCAL").length +
    (command.kind === "RESERVE" ? 1 : 0);
  if (
    command.kind !== "RELEASE_LOCAL" &&
    s.revision + 1 + futureActive > maximumCommands
  )
    throw Error("LOCAL_RELEASE_CAPACITY");
  s.epoch = epoch;
  s.seed.epoch = epoch;
  s.book.seedHash = hash(s.seed);
  if (command.kind === "RESERVE") {
    if (s.approvals.some((a) => a.id === command.proposal.reservationId))
      throw Error("LOCAL_RESERVATION_ID_REUSED");
    const checked = evaluateLocalProposal(s, command.proposal, epoch, project);
    if (checked.basisHash !== command.basisHash)
      throw Error("LOCAL_REAPPROVAL_REQUIRED");
    const p = checked.proposal.profile,
      r = checked.proposal.request,
      c = checked.candidate;
    const adverse = d(r.tickSize).mul(r.adverseExitTicks);
    const riskNative = d(c.entry)
      .minus(c.stop)
      .mul(c.quantity)
      .plus(estimateFeeBound(p, "BUY", c.quantity, c.entry, s.seed.clock))
      .plus(
        estimateFeeBound(
          p,
          "SELL",
          c.quantity,
          d(c.stop).minus(adverse).toString(),
          s.seed.clock,
          policy.execution.emergency_exit.maximum_replacements + 1,
        ),
      )
      .plus(adverse.mul(c.quantity))
      .toString();
    if (
      ceil(d(riskNative).mul(fxFor(s.seed.ledger, p.scope.currency))) !==
        c.riskKrw ||
      !c.reservationCashNative
    )
      throw Error("LOCAL_RESERVATION_COST_MISMATCH");
    s.approvals.push({
      id: checked.proposal.reservationId,
      status: "RESERVED_LOCAL",
      issuedAt: s.seed.clock,
      issuedEpoch: epoch,
      issuedRevision: s.revision + 1,
      releasedAt: null,
      proposal: checked.proposal,
      ...(checked.operatingBinding
        ? { operatingBinding: checked.operatingBinding }
        : {}),
      candidate: c,
      basisHash: checked.basisHash,
      reservation: {
        id: checked.proposal.reservationId,
        symbol: r.symbol,
        currency: p.scope.currency,
        quantity: c.quantity,
        entry: c.entry,
        cashNative: c.reservationCashNative,
        riskNative,
      },
    });
    s.seed.ledger.intents++;
    s.book.seedHash = hash(s.seed);
    const next = project(s);
    if (next.status !== "OK") throw Error("LOCAL_RESERVATION_PROJECTION_HOLD");
  } else if (command.kind === "RELEASE_LOCAL") {
    const a = s.approvals.find((a) => a.id === command.reservationId);
    if (!a || a.status !== "RESERVED_LOCAL")
      throw Error("LOCAL_RESERVATION_NOT_ACTIVE");
    a.status = "RELEASED_LOCAL";
    a.releasedAt = s.seed.clock;
    // This path has never sent an order; no broker cancellation is inferred.
    // Intent counts and historical records deliberately remain unchanged.
  } else {
    if (
      command.at < s.seed.clock ||
      hash(riskKeys(command.at)) !== hash(riskKeys(s.seed.clock))
    )
      throw Error("LOCAL_OBSERVATION_TIME_OR_PERIOD");
    if (
      command.fxAt < s.seed.ledger.fxAt ||
      command.accountAt < s.seed.ledger.accountAt ||
      command.fxAt > command.at ||
      command.accountAt > command.at
    )
      throw Error("LOCAL_OBSERVATION_SOURCE_TIME");
    if (
      command.observations.length !== s.book.sources.length ||
      new Set(command.observations.map((o) => o.runId)).size !==
        command.observations.length
    )
      throw Error("LOCAL_OBSERVATION_COMPLETENESS");
    for (const item of command.observations) {
      const source = s.book.sources.find((v) => v.config.runId === item.runId);
      if (
        !source ||
        item.observation.at < source.observation.at ||
        item.observation.at > command.at
      )
        throw Error("LOCAL_OBSERVATION_SOURCE_TIME");
      source.observation = item.observation;
    }
    s.seed.clock = command.at;
    s.seed.ledger.fx = command.fx;
    s.seed.ledger.fxAt = command.fxAt;
    s.seed.ledger.accountAt = command.accountAt;
    s.book.seedHash = hash(s.seed);
    preserveMarks(s);
    // Stale/expired evidence blocks future approvals, never erases old reserves.
    // Inputs cannot change opening capital, events, counters or clear halts.
  }
  s.revision++;
  return s;
}
