import { hash } from "../src/core/policy.js";
import { finalizationContractHash } from "../src/core/cost-finalization.js";
import type { OperatingCloseRequest } from "../src/core/cost-operating-close.js";
import {
  operatingConfig,
  openedOperating,
  op,
  record,
} from "./cost-operating-helpers.js";
import { beginTrade, fillTrade, closeTrade } from "./cost-outcome-helpers.js";

export function finalizationConfig() {
  return {
    ...operatingConfig(),
    finalization: { contractHash: finalizationContractHash },
  };
}
export type FinalizationFixture = ReturnType<typeof openedOperating>;
// Only the test author can declare that this synthetic risk day and its
// unpopulated intervals have no missing events. Not a real collection sealer.
export function closeRequest(f: FinalizationFixture): OperatingCloseRequest {
  const records = f.repo.db
    .prepare(
      "SELECT id,body,receipt FROM cost_reservation_commands ORDER BY seq",
    )
    .all()
    .map((r) => ({
      id: String(r.id),
      input: JSON.parse(String(r.body)) as unknown,
      receipt: JSON.parse(String(r.receipt)) as unknown,
    }));
  return {
    schemaVersion: "OPERATING_CLOSE_FIXTURE_REQUEST_V1",
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    manifest: {
      configHash: hash(f.c),
      stateHash: hash(f.store.read()),
      recordsHash: hash(records),
      recordCount: records.length,
      periodStart: f.c.operating.periodStart,
      periodEnd: f.c.operating.periodEnd,
      coverage: "FULL_PERIOD_FROM_EMPTY",
      finalizedAt: f.c.operating.periodEnd,
      availableAt: f.c.operating.periodEnd,
    },
    asOf: f.c.operating.periodEnd,
  };
}
export function closedFixture(f: FinalizationFixture, price = "10022") {
  const run = beginTrade(f.store);
  fillTrade(f.store, run);
  closeTrade(f.store, run, price);
  record(f.store, op(f.store.read(), "RECOGNIZE", "cost", "3"));
  return run;
}
