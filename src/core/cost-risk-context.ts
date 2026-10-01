import { z } from "zod";
import { configSchema, hash, policy, policyHash } from "./policy.js";
import {
  costJournalConfigSchema,
  costJournalEventSchema,
  replayCostJournal,
} from "./cost-journal.js";
import {
  costAmountSchema,
  positiveCostAmountSchema,
} from "./transaction-cost.js";
import { estimateFeeBound } from "./cost-kernel.js";
import { d, ceil, max, sum } from "./math.js";
import { fxFor, mark } from "./ledger.js";
import { profile, remainingRiskForExposure } from "./risk.js";
import { riskKeys } from "./calendar.js";
import type { State, Position, Currency } from "./types.js";
import type { OperatingDeltaView } from "./operating-journal.js";

const time = costJournalConfigSchema.shape.horizonEnd;
const protection = z.enum([
  "REGISTERED_PENDING_VERIFY",
  "WATCHING",
  "TRIGGER_SUSPECTED",
  "TRIGGERED",
  "CHILD_PENDING",
  "EXIT_WORKING",
  "EXIT_PARTIAL",
  "CANCEL_UNKNOWN",
  "RECOVERY_READY",
  "EXIT_BLOCKED",
  "CLOSED_RECONCILED",
  "PROTECTION_SUBMIT_UNKNOWN",
]);
export const costRiskBookSchema = z
  .object({
    kind: z.literal("SYNTHETIC_COST_RISK_BOOK_V1"),
    policyHash: z.literal(policyHash),
    seedHash: z.string().regex(/^[a-f0-9]{64}$/),
    initialAt: time,
    openingFx: positiveCostAmountSchema,
    riskEvidence: z.literal(
      "EXPLICIT_SYNTHETIC_SNAPSHOT_NOT_CONTINUOUS_HISTORY",
    ),
    sources: z
      .array(
        z
          .object({
            config: costJournalConfigSchema,
            events: z.array(costJournalEventSchema).max(500),
            observation: z
              .object({
                at: time,
                bid: positiveCostAmountSchema,
                stop: positiveCostAmountSchema,
                protection,
                protectedQuantity: z.number().int().min(0).max(1000),
              })
              .strict(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type CostRiskBook = z.infer<typeof costRiskBookSchema>;
export interface CostExposure {
  state: State;
  sourceHash: string;
  stateHash: string;
  openRiskKrw: string;
  notionalKrw: string;
  budgetKrw: string;
  available: Record<Currency, string>;
  entries: {
    symbol: string;
    heldRiskKrw: string;
    pendingRiskKrw: string;
    reservedCash: string;
    journalHash: string;
  }[];
  entryBlockReasons: string[];
  orderSubmissionAllowed: false;
  learningAllowed: false;
  liveEnabled: false;
}
// Only an in-process derived, unmodified projection can enter the extended
// research sizer. This is not authorization for persistence or broker access.
const issued = new WeakMap<CostExposure, string>();
export function assertCostExposure(value: CostExposure, state: State) {
  if (issued.get(value) !== hash(value) || value.stateHash !== hash(state))
    throw Error("UNVERIFIED_COST_EXPOSURE");
}

// Local, never-submitted reservations supplied by the versioned C2 reducer.
// This overlay does not insert a WORKING order into a B execution journal.
const localReservationSchema = z
  .object({
    id: costJournalConfigSchema.shape.runId,
    symbol: costJournalConfigSchema.shape.runId,
    currency: z.enum(["KRW", "USD"]),
    quantity: z.number().int().min(1).max(1000),
    entry: positiveCostAmountSchema,
    cashNative: costAmountSchema,
    riskNative: costAmountSchema,
  })
  .strict();
export type LocalCostReservation = z.infer<typeof localReservationSchema>;
// Trusted reducer-only input: this validates representation, not the provenance
// or calculation of riskNative. The C2 store replays the profile/request that
// produced these amounts; do not expose this helper to caller-supplied amounts.
export function withLocalCostReservations(
  base: CostExposure,
  raw: unknown,
  preserveDeficit = false,
): CostExposure {
  assertCostExposure(base, base.state);
  const reservations = z.array(localReservationSchema).max(500).parse(raw);
  const c = structuredClone(base),
    s = c.state;
  const ids = new Set<string>(),
    symbols = new Set(c.entries.map((e) => e.symbol));
  let risk = d(c.openRiskKrw),
    notional = d(c.notionalKrw);
  for (const r of reservations) {
    if (ids.has(r.id) || symbols.has(r.symbol))
      throw Error("DUPLICATE_LOCAL_RESERVATION");
    if (d(r.cashNative).lt(d(r.entry).mul(r.quantity)))
      throw Error("INVALID_LOCAL_CASH_RESERVATION");
    ids.add(r.id);
    symbols.add(r.symbol);
    const FX = fxFor(s.ledger, r.currency),
      R = ceil(d(r.riskNative).mul(FX));
    c.available[r.currency] = d(c.available[r.currency])
      .minus(r.cashNative)
      .toString();
    if (d(c.available[r.currency]).lt(0)) {
      if (!preserveDeficit) throw Error("LOCAL_CASH_OVERRESERVED");
      if (!c.entryBlockReasons.includes("OPERATING_SHARED_CASH_DEFICIT"))
        c.entryBlockReasons.push("OPERATING_SHARED_CASH_DEFICIT");
    }
    risk = risk.plus(R);
    notional = notional.plus(d(r.cashNative).mul(FX));
    const id = hash({ localReservation: r.id });
    s.orders.push({
      id,
      intentId: id,
      positionId: id,
      side: "BUY",
      quantity: r.quantity,
      filled: 0,
      value: "0",
      limit: r.entry,
      currency: r.currency,
      status: "INTENT_SAVED",
      version: 0,
      submittedAt: s.clock,
      lastProgressAt: s.clock,
      reservationRisk: R,
      reservationCash: r.cashNative,
      snapshot: { instrument_id: r.symbol },
      epoch: s.epoch,
      eventIds: [],
    });
    c.entries.push({
      symbol: r.symbol,
      heldRiskKrw: "0",
      pendingRiskKrw: R,
      reservedCash: r.cashNative,
      journalHash: hash(r),
    });
  }
  c.openRiskKrw = risk.toString();
  c.notionalKrw = notional.toString();
  c.budgetKrw = remainingRiskForExposure(s, c.openRiskKrw);
  c.sourceHash = hash({
    base: base.sourceHash,
    contract: "LOCAL_UNSENT_RESERVATIONS_V1",
    reservations,
  });
  c.stateHash = hash(s);
  issued.set(c, hash(c));
  return c;
}
type Result =
  | { status: "OK"; context: CostExposure }
  | {
      status: "HOLD";
      reasons: string[];
      orderSubmissionAllowed: false;
      learningAllowed: false;
      liveEnabled: false;
    };
// Trusted V2 reducer supplement, not an external risk-assertion API. Preserve
// the C1 estimate while retaining a larger approval-bound adverse-exit model.
export function withExecutionRiskFloors(
  base: CostExposure,
  floors: { symbol: string; riskKrw: string }[],
): CostExposure {
  assertCostExposure(base, base.state);
  const c = structuredClone(base),
    seen = new Set<string>();
  for (const f of floors) {
    costAmountSchema.parse(f.riskKrw);
    const entry = c.entries.find((e) => e.symbol === f.symbol);
    if (!entry || seen.has(f.symbol))
      throw Error("INVALID_EXECUTION_RISK_FLOOR");
    seen.add(f.symbol);
    const extra = max(
      0,
      d(f.riskKrw).minus(entry.heldRiskKrw).minus(entry.pendingRiskKrw),
    );
    entry.pendingRiskKrw = d(entry.pendingRiskKrw).plus(extra).toString();
    c.openRiskKrw = d(c.openRiskKrw).plus(extra).toString();
  }
  c.budgetKrw = remainingRiskForExposure(c.state, c.openRiskKrw);
  c.sourceHash = hash({
    base: base.sourceHash,
    model: "APPROVAL_BOUND_EXIT_RISK_V2",
    floors,
  });
  issued.set(c, hash(c));
  return c;
}
// Optional delta evidence is reducer-derived in V4, not a caller cash override.
export function buildCostExposure(
  seed: State,
  rawBook: unknown,
  operating?: OperatingDeltaView,
): Result {
  const hold = (reason: string): Result => ({
    status: "HOLD",
    reasons: [reason],
    orderSubmissionAllowed: false,
    learningAllowed: false,
    liveEnabled: false,
  });
  const parsed = costRiskBookSchema.safeParse(rawBook);
  if (!parsed.success) return hold("INVALID_COST_RISK_BOOK");
  const book = parsed.data;
  if (
    !configSchema.safeParse(seed.config).success ||
    seed.config?.forecast !== "TEST_ONLY"
  )
    return hold("SYNTHETIC_CONFIG_REQUIRED");
  if (book.seedHash !== hash(seed)) return hold("RISK_SEED_BINDING_MISMATCH");
  // The seed provides explicit synthetic risk/protection context, not an
  // authoritative live account. Its opening wallets are included exactly once.
  if (
    seed.positions.length ||
    seed.orders.length ||
    seed.ledger.costs.length ||
    !d(seed.ledger.operationsReserved).eq(0)
  )
    return hold("RISK_SEED_EXPOSURE_UNSUPPORTED");
  for (const w of Object.values(seed.ledger.wallets)) {
    if (
      ![w.cash, w.receivable, w.payable, w.unpaidFees].every(
        (v) => d(v).isFinite() && d(v).gte(0),
      ) ||
      !d(w.receivable).eq(0) ||
      !d(w.payable).eq(0) ||
      !d(w.unpaidFees).eq(0)
    )
      return hold("RISK_SEED_WALLET_UNSUPPORTED");
  }
  if (
    !d(seed.ledger.wallets.KRW.cash)
      .plus(d(seed.ledger.wallets.USD.cash).mul(book.openingFx))
      .eq(seed.config.capital)
  )
    return hold("OPENING_CAPITAL_MISMATCH");
  const keys = riskKeys(seed.clock);
  if (
    book.initialAt > seed.clock ||
    hash(riskKeys(book.initialAt)) !== hash(keys) ||
    Object.entries(keys).some(
      ([k, v]) => seed.ledger.periods[k as keyof typeof keys].key !== v,
    )
  )
    return hold("RISK_PERIOD_HISTORY_REQUIRED");
  for (const [at, ttl] of [
    [
      seed.ledger.accountAt,
      policy.execution.maximum_account_snapshot_age_seconds,
    ],
    [seed.ledger.fxAt, policy.execution.maximum_fx_age_seconds],
  ] as const) {
    if (
      !Number.isSafeInteger(at) ||
      at > seed.clock ||
      seed.clock - at > ttl * 1000
    )
      return hold("RISK_ACCOUNT_OR_FX_STALE");
  }
  if (!positiveCostAmountSchema.safeParse(seed.ledger.fx).success)
    return hold("INVALID_RISK_FX");
  const s = structuredClone(seed),
    entries: CostExposure["entries"] = [],
    reasons: string[] = [];
  const symbols = new Set<string>(),
    runs = new Set<string>();
  let scope: string | null = null,
    openRisk = d(0),
    notional = d(0);
  const reserves = { KRW: d(0), USD: d(0) };
  try {
    for (const source of book.sources) {
      const c = source.config,
        ec = c.execution,
        obs = source.observation;
      const symbol = ec.instrument,
        currency = ec.profile.scope.currency;
      const scoped = hash(c.sourceScope);
      if (scope !== null && scope !== scoped)
        return hold("ACCOUNT_SCOPE_MISMATCH");
      scope = scoped;
      if (symbols.has(symbol) || runs.has(c.runId))
        return hold("DUPLICATE_RISK_SOURCE");
      symbols.add(symbol);
      runs.add(c.runId);
      if (
        ec.initialAt !== book.initialAt ||
        !d(ec.initialCash).eq(seed.ledger.wallets[currency].cash)
      )
        return hold("JOURNAL_OPENING_MISMATCH");
      if (
        seed.clock > c.horizonEnd ||
        seed.clock >= ec.profile.effectiveTo ||
        seed.clock < ec.profile.availableAt ||
        source.events.some((e) => e.at > seed.clock)
      )
        return hold("RISK_SOURCE_TIME");
      if (
        obs.at > seed.clock ||
        seed.clock - obs.at > policy.execution.maximum_quote_age_seconds * 1000
      )
        return hold("RISK_MARK_STALE");
      const view = replayCostJournal(c, source.events);
      if (obs.protectedQuantity > view.quantity)
        return hold("PROTECTION_QUANTITY_MISMATCH");
      if (view.quantity > 0 && view.orders.some((o) => o.side === "SELL"))
        reasons.push("EXIT_CHAIN_REQUIRES_RECONCILIATION");
      const wallet = s.ledger.wallets[currency];
      wallet.cash = d(wallet.cash)
        .plus(d(view.wallet.cash).minus(ec.initialCash))
        .toString();
      wallet.receivable = d(wallet.receivable)
        .plus(view.wallet.receivable)
        .toString();
      wallet.payable = d(wallet.payable).plus(view.wallet.payable).toString();
      reserves[currency] = reserves[currency].plus(view.reservedCash);
      const FX = fxFor(s.ledger, currency);
      const heldCost = estimateFeeBound(
        ec.profile,
        "SELL",
        view.quantity,
        obs.bid,
        seed.clock,
        policy.execution.emergency_exit.maximum_replacements + 1,
      );
      const held = max(0, d(obs.bid).minus(obs.stop))
        .mul(view.quantity)
        .plus(heldCost)
        .plus(
          d(obs.bid)
            .mul(view.quantity)
            .mul(profile.fees.exitAdverseBps)
            .div(10000),
        )
        .mul(FX);
      let pending = d(0);
      for (const order of view.orders) {
        const terminal =
          order.status === "FILLED" || order.status === "CANCELLED";
        const remaining = order.quantity - order.filled;
        if (order.status === "UNKNOWN" || order.status === "CANCEL_UNKNOWN")
          reasons.push("UNRESOLVED_EXECUTION");
        const id = hash({ runId: c.runId, orderId: order.id });
        let risk = d(0);
        if (!terminal && order.side === "BUY") {
          if (d(order.limit).lte(obs.stop)) return hold("INVALID_PENDING_STOP");
          const entry = d(order.reservedCash).minus(
            d(order.limit).mul(remaining),
          );
          if (entry.lt(0)) return hold("INVALID_ENTRY_RESERVE");
          risk = d(order.limit)
            .minus(obs.stop)
            .mul(remaining)
            .plus(entry)
            .plus(
              estimateFeeBound(
                ec.profile,
                "SELL",
                remaining,
                obs.stop,
                seed.clock,
                policy.execution.emergency_exit.maximum_replacements + 1,
              ),
            )
            .plus(
              d(obs.stop)
                .mul(remaining)
                .mul(profile.fees.exitAdverseBps)
                .div(10000),
            )
            .mul(FX);
          pending = pending.plus(risk);
          notional = notional.plus(d(order.reservedCash).mul(FX));
        }
        s.orders.push({
          id,
          intentId: id,
          positionId: hash({ run: c.runId }),
          side: order.side,
          quantity: order.quantity,
          filled: order.filled,
          value: order.value,
          limit: order.limit,
          currency,
          status: order.status,
          version: 0,
          submittedAt: order.at,
          lastProgressAt: order.lastAt,
          reservationRisk: ceil(risk),
          reservationCash: order.reservedCash,
          snapshot: { instrument_id: symbol },
          epoch: s.epoch,
          eventIds: [],
        });
      }
      if (view.quantity) {
        const p: Position = {
          id: hash({ run: c.runId }),
          intentId: hash({ run: c.runId }),
          symbol,
          currency,
          market: ec.profile.scope.market,
          owner: "BOT",
          quantity: view.quantity,
          buyQuantity: view.postings
            .filter((p) => p.side === "BUY")
            .reduce((n, p) => n + p.fill.quantity, 0),
          buyValue: sum(
            view.postings.filter((p) => p.side === "BUY").map((p) => p.value),
          ).toString(),
          entryFees: sum(
            view.postings
              .filter((p) => p.side === "BUY")
              .map((p) => p.feeDelta),
          ).toString(),
          exitValue: sum(
            view.postings.filter((p) => p.side === "SELL").map((p) => p.value),
          ).toString(),
          exitFees: sum(
            view.postings
              .filter((p) => p.side === "SELL")
              .map((p) => p.feeDelta),
          ).toString(),
          stop: obs.stop,
          target: obs.bid,
          bid: obs.bid,
          firstFillAt: book.initialAt,
          deadline: c.horizonEnd,
          protection: obs.protection,
          protectedQuantity: obs.protectedQuantity,
          initialBudget: "0",
          replacements: 0,
        };
        s.positions.push(p);
        notional = notional.plus(d(obs.bid).mul(view.quantity).mul(FX));
      }
      openRisk = openRisk.plus(held).plus(pending);
      entries.push({
        symbol,
        heldRiskKrw: held.toString(),
        pendingRiskKrw: pending.toString(),
        reservedCash: view.reservedCash,
        journalHash: view.journalHash,
      });
    }
    // Seed counters must describe the supplied risk snapshot, including these
    // events; they are not silently reset to zero or inferred from deliveries.
    const intents = book.sources.reduce(
      (n, v) =>
        n +
        v.events.filter(
          (e) => e.kind === "ORDER" && e.side === "BUY" && !e.replaces,
        ).length,
      0,
    );
    const entered = entries.filter((e) =>
      book.sources
        .find((v) => v.config.execution.instrument === e.symbol)!
        .events.some(
          (v) =>
            v.kind === "FILL" &&
            book.sources
              .find((t) => t.config.execution.instrument === e.symbol)!
              .events.some(
                (o) =>
                  o.kind === "ORDER" &&
                  o.side === "BUY" &&
                  o.orderId === v.orderId,
              ),
        ),
    );
    if (
      s.ledger.intents < intents ||
      s.ledger.entries < entered.length ||
      entered.some((e) => (s.ledger.symbolEntries[e.symbol] ?? 0) < 1)
    )
      return hold("RISK_COUNTER_EVIDENCE_INCOMPLETE");
    if (operating) {
      s.ledger.wallets.KRW.cash = d(s.ledger.wallets.KRW.cash)
        .minus(operating.paidKrw)
        .toString();
      s.ledger.wallets.KRW.payable = d(s.ledger.wallets.KRW.payable)
        .plus(operating.payableKrw)
        .toString();
      reserves.KRW = reserves.KRW.plus(operating.reservedKrw);
      s.ledger.operationsReserved = operating.reservedKrw;
      s.ledger.costs = operating.obligations.map((o) => ({
        id: o.costEventId,
        amount: o.amountKrw,
        at: o.occurredAt,
        paid: o.paid,
      }));
    }
    const available = { KRW: "0", USD: "0" };
    for (const currency of ["KRW", "USD"] as const) {
      const w = s.ledger.wallets[currency];
      const raw = d(w.cash)
        .minus(w.payable)
        .minus(w.unpaidFees)
        .minus(reserves[currency]);
      if (d(w.cash).lt(0) || raw.lt(0)) {
        if (!operating) return hold("SHARED_CASH_OVERRESERVED");
        reasons.push("OPERATING_SHARED_CASH_DEFICIT");
      }
      available[currency] = raw.toString();
    }
    // Reuse current-valuation halt/reduction rules. This cannot reconstruct
    // unobserved historical peaks; the supplied risk snapshot remains explicit.
    mark(s);
    const context: CostExposure = {
      state: s,
      sourceHash: hash({
        book,
        ...(operating ? { operatingSourceHash: operating.sourceHash } : {}),
        model: {
          contract: "C1_INTEGER_PARTITIONS_EXIT_REPLACEMENT_BOUND_V1",
          legacyExecutionHash: hash(profile.execution),
          exitAdverseBps: profile.fees.exitAdverseBps,
          fxCashStressBps: profile.fxCashStressBps,
          maximumExitOrders:
            policy.execution.emergency_exit.maximum_replacements + 1,
        },
      }),
      stateHash: hash(s),
      openRiskKrw: openRisk.toString(),
      notionalKrw: notional.toString(),
      budgetKrw: remainingRiskForExposure(s, openRisk.toString()),
      available,
      entries,
      entryBlockReasons: [...new Set(reasons)],
      orderSubmissionAllowed: false,
      learningAllowed: false,
      liveEnabled: false,
    };
    issued.set(context, hash(context));
    return { status: "OK", context };
  } catch {
    return hold("COST_RISK_REPLAY_OR_BOUND_FAILED");
  }
}
