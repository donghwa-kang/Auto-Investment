import type { CostJournalEvent } from "../src/core/cost-journal.js";
import type { CostLoopTick } from "../src/core/cost-loop-schema.js";

// Local TEST_ONLY scripts, not historical prices or broker evidence. Times
// (including occurredAt/evidenceAt) are milliseconds relative to the signal.
type EventBody<E = CostJournalEvent> = E extends CostJournalEvent
  ? Omit<E, "at" | "seq" | "id">
  : never;
export interface StressExpected {
  buys: number;
  sells: number;
  paidBuys: number;
  receivedSells: number;
  sellPrice?: string;
  reserved: string;
  // id, status, original quantity, cumulative filled, limit
  orders: [string, string, number, number, string][];
  reason?: "STOP" | "TARGET" | "TIME" | "RISK" | null;
  holds?: string[];
  status?: "HOLD" | "CLOSED" | "WATCHING" | "EXITING" | "WAITING";
  pnl?: string;
  lossStreak?: number;
  deadlineOffset?: number;
}
type Checked = { id: string; expect?: StressExpected };
export type StressStep = Checked &
  (
    | { kind: "tick"; at: number; quote?: Partial<CostLoopTick["quote"]> }
    | { kind: "event"; at: number; event: EventBody }
    | { kind: "restart" }
    | { kind: "retry"; ref: string }
    | { kind: "fill-conflict"; ref: string }
    | { kind: "silence"; until: number }
  );
export interface StressFixture {
  id: string;
  description: string;
  steps: StressStep[];
}
const entry = (
  status = "FILLED",
  filled = 4,
): StressExpected["orders"][number] => ["entry", status, 4, filled, "21400"];
const sell = (
  n: number,
  status: string,
  filled: number,
  price: string,
  quantity = 4,
): StressExpected["orders"][number] => [
  `loop-exit-${n}`,
  status,
  quantity,
  filled,
  price,
];
const quote = (bid: string, ask = bid, bidSize = 1000, askSize = 0) => ({
  bid,
  ask,
  bidSize,
  askSize,
});
function bought(): StressStep[] {
  return [1, 2, 3, 4].map((i) => ({
    kind: "tick",
    id: `buy-${i}`,
    at: i * 1000,
    expect: {
      buys: i,
      sells: 0,
      paidBuys: i - 1,
      receivedSells: 0,
      reserved: String(BigInt(4 - i) * 21400n),
      orders: [entry(i === 4 ? "FILLED" : "PARTIAL", i)],
      reason: null,
      holds: [],
    },
  }));
}

export const costLoopStressFixtures: StressFixture[] = [
  {
    id: "CL-X01",
    description:
      "gap through stop, unfilled stop limit, replacement and actual loss",
    steps: [
      ...bought(),
      {
        kind: "tick",
        id: "gap",
        at: 5000,
        quote: quote("20000", "20001"),
        expect: {
          buys: 4,
          sells: 0,
          paidBuys: 4,
          receivedSells: 0,
          reserved: "0",
          orders: [entry()],
          reason: "STOP",
          holds: ["EXECUTION_BUDGET_EXCEEDED"],
          status: "HOLD",
        },
      },
      {
        kind: "tick",
        id: "stop-limit",
        at: 6000,
        quote: quote("20000", "20001"),
        expect: {
          buys: 4,
          sells: 0,
          paidBuys: 4,
          receivedSells: 0,
          reserved: "10",
          orders: [entry(), sell(0, "WORKING", 0, "21121")],
          reason: "STOP",
        },
      },
      { kind: "tick", id: "cancel", at: 8000, quote: quote("20000", "20001") },
      {
        kind: "tick",
        id: "replace",
        at: 10000,
        quote: quote("20000", "20001"),
        expect: {
          buys: 4,
          sells: 0,
          paidBuys: 4,
          receivedSells: 0,
          reserved: "10",
          orders: [
            entry(),
            sell(0, "CANCELLED", 0, "21121"),
            sell(1, "WORKING", 0, "20000"),
          ],
        },
      },
      ...[1, 2, 3, 4].map((i): StressStep => ({
        kind: "tick",
        id: `sell-${i}`,
        at: 10000 + i * 1000,
        quote: quote("20000", "20001"),
        expect: {
          buys: 4,
          sells: i,
          paidBuys: 4,
          receivedSells: i - 1,
          sellPrice: "20000",
          reserved: "0",
          orders: [
            entry(),
            sell(0, "CANCELLED", 0, "21121"),
            sell(1, i === 4 ? "FILLED" : "PARTIAL", i, "20000"),
          ],
        },
      })),
      {
        kind: "tick",
        id: "settle",
        at: 15000,
        quote: quote("20000", "20001"),
        expect: {
          buys: 4,
          sells: 4,
          paidBuys: 4,
          receivedSells: 4,
          sellPrice: "20000",
          reserved: "0",
          orders: [
            entry(),
            sell(0, "CANCELLED", 0, "21121"),
            sell(1, "FILLED", 4, "20000"),
          ],
          pnl: "-5620",
          lossStreak: 1,
          status: "HOLD",
          holds: ["EXECUTION_BUDGET_EXCEEDED"],
        },
      },
    ],
  },
  {
    id: "CL-X02",
    description:
      "spread shock, empty bid, latched price block and later partial liquidity",
    steps: [
      ...bought(),
      {
        kind: "tick",
        id: "target-no-bid",
        at: 5000,
        quote: quote("21958", "23000", 0),
      },
      {
        kind: "tick",
        id: "resting-exit",
        at: 6000,
        quote: quote("21958", "23000", 0),
      },
      {
        kind: "tick",
        id: "spread-shock",
        at: 8000,
        quote: quote("18000", "26000", 0),
        expect: {
          buys: 4,
          sells: 0,
          paidBuys: 4,
          receivedSells: 0,
          reserved: "10",
          orders: [entry(), sell(0, "WORKING", 0, "21958")],
          status: "HOLD",
          holds: [
            "EXIT_PRICE_OR_REPLACEMENT_LIMIT",
            "EXECUTION_BUDGET_EXCEEDED",
          ],
        },
      },
      {
        kind: "tick",
        id: "price-only-recovery",
        at: 9000,
        quote: quote("22000", "26000", 0),
        expect: {
          buys: 4,
          sells: 0,
          paidBuys: 4,
          receivedSells: 0,
          reserved: "10",
          orders: [entry(), sell(0, "WORKING", 0, "21958")],
          status: "HOLD",
        },
      },
      {
        kind: "tick",
        id: "one-share-liquidity",
        at: 10000,
        quote: quote("22000", "23000", 1),
        expect: {
          buys: 4,
          sells: 1,
          paidBuys: 4,
          receivedSells: 0,
          sellPrice: "22000",
          reserved: "0",
          orders: [entry(), sell(0, "PARTIAL", 1, "21958")],
          status: "HOLD",
        },
      },
      {
        kind: "tick",
        id: "bid-empty-again",
        at: 11000,
        quote: quote("22000", "23000", 0),
        expect: {
          buys: 4,
          sells: 1,
          paidBuys: 4,
          receivedSells: 1,
          sellPrice: "22000",
          reserved: "0",
          orders: [entry(), sell(0, "PARTIAL", 1, "21958")],
          status: "HOLD",
          holds: [
            "EXIT_PRICE_OR_REPLACEMENT_LIMIT",
            "EXECUTION_BUDGET_EXCEEDED",
          ],
        },
      },
    ],
  },
  {
    id: "CL-X03",
    description:
      "cancel response loss, delayed fill, duplicate delivery and exact reconciliation",
    steps: [
      { kind: "tick", id: "buy-one", at: 1000 },
      { kind: "tick", id: "stop", at: 2000, quote: quote("21121", "21400") },
      {
        kind: "tick",
        id: "request-cancel",
        at: 3000,
        quote: quote("21121", "21400"),
      },
      {
        kind: "event",
        id: "cancel-response-lost",
        at: 3500,
        event: { kind: "CANCEL_UNKNOWN", orderId: "entry" },
      },
      {
        kind: "event",
        id: "late-fill",
        at: 4000,
        event: {
          kind: "FILL",
          orderId: "entry",
          fillId: "delayed-buy",
          quantity: 1,
          price: "21400",
          occurredAt: 3200,
        },
        expect: {
          buys: 2,
          sells: 0,
          paidBuys: 1,
          receivedSells: 0,
          reserved: "42800",
          orders: [entry("CANCEL_UNKNOWN", 2)],
        },
      },
      { kind: "retry", id: "redelivered-fill", ref: "late-fill" },
      {
        kind: "tick",
        id: "cannot-assume-cancelled",
        at: 5000,
        quote: quote("21121", "21400"),
        expect: {
          buys: 2,
          sells: 0,
          paidBuys: 2,
          receivedSells: 0,
          reserved: "42800",
          orders: [entry("CANCEL_UNKNOWN", 2)],
          status: "HOLD",
          holds: ["ORDER_RECONCILIATION_REQUIRED"],
        },
      },
      {
        kind: "event",
        id: "cancel-proof",
        at: 6000,
        event: {
          kind: "CANCEL_CONFIRMED",
          orderId: "entry",
          cumulativeQuantity: 2,
          cumulativeValue: "42800",
          evidenceAt: 6000,
        },
      },
      {
        kind: "tick",
        id: "exit-after-proof",
        at: 7000,
        quote: quote("21121", "21400"),
        expect: {
          buys: 2,
          sells: 0,
          paidBuys: 2,
          receivedSells: 0,
          reserved: "10",
          orders: [entry("CANCELLED", 2), sell(0, "WORKING", 0, "21121", 2)],
        },
      },
      {
        kind: "tick",
        id: "sell-one",
        at: 8000,
        quote: quote("21121", "21400"),
      },
      {
        kind: "tick",
        id: "sell-two",
        at: 9000,
        quote: quote("21121", "21400"),
      },
      {
        kind: "tick",
        id: "settle",
        at: 10000,
        quote: quote("21121", "21400"),
        expect: {
          buys: 2,
          sells: 2,
          paidBuys: 2,
          receivedSells: 2,
          sellPrice: "21121",
          reserved: "0",
          orders: [entry("CANCELLED", 2), sell(0, "FILLED", 2, "21121", 2)],
          pnl: "-578",
          lossStreak: 1,
          status: "CLOSED",
          holds: [],
        },
      },
    ],
  },
  {
    id: "CL-X04",
    description: "no input, halt past holding deadline and reopening gap",
    steps: [
      ...bought(),
      {
        kind: "tick",
        id: "halt",
        at: 5000,
        quote: { ...quote("20000", "20001"), halted: true },
      },
      { kind: "silence", id: "no-scheduler", until: 5401000 },
      {
        kind: "tick",
        id: "halted-at-deadline",
        at: 5401000,
        quote: { ...quote("19000", "19001"), halted: true },
        expect: {
          buys: 4,
          sells: 0,
          paidBuys: 4,
          receivedSells: 0,
          reserved: "0",
          orders: [entry()],
          reason: "TIME",
          status: "HOLD",
          holds: ["HALTED_QUOTE", "RISK_HISTORY_RECONCILIATION_REQUIRED"],
        },
      },
      {
        kind: "tick",
        id: "reopen-gap",
        at: 5402000,
        quote: quote("19000", "19001"),
        expect: {
          buys: 4,
          sells: 0,
          paidBuys: 4,
          receivedSells: 0,
          reserved: "10",
          orders: [entry(), sell(0, "WORKING", 0, "19000")],
          reason: "TIME",
          status: "HOLD",
        },
      },
      ...[1, 2, 3, 4].map((i): StressStep => ({
        kind: "tick",
        id: `sell-${i}`,
        at: 5402000 + i * 1000,
        quote: quote("19000", "19001"),
      })),
      {
        kind: "tick",
        id: "settle",
        at: 5407000,
        quote: quote("19000", "19001"),
        expect: {
          buys: 4,
          sells: 4,
          paidBuys: 4,
          receivedSells: 4,
          sellPrice: "19000",
          reserved: "0",
          orders: [entry(), sell(0, "FILLED", 4, "19000")],
          pnl: "-9620",
          lossStreak: 1,
          status: "HOLD",
          holds: [
            "RISK_HISTORY_RECONCILIATION_REQUIRED",
            "EXECUTION_BUDGET_EXCEEDED",
          ],
        },
      },
    ],
  },
  {
    id: "CL-X05",
    description:
      "reopen, original tick receipt, out-of-order fill and conflicting redelivery",
    steps: [
      { kind: "tick", id: "buy-one", at: 2000 },
      { kind: "tick", id: "buy-two", at: 3000 },
      { kind: "restart", id: "restart-one" },
      { kind: "retry", id: "retry-old-tick", ref: "buy-two" },
      {
        kind: "event",
        id: "delayed-earlier-fill",
        at: 4000,
        event: {
          kind: "FILL",
          orderId: "entry",
          fillId: "earlier-buy",
          quantity: 1,
          price: "21400",
          occurredAt: 1500,
        },
        expect: {
          buys: 3,
          sells: 0,
          paidBuys: 1,
          receivedSells: 0,
          reserved: "21400",
          orders: [entry("PARTIAL", 3)],
        },
      },
      { kind: "retry", id: "redelivery-new-id", ref: "delayed-earlier-fill" },
      {
        kind: "fill-conflict",
        id: "changed-price",
        ref: "delayed-earlier-fill",
      },
      {
        kind: "tick",
        id: "settle-only",
        at: 5000,
        quote: { askSize: 0 },
        expect: {
          buys: 3,
          sells: 0,
          paidBuys: 3,
          receivedSells: 0,
          reserved: "21400",
          orders: [entry("PARTIAL", 3)],
          deadlineOffset: 5401500,
        },
      },
      {
        kind: "event",
        id: "cancel",
        at: 6000,
        event: { kind: "CANCEL_REQUEST", orderId: "entry" },
      },
      { kind: "restart", id: "restart-two" },
      {
        kind: "event",
        id: "unknown-cancel",
        at: 7500,
        event: { kind: "CANCEL_UNKNOWN", orderId: "entry" },
      },
      {
        kind: "tick",
        id: "still-unknown",
        at: 10000,
        quote: { askSize: 0 },
        expect: {
          buys: 3,
          sells: 0,
          paidBuys: 3,
          receivedSells: 0,
          reserved: "21400",
          orders: [entry("CANCEL_UNKNOWN", 3)],
          status: "HOLD",
          holds: [
            "ORDER_RECONCILIATION_REQUIRED",
            "RISK_HISTORY_RECONCILIATION_REQUIRED",
          ],
        },
      },
      {
        kind: "tick",
        id: "corrected-deadline-before",
        at: 5401499,
        quote: { askSize: 0 },
        expect: {
          buys: 3,
          sells: 0,
          paidBuys: 3,
          receivedSells: 0,
          reserved: "21400",
          orders: [entry("CANCEL_UNKNOWN", 3)],
          reason: null,
          deadlineOffset: 5401500,
        },
      },
      {
        kind: "tick",
        id: "corrected-deadline-at",
        at: 5401500,
        quote: { askSize: 0 },
        expect: {
          buys: 3,
          sells: 0,
          paidBuys: 3,
          receivedSells: 0,
          reserved: "21400",
          orders: [entry("CANCEL_UNKNOWN", 3)],
          reason: "TIME",
          deadlineOffset: 5401500,
          status: "HOLD",
          holds: [
            "ORDER_RECONCILIATION_REQUIRED",
            "RISK_HISTORY_RECONCILIATION_REQUIRED",
          ],
        },
      },
    ],
  },
];
