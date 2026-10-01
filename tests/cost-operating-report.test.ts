import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hash } from "../src/core/policy.js";
import { Decimal } from "../src/core/math.js";
import {
  verifyOperatingEvidence,
  MAX_OPERATING_EVIDENCE_BYTES,
  buildOperatingEvidence,
} from "../src/core/cost-operating-evidence.js";
import type { OperatingEvidence } from "../src/core/cost-operating-evidence.js";
import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { makeCostWebProgram } from "../src/server/cost-web-fixture.js";
import { openedOperating, op, record } from "./cost-operating-helpers.js";
import {
  closedFixture,
  finalizationConfig,
  closeRequest,
} from "./cost-finalization-helpers.js";
import {
  closedPostClose,
  paymentCommand,
  postCloseConfig,
  finishPostClose,
} from "./cost-post-close-helpers.js";
import {
  closedPartial,
  partialCommand,
  partialConfig,
  tradePartialConfig,
} from "./cost-partial-settlement-helpers.js";
import {
  beginTrade,
  fillTrade,
  closeTrade,
  openedOutcome,
  fillEvent,
} from "./cost-outcome-helpers.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";
import type { OperatingConfig } from "../src/core/cost-operating.js";

const dump = (repo: Repository) =>
  hash({
    data: dumpHandoff(repo),
    writer: repo.db.prepare("SELECT * FROM writer").all(),
  });
const verify = (v: OperatingEvidence, c = v.config) =>
  verifyOperatingEvidence(JSON.stringify(v), {
    config: c,
    exportHash: v.exportHash,
  });
let cachedProgram: ReturnType<typeof makeCostWebProgram> | undefined;
const webProgram = () => (cachedProgram ??= makeCostWebProgram());
const repin = (v: OperatingEvidence) => {
  const { exportHash, ...body } = v;
  void exportHash;
  v.exportHash = hash(body);
  return v;
};
const flags = (v: {
  orderSubmissionAllowed: boolean;
  learningAllowed: boolean;
  liveEnabled: boolean;
  newSpendingAllowed: boolean;
  automaticResumeAllowed: boolean;
}) =>
  assert.deepEqual(
    [
      v.orderSubmissionAllowed,
      v.learningAllowed,
      v.liveEnabled,
      v.newSpendingAllowed,
      v.automaticResumeAllowed,
    ],
    [false, false, false, false, false],
  );

test("OR-01 query-only one-snapshot report/export are detached and preserve DB/lease", () => {
  const f = openedOperating();
  try {
    const before = dump(f.repo);
    f.repo.db.exec("PRAGMA query_only=ON");
    const report = f.store.operatingReport(),
      v = f.store.exportOperatingEvidence();
    assert.deepEqual(v.report, report);
    assert.deepEqual(verify(v).report, report);
    flags(report);
    flags(v);
    assert.equal(report.financialEvidence.finalization.periodNetPnlKrw, null);
    assert.equal(
      report.financialEvidence.currentAccounts[0]!.netAssetValue,
      null,
    );
    report.financialEvidence.currentAccounts[0]!.cash = "0";
    assert.equal(dump(f.repo), before);
    assert.notEqual(
      f.store.operatingReport().financialEvidence.currentAccounts[0]!.cash,
      "0",
    );
  } finally {
    f.repo.db.exec("PRAGMA query_only=OFF");
    f.repo.close();
  }
});

test("OR-02 reservation recognition payment conserve available cash without double debit", () => {
  const f = openedOperating();
  try {
    const start = BigInt(f.store.read().handoff!.accounts.KRW.cash);
    record(f.store, op(f.store.read(), "RESERVE", "expense-budget"));
    let r = f.store.operatingReport().financialEvidence;
    assert.equal(r.currentAccounts[0]!.reservedCash, "50");
    assert.equal(r.currentAccounts[0]!.availableCash, String(start - 50n));
    record(
      f.store,
      op(f.store.read(), "RECOGNIZE", "incur", "50", "debt", "expense-budget"),
    );
    r = f.store.operatingReport().financialEvidence;
    assert.equal(r.currentAccounts[0]!.reservedCash, "0");
    assert.equal(r.currentAccounts[0]!.economicCash, String(start - 50n));
    record(f.store, op(f.store.read(), "PAY", "pay"));
    r = f.store.operatingReport().financialEvidence;
    assert.equal(r.currentAccounts[0]!.cash, String(start - 50n));
    assert.equal(r.currentAccounts[0]!.economicCash, String(start - 50n));
    assert.equal(r.operating.current.paidKrw, "50");
    assert.equal(r.operating.current.payableKrw, "0");
    verify(f.store.exportOperatingEvidence());
  } finally {
    f.repo.close();
  }
});

test("OR-02 open position / UNKNOWN remain incomplete and never become NAV or final PnL", () => {
  for (const ack of ["CONFIRMED", "UNKNOWN"] as const) {
    const f = openedOperating();
    try {
      const run = beginTrade(f.store, "FIRST", 1, ack);
      if (ack === "CONFIRMED") fillTrade(f.store, run);
      const r = f.store.operatingReport();
      assert.equal(r.financialEvidence.trades[0]!.finalNetPnlKrw, null);
      assert.equal(r.financialEvidence.currentAccounts[0]!.netAssetValue, null);
      assert.equal(r.diagnostics.allocationPending, true);
      if (ack === "CONFIRMED")
        assert.equal(r.financialEvidence.trades[0]!.quantity, 1);
      else
        assert.ok(
          r.financialEvidence.trades[0]!.orders.some(
            (o) => o.status === "UNKNOWN",
          ),
        );
      verify(f.store.exportOperatingEvidence());
    } finally {
      f.repo.close();
    }
  }
});

test("OR-03 D7 preview is not D8 final; 22 gross - 20 fees - 3 operating = -1", () => {
  const f = openedOperating(finalizationConfig());
  try {
    closedFixture(f);
    const request = closeRequest(f);
    assert.equal(f.store.operatingClose(request).periodNetPnlKrw, "-1");
    assert.equal(
      f.store.operatingReport().financialEvidence.trades[0]!.tradingNetPnlKrw,
      "2",
    );
    assert.equal(
      f.store.operatingReport().financialEvidence.finalization.checkpoint,
      null,
    );
    finishPostClose(f);
    const before = f.store.operatingReport();
    assert.equal(before.financialEvidence.trades[0]!.finalNetPnlKrw, "-1");
    assert.equal(before.financialEvidence.lossStreak, 1);
    f.store.postCloseInput(
      "raw",
      '{"lateUnknown":1}',
      f.store.read().seed.clock + 1,
      f.store.read(),
    );
    const after = f.store.operatingReport();
    assert.equal(after.financialEvidence.finalization.status, "RECONCILING");
    assert.equal(
      after.financialEvidence.finalization.checkpointHash,
      before.financialEvidence.finalization.checkpointHash,
    );
    assert.equal(after.financialEvidence.finalization.rejectedInputs.length, 1);
    assert.equal(after.financialEvidence.lossStreak, 1);
    verify(f.store.exportOperatingEvidence());
  } finally {
    f.repo.close();
  }
});

for (const amount of ["0", "50"])
  test(`OR-03 N=0 O=${amount} never invents a completed trade`, () => {
    const f = closedPostClose(":memory:", amount);
    try {
      const r = f.store.operatingReport().financialEvidence;
      assert.equal(r.trades.length, 0);
      assert.deepEqual(r.finalization.allocations, []);
      assert.equal(r.finalization.unallocatedKrw, amount);
      assert.equal(r.finalization.periodNetPnlKrw, String(-BigInt(amount)));
      verify(f.store.exportOperatingEvidence());
    } finally {
      f.repo.close();
    }
  });

test("OR-03 D9 current payment diverges from immutable historical costs", () => {
  const f = closedPostClose();
  try {
    const before = f.store.operatingReport(),
      s = f.store.read(),
      cmd = paymentCommand(s);
    f.store.settlePostClose("pay", cmd, s);
    const after = f.store.operatingReport();
    assert.equal(after.financialEvidence.operating.current.payableKrw, "0");
    assert.equal(
      after.financialEvidence.operating.preCloseEffects.payableKrw,
      "50",
    );
    assert.equal(after.followup.report!.unresolvedCount, 0);
    assert.equal(
      after.financialEvidence.finalization.checkpointHash,
      before.financialEvidence.finalization.checkpointHash,
    );
    assert.equal(
      after.financialEvidence.currentAccounts[0]!.economicCash,
      before.financialEvidence.currentAccounts[0]!.economicCash,
    );
    const v = f.store.exportOperatingEvidence();
    verify(v);
    f.store.settlePostClose("retry", cmd, f.store.read());
    assert.deepEqual(f.store.exportOperatingEvidence(), v);
  } finally {
    f.repo.close();
  }
});

test("OR-03 D10 20+30 and observation end preserve pending / final PnL", () => {
  const f = closedPartial();
  try {
    const s = f.store.read();
    f.store.settlePartial("part", partialCommand(s), s);
    const r = f.store.operatingReport(
      f.c.partialSettlement.followupEndExclusive,
    );
    assert.equal(r.followup.report!.observationEnded, true);
    assert.equal(r.followup.report!.unresolvedCount, 1);
    assert.equal(r.financialEvidence.operating.current.paidKrw, "20");
    assert.equal(r.financialEvidence.operating.current.payableKrw, "30");
    assert.equal(r.financialEvidence.finalization.periodNetPnlKrw, "-50");
    const v = f.store.exportOperatingEvidence(r.asOf);
    assert.deepEqual(verify(v).report, r);
    const latest = f.store.read();
    f.store.settlePartial("rest", partialCommand(latest, 1), latest);
    assert.equal(f.store.operatingReport().followup.report!.unresolvedCount, 0);
    verify(f.store.exportOperatingEvidence());
  } finally {
    f.repo.close();
  }
});

test("OR-04 D10 settled trade targets supersede historical unsettled posting flags", () => {
  const c = tradePartialConfig(),
    f = openedOperating(c);
  try {
    const run = beginTrade(f.store);
    fillTrade(f.store, run);
    closeTrade(f.store, run, "10022");
    finishPostClose(f);
    for (let i = 0; i < c.partialSettlement.evidence.length; i++) {
      const s = f.store.read();
      f.store.settlePartial(`part-${i}`, partialCommand(s, i), s);
    }
    const r = f.store.operatingReport();
    assert.ok(
      r.financialEvidence.trades[0]!.historicalPostings.some(
        (p) => p.settledAt === null,
      ),
    );
    assert.equal(r.followup.report!.unresolvedCount, 0);
    assert.equal(r.financialEvidence.currentAccounts[0]!.receivable, "0");
    assert.equal(r.financialEvidence.currentAccounts[0]!.payable, "0");
    verify(f.store.exportOperatingEvidence());
  } finally {
    f.repo.close();
  }
});

test("OR-04 S7 atomic ticks / pulse / retry replay without enabling close", () => {
  const program = webProgram(),
    adapter = program.operatingLoop(),
    c = adapter.config(),
    f = openedOperating(c);
  try {
    f.store.reserve("reserve", adapter.prepareEntry(f.store));
    f.store.handoff(
      "handoff",
      f.store.prepareHandoff(adapter.reservationId, "CONFIRMED"),
    );
    const at = f.store.read().seed.clock,
      tick = {
        kind: "COST_LOOP_TICK",
        purpose: "TEST_ONLY",
        instrument: "REPLAY-KR-B",
        at: at + 1000,
        quote: {
          at: at + 1000,
          bid: "21399",
          ask: "21400",
          bidSize: 1000,
          askSize: 1000,
          halted: false,
        },
      };
    const receipt = f.store.tick("tick", tick).receipt;
    record(f.store, op(f.store.read(), "RECOGNIZE", "cost"));
    f.store.pulse("pulse", {
      kind: "COST_LOOP_PULSE",
      purpose: "TEST_ONLY",
      instrument: "REPLAY-KR-B",
      at: at + 6000,
    });
    const v = f.store.exportOperatingEvidence();
    assert.equal(v.report.asOf, at + 6000);
    assert.ok(v.report.source.financialAt < v.report.asOf);
    assert.deepEqual(verify(v).report, v.report);
    assert.deepEqual(f.store.tick("tick", tick).receipt, receipt);
    assert.deepEqual(f.store.exportOperatingEvidence(), v);
    assert.equal(v.report.financialEvidence.finalization.checkpoint, null);
    assert.throws(() =>
      f.store.finalizeOperating(
        "close",
        "day",
        closeRequest(f),
        f.store.read(),
      ),
    );
  } finally {
    f.repo.close();
  }
});

test("OR-04 closed DB portable replay and query-only reopen preserve original evidence", () => {
  const path = join(
      mkdtempSync(join(tmpdir(), "operating-evidence-")),
      "case.sqlite",
    ),
    f = closedPartial(path);
  const v = f.store.exportOperatingEvidence(),
    c = f.c;
  f.repo.close();
  assert.deepEqual(verify(v, c).report, v.report);
  const repo = new Repository(path, () => 1000);
  try {
    repo.db.exec("PRAGMA query_only=ON");
    const store = new CostReservationStore(repo, c);
    assert.deepEqual(store.exportOperatingEvidence(), v);
  } finally {
    repo.db.exec("PRAGMA query_only=OFF");
    repo.close();
  }
});

test("OR-05 old pin, missing pin and wrong config fail closed", () => {
  const f = openedOperating();
  try {
    const v = f.store.exportOperatingEvidence();
    record(f.store, op(f.store.read(), "RECOGNIZE", "cost"));
    const later = f.store.exportOperatingEvidence();
    assert.throws(
      () =>
        verifyOperatingEvidence(JSON.stringify(v), {
          config: f.c,
          exportHash: later.exportHash,
        }),
      /HASH_MISMATCH/,
    );
    assert.throws(
      () =>
        verifyOperatingEvidence(JSON.stringify(v), {
          config: f.c,
          exportHash: "",
        }),
      /ANCHOR_REQUIRED/,
    );
    assert.throws(
      () => verify(v, { ...f.c, runId: "another" }),
      /CONFIG_MISMATCH/,
    );
  } finally {
    f.repo.close();
  }
});

const mutations: [string, (v: OperatingEvidence) => void][] = [
  [
    "missing",
    (v) => {
      v.records.pop();
    },
  ],
  [
    "duplicate ID",
    (v) => {
      v.records[1]!.id = v.records[0]!.id;
    },
  ],
  [
    "reordered",
    (v) => {
      v.records.reverse();
    },
  ],
  [
    "CAS",
    (v) => {
      v.records[0]!.input.expectedStateHash = "0".repeat(64);
    },
  ],
  [
    "epoch",
    (v) => {
      v.records[1]!.input.epoch = 0;
    },
  ],
  [
    "receipt",
    (v) => {
      v.records[0]!.receipt.stateHash = "0".repeat(64);
    },
  ],
  [
    "report",
    (v) => {
      v.report.financialEvidence.currentAccounts[0]!.cash = "1";
      v.report.reportHash = hash(v.report);
    },
  ],
  [
    "extra envelope",
    (v) => {
      Object.assign(v, { extra: true });
    },
  ],
  [
    "extra command",
    (v) => {
      Object.assign(v.records[0]!.input.command, { extra: true });
    },
  ],
  [
    "permission",
    (v) => {
      Object.assign(v, { learningAllowed: true });
    },
  ],
  [
    "asOf",
    (v) => {
      v.asOf = 0;
    },
  ],
];
for (const [name, mutate] of mutations)
  test(`OR-05 repinned ${name} still cannot bypass semantic/schema checks`, () => {
    const f = closedPostClose();
    try {
      const v = f.store.exportOperatingEvidence();
      mutate(v);
      repin(v);
      assert.throws(() => verify(v), /OPERATING_EVIDENCE_/);
    } finally {
      f.repo.close();
    }
  });

test("OR-05 appended duplicate fill with fresh CAS is not silently deduplicated", () => {
  const f = openedOperating();
  try {
    const run = beginTrade(f.store),
      s = f.store.read(),
      event = fillEvent(s, run);
    f.store.execute("fill", run, event, s);
    const v = f.store.exportOperatingEvidence(),
      last = structuredClone(v.records.at(-1)!);
    last.id = "duplicate";
    last.input.expectedRevision = v.report.source.revision;
    last.input.expectedStateHash = v.report.source.stateHash;
    v.records.push(last);
    repin(v);
    assert.throws(() => verify(v), /COMMAND_MISMATCH/);
  } finally {
    f.repo.close();
  }
});

test("OR-06 precise 40-place partial payment uses local exact arithmetic", () => {
  const tiny = "0." + "0".repeat(39) + "1",
    rest = "10009." + "9".repeat(40),
    original = tradePartialConfig(),
    c = partialConfig(
      original.partialSettlement.evidence.map((e, i) => ({
        target: e.target,
        receivable: e.receivable,
        payable: i === 0 ? tiny : i === 1 ? rest : e.payable,
      })),
    ),
    f = openedOperating(c),
    precision = Decimal.precision;
  try {
    const run = beginTrade(f.store);
    fillTrade(f.store, run);
    closeTrade(f.store, run, "10022");
    finishPostClose(f);
    const s = f.store.read(),
      cash = BigInt(s.handoff!.accounts.KRW.cash);
    f.store.settlePartial("tiny", partialCommand(s), s);
    const r = f.store.operatingReport(),
      a = r.financialEvidence.currentAccounts[0]!;
    assert.equal(a.cash, String(cash - 1n) + "." + "9".repeat(40));
    assert.equal(a.economicCash, String(cash + 2n));
    assert.equal(a.payable, rest);
    assert.equal(Decimal.precision, precision);
    verify(f.store.exportOperatingEvidence());
  } finally {
    f.repo.close();
  }
});

test("OR-06 bounded JSON rejects bytes depth nodes nonfinite and count overflow", () => {
  const f = openedOperating();
  try {
    const v = f.store.exportOperatingEvidence(),
      anchor = { config: f.c, exportHash: v.exportHash };
    for (const [text, code] of [
      [" ".repeat(MAX_OPERATING_EVIDENCE_BYTES + 1), "SIZE_LIMIT"],
      ["[".repeat(66) + "0" + "]".repeat(66), "STRUCTURE_LIMIT"],
      [JSON.stringify(Array(500001).fill(0)), "STRUCTURE_LIMIT"],
      ["1e999", "NONFINITE"],
      ["{", "JSON_INVALID"],
    ])
      assert.throws(
        () => verifyOperatingEvidence(text!, anchor),
        new RegExp(code!),
      );
    const many = structuredClone(v);
    Object.assign(many, { records: Array(21302).fill({}) });
    repin(many);
    assert.throws(() => verify(many), /SCHEMA_INVALID/);
    const oversized = structuredClone(f.store.read());
    oversized.operating!.rejectedInputs.push({
      rawJson: "x".repeat(MAX_OPERATING_EVIDENCE_BYTES),
      reason: "TEST",
      recordedAt: oversized.seed.clock,
    });
    const before = dump(f.repo);
    assert.throws(
      () => buildOperatingEvidence(f.c, 1, [], oversized),
      /SIZE_LIMIT/,
    );
    assert.equal(dump(f.repo), before);
  } finally {
    f.repo.close();
  }
});

test("OR-06 unknown config / forbidden combination do not initialize or gain permissions", () => {
  const f = openedOperating();
  try {
    const v = f.store.exportOperatingEvidence(),
      bad: OperatingConfig = structuredClone(f.c);
    Object.assign(bad, { executionLoop: {}, extra: true });
    assert.throws(() => verify(v, bad), /CONFIG_SHAPE/);
    const mixed = {
      ...postCloseConfig(),
      operatingLoop: webProgram().operatingLoop().config().operatingLoop,
    };
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    try {
      assert.throws(
        () => new CostReservationStore(repo, mixed, { initialize: true }),
        /EXTENSION_UNSUPPORTED/,
      );
    } finally {
      repo.close();
    }
    assert.throws(
      () => f.store.operatingReport(f.store.read().seed.clock - 1),
      /REPORT_TIME/,
    );
    assert.throws(() => f.store.report());
    assert.throws(() => f.store.exportEvidence());
  } finally {
    f.repo.close();
  }
});

test("OR-07 V3 legacy evidence remains identical and new entrypoints reject V3", () => {
  const f = openedOutcome();
  try {
    const before = f.store.exportEvidence();
    assert.throws(() => f.store.operatingReport(), /V4_REQUIRED/);
    assert.throws(() => f.store.exportOperatingEvidence(), /V4_REQUIRED/);
    assert.deepEqual(f.store.exportEvidence(), before);
  } finally {
    f.repo.close();
  }
});

test("OR-02 quarantined raw input is preserved and cannot finalize allocation", () => {
  const f = openedOperating();
  try {
    f.store.operatingInput("raw", "{broken fixture", f.store.read());
    const v = f.store.exportOperatingEvidence();
    assert.equal(
      v.report.financialEvidence.operating.rejectedInputs[0]!.rawJson,
      "{broken fixture",
    );
    assert.equal(v.report.financialEvidence.finalization.periodNetPnlKrw, null);
    assert.deepEqual(verify(v).report, v.report);
  } finally {
    f.repo.close();
  }
});

for (const mode of ["OPERATING", "D9", "D10"] as const)
  test(`OR-05 appended ${mode} duplicate business event rejected after repin`, () => {
    const f =
      mode === "D10"
        ? closedPartial()
        : mode === "D9"
          ? closedPostClose()
          : openedOperating();
    try {
      const s = f.store.read();
      if (mode === "D9") f.store.settlePostClose("pay", paymentCommand(s), s);
      else if (mode === "D10")
        f.store.settlePartial("part", partialCommand(s), s);
      else record(f.store, op(s, "RECOGNIZE", "cost"));
      const v = f.store.exportOperatingEvidence(),
        duplicate = structuredClone(v.records.at(-1)!);
      duplicate.id = "duplicate-business";
      duplicate.input.expectedRevision = v.report.source.revision;
      duplicate.input.expectedStateHash = v.report.source.stateHash;
      v.records.push(duplicate);
      repin(v);
      assert.throws(
        () => verify(v),
        /OPERATING_EVIDENCE_(COMMAND_MISMATCH|REPLAY_REJECTED)/,
      );
    } finally {
      f.repo.close();
    }
  });
