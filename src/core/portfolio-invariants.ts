import { d, ceil, sum } from "./math.js";
import { bindSnapshot, hash } from "./policy.js";
import { costFor, fee } from "./risk.js";
import { availableCash, fxFor } from "./ledger.js";
import type { State } from "./types.js";
import { terminal } from "./types.js";

export function checkPortfolioInvariants(s: State, initial: State) {
  const fail = (reason: string): never => {
    throw new Error(`PORTFOLIO_INVARIANT:${reason}`);
  };
  for (const list of [s.orders, s.positions, s.decisions])
    if (new Set(list.map((x) => x.id)).size !== list.length)
      fail("DUPLICATE_ID");
  for (const o of s.orders) {
    if (
      !Number.isSafeInteger(o.quantity) ||
      !Number.isSafeInteger(o.filled) ||
      o.quantity <= 0 ||
      o.filled < 0 ||
      o.filled > o.quantity
    )
      fail("QUANTITY");
    if (o.side === "BUY") {
      if (!o.snapshot || bindSnapshot(o.snapshot) !== o.snapshotHash)
        fail("SNAPSHOT");
      if (o.snapshot!.portfolio_run_hash !== s.manifest?.runHash)
        fail("ORDER_RUN");
      if (
        (s.manifest?.executionStress || o.snapshot!.execution_stress_hash) &&
        o.snapshot!.execution_stress_hash !==
          hash(s.manifest?.executionStress ?? null)
      )
        fail("ORDER_STRESS");
      if (o.currency !== (o.snapshot!.market === "US" ? "USD" : "KRW"))
        fail("ORDER_CURRENCY");
      const n = terminal(o) ? 0 : o.quantity - o.filled;
      const cost = costFor(
        n,
        o.limit,
        String(o.snapshot!.stop_price),
        fxFor(s.ledger, o.currency),
      );
      const cash = d(o.limit).mul(n).plus(cost.entry);
      const risk =
        n === 0
          ? "0"
          : ceil(
              d(o.limit)
                .minus(String(o.snapshot!.stop_price))
                .mul(n)
                .mul(fxFor(s.ledger, o.currency))
                .plus(cost.stop),
            );
      if (!cash.eq(o.reservationCash) || !d(risk).eq(o.reservationRisk))
        fail("RESERVATION");
    } else if (!d(o.reservationCash).eq(0) || !d(o.reservationRisk).eq(0))
      fail("SELL_RESERVATION");
    if (o.filled > 0 && !s.positions.some((p) => p.id === o.positionId))
      fail("ORPHAN_FILL");
  }
  for (const p of s.positions) {
    const orders = s.orders.filter((o) => o.positionId === p.id);
    const buys = orders.filter((o) => o.side === "BUY"),
      sells = orders.filter((o) => o.side === "SELL");
    if (
      buys.length !== 1 ||
      buys[0]!.snapshot?.instrument_id !== p.symbol ||
      buys[0]!.snapshot?.market !== p.market ||
      orders.some((o) => o.currency !== p.currency)
    )
      fail("POSITION_IDENTITY");
    if (
      p.owner !== "BOT" ||
      !Number.isSafeInteger(p.quantity) ||
      p.quantity < 0 ||
      p.quantity !==
        buys.reduce((n, o) => n + o.filled, 0) -
          sells.reduce((n, o) => n + o.filled, 0) ||
      p.buyQuantity !== buys.reduce((n, o) => n + o.filled, 0)
    )
      fail("POSITION_QUANTITY");
    if (
      !sum(buys.map((o) => o.value)).eq(p.buyValue) ||
      !sum(sells.map((o) => o.value)).eq(p.exitValue) ||
      !sum(buys.map((o) => fee(o.value, "BUY"))).eq(p.entryFees) ||
      !sum(sells.map((o) => fee(o.value, "SELL"))).eq(p.exitFees)
    )
      fail("POSITION_VALUE");
    if (p.protectedQuantity > p.quantity || p.protectedQuantity < 0)
      fail("PROTECTION_QUANTITY");
    if (p.closedAt && (p.quantity !== 0 || orders.some((o) => !terminal(o))))
      fail("CLOSED_EXPOSURE");
  }
  for (const c of ["KRW", "USD"] as const) {
    const w = s.ledger.wallets[c];
    if (Object.values(w).some((x) => !d(x).isFinite() || d(x).lt(0)))
      fail("NEGATIVE_WALLET");
    const orders = s.orders.filter((o) => o.currency === c);
    const expected = d(initial.ledger.wallets[c].cash)
      .minus(
        sum(
          orders
            .filter((o) => o.side === "BUY")
            .map((o) => d(o.value).plus(fee(o.value, "BUY"))),
        ),
      )
      .plus(
        sum(
          orders
            .filter((o) => o.side === "SELL")
            .map((o) => d(o.value).minus(fee(o.value, "SELL"))),
        ),
      );
    if (
      !d(w.cash)
        .plus(w.receivable)
        .minus(w.payable)
        .minus(w.unpaidFees)
        .eq(expected)
    )
      fail("WALLET_FLOW");
    const reserved = sum(
      orders
        .filter((o) => o.side === "BUY" && !terminal(o))
        .map((o) => o.reservationCash),
    );
    if (
      d(w.cash).minus(w.payable).minus(w.unpaidFees).minus(reserved).lt(0) ||
      availableCash(s, c).lt(0)
    )
      fail("CASH_OVERRESERVED");
  }
}
