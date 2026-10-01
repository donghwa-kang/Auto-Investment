import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
// Private historical evidence stays local; public clones verify unchanged policies.
const baselinePath = existsSync("work/phase1-original-hashes.json")
  ? "work/phase1-original-hashes.json"
  : "profiles/public-original-hashes.json";
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
console.log(`원본 검사 범위: ${baselinePath}`);
let failed = 0;
for (const f of baseline) {
  const h = createHash("sha256")
    .update(readFileSync(f.path))
    .digest("hex")
    .toUpperCase();
  if (h !== f.sha256) {
    console.error(`변경 감지: ${f.path}`);
    failed++;
  }
}
console.log(
  `원본 ${baseline.length}개: 일치 ${baseline.length - failed}, 불일치 ${failed}`,
);
process.exitCode = failed ? 1 : 0;
