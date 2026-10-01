import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectNativePe,
  nativeToolHashes,
  serializeNativeBuild,
} from "../dist/runtime/src/core/analysis-native-contract.js";
import { launchSha256 } from "../dist/runtime/src/core/analysis-launch-plan.js";
import {
  readLaunchFile,
  requireLaunchDirectory,
} from "../dist/runtime/src/server/analysis-launch-files.js";
import { nativeSourceHashes } from "../dist/runtime/src/server/analysis-native-runner.js";

// This is an installed-toolchain-specific offline build; it never installs or probes credentials.
if (
  process.argv.length !== 2 ||
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  process.versions.node !== "24.20.0"
)
  throw new Error("NATIVE_BUILD_FIXED_RUNTIME_AND_NO_ARGUMENTS_REQUIRED");
const workspace = fileURLToPath(new URL("../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const msvc =
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\MSVC\\14.39.33519";
const sdk = "C:\\Program Files (x86)\\Windows Kits\\10";
const bin = join(msvc, "bin", "Hostx64", "x64");
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
const tools = Object.fromEntries(
  Object.keys(nativeToolHashes).map((name) => [name, join(bin, `${name}.exe`)]),
);
for (const [name, path] of Object.entries(tools)) {
  if (launchSha256(readLaunchFile(path, 4194304)) !== nativeToolHashes[name])
    throw new Error("NATIVE_TOOLCHAIN_HASH_MISMATCH");
}
for (const directory of [...include, ...libs])
  requireLaunchDirectory(directory);
const sourceHashes = nativeSourceHashes(workspace);
requireLaunchDirectory(join(workspace, "work"));
const parent = join(workspace, "work", "analysis-native-build");
if (!existsSync(parent)) mkdirSync(parent);
requireLaunchDirectory(parent);
const buildId = randomUUID();
const output = join(parent, `build-${buildId}`);
mkdirSync(output);
requireLaunchDirectory(output);
const steps = [];
const commandLog = () =>
  JSON.stringify({ scope: "LOCAL_OFFLINE_BUILD_ONLY", steps }, null, 2) + "\n";
function run(name, args) {
  const result = spawnSync(tools[name], args, {
    cwd: output,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45000,
    maxBuffer: 262144,
    env: {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: `${bin};C:\\Windows\\System32`,
      TEMP: output,
      TMP: output,
    },
  });
  steps.push({
    tool: tools[name],
    args,
    exitCode: result.status,
    error: result.error?.code ?? null,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  // Preserve failed builds too, without issuing a successful build receipt.
  if (result.status !== 0 || result.error) {
    writeFileSync(join(output, "failed-build.json"), commandLog(), {
      flag: "wx",
    });
    throw new Error(`NATIVE_BUILD_FAILED: ${output}`);
  }
  return result.stdout;
}
const obj = join(output, "analysis-validator.obj");
const exe = join(output, "analysis-native-check.exe");
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
  `/Fo${obj}`,
  join(workspace, "src", "native", "analysis-validator.cpp"),
]);
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
  obj,
  "kernel32.lib",
]);
const evidence = {};
for (const option of ["headers", "imports", "loadconfig"]) {
  const text = run("dumpbin", [`/${option}`, exe]);
  writeFileSync(join(output, `${option}.txt`), text, { flag: "wx" });
  evidence[option] = launchSha256(text);
}
writeFileSync(join(output, "commands.txt"), commandLog(), { flag: "wx" });
evidence.commands = launchSha256(commandLog());
const binary = readLaunchFile(exe, 2097152);
inspectNativePe(binary);
if (
  JSON.stringify(sourceHashes) !== JSON.stringify(nativeSourceHashes(workspace))
)
  throw new Error("NATIVE_BUILD_SOURCE_CHANGED");
for (const [name, path] of Object.entries(tools)) {
  if (launchSha256(readLaunchFile(path, 4194304)) !== nativeToolHashes[name])
    throw new Error("NATIVE_TOOLCHAIN_CHANGED");
}
const receipt = serializeNativeBuild({
  version: "ANALYSIS_NATIVE_VALIDATOR_BUILD_V1",
  buildId,
  scope: "STDIO_VALIDATOR_ONLY_NOT_OS_LAUNCHER",
  sourceHashes,
  toolHashes: nativeToolHashes,
  artifact: {
    file: "analysis-native-check.exe",
    bytes: binary.length,
    sha256: launchSha256(binary),
  },
  evidence,
  executionAllowed: false,
  actualOsTests: "NOT_RUN",
});
writeFileSync(join(output, "build.json"), receipt, { flag: "wx" });
console.log(
  JSON.stringify({
    buildId,
    buildSha256: launchSha256(receipt),
    directory: output,
    status: "VALIDATOR_BUILT_NOT_OS_LAUNCHER",
    executionAllowed: false,
  }),
);
