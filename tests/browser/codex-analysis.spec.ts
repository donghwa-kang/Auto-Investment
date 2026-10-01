import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../../src/server/engine.js";
import { PortfolioWebService } from "../../src/server/portfolio-web-service.js";
import { CodexAnalysisService } from "../../src/server/codex-analysis-service.js";
import { createApp } from "../../src/server/http.js";

test("CODEX-MOCK-UI 자료 전체 확인·분리 승인·응답 유실·1회 실행·새로고침·취소·반응형", async ({
  page,
}) => {
  const root = mkdtempSync(resolve(tmpdir(), "codex-analysis-browser-"));
  const engine = new Engine(":memory:"),
    portfolio = new PortfolioWebService(resolve(root, "runs")),
    analysis = new CodexAnalysisService(resolve(root, "mock.sqlite"));
  const code = "TEST_ONLY_CODEX_ANALYSIS_BROWSER_12345",
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
      page.getByText(/실제 Codex는 연결하지 않았습니다/),
    ).toBeVisible();
    const create = () =>
      page.getByRole("button", {
        name: "합성 자료로 분석 요청 만들기",
        exact: true,
      });
    await create().click();
    await expect(page.getByTestId("analysis-status")).toHaveText(
      "자료 확인 · 승인 대기",
    );
    expect(analysis.view().mockCalls).toBe(0);
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
      "SYNTHETIC_REVIEW_FIXTURE_V1",
    );
    await page
      .getByLabel("전체 자료를 열어 확인했고", { exact: false })
      .check();
    await page
      .getByLabel("실제 Codex 분석·외부 전송", { exact: false })
      .check();
    await expect(page.locator(".ca-consent label").first()).toHaveCSS(
      "flex-direction",
      "row",
    );
    await expect(page.locator(".ca-consent input").first()).toHaveCSS(
      "min-height",
      "18px",
    );
    await page.screenshot({
      path: "test-results/codex-analysis-consent-desktop.png",
      fullPage: true,
    });
    await consent().click();
    await expect(page.getByTestId("analysis-status")).toHaveText(
      "승인 완료 · 실행 대기",
    );
    expect(analysis.view().mockCalls).toBe(0);
    let lost = false;
    const runIds: string[] = [];
    await page.route("**/api/codex-analysis", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as {
          type: string;
          id: string;
        };
        if (body.type === "run") {
          runIds.push(body.id);
          if (!lost) {
            lost = true;
            await route.fetch();
            await route.abort();
            return;
          }
        }
      }
      await route.continue();
    });
    await page
      .getByRole("button", { name: "승인된 모형 1회 실행", exact: true })
      .click();
    await page
      .getByRole("button", { name: "분석 동일 요청 재확인", exact: true })
      .click();
    await expect(page.getByTestId("analysis-status")).toHaveText(
      "모형 결과 검증 통과",
    );
    expect(runIds.length).toBe(2);
    expect(new Set(runIds).size).toBe(1);
    expect(analysis.view().mockCalls).toBe(1);
    await page.unroute("**/api/codex-analysis");
    await page.reload();
    await menu().click();
    await expect(page.getByTestId("analysis-status")).toHaveText(
      "모형 결과 검증 통과",
    );
    await expect(
      page.getByText("검증된 모형 제안 · 자동 적용 없음", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/codex-analysis-result-desktop.png",
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
        path: `test-results/codex-analysis-result-${width}.png`,
        fullPage: true,
      });
    }
    await create().click();
    await expect(page.getByTestId("analysis-status")).toHaveText(
      "자료 확인 · 승인 대기",
    );
    await expect(consent()).toBeDisabled();
    await page
      .getByRole("button", { name: "이 분석 취소", exact: true })
      .click();
    await expect(page.getByTestId("analysis-status")).toHaveText("취소됨");
    expect(analysis.view().mockCalls).toBe(1);
    await page.route("**/api/codex-analysis", (route) => route.abort());
    await expect(page.getByText(/분석 상태를 확인할 수 없어/)).toBeVisible();
    await expect(create()).toBeDisabled();
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
