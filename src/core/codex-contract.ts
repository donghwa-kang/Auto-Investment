import { z } from "zod";

const object = z.record(z.string(), z.unknown());
function record(value: unknown) {
  return object.parse(value);
}
function schema(value: unknown, title: string) {
  const result = record(value);
  if (result.title !== title || result.type !== "object")
    throw new Error("CODEX_SCHEMA_IDENTITY");
  return result;
}
function policyFields(value: unknown, kind: string) {
  const definitions = record(value);
  const alternatives = z
    .array(object)
    .parse(record(definitions.SandboxPolicy).oneOf);
  const matches = alternatives.filter((item) => {
    const properties = record(item.properties);
    const values = z.array(z.string()).parse(record(properties.type).enum);
    return values.length === 1 && values[0] === kind;
  });
  if (matches.length !== 1) throw new Error("CODEX_POLICY_VARIANT");
  return Object.keys(record(matches[0]!.properties)).sort();
}

// 선언 필드 관측 전용이며 JSON Schema 전체 검증기나 연결 승인기가 아니다.
export function inspectCodexContract(input: {
  command: unknown;
  turn: unknown;
  requirements: unknown;
  fileRead: unknown;
  readiness: unknown;
}) {
  const command = schema(input.command, "CommandExecParams");
  const turn = schema(input.turn, "TurnStartParams");
  const requirements = schema(
    input.requirements,
    "ConfigRequirementsReadResponse",
  );
  const fileRead = schema(input.fileRead, "FsReadFileParams");
  const readiness = schema(input.readiness, "WindowsSandboxReadinessResponse");
  const commandProperties = record(command.properties);
  const turnProperties = record(turn.properties);
  const commandReadOnly = policyFields(command.definitions, "readOnly");
  const commandWorkspaceWrite = policyFields(
    command.definitions,
    "workspaceWrite",
  );
  const turnReadOnly = policyFields(turn.definitions, "readOnly");
  const turnWorkspaceWrite = policyFields(turn.definitions, "workspaceWrite");
  const restrictionDeclared =
    commandReadOnly.includes("access") &&
    commandWorkspaceWrite.includes("readOnlyAccess") &&
    turnReadOnly.includes("access") &&
    turnWorkspaceWrite.includes("readOnlyAccess");
  const required = record(record(requirements.definitions).ConfigRequirements);
  return {
    version: "CODEX_SCHEMA_OBSERVATION_V1" as const,
    evidenceKind: "DECLARATIONS_NOT_RUNTIME_SUPPORT" as const,
    commandReadOnly,
    commandWorkspaceWrite,
    turnReadOnly,
    turnWorkspaceWrite,
    namedProfiles: {
      commandFieldDeclared: Object.hasOwn(
        commandProperties,
        "permissionProfile",
      ),
      turnFieldDeclared: Object.hasOwn(turnProperties, "permissions"),
      mutualExclusionDescription: {
        command:
          record(commandProperties.permissionProfile ?? {}).description ?? null,
        turn: record(turnProperties.permissions ?? {}).description ?? null,
      },
    },
    requirementFields: Object.keys(record(required.properties)).sort(),
    fileReadFields: Object.keys(record(fileRead.properties)).sort(),
    readinessValues: z
      .array(z.string())
      .parse(
        record(record(readiness.definitions).WindowsSandboxReadiness).enum,
      ),
    documentedReadRestriction: restrictionDeclared
      ? "DECLARED_NOT_TESTED"
      : "NOT_DECLARED_IN_CAPTURE",
    runtimeCompatibility: "UNVERIFIED" as const,
    osIsolationVerified: false as const,
  };
}
