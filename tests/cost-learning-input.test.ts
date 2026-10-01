import { test as runTest } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hash } from "../src/core/policy.js";
import { rebuildRvol } from "../src/core/learning-rvol.js";
import { runSignalReplay } from "../src/core/signal-replay.js";
import { parseLearningInput } from "../src/core/learning-schema.js";
import { verifyOperatingEvidence } from "../src/core/cost-operating-evidence.js";
import {
  costLearningInputLimits,
  costLearningPermissions,
  createCostLearningInput,
  verifyCostLearningInput,
  verifyCostLearningBatch,
} from "../src/server/cost-learning-input.js";
import {
  capturedLearning,
  learningSources,
  openLearning,
  reEnvelope,
} from "./cost-learning-input-helpers.js";
import type { LearningCapture } from "./cost-learning-input-helpers.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";
import { op, record } from "./cost-operating-helpers.js";
import { journal, fillEvent } from "./cost-outcome-helpers.js";

// Let the parent runner deliver each completed CPU-bound case immediately.
function test(name: string, check: () => void) {
  return runTest(name, async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    check();
  });
}

function verify(f: LearningCapture) {
  return verifyCostLearningInput(f.text, f.anchor);
}
function sealFinancial(f: LearningCapture) {
  const { exportHash: previous, ...body } = f.financial;
  assert.notEqual(previous, "");
  f.financial.exportHash = hash(body);
  f.anchor.operating.exportHash = f.financial.exportHash;
  f.envelope.operatingEvidenceText = JSON.stringify(f.financial);
  return reEnvelope(f);
}
for (const strategy of ["B", "P"] as const)
  test(`LI-01 ${strategy}: original signal/history/cost/D8, independent RVOL, no authority`, () => {
    const f = capturedLearning("closed", strategy),
      row = verify(f);
    assert.equal(row.status, "SYNTHETIC_INPUT_ELIGIBLE");
    assert.deepEqual(Object.keys(row.features).sort(), [
      "numericProfile",
      "rvol",
    ]);
    assert.equal(row.features.rvol, rebuildRvol(row.audit.rvolSource).value);
    // Independent fixture oracle: prior 15-minute sums = 15*20000;
    // current B = 15*40000, P = 15*30000. No indicator calculator used.
    assert.equal(row.features.rvol, strategy === "B" ? "2" : "1.5");
    assert.equal(row.audit.rvol.selectedBarCount, 315);
    assert.equal(
      row.decisionContext!.approvedCandidate.operatingEstimateKrw,
      "4",
    );
    assert.equal(
      row.trainingLabel!.checkpointHash,
      f.financial.report.financialEvidence.finalization.checkpointHash,
    );
    for (const [k, value] of Object.entries(costLearningPermissions))
      assert.equal(Reflect.get(row, k), value);
    assert.equal(row.audit.financialReport.status, "HOLD");
  });
test("LI-02: exact 2330 integer oracle; historical estimate/payments not charged twice", () => {
  const row = verify(capturedLearning()),
    label = row.trainingLabel!;
  assert.equal(label.grossPnlKrw, "2400");
  assert.deepEqual(label.components, {
    COMMISSION: "20",
    TAX: "0",
    EXCHANGE: "0",
    FX: "0",
  });
  assert.equal(label.operatingAllocationKrw, "50");
  assert.equal(label.finalNetPnlKrw, String(2400n - 20n - 50n));
});
test("LI-02 components: TAX/EXCHANGE kept; cumulative line.amount never summed", () => {
  const row = verify(capturedLearning("components")),
    label = row.trainingLabel!;
  assert.equal(row.status, "SYNTHETIC_INPUT_ELIGIBLE");
  const q = BigInt(row.decisionContext!.approvedCandidate.quantity);
  const fee = (price: bigint) => (q * price * 10n + 9999n) / 10000n;
  const commission = fee(21400n) + fee(22000n);
  assert.deepEqual(label.components, {
    COMMISSION: String(commission),
    TAX: "4",
    EXCHANGE: "6",
    FX: "0",
  });
  assert.equal(
    label.finalNetPnlKrw,
    String(q * 600n - commission - 4n - 6n - 50n),
  );
  const postings =
    row.audit.financialReport.financialEvidence.trades[0]!.historicalPostings;
  assert.ok(
    postings.flatMap((p) => p.lines).some((l) => l.amount !== l.amountDelta),
  );
});
for (const mode of ["loss", "risk-halt", "unpaid", "unsettled"])
  test(`LI-03 ${mode}: finalized negative/protection/unsettled outcome retained, no rights`, () => {
    const row = verify(capturedLearning(mode));
    assert.equal(row.status, "SYNTHETIC_INPUT_ELIGIBLE");
    if (mode === "loss" || mode === "risk-halt") {
      assert.ok(BigInt(row.trainingLabel!.finalNetPnlKrw) < 0n);
      assert.equal(row.audit.financialReport.financialEvidence.lossStreak, 1);
      if (mode === "risk-halt")
        assert.ok(
          row.audit.financialReport.financialEvidence.riskHalts.length > 0,
        );
    } else assert.equal(row.audit.settlementPending, true);
    if (mode === "unpaid")
      assert.equal(
        row.audit.financialReport.financialEvidence.operating.current
          .payableKrw,
        "50",
      );
    if (mode === "unsettled") {
      const account =
        row.audit.financialReport.financialEvidence.currentAccounts.find(
          (a) => a.currency === "KRW",
        )!;
      assert.ok(
        BigInt(account.receivable) > 0n && BigInt(account.totalPayable) > 0n,
      );
    }
    assert.equal(row.learningAllowed, false);
    assert.ok(
      row.audit.financialReport.financialEvidence.admissionHolds.length > 0,
    );
  });
for (const mode of ["future", "prefix"])
  test(`LI-04 ${mode}: separately executed/pinned sources retain as-of features/population`, () => {
    const base = verify(capturedLearning()),
      row = verify(capturedLearning(mode));
    assert.deepEqual(row.features, base.features);
    assert.equal(row.population.frameHash, base.population.frameHash);
    assert.equal(row.intentKey, base.intentKey);
    assert.notEqual(row.inputHash, base.inputHash);
    const f = capturedLearning(mode);
    assert.throws(
      () => verifyCostLearningInput(f.text, capturedLearning().anchor),
      /HASH_MISMATCH/,
    );
  });
const invalidSources: [string, (f: LearningCapture) => void][] = [
  [
    "bar missing",
    (f) => {
      f.envelope.replay.histories[0]!.sessions.at(-1)!.rows = [];
    },
  ],
  [
    "benchmark missing",
    (f) => {
      f.envelope.replay.histories.pop();
    },
  ],
  [
    "actions unknown",
    (f) => {
      f.envelope.replay.histories[0]!.actionCoverage!.status = "UNKNOWN";
    },
  ],
  [
    "conflicting revision",
    (f) => {
      const s = f.envelope.replay.histories[0]!.sessions.at(-1)!,
        r = s.rows.find((r) => r.offset === 44)!;
      s.rows.push({ ...r, v: "123456" });
    },
  ],
  [
    "required source future",
    (f) => {
      const s = f.envelope.replay.histories[0]!.sessions.at(-1)!;
      for (const r of s.rows.filter((r) => r.offset === 44))
        r.availableAt = f.envelope.selection.frameAsOf + 60000;
    },
  ],
];
for (const [name, mutate] of invalidSources)
  test(`LI-05 ${name}: resealing cannot bind unavailable sources to original financial export`, () => {
    const f = capturedLearning();
    mutate(f);
    const entry = reEnvelope(f);
    // Trust/replay failure is rejection, not a claimed lower-level HOLD.
    assert.throws(() => verifyCostLearningInput(entry.text, entry.anchor));
  });
for (const name of ["features", "trainingLabel", "verified"])
  test(`LI-06 injected ${name}: no caller-derived feature/label/verification path`, () => {
    const f = capturedLearning();
    assert.throws(
      () => createCostLearningInput({ ...f.envelope, [name]: {} }),
      /SCHEMA_INVALID/,
    );
  });
for (const name of ["symbol", "settings", "forecast", "history"])
  test(`LI-06 ${name}: independently repinned mixed sources rejected`, () => {
    const f = capturedLearning();
    if (name === "symbol") f.envelope.selection.catalogKey = "KR:REPLAY-KR-P";
    if (name === "settings") f.envelope.settings.config.capital = 4999999;
    if (name === "forecast") f.envelope.selection.forecast.q05Exit = "21500";
    if (name === "history") {
      const command = f.financial.records.find(
        (r) => r.input.command.kind === "RESERVE",
      )!.input.command;
      assert.equal(command.kind, "RESERVE");
      if (command.kind === "RESERVE")
        command.proposal.operatingHistory!.costs[0]!.amount = "11";
      const entry = sealFinancial(f);
      assert.throws(
        () => verifyCostLearningInput(entry.text, entry.anchor),
        /OPERATING_EVIDENCE/,
      );
      return;
    }
    const entry = reEnvelope(f);
    assert.throws(() => verifyCostLearningInput(entry.text, entry.anchor));
  });
test("LI-07: label boundary before/equal/after; never fabricate prefix from later export", () => {
  const f = capturedLearning(),
    boundary = verify(f).trainingLabel!.labelAvailableAt;
  for (const offset of [-1, 0, 1]) {
    const entry = reEnvelope(f, { ...f.envelope, asOf: boundary + offset }),
      row = verifyCostLearningInput(entry.text, entry.anchor);
    assert.equal(row.status, offset < 0 ? "HOLD" : "SYNTHETIC_INPUT_ELIGIBLE");
    if (offset < 0) {
      assert.equal(row.trainingLabel, null);
      assert.ok(row.reasons.includes("LABEL_NOT_AVAILABLE"));
      assert.ok(row.reasons.includes("FINANCIAL_EXPORT_AFTER_AS_OF"));
    }
  }
});
for (const mode of ["open-close", "reconciling"])
  test(`LI-08 ${mode}: unfinalized/reconciling records stay HOLD with no label`, () => {
    const row = verify(capturedLearning(mode));
    assert.equal(row.status, "HOLD");
    assert.equal(row.trainingLabel, null);
    assert.ok(row.reasons.includes("OPERATING_NOT_FINALIZED"));
    if (mode === "reconciling")
      assert.ok(row.reasons.includes("UNRESOLVED_OR_POST_CLOSE_INPUT"));
  });
for (const mode of [
  "empty",
  "reserved",
  "released",
  "unknown",
  "no-fills",
  "partial-buy",
  "bought",
  "partial-sell",
])
  test(`LI-09 ${mode}: original incomplete state not a zero-profit completed sample`, () => {
    const f = capturedLearning(mode),
      row = verify(f);
    assert.equal(row.status, "HOLD");
    assert.equal(row.trainingLabel, null);
    assert.deepEqual(row.audit.financialReport, f.financial.report);
    const trade = row.audit.financialReport.financialEvidence.trades[0];
    if (mode === "partial-buy") assert.equal(trade!.quantity, 1);
    if (mode === "partial-sell")
      assert.ok(
        trade!.orders.some(
          (o) => o.side === "SELL" && o.status === "PARTIAL" && o.filled === 1,
        ),
      );
    if (mode === "unknown")
      assert.ok(trade!.orders.some((o) => o.status === "UNKNOWN"));
    assert.ok(row.reasons.includes("TRADE_NOT_CLOSED"));
  });
test("LI-10: replacement/partial fills one intent; exact transport/input retransmission not charged twice", () => {
  const f = capturedLearning("replacement"),
    row = verify(f),
    batch = verifyCostLearningBatch([f, { ...f, text: ` ${f.text}\n` }]);
  assert.equal(row.status, "SYNTHETIC_INPUT_ELIGIBLE");
  assert.equal(row.audit.financialReport.financialEvidence.trades.length, 1);
  assert.equal(batch.rows.length, 1);
  assert.equal(batch.rows[0]!.duplicateCount, 1);
  const label = row.trainingLabel!;
  assert.equal(label.components.COMMISSION, "30");
  assert.equal(label.finalNetPnlKrw, String(2400n - 30n - 50n));
});
test("LI-10: same fill delivery reused by original Store leaves exactly one posting", () => {
  const f = openLearning();
  try {
    f.reserve();
    f.handoff();
    const run = f.store.read().handoff!.transfers[0]!.runId,
      event = fillEvent(f.store.read(), run);
    f.store.execute("delivery", run, event, f.store.read());
    const before = dumpHandoff(f.repo),
      duplicate = {
        ...event,
        id: "redelivery",
        seq: event.seq + 1,
        at: event.at + 1,
      };
    f.store.execute("redelivery", run, duplicate, f.store.read());
    assert.deepEqual(dumpHandoff(f.repo), before);
    assert.equal(journal(f.store.read(), run).postings.length, 1);
    const row = verify(f.capture());
    assert.equal(row.trainingLabel, null);
  } finally {
    f.repo.close();
  }
});
for (const mode of ["new-version", "loss", "future", "prefix"])
  test(`LI-11 ${mode}: same intent varied execution/namespace/basis all HOLD, order invariant`, () => {
    const a = capturedLearning(),
      b = capturedLearning(mode),
      left = verifyCostLearningBatch([a, b]),
      right = verifyCostLearningBatch([b, a]);
    assert.deepEqual(left, right);
    assert.equal(left.rows[0]!.intentKey, left.rows[1]!.intentKey);
    assert.notEqual(
      left.rows[0]!.audit.financialExportHash,
      left.rows[1]!.audit.financialExportHash,
    );
    for (const row of left.rows) {
      assert.equal(row.status, "HOLD");
      assert.equal(row.trainingLabel, null);
      assert.deepEqual(row.reasons, ["INTENT_INPUT_CONFLICT"]);
    }
  });
test("LI-12: all declared nonbenchmark candidates preserved; no counterfactual cost or labels", () => {
  const f = capturedLearning(),
    row = verify(f),
    expected = runSignalReplay(f.envelope.replay).frames[0]!.items;
  assert.equal(row.population.items.length, expected.length);
  assert.deepEqual(
    row.population.items.map((i) => i.catalogKey).sort(),
    expected.map((i) => i.catalogKey).sort(),
  );
  for (const item of row.population.items) {
    const original = expected.find((i) => i.catalogKey === item.catalogKey)!;
    assert.equal(item.status, original.status);
    assert.deepEqual(item.reasons, original.reasons);
    if (!item.selected) {
      assert.equal(item.costDecision, "NOT_RECORDED");
      assert.equal(
        item.executionEvidence,
        "NOT_SELECTED_NO_EXECUTION_EVIDENCE",
      );
    }
    assert.equal(Reflect.has(item, "trainingLabel"), false);
  }
  assert.equal(row.population.scope, "DECLARED_FRAME_POPULATION");
  assert.equal(row.populationQualified, false);
  const p = verify(capturedLearning("closed", "P"));
  assert.deepEqual(
    [
      ...new Set(
        [...row.population.items, ...p.population.items].map((i) => i.status),
      ),
    ].sort(),
    ["BLOCKED", "CHART_SIGNAL", "NO_CHART_SIGNAL"],
  );
});
for (const part of [
  "command",
  "receipt",
  "fees",
  "allocation",
  "rights",
  "checkpoint",
])
  test(`LI-13 ${part}: resealed financial envelope cannot bypass full replay`, () => {
    const f = capturedLearning();
    if (part === "command")
      f.financial.records[0]!.input.expectedStateHash = "0".repeat(64);
    if (part === "receipt") f.financial.records[0]!.receipt.revision++;
    if (part === "fees")
      f.financial.report.financialEvidence.trades[0]!.tradingFees = "0";
    if (part === "allocation")
      f.financial.report.financialEvidence.finalization.allocations![0]!.operatingCostKrw =
        "49";
    if (part === "checkpoint")
      f.financial.report.financialEvidence.finalization.checkpoint!.appliedAt++;
    if (part === "rights")
      Reflect.set(f.financial.report, "learningAllowed", true);
    const entry = sealFinancial(f);
    assert.throws(
      () => verifyCostLearningInput(entry.text, entry.anchor),
      /OPERATING_EVIDENCE/,
    );
  });
test("LI-13: independent anchor required; duplicate input does not forgive mismatched anchor", () => {
  const f = capturedLearning();
  assert.throws(
    () =>
      verifyCostLearningInput(f.text, {
        ...f.anchor,
        inputHash: "0".repeat(64),
      }),
    /HASH_MISMATCH/,
  );
  assert.throws(
    () =>
      verifyCostLearningInput(f.text, {
        ...f.anchor,
        operating: { ...f.anchor.operating, exportHash: "0".repeat(64) },
      }),
    /OPERATING_EVIDENCE_HASH_MISMATCH/,
  );
  const wrong = { ...f.anchor, operating: structuredClone(f.anchor.operating) };
  wrong.operating.config.seed.ledger.wallets.KRW.cash = "1";
  assert.throws(
    () => verifyCostLearningInput(f.text, wrong),
    /OPERATING_EVIDENCE/,
  );
  assert.throws(
    () => verifyCostLearningBatch([f, { ...f, anchor: wrong }]),
    /DUPLICATE_ANCHOR_MISMATCH/,
  );
});
for (const value of [12, "1e1", "NaN", "Infinity"])
  test(`LI-14 invalid money ${String(value)}: not converted/rounded`, () => {
    const f = capturedLearning();
    Reflect.set(f.envelope.selection.forecast, "expectedExit", value);
    const entry = reEnvelope(f);
    assert.throws(() => verifyCostLearningInput(entry.text, entry.anchor));
  });
test("LI-14: outer byte/depth/node limits, nonfinite JSON, unknown version, batch bounds", () => {
  const f = capturedLearning(),
    limit = costLearningInputLimits;
  assert.equal(Object.isFrozen(limit), true);
  assert.equal(Object.isFrozen(costLearningPermissions), true);
  assert.equal(Reflect.set(limit, "bytes", 1), false);
  assert.equal(
    Reflect.set(costLearningPermissions, "learningAllowed", true),
    false,
  );
  assert.equal(limit.bytes, 64 * 1024 * 1024);
  assert.equal(costLearningPermissions.learningAllowed, false);
  assert.throws(
    () => verifyCostLearningInput(" ".repeat(limit.bytes + 1), f.anchor),
    /SIZE_LIMIT/,
  );
  assert.throws(
    () =>
      verifyCostLearningInput(
        '"' + "한".repeat(Math.floor(limit.bytes / 3) + 1) + '"',
        f.anchor,
      ),
    /SIZE_LIMIT/,
  );
  assert.throws(
    () =>
      verifyCostLearningInput("[".repeat(66) + "0" + "]".repeat(66), f.anchor),
    /STRUCTURE_LIMIT/,
  );
  assert.throws(
    () =>
      verifyCostLearningInput("[" + "0,".repeat(limit.nodes) + "0]", f.anchor),
    /STRUCTURE_LIMIT/,
  );
  assert.throws(
    () => verifyCostLearningInput("[1e999]", f.anchor),
    /NONFINITE/,
  );
  assert.throws(
    () => createCostLearningInput({ ...f.envelope, kind: "UNKNOWN" }),
    /SCHEMA_INVALID/,
  );
  assert.throws(() => verifyCostLearningBatch([]), /BATCH_LIMIT/);
  assert.throws(
    () => verifyCostLearningBatch(Array.from({ length: 17 }, () => f)),
    /BATCH_LIMIT/,
  );
  const tooBig = { ...f, text: " ".repeat(limit.bytes / 2 + 1) };
  assert.throws(
    () => verifyCostLearningBatch([tooBig, tooBig]),
    /BATCH_BYTES_LIMIT/,
  );
});
test("LI-15: active source/DB/lease unchanged; after close detached repeat results identical", () => {
  const f = openLearning();
  let capture: LearningCapture;
  try {
    f.reserve();
    f.handoff();
    for (let ms = 1000; ms <= 4000; ms += 1000) f.tick(ms);
    f.expense();
    for (let ms = 5000; ms <= 11000; ms += 1000) f.tick(ms, "22000");
    record(f.store, op(f.store.read(), "PAY", "pay", "50"));
    f.close();
    capture = f.capture();
    const before = dumpHandoff(f.repo),
      sourceHash = hash(capture),
      epoch = f.repo.epoch;
    const row = verify(capture);
    assert.equal(row.status, "SYNTHETIC_INPUT_ELIGIBLE");
    assert.deepEqual(dumpHandoff(f.repo), before);
    assert.equal(f.repo.epoch, epoch);
    assert.equal(hash(capture), sourceHash);
  } finally {
    f.repo.close();
  }
  const first = verify(capture!),
    next = verify(capture!);
  assert.deepEqual(first, next);
  first.features.rvol = "0";
  first.trainingLabel!.finalNetPnlKrw = "0";
  assert.deepEqual(verify(capture!), next);
});
test("LI-16: legacy learning/export parsers reject new input/results; no network/training/writer dependency", () => {
  const f = capturedLearning();
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  const row = (() => {
    globalThis.fetch = () => {
      networkCalls++;
      throw Error("UNEXPECTED_NETWORK_CALL");
    };
    try {
      return verify(f);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })();
  assert.equal(networkCalls, 0);
  for (const raw of [f.envelope, row])
    assert.throws(() => parseLearningInput(raw));
  assert.throws(
    () => verifyOperatingEvidence(f.text, f.anchor.operating),
    /OPERATING_EVIDENCE/,
  );
  const source = readFileSync("src/server/cost-learning-input.ts", "utf8");
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*(?:repository|cost-reservation-store|learning-registry|broker)[^"']*["']/,
  );
  assert.doesNotMatch(
    source,
    /\b(?:fetch|WebSocket|writeFile|train|registerModel|submitOrder)\s*\(/,
  );
  const sources = learningSources(),
    program = openLearning(sources);
  try {
    const v3 = program.program.config(),
      before = hash(v3);
    program.program.proposalForEvidence("0".repeat(64)).request.quote.ask = "1";
    program.program.frameForEvidence().items[0]!.reasons.push("mutated");
    assert.ok(
      !program.program.frameForEvidence().items[0]!.reasons.includes("mutated"),
    );
    assert.equal(hash(program.program.config()), before);
    assert.equal(program.store.read().revision, 0);
  } finally {
    program.repo.close();
  }
});
