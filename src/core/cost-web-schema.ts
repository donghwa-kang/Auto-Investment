import { z } from "zod";

const id = z.string().uuid();
export const costWebRecipeSchema = z.enum([
  "COST_WEB_SYNTHETIC_KRW_V1",
  "COST_WEB_OPERATING_KRW_V1",
]);
export const costWebControlSchema = z.strictObject({
  type: z.literal("control"),
  runId: id,
  id,
  expectedControl: z.number().int().min(0).max(100),
  action: z.enum(["START", "STOP", "FEED_OFF", "FEED_ON"]),
});
export const costWebRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create"),
    id,
    acknowledgeSynthetic: z.literal(true),
    recipe: costWebRecipeSchema.optional(),
  }),
  z.strictObject({ type: z.literal("open"), runId: id }),
  costWebControlSchema,
  z.strictObject({
    type: z.literal("verify"),
    runId: id,
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
export const costWebRecordSchema = z.strictObject({
  id,
  createdAt: z.string().datetime(),
  recipe: costWebRecipeSchema,
});
export type CostWebRequest = z.infer<typeof costWebRequestSchema>;
export type CostWebControl = z.infer<typeof costWebControlSchema>;
export type CostWebRecord = z.infer<typeof costWebRecordSchema>;
