import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeToolHashes,
  inspectNativePe,
} from "../dist/runtime/src/core/analysis-native-contract.js";
import { launchSha256 } from "../dist/runtime/src/core/analysis-launch-plan.js";
import { probeJson } from "../dist/runtime/src/core/analysis-file-probe.js";
import {
  requireLaunchDirectory,
  readLaunchFile,
} from "../dist/runtime/src/server/analysis-launch-files.js";
const sourceFiles = [
  "src/native/permission-mutation.hpp",
  "src/native/readiness-process.hpp",
  "src/native/readiness-inspection.hpp",
  "src/native/analysis-readiness-inspect.cpp",
  "src/native/provision-security.hpp",
  "src/native/file-probe-common.hpp",
  "src/native/analysis-validator-contract.hpp",
  "scripts/build-analysis-readiness-inspect.mjs",
  "package-lock.json",
];
function provisionCodeHashes(workspace) {
  return Object.fromEntries(
    sourceFiles.map((p) => [
      p,
      launchSha256(readLaunchFile(join(workspace, p), 1048576)),
    ]),
  );
}
if (
  process.argv.length !== 2 ||
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  process.versions.node !== "24.20.0"
)
  throw new Error("PROVISION_FIXED_BUILD_ONLY");
const workspace = fileURLToPath(new URL("../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const msvc =
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\MSVC\\14.39.33519";
const sdk = "C:\\Program Files (x86)\\Windows Kits\\10";
const bin = join(msvc, "bin", "Hostx64", "x64");
const tools = Object.fromEntries(
  Object.keys(nativeToolHashes).map((name) => [name, join(bin, `${name}.exe`)]),
);
function checkTools() {
  for (const [name, path] of Object.entries(tools))
    if (launchSha256(readLaunchFile(path, 4194304)) !== nativeToolHashes[name])
      throw new Error("PROVISION_TOOL_HASH");
}
checkTools();
const include = [
  join(msvc, "include"),
  ...["ucrt", "shared", "um"].map((p) =>
    join(sdk, "Include", "10.0.22621.0", p),
  ),
];
const libs = [
  join(msvc, "lib", "x64"),
  ...["ucrt", "um"].map((p) => join(sdk, "Lib", "10.0.22621.0", p, "x64")),
];
for (const path of [...include, ...libs]) requireLaunchDirectory(path);
requireLaunchDirectory(join(workspace, "work"));
const buildId = randomUUID();
function fresh(name) {
  const parent = join(workspace, "work", name);
  if (!existsSync(parent)) mkdirSync(parent);
  requireLaunchDirectory(parent);
  const path = join(parent, `build-${buildId}`);
  mkdirSync(path);
  requireLaunchDirectory(path);
  return path;
}
const directory = fresh("analysis-readiness-inspect-build"),
  temporary = fresh("analysis-readiness-inspect-build-temp");
const sourceHashes = provisionCodeHashes(workspace),
  steps = [];
function run(tool, args) {
  const r = spawnSync(tools[tool], args, {
    cwd: directory,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 262144,
    env: {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: `${bin};C:\\Windows\\System32`,
      TEMP: temporary,
      TMP: temporary,
    },
  });
  steps.push({
    tool: tools[tool],
    args,
    exitCode: r.status,
    error: r.error?.code ?? null,
    stdout: r.stdout,
    stderr: r.stderr,
  });
  if (r.status !== 0 || r.error) {
    writeFileSync(join(directory, "failed-build.json"), probeJson({ steps }), {
      flag: "wx",
    });
    throw new Error(`PROVISION_BUILD_FAILED: ${directory}`);
  }
  return r.stdout;
}
for (const source of ["analysis-readiness-inspect"])
  run("cl", [
    "/nologo",
    "/c",
    "/std:c++20",
    "/O2",
    "/W4",
    "/WX",
    "/permissive-",
    "/utf-8",
    "/EHsc",
    "/MT",
    "/GS",
    "/guard:cf",
    "/D_WIN32_WINNT=0x0A00",
    ...include.map((p) => `/I${p}`),
    `/Fo${join(directory, `${source}.obj`)}`,
    join(workspace, `src/native/${source}.cpp`),
  ]);
const executable = join(directory, "analysis-readiness-inspect.exe");
run("link", [
  "/NOLOGO",
  "/WX",
  "/MACHINE:X64",
  "/SUBSYSTEM:CONSOLE",
  "/INCREMENTAL:NO",
  "/DYNAMICBASE",
  "/HIGHENTROPYVA",
  "/NXCOMPAT",
  "/GUARD:CF",
  "/OPT:REF",
  "/OPT:ICF",
  `/OUT:${executable}`,
  ...libs.map((p) => `/LIBPATH:${p}`),
  join(directory, "analysis-readiness-inspect.obj"),
  "kernel32.lib",
  "bcrypt.lib",
  "advapi32.lib",
  "userenv.lib",
  "ole32.lib",
]);
const evidence = {};
for (const option of ["headers", "imports", "loadconfig"]) {
  const value = run("dumpbin", [`/${option}`, executable]);
  writeFileSync(join(directory, `${option}.txt`), value, { flag: "wx" });
  evidence[option] = launchSha256(value);
}
const commands = probeJson({
  scope: "BUILD_ONLY_NO_PROFILE_OR_ACL_MUTATION",
  steps,
});
writeFileSync(join(directory, "commands.txt"), commands, { flag: "wx" });
evidence.commands = launchSha256(commands);
const bytes = readLaunchFile(executable, 2097152);
inspectNativePe(bytes);
checkTools();
if (probeJson(provisionCodeHashes(workspace)) !== probeJson(sourceHashes))
  throw new Error("PROVISION_SOURCE_CHANGED");
if (
  JSON.stringify(readdirSync(directory).sort()) !==
  JSON.stringify(
    [
      "analysis-readiness-inspect.exe",
      "analysis-readiness-inspect.obj",
      "headers.txt",
      "imports.txt",
      "loadconfig.txt",
      "commands.txt",
    ].sort(),
  )
)
  throw new Error("PROVISION_BUILD_EXTRA");
const build = {
  version: "READINESS_INSPECT_BUILD_V1",
  buildId,
  sourceHashes,
  toolHashes: nativeToolHashes,
  artifact: {
    file: "analysis-readiness-inspect.exe",
    bytes: bytes.length,
    sha256: launchSha256(bytes),
  },
  evidence,
  osMutationBackend: "ABSENT",
  executionAllowed: false,
};
const wire = probeJson(build);
writeFileSync(join(directory, "build.json"), wire, { flag: "wx" });
console.log(
  JSON.stringify({
    status: "READINESS_INSPECT_BUILT_READ_ONLY",
    buildId,
    buildSha256: launchSha256(wire),
    directory,
    osMutationBackend: "ABSENT",
    executionAllowed: false,
  }),
);
