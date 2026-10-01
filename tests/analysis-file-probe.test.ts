import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyProbe,
  expectedProbeSnapshot,
  parseProbeCommand,
  parseProbeReceipt,
  probeCases,
  probeContent,
  probeFileNames,
  probeJson,
  probeManifest,
  probeMutation,
  probeRequest,
  probeTargets,
  type ProbeCase,
  type ProbeReceipt,
  type ProbeSnapshot,
} from "../src/core/analysis-file-probe.js";
import { launchSha256 } from "../src/core/analysis-launch-plan.js";
const runId = "fbab57a9-53df-41a7-a2d1-190e8004b736";
const hash = "a".repeat(64);
const other = "b".repeat(64);
function before(): ProbeSnapshot {
  return Object.fromEntries(
    probeFileNames.map((file) => [
      file,
      file === "private/create.txt" || file === "private/renamed.txt"
        ? null
        : launchSha256(
            file === "manifest.json"
              ? probeJson(probeManifest(runId, "ALLOW_READ", runId, hash))
              : probeContent(runId, file),
          ),
    ]),
  ) as ProbeSnapshot;
}
function receipt(
  caseId: ProbeCase,
  outcome?: ProbeReceipt["outcome"],
): ProbeReceipt {
  const expected: Record<ProbeCase, ProbeReceipt["outcome"]> = {
    ALLOW_READ: "READ",
    ALLOW_WRITE: "APPENDED",
    DENY_READ: "READ",
    DENY_APPEND: "APPENDED",
    DENY_CREATE: "CREATED",
    DENY_DELETE: "DELETED",
    DENY_RENAME: "RENAMED",
  };
  const selected = outcome ?? expected[caseId];
  return {
    version: "FILE_PROBE_RECEIPT_V1",
    runId,
    caseId,
    requestSha256: launchSha256(probeRequest(runId, caseId, hash)),
    attempted: true,
    outcome: selected,
    stage: selected === "ERROR" ? "OPEN" : "NONE",
    win32Error: selected === "ERROR" ? 5 : 0,
    bytesWritten: ["APPENDED", "CREATED"].includes(selected)
      ? Buffer.byteLength(probeMutation)
      : 0,
    observedSha256:
      selected === "READ"
        ? before()[probeTargets[caseId] as keyof ProbeSnapshot]
        : null,
    osIsolationVerified: false,
  };
}
const wire = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const parse = (value: unknown, caseId: ProbeCase = "ALLOW_READ") =>
  parseProbeReceipt(
    wire(value),
    runId,
    caseId,
    probeRequest(runId, caseId, hash),
  );
test("probe request admits only fixed cases and lowercase UUID/hash", () => {
  for (const caseId of probeCases) {
    const request = probeRequest(runId, caseId, hash);
    assert.ok(request.length < 384);
    assert.equal(request.toString().split("\n").length, 8);
    assert.ok(request.toString().endsWith("NO_OS_ATTESTATION\nEND\n"));
  }
  for (const id of [
    "",
    "../user",
    runId.toUpperCase(),
    runId.replace("41a7", "11a7"),
  ])
    assert.throws(() => probeRequest(id, "ALLOW_READ", hash));
  for (const sha of ["", hash.toUpperCase(), hash + "\n", hash.slice(1)])
    assert.throws(() => probeRequest(runId, "ALLOW_READ", sha));
  assert.throws(() => probeRequest(runId, "EXECUTE" as ProbeCase, hash));
});
test("fixture generation uses fixed dummy paths and distinct marker/content", () => {
  assert.equal(
    probeContent(runId, "fixture-marker.txt"),
    `FILE_PROBE_FIXTURE_V1\n${runId}\nNO_USER_DATA\n`,
  );
  for (const file of [
    "auth.json",
    "private/create.txt",
    "private/renamed.txt",
    "../other",
    "C:\\data",
  ])
    assert.throws(() => probeContent(runId, file));
  const manifest = probeManifest(runId, "ALLOW_READ", runId, hash);
  assert.equal(manifest.mode, "UNRESTRICTED_SELF_TEST");
  assert.equal(manifest.osIsolationVerified, false);
});
test("all seven valid receipts bind to exact request bytes", () => {
  for (const caseId of probeCases) {
    const r = receipt(caseId);
    assert.deepEqual(parse(r, caseId), r);
    assert.throws(() =>
      parseProbeReceipt(
        wire(r),
        runId,
        caseId,
        probeRequest(runId, caseId, other),
      ),
    );
    assert.throws(() => parse({ ...r, requestSha256: other }, caseId));
    assert.throws(() =>
      parse({ ...r, runId: runId.replace("53df", "53de") }, caseId),
    );
  }
});
test("receipt wire rejects BOM/invalid UTF8/extra JSON/duplicates/oversize/noncanonical", () => {
  const valid = wire(receipt("ALLOW_READ"));
  for (const bad of [
    Buffer.alloc(0),
    Buffer.alloc(2049),
    Buffer.from([0xff]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
    Buffer.concat([valid, valid]),
    Buffer.from(valid.toString().trim()),
    Buffer.from(
      valid
        .toString()
        .replace('"attempted":true', '"attempted":true,"attempted":true'),
    ),
    Buffer.from(valid.toString().replaceAll("\n", "\r\n")),
  ])
    assert.throws(() =>
      parseProbeReceipt(
        bad,
        runId,
        "ALLOW_READ",
        probeRequest(runId, "ALLOW_READ", hash),
      ),
    );
});
test("contradictory success/OS approval/extra metadata is rejected", () => {
  const r = receipt("ALLOW_READ");
  for (const bad of [
    { ...r, attempted: false },
    { ...r, stage: "OPEN" },
    { ...r, win32Error: 5 },
    { ...r, bytesWritten: 1 },
    { ...r, observedSha256: null },
    { ...r, osIsolationVerified: true },
    { ...r, extra: "execute" },
    { ...r, outcome: "DELETED" },
  ])
    assert.throws(() => parse(bad));
  assert.throws(() =>
    parse({ ...receipt("DENY_CREATE"), bytesWritten: 0 }, "DENY_CREATE"),
  );
  assert.throws(() =>
    parse({ ...receipt("DENY_DELETE"), observedSha256: hash }, "DENY_DELETE"),
  );
});
test("errors require consistent attempt/stage/error-code/data relationship", () => {
  const error = receipt("DENY_READ", "ERROR");
  assert.deepEqual(parse(error, "DENY_READ"), error);
  assert.equal(
    parse(
      { ...error, attempted: false, stage: "PREFLIGHT", win32Error: 13 },
      "DENY_READ",
    ).attempted,
    false,
  );
  for (const bad of [
    { ...error, win32Error: 0 },
    { ...error, win32Error: -1 },
    { ...error, win32Error: 4294967296 },
    { ...error, stage: "NONE" },
    { ...error, attempted: false },
    { ...error, stage: "PREFLIGHT" },
    { ...error, observedSha256: hash },
    { ...error, bytesWritten: 1 },
  ])
    assert.throws(() => parse(bad, "DENY_READ"));
});
test("only direct Win32 access denied at OPEN/IO with unchanged fixture is a reported denial", () => {
  const b = before(),
    r = receipt("DENY_READ", "ERROR");
  assert.equal(
    classifyProbe(r, b, b, runId),
    "DENIAL_REPORTED_NOT_OS_ATTESTED",
  );
  assert.equal(
    classifyProbe({ ...r, stage: "IO" }, b, b, runId),
    "DENIAL_REPORTED_NOT_OS_ATTESTED",
  );
  for (const stage of ["GUARD", "HASH", "PREFLIGHT"] as const)
    assert.equal(classifyProbe({ ...r, stage }, b, b, runId), "INCONCLUSIVE");
  for (const win32Error of [2, 3, 13, 32, 80, 1112])
    assert.equal(
      classifyProbe({ ...r, win32Error }, b, b, runId),
      "INCONCLUSIVE",
    );
  assert.equal(
    classifyProbe({ ...r, attempted: false }, b, b, runId),
    "INCONCLUSIVE",
  );
  assert.equal(
    classifyProbe(r, b, b, runId.replace("53df", "53de")),
    "INCONCLUSIVE",
  );
});
test("actual successful negative operations mean exposure, not an OS acceptance pass", () => {
  const b = before();
  for (const caseId of probeCases) {
    const r = receipt(caseId),
      after = expectedProbeSnapshot(b, runId, caseId);
    assert.equal(
      classifyProbe(r, b, after, runId),
      caseId.startsWith("ALLOW_") ? "ALLOW_OBSERVED" : "EXPOSURE_DETECTED",
    );
  }
});
test("changed fixture outweighs a reported denial; missing reads/incorrect hashes are not passes", () => {
  const b = before(),
    after = { ...b, "private/read.txt": null };
  assert.equal(
    classifyProbe(receipt("DENY_READ", "ERROR"), b, after, runId),
    "EXPOSURE_DETECTED",
  );
  assert.equal(
    classifyProbe(
      { ...receipt("ALLOW_READ"), observedSha256: other },
      b,
      b,
      runId,
    ),
    "INCONCLUSIVE",
  );
  assert.equal(
    classifyProbe(receipt("ALLOW_READ"), b, after, runId),
    "INCONCLUSIVE",
  );
  assert.equal(
    classifyProbe(
      { ...receipt("DENY_READ"), observedSha256: other },
      b,
      b,
      runId,
    ),
    "INCONCLUSIVE",
  );
});
test("append/create/delete/rename expectations preserve every unrelated file", () => {
  const b = before();
  assert.equal(
    expectedProbeSnapshot(b, runId, "DENY_APPEND")["private/append.txt"],
    launchSha256(probeContent(runId, "private/append.txt") + probeMutation),
  );
  assert.equal(
    expectedProbeSnapshot(b, runId, "DENY_CREATE")["private/create.txt"],
    launchSha256(probeMutation),
  );
  assert.equal(
    expectedProbeSnapshot(b, runId, "DENY_DELETE")["private/delete.txt"],
    null,
  );
  const renamed = expectedProbeSnapshot(b, runId, "DENY_RENAME");
  assert.equal(renamed["private/rename.txt"], null);
  assert.equal(renamed["private/renamed.txt"], b["private/rename.txt"]);
  assert.equal(renamed["fixture-marker.txt"], b["fixture-marker.txt"]);
  assert.deepEqual(before(), b);
});
test("CLI admits only self-test with fixed build identity; no target/approval/execute arguments", () => {
  assert.deepEqual(parseProbeCommand(["self-test", runId, hash]), {
    buildId: runId,
    buildSha: hash,
  });
  for (const args of [
    [],
    ["execute", runId, hash],
    ["approve", runId, hash],
    ["setup", runId, hash],
    ["self-test", runId, hash, "--execute"],
    ["self-test", "C:\\other.exe", hash],
  ])
    assert.throws(() => parseProbeCommand(args));
});
