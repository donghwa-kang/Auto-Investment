import { z } from "zod";
import { hash, policyHash } from "./policy.js";
import { sourceTime, utc } from "./source-ingest-schema.js";
import {
  MAX_KIWOOM_BYTES,
  parseKiwoomInput,
  type KiwoomCapture,
  type KiwoomInput,
} from "./kiwoom-ingest-schema.js";
import { ingestMockKiwoom } from "./kiwoom-ingest.js";

// 공개 안내의 조회 한도 스냅샷. rolling window는 서버 구현 사실이 아닌 로컬 설계다.
export const KIWOOM_QUERY_LIMIT_BASIS = Object.freeze({
  checkedOn: "2026-09-21",
  reference: "https://openapi.kiwoom.com/intro",
  krPerSecond: 5,
  usNormalPerSecond: 5,
  usPeakPerSecond: 3,
  mockPerTrPerSecond: 1,
  usPeakKstStartHour: 9,
  usPeakKstEndHour: 10,
  windowMs: 1_000,
});
const epoch = z.number().int().min(0).max(1_000_000);
const eventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ATTEMPT"),
      captureId: z.string().min(1).max(64),
    })
    .strict(),
  z.object({ kind: z.literal("PAUSE"), at: sourceTime }).strict(),
  z
    .object({
      kind: z.literal("RESUME"),
      at: sourceTime,
      connectionEpoch: epoch,
    })
    .strict(),
  z.object({ kind: z.literal("STOP"), at: sourceTime }).strict(),
]);
const schema = z
  .object({
    schemaVersion: z.literal("OFFLINE_KIWOOM_COLLECTION_V1"),
    purpose: z.literal("MOCK_CONTRACT"),
    limitProfile: z.enum(["PUBLISHED_QUERY_LIMITS", "PUBLISHED_MOCK_LIMITS"]),
    startedAt: sourceTime,
    deadlineAt: sourceTime,
    maxAttempts: z.number().int().min(1).max(50),
    maxPagesPerChain: z.number().int().min(1).max(20),
    minIntervalMs: z.number().int().min(0).max(60_000),
    faultCooldownMs: z.number().int().min(1_000).max(60_000),
    sourceInput: z.unknown(),
    events: z.array(eventSchema).min(1).max(150),
  })
  .strict();
export type KiwoomCollectionInput = Omit<
  z.infer<typeof schema>,
  "sourceInput"
> & {
  sourceInput: KiwoomInput;
};
export class KiwoomCollectionError extends Error {
  constructor() {
    super("KIWOOM_COLLECTION_INPUT_INVALID");
  }
}
function parseInput(raw: unknown): KiwoomCollectionInput {
  try {
    const text = JSON.stringify(raw);
    if (!text || Buffer.byteLength(text) > MAX_KIWOOM_BYTES) throw new Error();
    const outer = schema.parse(JSON.parse(text));
    const sourceInput = parseKiwoomInput(outer.sourceInput);
    if (sourceInput.pagePlans.length || !sourceInput.captures.length)
      throw new Error();
    const start = Date.parse(outer.startedAt),
      end = Date.parse(outer.deadlineAt);
    const asOf = Date.parse(sourceInput.asOf);
    if (end <= start || end - start > 86_400_000 || asOf < start)
      throw new Error();
    const captures = new Map(sourceInput.captures.map((c) => [c.captureId, c]));
    const seen = new Set<string>();
    let previous = start;
    for (const event of outer.events) {
      const c =
        event.kind === "ATTEMPT" ? captures.get(event.captureId) : undefined;
      if (event.kind === "ATTEMPT") {
        if (!c || seen.has(event.captureId) || Date.parse(c.availableAt) > asOf)
          throw new Error();
        seen.add(event.captureId);
      }
      const at = Date.parse(
        event.kind === "ATTEMPT" ? c!.requestedAt : event.at,
      );
      if (at < previous || at > asOf) throw new Error();
      previous = at;
    }
    if (seen.size !== captures.size) throw new Error();
    return { ...outer, sourceInput };
  } catch {
    // 입력 값이나 공급자 오류 문구를 오류 응답에 복사하지 않는다.
    throw new KiwoomCollectionError();
  }
}
type State = "READY" | "PAUSED" | "STOPPED";
interface Decision {
  eventIndex: number;
  kind: KiwoomCollectionInput["events"][number]["kind"];
  at: string;
  resultKnownAt: string;
  captureId: string | null;
  disposition: "ADMITTED" | "CONTROL_APPLIED" | "REJECTED";
  reasons: string[];
  state: State;
  attemptsUsed: number;
  connectionEpoch: number;
  notBefore: string | null;
}
const isChart = (c: KiwoomCapture) =>
  ["ka10080", "usa06011"].includes(c.request.apiId);

function rateGate(
  input: KiwoomCollectionInput,
  c: KiwoomCapture,
  used: KiwoomCapture[],
) {
  const at = Date.parse(c.requestedAt),
    basis = KIWOOM_QUERY_LIMIT_BASIS;
  const kr = c.request.apiId.startsWith("ka");
  const hour = new Date(at + 9 * 3_600_000).getUTCHours();
  const peak =
    hour >= basis.usPeakKstStartHour && hour < basis.usPeakKstEndHour;
  const mock = input.limitProfile === "PUBLISHED_MOCK_LIMITS";
  const limit = mock
    ? basis.mockPerTrPerSecond
    : kr
      ? basis.krPerSecond
      : peak
        ? basis.usPeakPerSecond
        : basis.usNormalPerSecond;
  const recent = used.filter(
    (p) =>
      Date.parse(p.requestedAt) > at - basis.windowMs &&
      (mock
        ? p.request.apiId === c.request.apiId
        : p.request.apiId.startsWith("ka") === kr),
  );
  return recent.length < limit
    ? null
    : {
        reason: mock
          ? "MOCK_TR_RATE_LIMIT"
          : kr
            ? "KR_QUERY_RATE_LIMIT"
            : peak
              ? "US_PEAK_QUERY_RATE_LIMIT"
              : "US_QUERY_RATE_LIMIT",
        // 하한일 뿐 미래 요청의 허용 보장은 아니다. 피크 전환 시에도 다시 심사한다.
        notBefore:
          Date.parse(recent[recent.length - limit]!.requestedAt) +
          basis.windowMs,
      };
}

// 합성 순차 로그만 재생한다. 전송·대기·인증·영구 저장은 하지 않는다.
export function replayMockKiwoomCollection(raw: unknown) {
  const input = parseInput(raw),
    source = input.sourceInput;
  const captures = new Map(source.captures.map((c) => [c.captureId, c]));
  const used: KiwoomCapture[] = [],
    accepted: KiwoomCapture[] = [];
  const decisions: Decision[] = [];
  let state: State = "READY",
    stopReason: string | null = null;
  let currentEpoch = 0,
    busyUntil = Date.parse(input.startedAt),
    notBefore = busyUntil;
  let chain: KiwoomCapture[] = [];
  let ingest: ReturnType<typeof ingestMockKiwoom> | null = null;
  const deadline = Date.parse(input.deadlineAt);
  const ingestInput = (items: KiwoomCapture[], asOf: string): KiwoomInput => ({
    ...source,
    captures: items,
    pagePlans: [],
    asOf,
  });
  for (const [eventIndex, event] of input.events.entries()) {
    const c = event.kind === "ATTEMPT" ? captures.get(event.captureId)! : null;
    const at = Date.parse(event.kind === "ATTEMPT" ? c!.requestedAt : event.at);
    const reasons: string[] = [];
    let disposition: Decision["disposition"] = "REJECTED",
      gateTime: number | null = null;
    const pause = (reason: string): "PAUSED" => {
      stopReason = reason;
      chain = [];
      reasons.push(reason);
      return "PAUSED";
    };
    if (state === "STOPPED") reasons.push("SESSION_STOPPED");
    else if (at >= deadline) {
      state = "STOPPED";
      stopReason = "DEADLINE_EXCEEDED";
      chain = [];
      reasons.push(stopReason);
    } else if (at < busyUntil) {
      reasons.push("SERIAL_ATTEMPT_IN_FLIGHT");
      gateTime = busyUntil;
    } else if (event.kind === "STOP") {
      state = "STOPPED";
      stopReason = "USER_STOP";
      chain = [];
      disposition = "CONTROL_APPLIED";
    } else if (event.kind === "PAUSE") {
      if (state !== "READY") reasons.push("CONTROL_STATE_INVALID");
      else {
        state = pause("USER_PAUSE");
        disposition = "CONTROL_APPLIED";
      }
    } else if (event.kind === "RESUME") {
      if (state !== "PAUSED") reasons.push("CONTROL_STATE_INVALID");
      else if (event.connectionEpoch !== currentEpoch + 1)
        reasons.push("RESUME_EPOCH_INVALID");
      else if (at < notBefore) {
        reasons.push("COOLDOWN_ACTIVE");
        gateTime = notBefore;
      } else {
        state = "READY";
        stopReason = null;
        currentEpoch = event.connectionEpoch;
        chain = [];
        disposition = "CONTROL_APPLIED";
      }
    } else {
      const capture = c!;
      if (state !== "READY") reasons.push("SESSION_PAUSED");
      else if (capture.connectionEpoch !== currentEpoch)
        reasons.push("CONNECTION_EPOCH_MISMATCH");
      else if (at < notBefore) {
        reasons.push("LOCAL_INTERVAL_OR_COOLDOWN");
        gateTime = notBefore;
      } else {
        const previous = chain.at(-1);
        if (
          previous
            ? hash(capture.request) !== hash(previous.request) ||
              hash(capture.requestContinuation) !==
                hash(previous.responseContinuation)
            : capture.requestContinuation.contYn !== "N"
        )
          reasons.push("CURSOR_OR_QUERY_MISMATCH");
        const rate = rateGate(input, capture, used);
        if (rate) {
          reasons.push(rate.reason);
          gateTime = rate.notBefore;
        }
        if (!reasons.length) {
          used.push(capture);
          disposition = "ADMITTED";
          busyUntil = Date.parse(capture.availableAt);
          notBefore = Math.max(busyUntil, at + input.minIntervalMs);
          if (busyUntil > deadline) {
            // 예산을 쓴 미해결 시도로 남기고 마감 이후 본문은 정규화하지 않는다.
            state = "STOPPED";
            stopReason = "RESPONSE_AFTER_DEADLINE";
            reasons.push(stopReason);
            chain = [];
          } else {
            accepted.push(capture);
            ingest = ingestMockKiwoom(
              ingestInput(accepted, capture.availableAt),
            );
            const last = ingest.captures.at(-1)!;
            if (last.status === "BLOCKED") {
              state = pause(
                capture.httpStatus === 429
                  ? "HTTP_429_MANUAL_REVIEW"
                  : "CAPTURE_BLOCKED",
              );
              notBefore = Math.max(
                notBefore,
                busyUntil + input.faultCooldownMs,
              );
            } else if (isChart(capture)) {
              chain.push(capture);
              const page = ingestMockKiwoom({
                ...ingestInput([], capture.availableAt),
                pagePlans: [
                  {
                    planId: "active-chain",
                    maxPages: chain.length,
                    replies: chain,
                  },
                ],
              }).pagePlans[0]!;
              if (page.stop === "BLOCKED") {
                state = pause(page.reasons[0] ?? "PAGE_BLOCKED");
                notBefore = Math.max(
                  notBefore,
                  busyUntil + input.faultCooldownMs,
                );
              } else if (page.stop === "SOURCE_EXHAUSTED") chain = [];
              else if (chain.length >= input.maxPagesPerChain)
                state = pause("PAGE_BUDGET_EXHAUSTED");
            } else if (capture.responseContinuation?.contYn !== "N") {
              state = pause("BOOK_CONTINUATION_UNSUPPORTED");
              notBefore = Math.max(
                notBefore,
                busyUntil + input.faultCooldownMs,
              );
            }
          }
          if (used.length >= input.maxAttempts && state !== "STOPPED") {
            state = "STOPPED";
            stopReason = "ATTEMPT_BUDGET_EXHAUSTED";
            chain = [];
            reasons.push(stopReason);
          }
        }
      }
    }
    decisions.push({
      eventIndex,
      kind: event.kind,
      at: new Date(at).toISOString(),
      // 응답 결과를 요청 시각에 알았던 것처럼 기록하지 않는다.
      resultKnownAt: new Date(
        Math.max(at, Math.min(busyUntil, deadline)),
      ).toISOString(),
      captureId: c?.captureId ?? null,
      disposition,
      reasons,
      state,
      attemptsUsed: used.length,
      connectionEpoch: currentEpoch,
      notBefore: gateTime === null ? null : new Date(gateTime).toISOString(),
    });
  }
  if (state !== "STOPPED" && Date.parse(source.asOf) >= deadline) {
    state = "STOPPED";
    stopReason = "DEADLINE_EXCEEDED";
    chain = [];
  }
  // 마지막 시점에도 원자료로 재계산한다. 저장된 집계값을 재개 권한으로 쓰지 않는다.
  if (accepted.length)
    ingest = ingestMockKiwoom(ingestInput(accepted, source.asOf));
  const report = {
    schemaVersion: "OFFLINE_KIWOOM_COLLECTION_REPORT_V1",
    purpose: "MOCK_CONTRACT",
    dataOrigin: "MOCK_RESPONSE",
    inputHash: hash(input),
    policyHash,
    asOf: utc(source.asOf),
    limitProfile: input.limitProfile,
    limitBasis: KIWOOM_QUERY_LIMIT_BASIS,
    windowPolicy: "LOCAL_ROLLING_SECOND_NOT_SERVER_SEMANTICS",
    quotaScope: "ONE_SYNTHETIC_CLIENT_NOT_ACCOUNT_WIDE",
    state,
    stopReason,
    connectionEpoch: currentEpoch,
    budget: {
      maxAttempts: input.maxAttempts,
      used: used.length,
      remaining: input.maxAttempts - used.length,
    },
    localNotBefore: new Date(notBefore).toISOString(),
    pendingContinuation: chain.length > 0,
    decisions,
    ingest,
    realCollectionEnabled: false,
    realDataReady: false,
    strategyReady: false,
    paperOrdersEnabled: false,
    liveEnabled: false,
    historyCoverageVerified: false,
    networkRequests: 0,
    automaticRetries: 0,
  };
  return { ...report, reportHash: hash(report) };
}
