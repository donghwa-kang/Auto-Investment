import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  CatalogError,
  catalogIdentifierSchema as id,
} from "../core/catalog-schema.js";
import { hash } from "../core/policy.js";
import {
  MAX_REPLAY_ASSETS,
  replayHeader,
  replayDigest,
  signalHistorySchema,
} from "../core/signal-replay-schema.js";
import { readCatalogFile } from "./catalog-file.js";

export const replayManifestSchema = z.strictObject({
  schemaVersion: z.literal("OFFLINE_SIGNAL_REPLAY_MANIFEST_V1"),
  ...replayHeader,
  histories: z
    .array(
      z.strictObject({
        assetKey: id,
        // 명시한 매니페스트와 같은 디렉터리의 JSON만 허용한다. 경로 탐색/URL/장치 경로 금지.
        file: z
          .string()
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/),
        snapshotHash: replayDigest,
      }),
    )
    .max(MAX_REPLAY_ASSETS),
});
export function loadSignalReplay(path: string) {
  const parsed = replayManifestSchema.safeParse(readCatalogFile(path));
  if (!parsed.success) throw new CatalogError("SIGNAL_REPLAY_MANIFEST_INVALID");
  const manifest = parsed.data;
  if (
    new Set(manifest.histories.map((h) => h.file)).size !==
      manifest.histories.length ||
    new Set(manifest.histories.map((h) => h.assetKey)).size !==
      manifest.histories.length
  )
    throw new CatalogError("SIGNAL_REPLAY_DUPLICATE_FILE_BINDING");
  const histories = manifest.histories.map((link) => {
    const parsed = signalHistorySchema.safeParse(
      readCatalogFile(resolve(dirname(path), link.file)),
    );
    if (!parsed.success) throw new CatalogError("SIGNAL_HISTORY_INPUT_INVALID");
    if (
      parsed.data.assetKey !== link.assetKey ||
      hash(parsed.data) !== link.snapshotHash
    )
      throw new CatalogError("SIGNAL_HISTORY_SNAPSHOT_MISMATCH");
    return parsed.data;
  });
  return { ...manifest, schemaVersion: "OFFLINE_SIGNAL_REPLAY_V1", histories };
}
