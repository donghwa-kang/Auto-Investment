import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../../src/server/engine.js";
import { PortfolioWebService } from "../../src/server/portfolio-web-service.js";
import { CodexAnalysisService } from "../../src/server/codex-analysis-service.js";
import { RestrictedAnalysisProcess } from "../../src/server/analysis-process.js";
import { AnalysisRecordSources } from "../../src/server/analysis-record-source.js";
import { createApp } from "../../src/server/http.js";

test("PROCESS-UI 승인에 실행 코드/제한 표시·분리 실행·재조회·중복·모바일", async ({
  page,
}) => {
  const root = mkdtempSync(resolve(tmpdir(), "analysis-process-browser-"));
  const runner = new RestrictedAnalysisProcess(
    resolve(root, "executions"),
    resolve("dist/runtime/src/server/analysis-process-worker.js"),
  );
  const engine = new Engine(":memory:"),
    portfolio = new PortfolioWebService(resolve(root, "runs")),
    analysis = new CodexAnalysisService(
      resolve(root, "mock.sqlite"),
      undefined,
      Date.now,
      new AnalysisRecordSources(
        resolve(root, "recorded-runs"),
        resolve(root, "sources"),
      ),
      runner,
    );
  const code = "TEST_ONLY_PROCESS_BROWSER_12345",
    app = createApp(engine, code, { portfolio, analysis }),
    url = await app.listen(0);
  const outside: string[] = [],
    errors: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(url)) outside.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(url + "/?view=portfolio");
    await page.getByLabel("연결 코드", { exact: true }).fill(code);
    await page.getByRole("button", { name: "연결", exact: true }).click();
    const menu = () =>
      page.getByRole("button", { name: "Codex 분석 · 모형", exact: true });
    await menu().click();
    await expect(
      page.getByText("선택할 기록 전용 실행이 없습니다.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("기록 목록을 읽을 수 없습니다.", { exact: false }),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "합성 자료로 분석 요청 만들기",
        exact: true,
      })
      .click();
    await expect(page.getByTestId("analysis-execution-boundary")).toContainText(
      runner.binding.workerSha256,
    );
    await expect(page.getByTestId("analysis-execution-boundary")).toContainText(
      "OS 샌드박스가 아니며",
    );
    await page
      .getByText("전달 예정 자료 전체 보기 (JSON)", { exact: true })
      .click();
    await expect(page.getByTestId("analysis-payload")).toContainText(
      "RESTRICTED_NODE_MOCK_STDIO_V1",
    );
    await page
      .getByLabel("전체 자료를 열어 확인했고", { exact: false })
      .check();
    await page
      .getByLabel("실제 Codex 분석·외부 전송", { exact: false })
      .check();
    await page.screenshot({
      path: "test-results/analysis-process-consent-desktop.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "이 자료의 모형 전달 승인", exact: true })
      .click();
    expect(analysis.view().mockCalls).toBe(0);
    await page
      .getByRole("button", { name: "승인된 모형 1회 실행", exact: true })
      .click();
    await expect(page.getByTestId("analysis-status")).toHaveText(
      "모형 결과 검증 통과",
    );
    const j = analysis.view().jobs[0]!,
      receipt = JSON.parse(
        readFileSync(
          resolve(runner.root, j.request.id, "receipt.json"),
          "utf8",
        ),
      );
    expect(receipt.outcome).toBe("COMPLETE");
    expect(receipt.childPid).not.toBe(process.pid);
    await page.reload();
    await menu().click();
    await expect(page.getByTestId("analysis-status")).toHaveText(
      "모형 결과 검증 통과",
    );
    expect(analysis.view().jobs[0]!.resultHash).toBe(j.resultHash);
    expect(analysis.view().mockCalls).toBe(1);
    for (const width of [390, 720]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/analysis-process-result-${width}.png`,
        fullPage: true,
      });
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
    expect(engine.state().orders).toEqual([]);
    expect(portfolio.view().runs).toEqual([]);
  } finally {
    await app.close();
    await analysis.close();
    await portfolio.close();
    engine.close();
  }
});
