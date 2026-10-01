import { z } from "zod";

const flag = z.boolean().nullable();
const feature = z.enum([
  "Enabled",
  "Disabled",
  "EnablePending",
  "DisablePending",
  "DisabledWithPayloadRemoved",
  "UNKNOWN",
]);
export const isolationHostSchema = z.strictObject({
  version: z.literal("ANALYSIS_ISOLATION_HOST_V1"),
  capturedAt: z.iso.datetime(),
  platform: z.literal("win32"),
  os: z.strictObject({
    editionId: z
      .string()
      .regex(/^[A-Za-z0-9]{1,48}$/)
      .nullable(),
    build: z.number().int().min(1).max(999999).nullable(),
    is64Bit: z.boolean(),
  }),
  elevated: flag,
  hardware: z.strictObject({
    logicalProcessors: z.number().int().min(1).max(4096).nullable(),
    memoryMiB: z.number().int().min(1).max(16777216).nullable(),
    hypervisorPresent: flag,
    virtualizationFirmwareEnabled: flag,
    slat: flag,
  }),
  executables: z.strictObject({
    windowsSandbox: flag,
    wsl: flag,
    codexOnPath: flag,
  }),
  features: z.strictObject({
    windowsSandbox: feature,
    hyperV: feature,
    virtualMachinePlatform: feature,
    wsl: feature,
  }),
  unavailable: z
    .array(
      z.enum([
        "OS_QUERY_UNAVAILABLE",
        "TOKEN_QUERY_UNAVAILABLE",
        "COMPUTER_QUERY_UNAVAILABLE",
        "PROCESSOR_QUERY_UNAVAILABLE",
        "EXECUTABLE_QUERY_UNAVAILABLE",
        "FEATURE_QUERY_UNAVAILABLE",
      ]),
    )
    .max(6),
});
export type IsolationHost = z.infer<typeof isolationHostSchema>;

const supportedEditions = new Set([
  "Professional",
  "ProfessionalN",
  "ProfessionalEducation",
  "ProfessionalEducationN",
  "Enterprise",
  "EnterpriseN",
  "Education",
  "EducationN",
]);
// 준비 진단 전용. 입력에 성공/승인 필드를 허용하거나 실제 실행 게이트로 승격하지 않는다.
export function assessIsolationHost(raw: unknown) {
  const host = isolationHostSchema.parse(raw);
  const edition = host.os.editionId;
  const home =
    edition !== null &&
    /^Core(?:N|SingleLanguage|CountrySpecific)?$/.test(edition);
  const sandbox = home
    ? "UNSUPPORTED_EDITION"
    : edition === null || !supportedEditions.has(edition)
      ? "EDITION_UNCONFIRMED"
      : host.features.windowsSandbox !== "Enabled" ||
          host.executables.windowsSandbox !== true
        ? "FEATURE_UNCONFIRMED"
        : "CANDIDATE_NOT_TESTED";
  return {
    version: "ANALYSIS_ISOLATION_PREPARATION_V1" as const,
    status: "BLOCKED" as const,
    realCodexEnabled: false as const,
    osIsolationVerified: false as const,
    evidenceKind: "READ_ONLY_HOST_METADATA_NOT_CONFINEMENT_TEST" as const,
    host,
    candidates: {
      codexNative:
        host.os.build !== null &&
        host.os.build >= 22000 &&
        host.executables.codexOnPath === true
          ? "INVESTIGATE_ELEVATED_BOUNDARY"
          : "ENVIRONMENT_UNCONFIRMED",
      microsoftWindowsSandbox: sandbox,
      wsl2:
        host.executables.wsl === true
          ? "EXECUTABLE_ONLY_DISTRO_AND_ISOLATION_UNCONFIRMED"
          : "ENVIRONMENT_UNCONFIRMED",
    },
    missingEvidence: [
      "EXACT_CODEX_VERSION_AND_EFFECTIVE_PERMISSIONS",
      "APP_SERVER_AND_TOOL_ACCESS_BOUNDARIES",
      "OS_ALLOW_AND_DENY_CONTROL_TESTS",
      "COMMAND_AND_NONCOMMAND_NETWORK_RESTRICTIONS",
      "SEPARATE_SETUP_AND_MODEL_TRANSMISSION_APPROVALS",
    ],
  };
}

export function parseIsolationProbe(bytes: Uint8Array) {
  if (bytes.byteLength === 0 || bytes.byteLength > 16384)
    throw new Error("ISOLATION_PROBE_SIZE");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  return isolationHostSchema.parse(JSON.parse(text));
}
