import { z } from "zod";
import { signalHistorySchema, replayDigest } from "./signal-replay-schema.js";

export const rvolSourceSchema = z.strictObject({
  schemaVersion: z.literal("LEARNING_RVOL_SOURCE_V1"),
  purpose: z.literal("TEST_ONLY"),
  decisionId: z.string().min(1).max(220),
  symbol: z.string().min(1).max(220),
  asOf: z.number().int().nonnegative().max(8_640_000_000_000_000),
  signalAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  dataVersion: replayDigest,
  sourceDataHash: replayDigest,
  historyEvidenceHash: replayDigest,
  strategyHash: replayDigest,
  replayProfileHash: replayDigest,
  numericProfile: z.literal("DECIMAL40_V1"),
  // 전체 이력이 아니라 세션 목록과 RVOL에 필요한 21 × 15개의 원본 봉을 보존한다.
  history: signalHistorySchema.refine(
    (h) => h.sessions.reduce((n, s) => n + s.rows.length, 0) <= 315,
    "RVOL_SOURCE_RESOURCE_LIMIT",
  ),
  sourceHash: replayDigest,
});
export type RvolSource = z.infer<typeof rvolSourceSchema>;
export type RvolContext = Pick<
  RvolSource,
  | "decisionId"
  | "symbol"
  | "asOf"
  | "signalAt"
  | "dataVersion"
  | "sourceDataHash"
  | "historyEvidenceHash"
>;
export class RvolSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
