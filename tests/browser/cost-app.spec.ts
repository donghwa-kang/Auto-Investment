import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { CostWebService } from "../../src/server/cost-web-service.js";
import { PortfolioWebService } from "../../src/server/portfolio-web-service.js";
import { Engine } from "../../src/server/engine.js";
import { createApp } from "../../src/server/http.js";
import { costAppRecipe } from "../../src/server/cost-app-fixture.js";
import { Worker } from "node:worker_threads";

test("CA-03/08/09/10/11 real HTTP workers, V4 UI final2330, download identity and verifier isolation", async ({
  page,
}) => {
  test.setTimeout(300000);
  const root = mkdtempSync(resolve(tmpdir(), "cost-app-browser-"));
  const cost = new CostWebService(resolve(root, "cost")),
    portfolio = new PortfolioWebService(resolve(root, "portfolio"));
  const engine = new Engine(":memory:"),
    app = createApp(engine, "COST_APP_TEST_ONLY_LOGIN", { cost, portfolio });
  const url = await app.listen(0);
  const errors: string[] = [],
    outside: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(url)) outside.push(r.url());
  });
  try {
    expect(
      (await page.request.get(url + "/api/cost-lab/download")).status(),
    ).toBe(401);
    await page.goto(url + "/?view=portfolio&lab=cost");
    await page
      .getByLabel("연결 코드", { exact: true })
      .fill("COST_APP_TEST_ONLY_LOGIN");
    await page.getByRole("button", { name: "연결", exact: true }).click();
    await page.getByLabel("비용 시험 경로").selectOption(costAppRecipe);
    await page
      .getByLabel(
        "고정 합성 가격·비용으로 새 전용 실행을 만드는 것에 동의합니다.",
      )
      .check();
    // Lose a real create reply after it was accepted; retry across browser reload.
    let lost = false;
    const ids: string[] = [];
    await page.route("**/api/cost-lab", async (route) => {
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON() as {
          type: string;
          id: string;
          recipe: string;
        };
        if (input.type === "create") {
          expect(input.recipe).toBe(costAppRecipe);
          ids.push(input.id);
          if (!lost) {
            lost = true;
            expect((await route.fetch()).status()).toBe(200);
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
    await expect(page.getByTestId("cost-phase")).toHaveText("IDLE", {
      timeout: 120000,
    });
    expect(new Set(ids).size).toBe(1);
    expect(ids.length).toBe(2);
    await expect(page.getByLabel("비용 시험 경로")).toHaveValue(costAppRecipe);
    await page.unroute("**/api/cost-lab");
    await expect(page.getByTestId("cost-app-net")).toHaveText("미확정");
    await page
      .getByRole("button", { name: "비용 시험 시작", exact: true })
      .click();
    await expect(page.getByTestId("cost-app-finalization")).toHaveText(
      "FINALIZED",
      { timeout: 150000 },
    );
    await expect(page.getByTestId("cost-app-net")).toHaveText("2,330원");
    await expect(page.getByTestId("cost-phase")).toHaveText("STOPPED");
    await page.getByRole("button", { name: "고정 입력 검증 요청" }).focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => cost.view().verification?.phase, {
        timeout: 30000,
        intervals: [25, 50, 100],
      })
      .toBe("RUNNING");
    const running = cost.view();
    const stopStarted = Date.now();
    await cost.request({
      type: "control",
      runId: running.activeId!,
      id: crypto.randomUUID(),
      expectedControl: running.view!.controlRevision,
      action: "STOP",
    });
    const stopDurationMs = Date.now() - stopStarted;
    expect(stopDurationMs).toBeLessThan(20000);
    // The full verifier is still busy when the independent financial STOP
    // acknowledges. No lease timeout was enlarged for this assertion.
    expect(cost.view().verification?.phase).toBe("RUNNING");
    await expect(page.getByTestId("cost-app-verification")).toHaveText(
      "SYNTHETIC_INPUT_ELIGIBLE",
      { timeout: 120000 },
    );
    const state = cost.view(),
      v = state.view!;
    if (!("recipe" in v)) throw Error("EXPECTED_V4");
    expect(v.report.status).toBe("HOLD");
    expect(state.canCreate).toBe(false);
    expect(state.verification!.inputBytes!).toBeGreaterThan(1000);
    expect(state.verification!.durationMs!).toBeLessThan(180000);
    const pin = v.capture!,
      runId = state.activeId!;
    const artifact = (name: string) =>
      url +
      `/api/cost-lab/download?${new URLSearchParams({ runId, snapshotId: pin.snapshotId, artifact: name })}`;
    const finance = await page.request.get(artifact("financial"));
    expect(finance.status()).toBe(200);
    const exact = await finance.text();
    expect(await (await page.request.get(artifact("financial"))).text()).toBe(
      exact,
    );
    expect(exact).toBe(
      readFileSync(resolve(root, "cost", runId, "financial.json"), "utf8"),
    );
    expect(JSON.parse(exact).report.financialBasisHash).toBe(
      v.report.financialBasisHash,
    );
    const result = await (await page.request.get(artifact("result"))).json();
    expect(result.trainingLabel.finalNetPnlKrw).toBe(
      String(4n * (22000n - 21400n) - 20n - 50n),
    );
    expect(result.inputHash).toBe(pin.inputHash);
    expect(result.orderSubmissionAllowed).toBe(false);
    const invalid = await page.request.get(artifact("../cost.sqlite"));
    expect(invalid.status()).toBe(409);
    const { csrf } = (await (
      await page.request.get(url + "/api/session")
    ).json()) as { csrf: string };
    const oversized = await page.request.post(url + "/api/cost-lab", {
      headers: { Origin: url, "x-csrf-token": csrf },
      data: { padding: "x".repeat(9000) },
    });
    expect(oversized.status()).toBe(409);
    expect(
      (
        await page.request.post(url + "/api/cost-lab", {
          headers: { Origin: url },
          data: { type: "verify", runId, snapshotId: pin.snapshotId },
        })
      ).status(),
    ).toBe(403);
    const same = await cost.request({
      type: "verify",
      runId,
      snapshotId: pin.snapshotId,
    });
    expect(same.verification).toEqual(state.verification);
    await page.screenshot({
      path: "test-results/cost-app-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/cost-app-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
    console.log(
      JSON.stringify({
        verificationMs: state.verification!.durationMs,
        stopDuringVerificationMs: stopDurationMs,
        inputBytes: state.verification!.inputBytes,
        reportHash: v.report.reportHash,
      }),
    );
    // Reopen is inspection-only and does not automatically launch validation.
    await cost.close();
    const reopened = new CostWebService(resolve(root, "cost"));
    try {
      await reopened.request({ type: "open", runId });
      await expect
        .poll(() => reopened.view().phase, { timeout: 120000 })
        .toBe("READY");
      expect(reopened.view().view!.report).toEqual(v.report);
      expect(reopened.view().verification).toBeNull();
      await reopened.request({
        type: "verify",
        runId,
        snapshotId: pin.snapshotId,
      });
      await expect
        .poll(() => reopened.view().verification?.phase, {
          timeout: 30000,
          intervals: [25, 50, 100],
        })
        .toBe("RUNNING");
      // Adversarial test only: terminate the actual verifier, not money worker.
      const verifier: unknown = Reflect.get(reopened, "verifyWorker");
      expect(verifier).toBeInstanceOf(Worker);
      if (!(verifier instanceof Worker)) throw Error("VERIFIER_MISSING");
      await verifier.terminate();
      await expect
        .poll(() => reopened.view().verification?.phase)
        .toBe("FAILED");
      expect(reopened.view().phase).toBe("READY");
      await new Promise((r) => setTimeout(r, 1200));
      expect(reopened.view().workerStale).toBe(false);
      expect(reopened.view().view!.report).toEqual(v.report);
    } finally {
      await reopened.close();
    }
  } finally {
    await cost.close();
    await portfolio.close();
    await app.close();
    engine.close();
  }
});
