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
import { LearningError } from "../core/learning-schema.js";

// 실행 가능한 모델 파일 대신 크기 제한 JSON만 저장한다. 기존 파일을 덮어쓰지 않는다.
export function saveLearningJson(
  value: unknown,
  category:
    | "learning-inputs"
    | "learning-reports"
    | "paper-learning-exports"
    | "paper-learning-conversions",
  base = process.cwd(),
) {
  let fd: number | undefined;
  try {
    const text = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error();
    const root = resolve(base, "data", category);
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "run-")),
      partial = join(directory, "result.partial"),
      path = join(directory, "result.json");
    fd = openSync(partial, "wx", 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(partial, path);
    return path;
  } catch {
    throw new LearningError("LEARNING_EXPORT_FAILED");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
