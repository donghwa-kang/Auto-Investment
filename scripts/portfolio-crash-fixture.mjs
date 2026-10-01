import { PortfolioProgram } from "../dist/runtime/src/core/portfolio-program.js";
import { PortfolioPaperEngine } from "../dist/runtime/src/server/portfolio-engine.js";
import {
  portfolioFixture,
  laterTick,
} from "../dist/runtime/src/core/portfolio-fixture.js";
import { replayFixture } from "../dist/runtime/tests/signal-replay-helpers.js";
import {
  prepareSell,
  injectUnknownSell,
} from "../dist/runtime/tests/sell-unknown-helpers.js";
const [path, phase] = process.argv.slice(2);
if (
  !path ||
  ![
    "INTENT",
    "ACCEPTED",
    "PARTIAL",
    "SELL_UNKNOWN",
    "SELL_CANCEL_UNKNOWN",
  ].includes(phase)
)
  throw Error("TEST_ARGUMENTS");
const raw = replayFixture(),
  f = portfolioFixture(raw),
  p = new PortfolioProgram(raw, f.settings);
const engine = new PortfolioPaperEngine(p, path);
if (phase.startsWith("SELL_")) {
  prepareSell(engine, true, true);
  injectUnknownSell(
    engine,
    phase === "SELL_UNKNOWN" ? "UNKNOWN" : "CANCEL_UNKNOWN",
  );
} else {
  engine.command("start", { type: "start" });
  engine.command("frame", f.ticks[0]);
  if (phase !== "INTENT") engine.command("t1", laterTick(f.ticks[0], 1));
  if (phase === "PARTIAL") engine.command("t2", laterTick(f.ticks[0], 2));
}
process.send?.({ state: engine.state() });
setInterval(() => {}, 1000);
