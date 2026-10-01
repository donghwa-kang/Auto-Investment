import { z } from "zod";
import { positiveCostAmountSchema } from "./transaction-cost.js";
import { costExecutionConfigSchema } from "./cost-execution.js";

const time = costExecutionConfigSchema.shape.initialAt;
export const costLoopConfigSchema = z.strictObject({
  kind: z.literal("SYNTHETIC_COST_LOOP_V1"),
  purpose: z.literal("TEST_ONLY"),
  cancelLatencyMs: z.literal(2000),
  watchdog: z.literal(true).optional(),
});
export type CostLoopConfig = z.infer<typeof costLoopConfigSchema>;
export const costLoopCloseContract = "SYNTHETIC_S7_D8_SINGLE_CLOSE_V1";
// A distinct opt-in contract: never reinterpret a V3 loop as a V4 ledger.
export const costOperatingLoopConfigSchema = costLoopConfigSchema.extend({
  kind: z.literal("SYNTHETIC_COST_OPERATING_LOOP_V1"),
  signalBasisHash: z.string().regex(/^[a-f0-9]{64}$/),
  closeContract: z.literal(costLoopCloseContract).optional(),
});
export type CostOperatingLoopConfig = z.infer<
  typeof costOperatingLoopConfigSchema
>;
export const costLoopTickSchema = z.strictObject({
  kind: z.literal("COST_LOOP_TICK"),
  purpose: z.literal("TEST_ONLY"),
  instrument: costExecutionConfigSchema.shape.instrument,
  at: time,
  quote: z.strictObject({
    at: time,
    bid: positiveCostAmountSchema,
    ask: positiveCostAmountSchema,
    bidSize: z.number().int().min(0).max(1e9),
    askSize: z.number().int().min(0).max(1e9),
    halted: z.boolean(),
  }),
});
export type CostLoopTick = z.infer<typeof costLoopTickSchema>;
export const costLoopPulseSchema = z.strictObject({
  kind: z.literal("COST_LOOP_PULSE"),
  purpose: z.literal("TEST_ONLY"),
  instrument: costExecutionConfigSchema.shape.instrument,
  at: time,
});
export type CostLoopPulse = z.infer<typeof costLoopPulseSchema>;
export interface CostLoopState {
  config: CostLoopConfig | CostOperatingLoopConfig;
  lastTickAt: number | null;
  ticks: number;
  reason: "STOP" | "TARGET" | "TIME" | "RISK" | null;
  triggeredAt: number | null;
  referenceBid: string | null;
  target: string | null;
  deadline: number | null;
  exitBlocked: boolean;
  status: "WAITING" | "WATCHING" | "EXITING" | "CLOSED" | "HOLD";
  holds: string[];
  watchdog?: {
    lastQuoteAt: number | null;
    lastPulseAt: number | null;
    pulses: number;
    holds: string[];
  };
}
