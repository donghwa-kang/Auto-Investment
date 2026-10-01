import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { once } from "node:events";
import { Engine } from "../src/server/engine.js";
import type { State } from "../src/core/types.js";
import { configured, run } from "./helpers.js";
test("NETWORK-01 합성 엔진 시작/전진 중 부모 fetch/https 계측 호출 0", async () => {
  let calls = 0;
  const blocked = () => {
    calls++;
    throw new Error("OUTBOUND_DENIED_TEST");
  };
  const fetchMock = mock.method(globalThis, "fetch", blocked);
  const httpsMock = mock.method(https, "request", blocked);
  let e: Engine | undefined;
  try {
    e = await configured();
    await run(e, "start");
    await run(e, "step", { seconds: 3 });
    assert.equal(calls, 0);
    assert.throws(
      () => fetch("https://blocked.example.invalid"),
      /OUTBOUND_DENIED/,
    );
    assert.equal(calls, 1);
    assert.throws(
      () => https.request("https://blocked.example.invalid"),
      /OUTBOUND_DENIED/,
    );
    assert.equal(calls, 2);
    // 정적 경계는 network-boundary.test.ts가 전이 의존성/worker를 따로 검사한다.
    // 부모 mock은 import 시점과 별도 worker를 계측하지 않으므로 OS 격리 증명이 아니다.
  } finally {
    fetchMock.mock.restore();
    httpsMock.mock.restore();
    e?.close();
  }
});
test("CRASH-01 별도 프로세스 강제 종료 뒤 의도/접수/부분체결 보존", async () => {
  for (const phase of ["INTENT", "ACCEPTED", "PARTIAL"]) {
    const path = join(
      mkdtempSync(join(tmpdir(), "paper-crash-")),
      "test.sqlite",
    );
    const child = spawn(
      process.execPath,
      ["scripts/crash-fixture.mjs", path, phase],
      { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
    );
    let stderr = "";
    child.stderr!.on("data", (b) => {
      stderr += String(b);
    });
    const ready = await new Promise<State>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("CRASH_CHILD_TIMEOUT"));
      }, 30000);
      child.once("message", (m) => {
        clearTimeout(timer);
        resolve((m as { state: State }).state);
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== null && code !== 0)
          reject(new Error(stderr || `CHILD_EXIT:${code}`));
      });
    });
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    const restored = new Engine(path, () => Date.now() + 20000);
    try {
      assert.equal(restored.state().status, "RECONCILING");
      assert.equal(restored.state().orders[0]!.filled, ready.orders[0]!.filled);
      assert.equal(restored.state().orders[0]!.status, ready.orders[0]!.status);
      assert.equal(restored.state().ledger.intents, 1);
      assert.equal(restored.state().orders.length, 1);
      await assert.rejects(run(restored, "start"), /PREFLIGHT_BLOCKED/);
      assert.ok(restored.repo.verifyAudit() > 2);
    } finally {
      restored.close();
    }
  }
});
test("FAULT-01 적체/시계 이상·미해결 재시작 가드", async () => {
  const e = await configured();
  try {
    await run(e, "start");
    await run(e, "step", { seconds: 2 });
    await run(e, "fault", { fault: "CLOCK_ERROR" });
    assert.equal(e.state().status, "RECONCILING");
    await assert.rejects(run(e, "start"), /PREFLIGHT_BLOCKED/);
    await run(e, "step", { seconds: 4 });
    assert.ok(e.state().positions[0]!.protectedQuantity > 0);
    await run(e, "fault", { fault: "NONE" });
    assert.equal(e.state().status, "RECONCILING");
    await run(e, "reconcile");
    assert.equal(e.state().status, "ENTRY_PAUSED");
  } finally {
    e.close();
  }
});
