import { z } from "zod";
import {
  launchHashSchema,
  launchRunIdSchema,
  launchSha256,
} from "./analysis-launch-plan.js";
import { type ProvisionPlan } from "./analysis-provision.js";

const uint = z.number().int().min(0).max(4294967295);
const descriptorSchema = z.strictObject({
  sha256: launchHashSchema,
  hex: z
    .string()
    .min(40)
    .max(8192)
    .regex(/^(?:[a-f0-9]{2})+$/),
  control: z.number().int().min(0).max(65535),
  dacl: z.enum(["ABSENT", "NULL", "EMPTY", "ACL"]),
  aceCount: z.number().int().min(0).max(65535),
});
const fileSchema = z.strictObject({
  index: z.number().int().min(0).max(15),
  nodeId: launchHashSchema,
  objectId: launchHashSchema,
  base: descriptorSchema,
  saclError: uint,
  withSacl: descriptorSchema.nullable(),
  matchesPlannedInitial: z.boolean().nullable(),
});
const profileSchema = z.strictObject({
  appSidSha256: launchHashSchema,
  folder: z.enum([
    "PATH_ABSENT",
    "PATH_PRESENT",
    "UNKNOWN",
    "REPARSE_HOLD",
    "TYPE_HOLD",
  ]),
  hresult: uint,
  win32Error: uint,
  pathSha256: launchHashSchema.nullable(),
  registration: z.literal("NOT_VERIFIED"),
  ownership: z.literal("NOT_PROVEN"),
  creationReceipt: z.null(),
});
const ticks = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((s) => BigInt(s) <= 18446744073709551615n);
export const readinessProcessSchema = z.strictObject({
  pid: uint.positive(),
  creationTime: ticks,
  exitTime: ticks,
  imageObjectId: launchHashSchema,
  waitSignaled: z.literal(true),
  forced: z.boolean(),
  exitCode: uint,
  scope: z.literal("CREATED_SELF_CHILD_ONLY"),
});
export const readinessResultSchema = z.strictObject({
  version: z.literal("READINESS_SUPERVISED_V1"),
  observation: z.strictObject({
    version: z.literal("READINESS_OBSERVATION_V1"),
    requestSha256: launchHashSchema,
    nonce: launchRunIdSchema,
    ownerSha256: launchHashSchema,
    baseScope: z.literal("OWNER_GROUP_DACL_LABEL"),
    additionalScope: z.literal("SACL"),
    files: z.array(fileSchema).length(16),
    profile: profileSchema,
    osChangesApplied: z.literal(false),
  }),
  process: readinessProcessSchema,
  executionAllowed: z.literal(false),
});
export type ReadinessResult = z.infer<typeof readinessResultSchema>;
export const readinessSources = [
  "src/native/permission-mutation.hpp",
  "src/native/readiness-process.hpp",
  "src/native/readiness-inspection.hpp",
  "src/native/analysis-readiness-inspect.cpp",
  "src/native/provision-security.hpp",
  "src/native/file-probe-common.hpp",
  "src/native/analysis-validator-contract.hpp",
  "scripts/build-analysis-readiness-inspect.mjs",
  "package-lock.json",
] as const;
export const readinessHostFiles = [
  "dist/runtime/src/core/analysis-readiness-inspect.js",
  "dist/runtime/src/server/analysis-readiness-files.js",
  "dist/runtime/src/server/analysis-readiness-cli.js",
] as const;
export function readinessRequest(
  labId: string,
  plan: ProvisionPlan,
  nodeRoot: string,
  nonce: string,
) {
  launchRunIdSchema.parse(labId);
  launchRunIdSchema.parse(plan.runId);
  launchHashSchema.parse(nodeRoot);
  launchRunIdSchema.parse(nonce);
  return `READINESS_INSPECT_V1 ${labId} ${plan.runId} ${launchSha256(plan.inspection.hostSid)} ${nodeRoot} ${nonce}\n`;
}
// Validate bounded self-relative structure, not effective access or restoration eligibility.
export function validateReadinessDescriptor(
  value: z.infer<typeof descriptorSchema>,
) {
  descriptorSchema.parse(value);
  const bytes = Buffer.from(value.hex, "hex");
  if (
    launchSha256(bytes) !== value.sha256 ||
    bytes[0] !== 1 ||
    bytes[1] !== 0 ||
    bytes.readUInt16LE(2) !== value.control ||
    !(value.control & 32768)
  )
    throw new Error("READINESS_DESCRIPTOR_HEADER");
  function offset(at: number, minimum: number) {
    const p = bytes.readUInt32LE(at);
    if (p && (p < 20 || p % 4 || p + minimum > bytes.length))
      throw new Error("READINESS_DESCRIPTOR_OFFSET");
    return p;
  }
  function sid(at: number) {
    const p = offset(at, 8);
    if (!p) return "";
    const n = bytes[p + 1]!;
    if (bytes[p] !== 1 || n > 15 || p + 8 + n * 4 > bytes.length)
      throw new Error("READINESS_SID");
    return bytes.subarray(p, p + 8 + n * 4).toString("hex");
  }
  function acl(at: number) {
    const p = offset(at, 8);
    if (!p) return { hex: "", count: 0 };
    const length = bytes.readUInt16LE(p + 2),
      count = bytes.readUInt16LE(p + 4);
    if (![2, 4].includes(bytes[p]!) || length < 8 || p + length > bytes.length)
      throw new Error("READINESS_ACL_SIZE");
    let next = p + 8;
    for (let i = 0; i < count; i++) {
      if (next + 4 > p + length) throw new Error("READINESS_ACE_BOUNDS");
      const size = bytes.readUInt16LE(next + 2);
      if (size < 4 || size % 4 || next + size > p + length)
        throw new Error("READINESS_ACE_SIZE");
      next += size;
    }
    return { hex: bytes.subarray(p, p + length).toString("hex"), count };
  }
  const owner = sid(4),
    group = sid(8),
    dacl = acl(16);
  acl(12);
  const expected = !(value.control & 4)
    ? "ABSENT"
    : !dacl.hex
      ? "NULL"
      : !dacl.count
        ? "EMPTY"
        : "ACL";
  if (!owner || expected !== value.dacl || dacl.count !== value.aceCount)
    throw new Error("READINESS_DACL_DESCRIPTION");
  return { owner, group, dacl: dacl.hex };
}
export function parseReadinessResult(
  bytes: Buffer,
  request: string,
  plan: ProvisionPlan,
  nodeIds: readonly string[],
) {
  if (!bytes.length || bytes.length > 262144)
    throw new Error("READINESS_OUTPUT_SIZE");
  const wire = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes),
    result = readinessResultSchema.parse(JSON.parse(wire));
  if (JSON.stringify(result) + "\n" !== wire)
    throw new Error("READINESS_CANONICAL");
  const observation = result.observation;
  if (
    observation.requestSha256 !== launchSha256(request) ||
    observation.nonce !== request.trimEnd().split(" ")[5] ||
    observation.ownerSha256 !== launchSha256(plan.inspection.hostSid) ||
    observation.profile.appSidSha256 !== launchSha256(plan.profile.derivedSid)
  )
    throw new Error("READINESS_REQUEST_BINDING");
  if (
    result.process.forced ||
    result.process.exitCode !== 0 ||
    BigInt(result.process.exitTime) < BigInt(result.process.creationTime)
  )
    throw new Error("READINESS_PROCESS_NOT_NORMAL");
  if (
    nodeIds.length !== 16 ||
    new Set(observation.files.map((f) => f.objectId)).size !== 16
  )
    throw new Error("READINESS_ID_REUSE");
  observation.files.forEach((f, i) => {
    if (
      f.index !== i ||
      f.nodeId !== nodeIds[i] ||
      (f.saclError === 0) !== (f.withSacl !== null) ||
      (f.withSacl === null) !== (f.matchesPlannedInitial === null)
    )
      throw new Error("READINESS_FILE_BINDING");
    const base = validateReadinessDescriptor(f.base);
    const owner = Buffer.from(base.owner, "hex");
    let authority = 0n;
    for (let p = 2; p < 8; p++)
      authority = authority * 256n + BigInt(owner[p]!);
    const subAuthorities = Array.from({ length: owner[1]! }, (_, n) =>
      owner.readUInt32LE(8 + n * 4),
    );
    if (
      `S-1-${authority}${subAuthorities.map((n) => `-${n}`).join("")}` !==
      plan.inspection.hostSid
    )
      throw new Error("READINESS_DESCRIPTOR_OWNER");
    if (
      f.withSacl &&
      JSON.stringify(base) !==
        JSON.stringify(validateReadinessDescriptor(f.withSacl))
    )
      throw new Error("READINESS_SECURITY_CHANGED");
  });
  const p = observation.profile;
  if (
    p.folder !== "UNKNOWN" &&
    (p.hresult !== 0 ||
      p.pathSha256 === null ||
      (p.folder === "PATH_ABSENT"
        ? ![2, 3].includes(p.win32Error)
        : p.win32Error !== 0))
  )
    throw new Error("READINESS_PROFILE_CONTRADICTION");
  return result;
}
export function readinessSummary(result: ReadinessResult) {
  readinessResultSchema.parse(result);
  const files = result.observation.files,
    blockers = [
      "PROFILE_REGISTRATION_UNVERIFIED",
      "PROFILE_OWNERSHIP_UNPROVEN",
      "OS_CHANGE_NOT_APPROVED",
    ];
  if (files.some((f) => f.withSacl === null))
    blockers.push("SACL_QUERY_INCOMPLETE");
  if (files.some((f) => f.matchesPlannedInitial === false))
    blockers.push("INITIAL_SECURITY_TEMPLATE_MISMATCH");
  if (files.some((f) => ["ABSENT", "NULL"].includes(f.base.dacl)))
    blockers.push("DACL_NOT_RESTRICTIVE");
  if (
    ["UNKNOWN", "REPARSE_HOLD", "TYPE_HOLD"].includes(
      result.observation.profile.folder,
    )
  )
    blockers.push("PROFILE_PATH_UNCERTAIN");
  if (result.observation.profile.folder === "PATH_PRESENT")
    blockers.push("PROFILE_PATH_COLLISION");
  return {
    status: "READ_ONLY_RECORDED_HOLD",
    observedFiles: files.length,
    fullSaclObserved: files.filter((f) => f.withSacl !== null).length,
    processExitConfirmed:
      result.process.waitSignaled &&
      !result.process.forced &&
      result.process.exitCode === 0,
    profileFolder: result.observation.profile.folder,
    blockers,
    executionAllowed: false,
    osChangesApplied: false,
    osIsolationVerified: false,
  };
}
