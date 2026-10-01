import { Engine } from "../dist/runtime/src/server/engine.js";
const [path, phase] = process.argv.slice(2);
if (!path || !["INTENT", "ACCEPTED", "PARTIAL"].includes(phase))
  throw new Error("TEST_ARGUMENTS");
const engine = new Engine(path);
await engine.command("crash-configure", {
  type: "configure",
  config: {
    capital: 5000000,
    level: "LOW",
    mode: "PAPER",
    forecast: "TEST_ONLY",
    scenario: "B",
    market: "KR",
  },
});
await engine.command("crash-start", { type: "start" });
if (phase !== "INTENT")
  await engine.command("crash-step", {
    type: "step",
    seconds: phase === "ACCEPTED" ? 1 : 2,
  });
process.send?.({ ready: true, state: engine.state() });
setInterval(() => {}, 1000);
