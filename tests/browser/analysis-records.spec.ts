import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Engine } from "../../src/server/engine.js";
import { PortfolioWebService } from "../../src/server/portfolio-web-service.js";
import { CodexAnalysisService } from "../../src/server/codex-analysis-service.js";
import { createApp } from "../../src/server/http.js";
import { recordedAnalysisFixture } from "../analysis-record-helpers.js";

test("RECORD-UI 기록 선택·기간 변경·최소 자료·별도 동의·모형 결과·새로고침·모바일", async ({
  page,
}) => {
  const f = recordedAnalysisFixture(),
    before = readFileSync(f.path);
  const engine = new Engine(":memory:"),
    portfolio = new PortfolioWebService(resolve(f.root, "web-runs"));
  const analysis = new CodexAnalysisService(
    resolve(f.root, "mock.sqlite"),
    undefined,
    Date.now,
    f.sources,
  );
  const code = "TEST_ONLY_RECORDS_BROWSER_PAIRING_12345",
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
      page.getByLabel("기록 전용 실행", { exact: true }),
    ).toHaveValue(f.runId);
    const inspect = () =>
      page.getByRole("button", {
        name: "선택 기록 읽기 전용으로 가져오기",
        exact: true,
      });
    await inspect().click();
    await expect(page.getByTestId("record-source-info")).toContainText(
      f.source.exportHash,
    );
    const create = () =>
      page.getByRole("button", {
        name: "이 기록·기간으로 분석 요청 만들기",
        exact: true,
      });
    const end = page.getByLabel("분석 종료 (UTC)", { exact: true });
    await end.fill("bad");
    await expect(create()).toBeDisabled();
    const firstFill = new Date(f.source.journal.fills[0]!.at).toISOString();
    await end.fill(firstFill);
    await create().click();
    await expect(page.getByTestId("analysis-status")).toHaveText(
      "자료 확인 · 승인 대기",
    );
    await expect(page.getByTestId("record-net-KRW").first()).toContainText(
      "미확정",
    );
    await expect(inspect()).toBeDisabled();
    await page
      .getByRole("button", { name: "이 분석 취소", exact: true })
      .click();
    await expect(page.getByTestId("analysis-status")).toHaveText("취소됨");
    await end.fill(f.period.to);
    await create().click();
    await expect(page.getByTestId("analysis-status")).toHaveText(
      "자료 확인 · 승인 대기",
    );
    const consent = () =>
      page.getByRole("button", {
        name: "이 자료의 모형 전달 승인",
        exact: true,
      });
    await expect(consent()).toBeDisabled();
    await page
      .getByText("전달 예정 자료 전체 보기 (JSON)", { exact: true })
      .click();
    await expect(page.getByTestId("analysis-payload")).toContainText(
      "ENGINE_RECORD_ANALYSIS_BUNDLE_V1",
    );
    await expect(page.getByTestId("analysis-payload")).toContainText(
      f.source.exportHash,
    );
    await expect(page.getByTestId("analysis-payload")).not.toContainText(
      f.source.journal.decisions[0]!.id,
    );
    await page
      .getByLabel("전체 자료를 열어 확인했고", { exact: false })
      .check();
    await page
      .getByLabel("실제 Codex 분석·외부 전송", { exact: false })
      .check();
    await page.getByText("판단별 최소 자료 4건 보기", { exact: true }).click();
    await page.screenshot({
      path: "test-results/analysis-records-consent-desktop.png",
      fullPage: true,
    });
    await consent().click();
    expect(analysis.view().mockCalls).toBe(0);
    await page
      .getByRole("button", { name: "승인된 모형 1회 실행", exact: true })
      .click();
    await expect(page.getByTestId("analysis-status")).toHaveText(
      "모형 결과 검증 통과",
    );
    const result = analysis.view().jobs[0]!.result;
    expect(result?.version).toBe("LOCAL_MOCK_RECORD_RESULT_V1");
    await page.reload();
    await menu().click();
    await expect(page.getByTestId("analysis-status")).toHaveText(
      "모형 결과 검증 통과",
    );
    expect(analysis.view().jobs[0]!.result).toEqual(result);
    await page.screenshot({
      path: "test-results/analysis-records-result-desktop.png",
      fullPage: true,
    });
    for (const width of [390, 720]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/analysis-records-result-${width}.png`,
        fullPage: true,
      });
    }
    expect(analysis.view().mockCalls).toBe(1);
    expect(analysis.view().externalCalls).toBe(0);
    expect(readFileSync(f.path)).toEqual(before);
    expect(portfolio.view().runs).toEqual([]);
    expect(engine.state().orders).toEqual([]);
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await analysis.close();
    await portfolio.close();
    engine.close();
  }
});
