import { z } from "zod";
import profile from "../../profiles/synthetic-v1.json" with { type: "json" };
import { completedRiskWindow } from "./calendar.js";
import type { CompletedRiskWindow } from "./calendar.js";
import { ceil, d, max, sum } from "./math.js";
import { configSchema, hash, policy, policyHash } from "./policy.js";
import type { State } from "./types.js";

export const operatingCostContract = "OPERATING_COST_TEST_HISTORY_V1";

// 입력 크기 제한은 투자 한도가 아니다. 10,000개 × 30자리 합계와 나눗셈을
// 기존 40자리 Decimal 정밀도 안에서 손실 없이 심사하기 위한 합성 계약이다.
const amountSchema = z
  .string()
  .max(30)
  .regex(/^(0|[1-9][0-9]*)$/);
const timeSchema = z
  .number()
  .int()
  .safe()
  .min(-8_640_000_000_000_000)
  .max(8_640_000_000_000_000);
const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const costSchema = z
  .object({
    id: idSchema,
    kind: z.literal("OPERATING"),
    currency: z.literal("KRW"),
    amount: amountSchema,
    occurredAt: timeSchema,
    availableAt: timeSchema,
  })
  .strict();
// TEST_ONLY 완료 의도 집계 선언이며 실제 체결 원천/귀속/청산 대조가 아니다.
// 실제 원장 변환이나 AT-C07의 부분체결·최종 청산 검증을 대신하지 않는다.
const closedIntentSchema = z
  .object({
    entryIntentId: idSchema,
    closedAt: timeSchema,
    availableAt: timeSchema,
    buyQuantity: z.number().int().safe().positive(),
    sellQuantity: z.number().int().safe().positive(),
    allOrdersTerminal: z.literal(true),
  })
  .strict()
  .refine((value) => value.buyQuantity === value.sellQuantity);

// 실제 자료의 완전성·권한을 주장하는 입력 형식이 아니다. 호출자가 명시한
// TEST_ONLY 이력을 순수 계산에만 사용하며 원장·예약·학습 정답을 만들지 않는다.
export const operatingHistorySchema = z
  .object({
    purpose: z.literal("TEST_ONLY"),
    provenance: z.literal("SYNTHETIC_FIXTURE"),
    liveEnabled: z.literal(false),
    configHash: z.string().regex(/^[a-f0-9]{64}$/),
    riskEpoch: z.number().int().safe().nonnegative(),
    coverage: z
      .object({
        startInclusive: timeSchema,
        endExclusive: timeSchema,
        complete: z.literal(true),
        availableAt: timeSchema,
      })
      .strict(),
    costs: z.array(costSchema).max(10_000),
    closedIntents: z.array(closedIntentSchema).max(10_000),
    dailyBudgetKrw: amountSchema.nullable(),
    // 비영 증가분/D 중복 여부, 외화 환산, 환불은 계약 미결정이므로 보류한다.
    futureIncreaseKrw: z.literal("0"),
  })
  .strict();
export type OperatingHistory = z.infer<typeof operatingHistorySchema>;
export interface OperatingCostBinding {
  contract: typeof operatingCostContract;
  source: "SYNTHETIC_ZERO" | "EXPLICIT_TEST_HISTORY";
  evidenceHash: string;
  window: CompletedRiskWindow;
}
export interface OperatingCostAssessment {
  amount: string | null;
  reasons: string[];
  binding: OperatingCostBinding | null;
}

function hold(reason: string): OperatingCostAssessment {
  return {
    amount: null,
    reasons: ["OPERATING_COST_UNKNOWN", reason],
    binding: null,
  };
}

function uniqueRecords<T>(
  records: T[],
  key: (record: T) => string,
): T[] | null {
  const byId = new Map<string, { value: T; digest: string }>();
  for (const value of records) {
    const id = key(value),
      digest = hash(value),
      previous = byId.get(id);
    if (previous && previous.digest !== digest) return null;
    byId.set(id, { value, digest });
  }
  // 식별자는 위에서 ASCII로 제한했으므로 로케일별 정렬 차이를 만들지 않는다.
  return [...byId]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { value }]) => value);
}

function profileSupported(): boolean {
  return (
    profile.purpose === "TEST_ONLY" &&
    profile.provenance === "SYNTHETIC_FIXTURE" &&
    profile.liveForbidden === true &&
    profile.allowedModes.length === 2 &&
    profile.allowedModes.includes("PAPER") &&
    profile.allowedModes.includes("BACKTEST") &&
    profile.fees.fixedOperatingKrw === "0" &&
    profile.remainingDailyOperatingBudgetKrw === "0" &&
    profile.monthlyOperatingBudgetKrw === "0" &&
    profile.precision.digits === 40 &&
    profile.precision.rounding === "HALF_EVEN"
  );
}

const legacyZeroSchema = z
  .object({
    id: idSchema,
    amount: z.literal("0"),
    at: timeSchema,
    paid: z.boolean(),
  })
  .strict();

export function resolveOperatingCost(
  s: State,
  history?: unknown,
): OperatingCostAssessment {
  try {
    if (
      !configSchema.safeParse(s.config).success ||
      !Number.isSafeInteger(s.epoch) ||
      s.epoch < 0
    )
      return hold("OPERATING_STATE_INVALID");
    if (
      policy.live_enabled !== false ||
      policy.mode_contract.execution_adapter !== "NONE" ||
      policy.economic_gate.unknown_cost_action !== "ABSTAIN" ||
      policy.economic_gate.operating_cost_estimation !==
        "CEIL_PERIOD_TOTAL_COST_DIV_TOTAL_COMPLETED_TRADES" ||
      policy.economic_gate.zero_trade_cost_estimation !==
        "MAX_PERIOD_COST_AND_APPROVED_REMAINING_DAILY_BUDGET"
    )
      return hold("OPERATING_POLICY_UNSUPPORTED");
    if (!profileSupported()) return hold("OPERATING_PROFILE_UNSUPPORTED");

    let window: CompletedRiskWindow;
    try {
      window = completedRiskWindow(s.clock);
    } catch {
      return hold("OPERATING_WINDOW_INVALID");
    }
    // V1 원장은 종류·가용시각·예약 연결을 증명하지 못한다. 명백한 0원
    // 표식만 허용하며 비영 원장이나 예약을 합성 과거 이력으로 덮지 않는다.
    const legacy = z
      .array(legacyZeroSchema)
      .max(10_000)
      .safeParse(s.ledger.costs);
    if (
      !legacy.success ||
      legacy.data.some((entry) => entry.at > s.clock) ||
      uniqueRecords(legacy.data, (entry) => entry.id) === null
    )
      return hold("OPERATING_LEGACY_UNCLASSIFIED");
    if (s.ledger.operationsReserved !== "0")
      return hold("OPERATING_RESERVATION_UNSUPPORTED");

    const context = {
      contract: operatingCostContract,
      policyHash,
      profileHash: hash(profile),
      configHash: hash(s.config),
      riskEpoch: s.epoch,
      window,
    };
    if (history === undefined) {
      // 기존 데모의 명시적 무비용 선언이다. 실제 20일 관측/수집의 대체가 아니다.
      const source = "SYNTHETIC_ZERO" as const;
      return {
        amount: "0",
        reasons: [],
        binding: {
          contract: operatingCostContract,
          source,
          evidenceHash: hash({
            ...context,
            source,
            declaredOperatingCostKrw: "0",
          }),
          window,
        },
      };
    }

    const parsed = operatingHistorySchema.safeParse(history);
    if (!parsed.success) return hold("OPERATING_HISTORY_INVALID");
    const evidence = parsed.data;
    if (
      evidence.configHash !== context.configHash ||
      evidence.riskEpoch !== s.epoch
    )
      return hold("OPERATING_CONTEXT_CHANGED");
    if (
      evidence.coverage.startInclusive !== window.startInclusive ||
      evidence.coverage.endExclusive !== window.endExclusive
    )
      return hold("OPERATING_COVERAGE_INCOMPLETE");
    if (
      evidence.coverage.availableAt < window.endExclusive ||
      evidence.coverage.availableAt > s.clock ||
      evidence.costs.some(
        (entry) =>
          entry.occurredAt > s.clock ||
          entry.availableAt < entry.occurredAt ||
          entry.availableAt > s.clock,
      ) ||
      evidence.closedIntents.some(
        (entry) =>
          entry.closedAt > s.clock ||
          entry.availableAt < entry.closedAt ||
          entry.availableAt > s.clock,
      )
    )
      return hold("OPERATING_AVAILABILITY_INVALID");

    const costs = uniqueRecords(evidence.costs, (entry) => entry.id);
    const closedIntents = uniqueRecords(
      evidence.closedIntents,
      (entry) => entry.entryIntentId,
    );
    if (costs === null || closedIntents === null)
      return hold("OPERATING_DUPLICATE_CONTENT_CONFLICT");
    const contains = (at: number) =>
      at >= window.startInclusive && at < window.endExclusive;
    const includedCosts = costs.filter((entry) => contains(entry.occurredAt));
    const completed = closedIntents.filter((entry) => contains(entry.closedAt));
    // 기간 완전성 확인보다 나중에야 알 수 있던 포함 기록은 당시 확인의
    // 일부일 수 없다. 최신 가용성으로 다시 완전성을 확인한 선언이 필요하다.
    if (
      includedCosts.some(
        (entry) => entry.availableAt > evidence.coverage.availableAt,
      ) ||
      completed.some(
        (entry) => entry.availableAt > evidence.coverage.availableAt,
      )
    )
      return hold("OPERATING_AVAILABILITY_INVALID");
    const total = sum(includedCosts.map((entry) => entry.amount));
    if (!completed.length && evidence.dailyBudgetKrw === null)
      return hold("OPERATING_DAILY_BUDGET_UNKNOWN");
    const amount = completed.length
      ? ceil(total.div(completed.length))
      : max(total, d(evidence.dailyBudgetKrw!)).toFixed(0);
    const source = "EXPLICIT_TEST_HISTORY" as const;
    return {
      amount,
      reasons: [],
      binding: {
        contract: operatingCostContract,
        source,
        evidenceHash: hash({
          ...context,
          source,
          evidence: { ...evidence, costs, closedIntents },
          totalOperatingKrw: total.toFixed(0),
          completedIntentCount: completed.length,
          amount,
        }),
        window,
      },
    };
  } catch {
    return hold("OPERATING_INPUT_INVALID");
  }
}
