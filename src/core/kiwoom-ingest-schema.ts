import { z } from "zod";
import { sourceTime } from "./source-ingest-schema.js";

export const KIWOOM_SPEC_COMMIT = "953e5dbff123f437ab4d11a78a95191a685eb51f";
export const KIWOOM_SPEC_SHA256 =
  "42a7b3912c9d9588c83bdc2db7779c8d2e038703a2b5562e54ef46ae905cba79";
// 로컬 시험의 자원 상한이며 공급자 호출 한도나 투자 기준이 아니다.
export const MAX_KIWOOM_BYTES = 4 * 1024 * 1024;
export const MAX_KIWOOM_ROWS = 2_000;
const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);
const symbol = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[A-Z0-9.-]+$/);
const krSymbol = z.string().regex(/^\d{6}$/);
const date = z
  .string()
  .regex(/^\d{8}$/)
  .refine(
    (v) =>
      z.iso
        .date()
        .safeParse(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`)
        .success,
  );
export const kiwoomRequestSchema = z.discriminatedUnion("apiId", [
  z
    .object({
      apiId: z.literal("ka10080"),
      body: z
        .object({
          stk_cd: krSymbol,
          tic_scope: z.literal("1"),
          upd_stkpc_tp: z.literal("0"),
          base_dt: date.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      apiId: z.literal("ka10004"),
      body: z.object({ stk_cd: krSymbol }).strict(),
    })
    .strict(),
  z
    .object({
      apiId: z.literal("usa06011"),
      body: z
        .object({
          stex_tp: z.enum(["NA", "ND", "NY"]),
          stk_cd: symbol,
          tic_scope: z.literal("1"),
          upd_stkpc_tp: z.literal("0"),
          exrt_appl_tp: z.literal("0"),
          strt_dt: date.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      apiId: z.literal("usa20101"),
      body: z
        .object({ stex_tp: z.enum(["NA", "ND", "NY"]), stk_cd: symbol })
        .strict(),
    })
    .strict(),
]);
export const continuationSchema = z
  .object({
    contYn: z.enum(["Y", "N"]),
    nextKey: z
      .string()
      .max(50)
      .regex(/^[\x21-\x7e]*$/),
  })
  .strict()
  .refine((v) =>
    v.contYn === "Y" ? v.nextKey.length > 0 : v.nextKey.length === 0,
  );
const captureSchema = z
  .object({
    captureId: id,
    connectionEpoch: z.number().int().min(0).max(1_000_000),
    request: kiwoomRequestSchema,
    requestContinuation: continuationSchema,
    responseContinuation: continuationSchema.nullable(),
    requestedAt: sourceTime,
    receivedAt: sourceTime,
    availableAt: sourceTime,
    outcome: z.enum(["RESPONSE", "TIMEOUT", "DISCONNECTED"]),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    responseApiId: z.string().max(16).nullable(),
    response: z.unknown(),
  })
  .strict()
  .refine(
    (c) =>
      Date.parse(c.requestedAt) <= Date.parse(c.receivedAt) &&
      Date.parse(c.receivedAt) <= Date.parse(c.availableAt),
  )
  .refine((c) =>
    c.outcome === "RESPONSE"
      ? c.httpStatus !== null
      : c.httpStatus === null &&
        c.response === null &&
        c.responseContinuation === null &&
        c.responseApiId === null,
  );
const pagePlan = z
  .object({
    planId: id,
    maxPages: z.number().int().min(1).max(20),
    replies: z.array(captureSchema).min(1).max(20),
  })
  .strict();
const inputSchema = z
  .object({
    schemaVersion: z.literal("OFFLINE_KIWOOM_INGEST_V1"),
    purpose: z.literal("MOCK_CONTRACT"),
    dataOrigin: z.literal("MOCK_RESPONSE"),
    source: z.literal("KIWOOM_REST"),
    sourceSpecCommit: z.literal(KIWOOM_SPEC_COMMIT),
    asOf: sourceTime,
    captures: z.array(captureSchema).max(50),
    pagePlans: z.array(pagePlan).max(5),
  })
  .strict()
  .refine((v) => v.captures.length + v.pagePlans.length > 0)
  .refine(
    (v) =>
      new Set(v.pagePlans.map((p) => p.planId)).size === v.pagePlans.length,
  )
  .refine((v) => {
    const ids = [...v.captures, ...v.pagePlans.flatMap((p) => p.replies)].map(
      (c) => c.captureId,
    );
    return new Set(ids).size === ids.length;
  });
export type KiwoomRequest = z.infer<typeof kiwoomRequestSchema>;
export type KiwoomCapture = z.infer<typeof captureSchema>;
export type KiwoomInput = z.infer<typeof inputSchema>;
export type KiwoomPagePlan = z.infer<typeof pagePlan>;
export class KiwoomIngestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function parseKiwoomInput(raw: unknown): KiwoomInput {
  try {
    const text = JSON.stringify(raw);
    if (!text || Buffer.byteLength(text) > MAX_KIWOOM_BYTES) throw new Error();
    if (
      /"(?:__proto__|constructor|prototype|authorization|appkey|secretkey|app_secret|access_token|token|api_key|headers|account_no)"\s*:/i.test(
        text,
      )
    )
      throw new Error();
    const input = inputSchema.parse(JSON.parse(text));
    let rows = 0;
    for (const c of [
      ...input.captures,
      ...input.pagePlans.flatMap((p) => p.replies),
    ]) {
      const shape = z.record(z.string(), z.unknown()).safeParse(c.response);
      // 한 필드의 형식 오류나 빈 배열이 다른 배열의 자원 사용을 숨기지 않는다.
      const arrays = shape.success
        ? [shape.data.stk_min_pole_chart_qry, shape.data.result_list]
        : [];
      rows += Math.max(
        1,
        arrays.reduce<number>(
          (count, value) => count + (Array.isArray(value) ? value.length : 0),
          0,
        ),
      );
    }
    if (rows > MAX_KIWOOM_ROWS) throw new Error();
    return input;
  } catch {
    throw new KiwoomIngestError("KIWOOM_INPUT_INVALID");
  }
}
