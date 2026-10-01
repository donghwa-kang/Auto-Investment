import { parentPort, workerData } from "node:worker_threads";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PortfolioWebRun, prepareWebPlan } from "./portfolio-web-run.js";
import { type WebSetup, type WebAction } from "../core/portfolio-web-schema.js";
const port = parentPort!;
const data = workerData as {
  directory: string;
  setup: WebSetup;
  create: boolean;
  intervalMs?: number;
};
let run: PortfolioWebRun | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
try {
  if (data.create && !existsSync(resolve(data.directory, "plan.json")))
    prepareWebPlan(data.directory, data.setup);
  run = new PortfolioWebRun(data.directory);
  port.postMessage({ type: "ready", view: run.view() });
  timer = setInterval(() => {
    try {
      run!.heartbeat();
      run!.step();
      port.postMessage({ type: "view", view: run!.view() });
    } catch {
      run!.fail();
      try {
        port.postMessage({ type: "view", view: run!.view() });
      } catch {
        port.postMessage({ type: "fatal" });
      }
    }
  }, data.intervalMs ?? 1000);
  port.on(
    "message",
    (message: {
      type: "control" | "close";
      id: string;
      commandId: string;
      action: WebAction;
    }) => {
      if (message.type === "close") {
        if (timer) clearInterval(timer);
        try {
          run!.close();
          port.postMessage({ type: "closed" });
        } catch {
          port.postMessage({ type: "fatal" });
        }
        port.close();
        return;
      }
      try {
        port.postMessage({
          type: "reply",
          id: message.id,
          view: run!.control(message.commandId, message.action),
        });
      } catch (e) {
        const code =
          e instanceof Error && /^[A-Z_]+$/.test(e.message)
            ? e.message
            : "WEB_COMMAND_REJECTED";
        port.postMessage({ type: "reply", id: message.id, error: code });
      }
    },
  );
} catch {
  if (timer) clearInterval(timer);
  port.postMessage({ type: "fatal" });
  port.close();
}
