import { test } from "node:test";
import assert from "node:assert/strict";
import profile from "../profiles/synthetic-v1.json" with { type: "json" };
import { completedRiskWindow } from "../src/core/calendar.js";
import {
  operatingCostContract,
  operatingHistorySchema,
  resolveOperatingCost,
} from "../src/core/operating-cost.js";
import type { OperatingHistory } from "../src/core/operating-cost.js";
import { hash, policy } from "../src/core/policy.js";
import type { State } from "../src/core/types.js";
import { state } from "./helpers.js";

function fixture(s: State, total = "10", completed = 3): OperatingHistory {
  const window = completedRiskWindow(s.clock);
  return {
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    liveEnabled: false,
    configHash: hash(s.config),
    riskEpoch: s.epoch,
    coverage: {
      startInclusive: window.startInclusive,
      endExclusive: window.endExclusive,
      complete: true,
      availableAt: window.endExclusive,
    },
    costs: [
      {
        id: "cost-1",
        kind: "OPERATING",
        currency: "KRW",
        amount: total,
        occurredAt: window.startInclusive,
        availableAt: window.endExclusive,
      },
    ],
    closedIntents: Array.from({ length: completed }, (_, i) => ({
      entryIntentId: `intent-${i}`,
      closedAt: window.startInclusive + i,
      availableAt: window.endExclusive,
      buyQuantity: 5,
      sellQuantity: 5,
      allOrdersTerminal: true,
    })),
    dailyBudgetKrw: "0",
    futureIncreaseKrw: "0",
  };
}

function assertHold(s: State, history: unknown, reason: string) {
  const before = hash(s),
    result = resolveOperatingCost(s, history);
  assert.equal(result.amount, null);
  assert.equal(result.binding, null);
  assert.deepEqual(result.reasons, ["OPERATING_COST_UNKNOWN", reason]);
  assert.equal(
    hash(s),
    before,
    "보류는 원장·주문·예약·상태를 변경하지 않는다.",
  );
}

test("OPS-01 기존 KR/US·PAPER/BACKTEST 무비용 데모는 명시 합성 출처", () => {
  for (const market of ["KR", "US"] as const) {
    for (const mode of ["PAPER", "BACKTEST"] as const) {
      const s = state({ market, mode }),
        before = hash(s);
      const result = resolveOperatingCost(s);
      assert.equal(result.amount, "0");
      assert.deepEqual(result.reasons, []);
      assert.equal(result.binding!.source, "SYNTHETIC_ZERO");
      assert.equal(result.binding!.contract, operatingCostContract);
      assert.equal(result.binding!.window.riskDayIds.length, 20);
      assert.equal(hash(s), before);
    }
  }
});

test("OPS-02 O=10/N=3 후보 4원은 새 비용·예약·학습 기록을 만들지 않음", () => {
  const s = state(),
    history = fixture(s),
    before = hash(s),
    rawBefore = hash(history);
  const result = resolveOperatingCost(s, history);
  assert.equal(result.amount, "4");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.binding!.source, "EXPLICIT_TEST_HISTORY");
  assert.notEqual(
    result.binding!.evidenceHash,
    resolveOperatingCost(s).binding!.evidenceHash,
  );
  assert.equal(hash(s), before);
  assert.equal(hash(history), rawBefore);
});

for (const [O, D, expected] of [
  ["10", "25", "25"],
  ["30", "25", "30"],
  ["0", "0", "0"],
] as const) {
  test(`OPS-03 N=0: max(O=${O}, D=${D})=${expected}`, () => {
    const s = state(),
      history = fixture(s, O, 0);
    history.dailyBudgetKrw = D;
    assert.equal(resolveOperatingCost(s, history).amount, expected);
  });
}

test("OPS-04 미확인 D는 N=0일 때 보류하며 알려진 0과 구분", () => {
  const s = state(),
    history = fixture(s, "10", 0);
  history.dailyBudgetKrw = null;
  assertHold(s, history, "OPERATING_DAILY_BUDGET_UNKNOWN");
  const withCompleted = fixture(s);
  withCompleted.dailyBudgetKrw = null;
  assert.equal(resolveOperatingCost(s, withCompleted).amount, "4");
});

test("OPS-05 비용과 완료 의도는 같은 [시작 포함, 종료 제외) 창을 사용", () => {
  const s = state(),
    history = fixture(s),
    { startInclusive: start, endExclusive: end } = completedRiskWindow(s.clock);
  history.costs = [
    {
      ...history.costs[0]!,
      id: "before",
      amount: "100",
      occurredAt: start - 1,
    },
    { ...history.costs[0]!, id: "start", amount: "10", occurredAt: start },
    { ...history.costs[0]!, id: "last", amount: "20", occurredAt: end - 1 },
    { ...history.costs[0]!, id: "current", amount: "100", occurredAt: end },
  ];
  const closed = history.closedIntents[0]!;
  history.closedIntents = [
    { ...closed, entryIntentId: "before", closedAt: start - 1 },
    { ...closed, entryIntentId: "start", closedAt: start },
    { ...closed, entryIntentId: "last", closedAt: end - 1 },
    { ...closed, entryIntentId: "current", closedAt: end },
  ];
  assert.equal(resolveOperatingCost(s, history).amount, "15");
});

test("OPS-06 주말을 포함한 완료20일 창은 같은 위험일 안에서 움직이지 않음", () => {
  const s = state(),
    history = fixture(s),
    first = resolveOperatingCost(s, history);
  s.clock += 60_000;
  assert.deepEqual(resolveOperatingCost(s, history), first);
  s.clock += 86_400_000;
  assertHold(s, history, "OPERATING_COVERAGE_INCOMPLETE");
});

test("OPS-07 동일 의도 전체 청산은 수량·부분체결 개수와 무관하게 N=1", () => {
  const s = state(),
    history = fixture(s, "7", 1);
  const full = history.closedIntents[0]!;
  history.closedIntents = [full, structuredClone(full), structuredClone(full)];
  assert.equal(resolveOperatingCost(s, history).amount, "7");
  history.closedIntents = [{ ...full, buyQuantity: 3, sellQuantity: 3 }];
  assert.equal(resolveOperatingCost(s, history).amount, "7");
  history.closedIntents = [];
  assert.equal(
    resolveOperatingCost(s, history).amount,
    "7",
    "무거래 비용도 O에서 삭제하지 않는다.",
  );
});

test("OPS-08 동일 ID 동일 내용 재수신과 입력 순서는 금액·해시에 무효과", () => {
  const s = state(),
    history = fixture(s),
    initial = resolveOperatingCost(s, history);
  history.costs.push(structuredClone(history.costs[0]!));
  history.closedIntents.push(structuredClone(history.closedIntents[0]!));
  history.costs.reverse();
  history.closedIntents.reverse();
  assert.deepEqual(resolveOperatingCost(s, history), initial);
});

test("OPS-09 동일 ID의 비용·시각·청산 수량 충돌은 조용히 덮지 않고 보류", () => {
  const s = state();
  for (const difference of [
    { amount: "51" },
    { occurredAt: completedRiskWindow(s.clock).startInclusive + 1 },
  ]) {
    const history = fixture(s, "50", 1);
    history.costs.push({ ...history.costs[0]!, ...difference });
    assertHold(s, history, "OPERATING_DUPLICATE_CONTENT_CONFLICT");
  }
  const history = fixture(s);
  history.closedIntents.push({
    ...history.closedIntents[0]!,
    buyQuantity: 4,
    sellQuantity: 4,
  });
  assertHold(s, history, "OPERATING_DUPLICATE_CONTENT_CONFLICT");
});

test("OPS-10 0체결·미청산·미최종 주문·비정수 수량 선언은 완료로 인정하지 않음", () => {
  const s = state(),
    history = fixture(s);
  for (const difference of [
    { buyQuantity: 0, sellQuantity: 0 },
    { sellQuantity: 4 },
    { allOrdersTerminal: false },
    { buyQuantity: 1.5, sellQuantity: 1.5 },
    {
      buyQuantity: Number.MAX_SAFE_INTEGER + 1,
      sellQuantity: Number.MAX_SAFE_INTEGER + 1,
    },
  ]) {
    assertHold(
      s,
      {
        ...history,
        closedIntents: [{ ...history.closedIntents[0], ...difference }],
      },
      "OPERATING_HISTORY_INVALID",
    );
  }
});

test("OPS-11 미래 발생·늦은 이용 가능 시각·역전된 시각은 과거에 소급하지 않음", () => {
  const s = state(),
    history = fixture(s),
    cost = history.costs[0]!,
    closed = history.closedIntents[0]!;
  for (const difference of [
    { costs: [{ ...cost, occurredAt: s.clock + 1, availableAt: s.clock + 1 }] },
    { costs: [{ ...cost, availableAt: s.clock + 1 }] },
    { costs: [{ ...cost, availableAt: cost.occurredAt - 1 }] },
    {
      closedIntents: [
        { ...closed, closedAt: s.clock + 1, availableAt: s.clock + 1 },
      ],
    },
    { closedIntents: [{ ...closed, availableAt: s.clock + 1 }] },
    { closedIntents: [{ ...closed, availableAt: closed.closedAt - 1 }] },
    { coverage: { ...history.coverage, availableAt: s.clock + 1 } },
    {
      coverage: {
        ...history.coverage,
        availableAt: history.coverage.endExclusive - 1,
      },
    },
  ]) {
    assertHold(
      s,
      { ...history, ...difference },
      "OPERATING_AVAILABILITY_INVALID",
    );
  }
  history.costs[0]!.availableAt = s.clock;
  history.closedIntents[0]!.availableAt = s.clock;
  history.coverage.availableAt = s.clock;
  assert.equal(resolveOperatingCost(s, history).amount, "4");
});

test("OPS-12 부분 이력과 누락된 완전성은 0원 관측으로 채우지 않음", () => {
  const s = state(),
    history = fixture(s);
  assertHold(
    s,
    {
      ...history,
      coverage: {
        ...history.coverage,
        startInclusive: history.coverage.startInclusive + 1,
      },
    },
    "OPERATING_COVERAGE_INCOMPLETE",
  );
  assertHold(
    s,
    { ...history, coverage: { ...history.coverage, complete: false } },
    "OPERATING_HISTORY_INVALID",
  );
  assertHold(s, { ...history, coverage: null }, "OPERATING_HISTORY_INVALID");
});

test("OPS-12b 포함 자료를 알기 전에 기록한 완전성 확인은 재사용 불가", () => {
  const s = state(),
    history = fixture(s);
  history.costs[0]!.availableAt = history.coverage.availableAt + 1;
  assertHold(s, history, "OPERATING_AVAILABILITY_INVALID");
  history.costs[0]!.availableAt = history.coverage.availableAt;
  history.closedIntents[0]!.availableAt = history.coverage.availableAt + 1;
  assertHold(s, history, "OPERATING_AVAILABILITY_INVALID");
  history.coverage.availableAt += 1;
  assert.equal(resolveOperatingCost(s, history).amount, "4");
});

test("OPS-13 계정 구성·모드·위험 epoch가 바뀌면 기존 합성 이력도 재승인 필요", () => {
  const s = state(),
    history = fixture(s);
  assertHold(
    s,
    { ...history, riskEpoch: s.epoch + 1 },
    "OPERATING_CONTEXT_CHANGED",
  );
  assertHold(
    s,
    { ...history, configHash: hash({ ...s.config, market: "US" }) },
    "OPERATING_CONTEXT_CHANGED",
  );
  const before = resolveOperatingCost(s).binding!.evidenceHash;
  s.epoch += 1;
  assert.notEqual(resolveOperatingCost(s).binding!.evidenceHash, before);
  assertHold(s, history, "OPERATING_CONTEXT_CHANGED");
});

test("OPS-14 외화·환불·추가 증가분·실자료·추가 명령 필드는 strict 보류", () => {
  const s = state(),
    history = fixture(s);
  for (const difference of [
    { purpose: "PRODUCTION" },
    { provenance: "TOSS_API" },
    { liveEnabled: true },
    { futureIncreaseKrw: "1" },
    { futureIncreaseKrw: null },
    { futureIncreaseKrw: undefined },
    { execute: "buy" },
    { costs: [{ ...history.costs[0], currency: "USD" }] },
    { costs: [{ ...history.costs[0], kind: "TRADING" }] },
    { costs: [{ ...history.costs[0], refundOf: "old-cost" }] },
  ]) {
    assertHold(s, { ...history, ...difference }, "OPERATING_HISTORY_INVALID");
  }
  assertHold(s, null, "OPERATING_HISTORY_INVALID");
});

test("OPS-15 금액은 한정된 정수 십진 문자열만 허용하며 NaN·무한대·지수 거절", () => {
  const s = state(),
    history = fixture(s);
  for (const amount of [
    "-1",
    "0.1",
    "NaN",
    "Infinity",
    "1e3",
    "01",
    "+1",
    " 1",
    "1 ",
    "",
    "9".repeat(31),
    1,
    null,
  ]) {
    assertHold(
      s,
      { ...history, costs: [{ ...history.costs[0], amount }] },
      "OPERATING_HISTORY_INVALID",
    );
    // 비용 금액 null은 잘못된 자료지만 D=null은 유효한 '미확인' 표현이다.
    // N>0에서는 D를 사용하지 않으며 N=0 보류 여부는 OPS-04가 검증한다.
    if (amount !== null)
      assertHold(
        s,
        { ...history, dailyBudgetKrw: amount },
        "OPERATING_HISTORY_INVALID",
      );
  }
});

test("OPS-16 크기 제한 내 큰 금액 합계·올림은 JS number 정밀도에 의존하지 않음", () => {
  const s = state(),
    amount = "999999999999999999999999999999",
    history = fixture(s, amount, 7);
  history.costs = Array.from({ length: 100 }, (_, i) => ({
    ...history.costs[0]!,
    id: `cost-${i}`,
  }));
  const expected = (BigInt(amount) * 100n + 6n) / 7n;
  assert.equal(resolveOperatingCost(s, history).amount, expected.toString());
});

test("OPS-17 배열·식별자·시각 크기/형식 제한을 벗어나면 보류", () => {
  const s = state(),
    history = fixture(s);
  for (const difference of [
    { costs: Array.from({ length: 10_001 }, () => history.costs[0]) },
    {
      closedIntents: Array.from(
        { length: 10_001 },
        () => history.closedIntents[0],
      ),
    },
    { costs: [{ ...history.costs[0], id: "x".repeat(129) }] },
    { costs: [{ ...history.costs[0], occurredAt: 0.5 }] },
    { costs: [{ ...history.costs[0], availableAt: Infinity }] },
    {
      coverage: {
        ...history.coverage,
        startInclusive: Number.MAX_SAFE_INTEGER,
      },
    },
  ]) {
    assert.equal(
      operatingHistorySchema.safeParse({ ...history, ...difference }).success,
      false,
    );
    assertHold(s, { ...history, ...difference }, "OPERATING_HISTORY_INVALID");
  }
});

test("OPS-18 정상 레거시 0원 표식만 무효과이며 비용의 분류를 추측하지 않음", () => {
  const s = state(),
    history = fixture(s),
    initial = resolveOperatingCost(s, history);
  s.ledger.costs = [
    { id: "flow:deposit", amount: "0", at: s.clock, paid: true },
  ];
  assert.deepEqual(resolveOperatingCost(s, history), initial);
  assert.equal(resolveOperatingCost(s).amount, "0");
  for (const amount of ["1", "-1", "NaN", "0.0"]) {
    s.ledger.costs[0]!.amount = amount;
    assertHold(s, undefined, "OPERATING_LEGACY_UNCLASSIFIED");
    assertHold(s, history, "OPERATING_LEGACY_UNCLASSIFIED");
  }
});

test("OPS-19 레거시 필드 누락·미래 표식·중복 충돌은 기존 0 선언을 통과하지 못함", () => {
  const s = state();
  s.ledger.costs = [{ id: "zero", amount: "0", at: s.clock + 1, paid: true }];
  assertHold(s, undefined, "OPERATING_LEGACY_UNCLASSIFIED");
  s.ledger.costs = [
    { id: "zero", amount: "0", at: s.clock, paid: true },
    { id: "zero", amount: "0", at: s.clock - 1, paid: true },
  ];
  assertHold(s, undefined, "OPERATING_LEGACY_UNCLASSIFIED");
  s.ledger.costs = [
    { id: "zero", amount: "0", paid: true } as State["ledger"]["costs"][number],
  ];
  assertHold(s, undefined, "OPERATING_LEGACY_UNCLASSIFIED");
});

test("OPS-20 비영·잘못된 예약은 후보 추정으로 대체하거나 해제하지 않음", () => {
  const s = state(),
    history = fixture(s);
  for (const amount of ["1", "-1", "NaN", "0.0", ""]) {
    s.ledger.operationsReserved = amount;
    assertHold(s, history, "OPERATING_RESERVATION_UNSUPPORTED");
    assertHold(s, undefined, "OPERATING_RESERVATION_UNSUPPORTED");
  }
});

test("OPS-21 지원하지 않는 프로필·원본 산식·시각 계약은 보류", () => {
  const s = state(),
    history = fixture(s),
    original = profile.fees.fixedOperatingKrw;
  try {
    profile.fees.fixedOperatingKrw = "1";
    assertHold(s, history, "OPERATING_PROFILE_UNSUPPORTED");
    assertHold(s, undefined, "OPERATING_PROFILE_UNSUPPORTED");
  } finally {
    profile.fees.fixedOperatingKrw = original;
  }
  const estimation = policy.economic_gate.operating_cost_estimation;
  try {
    policy.economic_gate.operating_cost_estimation = "ROLLING_AVERAGE";
    assertHold(s, history, "OPERATING_POLICY_UNSUPPORTED");
  } finally {
    policy.economic_gate.operating_cost_estimation = estimation;
  }
  s.clock = NaN;
  assertHold(s, undefined, "OPERATING_WINDOW_INVALID");
});

test("OPS-22 미설정 상태·실거래 모드·비정상 epoch는 무비용으로 통과하지 않음", () => {
  const s = state();
  s.config = null;
  assertHold(s, undefined, "OPERATING_STATE_INVALID");
  const live = state();
  Object.assign(live.config!, { mode: "LIVE" });
  assertHold(live, undefined, "OPERATING_STATE_INVALID");
  const fractional = state();
  fractional.epoch = 1.5;
  assertHold(fractional, undefined, "OPERATING_STATE_INVALID");
});
