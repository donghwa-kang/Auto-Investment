import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, policyHash } from "../src/core/policy.js";
import { d, sum } from "../src/core/math.js";
import { verifyPaperExport } from "../src/core/paper-learning-verify.js";
import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { buildCostOutcomeReport } from "../src/core/cost-outcome-report.js";
import type { CostOutcomeReport } from "../src/core/cost-outcome-report.js";
import {
  reservationConfig,
  proposal,
  observation,
} from "./cost-reservation-helpers.js";
import { handoffConfig, dumpHandoff } from "./cost-handoff-helpers.js";
import {
  openedOutcome,
  outcomeConfig,
  beginTrade,
  fillTrade,
  closeTrade,
  sellOrder,
  cancelOrder,
  execute,
  fillEvent,
  journal,
} from "./cost-outcome-helpers.js";

const fresh = () =>
  join(mkdtempSync(join(tmpdir(), "cost-report-")), "test.sqlite");
const summary = (r: CostOutcomeReport, currency = "KRW") =>
  r.report.currencies.find((a) => a.currency === currency)!;
const account = (r: CostOutcomeReport, currency = "KRW") =>
  r.financialEvidence.accounts.find((a) => a.currency === currency)!;
const dump = (repo: Repository) => ({
  tables: dumpHandoff(repo),
  writer: repo.db.prepare("SELECT * FROM writer").all(),
});
function basis(r: CostOutcomeReport) {
  assert.equal(
    r.financialBasisHash,
    hash({ source: r.source, financialEvidence: r.financialEvidence }),
  );
  assert.equal(r.report.financialBasisHash, r.financialBasisHash);
  assert.equal(r.learningEvidence.financialBasisHash, r.financialBasisHash);
  const { reportHash, ...body } = r;
  assert.equal(reportHash, hash(body));
  assert.equal(r.orderSubmissionAllowed, false);
  assert.equal(r.learningAllowed, false);
  assert.equal(r.liveEnabled, false);
  assert.equal(r.learningEvidence.status, "HOLD");
  for (const row of r.learningEvidence.records) {
    assert.equal(row.financialBasisHash, r.financialBasisHash);
    assert.equal(row.trainingLabel, null);
    assert.equal(row.status, "HOLD");
    assert.ok(row.reasons.includes("OPERATING_COST_ALLOCATION_UNSUPPORTED"));
    assert.ok(row.reasons.includes("V3_TRAINING_CONTRACT_NOT_INTEGRATED"));
    const trade = r.financialEvidence.trades.find((t) => t.runId === row.runId);
    assert.deepEqual(row.components, trade?.components ?? null);
    assert.equal(row.tradingFees, trade?.tradingFees ?? null);
    assert.equal(row.tradingNetPnlNative, trade?.outcome?.netPnlNative ?? null);
    assert.equal(row.tradingNetPnlKrw, trade?.outcome?.netPnlKrw ?? null);
  }
}

test("COR-01 empty snapshot is not evidence of profitable trades or zero actual operating costs", () => {
  const { repo, store, c } = openedOutcome();
  try {
    const r = store.report();
    basis(r);
    assert.equal(r.source.stateHash, hash(store.read()));
    assert.equal(r.source.configHash, hash(c));
    assert.equal(r.source.policyHash, policyHash);
    assert.equal(r.source.asOf, c.seed.clock);
    assert.equal(summary(r).closedCount, 0);
    assert.equal(summary(r).closedTradingNetPnlNative, "0");
    assert.equal(summary(r).netPnlAfterOperatingCosts, null);
    assert.deepEqual(r.financialEvidence.operatingCosts, {
      fixture: "EXPLICIT_ZERO_FIXTURE",
      actualCosts: "UNVERIFIED",
      allocation: "UNSUPPORTED",
    });
    assert.equal(r.learningEvidence.records.length, 0);
  } finally {
    repo.close();
  }
});

test("COR-02 reserved and released approvals stay visible with no fabricated fill/PnL", () => {
  const { repo, store } = openedOutcome();
  try {
    store.reserve("reserve", store.prepare(proposal(store)));
    const before = store.report();
    basis(before);
    assert.equal(before.financialEvidence.trades.length, 0);
    assert.equal(before.learningEvidence.records[0]!.tradingFees, null);
    assert.ok(d(account(before).reservedCash).gt(0));
    store.release("release", "r-FIRST", store.read());
    const after = store.report();
    basis(after);
    assert.equal(
      after.financialEvidence.approvals[0]!.status,
      "RELEASED_LOCAL",
    );
    assert.ok(
      after.learningEvidence.records[0]!.reasons.includes("RELEASED_LOCAL"),
    );
    assert.equal(after.learningEvidence.records[0]!.tradingNetPnlNative, null);
    assert.equal(account(after).reservedCash, "0");
    assert.notEqual(after.financialBasisHash, before.financialBasisHash);
  } finally {
    repo.close();
  }
});

for (const market of ["KR", "US"] as const)
  for (const unit of ["ORDER", "FILL"] as const)
    test(`COR-03 ${market}/${unit} same-time partial fills retain IDs and itemized deltas`, () => {
      const { repo, store } = openedOutcome(outcomeConfig(market));
      try {
        const run = beginTrade(store, "FIRST", 2, "CONFIRMED", (p) => {
          for (const rule of p.rules) {
            rule.unit = unit;
            if (rule.component !== "COMMISSION")
              rule.fixed = market === "KR" ? "1" : "0.01";
          }
        });
        const at = store.read().seed.clock + 1;
        fillTrade(store, run, "entry", 1, undefined, at);
        fillTrade(store, run, "entry", 1, undefined, at);
        const open = store.report();
        basis(open);
        assert.equal(
          summary(open, market === "KR" ? "KRW" : "USD").incompleteCount,
          1,
        );
        assert.equal(
          open.learningEvidence.records[0]!.tradingNetPnlNative,
          null,
        );
        closeTrade(store, run, market === "KR" ? "10100" : "40.3");
        const r = store.report(),
          t = r.financialEvidence.trades[0]!;
        basis(r);
        assert.deepEqual(t.postings, journal(store.read(), run).postings);
        assert.equal(t.postings[0]!.fill.at, t.postings[1]!.fill.at);
        assert.equal(
          t.postings[0]!.fill.occurredAt,
          t.postings[1]!.fill.occurredAt,
        );
        assert.notEqual(t.postings[0]!.fill.fillId, t.postings[1]!.fill.fillId);
        assert.ok(t.postings[0]!.eventSeq < t.postings[1]!.eventSeq);
        const multiplier = unit === "ORDER" ? 2 : 3;
        assert.equal(
          t.components.COMMISSION,
          d(market === "KR" ? "10" : "0.01")
            .mul(multiplier)
            .toString(),
        );
        assert.equal(
          t.components.TAX,
          d(market === "KR" ? "1" : "0.01")
            .mul(multiplier)
            .toString(),
        );
        assert.equal(t.components.EXCHANGE, t.components.TAX);
        assert.equal(
          t.tradingFees,
          sum(Object.values(t.components)).toString(),
        );
        assert.equal(
          t.outcome!.netPnlNative,
          d(t.sellValue).minus(t.buyValue).minus(t.tradingFees).toString(),
        );
        if (unit === "ORDER") assert.equal(t.postings[1]!.feeDelta, "0");
      } finally {
        repo.close();
      }
    });

test("COR-04 mixed closed/open runs count initial money once and separate all-fill from closed fees", () => {
  const { repo, store, c } = openedOutcome();
  try {
    const first = beginTrade(store, "FIRST"),
      second = beginTrade(store, "SECOND");
    fillTrade(store, first);
    fillTrade(store, second);
    closeTrade(store, first, "10100");
    const r = store.report(),
      a = account(r),
      v = summary(r);
    basis(r);
    assert.equal(a.cash, c.seed.ledger.wallets.KRW.cash);
    assert.equal(a.payable, "20020");
    assert.equal(a.receivable, "10090");
    assert.equal(a.availableCash, d(a.cash).minus(20020).toString());
    assert.equal(a.economicCash, d(a.cash).minus(20020).plus(10090).toString());
    assert.equal(v.allFillFees, "30");
    assert.equal(v.closedTradingFees, "20");
    assert.equal(v.closedTradingNetPnlNative, "80");
    assert.equal(v.closedCount, 1);
    assert.equal(v.incompleteCount, 1);
    assert.equal(r.learningEvidence.records.length, 2);
  } finally {
    repo.close();
  }
});

test("COR-05 unknown/no-fill cancelled orders are not zero-profit completed trades", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store, "FIRST", 1, "UNKNOWN");
    let r = store.report();
    basis(r);
    assert.equal(r.financialEvidence.trades[0]!.orders[0]!.status, "UNKNOWN");
    assert.equal(summary(r).noFillCount, 1);
    cancelOrder(store, run);
    r = store.report();
    basis(r);
    assert.equal(r.financialEvidence.trades[0]!.orders[0]!.status, "CANCELLED");
    assert.equal(summary(r).closedCount, 0);
    assert.equal(r.learningEvidence.records[0]!.tradingNetPnlNative, null);
  } finally {
    repo.close();
  }
});

for (const market of ["KR", "US"] as const)
  test(`COR-06 ${market} settlement changes spendable cash but not outcome or counted fees`, () => {
    const { repo, store } = openedOutcome(outcomeConfig(market));
    try {
      const run = beginTrade(store);
      fillTrade(store, run);
      closeTrade(store, run, market === "KR" ? "10100" : "40.3");
      const before = store.report(),
        currency = market === "KR" ? "KRW" : "USD";
      execute(store, run, {
        kind: "SETTLE",
        id: "settle",
        fillIds: journal(store.read(), run).postings.map((p) => p.fill.fillId),
      });
      const after = store.report();
      basis(after);
      assert.deepEqual(
        after.financialEvidence.trades[0]!.outcome,
        before.financialEvidence.trades[0]!.outcome,
      );
      assert.equal(
        account(after, currency).cash,
        account(before, currency).economicCash,
      );
      assert.equal(account(after, currency).receivable, "0");
      assert.equal(account(after, currency).payable, "0");
      assert.equal(
        summary(after, currency).allFillFees,
        summary(before, currency).allFillFees,
      );
      assert.equal(
        summary(after, currency).closedTradingNetPnlNative,
        summary(before, currency).closedTradingNetPnlNative,
      );
      assert.equal(summary(after, currency).unsettledFillCount, 0);
      assert.notEqual(after.financialBasisHash, before.financialBasisHash);
    } finally {
      repo.close();
    }
  });

test("COR-07 pending FX is not zero; later known close contributes only an explicitly partial subtotal", () => {
  const { repo, store } = openedOutcome(outcomeConfig("US"));
  try {
    const early = beginTrade(store, "EARLY"),
      late = beginTrade(store, "LATE");
    fillTrade(store, early);
    fillTrade(store, late);
    sellOrder(store, early, "40.3");
    fillTrade(
      store,
      early,
      "exit",
      1,
      "40.3",
      store.read().seed.ledger.fxAt + 60001,
    );
    let s = store.read();
    store.observe("fresh", observation(s), s);
    closeTrade(store, late, "40.3");
    const r = store.report(),
      v = summary(r, "USD");
    basis(r);
    assert.equal(v.closedTradingNetPnlNative, "0.56");
    assert.equal(v.closedNetPnlKrw, null);
    assert.equal(v.closedNetPnlKrwKnownSubtotal, "364");
    assert.equal(v.knownKrwCount, 1);
    assert.equal(v.pendingKrwCount, 1);
    assert.equal(r.learningEvidence.records[0]!.tradingNetPnlKrw, null);
    assert.ok(
      r.learningEvidence.records[0]!.reasons.includes(
        "CLOSE_FX_RECONCILIATION_REQUIRED",
      ),
    );
    assert.ok(
      r.learningEvidence.records[1]!.reasons.includes(
        "CLOSE_SEQUENCE_RECONCILIATION_REQUIRED",
      ),
    );
    const old = r.financialEvidence.trades.map((t) => t.outcome);
    s = store.read();
    const obs = observation(s);
    obs.fx = "1500";
    store.observe("later", obs, s);
    assert.deepEqual(
      store.report().financialEvidence.trades.map((t) => t.outcome),
      old,
    );
  } finally {
    repo.close();
  }
});

test("COR-08 original loss halt stays visible; report does not require reapproval", () => {
  const c = outcomeConfig();
  c.seed.ledger.lossStreak = 1;
  c.book.seedHash = hash(c.seed);
  const { repo, store } = openedOutcome(c);
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    closeTrade(store, run, "10000");
    const r = store.report();
    basis(r);
    assert.equal(summary(r).closedTradingNetPnlNative, "-20");
    assert.ok(r.financialEvidence.riskHalts.includes("CONSECUTIVE_LOSSES"));
    assert.ok(
      r.learningEvidence.records[0]!.reasons.includes("CONSECUTIVE_LOSSES"),
    );
  } finally {
    repo.close();
  }
});

test("COR-09 duplicates retain financial report; report itself performs no writes or lease renewal", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store),
      s = store.read(),
      e = fillEvent(s, run);
    store.execute(e.id, run, e, s);
    const r = store.report(),
      before = dump(repo);
    store.execute(e.id, run, e, s);
    store.execute(
      "redelivery",
      run,
      { ...e, id: "redelivery", seq: e.seq + 1, at: e.at + 1 },
      store.read(),
    );
    assert.deepEqual(store.report(), r);
    assert.deepEqual(dump(repo), before);
    repo.db.exec("PRAGMA query_only=ON");
    assert.deepEqual(store.report(), r);
    assert.deepEqual(dump(repo), before);
    r.financialEvidence.trades[0]!.postings[0]!.feeDelta = "999";
    r.financialEvidence.approvals.length = 0;
    r.learningEvidence.records[0]!.reasons.length = 0;
    assert.notDeepEqual(store.report(), r);
    assert.deepEqual(dump(repo), before);
  } finally {
    repo.db.exec("PRAGMA query_only=OFF");
    repo.close();
  }
});

test("COR-17 SELL cost exceeding proceeds is payable, not negative receivable or a second PnL deduction", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    closeTrade(store, run, "1");
    const r = store.report(),
      a = account(r);
    basis(r);
    assert.equal(a.receivable, "0");
    assert.equal(a.payable, "10019");
    assert.equal(a.tradingFees, "20");
    assert.equal(summary(r).closedTradingNetPnlNative, "-10019");
    assert.equal(r.financialEvidence.trades[0]!.postings[1]!.payable, "9");
    assert.equal(a.economicCash, d(a.cash).minus(10019).toString());
  } finally {
    repo.close();
  }
});

test("COR-18 partial BUY cancellation and partial SELL replacement retain every fee and order lineage", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store, "FIRST", 3);
    fillTrade(store, run);
    fillTrade(store, run);
    cancelOrder(store, run);
    sellOrder(store, run, "10100");
    fillTrade(store, run, "exit");
    cancelOrder(store, run, "exit");
    sellOrder(store, run, "10100", "replacement", "exit");
    fillTrade(store, run, "replacement");
    const r = store.report(),
      t = r.financialEvidence.trades[0]!;
    basis(r);
    assert.equal(t.phase, "CLOSED");
    assert.equal(t.postings.length, 4);
    assert.equal(t.orders.length, 3);
    assert.equal(t.orders[2]!.replaces, "exit");
    assert.deepEqual(t.components, {
      COMMISSION: "30",
      TAX: "0",
      EXCHANGE: "0",
    });
    assert.equal(t.outcome!.netPnlNative, "170");
    assert.equal(summary(r).closedTradingFees, "30");
  } finally {
    repo.close();
  }
});

test("COR-19 unresolved partial BUY blocks SELL and keeps incomplete facts until exact cancellation", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store, "FIRST", 2, "UNKNOWN");
    fillTrade(store, run);
    const before = dump(repo);
    assert.throws(
      () => closeTrade(store, run, "10100"),
      /UNRESOLVED_ORDER_NO_NEW_ORDER/,
    );
    assert.deepEqual(dump(repo), before);
    const r = store.report(),
      t = r.financialEvidence.trades[0]!;
    basis(r);
    assert.equal(t.quantity, 1);
    assert.equal(t.phase, "INCOMPLETE_TRADE");
    assert.equal(t.orders[0]!.status, "UNKNOWN");
    assert.equal(t.outcome, null);
    assert.equal(summary(r).closedCount, 0);
    assert.equal(summary(r).allFillFees, "10");
    assert.equal(r.learningEvidence.records[0]!.tradingNetPnlNative, null);
    cancelOrder(store, run);
    closeTrade(store, run, "10100");
    assert.equal(summary(store.report()).closedTradingNetPnlNative, "80");
  } finally {
    repo.close();
  }
});

test("COR-10 file reopening without acquire reports recorded epoch, not local owner epoch", () => {
  const path = fresh(),
    { repo, store, c } = openedOutcome(outcomeConfig(), path);
  const run = beginTrade(store);
  fillTrade(store, run);
  closeTrade(store, run, "10100");
  const expected = store.report(),
    tables = dumpHandoff(repo);
  repo.close();
  const reader = new Repository(path, () => 1000);
  try {
    const before = dump(reader);
    reader.db.exec("PRAGMA query_only=ON");
    const other = new CostReservationStore(reader, c);
    assert.equal(reader.epoch, 0);
    assert.equal(expected.source.epoch, 1);
    assert.deepEqual(other.report(), expected);
    assert.deepEqual(dumpHandoff(reader), tables);
    assert.deepEqual(dump(reader), before);
  } finally {
    reader.db.exec("PRAGMA query_only=OFF");
    reader.close();
  }
});

test("COR-11 reader sees whole previous commit at every writer failpoint and whole new commit afterwards", () => {
  const path = fresh(),
    { repo, store, c } = openedOutcome(outcomeConfig(), path);
  const run = beginTrade(store);
  fillTrade(store, run);
  sellOrder(store, run, "10100");
  const reader = new Repository(path, () => 1000);
  try {
    reader.db.exec("PRAGMA query_only=ON");
    const view = new CostReservationStore(reader, c),
      before = view.report(),
      seen: string[] = [];
    const writer = new CostReservationStore(repo, c, {
      testStage(stage) {
        assert.deepEqual(view.report(), before);
        seen.push(stage);
      },
    });
    fillTrade(writer, run, "exit", 1, "10100");
    assert.deepEqual(seen, [
      "COMMAND",
      "APPROVALS",
      "FILL_INDEX",
      "STATE",
      "AUDIT",
    ]);
    assert.equal(summary(view.report()).closedTradingNetPnlNative, "80");
    assert.deepEqual(view.report(), writer.report());
  } finally {
    reader.db.exec("PRAGMA query_only=OFF");
    reader.close();
    repo.close();
  }
});

for (const [name, sql, expected] of [
  [
    "state",
    "UPDATE cost_reservation_run SET body='{}'",
    /LOCAL_STATE_REPLAY_MISMATCH/,
  ],
  [
    "config",
    "UPDATE cost_reservation_run SET config_hash='bad'",
    /LOCAL_RESERVATION_CONFIG_MISMATCH/,
  ],
  [
    "command",
    "UPDATE cost_reservation_commands SET input_hash='bad' WHERE seq=1",
    /LOCAL_COMMAND_REPLAY_MISMATCH/,
  ],
  [
    "receipt",
    "UPDATE cost_reservation_commands SET receipt_hash='bad' WHERE seq=1",
    /LOCAL_RECEIPT_MISMATCH/,
  ],
  [
    "approval",
    "UPDATE cost_reservation_approvals SET checksum='bad'",
    /LOCAL_APPROVAL_REPLAY_MISMATCH/,
  ],
  [
    "fill index",
    "DELETE FROM cost_reservation_fills",
    /HANDOFF_FILL_INDEX_REPLAY_MISMATCH/,
  ],
  ["audit", "UPDATE audit SET checksum='bad' WHERE seq=1", /AUDIT/],
] as const)
  test(`COR-12 tampered ${name} is rejected without report or attempted repair`, () => {
    const { repo, store } = openedOutcome();
    try {
      const run = beginTrade(store);
      fillTrade(store, run);
      closeTrade(store, run, "10100");
      repo.db.exec(sql);
      const before = dump(repo);
      assert.throws(() => store.report(), expected);
      assert.deepEqual(dump(repo), before);
    } finally {
      repo.close();
    }
  });

test("COR-13 rehashed forged closed PnL is still rejected by command replay", () => {
  const { repo, store } = openedOutcome();
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    closeTrade(store, run, "10100");
    const s = store.read();
    s.outcomes![0]!.netPnlNative = "999999";
    repo.db
      .prepare("UPDATE cost_reservation_run SET body=?, checksum=?")
      .run(JSON.stringify(s), hash(s));
    assert.throws(() => store.report(), /LOCAL_STATE_REPLAY_MISMATCH/);
  } finally {
    repo.close();
  }
});

for (const c of [reservationConfig(), handoffConfig()])
  test(`COR-14 ${c.kind} is not silently migrated`, () => {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    try {
      const store = new CostReservationStore(repo, c, { initialize: true });
      const before = store.read(),
        audit = repo.verifyAudit();
      assert.throws(() => store.report(), /COST_REPORT_REQUIRES_OUTCOME_V3/);
      assert.deepEqual(store.read(), before);
      assert.equal(repo.verifyAudit(), audit);
      store.reserve("reserve", store.prepare(proposal(store)));
      assert.equal(store.read().approvals.length, 1);
    } finally {
      repo.close();
    }
  });

test("COR-15 report and HOLD evidence cannot be imported as legacy paper learning", () => {
  const { repo, store } = openedOutcome();
  try {
    const r = store.report();
    assert.throws(() => verifyPaperExport(r), /PAPER_LEARNING_EXPORT_INVALID/);
    assert.throws(
      () => verifyPaperExport(r.learningEvidence),
      /PAPER_LEARNING_EXPORT_INVALID/,
    );
  } finally {
    repo.close();
  }
});

test("COR-16 internal projection preserves input; identical amounts with different profile evidence get different bases", () => {
  const { repo, store, c } = openedOutcome();
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    closeTrade(store, run, "10100");
    const s = store.read(),
      before = structuredClone(s);
    assert.deepEqual(buildCostOutcomeReport(s, hash(c)), store.report());
    assert.deepEqual(s, before);
    const other = openedOutcome();
    try {
      const run2 = beginTrade(other.store, "FIRST", 1, "CONFIRMED", (p) => {
        p.version = 2;
      });
      fillTrade(other.store, run2);
      closeTrade(other.store, run2, "10100");
      const r = store.report(),
        r2 = other.store.report();
      assert.equal(
        summary(r).closedTradingNetPnlNative,
        summary(r2).closedTradingNetPnlNative,
      );
      assert.notEqual(r.financialBasisHash, r2.financialBasisHash);
    } finally {
      other.repo.close();
    }
  } finally {
    repo.close();
  }
});
