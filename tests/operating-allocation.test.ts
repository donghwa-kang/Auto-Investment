import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortfolioProgram } from "../src/core/portfolio-program.js";
import { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import { portfolioFixture, laterTick } from "../src/core/portfolio-fixture.js";
import { exportPaperLearning } from "../src/server/paper-learning-export.js";
import { verifyPaperExport } from "../src/core/paper-learning-verify.js";
import type { PaperExport } from "../src/core/paper-learning-schema.js";
import { bindSnapshot, hash } from "../src/core/policy.js";
import { derivePaperRows } from "../src/core/paper-learning-convert.js";
import { d } from "../src/core/math.js";
import {
  assessOperatingAllocationAvailability,
  buildOperatingAllocation,
} from "../src/core/operating-allocation.js";
import { replayOperatingJournal } from "../src/core/operating-journal.js";
import { replayFixture } from "./signal-replay-helpers.js";
import { resign } from "./learning-bridge-helpers.js";

const fixtureInput = replayFixture(),
  fixture = portfolioFixture(fixtureInput),
  program = new PortfolioProgram(fixtureInput, fixture.settings),
  path = join(
    mkdtempSync(join(tmpdir(), "operating-allocation-")),
    "paper.sqlite",
  ),
  engine = new PortfolioPaperEngine(program, path, { captureLearning: true });
try {
  for (const [index, command] of fixture.commands.entries())
    engine.command(`allocation-${index}`, command);
} finally {
  engine.close();
}
const source = exportPaperLearning(path);

function input(paper = source, amounts = ["11"]) {
  return {
    schemaVersion: "OPERATING_ALLOCATION_TEST_V1" as const,
    purpose: "TEST_ONLY" as const,
    provenance: "SYNTHETIC_FIXTURE" as const,
    liveEnabled: false as const,
    corrections: "NONE_DECLARED" as const,
    period: {
      periodId: "test-period",
      startInclusive: paper.journal.startedAt,
      endExclusive: paper.asOf,
      finalizedAt: paper.asOf,
      availableAt: paper.asOf,
      complete: true as const,
    },
    journal: {
      schemaVersion: "OPERATING_JOURNAL_TEST_V1" as const,
      purpose: "TEST_ONLY" as const,
      provenance: "SYNTHETIC_FIXTURE" as const,
      liveEnabled: false as const,
      runHash: paper.journal.runHash,
      policyHash: paper.journal.policyHash,
      startedAt: paper.journal.startedAt,
      asOf: paper.asOf,
      openingCashKrw: "1000",
      startsEmpty: true as const,
      complete: true as const,
      events: amounts.map((amountKrw, index) => ({
        eventId: `test-cost-${index}`,
        sequence: index + 1,
        kind: "RECOGNIZE" as const,
        occurredAt: paper.journal.startedAt,
        availableAt: paper.journal.startedAt,
        obligationId: `test-obligation-${index}`,
        reservationId: null,
        amountKrw,
      })),
    },
    paperExport: structuredClone(paper),
  };
}

// 세 번째 산술 표본은 엔진 기록의 ID를 분리한 명시 합성 복제다.
// 세 거래를 실제 엔진이 실행했다거나 감사 서명을 검증했다는 의미가 아니다.
function withThirdSyntheticTrade() {
  const paper = structuredClone(source),
    position = structuredClone(paper.positions[0]!),
    originalPositionId = position.id,
    originalIntentId = position.intentId,
    orders = paper.orders
      .filter((order) => order.positionId === originalPositionId)
      .map((order) => structuredClone(order)),
    buy = orders.find((order) => order.side === "BUY")!,
    decision = structuredClone(
      paper.journal.decisions.find(
        (entry) => entry.id === buy.snapshot!.signal_id,
      )!,
    ),
    suffix = (id: string) => `${id}:extra`;
  position.id = suffix(position.id);
  position.intentId = suffix(position.intentId);
  decision.id = suffix(decision.id);
  for (const order of orders) {
    order.id = suffix(order.id);
    order.positionId = position.id;
    order.intentId =
      order.intentId === originalIntentId
        ? position.intentId
        : suffix(order.intentId);
    order.eventIds = order.eventIds.map(suffix);
    if (order.side === "BUY") {
      order.snapshot!.signal_id = decision.id;
      order.snapshotHash = bindSnapshot(order.snapshot!);
      decision.snapshotHash = order.snapshotHash;
    }
  }
  const fills = paper.journal.fills
    .filter((fill) => fill.positionId === originalPositionId)
    .map((fill) => ({
      ...fill,
      id: suffix(fill.id),
      commandId: suffix(fill.commandId),
      positionId: position.id,
      orderId: suffix(fill.orderId),
    }));
  paper.journal.decisions.push(decision);
  paper.orders.push(...orders);
  paper.positions.push(position);
  paper.journal.fills.push(...fills);
  paper.journal.closures.push({
    ...paper.journal.closures.find(
      (closure) => closure.positionId === originalPositionId,
    )!,
    positionId: position.id,
  });
  return verifyPaperExport(resign(paper));
}

test("OCA-01 엔진 청산·수수료 대조 후 비용은 보고에만 배분", () => {
  const raw = input(),
    before = structuredClone(raw),
    bytes = readFileSync(path),
    journalBefore = replayOperatingJournal(raw.journal),
    report = buildOperatingAllocation(raw);
  assert.equal(source.journal.closures.length, 2);
  assert.ok(source.journal.fills.length > 4);
  assert.equal(report.completedTrades, 2);
  assert.deepEqual(
    report.allocations.map((allocation) => allocation.operatingCostKrw),
    ["6", "5"],
  );
  assert.equal(report.totalOperatingKrw, "11");
  for (const allocation of report.allocations)
    assert.equal(
      allocation.netPnlKrw,
      d(allocation.tradingNetPnlKrw)
        .minus(allocation.operatingCostKrw)
        .toString(),
    );
  assert.equal(report.accountMutationAllowed, false);
  assert.equal(report.actualLearningAllowed, false);
  assert.deepEqual(raw, before);
  assert.deepEqual(replayOperatingJournal(raw.journal), journalBefore);
  assert.deepEqual(readFileSync(path), bytes);
});

test("OCA-02 명시 합성 O10/N3은 4/3/3이며 후보 올림 4를 반복하지 않음", () => {
  const report = buildOperatingAllocation(
    input(withThirdSyntheticTrade(), ["10"]),
  );
  assert.deepEqual(
    report.allocations.map((entry) => entry.operatingCostKrw),
    ["4", "3", "3"],
  );
  assert.equal(report.unallocatedKrw, "0");
});

test("OCA-03 거래 입력 순서가 달라도 ASCII ID 순 나머지 배분 동일", () => {
  const raw = input(withThirdSyntheticTrade(), ["10"]),
    expected = buildOperatingAllocation(raw);
  raw.paperExport.positions.reverse();
  raw.paperExport.orders.reverse();
  raw.paperExport.journal.closures.reverse();
  raw.paperExport.journal.decisions.reverse();
  resign(raw.paperExport);
  const actual = buildOperatingAllocation(raw);
  assert.deepEqual(actual.allocations, expected.allocations);
  assert.notEqual(actual.paperExportHash, expected.paperExportHash);
  assert.notEqual(actual.reportHash, expected.reportHash);
});

test("OCA-04 큰 정수 합계·몫·나머지와 순손익 표시를 정확히 보존", () => {
  const amount = "999999999999999999999999999999",
    report = buildOperatingAllocation(
      input(withThirdSyntheticTrade(), [amount, amount]),
    ),
    total = BigInt(amount) * 2n;
  assert.equal(report.totalOperatingKrw, total.toString());
  assert.equal(
    report.allocations.reduce(
      (sum, row) => sum + BigInt(row.operatingCostKrw),
      0n,
    ),
    total,
  );
  for (const row of report.allocations)
    assert.equal(
      d(row.netPnlKrw).plus(row.operatingCostKrw).toString(),
      d(row.tradingNetPnlKrw).toString(),
    );
});

test("OCA-05 무거래 확정 기간은 비용 전액을 미배분으로 남김", () => {
  const raw = input();
  // 주문 전 구간만 선택한다. 미래에 제출된 의도는 이번 분모가 아니다.
  raw.period.endExclusive = Math.min(
    ...source.orders.map((order) => order.submittedAt),
  );
  if (raw.period.endExclusive === raw.period.startInclusive) {
    raw.journal.startedAt -= 1;
    raw.period.startInclusive -= 1;
    raw.journal.events[0]!.occurredAt -= 1;
    raw.journal.events[0]!.availableAt -= 1;
    raw.paperExport.journal.startedAt -= 1;
    resign(raw.paperExport);
  }
  const report = buildOperatingAllocation(raw);
  assert.equal(report.completedTrades, 0);
  assert.deepEqual(report.allocations, []);
  assert.equal(report.unallocatedKrw, "11");
});

test("OCA-06 비용 시작 정각 포함·종료 정각 제외", () => {
  const raw = input(source, ["11", "7"]);
  raw.journal.events[1]!.occurredAt = raw.period.endExclusive;
  raw.journal.events[1]!.availableAt = raw.period.endExclusive;
  const report = buildOperatingAllocation(raw);
  assert.equal(report.totalOperatingKrw, "11");
  assert.deepEqual(report.costEventIds, ["test-cost-0"]);
});

test("OCA-07 동일 비용 재수신 무효과·내용 충돌 거절", () => {
  const raw = input(),
    expected = buildOperatingAllocation(raw);
  raw.journal.events.push(structuredClone(raw.journal.events[0]!));
  const repeated = buildOperatingAllocation(raw);
  assert.deepEqual(repeated, expected);
  raw.journal.events[1]!.amountKrw = "12";
  assert.throws(() => buildOperatingAllocation(raw));
});

test("OCA-08 정책/실행 바인딩 불일치와 알 수 없는 필드 거절", () => {
  const raw = input();
  raw.journal.runHash = hash("different-run");
  assert.throws(() => buildOperatingAllocation(raw), /BINDING_MISMATCH/);
  assert.throws(
    () => buildOperatingAllocation({ ...input(), extra: true }),
    /INPUT_INVALID/,
  );
  const wrong = input();
  wrong.journal.policyHash = hash("different-policy");
  assert.throws(() => buildOperatingAllocation(wrong));
});

test("OCA-09 TEST_ONLY·명시 완전성·정정 없음 경계 유지", () => {
  for (const change of [
    { purpose: "LIVE" },
    { provenance: "REAL" },
    { liveEnabled: true },
    { corrections: "REFUND_PENDING" },
  ])
    assert.throws(
      () => buildOperatingAllocation({ ...input(), ...change }),
      /INPUT_INVALID/,
    );
  const raw = input();
  assert.throws(
    () =>
      buildOperatingAllocation({
        ...raw,
        period: { ...raw.period, complete: false },
      }),
    /INPUT_INVALID/,
  );
});

test("OCA-10 기간 역전·가용시각 역전·저널 coverage 밖 거절", () => {
  for (const change of [
    (raw: ReturnType<typeof input>) => {
      raw.period.endExclusive = raw.period.startInclusive;
    },
    (raw: ReturnType<typeof input>) => {
      raw.period.finalizedAt -= 1;
    },
    (raw: ReturnType<typeof input>) => {
      raw.period.availableAt -= 1;
    },
    (raw: ReturnType<typeof input>) => {
      raw.period.startInclusive -= 1;
    },
    (raw: ReturnType<typeof input>) => {
      raw.journal.asOf -= 1;
    },
  ]) {
    const raw = input();
    change(raw);
    assert.throws(() => buildOperatingAllocation(raw), /PERIOD_INVALID/);
  }
});

test("OCA-11 확정 후 알게 된 기간 비용은 과거 보고에 쓰지 않음", () => {
  const raw = input();
  raw.journal.asOf += 2;
  raw.period.availableAt += 1;
  raw.journal.events[0]!.availableAt = raw.period.finalizedAt + 1;
  assert.throws(() => buildOperatingAllocation(raw), /PERIOD_INVALID/);
});

test("OCA-12 보고 시점보다 늦은 내보내기 스냅샷은 소급 사용 금지", () => {
  const raw = input();
  raw.paperExport.asOf += 1;
  resign(raw.paperExport);
  assert.throws(() => buildOperatingAllocation(raw), /PERIOD_INVALID/);
});

test("OCA-13 원장 비용은 0원 표식도 자동 운영비 분류하지 않음", () => {
  for (const amount of ["0", "1"]) {
    const raw = input();
    raw.paperExport.costs.push({
      id: "legacy",
      amount,
      at: raw.paperExport.asOf,
      paid: false,
    });
    resign(raw.paperExport);
    assert.throws(
      () => buildOperatingAllocation(raw),
      /LEGACY_COST_UNSUPPORTED/,
    );
  }
});

test("OCA-14 내보내기 해시 재작성도 체결/청산 변조를 통과시키지 못함", () => {
  for (const change of [
    (paper: PaperExport) => {
      paper.journal.fills[0]!.quantity++;
    },
    (paper: PaperExport) => {
      paper.journal.closures[0]!.netPnlKrw = "999";
    },
    (paper: PaperExport) => {
      paper.positions[1]!.intentId = paper.positions[0]!.intentId;
    },
    (paper: PaperExport) => {
      paper.positions.push(structuredClone(paper.positions[0]!));
    },
  ]) {
    const raw = input();
    change(raw.paperExport);
    resign(raw.paperExport);
    assert.throws(() => buildOperatingAllocation(raw), /PAPER_LEARNING/);
  }
});

test("OCA-15 열린 엔진 의도는 분모에서 조용히 제외하지 않음", () => {
  const openPath = join(
      mkdtempSync(join(tmpdir(), "operating-open-")),
      "paper.sqlite",
    ),
    openEngine = new PortfolioPaperEngine(program, openPath, {
      captureLearning: true,
    }),
    base = fixture.ticks[0]!;
  try {
    openEngine.command("start", { type: "start" });
    openEngine.command("frame", base);
    openEngine.command("t1", laterTick(base, 1));
    openEngine.command("t2", laterTick(base, 2));
    const raw = input(exportPaperLearning(openPath));
    assert.throws(() => buildOperatingAllocation(raw), /OPEN_INTENT|UNCLOSED/);
  } finally {
    openEngine.close();
  }
});

test("OCA-16 청산 종료 경계·진입 경계로 거래를 잘라 분모 축소 금지", () => {
  for (const boundary of ["entry", "exit"] as const) {
    const raw = input(),
      position = source.positions[0]!;
    if (boundary === "entry")
      raw.period.startInclusive = position.firstFillAt + 1;
    else raw.period.endExclusive = position.closedAt!;
    assert.throws(
      () => buildOperatingAllocation(raw),
      /UNCLOSED_OR_CROSS_PERIOD/,
    );
  }
});

test("OCA-17 미래 학습 기준 보류·정각 이후에도 실제 학습 허용 안 함", () => {
  const raw = input();
  raw.period.availableAt += 5;
  const report = buildOperatingAllocation(raw);
  assert.throws(
    () =>
      assessOperatingAllocationAvailability(
        raw,
        report.reportHash,
        raw.period.availableAt - 1,
      ),
    /NOT_AVAILABLE/,
  );
  const result = assessOperatingAllocationAvailability(
    raw,
    report.reportHash,
    raw.period.availableAt,
  );
  assert.equal(result.status, "AVAILABLE_TEST_ONLY");
  assert.equal(result.actualLearningAllowed, false);
  assert.equal(result.liveEnabled, false);
});

test("OCA-18 원자료·보고기간 변경 후 이전 보고 해시는 거절", () => {
  const raw = input(),
    report = buildOperatingAllocation(raw);
  raw.journal.events[0]!.amountKrw = "12";
  assert.throws(
    () =>
      assessOperatingAllocationAvailability(
        raw,
        report.reportHash,
        raw.period.availableAt,
      ),
    /REPORT_MISMATCH/,
  );
  const another = input();
  another.period.periodId = "different-period";
  assert.throws(
    () =>
      assessOperatingAllocationAvailability(
        another,
        report.reportHash,
        another.period.availableAt,
      ),
    /REPORT_MISMATCH/,
  );
});

test("OCA-19 미확정 예약은 기간 확정 선언만으로 지우지 않음", () => {
  const raw = input();
  const reserve = {
    eventId: "reserved-cost",
    sequence: 2,
    kind: "RESERVE",
    occurredAt: raw.journal.startedAt,
    availableAt: raw.journal.startedAt,
    obligationId: "future-cost",
    amountKrw: "5",
  };
  assert.throws(
    () =>
      buildOperatingAllocation({
        ...raw,
        journal: { ...raw.journal, events: [...raw.journal.events, reserve] },
      }),
    /RESERVATION_UNRESOLVED/,
  );
});

test("OCA-20 확정 시험 보고를 만들더라도 기존 학습 비용 보류 유지", () => {
  const raw = input(),
    order = raw.paperExport.orders.find((entry) => entry.side === "BUY")!,
    snapshot = order.snapshot!,
    binding = snapshot.operating_cost_binding;
  assert.ok(binding && typeof binding === "object");
  snapshot.operating_cost_binding = {
    ...binding,
    source: "EXPLICIT_TEST_HISTORY",
  };
  order.snapshotHash = bindSnapshot(snapshot);
  raw.paperExport.journal.decisions.find(
    (entry) => entry.id === snapshot.signal_id,
  )!.snapshotHash = order.snapshotHash;
  resign(raw.paperExport);
  const report = buildOperatingAllocation(raw),
    rows = derivePaperRows(raw.paperExport, "KR", "B");
  assert.equal(report.actualLearningAllowed, false);
  assert.ok(
    rows.diagnostics.some((row) =>
      row.reasons.includes("OPERATING_COST_ALLOCATION_UNSUPPORTED"),
    ),
  );
});

test("OCA-21 다른 시장 판단이 섞인 실행은 KR 보고로 강등하지 않음", () => {
  const raw = input(),
    decision = structuredClone(raw.paperExport.journal.decisions[0]!);
  decision.id = "us-abstain-fixture";
  decision.symbol = "US:TEST_ONLY";
  decision.result = "ABSTAIN";
  decision.quantity = 0;
  delete decision.snapshotHash;
  raw.paperExport.journal.decisions.push(decision);
  resign(raw.paperExport);
  assert.doesNotThrow(() => verifyPaperExport(raw.paperExport));
  assert.throws(() => buildOperatingAllocation(raw), /MARKET_UNSUPPORTED/);
});

test("OCA-22 지급은 기존 발생 비용 배분을 늘리지 않음", () => {
  const raw = input(),
    before = buildOperatingAllocation(raw),
    paidJournal = {
      ...raw.journal,
      events: [
        ...raw.journal.events,
        {
          eventId: "pay-cost",
          sequence: 2,
          kind: "PAY",
          occurredAt: raw.journal.startedAt + 1,
          availableAt: raw.journal.startedAt + 1,
          obligationId: "test-obligation-0",
          amountKrw: "11",
        },
      ],
    },
    after = buildOperatingAllocation({ ...raw, journal: paidJournal }),
    view = replayOperatingJournal(paidJournal);
  assert.deepEqual(after.allocations, before.allocations);
  assert.equal(after.totalOperatingKrw, "11");
  assert.equal(view.paidKrw, "11");
  assert.equal(view.cashKrw, "989");
  assert.equal(view.payableKrw, "0");
  assert.equal(view.netEquityKrw, "989");
});

test("OCA-23 미래 해제·지급·새 비용을 가진 저널은 과거 확정에 쓰지 않음", () => {
  const raw = input(),
    lateAt = raw.period.finalizedAt + 1,
    reserve = {
      eventId: "reserve-later-release",
      sequence: 2,
      kind: "RESERVE",
      occurredAt: raw.journal.startedAt + 1,
      availableAt: raw.journal.startedAt + 1,
      obligationId: "reserved-obligation",
      amountKrw: "5",
    };
  const eventSets = [
    [
      ...raw.journal.events,
      reserve,
      {
        eventId: "late-release",
        sequence: 3,
        kind: "RELEASE",
        occurredAt: lateAt,
        availableAt: lateAt,
        reservationId: reserve.eventId,
      },
    ],
    [
      ...raw.journal.events,
      {
        eventId: "late-payment",
        sequence: 2,
        kind: "PAY",
        occurredAt: lateAt,
        availableAt: lateAt,
        obligationId: "test-obligation-0",
        amountKrw: "11",
      },
    ],
    [
      ...raw.journal.events,
      {
        eventId: "late-cost",
        sequence: 2,
        kind: "RECOGNIZE",
        occurredAt: raw.period.endExclusive - 1,
        availableAt: lateAt,
        obligationId: "late-obligation",
        reservationId: null,
        amountKrw: "1",
      },
    ],
  ];
  for (const events of eventSets) {
    const journal = { ...raw.journal, asOf: lateAt, events };
    assert.doesNotThrow(() => replayOperatingJournal(journal));
    assert.throws(
      () => buildOperatingAllocation({ ...raw, journal }),
      /PERIOD_INVALID/,
    );
  }
});

test("OCA-24 시작 전 미해결 예약의 귀속을 임의로 기간 밖 처리하지 않음", () => {
  const raw = input(),
    earlier = raw.period.startInclusive - 1,
    journal = {
      ...raw.journal,
      startedAt: earlier,
      events: [
        {
          eventId: "carry-in-reservation",
          sequence: 1,
          kind: "RESERVE",
          occurredAt: earlier,
          availableAt: earlier,
          obligationId: "carry-in-obligation",
          amountKrw: "5",
        },
        { ...raw.journal.events[0]!, sequence: 2 },
      ],
    };
  assert.doesNotThrow(() => replayOperatingJournal(journal));
  assert.throws(
    () => buildOperatingAllocation({ ...raw, journal }),
    /RESERVATION_UNRESOLVED/,
  );
});

test("OCA-25 종료 정각의 신규 예약은 이전 반개구간 보고를 막지 않음", () => {
  const raw = input(),
    baseline = buildOperatingAllocation(raw),
    journal = {
      ...raw.journal,
      events: [
        ...raw.journal.events,
        {
          eventId: "next-period-reservation",
          sequence: 2,
          kind: "RESERVE",
          occurredAt: raw.period.endExclusive,
          availableAt: raw.period.endExclusive,
          obligationId: "next-period-obligation",
          amountKrw: "5",
        },
      ],
    },
    report = buildOperatingAllocation({ ...raw, journal });
  assert.equal(replayOperatingJournal(journal).reservedKrw, "5");
  assert.deepEqual(report.allocations, baseline.allocations);
  assert.equal(report.totalOperatingKrw, "11");
});
