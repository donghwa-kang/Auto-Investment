import { d } from "./math.js";
import { mark, latch } from "./ledger.js";
import { policy } from "./policy.js";
import { minute } from "./calendar.js";
import { terminal, type State, type Currency } from "./types.js";
export interface KnownEvent {
  id: string;
  start: number;
  end: number;
  availableAt: number;
}
export function eventGate(at: number, events: KnownEvent[] | null) {
  if (
    events === null ||
    events.some((e) => e.availableAt > at || e.end < e.start)
  )
    return false;
  return !events.some(
    (e) =>
      at >=
        e.start -
          policy.exit_policy.event_entry_block_before_minutes * minute &&
      at <=
        e.end + policy.exit_policy.event_entry_block_after_end_minutes * minute,
  );
}
export function holdingDeadline(
  firstFill: number,
  sessionClose: number,
  events: KnownEvent[],
) {
  const next = events
    .filter((e) => e.availableAt <= firstFill && e.start > firstFill)
    .sort((a, b) => a.start - b.start)[0];
  return Math.min(
    firstFill + policy.exit_policy.maximum_holding_minutes * minute,
    sessionClose - policy.exit_policy.close_buffer_minutes * minute,
    next
      ? next.start - policy.exit_policy.event_exit_buffer_minutes * minute
      : Infinity,
  );
}
// 공개·효력 확인된 합성 기업행동만 사용. 소수 수량/미체결이 있으면 자동 적용하지 않는다.
export function applySplit(
  s: State,
  id: string,
  symbol: string,
  ratio: string,
  availableAt: number,
  effectiveAt: number,
) {
  if (availableAt > s.clock || effectiveAt > s.clock) return false;
  if (s.ledger.costs.some((x) => x.id === `action:${id}`)) return true;
  if (d(ratio).lte(0)) throw new Error("INVALID_SPLIT");
  const positions = s.positions.filter(
    (p) => p.symbol === symbol && p.quantity > 0,
  );
  if (
    s.orders.some(
      (o) => positions.some((p) => p.id === o.positionId) && !terminal(o),
    ) ||
    positions.some(
      (p) =>
        !d(p.quantity).mul(ratio).isInteger() ||
        !d(p.buyQuantity).mul(ratio).isInteger(),
    )
  ) {
    latch(s, "CORPORATE_ACTION_RECONCILIATION_REQUIRED");
    return false;
  }
  for (const p of positions) {
    p.quantity = d(p.quantity).mul(ratio).toNumber();
    p.buyQuantity = d(p.buyQuantity).mul(ratio).toNumber();
    p.protectedQuantity = d(p.protectedQuantity).mul(ratio).toNumber();
    for (const key of ["stop", "target", "bid"] as const)
      p[key] = d(p[key]).div(ratio).toString();
  }
  s.ledger.costs.push({
    id: `action:${id}`,
    at: s.clock,
    amount: "0",
    paid: true,
  });
  mark(s);
  return true;
}
export function dividendReceivable(
  s: State,
  id: string,
  currency: Currency,
  gross: string,
  withholding: string,
  availableAt: number,
) {
  if (availableAt > s.clock) return false;
  if (d(gross).lt(0) || d(withholding).lt(0) || d(withholding).gt(gross))
    throw new Error("INVALID_DIVIDEND");
  if (s.ledger.costs.some((x) => x.id === `dividend:${id}`)) return true;
  const wallet = s.ledger.wallets[currency];
  wallet.receivable = d(wallet.receivable)
    .plus(d(gross).minus(withholding))
    .toString();
  s.ledger.costs.push({
    id: `dividend:${id}`,
    at: s.clock,
    amount: "0",
    paid: true,
  });
  mark(s);
  return true;
}
