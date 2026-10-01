import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import policy from "../../outputs/AI_TRADING_POLICY_v2.3.json" with { type: "json" };
import spec from "../../outputs/TRADING_STRATEGY_SPEC_v1.0.json" with { type: "json" };
import theme from "../../outputs/THEME_RESEARCH_POLICY_v1.3.json" with { type: "json" };
export { policy, spec, theme };
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  if (v === undefined) throw new Error("UNDEFINED_CANONICAL_VALUE");
  return JSON.stringify(v);
}
export const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
export const bytesHash = (v: Uint8Array) =>
  createHash("sha256").update(v).digest("hex").toUpperCase();
const pinned = {
  "AI_TRADING_POLICY_v2.3.json":
    "9D98FA0561DAACDF77E3A3D4509B611A4CBB1F23993F00EF09B51E628D72AFB3",
  "THEME_RESEARCH_POLICY_v1.3.json":
    "DB7F45B3D768D18E77759FE320A8BEB26A924EC3F7BC64DF13E87AB6DF5828A9",
  "TRADING_STRATEGY_SPEC_v1.0.json":
    policy.shared_strategy_contract.definition_sha256,
};
export function verifyPolicies() {
  for (const [name, h] of Object.entries(pinned)) {
    if (bytesHash(readFileSync(`outputs/${name}`)) !== h)
      throw new Error(`POLICY_HASH_MISMATCH:${name}`);
  }
  return pinned;
}
export const policyHash = pinned["AI_TRADING_POLICY_v2.3.json"];
export const levelSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type Level = z.infer<typeof levelSchema>;
export const configSchema = z
  .object({
    capital: z
      .number()
      .int()
      .positive()
      .max(policy.capital.maximum_inclusive_krw),
    usdCapitalKrw: z.number().int().nonnegative().default(0),
    level: levelSchema,
    mode: z.enum(["PAPER", "BACKTEST"]),
    forecast: z.enum(["MISSING_PROFILE", "TEST_ONLY"]),
    scenario: z.enum([
      "B",
      "P",
      "NO_SIGNAL",
      "GAP",
      "PARTIAL_CANCEL",
      "UNKNOWN",
      "PROTECTION_FAILURE",
    ]),
    market: z.enum(["KR", "US"]),
    stage: z.enum(["PILOT", "STANDARD"]).default("PILOT"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.usdCapitalKrw > v.capital * 0.4)
      ctx.addIssue({
        code: "custom",
        message: "외화 초기 배정은 40% 이하",
        path: ["usdCapitalKrw"],
      });
  });
export type Config = z.infer<typeof configSchema>;
export function assertOffline(mode: unknown, enabled: unknown = false) {
  if (
    !["PAPER", "BACKTEST"].includes(String(mode)) ||
    enabled === true ||
    enabled === "true"
  )
    throw new Error("LIVE_LOCKED: 실거래 어댑터는 존재하지 않습니다.");
}
export function bindSnapshot(value: Record<string, unknown>) {
  for (const f of policy.decision_snapshot.required_binding_fields) {
    if (value[f] === undefined || value[f] === null)
      throw new Error(`MISSING_BINDING:${f}`);
  }
  return hash(value);
}
