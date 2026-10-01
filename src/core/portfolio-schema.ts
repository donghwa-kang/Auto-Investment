import { z } from "zod";
import { d } from "./math.js";
import { configSchema } from "./policy.js";
import { replayDigest } from "./signal-replay-schema.js";

const time = z.number().int().nonnegative().max(8_640_000_000_000_000);
const decimal = z
  .string()
  .max(32)
  .regex(/^\d{1,18}(\.\d{1,12})?$/)
  .refine((x) => d(x).isFinite());
const key = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[A-Za-z0-9:._-]+$/);
export const portfolioSettingsSchema = z.strictObject({
  purpose: z.literal("TEST_ONLY"),
  // 고정 합성 비용·예측·체결 모형 전체에 대한 명시적 동의/버전 결합.
  syntheticProfileHash: replayDigest.nullable(),
  candidateOrder: z.array(key).min(1).max(8).nullable(),
  candidateOrderMeaning: z.literal("TEST_SEQUENCE_NOT_INVESTMENT_RANKING"),
  config: configSchema.refine(
    (c) => c.mode === "PAPER" && c.scenario === "B" && c.market === "KR",
    "PORTFOLIO_CONFIG_BASE_ONLY",
  ),
});
export type PortfolioSettings = z.infer<typeof portfolioSettingsSchema>;
export const portfolioTickSchema = z
  .strictObject({
    type: z.literal("tick"),
    at: time,
    accountAt: time,
    fx: z.strictObject({ rate: decimal.refine((x) => d(x).gt(0)), at: time }),
    quotes: z
      .array(
        z.strictObject({
          catalogKey: key,
          sourceId: key,
          availableAt: time,
          quote: z
            .strictObject({
              bid: decimal.refine((x) => d(x).gt(0)),
              ask: decimal.refine((x) => d(x).gt(0)),
              bidSize: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER),
              askSize: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER),
              lastMinuteVolume: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER),
              at: time,
              halted: z.boolean(),
            })
            .refine((q) => d(q.ask).gte(q.bid)),
        }),
      )
      .max(8),
    frameAsOf: time.nullable(),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.quotes.map((q) => q.catalogKey)).size !== v.quotes.length)
      ctx.addIssue({ code: "custom", message: "DUPLICATE_QUOTE" });
    if (v.frameAsOf !== null && v.frameAsOf !== v.at)
      ctx.addIssue({ code: "custom", message: "FRAME_TIME_MISMATCH" });
  });
export const portfolioCommandSchema = z.discriminatedUnion("type", [
  portfolioTickSchema,
  z.strictObject({ type: z.literal("start") }),
  z.strictObject({ type: z.literal("pause") }),
  z.strictObject({ type: z.literal("reconcile") }),
  z.strictObject({ type: z.literal("liquidate"), confirm: z.literal(true) }),
]);
export type PortfolioTick = z.infer<typeof portfolioTickSchema>;
