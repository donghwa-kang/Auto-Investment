import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  webSetupSchema,
  webRequestSchema,
} from "../src/core/portfolio-web-schema.js";
import { PortfolioWebRun } from "../src/server/portfolio-web-run.js";
import { PortfolioWebService } from "../src/server/portfolio-web-service.js";
import { Engine } from "../src/server/engine.js";
import { createApp } from "../src/server/http.js";
import { webSetup, webDirectory } from "./portfolio-web-helpers.js";
const id = () => randomUUID();

test("WEB-01 자금/통화 한도·동의·임의 경로/시세 주입 거절", () => {
  assert.ok(webSetupSchema.safeParse(webSetup).success);
  for (const v of [
    { capital: 0 },
    { capital: 5000001 },
    { capital: 1.1 },
    { usdCapitalKrw: 2000001 },
    { acknowledgeSynthetic: false },
    { level: "LIVE" },
  ])
    assert.equal(
      webSetupSchema.safeParse({ ...webSetup, ...v }).success,
      false,
    );
  assert.equal(
    webRequestSchema.safeParse({ type: "open", runId: "../paper.sqlite" })
      .success,
    false,
  );
  assert.equal(
    webRequestSchema.safeParse({
      type: "control",
      id: id(),
      runId: id(),
      action: { type: "tick", at: 0 },
    }).success,
    false,
  );
});
test("WEB-02 준비 후 미시작·자금 보존·중복/충돌 명령·체크포인트 원자성", () => {
  const { directory } = webDirectory(),
    r = new PortfolioWebRun(directory);
  try {
    assert.equal(r.view().playing, false);
    assert.equal(r.view().equity, "5000000");
    assert.equal(r.view().step, 0);
    const commandId = id();
    r.control(commandId, { type: "start" });
    r.step();
    const before = r.view();
    r.control(commandId, { type: "start" });
    assert.deepEqual(r.view(), before);
    assert.throws(
      () => r.control(commandId, { type: "pause" }),
      /COMMAND_ID_CONFLICT/,
    );
    r.engine.repo.failure = "WRITE_FAILURE";
    assert.throws(() => r.step(), /WRITE_FAILURE/);
    assert.deepEqual(r.view(), before);
    r.engine.repo.failure = null;
    r.step();
    assert.equal(r.view().step, 2);
    assert.ok(r.engine.repo.verifyAudit() > 0);
  } finally {
    r.engine.repo.failure = null;
    r.close();
  }
});
test("WEB-03 신규 중지가 예정 재개에 의해 무시되지 않음·전체 재생 종료", () => {
  const { directory } = webDirectory(),
    r = new PortfolioWebRun(directory);
  try {
    r.control(id(), { type: "start" });
    r.step();
    r.step();
    r.step();
    r.control(id(), { type: "pause" });
    assert.equal(r.view().playing, true);
    for (let i = 0; i < 100 && r.playing; i++) r.step();
    const v = r.view();
    assert.ok(v.finished);
    assert.equal(v.entryEnabled, false);
    assert.equal(v.orders.filter((o) => o.side === "BUY").length, 1);
    assert.equal(v.exposureCount, 0);
    assert.equal(v.pendingCount, 0);
    assert.throws(
      () => r.control(id(), { type: "start" }),
      /WEB_REPLAY_FINISHED/,
    );
  } finally {
    r.close();
  }
});
test("WEB-04 멈춤은 청산 아님·청산 요청 후 호가 재생과 잔여 대조", () => {
  const { directory } = webDirectory(),
    r = new PortfolioWebRun(directory);
  try {
    r.control(id(), { type: "start" });
    for (let i = 0; i < 5; i++) r.step();
    r.control(id(), { type: "freeze" });
    const held = r.view();
    assert.ok(held.exposureCount > 0);
    assert.equal(held.playing, false);
    r.step();
    assert.deepEqual(r.view(), held);
    r.control(id(), { type: "liquidate", confirm: true });
    assert.ok(r.view().exposureCount > 0);
    for (let i = 0; i < 100 && r.playing; i++) r.step();
    assert.equal(r.view().exposureCount, 0);
    assert.equal(r.view().pendingCount, 0);
  } finally {
    r.close();
  }
});
test("WEB-05 재시작은 대조+명시적 재개·이전 요청 재전송이 자동 재개하지 않음", () => {
  const { directory } = webDirectory();
  let r = new PortfolioWebRun(directory);
  const request = id();
  r.control(request, { type: "start" });
  r.step();
  r.step();
  const before = r.view();
  r.close();
  r = new PortfolioWebRun(directory);
  try {
    const restored = r.view();
    assert.equal(restored.step, before.step);
    assert.equal(restored.equity, before.equity);
    assert.ok(restored.recoveryRequired);
    assert.equal(restored.playing, false);
    r.control(request, { type: "start" });
    assert.equal(r.view().playing, false);
    assert.throws(
      () => r.control(id(), { type: "start" }),
      /WEB_RECONCILIATION_REQUIRED/,
    );
    r.control(id(), { type: "protect" });
    for (let i = 0; i < 3; i++) r.step();
    r.control(id(), { type: "freeze" });
    assert.throws(
      () => r.control(id(), { type: "start" }),
      /WEB_RECONCILIATION_REQUIRED/,
    );
    r.control(id(), { type: "reconcile" });
    assert.equal(r.view().playing, false);
    assert.equal(r.view().recoveryRequired, false);
    assert.equal(r.view().orders.filter((o) => o.side === "BUY").length, 1);
  } finally {
    r.close();
  }
});
test("WEB-06 기본 예측 누락은 모의 주문 보류·USD 배정은 별도 가상 장부", () => {
  const { directory } = webDirectory({
      ...webSetup,
      forecast: "MISSING_PROFILE",
      usdCapitalKrw: 1000000,
    }),
    r = new PortfolioWebRun(directory);
  try {
    assert.equal(r.view().wallets.KRW.cash, "4000000");
    assert.ok(Number(r.view().wallets.USD.cash) > 0);
    r.control(id(), { type: "start" });
    for (let i = 0; i < 100 && r.playing; i++) r.step();
    assert.equal(r.view().orders.length, 0);
    assert.ok(r.view().decisions.every((d) => d.result === "ABSTAIN"));
    assert.equal(r.view().equity, "5000000");
  } finally {
    r.close();
  }
});
test("WEB-07 재생 명령 변조는 DB 부팅 변경 전에 거절", () => {
  const { directory } = webDirectory(),
    r = new PortfolioWebRun(directory);
  r.close();
  const path = resolve(directory, "plan.json"),
    plan = JSON.parse(readFileSync(path, "utf8")) as { commands: unknown[] };
  plan.commands.push({ type: "pause" });
  writeFileSync(path, JSON.stringify(plan));
  const pathDb = resolve(directory, "paper.sqlite"),
    db = new DatabaseSync(pathDb, { readOnly: true });
  const before = db.prepare("SELECT body FROM aggregate").get();
  db.close();
  assert.throws(() => new PortfolioWebRun(directory), /WEB_RECIPE_BINDING/);
  const after = new DatabaseSync(pathDb, { readOnly: true });
  assert.deepEqual(after.prepare("SELECT body FROM aggregate").get(), before);
  after.close();
});
test("WEB-08 HTTP 인증/쿠키 격리·CSRF·외부 Origin·자료 검증 중 응답·중복 생성", async () => {
  const { root, id: runId } = webDirectory();
  const service = new PortfolioWebService(root, 200),
    engine = new Engine(":memory:"),
    app = createApp(engine, "TEST_WEB_PAIRING_ONLY_123456789", {
      portfolio: service,
    });
  const url = await app.listen(0);
  try {
    assert.equal((await fetch(url + "/api/portfolio")).status, 401);
    const login = await fetch(url + "/api/login", {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "TEST_WEB_PAIRING_ONLY_123456789" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    assert.ok(cookie.startsWith("portfolio_session="));
    const { csrf } = (await login.json()) as { csrf: string };
    const post = (body: unknown, token = csrf, origin = url) =>
      fetch(url + "/api/portfolio", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
          "x-csrf-token": token,
        },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ type: "open", runId }, "bad")).status, 403);
    assert.equal(
      (await post({ type: "open", runId }, csrf, "https://evil.invalid"))
        .status,
      403,
    );
    assert.equal(
      (await post({ type: "open", runId: "../secret" })).status,
      409,
    );
    const open = await post({ type: "open", runId });
    assert.equal(open.status, 200);
    assert.equal((await fetch(url + "/api/health")).status, 200);
    const duplicate = await post({
      type: "create",
      id: runId,
      setup: webSetup,
    });
    assert.equal(duplicate.status, 200);
    assert.equal(service.list().runs.length, 1);
    const deadline = Date.now() + 90000;
    while (service.view().phase === "PREPARING" && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 200));
    assert.equal(service.view().phase, "READY");
    const cid = id(),
      request = { type: "control", runId, id: cid, action: { type: "start" } };
    const responses = await Promise.all([post(request), post(request)]);
    assert.ok(responses.every((r) => r.status === 200));
    assert.equal(
      (await post({ ...request, action: { type: "pause" } })).status,
      409,
    );
    assert.equal(
      (await post({ type: "create", id: id(), setup: webSetup })).status,
      409,
    );
    assert.equal(
      (
        await post({
          type: "control",
          runId,
          id: id(),
          action: { type: "freeze" },
        })
      ).status,
      200,
    );
  } finally {
    await app.close();
    await service.close();
    engine.close();
  }
});
