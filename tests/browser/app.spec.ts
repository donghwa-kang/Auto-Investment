import { test, expect } from "@playwright/test";
import { Engine } from "../../src/server/engine.js";
import { createApp } from "../../src/server/http.js";
// 런타임 자체는 빌드된 JS를 사용하도록 테스트 런너에서 모듈 경로를 고정한다.
const pairing = "BROWSER_TEST_ONLY_LOCAL_PAIRING_123";
test("UI-01 입력·사전 점검·주문·중지·귀속 청산·다섯 화면·모바일", async ({
  page,
}) => {
  const engine = new Engine(":memory:");
  const app = createApp(engine, pairing);
  const url = await app.listen(0);
  const outside: string[] = [],
    errors: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(url)) outside.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(url);
    await expect(page.getByText("실거래 잠금", { exact: true })).toBeVisible();
    await page.getByLabel("연결 코드").fill(pairing);
    await page.getByRole("button", { name: "연결", exact: true }).click();
    await page.getByLabel("총 운용금 (KRW)", { exact: true }).fill("5000000");
    await page.getByLabel("예측 제공기").selectOption("TEST_ONLY");
    await page
      .getByRole("button", { name: "사전 점검 · 모의 자금 배정" })
      .click();
    await expect(
      page.getByText("회당 계획 위험 상한", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("1,250원", { exact: true }).first(),
    ).toBeVisible({ timeout: 30000 });
    await page
      .getByRole("button", { name: "모의 거래 시작", exact: true })
      .click();
    await expect(page.getByTestId("engine-status")).toHaveText("RUNNING");
    await page.getByRole("button", { name: "가상 시계 +10초" }).click();
    await page.getByRole("button", { name: "04 주문·보유" }).click();
    await expect(page.getByText("WATCHING", { exact: false })).toBeVisible();
    await page.screenshot({
      path: "test-results/desktop-orders.png",
      fullPage: true,
    });
    page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", { name: "프로그램 매매분 청산", exact: true })
      .click();
    await page.getByRole("button", { name: "01 운용 현황" }).click();
    await page.getByRole("button", { name: "가상 시계 +10초" }).click();
    await page.getByRole("button", { name: "04 주문·보유" }).click();
    await expect(
      page.getByText("CLOSED_RECONCILED", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "02 판단 근거" }).click();
    await expect(page.getByText("APPROVED", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "03 테마 조사" }).click();
    await expect(
      page.getByRole("heading", { name: "SOXL", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("검증 후보 포함 · 실제 시세 모의매매 미연결").last(),
    ).toBeVisible();
    await expect(
      page.getByText(/단일종목 레버리지 금지 대상과 구분/),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/research-scope.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "05 검증·설정" }).click();
    await expect(page.getByText("UNVALIDATED", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "01 운용 현황" }).click();
    await page.screenshot({
      path: "test-results/mobile-dashboard.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId("engine-status")).toHaveText("ENTRY_PAUSED");
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    engine.close();
  }
});
test("UI-02 기본 예측 누락 보류·잘못된 자금·연결 끊김 표시", async ({
  page,
}) => {
  const engine = new Engine(":memory:"),
    app = createApp(engine, pairing);
  const url = await app.listen(0);
  try {
    await page.goto(url);
    await page.getByLabel("연결 코드").fill(pairing);
    await page.getByRole("button", { name: "연결", exact: true }).click();
    await page.getByLabel("총 운용금 (KRW)", { exact: true }).fill("0");
    await page
      .getByRole("button", { name: "사전 점검 · 모의 자금 배정" })
      .click();
    expect(
      await page
        .getByLabel("총 운용금 (KRW)", { exact: true })
        .evaluate((el: HTMLInputElement) => el.validity.valid),
    ).toBe(false);
    await page.getByLabel("총 운용금 (KRW)", { exact: true }).fill("5000000");
    await page
      .getByRole("button", { name: "사전 점검 · 모의 자금 배정" })
      .click();
    await expect(
      page.getByText("1,250원", { exact: true }).first(),
    ).toBeVisible({ timeout: 30000 });
    await page
      .getByRole("button", { name: "모의 거래 시작", exact: true })
      .click();
    await page.getByRole("button", { name: "02 판단 근거" }).click();
    await expect(
      page.getByText("MISSING_FORECAST_PROFILE", { exact: true }),
    ).toBeVisible();
    await page.route("**/api/state", (route) => route.abort());
    await expect(page.getByText(/연결 지연\/끊김/)).toBeVisible({
      timeout: 6000,
    });
  } finally {
    await app.close();
    engine.close();
  }
});
