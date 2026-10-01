import { z } from "zod";

// 이 계약은 고정된 자체 모형 전용이다. 실제 Codex 실행 어댑터가 아니다.
export const analysisExecutionSchema = z.strictObject({
  kind: z.literal("RESTRICTED_NODE_MOCK_STDIO_V1"),
  protocol: z.literal("APP_SERVER_DOCUMENTED_SUBSET_20260914"),
  workerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nodeVersion: z.literal("24.20.0"),
  trustBoundary: z.literal("TRUSTED_MOCK_NOT_OS_SANDBOX"),
  realCodexEnabled: z.literal(false),
});
export type AnalysisExecution = z.infer<typeof analysisExecutionSchema>;
