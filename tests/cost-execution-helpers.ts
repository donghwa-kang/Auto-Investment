import { policyHash } from "../src/core/policy.js";
import { costExecutionKind } from "../src/core/cost-execution.js";
import type {
  CostExecutionConfig,
  CostExecutionEvent,
} from "../src/core/cost-execution.js";
import { costAt, costProfile } from "./transaction-cost-helpers.js";
export function executionConfig(
  unit: "ORDER" | "FILL" = "ORDER",
  market: "KR" | "US" = "KR",
): CostExecutionConfig {
  const profile = costProfile(market);
  profile.rules.forEach((r) => {
    r.unit = unit;
    r.tiers[0]!.rate = "0";
    if (r.component === "COMMISSION") r.minimum = "10";
  });
  return {
    kind: costExecutionKind,
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    liveEnabled: false,
    policyHash,
    instrument: "SYNTHETIC-COST-INSTRUMENT",
    initialAt: costAt,
    initialCash: "100000",
    settlement: "SYNTHETIC_IMMEDIATE",
    profile,
  };
}
export function executionEvents(): CostExecutionEvent[] {
  const at = (seq: number) => costAt + seq;
  return [
    {
      id: "e1",
      seq: 1,
      at: at(1),
      kind: "ORDER",
      orderId: "buy",
      side: "BUY",
      quantity: 4,
      limit: "1000",
      replaces: null,
    },
    {
      id: "e2",
      seq: 2,
      at: at(2),
      kind: "FILL",
      orderId: "buy",
      fillId: "buy-fill1",
      quantity: 1,
      price: "1000",
      occurredAt: at(2),
    },
    {
      id: "e3",
      seq: 3,
      at: at(3),
      kind: "FILL",
      orderId: "buy",
      fillId: "buy-fill2",
      quantity: 1,
      price: "1000",
      occurredAt: at(3),
    },
    { id: "e4", seq: 4, at: at(4), kind: "CANCEL_REQUEST", orderId: "buy" },
    { id: "e5", seq: 5, at: at(5), kind: "CANCEL_UNKNOWN", orderId: "buy" },
    {
      id: "e6",
      seq: 6,
      at: at(6),
      kind: "CANCEL_CONFIRMED",
      orderId: "buy",
      cumulativeQuantity: 2,
      cumulativeValue: "2000",
      evidenceAt: at(6),
    },
    {
      id: "e7",
      seq: 7,
      at: at(7),
      kind: "ORDER",
      orderId: "sell",
      side: "SELL",
      quantity: 2,
      limit: "1100",
      replaces: null,
    },
    {
      id: "e8",
      seq: 8,
      at: at(8),
      kind: "FILL",
      orderId: "sell",
      fillId: "sell-fill1",
      quantity: 1,
      price: "1100",
      occurredAt: at(8),
    },
    { id: "e9", seq: 9, at: at(9), kind: "CANCEL_REQUEST", orderId: "sell" },
    {
      id: "e10",
      seq: 10,
      at: at(10),
      kind: "CANCEL_CONFIRMED",
      orderId: "sell",
      cumulativeQuantity: 1,
      cumulativeValue: "1100",
      evidenceAt: at(10),
    },
    {
      id: "e11",
      seq: 11,
      at: at(11),
      kind: "ORDER",
      orderId: "sell-replace",
      side: "SELL",
      quantity: 1,
      limit: "1100",
      replaces: "sell",
    },
    {
      id: "e12",
      seq: 12,
      at: at(12),
      kind: "FILL",
      orderId: "sell-replace",
      fillId: "sell-fill2",
      quantity: 1,
      price: "1100",
      occurredAt: at(12),
    },
  ];
}
