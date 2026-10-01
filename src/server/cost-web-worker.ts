import { parentPort, workerData } from "node:worker_threads";
import { CostWebRun } from "./cost-web-run.js";
import { makeCostWebProgram } from "./cost-web-fixture.js";
import type { CostWebControl } from "../core/cost-web-schema.js";
import { CostAppRun } from "./cost-app-run.js";
import { costAppRecipe } from "./cost-app-fixture.js";
const port = parentPort!;
const data = workerData as {
  directory: string;
  create: boolean;
  recipe?: string;
};
let run: CostWebRun | CostAppRun | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const publish = () => {
  if (run) port.postMessage({ type: "view", view: run.view() });
};
try {
  run =
    data.recipe === costAppRecipe
      ? new CostAppRun(data.directory, data.create)
      : new CostWebRun(
          data.directory,
          makeCostWebProgram(),
          data.create,
          publish,
        );
  port.postMessage({ type: "ready", view: run.view() });
  timer = setInterval(() => {
    run!.step();
    publish();
  }, 500);
  port.on(
    "message",
    (m: {
      type: "control" | "close" | "capture";
      token?: string;
      command: CostWebControl;
    }) => {
      if (m.type === "close") {
        if (timer) clearInterval(timer);
        try {
          run!.close();
        } finally {
          port.close();
        }
        return;
      }
      try {
        if (m.type === "capture") {
          if (!(run instanceof CostAppRun))
            throw Error("COST_APP_RECIPE_REQUIRED");
          port.postMessage({
            type: "reply",
            token: m.token,
            input: run.verificationInput(),
            view: run.view(),
          });
          return;
        }
        port.postMessage({
          type: "reply",
          token: m.token,
          view: run!.control(m.command),
        });
      } catch (e) {
        port.postMessage({
          type: "reply",
          token: m.token,
          view: run!.view(),
          error:
            e instanceof Error && /^[A-Z_0-9]+$/.test(e.message)
              ? e.message
              : "COST_WEB_COMMAND_REJECTED",
        });
      }
    },
  );
} catch {
  if (timer) clearInterval(timer);
  run?.close();
  port.postMessage({ type: "fatal" });
  port.close();
}
