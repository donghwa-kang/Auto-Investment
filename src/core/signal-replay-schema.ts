import { z } from "zod";
import {
  CatalogError,
  catalogIdentifierSchema as id,
} from "./catalog-schema.js";
import { qualityIdentitySchema } from "./market-quality-schema.js";
import { multiPreflightSchema } from "./multi-preflight-schema.js";
import { d } from "./math.js";

// 자원 상한은 투자 기준과 별개다. 파일별 16 MiB 제한은 기존 로컬 리더를 유지한다.
export const MAX_REPLAY_ASSETS = 8;
export const MAX_REPLAY_FRAMES = 8;
export const MAX_HISTORY_ROWS = 110_000;
const epoch = z.number().int().min(0).max(8_640_000_000_000_000);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const replayDigest = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z
  .string()
  .max(32)
  .regex(/^-?\d{1,18}(\.\d{1,12})?$/)
  .transform((v) => d(v).toFixed());
const row = z.strictObject({
  offset: z.number().int().min(0).max(1440),
  observedAt: epoch,
  receivedAt: epoch,
  availableAt: epoch,
  revision,
  o: decimal.nullable(),
  h: decimal.nullable(),
  l: decimal.nullable(),
  c: decimal.nullable(),
  v: decimal.nullable(),
  completed: z.boolean(),
  halted: z.boolean().nullable(),
});
export const signalHistorySchema = z
  .strictObject({
    schemaVersion: z.literal("OFFLINE_SIGNAL_HISTORY_V1"),
    purpose: z.literal("TEST_ONLY"),
    datasetId: id,
    assetKey: id,
    identity: qualityIdentitySchema,
    sourceId: id,
    basis: z.enum(["RAW", "ADJUSTED", "UNKNOWN"]),
    sessions: z
      .array(
        z.strictObject({
          sessionId: id,
          openAt: epoch,
          closeAt: epoch,
          availableAt: epoch,
          rows: z.array(row).max(MAX_HISTORY_ROWS),
        }),
      )
      .max(260),
    actionCoverage: z
      .strictObject({
        from: epoch,
        to: epoch,
        availableAt: epoch,
        status: z.enum(["KNOWN", "UNKNOWN"]),
      })
      .nullable(),
    actions: z
      .array(
        z.strictObject({
          eventId: id,
          revision,
          announcedAt: epoch,
          availableAt: epoch,
          effectiveAt: epoch,
          kind: z.enum(["SPLIT", "UNSUPPORTED"]),
          ratio: decimal.nullable(),
          cancelled: z.boolean(),
        }),
      )
      .max(1024),
  })
  .superRefine((h, ctx) => {
    if (h.sessions.reduce((n, s) => n + s.rows.length, 0) > MAX_HISTORY_ROWS)
      ctx.addIssue({ code: "custom", message: "HISTORY_RESOURCE_LIMIT" });
    if (new Set(h.sessions.map((s) => s.sessionId)).size !== h.sessions.length)
      ctx.addIssue({ code: "custom", message: "DUPLICATE_SESSION_ID" });
  });
export const replayHeader = {
  purpose: z.literal("TEST_ONLY"),
  experimentId: id,
  profileHash: replayDigest.nullable(),
  policyHash: z
    .string()
    .regex(/^[A-F0-9]{64}$/)
    .nullable(),
  strategyDefinitionHash: z
    .string()
    .regex(/^[A-F0-9]{64}$/)
    .nullable(),
  frames: z.array(multiPreflightSchema).min(1).max(MAX_REPLAY_FRAMES),
};
export const signalReplaySchema = z
  .strictObject({
    schemaVersion: z.literal("OFFLINE_SIGNAL_REPLAY_V1"),
    ...replayHeader,
    histories: z.array(signalHistorySchema).max(MAX_REPLAY_ASSETS),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.histories.map((h) => h.assetKey)).size !== v.histories.length)
      ctx.addIssue({ code: "custom", message: "DUPLICATE_HISTORY_ASSET" });
    if (new Set(v.frames.map((f) => f.asOf)).size !== v.frames.length)
      ctx.addIssue({ code: "custom", message: "DUPLICATE_REPLAY_TIME" });
    if (
      v.frames.some((f) => (f.market?.assets.length ?? 0) > MAX_REPLAY_ASSETS)
    )
      ctx.addIssue({ code: "custom", message: "REPLAY_ASSET_LIMIT" });
    const slots = v.histories.reduce(
      (n, h) =>
        n +
        h.sessions.reduce(
          (m, s) => m + Math.max(0, Math.ceil((s.closeAt - s.openAt) / 60000)),
          0,
        ),
      0,
    );
    if (slots * v.frames.length > 2_000_000)
      ctx.addIssue({ code: "custom", message: "REPLAY_WORK_LIMIT" });
  });
export type SignalHistory = z.infer<typeof signalHistorySchema>;
export type HistoryRow = SignalHistory["sessions"][number]["rows"][number];
export type SignalReplayInput = z.infer<typeof signalReplaySchema>;
export function parseSignalReplay(raw: unknown) {
  const parsed = signalReplaySchema.safeParse(raw);
  if (!parsed.success) throw new CatalogError("SIGNAL_REPLAY_INPUT_INVALID");
  if (
    parsed.data.frames.some(
      (f) =>
        f.asOf !== f.enrichment.catalog.asOf ||
        (f.market && f.asOf !== f.market.asOf),
    )
  )
    throw new CatalogError("MULTI_PREFLIGHT_AS_OF_MISMATCH");
  return parsed.data;
}
