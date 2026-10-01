import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectNativePe,
  nativeToolHashes,
} from "../dist/runtime/src/core/analysis-native-contract.js";
import {
  probeBuildSchema,
  probeJson,
} from "../dist/runtime/src/core/analysis-file-probe.js";
import { fileProbeSourceHashes } from "../dist/runtime/src/server/analysis-file-probe-files.js";
import { launchSha256 } from "../dist/runtime/src/core/analysis-launch-plan.js";
import {
  readLaunchFile,
  requireLaunchDirectory,
} from "../dist/runtime/src/server/analysis-launch-files.js";

if (
  process.argv.length !== 2 ||
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  process.versions.node !== "24.20.0"
)
  throw new Error("FILE_PROBE_FIXED_BUILD_ONLY");
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
      throw new Error("FILE_PROBE_TOOL_HASH");
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
for (const directory of [...include, ...libs])
  requireLaunchDirectory(directory);
const sourceHashes = fileProbeSourceHashes(workspace);
requireLaunchDirectory(join(workspace, "work"));
const parent = join(workspace, "work", "analysis-file-build");
if (!existsSync(parent)) mkdirSync(parent);
requireLaunchDirectory(parent);
const buildId = randomUUID(),
  directory = join(parent, `build-${buildId}`);
mkdirSync(directory);
requireLaunchDirectory(directory);
const tempParent = join(workspace, "work", "analysis-file-build-temp");
if (!existsSync(tempParent)) mkdirSync(tempParent);
requireLaunchDirectory(tempParent);
const temporary = join(tempParent, `build-${buildId}`);
mkdirSync(temporary);
requireLaunchDirectory(temporary);
const steps = [],
  evidence = {};
function run(tool, args) {
  const result = spawnSync(tools[tool], args, {
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
    exitCode: result.status,
    error: result.error?.code ?? null,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  if (result.status !== 0 || result.error) {
    writeFileSync(join(directory, "failed-build.json"), probeJson({ steps }), {
      flag: "wx",
    });
    throw new Error(`FILE_PROBE_BUILD_FAILED: ${directory}`);
  }
  return result.stdout;
}
for (const [name, source] of [
  ["probe", "analysis-file-probe.cpp"],
  ["controller", "isolation-controller.cpp"],
  ["backend", "isolation-win32.cpp"],
])
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
    `/Fo${join(directory, `${name}.obj`)}`,
    join(workspace, "src/native", source),
  ]);
const artifacts = {};
for (const [name, file, objects] of [
  ["probe", "analysis-file-probe.exe", ["probe"]],
  [
    "controller",
    "analysis-isolation-controller.exe",
    ["controller", "backend"],
  ],
]) {
  const exe = join(directory, file);
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
    `/OUT:${exe}`,
    ...libs.map((p) => `/LIBPATH:${p}`),
    ...objects.map((p) => join(directory, `${p}.obj`)),
    "kernel32.lib",
    "bcrypt.lib",
    "advapi32.lib",
    "userenv.lib",
  ]);
  for (const option of ["headers", "imports", "loadconfig"]) {
    const text = run("dumpbin", [`/${option}`, exe]);
    writeFileSync(join(directory, `${name}-${option}.txt`), text, {
      flag: "wx",
    });
    evidence[`${name}-${option}`] = launchSha256(text);
  }
  const bytes = readLaunchFile(exe, 2097152);
  inspectNativePe(bytes);
  artifacts[name] = { file, sha256: launchSha256(bytes), bytes: bytes.length };
}
const commands = probeJson({ scope: "BUILD_ONLY_NOT_OS_EXECUTION", steps });
writeFileSync(join(directory, "commands.txt"), commands, { flag: "wx" });
evidence.commands = launchSha256(commands);
checkTools();
if (probeJson(fileProbeSourceHashes(workspace)) !== probeJson(sourceHashes))
  throw new Error("FILE_PROBE_SOURCE_CHANGED");
const build = probeBuildSchema.parse({
  version: "FILE_PROBE_BUILD_V1",
  buildId,
  sourceHashes,
  toolHashes: nativeToolHashes,
  artifacts,
  evidence,
  osExecutionAllowed: false,
  win32BackendExecuted: false,
});
const expectedFiles = [
  "probe.obj",
  "controller.obj",
  "backend.obj",
  ...Object.values(artifacts).map((a) => a.file),
  ...Object.keys(evidence).map((name) => `${name}.txt`),
];
if (
  JSON.stringify(readdirSync(directory).sort()) !==
  JSON.stringify(expectedFiles.sort())
)
  throw new Error("FILE_PROBE_UNEXPECTED_BUILD_OUTPUT");
const wire = probeJson(build);
writeFileSync(join(directory, "build.json"), wire, { flag: "wx" });
console.log(
  JSON.stringify({
    status: "FILE_PROBE_AND_LOCKED_CONTROLLER_BUILT",
    buildId,
    buildSha256: launchSha256(wire),
    directory,
    osExecutionAllowed: false,
  }),
);
