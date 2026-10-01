import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../src/core/policy.js";
import { d } from "../src/core/math.js";
import {
  assessCostLearningReadiness,
  type CostLearningReadiness,
} from "../src/core/cost-learning-readiness.js";
import {
  CostOutcomeExportError,
  MAX_COST_EXPORT_BYTES,
  verifyCostOutcomeExport,
  type CostOutcomeExport,
  type CostExportAnchor,
} from "../src/core/cost-outcome-export.js";
import { parseLearningInput } from "../src/core/learning-schema.js";
import { evaluateLearning } from "../src/core/learning.js";
import { verifyPaperExport } from "../src/core/paper-learning-verify.js";
import { derivePaperRows } from "../src/core/paper-learning-convert.js";
import { LearningRegistry } from "../src/server/learning-registry.js";
import { proposal } from "./cost-reservation-helpers.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";
import {
  openedOutcome,
  outcomeConfig,
  beginTrade,
  fillTrade,
  closeTrade,
  cancelOrder,
  sellOrder,
  execute,
  journal,
} from "./cost-outcome-helpers.js";

const encode = (value: unknown) => JSON.stringify(value);
const fresh = () => mkdtempSync(join(tmpdir(), "cost-readiness-"));
type Opened = ReturnType<typeof openedOutcome>;
function capture(o: Opened) {
  const value = o.store.exportEvidence();
  const anchor = { config: o.c, exportHash: value.exportHash };
  const text = encode(value);
  return {
    value,
    anchor,
    text,
    report: assessCostLearningReadiness(text, anchor),
  };
}
function closed(market: "KR" | "US" = "KR") {
  const o = openedOutcome(outcomeConfig(market));
  try {
    const run = beginTrade(o.store);
    fillTrade(o.store, run);
    closeTrade(o.store, run, market === "KR" ? "10100" : "40.3");
    return capture(o);
  } finally {
    o.repo.close();
  }
}
const expectedChecks = [
  { id: "FINANCIAL_REPLAY", status: "VERIFIED", reasons: [] },
  {
    id: "FEATURE_BINDING",
    status: "MISSING",
    reasons: ["V3_FEATURE_SOURCE_NOT_BOUND"],
  },
  {
    id: "OPERATING_ALLOCATION",
    status: "UNSUPPORTED",
    reasons: ["OPERATING_COST_ALLOCATION_UNSUPPORTED"],
  },
  {
    id: "TRAINING_CONTRACT",
    status: "UNSUPPORTED",
    reasons: ["V3_TRAINING_CONTRACT_NOT_INTEGRATED"],
  },
  {
    id: "POPULATION_SCOPE",
    status: "LIMITED",
    reasons: ["V3_PREAPPROVAL_POPULATION_NOT_RECORDED"],
  },
];
function contract(r: CostLearningReadiness, value: CostOutcomeExport) {
  assert.equal(r.kind, "COST_LEARNING_READINESS_V1");
  assert.equal(r.purpose, "TEST_ONLY");
  assert.equal(r.status, "HOLD");
  assert.equal(r.trainingInput, null);
  assert.equal(r.learningAllowed, false);
  assert.equal(r.orderSubmissionAllowed, false);
  assert.equal(r.liveEnabled, false);
  assert.deepEqual(r.checks, expectedChecks);
  assert.deepEqual(r.financialReport, value.report);
  assert.deepEqual(r.source, {
    ...value.report.source,
    exportHash: value.exportHash,
    financialBasisHash: value.report.financialBasisHash,
    reportHash: value.report.reportHash,
  });
  assert.equal(r.coverage.scope, "PERSISTED_APPROVALS_ONLY");
  assert.equal(r.coverage.preApprovalDecisions, "NOT_RECORDED_BY_V3_CONTRACT");
  assert.equal(
    r.coverage.approvalCount,
    value.report.financialEvidence.approvals.length,
  );
  assert.equal(
    r.coverage.transferCount,
    value.report.financialEvidence.trades.length,
  );
  assert.equal(r.records.length, r.coverage.approvalCount);
  assert.equal(
    Object.values(r.coverage.phaseCounts).reduce((a, b) => a + b, 0),
    r.records.length,
  );
  assert.equal(
    new Set(r.records.map((row) => row.rowId)).size,
    r.records.length,
  );
  for (const [i, row] of r.records.entries()) {
    assert.equal(row.status, "HOLD");
    assert.equal(row.trainingLabel, null);
    assert.deepEqual(row.checks, expectedChecks);
    const { rowId, phase, checks, ...original } = row;
    assert.deepEqual(original, value.report.learningEvidence.records[i]);
    assert.equal(
      r.coverage.phaseCounts[phase],
      r.records.filter((v) => v.phase === phase).length,
    );
    assert.equal(
      rowId,
      hash({
        configHash: value.configHash,
        sourceScope: value.config.sourceScope,
        reservationId: row.reservationId,
      }),
    );
    assert.notEqual(checks, r.checks);
  }
  const { readinessHash, ...body } = r;
  assert.equal(readinessHash, hash(body));
}

for (const market of ["KR", "US"] as const)
  test(`D4-A01 ${market} replayed money and nonzero tax/exchange preserved without labels`, () => {
    const o = openedOutcome(outcomeConfig(market));
    try {
      const run = beginTrade(o.store, "FIRST", 1, "CONFIRMED", (p) => {
        for (const rule of p.rules)
          if (rule.component !== "COMMISSION")
            rule.fixed = market === "KR" ? "1" : "0.01";
      });
      fillTrade(o.store, run);
      closeTrade(o.store, run, market === "KR" ? "10100" : "40.3");
      const { value, report } = capture(o);
      contract(report, value);
      const t = report.financialReport.financialEvidence.trades[0]!;
      assert.ok(d(t.components.TAX).gt(0));
      assert.ok(d(t.components.EXCHANGE).gt(0));
      assert.equal(
        d(t.sellValue).minus(t.buyValue).minus(t.tradingFees).toString(),
        report.records[0]!.tradingNetPnlNative,
      );
      assert.equal(report.coverage.phaseCounts.CLOSED, 1);
    } finally {
      o.repo.close();
    }
  });

test("D4-A02/A10 empty approvals retain all five top-level checks", () => {
  const o = openedOutcome();
  try {
    const { report, value } = capture(o);
    contract(report, value);
    assert.deepEqual(report.records, []);
    assert.deepEqual(report.coverage.phaseCounts, {
      RESERVED_LOCAL: 0,
      RELEASED_LOCAL: 0,
      NO_FILLS: 0,
      INCOMPLETE_TRADE: 0,
      CLOSED: 0,
    });
  } finally {
    o.repo.close();
  }
});

test("D4-A02/A10 reserved/released/unknown/partial approvals keep order and nulls", () => {
  const o = openedOutcome();
  try {
    o.store.reserve(
      "reserve-release",
      o.store.prepare(proposal(o.store, "RELEASED")),
    );
    const reserved = capture(o);
    contract(reserved.report, reserved.value);
    assert.equal(reserved.report.records[0]!.phase, "RESERVED_LOCAL");
    o.store.release("release", "r-RELEASED", o.store.read());
    const run = beginTrade(o.store, "FIRST", 2, "UNKNOWN");
    const unknown = capture(o);
    contract(unknown.report, unknown.value);
    assert.deepEqual(
      unknown.report.records.map((r) => r.phase),
      ["RELEASED_LOCAL", "NO_FILLS"],
    );
    assert.equal(unknown.report.records[0]!.runId, null);
    assert.equal(unknown.report.records[0]!.outcomeBasisHash, null);
    assert.equal(
      unknown.report.financialReport.financialEvidence.trades[0]!.orders[0]!
        .status,
      "UNKNOWN",
    );
    fillTrade(o.store, run);
    const partial = capture(o);
    contract(partial.report, partial.value);
    assert.equal(partial.report.records[1]!.phase, "INCOMPLETE_TRADE");
    assert.equal(partial.report.records[1]!.tradingNetPnlNative, null);
  } finally {
    o.repo.close();
  }
});

test("D4-A03 native loss and unknown KRW conversion remain null/HOLD", () => {
  const o = openedOutcome(outcomeConfig("US"));
  try {
    const run = beginTrade(o.store);
    fillTrade(o.store, run);
    sellOrder(o.store, run, "39.7");
    fillTrade(
      o.store,
      run,
      "exit",
      1,
      "39.7",
      o.store.read().seed.clock + 60001,
    );
    const { report, value } = capture(o);
    contract(report, value);
    assert.ok(d(report.records[0]!.tradingNetPnlNative!).lt(0));
    assert.equal(report.records[0]!.tradingNetPnlKrw, null);
    assert.ok(report.records[0]!.reasons.length > 2);
  } finally {
    o.repo.close();
  }
});

test("D4-A03 large loss keeps existing risk halt and all evidence", () => {
  const o = openedOutcome();
  try {
    const run = beginTrade(o.store, "FIRST", 4);
    fillTrade(o.store, run, "entry", 4);
    closeTrade(o.store, run, "1");
    const before = o.store.read();
    assert.ok(
      d(before.outcomes![0]!.netPnlKrw!)
        .neg()
        .gt(d(before.approvals[0]!.candidate.budgetKrw).mul(2)),
    );
    assert.ok(before.seed.ledger.halts.includes("STOP_LOSS_EXCEEDS_2X"));
    const { report, value } = capture(o);
    contract(report, value);
    assert.deepEqual(
      report.financialReport.financialEvidence.riskHalts,
      before.seed.ledger.halts,
    );
    for (const reason of before.seed.ledger.halts)
      assert.ok(report.records[0]!.reasons.includes(reason));
    assert.deepEqual(o.store.read(), before);
  } finally {
    o.repo.close();
  }
});

test("D4-A04 partial same-time fills, replacement and settlement preserve stable row IDs", () => {
  const o = openedOutcome();
  try {
    const run = beginTrade(o.store, "FIRST", 3);
    const at = o.store.read().seed.clock + 1;
    fillTrade(o.store, run, "entry", 1, undefined, at);
    fillTrade(o.store, run, "entry", 1, undefined, at);
    cancelOrder(o.store, run);
    sellOrder(o.store, run, "10100");
    cancelOrder(o.store, run, "exit");
    sellOrder(o.store, run, "10100", "replacement", "exit");
    fillTrade(o.store, run, "replacement", 2, "10100");
    const first = capture(o);
    contract(first.report, first.value);
    const postings =
      first.report.financialReport.financialEvidence.trades[0]!.postings;
    assert.equal(postings[0]!.fill.at, postings[1]!.fill.at);
    assert.notEqual(postings[0]!.fill.fillId, postings[1]!.fill.fillId);
    execute(o.store, run, {
      kind: "SETTLE",
      id: "settle",
      fillIds: journal(o.store.read(), run).postings.map((p) => p.fill.fillId),
    });
    const second = capture(o);
    contract(second.report, second.value);
    assert.equal(
      second.report.records[0]!.rowId,
      first.report.records[0]!.rowId,
    );
    assert.equal(
      second.report.records[0]!.outcomeBasisHash,
      first.report.records[0]!.outcomeBasisHash,
    );
    assert.notEqual(
      second.report.source.exportHash,
      first.report.source.exportHash,
    );
    assert.notEqual(second.report.readinessHash, first.report.readinessHash);
    assert.equal(
      second.report.financialReport.financialEvidence.trades[0]!
        .unsettledFillCount,
      0,
    );
  } finally {
    o.repo.close();
  }
});

function rejectSame(text: string, anchor: CostExportAnchor) {
  let upstream: unknown;
  try {
    verifyCostOutcomeExport(text, anchor);
  } catch (error) {
    upstream = error;
  }
  assert.ok(upstream instanceof CostOutcomeExportError);
  assert.throws(
    () => assessCostLearningReadiness(text, anchor),
    (error: unknown) =>
      error instanceof CostOutcomeExportError &&
      error.message === upstream.message,
  );
}
const mutations: [string, (v: CostOutcomeExport) => void][] = [
  [
    "money",
    (v) => {
      v.report.financialEvidence.accounts[0]!.cash = "0";
    },
  ],
  [
    "omission",
    (v) => {
      v.records.pop();
    },
  ],
  [
    "duplicate",
    (v) => {
      v.records.push(structuredClone(v.records[0]!));
    },
  ],
  [
    "receipt",
    (v) => {
      v.records[0]!.receipt.stateHash = "0".repeat(64);
    },
  ],
  [
    "version",
    (v) => {
      Object.assign(v, { kind: "FUTURE" });
    },
  ],
  [
    "policy",
    (v) => {
      v.policyHash = "0".repeat(64);
    },
  ],
  [
    "verified",
    (v) => {
      Object.assign(v, { verified: true });
    },
  ],
  [
    "allow training",
    (v) => {
      Object.assign(v, { learningAllowed: true });
    },
  ],
  [
    "features and operations",
    (v) => {
      Object.assign(v, { features: {}, operatingCosts: 0 });
    },
  ],
];
for (const [label, mutate] of mutations)
  test(`D4-A05/A06/A07 ${label} cannot bypass D2 even with recomputed pin`, () => {
    const { value, anchor } = closed();
    mutate(value);
    const { exportHash, ...body } = value;
    assert.equal(typeof exportHash, "string");
    value.exportHash = hash(body);
    rejectSame(encode(value), { ...anchor, exportHash: value.exportHash });
  });

test("D4-A06 bad anchor, config and bounded JSON failures propagate without a partial report", () => {
  const { text, anchor } = closed();
  rejectSame(text, { ...anchor, exportHash: "" });
  rejectSame(text, { ...anchor, exportHash: "0".repeat(64) });
  const config = structuredClone(anchor.config);
  config.runId = "different-run";
  rejectSame(text, { ...anchor, config });
  rejectSame("{", anchor);
  rejectSame(" ".repeat(MAX_COST_EXPORT_BYTES + 1), anchor);
  rejectSame("[".repeat(66) + "0" + "]".repeat(66), anchor);
  rejectSame("[" + "0,".repeat(500000) + "0]", anchor);
});

test("D4-A07 forged verified object is not an accepted input type", () => {
  const { text, anchor } = closed();
  const checked = verifyCostOutcomeExport(text, anchor);
  rejectSame(encode(checked), anchor);
  // Deliberately bypass TypeScript to exercise the real untrusted JS boundary.
  assert.throws(
    () =>
      Reflect.apply(assessCostLearningReadiness, undefined, [checked, anchor]),
    /COST_EXPORT_SIZE_LIMIT/,
  );
});

test("D4-A05/A08/A10 deterministic, detached copies do not mutate input, DB or lease", () => {
  const o = openedOutcome();
  try {
    o.store.reserve(
      "release-reserve",
      o.store.prepare(proposal(o.store, "RELEASED")),
    );
    o.store.release("release", "r-RELEASED", o.store.read());
    const run = beginTrade(o.store);
    fillTrade(o.store, run);
    const { text, anchor, value } = capture(o);
    const before = {
      tables: dumpHandoff(o.repo),
      writer: o.repo.db.prepare("SELECT * FROM writer").all(),
      input: encode(anchor),
    };
    o.repo.db.exec("PRAGMA query_only=ON");
    const first = assessCostLearningReadiness(text, anchor);
    const second = assessCostLearningReadiness(text, anchor);
    assert.deepEqual(first, second);
    contract(first, value);
    first.records[0]!.checks[1]!.reasons.push("changed");
    first.records[0]!.reasons.push("changed");
    first.financialReport.financialEvidence.accounts[0]!.cash = "0";
    assert.deepEqual(first.checks, expectedChecks);
    assert.deepEqual(first.records[1]!.checks, expectedChecks);
    assert.deepEqual(
      first.financialReport.learningEvidence.records[0],
      second.financialReport.learningEvidence.records[0],
    );
    assert.deepEqual(assessCostLearningReadiness(text, anchor), second);
    assert.deepEqual(
      {
        tables: dumpHandoff(o.repo),
        writer: o.repo.db.prepare("SELECT * FROM writer").all(),
        input: encode(anchor),
      },
      before,
    );
  } finally {
    o.repo.db.exec("PRAGMA query_only=OFF");
    o.repo.close();
  }
});

test("D4-A08 after money DB closes assessment creates no files or writes", () => {
  const base = fresh(),
    path = join(base, "source.sqlite");
  const o = openedOutcome(outcomeConfig(), path);
  let text: string, anchor: CostExportAnchor;
  try {
    beginTrade(o.store);
    ({ text, anchor } = capture(o));
  } finally {
    o.repo.close();
  }
  writeFileSync(join(base, "input.json"), text);
  const snapshot = () =>
    Object.fromEntries(
      readdirSync(base)
        .sort()
        .map((p) => [p, readFileSync(join(base, p)).toString("base64")]),
    );
  const before = snapshot();
  assessCostLearningReadiness(
    readFileSync(join(base, "input.json"), "utf8"),
    anchor,
  );
  assert.deepEqual(snapshot(), before);
});

test("D4-A09 legacy learning/registry/evaluation reject before fitting or registration", () => {
  const { report } = closed();
  assert.throws(() => parseLearningInput(report), /LEARNING_INPUT_INVALID/);
  assert.throws(() => evaluateLearning(report), /LEARNING_INPUT_INVALID/);
  assert.throws(() => verifyPaperExport(report));
  assert.throws(() => derivePaperRows(report, "KR", "B"));
  const registry = new LearningRegistry(fresh());
  try {
    const before = readFileSync(registry.path);
    assert.throws(() => registry.register(report), /LEARNING_INPUT_INVALID/);
    assert.deepEqual(readFileSync(registry.path), before);
  } finally {
    registry.close();
  }
});
