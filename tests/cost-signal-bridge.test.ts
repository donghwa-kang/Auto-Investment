import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CostSignalProgram,
  costSignalSelectionSchema,
} from "../src/server/cost-signal-bridge.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { Repository } from "../src/server/repository.js";
import { portfolioFixture } from "../src/core/portfolio-fixture.js";
import { PortfolioProgram } from "../src/core/portfolio-program.js";
import { costSizingRequestSchema } from "../src/core/cost-aware-sizing.js";
import { roundedEntry } from "../src/core/strategy.js";
import { profile } from "../src/core/risk.js";
import { hash } from "../src/core/policy.js";
import { verifyCostOutcomeExport } from "../src/core/cost-outcome-export.js";
import { replayFixture } from "./signal-replay-helpers.js";
import { costProfile } from "./transaction-cost-helpers.js";
import { observation } from "./cost-reservation-helpers.js";
import {
  fillTrade,
  fillEvent,
  sellOrder,
  execute,
  journal,
} from "./cost-outcome-helpers.js";

function fixture(strategy: "B" | "P" = "B") {
  const input = replayFixture(),
    settings = portfolioFixture(input).settings;
  const at = Date.parse(input.frames[strategy === "B" ? 0 : 1]!.asOf);
  const p = costProfile();
  p.effectiveFrom = at - 100000;
  p.availableAt = p.effectiveFrom;
  p.effectiveTo = at + 7200000;
  const selection = costSignalSelectionSchema.parse({
    kind: "SYNTHETIC_COST_SIGNAL_SELECTION_V1",
    purpose: "TEST_ONLY",
    frameAsOf: at,
    catalogKey: `KR:REPLAY-KR-${strategy}`,
    profile: p,
    forecast: {
      model: "SYNTHETIC_POINT_SCENARIO",
      expectedExit: "22000",
      q05Exit: "21400",
      availableAt: at,
      validUntil: at + 30000,
    },
    adverseExitTicks: 0,
  });
  return { input, settings, selection };
}
function program(f = fixture()) {
  return new CostSignalProgram(f.input, f.settings, f.selection);
}
function opened(p: CostSignalProgram, path = ":memory:", initialize = true) {
  const repo = new Repository(path, () => 1000);
  repo.acquire();
  return {
    repo,
    store: new CostReservationStore(repo, p.config(), { initialize }),
  };
}
function enter(p: CostSignalProgram, store: CostReservationStore) {
  const prepared = p.prepareEntry(store);
  store.reserve("reserve", prepared);
  store.handoff("handoff", store.prepareHandoff(p.reservationId, "CONFIRMED"));
  return { prepared, runId: store.read().handoff!.transfers[0]!.runId };
}

for (const strategy of ["B", "P"] as const)
  test(`CSB-01 ${strategy} real replay signal drives native approval without ATR rounding`, () => {
    const f = fixture(strategy),
      before = hash(f),
      p = program(f),
      { repo, store } = opened(p);
    try {
      const item = new PortfolioProgram(f.input, f.settings)
        .report()
        .frames.find((r) => Date.parse(r.asOf) === f.selection.frameAsOf)!
        .items.find((i) => i.catalogKey === f.selection.catalogKey)!;
      const prepared = p.prepareEntry(store);
      assert.equal(prepared.input.command.kind, "RESERVE");
      const request = prepared.input.command.proposal.request;
      assert.equal(request.strategy, strategy);
      assert.equal(request.atr, item.evaluation!.current!.atr);
      assert.ok(request.atr.split(".")[1]!.length > 6);
      assert.equal(
        request.stop,
        roundedEntry(
          item.evaluation!,
          strategy,
          request.quote.ask,
          profile.ticks.KR,
        ).S,
      );
      assert.ok(prepared.candidate.quantity > 0);
      assert.equal(hash(f), before);
      const clone = p.config();
      clone.seed.ledger.wallets.KRW.cash = "0";
      assert.equal(p.config().seed.ledger.wallets.KRW.cash, "5000000");
      assert.equal(store.read().revision, 0, "prepare remains read-only");
    } finally {
      repo.close();
    }
  });

for (const unit of ["ORDER", "FILL"] as const)
  test(`CSB-02 ${unit} signal -> partial fills -> settlement -> close -> shared report/HOLD basis`, () => {
    const f = fixture();
    for (const r of f.selection.profile.rules) r.unit = unit;
    const p = program(f),
      { repo, store } = opened(p);
    try {
      const { prepared, runId } = enter(p, store),
        quantity = prepared.candidate.quantity;
      assert.ok(quantity > 1);
      fillTrade(store, runId);
      assert.equal(journal(store.read(), runId).quantity, 1);
      assert.equal(
        p.evidence(store).cost.report.financialEvidence.trades[0]!.phase,
        "INCOMPLETE_TRADE",
      );
      for (let i = 1; i < quantity; i++) fillTrade(store, runId);
      const buyFillIds = journal(store.read(), runId).postings.map(
        (v) => v.fill.fillId,
      );
      execute(store, runId, {
        kind: "SETTLE",
        id: "buy-settle",
        fillIds: buyFillIds,
      });
      sellOrder(store, runId, "21800");
      for (let i = 0; i < quantity; i++) fillTrade(store, runId, "exit");
      const sellFillIds = journal(store.read(), runId)
        .postings.filter((v) => v.side === "SELL")
        .map((v) => v.fill.fillId);
      execute(store, runId, {
        kind: "SETTLE",
        id: "sell-settle",
        fillIds: sellFillIds,
      });
      const before = hash(store.read()),
        a = p.evidence(store),
        b = p.evidence(store),
        report = a.cost.report;
      assert.deepEqual(a, b);
      assert.equal(hash(store.read()), before);
      // Independent integer oracle: 1bp per order with minimum 10, or minimum
      // 10 per one-share fill. Never use the production fee calculator here.
      const q = BigInt(quantity),
        buy = q * 21400n,
        sell = q * 21800n;
      const orderFee = (value: bigint) => {
        const rounded = (value + 9999n) / 10000n;
        return rounded > 10n ? rounded : 10n;
      };
      const fees = unit === "ORDER" ? orderFee(buy) + orderFee(sell) : q * 20n;
      const net = sell - buy - fees;
      assert.equal(
        report.report.currencies.find((c) => c.currency === "KRW")!
          .closedNetPnlKrw,
        String(net),
      );
      assert.equal(
        report.financialEvidence.trades[0]!.tradingFees,
        String(fees),
      );
      assert.equal(
        report.financialEvidence.accounts.find((c) => c.currency === "KRW")!
          .cash,
        String(5000000n + net),
      );
      assert.equal(report.financialEvidence.trades[0]!.unsettledFillCount, 0);
      assert.equal(a.financialBasisHash, report.report.financialBasisHash);
      assert.equal(
        a.financialBasisHash,
        report.learningEvidence.financialBasisHash,
      );
      const learning = report.learningEvidence.records[0]!;
      assert.equal(learning.tradingFees, String(fees));
      assert.equal(learning.tradingNetPnlKrw, String(net));
      assert.equal(learning.trainingLabel, null);
      assert.equal(learning.status, "HOLD");
      assert.equal(a.orderSubmissionAllowed, false);
      assert.equal(a.learningAllowed, false);
      assert.equal(a.liveEnabled, false);
      assert.deepEqual(
        verifyCostOutcomeExport(JSON.stringify(a.cost), {
          config: p.config(),
          exportHash: a.cost.exportHash,
        }).report,
        report,
      );
    } finally {
      repo.close();
    }
  });

test("CSB-03 disk restart retries original prepared request and duplicate fill without recharging", () => {
  const p = program(),
    dir = mkdtempSync(join(tmpdir(), "cost-signal-")),
    path = join(dir, "new.sqlite"),
    requestPath = join(dir, "prepared.json");
  let { repo, store } = opened(p, path);
  try {
    const prepared = p.prepareEntry(store);
    writeFileSync(requestPath, JSON.stringify(prepared), { flag: "wx" });
    const receipt = store.reserve("reserve", prepared).receipt;
    repo.close();
    ({ repo, store } = opened(program(), path, false));
    const restored: typeof prepared = JSON.parse(
      readFileSync(requestPath, "utf8"),
    );
    assert.deepEqual(restored, prepared);
    assert.deepEqual(store.reserve("reserve", restored).receipt, receipt);
    store.handoff(
      "handoff",
      store.prepareHandoff(p.reservationId, "CONFIRMED"),
    );
    const runId = store.read().handoff!.transfers[0]!.runId,
      previous = store.read(),
      fill = fillEvent(previous, runId);
    store.execute("fill", runId, fill, previous);
    const after = store.read();
    repo.close();
    ({ repo, store } = opened(program(), path, false));
    assert.deepEqual(
      store.execute(
        "fill-retry",
        runId,
        { ...fill, id: "redelivery", seq: fill.seq + 1, at: fill.at + 1 },
        store.read(),
      ).current,
      after,
    );
    const bytes = readFileSync(path);
    p.evidence(store);
    p.evidence(store);
    assert.deepEqual(readFileSync(path), bytes);
    const changed = { ...fill, price: "21399" };
    assert.throws(
      () => store.execute("conflict", runId, changed, store.read()),
      /CONFLICT/,
    );
    assert.deepEqual(store.read(), after);
  } finally {
    repo.close();
  }
});

test("CSB-04 stale state and stale market evidence cannot mint a fresh approval", () => {
  const p = program(),
    { repo, store } = opened(p);
  try {
    const prepared = p.prepareEntry(store),
      s = store.read();
    store.observe("later", observation(s, 60000), s);
    const before = hash(store.read());
    assert.throws(() => store.reserve("stale", prepared), /STALE|REAPPROVAL/);
    assert.throws(() => p.prepareEntry(store), /HOLD/);
    assert.equal(hash(store.read()), before);
  } finally {
    repo.close();
  }
});

test("CSB-05 signal/profile binding detects foreign Store and caller-derived replacement proposal", () => {
  const p = program(),
    f = fixture();
  f.selection.adverseExitTicks = 1;
  const other = program(f),
    { repo, store } = opened(p);
  try {
    const before = hash(store.read());
    assert.throws(() => other.prepareEntry(store), /STORE_BINDING_MISMATCH/);
    assert.throws(() => other.evidence(store), /STORE_BINDING_MISMATCH/);
    assert.equal(hash(store.read()), before);
    const prepared = p.prepareEntry(store);
    assert.equal(prepared.input.command.kind, "RESERVE");
    const changed = prepared.input.command.proposal;
    changed.request.stop = "21120";
    store.reserve("outside-bridge", store.prepare(changed));
    assert.throws(() => p.evidence(store), /SIGNAL_APPROVAL_MISMATCH/);
  } finally {
    repo.close();
  }
});

test("CSB-06 costly scenario abstains with no financial mutation instead of relaxing risk", () => {
  const f = fixture();
  f.selection.forecast.expectedExit = "21400";
  const p = program(f),
    { repo, store } = opened(p);
  try {
    const before = hash(store.read());
    assert.throws(() => p.prepareEntry(store), /LOCAL_ADMISSION_HOLD/);
    assert.equal(hash(store.read()), before);
    assert.equal(store.report().financialEvidence.approvals.length, 0);
  } finally {
    repo.close();
  }
});

for (const [name, mutate, error] of [
  [
    "blocked chart",
    (f: ReturnType<typeof fixture>) => {
      f.selection.catalogKey = "KR:REPLAY-KR-P";
    },
    /SINGLE_VALIDATED/,
  ],
  [
    "unknown frame",
    (f: ReturnType<typeof fixture>) => {
      f.selection.frameAsOf++;
    },
    /SINGLE_KRW/,
  ],
  [
    "product mismatch",
    (f: ReturnType<typeof fixture>) => {
      f.selection.profile.scope.product = "EQUITY";
    },
    /SCOPE_MISMATCH/,
  ],
  [
    "USD wallet",
    (f: ReturnType<typeof fixture>) => {
      f.settings.config.usdCapitalKrw = 100000;
    },
    /TEST_SETTINGS/,
  ],
  [
    "forecast mode",
    (f: ReturnType<typeof fixture>) => {
      f.settings.config.forecast = "MISSING_PROFILE";
    },
    /TEST_SETTINGS/,
  ],
  [
    "missing test sequence",
    (f: ReturnType<typeof fixture>) => {
      f.settings.candidateOrder = null;
    },
    /TEST_SETTINGS/,
  ],
  [
    "execution profile changed",
    (f: ReturnType<typeof fixture>) => {
      f.settings.syntheticProfileHash = "0".repeat(64);
    },
    /TEST_SETTINGS/,
  ],
  [
    "cost horizon too short",
    (f: ReturnType<typeof fixture>) => {
      f.selection.profile.effectiveTo = f.selection.frameAsOf + 3600000;
    },
    /COST_PROFILE_HORIZON/,
  ],
] as const)
  test(`CSB-07 ${name} fails before Store initialization`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => program(f), error);
  });

test("CSB-08 caller-supplied evaluation/stop and omitted forecast are not accepted selection fields", () => {
  const f = fixture();
  assert.throws(
    () =>
      new CostSignalProgram(f.input, f.settings, {
        ...f.selection,
        stop: "21100",
      }),
  );
  assert.throws(
    () =>
      new CostSignalProgram(f.input, f.settings, {
        ...f.selection,
        forecast: undefined,
      }),
  );
});

test("CSB-09 ATR analytic precision expands only ATR, never money or nonfinite forms", () => {
  const schema = costSizingRequestSchema.shape.atr;
  assert.equal(
    schema.parse("284.1545189504373177842565597667638483965"),
    "284.1545189504373177842565597667638483965",
  );
  for (const invalid of [
    NaN,
    1,
    "NaN",
    "Infinity",
    "garbage",
    "1e3",
    "-1",
    "0",
    "0x10",
    " 1",
    "1." + "1".repeat(40),
    "123." + "1".repeat(38),
  ])
    assert.equal(schema.safeParse(invalid).success, false, String(invalid));
  assert.equal(
    costSizingRequestSchema.shape.stop.safeParse("21121.1234567").success,
    false,
  );
  assert.equal(schema.safeParse("1.1234567").success, true);
});

for (const cancelled of [false, true])
  test(`CSB-10 visible future corporate action, cancelled=${cancelled}`, () => {
    const f = fixture(),
      at = f.selection.frameAsOf;
    const action = {
      eventId: "known-split",
      revision: 1,
      announcedAt: at - 2000,
      availableAt: at - 2000,
      effectiveAt: at + 300000,
      kind: "SPLIT" as const,
      ratio: "2",
      cancelled: false,
    };
    f.input.histories[0]!.actions.push(action);
    if (cancelled)
      f.input.histories[0]!.actions.push({
        ...action,
        revision: 2,
        availableAt: at - 1000,
        cancelled: true,
      });
    if (!cancelled)
      assert.throws(() => program(f), /PORTFOLIO_ACTION_WINDOW_UNSUPPORTED/);
    else {
      const p = program(f),
        { repo, store } = opened(p);
      try {
        assert.ok(p.prepareEntry(store).candidate.quantity > 0);
      } finally {
        repo.close();
      }
    }
  });

test("CSB-11 stale selected quote blocks entry even when the historical chart signals", () => {
  const f = fixture(),
    q = f.input.frames[0]!.market!.records.find(
      (r) => r.assetKey === "REPLAY-KR-B" && r.kind === "QUOTE",
    )!;
  q.observedAt = new Date(f.selection.frameAsOf - 60000).toISOString();
  assert.throws(() => program(f), /COST_SIGNAL_HOLD/);
});
