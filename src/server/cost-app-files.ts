import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { hash } from "../core/policy.js";

// Only internal fixed names; never expose a caller-supplied path in HTTP.
export function readCostAppText(
  directory: string,
  name: string,
  limit = 64 * 1024 * 1024,
) {
  const path = resolve(directory, name),
    stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw Error("COST_APP_FILE_INVALID");
  return readFileSync(path, "utf8");
}
// Single writer, immutable files. A partial remains for diagnosis on failure;
// absence of the final name is never treated as successful publication.
export function saveCostAppText(directory: string, name: string, text: string) {
  if (Buffer.byteLength(text) > 64 * 1024 * 1024)
    throw Error("COST_APP_FILE_LIMIT");
  const path = resolve(directory, name);
  if (existsSync(path)) {
    if (readCostAppText(directory, name) !== text)
      throw Error("COST_APP_FILE_CONFLICT");
    return;
  }
  const partial = path + ".partial";
  const fd = openSync(partial, "wx", 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, path);
}
export function saveCostAppJson(
  directory: string,
  name: string,
  value: unknown,
) {
  saveCostAppText(directory, name, JSON.stringify(value));
}
export function readCostAppPinned<T>(
  directory: string,
  name: string,
  expectedHash: string,
): T {
  const value: unknown = JSON.parse(readCostAppText(directory, name));
  if (hash(value) !== expectedHash) throw Error("COST_APP_PIN_MISMATCH");
  // Trusted creator's independent local pin, not an external authentication API.
  return value as T;
}
