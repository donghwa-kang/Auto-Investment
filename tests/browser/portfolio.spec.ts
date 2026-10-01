import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Engine } from "../../src/server/engine.js";
import { PortfolioWebService } from "../../src/server/portfolio-web-service.js";
import { createApp } from "../../src/server/http.js";
import { webDirectory } from "../portfolio-web-helpers.js";
const code = "TEST_ONLY_PORTFOLIO_BROWSER_123456789";

test("PORTFOLIO-UI-01 실제 합성 자료 생성·응답 유실 재확인·중복 클릭·새로고침·청산·반응형", async ({
  page,
}) => {
  test.setTimeout(240000);
  const service = new PortfolioWebService(
      mkdtempSync(resolve(tmpdir(), "portfolio-browser-")),
    ),
    engine = new Engine(":memory:"),
    app = createApp(engine, code, { portfolio: service });
  const url = await app.listen(0),
    outside: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(url)) outside.push(r.url());
  });
  try {
    await page.goto(url + "/?view=portfolio");
    await expect(
      page.getByText("실거래 연결 없음", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/portfolio-login.png",
      fullPage: true,
    });
    await page.getByLabel("연결 코드", { exact: true }).fill(code);
    await page.getByRole("button", { name: "연결", exact: true }).click();
    await page
      .getByRole("button", { name: "새 모의 실험", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "가상 자금 배정 · 실험 생성" }),
    ).toBeDisabled();
    await page
      .getByLabel("합성 예측값으로 모의 주문 경로 시험", { exact: false })
      .check();
    await page
      .getByLabel("시험용 가격·비용·체결·처리 순서", { exact: false })
      .check();
    await page
      .getByLabel("총 가상 운용금 (원)", { exact: false })
      .fill("5000001");
    expect(
      await page
        .getByLabel("총 가상 운용금 (원)", { exact: false })
        .evaluate((el: HTMLInputElement) => el.validity.valid),
    ).toBe(false);
    await page
      .getByLabel("총 가상 운용금 (원)", { exact: false })
      .fill("5000000");
    const createdIds: string[] = [];
    let lost = false;
    await page.route("**/api/portfolio", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as {
          type: string;
          id: string;
        };
        if (body.type === "create") {
          createdIds.push(body.id);
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
    await page
      .getByRole("button", { name: "가상 자금 배정 · 실험 생성" })
      .click();
    await page.getByRole("button", { name: "같은 요청 재확인" }).click();
    await expect(page.getByTestId("portfolio-equity")).toHaveText(
      "5,000,000원",
      { timeout: 100000 },
    );
    expect(createdIds.length).toBe(2);
    expect(new Set(createdIds).size).toBe(1);
    expect(service.list().runs.length).toBe(1);
    expect(service.view().view!.playing).toBe(false);
    await page.unroute("**/api/portfolio");
    await page.route("**/api/portfolio", (route) =>
      route.request().method() === "GET" ? route.abort() : route.continue(),
    );
    await expect(page.getByText(/연결 지연·끊김/)).toBeVisible({
      timeout: 6000,
    });
    await expect(
      page.getByRole("button", { name: "모의 거래 시작", exact: true }),
    ).toBeDisabled();
    await page.unroute("**/api/portfolio");
    await expect(page.getByText(/연결 지연·끊김/)).not.toBeVisible({
      timeout: 6000,
    });
    await page
      .getByRole("button", { name: "모의 거래 시작", exact: true })
      .dblclick();
    await expect
      .poll(() => service.view().view!.exposureCount)
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "재생 정지", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page
      .getByRole("button", { name: "저장된 위치에서 재생 정지" })
      .click();
    await expect(page.getByTestId("portfolio-status")).toHaveText("재생 정지");
    const frozen = service.view().view!;
    await page.reload();
    await expect(page.getByTestId("portfolio-status")).toHaveText("재생 정지");
    expect(service.view().view!.step).toBe(frozen.step);
    expect(service.view().view!.equity).toBe(frozen.equity);
    await page.screenshot({
      path: "test-results/portfolio-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "판단 근거", exact: true }).click();
    await expect(page.locator(".p-detail")).not.toHaveCount(0);
    await page.locator(".p-detail summary").first().click();
    await expect(page.locator(".p-detail-body").first()).toBeVisible();
    await page.getByRole("button", { name: "주문·보유", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "모의 주문 내역" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "프로그램 보유분 청산", exact: true })
      .click();
    await page.getByRole("button", { name: "가상 보유분 청산 요청" }).click();
    await expect(page.getByTestId("portfolio-status")).toHaveText("재생 종료", {
      timeout: 70000,
    });
    expect(service.view().view!.exposureCount).toBe(0);
    expect(service.view().view!.pendingCount).toBe(0);
    expect(
      service.view().view!.orders.filter((o) => o.side === "BUY").length,
    ).toBe(1);
    await page.getByRole("button", { name: "모의 투자", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/portfolio-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "실행 기록", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "저장된 모의 실험" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 720, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await service.close();
    engine.close();
  }
});

test("PORTFOLIO-UI-02 서버 재시작·기존 기록 열기·대조 전 시작 차단", async ({
  page,
}) => {
  test.setTimeout(120000);
  const { root, id } = webDirectory();
  let service = new PortfolioWebService(root),
    engine = new Engine(":memory:"),
    app = createApp(engine, code, { portfolio: service });
  let url = await app.listen(0);
  try {
    await service.request({ type: "open", runId: id });
    await expect
      .poll(() => service.view().phase, { timeout: 60000 })
      .toBe("READY");
    const before = service.view().view!;
    await app.close();
    await service.close();
    engine.close();
    service = new PortfolioWebService(root);
    engine = new Engine(":memory:");
    app = createApp(engine, code, { portfolio: service });
    url = await app.listen(0);
    await page.goto(url + "/?view=portfolio");
    await page.getByLabel("연결 코드", { exact: true }).fill(code);
    await page.getByRole("button", { name: "연결", exact: true }).click();
    await page.getByRole("button", { name: "저장된 실행 보기" }).click();
    await page.getByRole("button", { name: "기록 열기·복구 검사" }).click();
    await expect(page.getByTestId("portfolio-status")).toHaveText(
      "복구 대조 필요",
      { timeout: 60000 },
    );
    await expect(
      page.getByRole("button", { name: "모의 거래 시작", exact: true }),
    ).toBeDisabled();
    expect(service.view().view!.equity).toBe(before.equity);
    expect(service.view().view!.step).toBe(before.step);
    await page.getByRole("button", { name: "장부 대조", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "모의 거래 시작", exact: true }),
    ).toBeEnabled();
    expect(service.view().view!.playing).toBe(false);
  } finally {
    await app.close();
    await service.close();
    engine.close();
  }
});
