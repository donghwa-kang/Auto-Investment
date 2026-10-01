import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Repository } from "../src/server/repository.js";
test("SHUTDOWN-01 실제 CLI 시작/로그인/정상 저장 종료 및 재시작 가드", async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "paper-shutdown-")),
    "test.sqlite",
  );
  const child = spawn(process.execPath, ["dist/runtime/src/server/main.js"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PAPER_DB: path, PAPER_PORT: "4188" },
  });
  let ended = false;
  child.once("exit", () => {
    ended = true;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("START_TIMEOUT")), 15000);
      child.stdout!.on("data", (b) => {
        if (String(b).includes("http://127.0.0.1:4188")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`START_EXIT:${code}`));
      });
    });
    const url = "http://127.0.0.1:4188",
      code = readFileSync("data/local-pairing.txt", "utf8")
        .trim()
        .split("\n")
        .at(-1)!;
    const login = await fetch(url + "/api/login", {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!,
      { csrf } = (await login.json()) as { csrf: string };
    const exit = once(child, "exit");
    const result = await fetch(url + "/api/command", {
      method: "POST",
      headers: {
        Origin: url,
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({
        id: "shutdown-test-command",
        command: { type: "shutdown", confirm: true },
      }),
    });
    assert.equal(result.status, 202);
    const [exitCode] = await exit;
    assert.equal(exitCode, 0);
    const repo = new Repository(path);
    try {
      assert.equal(repo.read()!.cleanShutdown, true);
      assert.equal(repo.read()!.status, "RECONCILING");
      assert.ok(repo.verifyAudit() >= 2);
    } finally {
      repo.close();
    }
    assert.match(readFileSync("data/local-pairing.txt", "utf8"), /만료/);
  } finally {
    if (!ended) child.kill();
  }
});
