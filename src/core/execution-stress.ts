import { z } from "zod";
import { d } from "./math.js";
import { profile } from "./risk.js";
import type { Quote } from "./types.js";

// 실측 추정치나 정책이 아닌, 별도 실행에 명시적으로 결합하는 합성 시험 조건.
export const executionStressSchema = z.strictObject({
  schemaVersion: z.literal("OFFLINE_EXECUTION_STRESS_V1"),
  purpose: z.literal("TEST_ONLY"),
  latencyMs: z.number().int().min(0).max(60000),
  cancelLatencyMs: z.number().int().min(0).max(60000),
  adverseTicks: z.number().int().min(0).max(100),
  liquidityBps: z.number().int().min(0).max(10000),
});
export type ExecutionStress = z.infer<typeof executionStressSchema>;

export function stressProfiles() {
  const control = executionStressSchema.parse({
    schemaVersion: "OFFLINE_EXECUTION_STRESS_V1",
    purpose: "TEST_ONLY",
    latencyMs: 0,
    cancelLatencyMs: 2000,
    adverseTicks: 0,
    liquidityBps: 10000,
  });
  return {
    CONTROL: control,
    ADVERSE: {
      ...control,
      latencyMs: 500,
      cancelLatencyMs: 3000,
      adverseTicks: 2,
      liquidityBps: 5000,
    },
    EXTREME: {
      ...control,
      latencyMs: 2500,
      cancelLatencyMs: 5000,
      adverseTicks: 5,
      liquidityBps: 1000,
    },
  };
}

export function stressQuote(
  q: Quote,
  market: "KR" | "US",
  stress: ExecutionStress,
): Quote {
  const shift = d(profile.ticks[market]).mul(stress.adverseTicks);
  const bid = d(q.bid).minus(shift),
    ask = d(q.ask).plus(shift);
  if (!bid.isFinite() || !ask.isFinite() || bid.lte(0) || ask.lt(bid))
    throw new Error("STRESS_QUOTE_INVALID");
  // 시각을 새로 만들지 않는다. 미래/지연/정지 판정은 원본 관측 근거를 유지한다.
  return {
    ...q,
    bid: bid.toString(),
    ask: ask.toString(),
    bidSize: d(q.bidSize)
      .mul(stress.liquidityBps)
      .div(10000)
      .floor()
      .toNumber(),
    askSize: d(q.askSize)
      .mul(stress.liquidityBps)
      .div(10000)
      .floor()
      .toNumber(),
  };
}
