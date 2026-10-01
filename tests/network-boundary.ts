// 테스트 전용 구조 검사. 악성 JavaScript 분석기나 OS 네트워크 차단기가 아니다.
// 빌드 산출물을 읽기만 하며 import/실행하지 않는다. 타입 전용 의존성은 이미 제거되어 있다.
import ts from "typescript";
import { posix } from "node:path";

const engine = "src/server/engine.js";
const evaluator = "src/server/evaluator-worker.js";
export const offlineRoots = [
  engine,
  evaluator,
  "src/server/portfolio-engine.js",
  // 생성자 주입으로 컴파일 후 import가 사라져도 판단 구현을 검사한다.
  "src/core/portfolio-program.js",
  // 웹용 프로그램/엔진 생성 지점도 포함한다. HTTP 서버나 수집 CLI는 실행하지 않는다.
  "src/server/portfolio-web-run.js",
] as const;

const reviewedExternals = new Set([
  "node:crypto",
  "node:fs",
  "node:path",
  "node:url",
  "node:sqlite",
  "zod",
  "decimal.js",
]);
const reviewedJson = new Set([
  "outputs/AI_TRADING_POLICY_v2.3.json",
  "outputs/TRADING_STRATEGY_SPEC_v1.0.json",
  "outputs/THEME_RESEARCH_POLICY_v1.3.json",
  "profiles/synthetic-v1.json",
  "profiles/research-scope-v1.json",
  "profiles/signal-replay-v1.json",
  "fixtures/multi-preflight-v1.json",
]);
const deniedNames = new Set([
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "globalThis",
  "global",
  "Reflect",
  "eval",
  "Function",
  "require",
  "createRequire",
  "getBuiltinModule",
]);
const printer = ts.createPrinter({ removeComments: true });
const signature = (node: ts.Node, source: ts.SourceFile) => {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2023,
    true,
    ts.LanguageVariant.Standard,
    printer.printNode(ts.EmitHint.Unspecified, node, source),
  );
  const tokens: string[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken)
    tokens.push(scanner.getTokenText());
  return tokens
    .filter(
      (token, i) =>
        !(token === "," && ["}", "]", ")"].includes(tokens[i + 1] ?? "")),
    )
    .join(" ");
};
const parsed = (source: string) =>
  ts.createSourceFile(
    "boundary.js",
    source,
    ts.ScriptTarget.ES2023,
    true,
    ts.ScriptKind.JS,
  );
const expectedExpression = (text: string) => {
  const source = parsed(`${text};`);
  return signature(
    (source.statements[0] as ts.ExpressionStatement).expression,
    source,
  );
};
const workerUrlShape = expectedExpression(
  'pathToFileURL(resolve("dist/runtime/src/server/evaluator-worker.js"))',
);
const workerShape = expectedExpression(
  "new Worker(workerUrl, { workerData: { config, at }, execArgv: [] })",
);

function configurationRead(node: ts.Identifier): boolean {
  const env = node.parent;
  if (
    !ts.isPropertyAccessExpression(env) ||
    env.expression !== node ||
    env.name.text !== "env"
  )
    return false;
  const setting = env.parent;
  if (
    !ts.isPropertyAccessExpression(setting) ||
    setting.expression !== env ||
    !["TRADING_MODE", "LIVE_ENABLED"].includes(setting.name.text)
  )
    return false;
  // 괄호·구조 분해를 포함한 쓰기 대상, 삭제·증감·for 할당은 보수적으로 거절한다.
  for (let child: ts.Node = setting; child.parent; child = child.parent) {
    const parent = child.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === child &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      return false;
    if (
      ts.isDeleteExpression(parent) ||
      ts.isPostfixUnaryExpression(parent) ||
      (ts.isPrefixUnaryExpression(parent) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
          parent.operator,
        ))
    )
      return false;
    if (
      (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
      parent.initializer === child
    )
      return false;
  }
  return true;
}

export interface BoundaryFinding {
  file: string;
  line: number;
  code: string;
  detail: string;
}
export interface BoundaryReport {
  modules: string[];
  externals: string[];
  findings: BoundaryFinding[];
}

export function inspectOfflineGraph(
  read: (id: string) => string | undefined,
  roots: readonly string[] = offlineRoots,
): BoundaryReport {
  const modules = new Set<string>(),
    externals = new Set<string>();
  const findings: BoundaryFinding[] = [];
  const visitModule = (file: string) => {
    if (modules.has(file)) return;
    modules.add(file);
    const content = read(file);
    if (content === undefined) {
      findings.push({ file, line: 1, code: "MISSING_MODULE", detail: file });
      return;
    }
    if (reviewedJson.has(file)) {
      try {
        JSON.parse(content);
      } catch {
        findings.push({ file, line: 1, code: "INVALID_JSON", detail: file });
      }
      return;
    }
    const source = parsed(content);
    const fail = (node: ts.Node, code: string, detail: string) =>
      findings.push({
        file,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        code,
        detail,
      });
    // 오류 복구로 만들어진 AST만 보고 잘못된 구문을 성공 처리하지 않는다.
    const diagnostics =
      ts.transpileModule(content, {
        fileName: "boundary.js",
        compilerOptions: {
          allowJs: true,
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
        },
        reportDiagnostics: true,
      }).diagnostics ?? [];
    if (diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error))
      fail(
        source,
        "INVALID_SYNTAX",
        "Build must succeed before boundary inspection",
      );
    const identifiers = new Map<string, ts.Identifier[]>();
    const workerImports: ts.ImportDeclaration[] = [];
    const newWorkers: ts.NewExpression[] = [];
    const workerUrls: ts.VariableDeclaration[] = [];
    const dependency = (node: ts.Node, specifier: ts.Expression) => {
      if (!ts.isStringLiteral(specifier)) {
        fail(
          node,
          "UNKNOWN_MODULE",
          "Only literal static imports are supported",
        );
        return;
      }
      const spec = specifier.text;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const target = posix.normalize(posix.join(posix.dirname(file), spec));
        if (reviewedJson.has(target)) {
          const attributes =
            ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
              ? node.attributes
              : undefined;
          if (
            attributes?.elements.length !== 1 ||
            attributes.elements[0]?.name.text !== "type" ||
            !ts.isStringLiteral(attributes.elements[0].value) ||
            attributes.elements[0].value.text !== "json"
          )
            fail(node, "JSON_IMPORT_ATTRIBUTE", target);
          else visitModule(target);
        } else if (
          !target.startsWith("src/") ||
          !target.endsWith(".js") ||
          /[\\?#:]/.test(target)
        )
          fail(node, "INVALID_LOCAL_MODULE", spec);
        else visitModule(target);
      } else {
        externals.add(spec);
        if (spec === "node:worker_threads" && ts.isImportDeclaration(node))
          workerImports.push(node);
        else if (!reviewedExternals.has(spec))
          fail(node, "UNREVIEWED_MODULE", spec);
      }
    };
    const walk = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) dependency(node, node.moduleSpecifier);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier)
        dependency(node, node.moduleSpecifier);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        fail(
          node,
          "DYNAMIC_IMPORT",
          "Dynamic loading requires a separate reviewed boundary",
        );
      if (ts.isIdentifier(node)) {
        const list = identifiers.get(node.text) ?? [];
        list.push(node);
        identifiers.set(node.text, list);
        if (deniedNames.has(node.text))
          fail(node, "DENIED_CAPABILITY", node.text);
        // process의 별칭/계산 속성으로 내장 모듈 로더에 접근하는 경로를 허용하지 않는다.
        if (node.text === "process" && !configurationRead(node))
          fail(
            node,
            "PROCESS_CAPABILITY",
            "Only TRADING_MODE/LIVE_ENABLED configuration reads are allowed",
          );
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Worker"
      )
        newWorkers.push(node);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "workerUrl"
      )
        workerUrls.push(node);
      ts.forEachChild(node, walk);
    };
    walk(source);
    if (
      workerImports.length ||
      identifiers.has("Worker") ||
      file === engine ||
      file === evaluator
    ) {
      const wanted =
        file === engine
          ? 'import { Worker } from "node:worker_threads";'
          : 'import { parentPort, workerData } from "node:worker_threads";';
      const expected = parsed(wanted);
      if (
        ![engine, evaluator].includes(file) ||
        workerImports.length !== 1 ||
        signature(workerImports[0] ?? source, source) !==
          signature(expected.statements[0]!, expected)
      )
        fail(
          source,
          "WORKER_IMPORT",
          "Only the reviewed engine/evaluator named imports are allowed",
        );
      if (file === engine) {
        const url = workerUrls[0];
        const declaration = url?.parent;
        const constUrl =
          declaration &&
          ts.isVariableDeclarationList(declaration) &&
          (declaration.flags & ts.NodeFlags.Const) !== 0;
        if (
          newWorkers.length !== 1 ||
          signature(newWorkers[0] ?? source, source) !== workerShape ||
          workerUrls.length !== 1 ||
          !constUrl ||
          !url?.initializer ||
          signature(url.initializer, source) !== workerUrlShape
        )
          fail(
            source,
            "WORKER_ENTRY",
            "Fixed evaluator entry, data and execArgv required",
          );
        // 별칭/재정의/추가 생성으로 고정 진입점을 우회하지 못하게 현재 바인딩 사용 수도 고정한다.
        for (const name of ["Worker", "workerUrl", "resolve", "pathToFileURL"])
          if (
            identifiers
              .get(name)
              ?.filter(
                (n) =>
                  !(
                    ts.isPropertyAccessExpression(n.parent) &&
                    n.parent.name === n
                  ),
              ).length !== 2
          )
            fail(source, "WORKER_BINDING", name);
        for (const [module, name] of [
          ["node:path", "resolve"],
          ["node:url", "pathToFileURL"],
        ] as const) {
          const expectedImport = parsed(`import { ${name} } from "${module}";`);
          const wantedSignature = signature(
            expectedImport.statements[0]!,
            expectedImport,
          );
          if (
            !source.statements.some(
              (s) =>
                ts.isImportDeclaration(s) &&
                signature(s, source) === wantedSignature,
            )
          )
            fail(source, "WORKER_BINDING", `${module}:${name}`);
        }
        visitModule(evaluator);
      } else if (newWorkers.length || identifiers.has("Worker"))
        fail(source, "WORKER_ENTRY", "No additional workers allowed");
    }
  };
  for (const root of roots) visitModule(root);
  return {
    modules: [...modules].sort(),
    externals: [...externals].sort(),
    findings,
  };
}
