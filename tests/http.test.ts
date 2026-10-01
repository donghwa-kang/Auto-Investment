import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { Engine } from "../src/server/engine.js";
import { createApp } from "../src/server/http.js";
const code = "TEST_ONLY_LOCAL_PAIRING_123456789";
test("SEC-HTTP-01 인증·Origin·Host·CSRF·스키마·경로 격리", async () => {
  const e = new Engine(":memory:"),
    app = createApp(e, code);
  const url = await app.listen(0);
  try {
    const raw = async (
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(body === undefined
            ? {}
            : { Origin: url, "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    assert.equal((await raw("/api/health")).status, 200);
    assert.equal((await raw("/api/state")).status, 401);
    assert.equal(
      (
        await raw(
          "/api/login",
          { code },
          { Origin: "https://attacker.invalid" },
        )
      ).status,
      403,
    );
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        url + "/api/health",
        { headers: { Host: "evil.invalid" } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(hostStatus, 403);
    const login = await raw("/api/login", { code });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    assert.ok(login.headers.get("set-cookie")!.includes("HttpOnly"));
    assert.ok(login.headers.get("set-cookie")!.includes("SameSite=Strict"));
    const { csrf } = (await login.json()) as { csrf: string };
    assert.equal((await raw("/api/login", { code })).status, 401);
    assert.equal(
      (await raw("/api/state", undefined, { Cookie: cookie })).status,
      200,
    );
    const valid = { id: "security-command-1", command: { type: "pause" } };
    assert.equal(
      (await raw("/api/command", valid, { Cookie: cookie })).status,
      403,
    );
    assert.equal(
      (
        await raw("/api/command", valid, {
          Cookie: cookie,
          "X-CSRF-Token": csrf,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await raw(
          "/api/command",
          {
            ...valid,
            id: "security-command-2",
            command: { type: "LIVE", live_enabled: true },
          },
          { Cookie: cookie, "X-CSRF-Token": csrf },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await raw(
          "/api/command",
          { ...valid, id: "'; DROP TABLE aggregate;--" },
          { Cookie: cookie, "X-CSRF-Token": csrf },
        )
      ).status,
      400,
    );
    assert.equal(
      (await raw("/api/audit?page=0%20OR%201=1", undefined, { Cookie: cookie }))
        .status,
      400,
    );
    assert.equal((await raw("/data/paper.sqlite")).status, 404);
    assert.equal(
      (await raw("/outputs/AI_TRADING_POLICY_v2.3.json")).status,
      404,
    );
    const tooLarge = await raw(
      "/api/command",
      { blob: "x".repeat(9000) },
      { Cookie: cookie, "X-CSRF-Token": csrf },
    );
    assert.equal(tooLarge.status, 400);
    assert.ok(e.repo.verifyAudit() > 0);
    const missingOrigin = await fetch(url + "/api/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify(valid),
    });
    assert.equal(missingOrigin.status, 403);
  } finally {
    await app.close();
    e.close();
  }
});
