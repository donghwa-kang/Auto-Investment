import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { request as httpRequest } from "node:http";
import { Engine } from "../src/server/engine.js";
import { createApp } from "../src/server/http.js";
import { CodexAnalysisService } from "../src/server/codex-analysis-service.js";
import type { AnalysisView } from "../src/core/codex-analysis-schema.js";
import { configured, run } from "./helpers.js";
import { hash } from "../src/core/policy.js";

test("ANALYSIS-HTTP 인증·CSRF·Origin·입력 제한·결과 조회·거래 장부 불변·분석 저장 장애 격리", async () => {
  const path = resolve(
      mkdtempSync(resolve(tmpdir(), "analysis-http-")),
      "mock.sqlite",
    ),
    analysis = new CodexAnalysisService(path),
    e = new Engine(":memory:"),
    code = "TEST_ONLY_ANALYSIS_LOCAL_PAIRING_12345";
  const app = createApp(e, code, { analysis }),
    url = await app.listen(0);
  let cookie = "",
    csrf = "";
  const request = (body?: unknown, headers: Record<string, string> = {}) =>
    fetch(url + "/api/codex-analysis", {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookie,
        Origin: url,
        "Content-Type": "application/json",
        "x-csrf-token": csrf,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await request()).status, 401);
    const login = await fetch(url + "/api/login", {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    csrf = ((await login.json()) as { csrf: string }).csrf;
    const command = {
      type: "create",
      id: randomUUID(),
      dataset: "SYNTHETIC_REVIEW_FIXTURE_V1",
    };
    assert.equal((await request(command, { "x-csrf-token": "" })).status, 403);
    assert.equal(
      (await request(command, { Origin: "https://outside.invalid" })).status,
      403,
    );
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const r = httpRequest(
        url + "/api/codex-analysis",
        { headers: { Host: "outside.invalid", Cookie: cookie } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      r.on("error", reject);
      r.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal(
      (await request({ ...command, filePath: "C:/TEST_SECRET.txt" })).status,
      409,
    );
    assert.equal(
      (await request({ ...command, large: "x".repeat(9000) })).status,
      409,
    );
    const before = hash(e.state());
    const created = await request(command),
      j = ((await created.json()) as AnalysisView).jobs[0]!;
    assert.equal(created.status, 200);
    const args = { id: j.request.id, requestHash: j.requestHash };
    assert.equal((await request({ type: "run", ...args })).status, 409);
    assert.equal(
      (
        await request({
          type: "approve",
          ...args,
          acknowledgeExactData: true,
          acknowledgeMockOnly: true,
        })
      ).status,
      200,
    );
    await request({ type: "run", ...args });
    await request({ type: "run", ...args });
    await analysis.idle();
    const view = (await (await request()).json()) as AnalysisView;
    assert.equal(view.jobs[0]!.state, "VERIFIED_MOCK");
    assert.equal(view.mockCalls, 1);
    assert.equal(view.externalCalls, 0);
    assert.equal(hash(e.state()), before);
    const db = new DatabaseSync(path);
    db.exec("UPDATE state SET checksum='bad'");
    db.close();
    assert.equal((await request()).status, 503);
    assert.equal(e.runtimeError, null);
    assert.equal((await fetch(url + "/api/health")).status, 200);
    assert.equal(hash(e.state()), before);
  } finally {
    await app.close();
    await analysis.close().catch(() => {});
    e.close();
  }
});
test("ANALYSIS-RISK 분석 사용/오류와 무관하게 예측 누락 진입 차단·보호 실패 위험관리 유지", async () => {
  const s = new CodexAnalysisService(
    resolve(mkdtempSync(resolve(tmpdir(), "analysis-risk-")), "mock.sqlite"),
    async () => {
      throw new Error("MOCK_TEST_FAILURE");
    },
  );
  const a = await configured({ forecast: "MISSING_PROFILE" }),
    b = await configured({ scenario: "PROTECTION_FAILURE" });
  try {
    const j = s.request({
      type: "create",
      id: randomUUID(),
      dataset: "SYNTHETIC_REVIEW_FIXTURE_V1",
    }).jobs[0]!;
    s.request({
      type: "approve",
      id: j.request.id,
      requestHash: j.requestHash,
      acknowledgeExactData: true,
      acknowledgeMockOnly: true,
    });
    s.request({ type: "run", id: j.request.id, requestHash: j.requestHash });
    await s.idle();
    assert.equal(s.view().jobs[0]!.state, "FAILED");
    await run(a, "start");
    await run(a, "step", { seconds: 10 });
    assert.equal(a.state().orders.length, 0);
    assert.ok(
      JSON.stringify(a.state().decisions).includes("MISSING_FORECAST_PROFILE"),
    );
    await run(b, "start");
    await run(b, "step", { seconds: 10 });
    assert.ok(b.state().ledger.halts.includes("PROTECTION_FAILURE"));
    assert.notEqual(b.state().status, "RUNNING");
  } finally {
    await s.close();
    a.close();
    b.close();
  }
});
