import { randomUUID } from "node:crypto";
import { Engine } from "../src/server/engine.js";
import { emptyLedger } from "../src/core/ledger.js";
import type { Config } from "../src/core/policy.js";
import type { State } from "../src/core/types.js";
export const config: Config = {
  capital: 5000000,
  usdCapitalKrw: 0,
  level: "LOW",
  mode: "PAPER",
  forecast: "TEST_ONLY",
  scenario: "B",
  market: "KR",
  stage: "PILOT",
};
export async function configured(
  overrides: Partial<Config> = {},
  path = ":memory:",
) {
  const e = new Engine(path);
  await e.command(randomUUID(), {
    type: "configure",
    config: { ...config, ...overrides },
  });
  return e;
}
export async function run(
  e: Engine,
  type: string,
  extra: Record<string, unknown> = {},
) {
  return e.command(randomUUID(), { type, ...extra });
}
export function state(overrides: Partial<Config> = {}): State {
  const c = { ...config, ...overrides },
    clock = Date.parse("2026-08-31T00:45:00Z");
  return {
    version: 1,
    revision: 1,
    config: c,
    status: "RUNNING",
    clock,
    sessionOpen: clock - 45 * 60000,
    sessionClose: clock + 345 * 60000,
    cursor: 0,
    epoch: 1,
    pendingLevel: null,
    ledger: emptyLedger(
      clock,
      String(c.capital),
      String(c.usdCapitalKrw / 1300),
    ),
    positions: [],
    orders: [],
    decisions: [],
    notices: [],
    lastSignalAt: 0,
    manifest: null,
    manifestHistory: [],
    fault: null,
    cleanShutdown: false,
  };
}
