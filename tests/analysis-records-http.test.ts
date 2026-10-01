import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Engine } from "../src/server/engine.js";
import { createApp } from "../src/server/http.js";
import { CodexAnalysisService } from "../src/server/codex-analysis-service.js";
import type { AnalysisView } from "../src/core/codex-analysis-schema.js";
import type { RecordSourceInfo } from "../src/core/analysis-record-schema.js";
import { hash } from "../src/core/policy.js";
import { recordedAnalysisFixture } from "./analysis-record-helpers.js";

test("RECORD-HTTP 선택 목록/내보내기 인증·CSRF·경로 차단·분석 전후 원본/거래 장부 불변", async () => {
  const f = recordedAnalysisFixture(),
    before = readFileSync(f.path);
  const analysis = new CodexAnalysisService(
    resolve(f.root, "mock.sqlite"),
    undefined,
    Date.now,
    f.sources,
  );
  const engine = new Engine(":memory:"),
    originalState = hash(engine.state());
  const code = "TEST_ONLY_RECORDS_HTTP_PAIRING_12345",
    app = createApp(engine, code, { analysis }),
    url = await app.listen(0);
  let cookie = "",
    csrf = "";
  const request = (
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookie,
        Origin: url,
        "Content-Type": "application/json",
        "x-csrf-token": csrf,
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const inspect = { type: "inspect", runId: f.runId };
    assert.equal((await request("/api/codex-records")).status, 401);
    assert.equal((await request("/api/codex-records", inspect)).status, 401);
    const login = await request("/api/login", { code });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    csrf = ((await login.json()) as { csrf: string }).csrf;
    assert.deepEqual(await (await request("/api/codex-records")).json(), {
      runs: [f.runId],
    });
    assert.equal(
      (await request("/api/codex-records", inspect, { "x-csrf-token": "" }))
        .status,
      403,
    );
    assert.equal(
      (
        await request("/api/codex-records", inspect, {
          Origin: "https://outside.invalid",
        })
      ).status,
      403,
    );
    for (const body of [
      { ...inspect, runId: "../TEST_SECRET" },
      { ...inspect, filePath: "C:/TEST_SECRET.txt" },
      { ...inspect, large: "x".repeat(9000) },
    ]) {
      const response = await request("/api/codex-records", body);
      assert.equal(response.status, 409);
      assert.ok(!(await response.text()).includes("TEST_SECRET"));
    }
    const info = (await (
      await request("/api/codex-records", inspect)
    ).json()) as RecordSourceInfo;
    assert.equal(info.sourceId, f.source.exportHash);
    const command = {
      type: "create-record",
      id: randomUUID(),
      sourceId: info.sourceId,
      period: f.period,
    };
    const j = (
      (await (
        await request("/api/codex-analysis", command)
      ).json()) as AnalysisView
    ).jobs[0]!;
    assert.equal(j.request.bundle.version, "ENGINE_RECORD_ANALYSIS_BUNDLE_V1");
    const bound = { id: j.request.id, requestHash: j.requestHash };
    assert.equal(
      (
        await request("/api/codex-analysis", {
          type: "approve",
          ...bound,
          requestHash: "0".repeat(64),
          acknowledgeExactData: true,
          acknowledgeMockOnly: true,
        })
      ).status,
      409,
    );
    await request("/api/codex-analysis", {
      type: "approve",
      ...bound,
      acknowledgeExactData: true,
      acknowledgeMockOnly: true,
    });
    await request("/api/codex-analysis", { type: "run", ...bound });
    await analysis.idle();
    const view = (await (
      await request("/api/codex-analysis")
    ).json()) as AnalysisView;
    assert.equal(view.jobs[0]!.state, "VERIFIED_MOCK");
    assert.equal(view.mockCalls, 1);
    assert.equal(view.externalCalls, 0);
    assert.deepEqual(readFileSync(f.path), before);
    assert.equal(hash(engine.state()), originalState);
  } finally {
    await app.close();
    await analysis.close();
    engine.close();
  }
});
