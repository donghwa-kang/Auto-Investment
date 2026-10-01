import { z } from "zod";
import {
  launchHashSchema,
  launchRunIdSchema,
  launchSha256,
} from "./analysis-launch-plan.js";

export const nativeSourceFiles = {
  nativeCore: "src/native/analysis-validator-contract.hpp",
  nativeMain: "src/native/analysis-validator.cpp",
  buildScript: "scripts/build-analysis-native.mjs",
  protocol: "dist/runtime/src/core/analysis-native-contract.js",
  runner: "dist/runtime/src/server/analysis-native-runner.js",
  cli: "dist/runtime/src/server/analysis-native-cli.js",
  lockfile: "package-lock.json",
} as const;
const sourceHashSchema = z.strictObject({
  nativeCore: launchHashSchema,
  nativeMain: launchHashSchema,
  buildScript: launchHashSchema,
  protocol: launchHashSchema,
  runner: launchHashSchema,
  cli: launchHashSchema,
  lockfile: launchHashSchema,
});
export const nativeToolHashes = {
  cl: "dc1ef4e36c7044ae9bd0ce24d27de45f8fe26dc1210897b8717e8ef0232360e8",
  link: "c103a76c3e9a8f02d0d06f0737bd76cce8b827ff84007fdb152bbdac10d17025",
  dumpbin: "6ad86f7fa61936301fddafa97de7c8f0ac5c3cb225569dca68edfa021cce5919",
} as const;
export const nativeBuildSchema = z.strictObject({
  version: z.literal("ANALYSIS_NATIVE_VALIDATOR_BUILD_V1"),
  buildId: launchRunIdSchema,
  scope: z.literal("STDIO_VALIDATOR_ONLY_NOT_OS_LAUNCHER"),
  sourceHashes: sourceHashSchema,
  toolHashes: z.strictObject({
    cl: z.literal(nativeToolHashes.cl),
    link: z.literal(nativeToolHashes.link),
    dumpbin: z.literal(nativeToolHashes.dumpbin),
  }),
  artifact: z.strictObject({
    file: z.literal("analysis-native-check.exe"),
    bytes: z.number().int().positive().max(2097152),
    sha256: launchHashSchema,
  }),
  evidence: z.strictObject({
    headers: launchHashSchema,
    imports: launchHashSchema,
    loadconfig: launchHashSchema,
    commands: launchHashSchema,
  }),
  executionAllowed: z.literal(false),
  actualOsTests: z.literal("NOT_RUN"),
});
export type NativeBuild = z.infer<typeof nativeBuildSchema>;
export const serializeNativeBuild = (build: NativeBuild) =>
  JSON.stringify(nativeBuildSchema.parse(build), null, 2) + "\n";

export function validateNativeBuild(
  bytes: Buffer,
  expectedSha: string,
  buildId: string,
  sourceHashes: NativeBuild["sourceHashes"],
) {
  launchHashSchema.parse(expectedSha);
  launchRunIdSchema.parse(buildId);
  if (
    !bytes.length ||
    bytes.length > 16384 ||
    launchSha256(bytes) !== expectedSha
  )
    throw new Error("NATIVE_BUILD_HASH_OR_SIZE");
  const wire = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const build = nativeBuildSchema.parse(JSON.parse(wire));
  if (
    build.buildId !== buildId ||
    wire !== serializeNativeBuild({ ...build, sourceHashes })
  )
    throw new Error("NATIVE_BUILD_BINDING");
  return build;
}

export function nativeRequest(
  runId: string,
  manifestSha: string,
  inputSha: string,
) {
  launchRunIdSchema.parse(runId);
  launchHashSchema.parse(manifestSha);
  launchHashSchema.parse(inputSha);
  return Buffer.from(
    [
      "ANALYSIS_NATIVE_REQUEST_V1",
      runId,
      manifestSha,
      inputSha,
      "PREPARATION_ONLY",
      "CAPABILITIES=NONE",
      "CHILD_PROCESSES=DENY",
      "LIMITS=1,128,2000,10000,8192",
      "EXECUTION=LOCKED",
      "END",
      "",
    ].join("\n"),
    "ascii",
  );
}
export function expectedNativeReceipt(
  runId: string,
  manifestSha: string,
  inputSha: string,
) {
  nativeRequest(runId, manifestSha, inputSha);
  return {
    status: "NATIVE_REQUEST_VALID_EXECUTION_LOCKED" as const,
    runId,
    manifestSha256: manifestSha,
    inputSha256: inputSha,
    executionAllowed: false as const,
    actualOsTests: "NOT_RUN" as const,
  };
}
export function validateNativeReceipt(
  bytes: Buffer,
  runId: string,
  manifestSha: string,
  inputSha: string,
) {
  const expected = expectedNativeReceipt(runId, manifestSha, inputSha);
  if (!bytes.equals(Buffer.from(JSON.stringify(expected) + "\n")))
    throw new Error("NATIVE_RECEIPT_REJECTED");
  return expected;
}

// Inspect actual PE bytes, not a claim in the build receipt. Not an OS isolation proof.
export function inspectNativePe(bytes: Buffer) {
  if (
    bytes.length < 256 ||
    bytes.length > 2097152 ||
    bytes.readUInt16LE(0) !== 0x5a4d
  )
    throw new Error("NATIVE_PE_REJECTED");
  const pe = bytes.readUInt32LE(0x3c);
  if (
    pe < 64 ||
    pe + 112 > bytes.length ||
    bytes.readUInt32LE(pe) !== 0x4550 ||
    bytes.readUInt16LE(pe + 4) !== 0x8664 ||
    bytes.readUInt16LE(pe + 20) < 112 ||
    pe + 24 + bytes.readUInt16LE(pe + 20) > bytes.length ||
    (bytes.readUInt16LE(pe + 22) & 0x2002) !== 2 ||
    bytes.readUInt16LE(pe + 24) !== 0x20b ||
    bytes.readUInt16LE(pe + 92) !== 3 ||
    (bytes.readUInt16LE(pe + 94) & 0x4160) !== 0x4160
  )
    throw new Error("NATIVE_PE_REJECTED");
  return {
    machine: "X64",
    subsystem: "CONSOLE",
    aslr: true,
    highEntropyVa: true,
    nx: true,
    cfgHeader: true,
  } as const;
}

export function parseNativeCommand(args: readonly string[]) {
  if (args.length !== 5 || args[0] !== "check")
    throw new Error("NATIVE_CHECK_ONLY");
  return {
    buildId: launchRunIdSchema.parse(args[1]),
    buildSha: launchHashSchema.parse(args[2]),
    runId: launchRunIdSchema.parse(args[3]),
    manifestSha: launchHashSchema.parse(args[4]),
  };
}
