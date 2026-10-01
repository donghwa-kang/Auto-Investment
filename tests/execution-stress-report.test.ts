import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { runExecutionStressSample } from "../src/server/execution-stress-run.js";
import { d, sum } from "../src/core/math.js";
import { hash } from "../src/core/policy.js";
import { inspectOfflineGraph } from "./network-boundary.js";
import ts from "typescript";

// 기존 엔진 검사기는 환경 설정 읽기만 허용한다. CLI의 최소 부트스트랩은
// 그 검사기를 완화하지 않고 정확한 argv 읽기/실패 종료 구문을 별도 대조한다.
function bootstrapProcessLines(text: string) {
  const source = ts.createSourceFile(
    "cli.js",
    text,
    ts.ScriptTarget.ES2023,
    true,
    ts.ScriptKind.JS,
  );
  const lines: number[] = [];
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && node.text === "process") {
      const access = node.parent;
      const expression = access.parent;
      const code = expression.getText(source).replace(/\s+/g, "");
      if (
        ["process.argv.length", "process.argv[2]", "process.argv[3]"].includes(
          code,
        )
      ) {
        for (
          let child: ts.Node = expression;
          child.parent;
          child = child.parent
        ) {
          const parent = child.parent;
          assert.ok(
            !(
              ts.isBinaryExpression(parent) &&
              parent.left === child &&
              parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
              parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            ),
          );
          assert.ok(
            !(
              (ts.isPrefixUnaryExpression(parent) ||
                ts.isPostfixUnaryExpression(parent)) &&
              [
                ts.SyntaxKind.PlusPlusToken,
                ts.SyntaxKind.MinusMinusToken,
              ].includes(parent.operator)
            ) && !ts.isDeleteExpression(parent),
          );
          assert.ok(
            !(ts.isForInStatement(parent) || ts.isForOfStatement(parent)) ||
              parent.initializer !== child,
          );
        }
      } else {
        assert.equal(code, "process.exitCode=1");
        assert.ok(
          ts.isBinaryExpression(expression) &&
            expression.left === access &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isExpressionStatement(expression.parent),
        );
      }
      lines.push(
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return lines;
}

let report: ReturnType<typeof runExecutionStressSample>;
test("STRESS-REPORT-01 공용 엔진의 다섯 합성 조건과 원화 비용 항등식", () => {
  report = runExecutionStressSample(5000000, "KR");
  assert.equal(report.performanceQualified, false);
  assert.equal(report.learningEligible, false);
  assert.equal(report.liveEnabled, false);
  assert.equal(report.sampleQuoteIntervalMs, 100);
  assert.deepEqual(
    report.results.map((r) => r.name),
    ["CONTROL", "DELAY_ONLY", "SPREAD_ONLY", "ADVERSE", "EXTREME"],
  );
  for (const r of report.results) {
    assert.equal(hash(r.stress), r.stressHash);
    assert.equal(hash(r.state), r.stateHash);
    assert.ok(r.auditEvents >= 203);
    assert.equal(r.timeline.length, 200);
    assert.ok(d(r.availableKRW).gte(0));
    assert.ok(d(r.availableUSD).gte(0));
    assert.equal(
      r.exposureStatus,
      r.openPositions || r.pendingOrders ? "UNRESOLVED_EXPOSURE" : "FLAT",
    );
    const fees = sum(
      r.state.positions.map((p) => d(p.entryFees).plus(p.exitFees)),
    );
    assert.equal(r.feesKrw, fees.toString());
    assert.equal(r.state.ledger.costs.length, 0);
    assert.equal(r.timeline[98]!.status, "RUNNING");
    assert.equal(r.timeline[99]!.status, "ENTRY_PAUSED");
    assert.equal(r.timeline[99]!.at, r.timeline[0]!.at + 9900);
    // 청산 요청은 10초, 실제 매도 의도 생성은 다음 유효 호가(10.1초)다.
    for (const order of r.state.orders.filter((o) => o.side === "SELL"))
      assert.equal(order.submittedAt, r.timeline[100]!.at);
    for (const p of r.state.positions.filter((p) => p.closedAt)) {
      assert.equal(
        p.netPnl,
        d(p.exitValue)
          .minus(p.buyValue)
          .minus(p.entryFees)
          .minus(p.exitFees)
          .toString(),
      );
    }
    if (r.exposureStatus === "FLAT")
      assert.equal(r.equityChangeKrw, r.closedTradeNetKrw);
  }
  assert.ok(report.results[0]!.filledBuyQuantity > 0);
  assert.equal(
    report.results[1]!.firstFillAt! - report.results[0]!.firstFillAt!,
    300,
  );
  const spread = report.results[2]!;
  assert.ok(spread.filledBuyQuantity > 0);
  assert.ok(d(spread.equityChangeKrw).lt(report.results[0]!.equityChangeKrw));
});

test("STRESS-REPORT-02 CLI는 잘못된 금액·시장·LIVE를 거절한다", () => {
  const cli = resolve("dist/runtime/src/server/execution-stress-cli.js");
  for (const args of [
    [],
    ["0", "KR"],
    ["5000001", "KR"],
    ["1.5", "KR"],
    ["1000", "JP"],
    ["1000", "KR", "extra"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /OFFLINE_STRESS_SAMPLE_FAILED/);
  }
  for (const env of [{ TRADING_MODE: "LIVE" }, { LIVE_ENABLED: "true" }]) {
    const result = spawnSync(process.execPath, [cli, "5000000", "KR"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, ...env },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /OFFLINE_STRESS_SAMPLE_FAILED/);
  }
});

test("STRESS-REPORT-03 새 실행/CLI 전이 의존성의 통신 경계를 정적으로 검사한다", () => {
  const root = resolve("dist/runtime");
  const report = inspectOfflineGraph(
    (id) => {
      const path = resolve(root, id);
      const rel = relative(root, path);
      assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    },
    ["src/server/execution-stress-cli.js"],
  );
  const cli = "src/server/execution-stress-cli.js";
  const allowedLines = bootstrapProcessLines(
    readFileSync(resolve(root, cli), "utf8"),
  );
  assert.equal(allowedLines.length, 6);
  assert.deepEqual(
    report.findings,
    allowedLines.map((line) => ({
      file: cli,
      line,
      code: "PROCESS_CAPABILITY",
      detail: "Only TRADING_MODE/LIVE_ENABLED configuration reads are allowed",
    })),
  );
  assert.ok(report.modules.includes("src/core/simulator.js"));
  assert.ok(report.modules.includes("src/core/approval.js"));
  assert.ok(!report.modules.includes("src/server/toss-market-data.js"));
});

test("STRESS-REPORT-04 CLI 부트스트랩 예외는 로더·별칭·인수 변경·임의 환경 접근을 허용하지 않는다", () => {
  assert.equal(
    bootstrapProcessLines(
      "const n=process.argv.length; const a=process.argv[2]; const b=process.argv[3]; process.exitCode=1;",
    ).length,
    4,
  );
  for (const source of [
    "process.getBuiltinModule('https');",
    "const p=process;",
    "process.argv[2]='secret';",
    "process.exitCode=0;",
    "[process.exitCode=1]=[0];",
    "({code:process.exitCode=1}={code:0});",
    "process.env.SECRET;",
    "process.exit(0);",
    "process.argv[2]++;",
    "delete process.argv[2];",
    "process['argv'][2];",
  ])
    assert.throws(() => bootstrapProcessLines(source));
});
