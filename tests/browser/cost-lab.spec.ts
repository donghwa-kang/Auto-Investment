import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { CostWebService } from "../../src/server/cost-web-service.js";
import { PortfolioWebService } from "../../src/server/portfolio-web-service.js";
import { Engine } from "../../src/server/engine.js";
import { createApp } from "../../src/server/http.js";

test("COST-UI-01 durable lost-response retry, reload, start/stop, stale/HOLD and mobile", async ({
  page,
}) => {
  test.setTimeout(180000);
  const root = mkdtempSync(resolve(tmpdir(), "cost-lab-browser-"));
  const cost = new CostWebService(resolve(root, "cost")),
    portfolio = new PortfolioWebService(resolve(root, "portfolio"));
  const engine = new Engine(":memory:"),
    code = "COST_LAB_BROWSER_TEST_ONLY";
  const app = createApp(engine, code, { cost, portfolio });
  const url = await app.listen(0),
    outside: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(url)) outside.push(r.url());
  });
  try {
    await page.goto(url + "/?view=portfolio&lab=cost");
    await page.getByLabel("연결 코드", { exact: true }).fill(code);
    await page.getByRole("button", { name: "연결", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "체결부터 장부까지, 하나의 근거" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "새 비용 시험 생성" }),
    ).toBeDisabled();
    await page
      .getByLabel(
        "고정 합성 가격·비용으로 새 전용 실행을 만드는 것에 동의합니다.",
      )
      .check();
    const ids: string[] = [];
    let lost = false;
    await page.route("**/api/cost-lab", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as {
          type: string;
          id: string;
        };
        if (body.type === "create") {
          ids.push(body.id);
          if (!lost) {
            lost = true;
            const response = await route.fetch();
            expect(response.status()).toBe(200);
            await route.abort();
            return;
          }
        }
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "새 비용 시험 생성" }).click();
    await expect(
      page.getByRole("button", { name: "저장된 같은 요청 재확인" }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "저장된 같은 요청 재확인" }).click();
    expect(new Set(ids).size).toBe(1);
    expect(ids.length).toBe(2);
    await expect(page.getByTestId("cost-phase")).toHaveText("IDLE", {
      timeout: 100000,
    });
    expect(cost.list().runs.length).toBe(1);
    expect(portfolio.list().runs.length).toBe(0);
    await page.unroute("**/api/cost-lab");
    await page
      .getByRole("button", { name: "비용 시험 시작", exact: true })
      .dblclick();
    await expect
      .poll(
        () => cost.view().view?.report.financialEvidence.trades[0]?.quantity,
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "실행 중지", exact: true }).click();
    await expect(
      page.getByText("청산 버튼이 아닙니다.", { exact: false }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "청산 없이 실행 중지 확인" })
      .click();
    await expect(page.getByTestId("cost-phase")).toHaveText("STOPPED");
    const stopped = cost.view().view!;
    await page.reload();
    await expect(page.getByTestId("cost-phase")).toHaveText("STOPPED");
    expect(cost.view().view!.report.reportHash).toBe(stopped.report.reportHash);
    await page.route("**/api/cost-lab", (route) =>
      route.request().method() === "GET" ? route.abort() : route.continue(),
    );
    await expect(page.getByText(/비용 시험 연결 확인 필요/)).toBeVisible({
      timeout: 7000,
    });
    await expect(
      page.getByRole("button", { name: "같은 실행 재개" }),
    ).toBeDisabled();
    await page.unroute("**/api/cost-lab");
    await expect(
      page.getByRole("button", { name: "같은 실행 재개" }),
    ).toBeEnabled({ timeout: 7000 });
    await page.getByRole("button", { name: "같은 실행 재개" }).click();
    await expect(page.getByTestId("cost-holds")).toContainText(
      "WATCHDOG_INPUT_STALE",
      { timeout: 10000 },
    );
    await page.getByRole("button", { name: "합성 입력 끊기" }).click();
    await expect(
      page.getByRole("button", { name: "합성 입력 다시 공급" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "합성 입력 다시 공급" }).click();
    await expect(page.getByTestId("cost-holds")).toContainText(
      "WATCHDOG_INPUT_STALE",
    );
    await page.getByRole("button", { name: "실행 중지", exact: true }).click();
    await page
      .getByRole("button", { name: "청산 없이 실행 중지 확인" })
      .click();
    await expect(page.getByTestId("cost-phase")).toHaveText("STOPPED");
    await page
      .getByText("동일 비용 근거와 학습 보류 사유", { exact: true })
      .click();
    await expect(page.getByText(/학습 상태: HOLD/)).toBeVisible();
    const report = cost.view().view!.report;
    if (!("learningEvidence" in report))
      throw Error("EXPECTED_LEGACY_V3_REPORT");
    expect(report.financialBasisHash).toBe(
      report.learningEvidence.financialBasisHash,
    );
    await expect(page.getByTestId("cost-fees")).toContainText(
      report.financialEvidence.accounts[0]!.tradingFees,
    );
    await page.screenshot({
      path: "test-results/cost-lab-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/cost-lab-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
    // Presentation-only quota boundary; the actual 100 persisted controls are
    // exercised by CW-08. Do not send this mocked view back to the real worker.
    const quotaView = structuredClone(cost.view());
    quotaView.view!.controlRevision = 99;
    quotaView.view!.runtime.phase = "RUNNING";
    await page.route("**/api/cost-lab", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: quotaView })
        : route.continue(),
    );
    await expect(page.getByText(/제어 요청 한도에 도달/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "비용 시험 시작", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "합성 입력 끊기" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "실행 중지", exact: true }),
    ).toBeEnabled();
  } finally {
    await cost.close();
    await portfolio.close();
    await app.close();
    engine.close();
  }
});
