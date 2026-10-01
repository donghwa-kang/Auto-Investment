import { z } from "zod";

export const webSetupSchema = z
  .strictObject({
    capital: z.number().int().positive().max(5_000_000),
    usdCapitalKrw: z.number().int().nonnegative(),
    level: z.enum(["LOW", "MEDIUM", "HIGH"]),
    stage: z.enum(["PILOT", "STANDARD"]),
    forecast: z.enum(["MISSING_PROFILE", "TEST_ONLY"]),
    sampleMarket: z.enum(["KR", "US"]),
    acknowledgeSynthetic: z.literal(true),
  })
  .refine(
    (s) => s.usdCapitalKrw <= s.capital * 0.4,
    "USD_ALLOCATION_MAX_40_PERCENT",
  );
export type WebSetup = z.infer<typeof webSetupSchema>;
export const webCheckpointSchema = z.strictObject({
  recipeHash: z.string().regex(/^[a-f0-9]{64}$/),
  index: z.number().int().min(0).max(10000),
  entryEnabled: z.boolean(),
  reconciledEpoch: z.number().int().nonnegative(),
});
export type WebCheckpoint = z.infer<typeof webCheckpointSchema>;
export const webActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start") }),
  z.strictObject({ type: z.literal("pause") }),
  z.strictObject({ type: z.literal("freeze") }),
  z.strictObject({ type: z.literal("protect") }),
  z.strictObject({ type: z.literal("reconcile") }),
  z.strictObject({ type: z.literal("liquidate"), confirm: z.literal(true) }),
]);
export type WebAction = z.infer<typeof webActionSchema>;
export const runIdSchema = z.string().uuid();
export const webRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create"),
    id: runIdSchema,
    setup: webSetupSchema,
  }),
  z.strictObject({ type: z.literal("open"), runId: runIdSchema }),
  z.strictObject({
    type: z.literal("control"),
    runId: runIdSchema,
    id: runIdSchema,
    action: webActionSchema,
  }),
]);
