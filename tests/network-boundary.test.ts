import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import {
  inspectOfflineGraph,
  offlineRoots,
  type BoundaryReport,
} from "./network-boundary.js";

// 제품 모듈은 실행/import하지 않는다. 빌드된 JavaScript와 등록된 JSON 데이터만 읽는다.
const compiledRoot = resolve("dist/runtime");
const sources = new Map<string, string>();
function readCompiled(id: string): string | undefined {
  const saved = sources.get(id);
  if (saved !== undefined) return saved;
  assert.match(
    id,
    /^(?:src\/(?:[\w-]+\/)*[\w-]+\.js|(?:outputs|profiles|fixtures)\/(?:[\w-]+\/)*[\w.-]+\.json)$/,
  );
  const path = resolve(compiledRoot, ...id.split("/"));
  const inside = relative(compiledRoot, path);
  assert.ok(!inside.startsWith("..") && !isAbsolute(inside));
  try {
    // 파일뿐 아니라 각 상위 경로도 확인해 링크 경유를 허용하지 않는다.
    for (
      let current = path;
      current !== parse(current).root;
      current = dirname(current)
    )
      assert.equal(lstatSync(current).isSymbolicLink(), false, current);
    assert.ok(lstatSync(path).isFile(), id);
    const text = readFileSync(path, "utf8");
    sources.set(id, text);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

let actual: BoundaryReport | undefined;
const actualReport = () => (actual ??= inspectOfflineGraph(readCompiled));
const fixtureRoot = "src/fixture/root.js";
function fixture(source: string, extra: Record<string, string> = {}) {
  const files: Record<string, string> = { [fixtureRoot]: source, ...extra };
  return inspectOfflineGraph((id) => files[id], [fixtureRoot]);
}
function rejects(report: BoundaryReport, code: string) {
  assert.ok(
    report.findings.some((finding) => finding.code === code),
    JSON.stringify(report.findings),
  );
  assert.ok(
    report.findings.every(
      (finding) => Number.isInteger(finding.line) && finding.line >= 1,
    ),
  );
}

test("BOUNDARY-01 빌드된 다섯 진입점의 전체 정적 의존 그래프를 읽기 전용 검사", () => {
  const report = actualReport();
  assert.equal(offlineRoots.length, 5);
  for (const root of offlineRoots)
    assert.ok(report.modules.includes(root), root);
  assert.deepEqual(report.findings, []);
  assert.ok(report.modules.includes("src/core/approval.js"));
  assert.ok(report.modules.includes("src/core/signal-replay.js"));
  assert.ok(report.modules.includes("src/server/repository.js"));
  assert.ok(report.externals.includes("zod"));
  assert.ok(report.externals.includes("decimal.js"));
});

test("BOUNDARY-02 독립 분석 모형·수집·HTTP는 엔진 그래프 밖이며 PROCESS 시험과 구분", () => {
  const report = actualReport();
  for (const id of [
    "src/server/analysis-process.js",
    "src/server/analysis-process-worker.js",
    "src/server/toss-market-data.js",
    "src/server/toss-catalog-client.js",
    "src/server/http.js",
  ])
    assert.ok(!report.modules.includes(id), id);
  // 분석 worker의 차단 자기검사 실행은 analysis-process.test.ts의 PROCESS-01/08 담당.
  // 이 구조 검사는 그 시험을 대체하거나 OS 전체 통신 격리를 입증하지 않는다.
});

for (const [number, file] of [
  [3, "src/server/toss-market-data.js"],
  [4, "src/server/toss-catalog-client.js"],
] as const) {
  test(`BOUNDARY-0${number} 실제 수집 모듈 ${file}의 별칭 fetch 능력을 실행 없이 검출`, () => {
    const report = inspectOfflineGraph(readCompiled, [file]);
    assert.ok(
      report.findings.some(
        (finding) =>
          finding.file === file &&
          finding.code === "DENIED_CAPABILITY" &&
          finding.detail === "fetch",
      ),
    );
  });
}

test("BOUNDARY-05 side-effect import의 전이 의존성도 검사", () => {
  const report = fixture('import "./middle.js";', {
    "src/fixture/middle.js": 'import "./leaf.js";',
    "src/fixture/leaf.js":
      'import { createHash } from "node:crypto"; export const value = createHash;',
  });
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.modules, [
    "src/fixture/leaf.js",
    "src/fixture/middle.js",
    fixtureRoot,
  ]);
  assert.deepEqual(report.externals, ["node:crypto"]);
});

test("BOUNDARY-06 export-star 및 named re-export 뒤의 금지 모듈도 검사", () => {
  const report = fixture('export * from "./middle.js";', {
    "src/fixture/middle.js": 'export { request } from "./leaf.js";',
    "src/fixture/leaf.js": 'export { request } from "node:https";',
  });
  rejects(report, "UNREVIEWED_MODULE");
  assert.ok(report.modules.includes("src/fixture/leaf.js"));
});

test("BOUNDARY-07 순환 import는 한 번씩 검사하되 뒤쪽 의존성을 누락하지 않음", () => {
  const report = fixture('import "./middle.js";', {
    "src/fixture/middle.js": 'import "./root.js"; import "./leaf.js";',
    "src/fixture/leaf.js": 'import "node:net";',
  });
  rejects(report, "UNREVIEWED_MODULE");
  assert.equal(report.modules.length, 3);
  assert.equal(new Set(report.modules).size, 3);
});

test("BOUNDARY-08 금지 API를 설명하는 주석·문자열은 실행 능력으로 오인하지 않음", () => {
  const report = fixture(
    '// fetch("https://example.invalid"); import("node:net");\nconst description = "fetch node:https WebSocket globalThis"; export { description };',
  );
  assert.deepEqual(report.findings, []);
});

const capabilityCases = [
  [9, "직접 fetch", 'fetch("https://example.invalid");', "DENIED_CAPABILITY"],
  [
    10,
    "fetch 함수 별칭",
    'const send = fetch; send("https://example.invalid");',
    "DENIED_CAPABILITY",
  ],
  [
    11,
    "계산한 전역 속성",
    'globalThis["fe" + "tch"]("https://example.invalid");',
    "DENIED_CAPABILITY",
  ],
  [
    12,
    "전역 객체 별칭",
    'const g = globalThis; g["fetch"]("https://example.invalid");',
    "DENIED_CAPABILITY",
  ],
  [
    13,
    "구조 분해 별칭",
    'const { fetch: send } = globalThis; send("https://example.invalid");',
    "DENIED_CAPABILITY",
  ],
  [
    14,
    "Reflect 전역 접근",
    'Reflect.get(globalThis, "fetch")("https://example.invalid");',
    "DENIED_CAPABILITY",
  ],
  [
    15,
    "process 객체 별칭",
    'const p = process; p["get" + "BuiltinModule"]("https");',
    "PROCESS_CAPABILITY",
  ],
  [
    16,
    "process 계산 속성",
    'process["get" + "BuiltinModule"]("https");',
    "PROCESS_CAPABILITY",
  ],
  [
    17,
    "CommonJS require",
    'const transport = require("https");',
    "DENIED_CAPABILITY",
  ],
  [18, "문자열 eval", 'eval("1");', "DENIED_CAPABILITY"],
  [19, "Function 생성", 'new Function("return 1");', "DENIED_CAPABILITY"],
  [
    20,
    "createRequire 로더",
    'import { createRequire } from "node:module"; const load = createRequire(import.meta.url);',
    "DENIED_CAPABILITY",
  ],
] as const;
for (const [number, name, source, code] of capabilityCases)
  test(`BOUNDARY-${number} ${name}의 실행 능력 추가를 거절`, () => {
    const report = fixture(source);
    assert.ok(
      !report.findings.some((finding) => finding.code === "INVALID_SYNTAX"),
    );
    rejects(report, code);
  });

test("BOUNDARY-21 리터럴 및 비리터럴 dynamic import는 별도 검토 전 거절", () => {
  for (const source of [
    'import("./leaf.js");',
    'const name = "node:https"; import(name);',
  ])
    rejects(fixture(source), "DYNAMIC_IMPORT");
});

test("BOUNDARY-22 미등록 내장 모듈·외부 패키지·허용 패키지 하위 경로 거절", () => {
  for (const specifier of [
    "node:net",
    "https",
    "undici",
    "zod/unreviewed",
    "node:child_process",
  ])
    rejects(
      fixture(`import ${JSON.stringify(specifier)};`),
      "UNREVIEWED_MODULE",
    );
});

test("BOUNDARY-23 루트 이탈·확장자·검색문자열·역슬래시 상대 import 거절", () => {
  for (const specifier of [
    "../../outside.js",
    "./leaf.mjs",
    "./leaf.js?x=1",
    "./leaf.js#fragment",
    "./folder\\leaf.js",
  ])
    rejects(
      fixture(`import ${JSON.stringify(specifier)};`),
      "INVALID_LOCAL_MODULE",
    );
});

test("BOUNDARY-24 존재하지 않는 전이 모듈은 성공으로 건너뛰지 않음", () => {
  const report = fixture('import "./missing.js";');
  rejects(report, "MISSING_MODULE");
  assert.ok(
    report.findings.some(
      (finding) => finding.file === "src/fixture/missing.js",
    ),
  );
});

test("BOUNDARY-25 파싱 가능한 일부 AST가 있어도 문법 오류는 거절", () => {
  rejects(fixture("const value = ;"), "INVALID_SYNTAX");
});

const engineId = "src/server/engine.js";
const evaluatorId = "src/server/evaluator-worker.js";
function workerFixture(
  transform: (source: string) => string = (source) => source,
) {
  const engine = readCompiled(engineId),
    evaluator = readCompiled(evaluatorId);
  assert.ok(engine !== undefined);
  assert.ok(evaluator !== undefined);
  return inspectOfflineGraph(
    (id) =>
      id === engineId
        ? transform(engine)
        : id === evaluatorId
          ? evaluator
          : "export {};",
    [engineId],
  );
}
function replacement(source: string, before: string, after: string) {
  assert.ok(source.includes(before), `BUILD_FIXTURE_CHANGED:${before}`);
  return source.replace(before, after);
}

test("BOUNDARY-26 실제 빌드의 고정 evaluator Worker 구조를 승인", () => {
  const report = workerFixture();
  assert.deepEqual(report.findings, []);
  assert.ok(report.modules.includes(evaluatorId));
});

test("BOUNDARY-27 Worker 실행 경로 변경은 거절", () => {
  rejects(
    workerFixture((source) =>
      replacement(
        source,
        'resolve("dist/runtime/src/server/evaluator-worker.js")',
        'resolve("dist/runtime/src/server/other-worker.js")',
      ),
    ),
    "WORKER_ENTRY",
  );
});

test("BOUNDARY-28 Worker 옵션 spread를 통한 덮어쓰기는 거절", () => {
  rejects(
    workerFixture((source) =>
      replacement(source, "execArgv: [],", "execArgv: [], ...other,"),
    ),
    "WORKER_ENTRY",
  );
});

test("BOUNDARY-29 Worker import·생성자 별칭은 거절", () => {
  rejects(
    workerFixture((source) =>
      replacement(
        replacement(
          source,
          'import { Worker } from "node:worker_threads";',
          'import { Worker as Launcher } from "node:worker_threads";',
        ),
        "new Worker(workerUrl,",
        "new Launcher(workerUrl,",
      ),
    ),
    "WORKER_IMPORT",
  );
});

test("BOUNDARY-30 추가 Worker 생성은 거절", () => {
  rejects(
    workerFixture((source) => source + "\nnew Worker(workerUrl, {});"),
    "WORKER_ENTRY",
  );
});

test("BOUNDARY-31 Worker URL 바인딩을 변경 가능한 let으로 전환하면 거절", () => {
  rejects(
    workerFixture((source) =>
      replacement(source, "const workerUrl =", "let workerUrl ="),
    ),
    "WORKER_ENTRY",
  );
});

test("BOUNDARY-32 Worker execArgv 중복 키 덮어쓰기는 거절", () => {
  rejects(
    workerFixture((source) =>
      replacement(source, "execArgv: [],", "execArgv: [], execArgv: extra,"),
    ),
    "WORKER_ENTRY",
  );
});

test("BOUNDARY-33 등록된 JSON은 type 속성을 확인하고 실행 없이 데이터로 읽음", () => {
  const id = "profiles/synthetic-v1.json";
  const report = fixture(
    'import data from "../../profiles/synthetic-v1.json" with { type: "json" };',
    { [id]: '{"purpose":"TEST_ONLY"}' },
  );
  assert.deepEqual(report.findings, []);
  assert.ok(report.modules.includes(id));
});

test("BOUNDARY-34 미등록 JSON과 누락·잘못된 JSON import 속성은 거절", () => {
  rejects(
    fixture(
      'import data from "../../profiles/unreviewed.json" with { type: "json" };',
    ),
    "INVALID_LOCAL_MODULE",
  );
  for (const attributes of ["", ' with { type: "javascript" }'])
    rejects(
      fixture(
        `import data from "../../profiles/synthetic-v1.json"${attributes};`,
      ),
      "JSON_IMPORT_ATTRIBUTE",
    );
});

test("BOUNDARY-35 등록된 JSON도 잘못된 데이터면 성공으로 취급하지 않음", () => {
  const report = fixture(
    'import data from "../../profiles/synthetic-v1.json" with { type: "json" };',
    { "profiles/synthetic-v1.json": "not valid JSON" },
  );
  rejects(report, "INVALID_JSON");
});

test("BOUNDARY-36 현재 두 거래 설정의 명시적 읽기만 허용", () => {
  assert.deepEqual(
    fixture(
      'const mode = process.env.TRADING_MODE ?? "PAPER"; const live = process.env.LIVE_ENABLED ?? false;',
    ).findings,
    [],
  );
  for (const source of [
    "process.env.NODE_OPTIONS;",
    "const env = process.env;",
    'process["env"].TRADING_MODE;',
  ])
    rejects(fixture(source), "PROCESS_CAPABILITY");
});

test("BOUNDARY-37 환경변수 쓰기·삭제·증감·구조분해·반복 할당 거절", () => {
  for (const source of [
    'process.env.NODE_OPTIONS = "TEST_ONLY";',
    'process.env.TRADING_MODE = "TEST_ONLY";',
    "delete process.env.LIVE_ENABLED;",
    "process.env.LIVE_ENABLED++;",
    "++process.env.LIVE_ENABLED;",
    '(process.env.TRADING_MODE) = "TEST_ONLY";',
    "({value: process.env.TRADING_MODE} = input);",
    "for (process.env.TRADING_MODE of input) {}",
  ])
    rejects(fixture(source), "PROCESS_CAPABILITY");
});

test("BOUNDARY-38 WebSocket/EventSource와 추가 worker 능력도 거절", () => {
  for (const source of [
    "const Connect = WebSocket;",
    "const Events = EventSource;",
    "const transport = XMLHttpRequest;",
    "const g = global;",
  ])
    rejects(fixture(source), "DENIED_CAPABILITY");
  rejects(
    fixture(
      'import { Worker } from "node:worker_threads"; new Worker("other.js");',
    ),
    "WORKER_IMPORT",
  );
});

test("BOUNDARY-39 고정 Worker URL 해석 함수의 import 교체 거절", () => {
  rejects(
    workerFixture((source) =>
      replacement(
        source,
        'import { resolve } from "node:path";',
        'import { resolve } from "./other-path.js";',
      ),
    ),
    "WORKER_BINDING",
  );
});
