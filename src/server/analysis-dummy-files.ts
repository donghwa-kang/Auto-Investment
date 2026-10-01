import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, basename } from "node:path";
import { z } from "zod";
import {
  dummyCases,
  dummyCaseSchema,
  dummyHashSchema,
  type DummyCase,
  type DummyReceipt,
} from "../core/analysis-dummy.js";

export const dummyTargets: Record<DummyCase, string> = {
  ALLOW_READ: "approved-input.txt",
  DENY_READ: "unapproved-canary.txt",
  DENY_WRITE: "write-canary.txt",
};
export const dummyMutation = "DUMMY_MUTATION_V1\n";
export const dummySha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const manifestSchema = z.strictObject({
  version: z.literal("DUMMY_FILE_MANIFEST_V1"),
  runId: z.uuid(),
  targets: z.strictObject({
    ALLOW_READ: dummyHashSchema,
    DENY_READ: dummyHashSchema,
    DENY_WRITE: dummyHashSchema,
  }),
});
export const dummyJobSchema = z.strictObject({
  version: z.literal("DUMMY_FILE_JOB_V1"),
  root: z.string().min(1).max(1024),
  runId: z.uuid(),
  caseId: dummyCaseSchema,
  manifestSha256: dummyHashSchema,
});
export type DummyJob = z.infer<typeof dummyJobSchema>;

export function plainDummyDirectory(path: string) {
  if (!isAbsolute(path) || path.startsWith("\\\\") || resolve(path) !== path)
    throw new Error("DUMMY_DIRECTORY");
  let cursor = path;
  for (;;) {
    const stat = lstatSync(cursor);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(cursor).toLowerCase() !== cursor.toLowerCase()
    )
      throw new Error("DUMMY_DIRECTORY");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function readSmallPlain(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 4096
  )
    throw new Error("DUMMY_FILE");
  return readFileSync(path);
}

export function createDummyFixture(parent: string) {
  plainDummyDirectory(parent);
  const root = mkdtempSync(join(parent, "lab-"));
  const runId = randomUUID();
  const targets = {} as Record<DummyCase, string>;
  for (const caseId of dummyCases) {
    const content = `DUMMY_FILE_V1\n${runId}\n${caseId}\n`;
    writeFileSync(join(root, dummyTargets[caseId]), content, { flag: "wx" });
    targets[caseId] = dummySha256(content);
  }
  const manifest = manifestSchema.parse({
    version: "DUMMY_FILE_MANIFEST_V1",
    runId,
    targets,
  });
  const bytes = JSON.stringify(manifest, null, 2);
  writeFileSync(join(root, "manifest.json"), bytes, { flag: "wx" });
  mkdirSync(join(root, "tmp"));
  return { root, manifest, manifestSha256: dummySha256(bytes) };
}

// 정해진 새 더미 파일만 검사. 범용 파일/명령 실행 또는 OS 격리 기능이 아니다.
export function executeDummyFileProbe(raw: unknown): DummyReceipt {
  const job = dummyJobSchema.parse(raw);
  const result: DummyReceipt = {
    version: "DUMMY_FILE_RECEIPT_V1",
    runId: job.runId,
    caseId: job.caseId,
    manifestSha256: job.manifestSha256,
    attempted: false,
    outcome: "ERROR",
    observedSha256: null,
    errorCode: "PRECONDITION",
  };
  let fd: number | undefined;
  let writeContentValidated = false;
  try {
    plainDummyDirectory(job.root);
    if (!/^lab-[a-zA-Z0-9]{6}$/.test(basename(job.root))) return result;
    const bytes = readSmallPlain(join(job.root, "manifest.json"));
    if (dummySha256(bytes) !== job.manifestSha256) return result;
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (manifest.runId !== job.runId) return result;
    const target = join(job.root, dummyTargets[job.caseId]);
    const stat = lstatSync(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 4096 ||
      realpathSync(target).toLowerCase() !== target.toLowerCase()
    )
      return result;
    result.attempted = true;
    fd = openSync(target, job.caseId === "DENY_WRITE" ? "r+" : "r");
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 4096)
      return { ...result, attempted: false };
    const content = readFileSync(fd);
    const expectedContent = Buffer.from(
      `DUMMY_FILE_V1\n${job.runId}\n${job.caseId}\n`,
    );
    if (
      dummySha256(content) !== manifest.targets[job.caseId] ||
      !content.equals(expectedContent)
    )
      return { ...result, attempted: false };
    if (job.caseId === "DENY_WRITE") {
      writeContentValidated = true;
      // 열린 전용 파일의 EOF에만 추가하며 실제 정책/장부 파일을 사용하지 않는다.
      writeFileSync(fd, dummyMutation);
      result.observedSha256 = dummySha256(
        Buffer.concat([content, Buffer.from(dummyMutation)]),
      );
      result.outcome = "WRITE";
    } else {
      result.observedSha256 = dummySha256(content);
      result.outcome = "READ";
    }
    result.errorCode = null;
    return result;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // r+ 열기 이후 내용 검증 중의 읽기 실패를 쓰기 거절로 오인하지 않는다.
    if (
      job.caseId === "DENY_WRITE" &&
      fd !== undefined &&
      !writeContentValidated
    )
      result.attempted = false;
    result.errorCode = !result.attempted
      ? "PRECONDITION"
      : code === "EACCES" || code === "EPERM" || code === "ENOENT"
        ? code
        : "OTHER";
    return result;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
