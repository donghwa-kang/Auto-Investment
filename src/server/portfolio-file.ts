import { z } from "zod";
import { dirname, resolve } from "node:path";
import {
  portfolioSettingsSchema,
  portfolioCommandSchema,
} from "../core/portfolio-schema.js";
import {
  parseSignalReplay,
  replayDigest,
} from "../core/signal-replay-schema.js";
import { hash } from "../core/policy.js";
import { readCatalogFile } from "./catalog-file.js";
import { loadSignalReplay } from "./signal-replay-file.js";

export const portfolioPlanSchema = z.strictObject({
  schemaVersion: z.literal("OFFLINE_PORTFOLIO_PLAN_V1"),
  purpose: z.literal("TEST_ONLY"),
  replayFile: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/),
  replayInputHash: replayDigest,
  settings: portfolioSettingsSchema,
  commands: z.array(portfolioCommandSchema).min(1).max(10000),
});
export function loadPortfolioPlan(path: string) {
  const plan = portfolioPlanSchema.parse(readCatalogFile(path));
  const input = parseSignalReplay(
    loadSignalReplay(resolve(dirname(path), plan.replayFile)),
  );
  if (hash(input) !== plan.replayInputHash)
    throw new Error("PORTFOLIO_REPLAY_BINDING");
  return { plan, input };
}
