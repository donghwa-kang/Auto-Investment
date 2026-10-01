import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expectedNativeReceipt,
  inspectNativePe,
  nativeBuildSchema,
  nativeRequest,
  nativeToolHashes,
  parseNativeCommand,
  serializeNativeBuild,
  validateNativeBuild,
  validateNativeReceipt,
} from "../src/core/analysis-native-contract.js";
import { launchSha256 } from "../src/core/analysis-launch-plan.js";

const id = "fbab57a9-53df-41a7-a2d1-190e8004b736";
const sha = "a".repeat(64);
const inputSha = "b".repeat(64);
const sourceHashes = {
  nativeCore: sha,
  nativeMain: sha,
  buildScript: sha,
  protocol: sha,
  runner: sha,
  cli: sha,
  lockfile: sha,
};
function build() {
  return nativeBuildSchema.parse({
    version: "ANALYSIS_NATIVE_VALIDATOR_BUILD_V1",
    buildId: id,
    scope: "STDIO_VALIDATOR_ONLY_NOT_OS_LAUNCHER",
    sourceHashes,
    toolHashes: nativeToolHashes,
    artifact: { file: "analysis-native-check.exe", bytes: 500, sha256: sha },
    evidence: { headers: sha, imports: sha, loadconfig: sha, commands: sha },
    executionAllowed: false,
    actualOsTests: "NOT_RUN",
  });
}
test("native fixed request binds IDs/hashes, limits and locked intent", () => {
  const wire = nativeRequest(id, sha, inputSha);
  assert.ok(wire.length <= 384);
  assert.equal(wire.toString().split("\n").length, 11);
  assert.ok(wire.toString().endsWith("EXECUTION=LOCKED\nEND\n"));
  for (const bad of [
    "",
    id.toUpperCase(),
    id.replace("41a7", "11a7"),
    "../../key",
  ])
    assert.throws(() => nativeRequest(bad, sha, inputSha));
  for (const bad of ["", sha.toUpperCase(), "a".repeat(63), `${sha}\n`]) {
    assert.throws(() => nativeRequest(id, bad, inputSha));
    assert.throws(() => nativeRequest(id, sha, bad));
  }
});
test("native receipts require exact bytes and request binding; claims cannot unlock", () => {
  const receipt = expectedNativeReceipt(id, sha, inputSha);
  const wire = Buffer.from(JSON.stringify(receipt) + "\n");
  assert.deepEqual(validateNativeReceipt(wire, id, sha, inputSha), receipt);
  const invalid = [
    Buffer.alloc(0),
    Buffer.alloc(513),
    Buffer.from([0xff]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), wire]),
    Buffer.from(wire.toString().trim()),
    Buffer.from(wire.toString().replace("false", "true")),
    Buffer.concat([wire, wire]),
    Buffer.from(JSON.stringify({ ...receipt, extra: true }) + "\n"),
  ];
  for (const bytes of invalid)
    assert.throws(() => validateNativeReceipt(bytes, id, sha, inputSha));
  assert.throws(() => validateNativeReceipt(wire, id, inputSha, inputSha));
  assert.throws(() => validateNativeReceipt(wire, id, sha, sha));
  assert.throws(() =>
    validateNativeReceipt(wire, id.replace("53df", "53de"), sha, inputSha),
  );
});
test("native build validates fixed evidence, source hashes and external hash", () => {
  const wire = Buffer.from(serializeNativeBuild(build()));
  assert.deepEqual(
    validateNativeBuild(wire, launchSha256(wire), id, sourceHashes),
    build(),
  );
  assert.throws(() => validateNativeBuild(wire, sha, id, sourceHashes));
  assert.throws(() =>
    validateNativeBuild(
      wire,
      launchSha256(wire),
      id.replace("53df", "53de"),
      sourceHashes,
    ),
  );
  for (const key of Object.keys(sourceHashes))
    assert.throws(() =>
      validateNativeBuild(wire, launchSha256(wire), id, {
        ...sourceHashes,
        [key]: inputSha,
      }),
    );
});
test("rehashed fake builds reject executable paths, permissions and altered schemas", () => {
  const original = build();
  const invalid = [
    { ...original, executionAllowed: true },
    { ...original, actualOsTests: "PASSED" },
    { ...original, artifact: { ...original.artifact, file: "other.exe" } },
    { ...original, toolHashes: { ...nativeToolHashes, cl: sha } },
    { ...original, scope: "OS_LAUNCHER" },
    { ...original, extra: true },
    { ...original, artifact: { ...original.artifact, bytes: 2097153 } },
  ];
  for (const entry of invalid) {
    const bytes = Buffer.from(JSON.stringify(entry, null, 2) + "\n");
    assert.throws(() =>
      validateNativeBuild(bytes, launchSha256(bytes), id, sourceHashes),
    );
  }
});
test("native build rejects noncanonical JSON, duplicate keys, malformed encodings and sizes", () => {
  const original = serializeNativeBuild(build());
  const invalid = [
    Buffer.alloc(0),
    Buffer.alloc(16385),
    Buffer.from([0xff]),
    Buffer.from(`\ufeff${original}`),
    Buffer.from(original + "\n"),
    Buffer.from(original + "{}"),
    Buffer.from(
      original.replace(
        '"executionAllowed": false,',
        '"executionAllowed": false, "executionAllowed": false,',
      ),
    ),
  ];
  for (const bytes of invalid)
    assert.throws(() =>
      validateNativeBuild(bytes, launchSha256(bytes), id, sourceHashes),
    );
});
test("native CLI refuses all execute/approve/setup commands, paths and extra flags", () => {
  const args = ["check", id, sha, id, inputSha];
  assert.equal(parseNativeCommand(args).buildId, id);
  for (const action of ["execute", "approve", "setup", "prepare", "--validate"])
    assert.throws(() => parseNativeCommand([action, ...args.slice(1)]));
  assert.throws(() => parseNativeCommand([...args, "--execute"]));
  assert.throws(() => parseNativeCommand(args.slice(0, -1)));
  assert.throws(() =>
    parseNativeCommand(["check", "C:\\other.exe", sha, id, inputSha]),
  );
});
test("PE header flags require x64 console executable with ASLR/NX/CFG indicators", () => {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(112, 84);
  bytes.writeUInt16LE(2, 86);
  bytes.writeUInt16LE(0x20b, 88);
  bytes.writeUInt16LE(3, 156);
  bytes.writeUInt16LE(0x4160, 158);
  assert.equal(inspectNativePe(bytes).cfgHeader, true);
  for (const offset of [0, 64, 68, 84, 86, 88, 156, 158]) {
    const bad = Buffer.from(bytes);
    bad.writeUInt16LE(0, offset);
    assert.throws(() => inspectNativePe(bad));
  }
  for (const bit of [0x20, 0x40, 0x100, 0x4000]) {
    const bad = Buffer.from(bytes);
    bad.writeUInt16LE(0x4160 & ~bit, 158);
    assert.throws(() => inspectNativePe(bad));
  }
  for (const bad of [
    Buffer.alloc(0),
    Buffer.alloc(2097153),
    bytes.subarray(0, 100),
  ])
    assert.throws(() => inspectNativePe(bad));
  const badOffset = Buffer.from(bytes);
  badOffset.writeUInt32LE(0xffffffff, 0x3c);
  assert.throws(() => inspectNativePe(badOffset));
});
