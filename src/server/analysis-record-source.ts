import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash } from "../core/policy.js";
import { exportPaperLearning } from "./paper-learning-export.js";
import { verifyPaperExport } from "../core/paper-learning-verify.js";
import { buildRecordBundle } from "../core/analysis-records.js";
import type {
  RecordBundle,
  RecordPeriod,
  RecordSourceInfo,
} from "../core/analysis-record-schema.js";

const runId = z.string().regex(/^run-[A-Za-z0-9_-]{6,40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceLimit = 16 * 1024 * 1024;
function localPath(path: string) {
  const full = resolve(path);
  if (full.startsWith("\\\\")) throw new Error("ANALYSIS_SOURCE_PATH_DENIED");
  for (let p = full; p !== parse(p).root; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw new Error("ANALYSIS_SOURCE_PATH_DENIED");
  }
  return full;
}
function regularFile(path: string, max: number) {
  localPath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max)
    throw new Error("ANALYSIS_SOURCE_FILE_INVALID");
  return path;
}

export class AnalysisRecordSources {
  constructor(
    readonly runsRoot: string,
    readonly archiveRoot: string,
  ) {}
  list() {
    const root = localPath(this.runsRoot);
    if (!existsSync(root)) return { runs: [] as string[] };
    const entries = readdirSync(root, { withFileTypes: true });
    if (entries.length > 100) throw new Error("ANALYSIS_SOURCE_LIST_LIMIT");
    // 목록 조회는 DB를 열지 않는다. 사용자가 하나를 고른 뒤에만 내용을 읽는다.
    return {
      runs: entries
        .filter((e) => e.isDirectory() && runId.safeParse(e.name).success)
        .map((e) => e.name)
        .sort(),
    };
  }
  inspect(raw: unknown): RecordSourceInfo {
    const c = z.strictObject({ type: z.literal("inspect"), runId }).parse(raw);
    const path = regularFile(
      resolve(localPath(this.runsRoot), c.runId, "paper.sqlite"),
      256 * 1024 * 1024,
    );
    const source = exportPaperLearning(path);
    const body = JSON.stringify(source);
    if (Buffer.byteLength(body) > sourceLimit)
      throw new Error("ANALYSIS_SOURCE_SIZE");
    const root = localPath(this.archiveRoot);
    mkdirSync(root, { recursive: true });
    const id = source.exportHash.toLowerCase(),
      target = resolve(root, `${id}.json`);
    if (existsSync(target)) {
      if (hash(this.read(id)) !== hash(source))
        throw new Error("ANALYSIS_SOURCE_CHANGED");
    } else {
      const entries = readdirSync(root);
      const bytes = entries.reduce(
        (n, name) => n + lstatSync(resolve(root, name)).size,
        0,
      );
      if (
        entries.length >= 10 ||
        bytes + Buffer.byteLength(body) > 64 * 1024 * 1024
      )
        throw new Error("ANALYSIS_SOURCE_ARCHIVE_LIMIT");
      const temp = resolve(root, `${id}.${randomUUID()}.partial`),
        fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // 동일 서버의 동기 경로와 분석 writer 소유권 아래 게시한다. 실패한 partial은 보존한다.
      if (existsSync(target))
        throw new Error("ANALYSIS_SOURCE_PUBLISH_CONFLICT");
      renameSync(temp, target);
    }
    return {
      sourceId: id,
      runHash: source.journal.runHash.toLowerCase(),
      from: new Date(source.journal.startedAt).toISOString(),
      to: new Date(source.asOf).toISOString(),
      decisions: source.journal.decisions.length,
      fillEvents: source.journal.fills.length,
      revision: source.revision,
    };
  }
  private read(id: string) {
    const path = regularFile(
      resolve(localPath(this.archiveRoot), `${digest.parse(id)}.json`),
      sourceLimit,
    );
    const source = verifyPaperExport(JSON.parse(readFileSync(path, "utf8")));
    if (source.exportHash.toLowerCase() !== id)
      throw new Error("ANALYSIS_SOURCE_CHANGED");
    return source;
  }
  bundle(id: string, period: RecordPeriod) {
    return buildRecordBundle(this.read(id), period);
  }
  verify(bundle: RecordBundle) {
    if (
      hash(this.bundle(bundle.source.id, bundle.summary.period)) !==
      hash(bundle)
    )
      throw new Error("ANALYSIS_SOURCE_CHANGED");
  }
}
