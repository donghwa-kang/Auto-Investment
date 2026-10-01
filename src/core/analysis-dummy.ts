import { z } from "zod";

export const dummyCases = ["ALLOW_READ", "DENY_READ", "DENY_WRITE"] as const;
export const dummyCaseSchema = z.enum(dummyCases);
export type DummyCase = z.infer<typeof dummyCaseSchema>;
export const dummyHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const dummyReceiptSchema = z
  .strictObject({
    version: z.literal("DUMMY_FILE_RECEIPT_V1"),
    runId: z.uuid(),
    caseId: dummyCaseSchema,
    manifestSha256: dummyHashSchema,
    attempted: z.boolean(),
    outcome: z.enum(["READ", "WRITE", "ERROR"]),
    observedSha256: dummyHashSchema.nullable(),
    errorCode: z
      .enum(["EACCES", "EPERM", "ENOENT", "OTHER", "PRECONDITION"])
      .nullable(),
  })
  .superRefine((value, context) => {
    const success = value.outcome !== "ERROR";
    if (
      success &&
      (!value.attempted ||
        value.errorCode !== null ||
        value.observedSha256 === null)
    )
      context.addIssue({ code: "custom", message: "INCONSISTENT_SUCCESS" });
    if (!success && (value.errorCode === null || value.observedSha256 !== null))
      context.addIssue({ code: "custom", message: "INCONSISTENT_ERROR" });
    if (
      (value.outcome === "WRITE" && value.caseId !== "DENY_WRITE") ||
      (value.outcome === "READ" && value.caseId === "DENY_WRITE")
    )
      context.addIssue({ code: "custom", message: "WRONG_OPERATION" });
  });
export type DummyReceipt = z.infer<typeof dummyReceiptSchema>;

export function parseDummyReceipt(bytes: Uint8Array): DummyReceipt {
  if (!bytes.length || bytes.length > 4096)
    throw new Error("DUMMY_RECEIPT_SIZE");
  return dummyReceiptSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

// 더미 검사 분류만 제공한다. 호출자가 만든 영수증으로 제품을 활성화하지 않는다.
export function classifyDummyProbe(input: {
  caseId: DummyCase;
  runId: string;
  manifestSha256: string;
  controlMatched: boolean;
  beforeSha256: string;
  afterSha256: string | null;
  receipt: unknown;
}) {
  const r = dummyReceiptSchema.parse(input.receipt);
  if (
    r.caseId !== input.caseId ||
    r.runId !== input.runId ||
    r.manifestSha256 !== input.manifestSha256 ||
    !input.controlMatched
  )
    return "INCONCLUSIVE" as const;
  if (input.caseId === "ALLOW_READ") {
    return r.outcome === "READ" &&
      r.observedSha256 === input.beforeSha256 &&
      input.afterSha256 === input.beforeSha256
      ? ("ALLOW_OBSERVED" as const)
      : ("INCONCLUSIVE" as const);
  }
  if (r.outcome !== "ERROR") return "EXPOSURE_DETECTED" as const;
  if (input.afterSha256 === null) return "INCONCLUSIVE" as const;
  if (input.afterSha256 !== input.beforeSha256)
    return "EXPOSURE_DETECTED" as const;
  if (r.attempted && (r.errorCode === "EACCES" || r.errorCode === "EPERM"))
    return "DENIAL_REPORTED_NOT_OS_ATTESTED" as const;
  return "INCONCLUSIVE" as const;
}
