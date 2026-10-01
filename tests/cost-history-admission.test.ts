import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../src/core/policy.js";
import { completedRiskWindow } from "../src/core/calendar.js";
import {
  assessAdmissionHistory,
  admissionHistorySchema,
  historyAdmissionHash,
} from "../src/core/cost-history-admission.js";
import { initialOperatingReplay } from "../src/core/cost-operating-replay.js";
import { resolveOperatingCost } from "../src/core/operating-cost.js";
import type { OperatingHistory } from "../src/core/operating-cost.js";
import { verifyOperatingEvidence } from "../src/core/cost-operating-evidence.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import type { ReservationWriteStage } from "../src/server/cost-reservation-store.js";
import { Repository } from "../src/server/repository.js";
import { initialHandoff } from "../src/core/cost-handoff.js";
import { replayCostJournal } from "../src/core/cost-journal.js";
import { dumpHandoff } from "./cost-handoff-helpers.js";
import { observation } from "./cost-reservation-helpers.js";
import { op, record } from "./cost-operating-helpers.js";
import { admissionFixture, historyProgram } from "./cost-history-helpers.js";

test("HA-01/02: explicit signal history reaches reserve/handoff/export without historical cash or counter writes", () => {
  const f = admissionFixture();
  try {
    const before = f.store.read(),
      p = f.adapter.prepareEntry(f.store, f.history());
    assert.equal(p.candidate.operatingEstimateKrw, "4");
    assert.equal(f.c.historyAdmission?.contractHash, historyAdmissionHash);
    for (const k of [
      "orderSubmissionAllowed",
      "learningAllowed",
      "liveEnabled",
    ] as const)
      assert.equal(p[k], false);
    f.store.reserve("reserve", p);
    const s = f.store.read();
    assert.deepEqual(s.seed.ledger.wallets, before.seed.ledger.wallets);
    assert.equal(s.seed.ledger.intents, 1);
    assert.equal(s.seed.ledger.entries, 0);
    assert.equal(s.operating!.effects.incurredKrw, "0");
    assert.equal(
      s.approvals[0]!.operatingBinding?.source,
      "EXPLICIT_TEST_HISTORY",
    );
    f.handoff();
    const evidence = f.store.exportOperatingEvidence();
    assert.equal(evidence.records.length, 2);
    assert.deepEqual(
      evidence.report.financialEvidence.approvals[0]!.proposal.operatingHistory,
      f.history(),
    );
    assert.equal(evidence.newSpendingAllowed, false);
    assert.equal(evidence.report.status, "HOLD");
    assert.equal(
      verifyOperatingEvidence(JSON.stringify(evidence), {
        config: f.c,
        exportHash: evidence.exportHash,
      }).report.reportHash,
      evidence.report.reportHash,
    );
  } finally {
    f.repo.close();
  }
});

test("HA-03/04: only historical cost changes economics; equal quantity reserves and stop risk stay unchanged", () => {
  const f = admissionFixture();
  try {
    const zero = f.adapter.prepareEntry(f.store, f.history("0")).candidate;
    const low = f.adapter.prepareEntry(f.store, f.history()).candidate;
    assert.equal(low.quantity, zero.quantity);
    assert.equal(
      BigInt(low.economicCostKrw) - BigInt(zero.economicCostKrw),
      4n,
    );
    assert.equal(BigInt(zero.netQ05Krw) - BigInt(low.netQ05Krw), 4n);
    for (const key of [
      "riskKrw",
      "reservationCashNative",
      "entry",
      "stop",
      "stopTradingCostKrw",
      "roundTripTradingCostKrw",
    ] as const) {
      assert.equal(low[key], zero[key]);
    }
    const before = dumpHandoff(f.repo);
    assert.throws(
      () => f.adapter.prepareEntry(f.store, f.history("999999999")),
      /LOCAL_ADMISSION_HOLD/,
    );
    assert.deepEqual(dumpHandoff(f.repo), before);
  } finally {
    f.repo.close();
  }
});

test("HA-05/13: history does not block protection; actual current expense and payment count once through D8", () => {
  const f = admissionFixture();
  try {
    f.reserve();
    f.handoff();
    f.tick(1000);
    f.expense();
    let s = f.store.read();
    assert.equal(s.operating!.effects.incurredKrw, "50");
    assert.ok(
      s.handoff!.admissionHolds.includes(
        "OPERATING_ADMISSION_INTEGRATION_PENDING",
      ),
    );
    assert.throws(() => f.adapter.prepareEntry(f.store, f.history()), /HOLD/);
    for (const ms of [2000, 3000, 4000]) f.tick(ms);
    for (const ms of [5000, 6000, 7000, 8000, 9000, 10000, 11000])
      f.tick(ms, "22000");
    s = f.store.read();
    assert.equal(s.outcomes!.length, 1);
    record(f.store, op(s, "PAY", "pay", "50"));
    assert.equal(f.store.read().operating!.effects.incurredKrw, "50");
    assert.equal(f.store.read().operating!.effects.paidKrw, "50");
    f.close();
    const e = f.store.exportOperatingEvidence(),
      t = e.report.financialEvidence.trades[0]!;
    assert.equal(t.operatingAllocationKrw, "50");
    assert.equal(BigInt(t.tradingNetPnlKrw!) - BigInt(t.finalNetPnlKrw!), 50n);
    assert.equal(t.finalNetPnlKrw, "2330");
    assert.equal(
      e.report.financialEvidence.operating.current.incurredKrw,
      "50",
    );
    assert.equal(e.report.learningAllowed, false);
    assert.equal(
      verifyOperatingEvidence(JSON.stringify(e), {
        config: f.c,
        exportHash: e.exportHash,
      }).report.reportHash,
      e.report.reportHash,
    );
  } finally {
    f.repo.close();
  }
});

const invalidHistories: [string, (h: OperatingHistory) => unknown][] = [
  ["missing", () => undefined],
  ["null", () => null],
  ["wrong type", () => "history"],
  ["numeric money", (h) => ({ ...h, costs: [{ ...h.costs[0], amount: 10 }] })],
  ["exponent", (h) => ({ ...h, costs: [{ ...h.costs[0], amount: "1e1" }] })],
  [
    "wrong kind",
    (h) => ({ ...h, costs: [{ ...h.costs[0], kind: "TRADING" }] }),
  ],
  ["USD", (h) => ({ ...h, costs: [{ ...h.costs[0], currency: "USD" }] })],
  ["N zero", (h) => ({ ...h, closedIntents: [], dailyBudgetKrw: "0" })],
  [
    "incomplete",
    (h) => ({ ...h, coverage: { ...h.coverage, complete: false } }),
  ],
  [
    "19 days",
    (h) => ({
      ...h,
      coverage: {
        ...h.coverage,
        startInclusive: h.coverage.startInclusive + 86400000,
      },
    }),
  ],
  ["future increase", (h) => ({ ...h, futureIncreaseKrw: "1" })],
  ["refund", (h) => ({ ...h, costs: [{ ...h.costs[0], amount: "-1" }] })],
  ["wrong config", (h) => ({ ...h, configHash: "0".repeat(64) })],
  ["wrong epoch", (h) => ({ ...h, riskEpoch: h.riskEpoch + 1 })],
  [
    "future coverage",
    (h) => ({
      ...h,
      coverage: {
        ...h.coverage,
        availableAt: h.coverage.endExclusive + 86400000,
      },
    }),
  ],
  [
    "coverage too early",
    (h) => ({
      ...h,
      coverage: { ...h.coverage, availableAt: h.coverage.endExclusive - 1 },
    }),
  ],
  [
    "cost later than coverage",
    (h) => ({
      ...h,
      costs: [{ ...h.costs[0], availableAt: h.coverage.availableAt + 1 }],
    }),
  ],
  [
    "availability before occurrence",
    (h) => ({
      ...h,
      costs: [{ ...h.costs[0], availableAt: h.costs[0]!.occurredAt - 1 }],
    }),
  ],
  [
    "start minus 1ms",
    (h) => ({
      ...h,
      costs: [
        {
          ...h.costs[0],
          occurredAt: h.coverage.startInclusive - 1,
          availableAt: h.coverage.startInclusive - 1,
        },
      ],
    }),
  ],
  [
    "end boundary",
    (h) => ({
      ...h,
      costs: [
        {
          ...h.costs[0],
          occurredAt: h.coverage.endExclusive,
          availableAt: h.coverage.endExclusive,
        },
      ],
    }),
  ],
  [
    "end plus 1ms",
    (h) => ({
      ...h,
      closedIntents: [
        {
          ...h.closedIntents[0],
          closedAt: h.coverage.endExclusive + 1,
          availableAt: h.coverage.endExclusive + 1,
        },
      ],
    }),
  ],
  [
    "intent not fully closed",
    (h) => ({
      ...h,
      closedIntents: [{ ...h.closedIntents[0], sellQuantity: 3 }],
    }),
  ],
  [
    "conflicting cost id",
    (h) => ({ ...h, costs: [...h.costs, { ...h.costs[0], amount: "11" }] }),
  ],
  [
    "conflicting intent id",
    (h) => ({
      ...h,
      closedIntents: [
        ...h.closedIntents,
        { ...h.closedIntents[0], buyQuantity: 3, sellQuantity: 3 },
      ],
    }),
  ],
];
for (const [name, change] of invalidHistories)
  test(`HA-06/07/08/09/14: ${name} rejects without writes`, () => {
    const f = admissionFixture();
    try {
      const before = dumpHandoff(f.repo);
      assert.throws(() => f.adapter.prepareEntry(f.store, change(f.history())));
      assert.deepEqual(dumpHandoff(f.repo), before);
    } finally {
      f.repo.close();
    }
  });

test("HA-07/09: exact window includes weekends and last millisecond; permutation/duplicates have same binding", () => {
  const f = admissionFixture();
  try {
    const h = f.history(),
      w = completedRiskWindow(f.at);
    assert.equal(w.riskDayIds.length, 20);
    assert.ok(w.riskDayIds.includes("2026-08-16"));
    assert.equal(
      new Date(w.startInclusive).toISOString(),
      "2026-08-12T00:00:00.000Z",
    );
    const other = structuredClone(h);
    other.costs.push({ ...other.costs[0]! });
    other.closedIntents.reverse();
    other.closedIntents.push({ ...other.closedIntents[0]! });
    const a = assessAdmissionHistory(f.c.seed, h),
      b = assessAdmissionHistory(f.c.seed, other);
    assert.deepEqual(a.binding, b.binding);
    assert.equal(b.amount, "4");
    f.reserve(h);
    f.handoff(other);
    const last = f.history();
    last.costs[0]!.occurredAt = last.costs[0]!.availableAt = w.endExclusive - 1;
    assert.equal(assessAdmissionHistory(f.c.seed, last).amount, "4");
  } finally {
    f.repo.close();
  }
});

test("HA-10: equal amount/different evidence and missing current input reject, preserving local reserve until explicit release", () => {
  const f = admissionFixture();
  try {
    f.reserve();
    const before = dumpHandoff(f.repo);
    assert.equal(assessAdmissionHistory(f.c.seed, f.history("11")).amount, "4");
    assert.throws(
      () => f.store.prepareHandoff(f.adapter.reservationId, "CONFIRMED"),
      /CURRENT_INPUT_REQUIRED/,
    );
    assert.throws(() =>
      f.store.prepareHandoff(f.adapter.reservationId, "CONFIRMED", null),
    );
    assert.throws(() => f.handoff(f.history("11")), /REAPPROVAL_REQUIRED/);
    assert.deepEqual(dumpHandoff(f.repo), before);
    f.store.release("release", f.adapter.reservationId, f.store.read());
    assert.equal(f.store.read().approvals[0]!.status, "RELEASED_LOCAL");
    assert.throws(
      () =>
        f.store.reserve(
          "second-reserve",
          f.adapter.prepareEntry(f.store, f.history()),
        ),
      /SINGLE_APPROVAL/,
    );
  } finally {
    f.repo.close();
  }
});

test("HA-08/11: observation cannot refresh forecast TTL and stale prepared reserve is rejected", () => {
  const f = admissionFixture();
  try {
    const p = f.adapter.prepareEntry(f.store, f.history());
    f.store.observe(
      "observe",
      observation(f.store.read(), 30001),
      f.store.read(),
    );
    const before = dumpHandoff(f.repo);
    assert.throws(() => f.store.reserve("reserve", p));
    assert.throws(() => f.adapter.prepareEntry(f.store, f.history()), /HOLD/);
    assert.deepEqual(dumpHandoff(f.repo), before);
  } finally {
    f.repo.close();
  }
});

test("HA-11: altered/cloned receipt rejected; same committed command returns original receipt once", () => {
  const f = admissionFixture();
  try {
    const p = f.adapter.prepareEntry(f.store, f.history()),
      before = dumpHandoff(f.repo);
    assert.throws(
      () => f.store.reserve("clone", structuredClone(p)),
      /UNISSUED/,
    );
    assert.equal(p.input.command.kind, "RESERVE");
    if (p.input.command.kind !== "RESERVE") throw Error("expected reserve");
    p.input.command.proposal.operatingHistory!.costs[0]!.amount = "11";
    assert.throws(() => f.store.reserve("tamper", p), /UNISSUED/);
    assert.deepEqual(dumpHandoff(f.repo), before);
    const fresh = f.adapter.prepareEntry(f.store, f.history());
    const first = f.store.reserve("reserve", fresh),
      saved = dumpHandoff(f.repo);
    const retry = f.store.reserve("reserve", structuredClone(fresh));
    assert.deepEqual(retry.receipt, first.receipt);
    assert.deepEqual(dumpHandoff(f.repo), saved);
  } finally {
    f.repo.close();
  }
});

for (const stage of [
  "COMMAND",
  "APPROVALS",
  "FILL_INDEX",
  "STATE",
  "AUDIT",
] as ReservationWriteStage[])
  test(`HA-12: ${stage} failure rolls history and financial state back together`, () => {
    let fail = false;
    const f = admissionFixture({
      testStage: (s) => {
        if (fail && s === stage) throw Error("injected-history-write");
      },
    });
    try {
      const p = f.adapter.prepareEntry(f.store, f.history()),
        before = dumpHandoff(f.repo);
      fail = true;
      assert.throws(() => f.store.reserve("reserve", p), /injected/);
      assert.deepEqual(dumpHandoff(f.repo), before);
      fail = false;
      f.store.reserve("reserve", p);
      const hp = f.store.prepareHandoff(
          f.adapter.reservationId,
          "CONFIRMED",
          f.history(),
        ),
        reserved = dumpHandoff(f.repo);
      fail = true;
      assert.throws(() => f.store.handoff("handoff", hp), /injected/);
      assert.deepEqual(dumpHandoff(f.repo), reserved);
      fail = false;
      f.store.handoff("handoff", hp);
      assert.equal(f.store.read().book.sources.length, 1);
    } finally {
      f.repo.close();
    }
  });

test("HA-12: cold reopen recovers original receipt; new epoch cannot reuse outstanding approval", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "history-admission-")),
    "test.sqlite",
  );
  const f = admissionFixture({ path });
  const p = f.adapter.prepareEntry(f.store, f.history());
  const first = f.store.reserve("reserve", p),
    h = f.history(),
    evidence = f.store.exportOperatingEvidence();
  f.repo.close();
  const repo = new Repository(path, () => 2000);
  repo.acquire();
  try {
    const store = new CostReservationStore(repo, f.c);
    assert.deepEqual(
      store.reserve("reserve", structuredClone(p)).receipt,
      first.receipt,
    );
    const before = dumpHandoff(repo);
    assert.throws(
      () => store.prepareHandoff(f.adapter.reservationId, "CONFIRMED", h),
      /EPOCH_CHANGED/,
    );
    assert.throws(
      () =>
        store.prepareHandoff(f.adapter.reservationId, "CONFIRMED", {
          ...h,
          riskEpoch: repo.epoch,
        }),
      /EPOCH_CHANGED/,
    );
    assert.deepEqual(dumpHandoff(repo), before);
    assert.equal(
      store.exportOperatingEvidence().exportHash,
      evidence.exportHash,
    );
  } finally {
    repo.close();
  }
  assert.equal(
    verifyOperatingEvidence(JSON.stringify(evidence), {
      config: f.c,
      exportHash: evidence.exportHash,
    }).report.reportHash,
    evidence.report.reportHash,
  );
});

test("HA-12/16: raw evidence omission or alteration fails independent replay even with resealed outer hash", () => {
  const f = admissionFixture();
  try {
    f.reserve();
    f.handoff();
    const e = f.store.exportOperatingEvidence();
    for (const target of ["RESERVE", "HANDOFF"] as const)
      for (const omit of [true, false]) {
        const v = structuredClone(e),
          command = v.records.find((r) => r.input.command.kind === target)!
            .input.command;
        if (command.kind === "RESERVE") {
          if (omit) delete command.proposal.operatingHistory;
          else command.proposal.operatingHistory!.costs[0]!.amount = "11";
        } else if (command.kind === "HANDOFF") {
          if (omit) delete command.operatingHistory;
          else command.operatingHistory!.costs[0]!.amount = "11";
        }
        const { exportHash, ...body } = v;
        assert.equal(exportHash, e.exportHash);
        v.exportHash = hash(body);
        assert.throws(() =>
          verifyOperatingEvidence(JSON.stringify(v), {
            config: f.c,
            exportHash: v.exportHash,
          }),
        );
      }
  } finally {
    f.repo.close();
  }
});

test("HA-13: UNKNOWN is not cleared by history; no auto resume", () => {
  const f = admissionFixture();
  try {
    f.reserve();
    f.handoff(f.history(), "UNKNOWN");
    const before = dumpHandoff(f.repo);
    assert.throws(() => f.adapter.prepareEntry(f.store, f.history()), /HOLD/);
    assert.deepEqual(dumpHandoff(f.repo), before);
    const src = f.store.read().book.sources[0]!;
    assert.ok(
      replayCostJournal(src.config, src.events).orders.some(
        (o) => o.status === "UNKNOWN",
      ),
    );
  } finally {
    f.repo.close();
  }
});

test("HA-08/11: handoff stays pinned to original signal and cost profile; stale receipts preserve reservations", () => {
  const f = admissionFixture();
  try {
    f.reserve();
    const p = f.store.prepareHandoff(
      f.adapter.reservationId,
      "CONFIRMED",
      f.history(),
    );
    f.store.observe(
      "observe",
      observation(f.store.read(), 30001),
      f.store.read(),
    );
    const before = dumpHandoff(f.repo);
    assert.throws(() => f.store.handoff("handoff", p));
    assert.throws(
      () =>
        f.store.prepareHandoff(
          f.adapter.reservationId,
          "CONFIRMED",
          f.history(),
        ),
      /HOLD/,
    );
    assert.deepEqual(dumpHandoff(f.repo), before);
    assert.equal(f.store.read().approvals[0]!.status, "RESERVED_LOCAL");
  } finally {
    f.repo.close();
  }
  const g = admissionFixture();
  try {
    const p = g.adapter.prepareEntry(g.store, g.history());
    if (p.input.command.kind !== "RESERVE") throw Error("expected reserve");
    for (const change of [
      (r: typeof p.input.command.proposal) => {
        r.profile.effectiveTo = g.at;
      },
      (r: typeof p.input.command.proposal) => {
        r.request.signalAt = g.at - 86400000;
      },
      (r: typeof p.input.command.proposal) => {
        r.profile.availableAt = g.at + 1;
      },
    ]) {
      const proposal = structuredClone(p.input.command.proposal);
      change(proposal);
      proposal.request.profileHash = hash(proposal.profile);
      assert.throws(() => g.store.prepare(proposal), /HOLD/);
    }
  } finally {
    g.repo.close();
  }
});

test("HA-11/12: lease expiry before COMMIT rolls back; edited current-history receipt is unissued", () => {
  let now = 1000,
    fail = false;
  const f = admissionFixture({
    leaseNow: () => now,
    testStage: (s) => {
      if (fail && s === "AUDIT") now += 10001;
    },
  });
  try {
    const p = f.adapter.prepareEntry(f.store, f.history()),
      before = dumpHandoff(f.repo);
    fail = true;
    assert.throws(() => f.store.reserve("reserve", p), /FENCED_WRITER/);
    assert.deepEqual(dumpHandoff(f.repo), before);
  } finally {
    f.repo.close();
  }
  const g = admissionFixture();
  try {
    g.reserve();
    const hp = g.store.prepareHandoff(
      g.adapter.reservationId,
      "CONFIRMED",
      g.history(),
    );
    const before = dumpHandoff(g.repo);
    if (hp.input.command.kind !== "HANDOFF") throw Error("expected handoff");
    hp.input.command.operatingHistory!.costs[0]!.amount = "11";
    assert.throws(() => g.store.handoff("handoff", hp), /UNISSUED/);
    assert.deepEqual(dumpHandoff(g.repo), before);
  } finally {
    g.repo.close();
  }
});

test("HA-13: stopping loss closes under current expense HOLD, final loss counter applies only once", () => {
  const f = admissionFixture();
  try {
    f.reserve();
    f.handoff();
    for (const ms of [1000, 2000, 3000, 4000]) f.tick(ms);
    f.expense();
    const stop = f.store.read().approvals[0]!.candidate.stop;
    for (const ms of [5000, 6000, 7000, 8000, 9000, 10000, 11000])
      f.tick(ms, stop);
    const paid = record(f.store, op(f.store.read(), "PAY", "pay", "50"));
    assert.ok(
      paid.handoff!.admissionHolds.includes(
        "OPERATING_ADMISSION_INTEGRATION_PENDING",
      ),
    );
    f.close();
    const s = f.store.read();
    assert.equal(s.seed.ledger.lossStreak, 1);
    assert.equal(s.outcomes!.length, 1);
    assert.ok(
      s.handoff!.admissionHolds.includes(
        "OPERATING_ADMISSION_INTEGRATION_PENDING",
      ),
    );
    assert.throws(() => f.adapter.prepareEntry(f.store, f.history()), /HOLD/);
  } finally {
    f.repo.close();
  }
});

test("HA-14/15: month-middle/carry/extension misuse rejected; old N=0 and no opt-in still retain old behavior", () => {
  const f = admissionFixture();
  try {
    for (const change of [
      (c: typeof f.c) => {
        c.seed.clock += 86400000;
        c.operating.periodStart += 86400000;
        c.operating.periodEnd += 86400000;
        c.book.initialAt += 86400000;
        c.book.seedHash = hash(c.seed);
      },
      (c: typeof f.c) => {
        c.seed.ledger.lossStreak = 1;
        c.book.seedHash = hash(c.seed);
      },
      (c: typeof f.c) => {
        c.seed.ledger.halts.push("MANUAL_HALT");
        c.book.seedHash = hash(c.seed);
      },
      (c: typeof f.c) => {
        c.historyAdmission!.contractHash = "bad";
      },
      (c: typeof f.c) => {
        delete c.operatingLoop;
      },
    ]) {
      const c = structuredClone(f.c);
      change(c);
      assert.throws(() => initialOperatingReplay(c, 1));
    }
    const unsupported = {
      ...historyProgram().config(),
      historyAdmission: f.c.historyAdmission,
    };
    assert.throws(() => initialHandoff(unsupported, 1), /OPT_IN_REQUIRED/);
    const h = f.history();
    h.closedIntents = [];
    h.dailyBudgetKrw = "20";
    assert.equal(resolveOperatingCost(f.c.seed, h).amount, "20");
  } finally {
    f.repo.close();
  }
  const old = admissionFixture({ legacy: true });
  try {
    assert.equal(
      old.adapter.prepareEntry(old.store).candidate.operatingEstimateKrw,
      "0",
    );
    assert.throws(
      () => old.adapter.prepareEntry(old.store, old.history()),
      /OPT_IN_REQUIRED/,
    );
    const p = old.adapter.prepareEntry(old.store);
    if (p.input.command.kind !== "RESERVE") throw Error("expected reserve");
    const proposal = p.input.command.proposal;
    assert.throws(
      () => old.store.prepare({ ...proposal, operatingHistory: old.history() }),
      /OPT_IN_REQUIRED/,
    );
    old.store.reserve("reserve", p);
    assert.throws(
      () =>
        old.store.prepareHandoff(
          old.adapter.reservationId,
          "CONFIRMED",
          old.history(),
        ),
      /OPT_IN_REQUIRED/,
    );
  } finally {
    old.repo.close();
  }
});

test("HA-16: oversized serialized history and row/id/money bounds reject without writes", () => {
  const f = admissionFixture();
  try {
    const before = dumpHandoff(f.repo),
      h = f.history();
    h.costs = Array.from({ length: 2000 }, (_, i) => ({
      ...h.costs[0]!,
      id: `cost-${i}-${"x".repeat(100)}`,
    }));
    assert.throws(() => admissionHistorySchema.parse(h), /SIZE_LIMIT/);
    assert.throws(() => f.adapter.prepareEntry(f.store, h), /SIZE_LIMIT/);
    for (const change of [
      (v: OperatingHistory) => {
        v.costs = Array(10001).fill(v.costs[0]);
      },
      (v: OperatingHistory) => {
        v.costs[0]!.id = "x".repeat(129);
      },
      (v: OperatingHistory) => {
        v.costs[0]!.amount = "9".repeat(31);
      },
    ]) {
      const v = f.history();
      change(v);
      assert.throws(() => f.adapter.prepareEntry(f.store, v));
    }
    assert.deepEqual(dumpHandoff(f.repo), before);
  } finally {
    f.repo.close();
  }
});
