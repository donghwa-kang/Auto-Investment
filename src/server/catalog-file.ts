import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import { CatalogError } from "../core/catalog-schema.js";

export const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
export function readCatalogFile(path: string): unknown {
  // URL/UNC/장치 경로는 입력으로 받지 않는다. 이 CLI는 로컬 파일 전용이다.
  if (
    !path ||
    path.startsWith("\\\\") ||
    path.startsWith("//") ||
    /^[a-z]+:\/\//i.test(path)
  )
    throw new CatalogError("LOCAL_CATALOG_FILE_REQUIRED");
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const info = fstatSync(fd);
    if (!info.isFile()) throw new CatalogError("CATALOG_REGULAR_FILE_REQUIRED");
    if (info.size > MAX_CATALOG_BYTES)
      throw new CatalogError("CATALOG_FILE_TOO_LARGE");
    // 파일이 읽는 중 증가해도 고정된 상한 이상의 메모리를 사용하지 않는다.
    const buffer = Buffer.alloc(MAX_CATALOG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > MAX_CATALOG_BYTES)
      throw new CatalogError("CATALOG_FILE_TOO_LARGE");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, length),
    );
    try {
      return JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      throw new CatalogError("CATALOG_JSON_INVALID");
    }
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    // OS/파서 오류의 원문·파일 경로·입력값을 표준 오류로 복사하지 않는다.
    throw new CatalogError("CATALOG_FILE_READ_FAILED");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
