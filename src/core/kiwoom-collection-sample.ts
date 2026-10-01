import { kiwoomMockSample } from "./kiwoom-ingest-sample.js";
import type { KiwoomCollectionInput } from "./kiwoom-collection.js";

// 자체 합성값만 시간순으로 배치한다. 실제 지연의 측정 표본이 아니다.
export function kiwoomCollectionSample(): KiwoomCollectionInput {
  const sourceInput = kiwoomMockSample();
  const start = Date.parse("2026-09-21T14:00:00Z");
  const time = (ms: number) => new Date(start + ms).toISOString();
  sourceInput.captures.forEach((c, i) => {
    const offset = [0, 500, 1_000, 2_000][i]!;
    c.requestedAt = time(offset);
    c.receivedAt = time(offset + 100);
    c.availableAt = time(offset + 200);
    c.connectionEpoch = i === 3 ? 1 : 0;
  });
  sourceInput.asOf = time(3_000);
  return {
    schemaVersion: "OFFLINE_KIWOOM_COLLECTION_V1",
    purpose: "MOCK_CONTRACT",
    limitProfile: "PUBLISHED_QUERY_LIMITS",
    startedAt: time(0),
    deadlineAt: time(5_000),
    maxAttempts: 8,
    maxPagesPerChain: 4,
    minIntervalMs: 250,
    faultCooldownMs: 1_000,
    sourceInput,
    events: [
      ...sourceInput.captures
        .slice(0, 3)
        .map((c) => ({ kind: "ATTEMPT" as const, captureId: c.captureId })),
      { kind: "PAUSE", at: time(1_500) },
      { kind: "RESUME", at: time(1_750), connectionEpoch: 1 },
      { kind: "ATTEMPT", captureId: sourceInput.captures[3]!.captureId },
      { kind: "STOP", at: time(2_500) },
    ],
  };
}
