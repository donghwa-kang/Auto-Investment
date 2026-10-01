import { z } from "zod";
import scope from "../../profiles/research-scope-v1.json" with { type: "json" };

// 후보 분류 전용이다. 실제 계좌 자격 판정이나 주문 승인 함수가 아니다.
const productSchema = z
  .object({
    underlying: z.enum(["SINGLE_STOCK", "INDEX", "UNKNOWN"]),
    leveraged: z.boolean(),
    requiredDepositKrw: z.number().int().nonnegative().nullable(),
  })
  .strict();

export function researchAdmission(input: unknown) {
  const parsed = productSchema.safeParse(input);
  if (!parsed.success || parsed.data.underlying === "UNKNOWN")
    return "CLASSIFICATION_REQUIRED" as const;
  const p = parsed.data;
  if (p.underlying === "SINGLE_STOCK" && p.leveraged) {
    if (p.requiredDepositKrw === null)
      return "CLASSIFICATION_REQUIRED" as const;
    if (p.requiredDepositKrw >= scope.minimum_excluded_deposit_krw)
      return "EXCLUDED_BY_USER" as const;
  }
  return "INCLUDED_FOR_VALIDATION" as const;
}

export const researchScope = scope;
