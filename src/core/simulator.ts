import { d, tick, ceil } from "./math.js";
import { fee, costFor, profile } from "./risk.js";
import { fxFor, latch, mark } from "./ledger.js";
import { policy } from "./policy.js";
import type { State, Order, Quote, Position, OrderStatus } from "./types.js";
import { terminal } from "./types.js";
import { minute } from "./calendar.js";
import { holdingDeadline } from "./events.js";
import { exitTarget } from "./execution-loop-rules.js";
import type { ExecutionStress } from "./execution-stress.js";
export interface FillEvent {
  id: string;
  version: number;
  cumulativeFilled: number;
  cumulativeValue: string;
  status: OrderStatus;
}
export function applyOrderEvent(s: State, o: Order, event: FillEvent) {
  if (o.eventIds.includes(event.id)) return;
  if (event.version <= o.version) {
    if (event.cumulativeFilled > o.filled) latch(s, "OUT_OF_ORDER_CONFLICT");
    return;
  }
  if (event.cumulativeFilled < o.filled) {
    latch(s, "CUMULATIVE_REGRESSION");
    return;
  }
  if (
    event.cumulativeFilled > o.quantity ||
    event.cumulativeFilled < 0 ||
    !Number.isSafeInteger(event.cumulativeFilled)
  )
    throw new Error("INVALID_FILL_QUANTITY");
  const delta = event.cumulativeFilled - o.filled;
  const value = d(event.cumulativeValue).minus(o.value);
  if (
    value.lt(0) ||
    (delta === 0 && !value.eq(0)) ||
    (delta > 0 && value.lte(0))
  )
    throw new Error("INVALID_FILL_VALUE");
  if ((event.status === "FILLED") !== (event.cumulativeFilled === o.quantity))
    throw new Error("INVALID_TERMINAL_FILL");
  let p = s.positions.find((p) => p.id === o.positionId);
  const w = s.ledger.wallets[o.currency];
  if (delta > 0) {
    const fillPrice = value.div(delta);
    if (o.side === "BUY" && fillPrice.gt(o.limit))
      throw new Error("BUY_LIMIT_VIOLATION");
    if (o.side === "SELL" && fillPrice.lt(o.limit))
      throw new Error("SELL_LIMIT_VIOLATION");
    const f = fee(value.toString(), o.side);
    if (o.side === "BUY") {
      if (!p) {
        p = {
          id: o.positionId,
          intentId: o.intentId,
          symbol: String(o.snapshot!.instrument_id),
          market:
            o.snapshot?.market === "US"
              ? "US"
              : o.snapshot?.market === "KR"
                ? "KR"
                : s.config!.market,
          currency: o.currency,
          owner: "BOT",
          quantity: 0,
          buyQuantity: 0,
          buyValue: "0",
          entryFees: "0",
          exitValue: "0",
          exitFees: "0",
          stop: String(o.snapshot!.stop_price),
          target: String(o.snapshot!.target_price),
          bid: fillPrice.toString(),
          firstFillAt: s.clock,
          deadline: holdingDeadline(
            s.clock,
            Number(o.snapshot?.session_close ?? s.sessionClose),
            profile.eventCalendar.events,
          ),
          protection: "REGISTERED_PENDING_VERIFY",
          protectedQuantity: 0,
          initialBudget: String(o.snapshot!.initial_budget),
          replacements: 0,
        };
        s.positions.push(p);
        s.ledger.entries++;
        s.ledger.symbolEntries[p.symbol] =
          (s.ledger.symbolEntries[p.symbol] ?? 0) + 1;
      }
      p.quantity += delta;
      p.buyQuantity += delta;
      p.buyValue = d(p.buyValue).plus(value).toString();
      p.entryFees = d(p.entryFees).plus(f).toString();
      const F = d(p.buyValue).div(p.buyQuantity);
      p.target = exitTarget(F.toString(), p.stop, profile.ticks[p.market]);
      p.protectedQuantity = 0;
      p.protection = "REGISTERED_PENDING_VERIFY";
      w.payable = d(w.payable).plus(value).plus(f).toString();
    } else {
      if (!p || p.owner !== "BOT" || delta > p.quantity)
        throw new Error("OVERSELL_OR_MANUAL");
      p.quantity -= delta;
      p.exitValue = d(p.exitValue).plus(value).toString();
      p.exitFees = d(p.exitFees).plus(f).toString();
      w.receivable = d(w.receivable).plus(value).minus(f).toString();
      p.protection = p.quantity ? "EXIT_PARTIAL" : "CHILD_PENDING";
      p.protectedQuantity = Math.min(p.protectedQuantity, p.quantity);
    }
    o.lastProgressAt = s.clock;
  }
  o.version = event.version;
  o.filled = event.cumulativeFilled;
  o.value = event.cumulativeValue;
  o.status = event.status;
  o.eventIds.push(event.id);
  if (o.side === "BUY") {
    const remaining = o.quantity - o.filled;
    if (terminal(o)) {
      o.reservationRisk = "0";
      o.reservationCash = "0";
    } else {
      const costs = costFor(
        remaining,
        o.limit,
        String(o.snapshot!.stop_price),
        fxFor(s.ledger, o.currency),
      );
      o.reservationRisk = ceil(
        d(o.limit)
          .minus(String(o.snapshot!.stop_price))
          .mul(remaining)
          .mul(fxFor(s.ledger, o.currency))
          .plus(costs.stop),
      );
      o.reservationCash = d(o.limit)
        .mul(remaining)
        .plus(costs.entry)
        .toString();
    }
  }
  finishPositions(s);
  mark(s);
}
export function cancelEntries(s: State, stress?: ExecutionStress) {
  for (const o of s.orders) {
    if (o.side === "BUY" && o.status === "INTENT_SAVED") {
      o.status = "CANCELLED";
      o.reservationCash = "0";
      o.reservationRisk = "0";
      continue;
    }
    if (
      o.side === "BUY" &&
      !terminal(o) &&
      !["CANCEL_PENDING", "CANCEL_UNKNOWN", "UNKNOWN"].includes(o.status)
    ) {
      o.status = "CANCEL_PENDING";
      o.cancelAt = s.clock;
      o.cancelFinalAt = s.clock + (stress?.cancelLatencyMs ?? 2000);
    }
  }
}
function finishPositions(s: State) {
  for (const p of s.positions) {
    if (
      p.owner === "BOT" &&
      p.quantity === 0 &&
      !p.closedAt &&
      s.orders.filter((o) => o.positionId === p.id).every(terminal)
    ) {
      p.closedAt = s.clock;
      p.protection = "CLOSED_RECONCILED";
      p.netPnl = d(p.exitValue)
        .minus(p.buyValue)
        .minus(p.entryFees)
        .minus(p.exitFees)
        .mul(fxFor(s.ledger, p.currency))
        .toString();
      s.ledger.cooldowns[p.symbol] =
        s.clock + policy.risk.reentry_cooldown_minutes * minute;
      if (d(p.netPnl).lt(0)) s.ledger.lossStreak++;
      else if (d(p.netPnl).gt(0)) s.ledger.lossStreak = 0;
      if (s.ledger.lossStreak >= policy.risk.consecutive_loss_halt_count)
        latch(s, "CONSECUTIVE_LOSSES");
      if (d(p.netPnl).neg().gt(d(p.initialBudget).mul(2)))
        latch(s, "STOP_LOSS_EXCEEDS_2X");
    }
  }
}
export function requestExit(
  s: State,
  p: Position,
  reason: string,
  q: Quote,
  stress?: ExecutionStress,
) {
  if (p.owner !== "BOT" || p.quantity <= 0) return;
  p.exitReason = reason;
  cancelEntries(s, stress);
  if (s.orders.some((o) => o.positionId === p.id && !terminal(o))) return;
  if (p.protection === "EXIT_BLOCKED") return;
  const unit = profile.ticks[p.market];
  const limit =
    reason === "STOP" && p.replacements === 0
      ? tick(p.stop, unit)
      : tick(q.bid, unit);
  p.exitReferenceBid ??= q.bid;
  const floorPrice = tick(
    d(p.exitReferenceBid).mul(
      d(1).minus(d(profile.execution.maxAdversePriceBps).div(10000)),
    ),
    unit,
    true,
  );
  if (
    d(limit).lt(floorPrice) ||
    q.halted ||
    s.clock - q.at > policy.execution.maximum_quote_age_seconds * 1000
  ) {
    p.protection = "EXIT_BLOCKED";
    s.status = "EXIT_BLOCKED";
    s.notices.push(
      "청산 가격 범위/호가 확인 실패. 잔여 보유는 미완료 노출입니다.",
    );
    return;
  }
  const id = `exit-${p.id}-${p.replacements}`;
  if (s.orders.some((o) => o.id === id)) return;
  const previous = p.exitOrderId;
  p.exitOrderId = id;
  p.protection = "CHILD_PENDING";
  s.orders.push({
    id,
    intentId: `close-${p.intentId}`,
    positionId: p.id,
    side: "SELL",
    quantity: p.quantity,
    filled: 0,
    value: "0",
    limit,
    currency: p.currency,
    status: "INTENT_SAVED",
    version: 0,
    submittedAt: s.clock,
    lastProgressAt: s.clock,
    reservationRisk: "0",
    reservationCash: "0",
    epoch: s.epoch,
    eventIds: [],
    replaces: previous,
  });
}
// DB 트랜잭션에서 호출한다. 이전 tick에 영속 저장된 의도만 접수/체결 대상이다.
export function orderInstrument(s: State, o: Order) {
  return o.side === "BUY"
    ? String(o.snapshot?.instrument_id)
    : s.positions.find((p) => p.id === o.positionId)?.symbol;
}
export function simulatorStep(
  s: State,
  q: Quote,
  instrument?: string,
  stress?: ExecutionStress,
) {
  const existing = s.orders.filter(
    (o) => instrument === undefined || orderInstrument(s, o) === instrument,
  );
  for (const o of existing) {
    if (terminal(o) || o.submittedAt >= s.clock) continue;
    if (o.status === "UNKNOWN" || o.status === "CANCEL_UNKNOWN") continue;
    if (o.status === "INTENT_SAVED") {
      if (o.side === "BUY" && s.config!.scenario === "UNKNOWN") {
        o.status = "UNKNOWN";
        s.status = "RECONCILING";
        continue;
      }
      o.status = "WORKING";
      continue;
    }
    if (
      o.side === "BUY" &&
      s.clock - o.submittedAt >=
        policy.execution.cancel_unfilled_entry_after_seconds * 1000 &&
      !o.cancelAt
    ) {
      o.status = "CANCEL_PENDING";
      o.cancelAt = s.clock;
      o.cancelFinalAt = s.clock + (stress?.cancelLatencyMs ?? 2000);
    }
    const evidence = s.clock > o.submittedAt && q.at === s.clock && !q.halted;
    const marketable =
      o.side === "BUY" ? d(q.ask).lte(o.limit) : d(q.bid).gte(o.limit);
    const pendingCancel = ["CANCEL_PENDING"].includes(o.status);
    const canFill =
      evidence &&
      marketable &&
      s.clock - o.submittedAt >= (stress?.latencyMs ?? 0) &&
      (o.side === "BUY" ? q.askSize : q.bidSize) > 0;
    if (canFill && (!pendingCancel || s.clock < o.cancelFinalAt!)) {
      const fill = Math.min(
        o.quantity - o.filled,
        profile.execution.maxUnitsPerFill,
        o.side === "BUY" ? q.askSize : q.bidSize,
      );
      const price = o.side === "BUY" ? q.ask : q.bid;
      const cumulative = o.filled + fill;
      applyOrderEvent(s, o, {
        id: `${o.id}:fill:${cumulative}`,
        version: o.version + 1,
        cumulativeFilled: cumulative,
        cumulativeValue: d(o.value).plus(d(price).mul(fill)).toString(),
        status: cumulative === o.quantity ? "FILLED" : "PARTIAL",
      });
      if (pendingCancel && !terminal(o)) o.status = "CANCEL_PENDING";
      if (
        s.config!.scenario === "PARTIAL_CANCEL" &&
        o.side === "BUY" &&
        !o.cancelAt &&
        !terminal(o)
      ) {
        o.status = "CANCEL_PENDING";
        o.cancelAt = s.clock;
        o.cancelFinalAt = s.clock + (stress?.cancelLatencyMs ?? 2000);
      }
    }
    if (pendingCancel && s.clock >= o.cancelFinalAt! && !terminal(o))
      applyOrderEvent(s, o, {
        id: `${o.id}:cancel`,
        version: o.version + 1,
        cumulativeFilled: o.filled,
        cumulativeValue: o.value,
        status: "CANCELLED",
      });
  }
  for (const p of s.positions.filter(
    (p) =>
      p.owner === "BOT" &&
      p.quantity > 0 &&
      (instrument === undefined || p.symbol === instrument),
  )) {
    p.bid = q.bid;
    if (p.protection === "REGISTERED_PENDING_VERIFY") {
      if (s.config!.scenario === "PROTECTION_FAILURE") {
        p.protection = "PROTECTION_SUBMIT_UNKNOWN";
        latch(s, "PROTECTION_FAILURE");
        s.notices.push("모의 보호 확인 실패: 신규 진입 중단, 청산 대조 필요");
      } else {
        p.protectedQuantity = p.quantity;
        p.protection = "WATCHING";
      }
    }
    const atStop = d(q.bid).lte(p.stop),
      atTarget = d(q.bid).gte(p.target);
    if (p.protection === "WATCHING" && (atStop || atTarget)) {
      p.protection = "TRIGGER_SUSPECTED";
      p.exitReason = atStop ? "STOP" : "TARGET";
      continue;
    }
    if (p.protection === "TRIGGER_SUSPECTED") p.protection = "TRIGGERED";
    if (
      p.protection === "TRIGGERED" ||
      p.exitReason ||
      s.ledger.halts.length ||
      s.status === "REDUCTION_PENDING" ||
      s.clock >= p.deadline
    )
      requestExit(
        s,
        p,
        s.ledger.halts.length
          ? "RISK"
          : (p.exitReason ??
              (s.status === "REDUCTION_PENDING" ? "REDUCE" : "TIME")),
        q,
        stress,
      );
    const o = s.orders.find((o) => o.id === p.exitOrderId);
    // 주문 루프에서 건너뛴 미확정을 무진행 타이머로 취소/대체하지 않는다.
    // 시가평가는 위에서 유지하며 확정 체결/취소는 별도 주문 증거가 필요하다.
    if (o?.status === "UNKNOWN" || o?.status === "CANCEL_UNKNOWN") continue;
    if (o && !terminal(o) && o.status !== "INTENT_SAVED") {
      p.protection = o.filled ? "EXIT_PARTIAL" : "EXIT_WORKING";
      if (
        s.clock - o.lastProgressAt >=
          policy.execution.emergency_exit.no_progress_review_seconds * 1000 &&
        o.status !== "CANCEL_PENDING"
      ) {
        const floorPrice = d(p.exitReferenceBid!).mul(
          d(1).minus(d(profile.execution.maxAdversePriceBps).div(10000)),
        );
        if (
          p.replacements >=
            policy.execution.emergency_exit.maximum_replacements ||
          d(q.bid).lt(floorPrice)
        ) {
          p.protection = "EXIT_BLOCKED";
          s.status = "EXIT_BLOCKED";
        } else {
          o.status = "CANCEL_PENDING";
          o.cancelAt = s.clock;
          o.cancelFinalAt = s.clock + (stress?.cancelLatencyMs ?? 2000);
        }
      }
    }
    if (
      o?.status === "CANCELLED" &&
      p.quantity > 0 &&
      p.protection !== "EXIT_BLOCKED"
    ) {
      p.replacements++;
      p.protection = "RECOVERY_READY";
      requestExit(s, p, p.exitReason ?? "RECOVERY", q, stress);
    }
  }
  if (s.ledger.halts.length) cancelEntries(s, stress);
  finishPositions(s);
  for (const p of s.positions) {
    if (
      p.owner === "BOT" &&
      p.quantity > 0 &&
      s.clock - p.firstFillAt >
        policy.execution.maximum_protection_verification_seconds * 1000 &&
      ["PROTECTION_SUBMIT_UNKNOWN", "REGISTERED_PENDING_VERIFY"].includes(
        p.protection,
      )
    )
      latch(s, "PROTECTION_TIMEOUT");
  }
}
export function reconcileUnknown(s: State) {
  for (const o of s.orders) {
    if (o.status === "UNKNOWN" || o.status === "CANCEL_UNKNOWN")
      throw new Error(
        "UNKNOWN_UNRESOLVED: 접수 증거 없음. 예약 유지, 신규 진입 금지",
      );
  }
  finishPositions(s);
}
export function adverseBarOutcome(
  low: string,
  high: string,
  stop: string,
  target: string,
) {
  if (d(low).lte(stop) && d(high).gte(target))
    return "ADVERSE_STOP_FIRST_UNRESOLVED_FILL";
  return d(low).lte(stop)
    ? "STOP_TRIGGER_ONLY"
    : d(high).gte(target)
      ? "TARGET_TRIGGER_ONLY"
      : "NO_TRIGGER";
}
