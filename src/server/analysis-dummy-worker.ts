import { executeDummyFileProbe } from "./analysis-dummy-files.js";

if (process.argv.length !== 2) process.exit(1);
const chunks: Buffer[] = [];
let size = 0;
const timer = setTimeout(() => process.exit(1), 5000);
process.stdin.on("data", (bytes: Buffer) => {
  size += bytes.length;
  if (size > 4096) process.exit(1);
  chunks.push(bytes);
});
process.stdin.on("end", () => {
  clearTimeout(timer);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    const result = executeDummyFileProbe(JSON.parse(text));
    process.stdout.write(JSON.stringify(result));
  } catch {
    process.exitCode = 1;
  }
});
