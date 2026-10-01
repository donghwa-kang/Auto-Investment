import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  CostOutcomeExportError,
  MAX_COST_EXPORT_BYTES,
  verifyCostOutcomeExport,
} from "../core/cost-outcome-export.js";
import type {
  CostExportAnchor,
  CostOutcomeExport,
} from "../core/cost-outcome-export.js";

function localPath(path: string) {
  if (
    !path ||
    path.includes("\0") ||
    path.startsWith("\\\\") ||
    path.startsWith("//") ||
    /^[a-z]+:\/\//i.test(path) ||
    /^[a-z]:(?![\\/])/i.test(path) ||
    path.replace(/^[a-z]:[\\/]/i, "").includes(":")
  )
    throw new CostOutcomeExportError("COST_EXPORT_LOCAL_PATH_REQUIRED");
  return resolve(path);
}
function directory(path: string) {
  const parent = dirname(path);
  if (parent !== path) directory(parent);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new CostOutcomeExportError("COST_EXPORT_LOCAL_DIRECTORY_REQUIRED");
}
function childDirectory(parent: string, name: string) {
  const path = join(parent, name);
  try {
    mkdirSync(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
  }
  directory(path);
  return path;
}

// A new run directory only; never overwrites a prior export. An interrupted
// write may leave result.partial, which is not an accepted input file.
export function saveCostOutcomeExport(
  value: CostOutcomeExport,
  anchor: CostExportAnchor,
  base = process.cwd(),
) {
  let fd: number | undefined;
  try {
    const text = JSON.stringify(value) + "\n";
    verifyCostOutcomeExport(text, anchor);
    const root = localPath(base);
    directory(root);
    const target = childDirectory(
      childDirectory(root, "data"),
      "cost-hold-exports",
    );
    const run = mkdtempSync(join(target, "run-"));
    const partial = join(run, "result.partial"),
      path = join(run, "result.json");
    fd = openSync(partial, "wx", 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(partial, path);
    return path;
  } catch (error) {
    if (error instanceof CostOutcomeExportError) throw error;
    throw new CostOutcomeExportError("COST_EXPORT_WRITE_FAILED");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function verifyCostOutcomeExportFile(
  path: string,
  anchor: CostExportAnchor,
) {
  let fd: number | undefined;
  try {
    const target = localPath(path);
    if (!target.endsWith(".json"))
      throw new CostOutcomeExportError("COST_EXPORT_JSON_FILE_REQUIRED");
    directory(dirname(target));
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new CostOutcomeExportError("COST_EXPORT_REGULAR_FILE_REQUIRED");
    fd = openSync(target, "r");
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev)
      throw new CostOutcomeExportError("COST_EXPORT_FILE_CHANGED");
    if (opened.size > MAX_COST_EXPORT_BYTES)
      throw new CostOutcomeExportError("COST_EXPORT_SIZE_LIMIT");
    const bytes = Buffer.alloc(MAX_COST_EXPORT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_COST_EXPORT_BYTES)
      throw new CostOutcomeExportError("COST_EXPORT_SIZE_LIMIT");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length),
    );
    return verifyCostOutcomeExport(text, anchor);
  } catch (error) {
    if (error instanceof CostOutcomeExportError) throw error;
    throw new CostOutcomeExportError("COST_EXPORT_READ_FAILED");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
