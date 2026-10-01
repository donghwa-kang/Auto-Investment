import { z } from "zod";
import { d } from "./math.js";
import { hash } from "./policy.js";
import { profile, type Forecast } from "./risk.js";
import { researchAdmission, researchScope } from "./research-scope.js";
export interface ForecastInput {
  quantity: number;
  R0: string;
  cost: string;
  at: number;
  deadline: number;
  horizon: number;
  inputHash: string;
}
export interface ForecastProvider {
  forecast(input: ForecastInput): Forecast | null;
}
export class MissingForecast implements ForecastProvider {
  forecast(_input: ForecastInput) {
    return null;
  }
}
export class SyntheticForecast implements ForecastProvider {
  forecast(i: ForecastInput): Forecast {
    return {
      purpose: "TEST_ONLY",
      quantity: i.quantity,
      currency: "KRW",
      horizon: i.horizon,
      inputHash: i.inputHash,
      profileHash: hash(profile.forecast),
      asOf: i.at,
      validUntil: i.deadline,
      gross: d(i.R0).mul(profile.forecast.expectedGrossR).toString(),
      q05: d(i.R0).mul(profile.forecast.q05NetR).toString(),
      cost: i.cost,
    };
  }
}
const decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .refine((v) => d(v).isFinite());
const forecastSchema = z
  .object({
    purpose: z.literal("TEST_ONLY"),
    quantity: z.number().int().positive(),
    currency: z.literal("KRW"),
    horizon: z.number().positive(),
    inputHash: z.string(),
    profileHash: z.string(),
    asOf: z.number(),
    validUntil: z.number(),
    gross: decimal,
    q05: decimal,
    cost: decimal,
  })
  .strict();
export function validateForecast(output: unknown, input: ForecastInput) {
  const v = forecastSchema.parse(output);
  if (
    v.inputHash !== input.inputHash ||
    v.profileHash !== hash(profile.forecast) ||
    v.quantity !== input.quantity ||
    v.cost !== input.cost ||
    v.horizon !== input.horizon ||
    v.asOf > input.at ||
    v.validUntil < input.at ||
    v.validUntil > input.deadline
  )
    throw new Error("FORECAST_BINDING_OR_TTL");
  return v;
}
export interface Evidence {
  id: string;
  kind: "FACT" | "ESTIMATE";
  text: string;
  source: string;
  publishedAt: number;
  receivedAt: number;
  availableAt: number;
  revision: number;
}
export interface Dossier {
  id: string;
  kind: "COMPANY" | "ETF";
  tradePermission: "NOT_CONFIGURED" | "UNVERIFIED" | "OBSERVE_ONLY";
  validationCandidate?: ReturnType<typeof researchAdmission>;
  state: "DISCOVERED" | "RESEARCHING" | "RESEARCH_READY" | "STALE" | "REJECTED";
  reviewedAt: number | null;
  sourceCheckedAt: number | null;
  materialChange: boolean;
  version: string;
  evidence: Evidence[];
  counterEvidence: string[];
  thesis: string;
  unknowns: string[];
}
export interface EvidenceProvider {
  read(at: number): Evidence[];
}
export interface SelectionProvider {
  select(): { status: "MISSING_PROFILE"; members: string[] };
}
export const missingSelection: SelectionProvider = {
  select: () => ({ status: "MISSING_PROFILE", members: [] }),
};
export function researchState(
  x: Dossier,
  at: number,
  preopen: number,
): Dossier["state"] {
  if (x.state === "REJECTED") return "REJECTED";
  if (x.reviewedAt === null) return "DISCOVERED";
  if (
    x.materialChange ||
    at - x.reviewedAt > 30 * 86400000 ||
    x.sourceCheckedAt === null ||
    x.sourceCheckedAt < preopen
  )
    return "STALE";
  if (
    !x.evidence.length ||
    !x.counterEvidence.length ||
    x.evidence.some(
      (e) => e.availableAt > at || e.receivedAt > at || e.publishedAt > at,
    )
  )
    return "RESEARCHING";
  return "RESEARCH_READY";
}
export function researchSamples(_at: number): Dossier[] {
  return [
    {
      id: "DEMO-COMPANY",
      kind: "COMPANY",
      tradePermission: "NOT_CONFIGURED",
      state: "DISCOVERED",
      reviewedAt: null,
      sourceCheckedAt: null,
      materialChange: false,
      version: "SAMPLE_ONLY",
      evidence: [],
      counterEvidence: ["합성 자료로 기업 경쟁력을 검증할 수 없음"],
      thesis: "조사 구조 예시이며 실제 유망기업이 아닙니다.",
      unknowns: ["사업부 매출", "연간/중간 공시", "비교 모집단", "선정 프로필"],
    },
    {
      id: "SOXX",
      kind: "ETF",
      tradePermission: "UNVERIFIED",
      validationCandidate: researchAdmission({
        underlying: "INDEX",
        leveraged: false,
        requiredDepositKrw: null,
      }),
      state: "RESEARCHING",
      reviewedAt: null,
      sourceCheckedAt: null,
      materialChange: false,
      version: "POLICY_EXAMPLE_NOT_CURRENT_RESEARCH",
      evidence: [],
      counterEvidence: ["집중 산업 위험·구성 중복 미확인"],
      thesis: "원본 정책의 조사 예시. 매수 자격 UNVERIFIED.",
      unknowns: ["현재 구성·보수·유동성", "계좌 자격", "거래 예측"],
    },
    {
      id: "SOXL",
      kind: "ETF",
      tradePermission: "UNVERIFIED",
      validationCandidate: researchAdmission({
        underlying: "INDEX",
        leveraged: true,
        requiredDepositKrw: null,
      }),
      state: "DISCOVERED",
      reviewedAt: null,
      sourceCheckedAt: null,
      materialChange: false,
      version: researchScope.id,
      evidence: [],
      counterEvidence: [
        "일일 3배 재설정·큰 변동성·불리한 체결을 별도로 검증해야 함",
      ],
      thesis:
        "반도체 지수의 일일 3배 ETF. 단일종목 레버리지 금지 대상과 구분하여 검증 후보에 포함합니다. 후보 포함은 주문 승인이 아닙니다.",
      unknowns: [
        "토스 계좌별 기본예탁금·교육·매매 자격",
        "실제 시세 공급·상품별 비용/체결/예측 프로필",
        "실제 전략 성과·실사",
      ],
    },
  ];
}
