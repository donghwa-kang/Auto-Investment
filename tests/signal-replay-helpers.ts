import { makeSignalReplayFixture } from "../src/core/signal-replay-fixture.js";
import { prepareSignalHistory } from "../src/core/signal-history.js";
import { runMultiPreflight } from "../src/core/multi-preflight.js";
import type { SignalReplayInput } from "../src/core/signal-replay-schema.js";
import { minute } from "../src/core/calendar.js";

// 경계 시험의 명시적 짧은 과거 세션. 세션 수 120은 줄이지 않는다.
// CLI 수용시험은 축약하지 않은 390분 세션 원본 샘플을 사용한다.
const seed = makeSignalReplayFixture();
for (const h of seed.histories)
  for (const s of h.sessions.slice(0, -1)) {
    s.closeAt = s.openAt + 60 * minute;
    s.rows = s.rows.filter((r) => r.offset < 60);
  }
export function replayFixture() {
  return structuredClone(seed);
}
export function lastOnly() {
  const f = replayFixture();
  f.frames = f.frames.slice(-1);
  return f;
}
export function prepare(
  f: SignalReplayInput,
  index = 0,
  frameIndex = f.frames.length - 1,
) {
  const frame = f.frames[frameIndex]!,
    asset = frame.market!.assets[index]!;
  const report = runMultiPreflight(frame);
  return prepareSignalHistory(
    f.histories.find((h) => h.assetKey === asset.assetKey),
    asset,
    Date.parse(frame.asOf),
    report.stageReports
      .market!.items.find((i) => i.assetKey === asset.assetKey)!
      .selected.map((s) => s.record),
  );
}
