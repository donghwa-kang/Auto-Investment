import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { hash } from "../core/policy.js";
import { IngestError } from "../core/source-ingest-schema.js";
import type { IngestReport } from "../core/source-ingest.js";

// 매번 새 디렉터리에 단일 결과를 쓰고 완료 파일명으로 게시한다. 기존 DB/결과를 열지 않는다.
export function saveSourceIngest(report: IngestReport, base = process.cwd()) {
  let fd: number | undefined;
  try {
    const { reportHash, ...content } = report;
    if (
      content.purpose !== "MOCK_CONTRACT" ||
      content.dataOrigin !== "MOCK_RESPONSE" ||
      content.liveEnabled !== false ||
      content.paperOrdersEnabled !== false ||
      content.realDataReady !== false ||
      content.strategyReady !== false ||
      content.strategyEvaluated !== false ||
      content.historicalPointInTimeVerified !== false ||
      content.corporateActionsVerified !== false ||
      content.networkRequests !== 0 ||
      content.sourceAuthentication !== "UNVERIFIED_MOCK" ||
      hash(content) !== reportHash
    )
      throw new Error();
    const json = JSON.stringify(report, null, 2) + "\n";
    if (Buffer.byteLength(json) > 64 * 1024 * 1024) throw new Error();
    const root = resolve(base, "data", "source-ingest-checks");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "run-"));
    const temporary = join(directory, "report.partial");
    const reportPath = join(directory, "report.json");
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, json);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, reportPath);
    return reportPath;
  } catch {
    throw new IngestError("INGEST_SAVE_FAILED");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
