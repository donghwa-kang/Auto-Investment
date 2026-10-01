import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectCodexContract } from "../src/core/codex-contract.js";

function fixture() {
  const base = (
    title: string,
    properties: Record<string, unknown>,
    definitions: Record<string, unknown> = {},
  ) => ({ title, type: "object", properties, definitions });
  const policies = {
    SandboxPolicy: {
      oneOf: [
        {
          properties: {
            type: { enum: ["readOnly"] },
            networkAccess: { default: false },
          },
        },
        {
          properties: {
            type: { enum: ["workspaceWrite"] },
            writableRoots: {},
            networkAccess: { default: false },
          },
        },
      ],
    },
  };
  return {
    command: base(
      "CommandExecParams",
      {
        permissionProfile: {
          description: "Cannot be combined with sandboxPolicy",
        },
      },
      structuredClone(policies),
    ),
    turn: base(
      "TurnStartParams",
      { permissions: { description: "Cannot be combined with sandboxPolicy" } },
      structuredClone(policies),
    ),
    requirements: base(
      "ConfigRequirementsReadResponse",
      {},
      {
        ConfigRequirements: {
          properties: {
            allowedWindowsSandboxImplementations: {},
            allowedPermissionProfiles: {},
          },
        },
      },
    ),
    fileRead: base("FsReadFileParams", { path: { type: "string" } }),
    readiness: base(
      "WindowsSandboxReadinessResponse",
      {},
      {
        WindowsSandboxReadiness: {
          enum: ["ready", "notConfigured", "updateRequired"],
        },
      },
    ),
  };
}
test("CONTRACT 누락된 읽기 범위 필드를 지원한다고 가정하지 않음", () => {
  const r = inspectCodexContract(fixture());
  assert.equal(r.documentedReadRestriction, "NOT_DECLARED_IN_CAPTURE");
  assert.deepEqual(r.commandReadOnly, ["networkAccess", "type"]);
  assert.equal(r.namedProfiles.commandFieldDeclared, true);
  assert.equal(r.namedProfiles.turnFieldDeclared, true);
  assert.equal(r.osIsolationVerified, false);
});
test("CONTRACT 기본 스키마에 없는 실험적 named profile 필드는 미선언으로 관측", () => {
  const f = fixture();
  delete f.command.properties.permissionProfile;
  delete f.turn.properties.permissions;
  const r = inspectCodexContract(f);
  assert.equal(r.namedProfiles.commandFieldDeclared, false);
  assert.equal(r.namedProfiles.turnFieldDeclared, false);
  assert.deepEqual(r.namedProfiles.mutualExclusionDescription, {
    command: null,
    turn: null,
  });
});
test("CONTRACT 선언이 있어도 실제 호환/격리 상태로 승격하지 않음", () => {
  const f = fixture();
  for (const part of [f.command, f.turn]) {
    const d = part.definitions.SandboxPolicy as {
      oneOf: { properties: Record<string, unknown> }[];
    };
    d.oneOf[0]!.properties.access = {};
    d.oneOf[1]!.properties.readOnlyAccess = {};
  }
  const r = inspectCodexContract(f);
  assert.equal(r.documentedReadRestriction, "DECLARED_NOT_TESTED");
  assert.equal(r.runtimeCompatibility, "UNVERIFIED");
  assert.equal(r.osIsolationVerified, false);
});
test("CONTRACT 다른 제목/형식과 누락·중복 정책 변형 거절", () => {
  const badTitle = fixture();
  badTitle.command.title = "Different";
  assert.throws(() => inspectCodexContract(badTitle));
  for (const mode of ["missing", "duplicate"]) {
    const f = fixture();
    const d = f.command.definitions.SandboxPolicy as { oneOf: unknown[] };
    if (mode === "missing") d.oneOf.shift();
    else d.oneOf.push(structuredClone(d.oneOf[0]));
    assert.throws(() => inspectCodexContract(f));
  }
});
test("CONTRACT 호스트 파일 API·readiness enum은 존재만 관측", () => {
  const r = inspectCodexContract(fixture());
  assert.deepEqual(r.fileReadFields, ["path"]);
  assert.ok(r.readinessValues.includes("ready"));
  assert.equal(r.osIsolationVerified, false);
});
test("CONTRACT 입력을 수정하지 않고 결정적으로 요약", () => {
  const f = fixture();
  const before = structuredClone(f);
  const first = inspectCodexContract(f);
  assert.deepEqual(f, before);
  assert.deepEqual(inspectCodexContract(f), first);
});
