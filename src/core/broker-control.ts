import { z } from "zod";
import { hash, policy } from "./policy.js";

// TEST_ONLY 논리 별칭이다. 실제 계좌번호·인증 키·URL을 받지 않는다.
export const mockId = z.string().regex(/^sim-[a-z0-9-]{1,48}$/);
export const controlTime = z.number().int().min(0).max(8_000_000_000_000);
const routeSchema = z
  .object({
    id: mockId,
    provider: mockId,
    account: mockId,
    key: mockId,
    environment: z.literal("SYNTHETIC"),
    market: z.enum(["KR", "US"]),
    tr: mockId,
  })
  .strict();
const ruleSchema = z
  .object({
    id: mockId,
    provider: mockId,
    environment: z.literal("SYNTHETIC"),
    dimension: z.enum(["PROVIDER", "ACCOUNT", "KEY", "TR"]),
    subject: mockId,
    capacity: z.number().int().min(1).max(100),
    windowMs: z.number().int().min(1).max(60_000),
    safetyReserve: z.number().int().min(0).max(100),
    maxAttempts: z.number().int().min(1).max(500),
    totalSafetyReserve: z.number().int().min(0).max(500),
  })
  .strict();
export const controlConfigSchema = z
  .object({
    schemaVersion: z.literal("OFFLINE_BROKER_CONTROL_V1"),
    purpose: z.literal("TEST_ONLY"),
    routes: z.array(routeSchema).min(1).max(16),
    rules: z.array(ruleSchema).min(4).max(64),
    maxQueued: z.number().int().min(4).max(128),
    safetyQueueReserve: z.number().int().min(1).max(32),
    laneCapacity: z.number().int().min(1).max(4),
    maxRecords: z.number().int().min(4).max(500),
    minBackoffMs: z.number().int().min(1).max(60_000),
    maxRetries: z.number().int().min(0).max(3),
  })
  .strict()
  .superRefine((c, ctx) => {
    const invalid = () =>
      ctx.addIssue({ code: "custom", message: "CONTROL_CONFIG_INVALID" });
    if (
      new Set(c.routes.map((r) => r.id)).size !== c.routes.length ||
      new Set(c.rules.map((r) => r.id)).size !== c.rules.length ||
      c.safetyQueueReserve >= c.maxQueued ||
      c.maxRecords < c.maxQueued
    )
      invalid();
    for (const rule of c.rules)
      if (
        rule.safetyReserve > rule.capacity ||
        rule.totalSafetyReserve > rule.maxAttempts
      )
        invalid();
    for (const route of c.routes)
      for (const dimension of ["PROVIDER", "ACCOUNT", "KEY", "TR"] as const)
        if (
          !c.rules.some((r) => r.dimension === dimension && applies(r, route))
        )
          invalid();
  });
export type ControlConfig = z.infer<typeof controlConfigSchema>;
export type ControlRoute = z.infer<typeof routeSchema>;
type Rule = z.infer<typeof ruleSchema>;
const actionSchema = z.enum([
  "EXIT",
  "CANCEL",
  "ORDER_QUERY",
  "FILL_QUERY",
  "POSITION_QUERY",
  "MONITOR",
  "ACCOUNT",
  "RISK_NEWS",
  "ENTRY",
  "CANDIDATE_QUOTE",
  "SCAN",
  "HISTORY",
  "NEWS",
]);
export type ControlAction = z.infer<typeof actionSchema>;
export const evidenceActions = [
  "ORDER_QUERY",
  "FILL_QUERY",
  "POSITION_QUERY",
] as const;
const planSchema = z
  .object({ action: z.enum(evidenceActions), routeId: mockId })
  .strict();
export const controlRequestSchema = z
  .object({
    id: mockId,
    routeId: mockId,
    action: actionSchema,
    orderId: z.string().min(1).max(200).nullable().default(null),
    caseId: mockId.nullable(),
    deadlineAt: controlTime,
    timeoutMs: z.number().int().min(1).max(60_000),
    retryOf: mockId.nullable(),
    reservationFor: mockId.nullable(),
    safetyPlan: z.array(planSchema).max(3),
    freshness: z
      .object({
        quoteAt: controlTime,
        accountAt: controlTime,
        fxAt: controlTime,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.action === "ENTRY"
        ? r.safetyPlan.length !== 3 ||
          new Set(r.safetyPlan.map((p) => p.action)).size !== 3 ||
          !r.freshness
        : r.safetyPlan.length !== 0 || r.freshness !== null
    )
      ctx.addIssue({ code: "custom", message: "ENTRY_SAFETY_PLAN_INVALID" });
  });
export type ControlRequest = z.infer<typeof controlRequestSchema>;
const recordSchema = z
  .object({
    request: controlRequestSchema,
    enqueuedAt: controlTime,
    status: z.enum([
      "QUEUED",
      "IN_FLIGHT",
      "OK",
      "ERROR",
      "UNKNOWN",
      "DROPPED",
    ]),
    sentAt: controlTime.nullable(),
    responseAt: controlTime.nullable(),
    worker: mockId.nullable(),
    epoch: z.number().int().nonnegative(),
    transportClosed: z.boolean(),
    reason: z.string().max(512),
  })
  .strict();
export type ControlRecord = z.infer<typeof recordSchema>;
export const controlStateSchema = z
  .object({
    config: controlConfigSchema,
    now: controlTime,
    epoch: z.number().int().nonnegative(),
    mode: z.enum(["READY", "PAUSED"]),
    records: z.array(recordSchema).max(500),
    cooldowns: z.record(z.string(), controlTime),
    warnings: z.array(z.string().max(100)).max(128),
    networkRequests: z.literal(0),
    liveEnabled: z.literal(false),
  })
  .strict();
export type ControlState = z.infer<typeof controlStateSchema>;
export const controlCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ENQUEUE"),
      at: controlTime,
      request: controlRequestSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("DISPATCH"), at: controlTime, worker: mockId })
    .strict(),
  z.object({ kind: z.literal("ADVANCE"), at: controlTime }).strict(),
  z
    .object({
      kind: z.literal("RESPONSE"),
      at: controlTime,
      requestId: mockId,
      epoch: z.number().int().nonnegative(),
      code: z.enum(["OK", "ERROR", "429"]),
      retryAfterMs: z.number().int().min(0).max(86_400_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("TRANSPORT_CLOSED"),
      at: controlTime,
      requestId: mockId,
    })
    .strict(),
  z.object({ kind: z.literal("PAUSE"), at: controlTime }).strict(),
  z
    .object({
      kind: z.literal("RESUME"),
      at: controlTime,
      epoch: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type ControlCommand = z.infer<typeof controlCommandSchema>;
export const isWrite = (a: ControlAction) =>
  ["ENTRY", "EXIT", "CANCEL"].includes(a);
export function tier(a: ControlAction) {
  if (["EXIT", "CANCEL", ...evidenceActions].includes(a)) return 0;
  if (["MONITOR", "ACCOUNT", "RISK_NEWS"].includes(a)) return 1;
  return ["ENTRY", "CANDIDATE_QUOTE"].includes(a) ? 2 : 3;
}
function applies(rule: Rule, r: ControlRoute) {
  const subject =
    rule.dimension === "PROVIDER"
      ? r.provider
      : rule.dimension === "ACCOUNT"
        ? r.account
        : rule.dimension === "KEY"
          ? r.key
          : r.tr;
  return (
    rule.provider === r.provider &&
    rule.environment === r.environment &&
    rule.subject === subject
  );
}
export function routeFor(s: ControlState, id: string) {
  const r = s.config.routes.find((r) => r.id === id);
  if (!r) throw Error("CONTROL_ROUTE_UNKNOWN");
  return r;
}
const lane = (s: ControlState, r: ControlRequest) => {
  const route = routeFor(s, r.routeId);
  return `${route.provider}:${route.environment}:${route.market}:${tier(r.action) <= 1 ? "SAFETY" : "WORK"}`;
};
export function newControl(raw: unknown, at: number): ControlState {
  return controlStateSchema.parse({
    config: controlConfigSchema.parse(raw),
    now: controlTime.parse(at),
    epoch: 0,
    mode: "READY",
    records: [],
    cooldowns: {},
    warnings: [],
    networkRequests: 0,
    liveEnabled: false,
  });
}
export function warn(s: ControlState, reason: string) {
  if (!s.warnings.includes(reason)) s.warnings.push(reason);
  if (s.warnings.length > 128) s.warnings.shift();
}
// 이미 발송된 진입에 예약한 세 조회는 시간 경과로 환급하지 않는다.
function holds(s: ControlState) {
  return s.records.flatMap((r) =>
    r.sentAt !== null && r.request.action === "ENTRY"
      ? r.request.safetyPlan
          .filter(
            (p) =>
              !s.records.some(
                (q) =>
                  q.sentAt !== null &&
                  q.request.reservationFor === r.request.id &&
                  q.request.action === p.action,
              ),
          )
          .map((p) => ({ ...p, entryId: r.request.id }))
      : [],
  );
}
export function dispatchReasons(
  s: ControlState,
  request: ControlRequest,
  unresolvedOrders = false,
) {
  const route = routeFor(s, request.routeId),
    reasons: string[] = [];
  if (s.mode === "PAUSED" && tier(request.action) >= 2)
    reasons.push("ENTRY_AND_DISCOVERY_PAUSED");
  if (
    isWrite(request.action) &&
    (unresolvedOrders || s.records.some((r) => r.status === "UNKNOWN"))
  )
    reasons.push("UNRESOLVED_REQUEST");
  if (
    isWrite(request.action) &&
    request.orderId &&
    s.records.some(
      (r) =>
        r.sentAt !== null &&
        r.request.orderId === request.orderId &&
        r.request.action === request.action,
    )
  )
    reasons.push("ORDER_WRITE_ALREADY_SENT");
  if (
    s.records.filter(
      (r) =>
        r.sentAt !== null &&
        !r.transportClosed &&
        lane(s, r.request) === lane(s, request),
    ).length >= s.config.laneCapacity
  )
    reasons.push("LANE_BUSY");
  if (request.freshness) {
    for (const [time, seconds] of [
      [request.freshness.quoteAt, policy.execution.maximum_quote_age_seconds],
      [
        request.freshness.accountAt,
        policy.execution.maximum_account_snapshot_age_seconds,
      ],
      [request.freshness.fxAt, policy.execution.maximum_fx_age_seconds],
    ])
      if (time! > s.now || s.now - time! > seconds! * 1000)
        reasons.push("ENTRY_SNAPSHOT_STALE");
  }
  const reserved = holds(s).filter(
    (h) =>
      !(h.entryId === request.reservationFor && h.action === request.action),
  );
  for (const rule of s.config.rules) {
    const cost = Number(applies(rule, route));
    const newHold = request.safetyPlan.filter((p) =>
      applies(rule, routeFor(s, p.routeId)),
    ).length;
    if (!cost && !newHold) continue;
    if ((s.cooldowns[rule.id] ?? 0) > s.now) reasons.push("SERVER_BACKOFF");
    const sent = s.records.filter(
      (r) => r.sentAt !== null && applies(rule, routeFor(s, r.request.routeId)),
    );
    const reservedCount =
      reserved.filter((h) => applies(rule, routeFor(s, h.routeId))).length +
      newHold;
    const used = sent.filter((r) => r.sentAt! > s.now - rule.windowMs).length;
    if (
      used + cost + reservedCount > rule.capacity ||
      sent.length + cost + reservedCount > rule.maxAttempts
    )
      reasons.push("BUDGET_OR_SAFETY_HOLD");
    if (
      tier(request.action) >= 2 &&
      (used + cost > rule.capacity - rule.safetyReserve ||
        sent.length + cost > rule.maxAttempts - rule.totalSafetyReserve)
    )
      reasons.push("SAFETY_CAPACITY_RESERVED");
  }
  return [...new Set(reasons)];
}
function enqueue(s: ControlState, request: ControlRequest) {
  const existing = s.records.find((r) => r.request.id === request.id);
  if (existing) {
    if (hash(existing.request) !== hash(request))
      throw Error("CONTROL_REQUEST_ID_CONFLICT");
    return;
  }
  const route = routeFor(s, request.routeId);
  if (request.deadlineAt <= s.now) throw Error("CONTROL_DEADLINE_EXPIRED");
  for (const p of request.safetyPlan) {
    const other = routeFor(s, p.routeId);
    if (
      other.provider !== route.provider ||
      other.account !== route.account ||
      other.environment !== route.environment ||
      other.market !== route.market
    )
      throw Error("CONTROL_SAFETY_SCOPE_MISMATCH");
  }
  if (request.reservationFor) {
    const owner = s.records.find(
      (r) => r.request.id === request.reservationFor && r.sentAt !== null,
    );
    if (
      !owner?.request.safetyPlan.some(
        (p) => p.routeId === request.routeId && p.action === request.action,
      )
    )
      throw Error("CONTROL_RESERVATION_MISMATCH");
    if (
      s.records.some(
        (r) =>
          r.request.reservationFor === request.reservationFor &&
          r.request.action === request.action &&
          r.status === "QUEUED",
      )
    )
      throw Error("CONTROL_RESERVATION_DUPLICATE");
  }
  if (request.retryOf) {
    const prev = s.records.find((r) => r.request.id === request.retryOf);
    if (
      isWrite(request.action) ||
      !prev ||
      prev.status !== "ERROR" ||
      !prev.transportClosed ||
      prev.request.routeId !== request.routeId ||
      prev.request.action !== request.action ||
      prev.request.caseId !== request.caseId ||
      prev.request.orderId !== request.orderId ||
      prev.request.reservationFor !== request.reservationFor ||
      s.records.some((r) => r.request.retryOf === request.retryOf)
    )
      throw Error("CONTROL_RETRY_UNSAFE");
    let count = 1,
      ancestor: ControlRecord | undefined = prev;
    while (ancestor?.request.retryOf) {
      count++;
      ancestor = s.records.find(
        (r) => r.request.id === ancestor!.request.retryOf,
      );
    }
    if (count > s.config.maxRetries) throw Error("CONTROL_RETRY_LIMIT");
  }
  const queued = s.records.filter((r) => r.status === "QUEUED").length;
  if (
    s.records.length >= s.config.maxRecords ||
    queued >= s.config.maxQueued ||
    (tier(request.action) >= 2 &&
      (queued >= s.config.maxQueued - s.config.safetyQueueReserve ||
        s.records.length >= s.config.maxRecords - s.config.safetyQueueReserve))
  )
    throw Error("CONTROL_QUEUE_CAPACITY");
  s.records.push({
    request,
    enqueuedAt: s.now,
    status: "QUEUED",
    sentAt: null,
    responseAt: null,
    worker: null,
    epoch: s.epoch,
    transportClosed: true,
    reason: "QUEUED",
  });
}
function advance(s: ControlState, at: number) {
  if (at < s.now) throw Error("CONTROL_CLOCK_REGRESSION");
  s.now = at;
  for (const r of s.records) {
    if (r.status === "QUEUED" && at >= r.request.deadlineAt) {
      r.status = "DROPPED";
      r.reason = "DEADLINE_EXPIRED";
      if (tier(r.request.action) <= 1) s.mode = "PAUSED";
      warn(
        s,
        tier(r.request.action) <= 1
          ? "SAFETY_DEADLINE_MANUAL_REVIEW"
          : "QUEUED_DEADLINE_EXPIRED",
      );
    }
    if (
      r.status === "IN_FLIGHT" &&
      at >= Math.min(r.sentAt! + r.request.timeoutMs, r.request.deadlineAt)
    ) {
      r.status = isWrite(r.request.action) ? "UNKNOWN" : "ERROR";
      r.reason = "TIMEOUT_TRANSPORT_NOT_CANCELLED";
      s.mode = "PAUSED";
      warn(s, "TIMEOUT_RECONCILE_DO_NOT_RESUBMIT");
    }
  }
}
// 단일 순수 전이: 호출자는 최신 상태에서 직렬화/트랜잭션해야 한다.
export function controlStep(
  state: ControlState,
  raw: unknown,
  unresolvedOrders = false,
  terminalOrderIds: readonly string[] = [],
): ControlState {
  const c = controlCommandSchema.parse(raw),
    s = controlStateSchema.parse(state);
  advance(s, c.at);
  if (c.kind === "ENQUEUE") enqueue(s, c.request);
  else if (c.kind === "DISPATCH") {
    // ENQUEUE 당시 허용됐더라도 확정된 옛 의도는 재전송하지 않는다.
    for (const r of s.records)
      if (
        r.status === "QUEUED" &&
        isWrite(r.request.action) &&
        r.request.orderId &&
        terminalOrderIds.includes(r.request.orderId)
      ) {
        r.status = "DROPPED";
        r.reason = "ORDER_ALREADY_TERMINAL_REEVALUATE";
      }
    const candidates = s.records
      .filter((r) => r.status === "QUEUED")
      .sort(
        (a, b) =>
          tier(a.request.action) - tier(b.request.action) ||
          a.request.deadlineAt - b.request.deadlineAt ||
          a.enqueuedAt - b.enqueuedAt ||
          a.request.id.localeCompare(b.request.id, "en"),
      );
    for (const r of candidates) {
      const reasons = dispatchReasons(s, r.request, unresolvedOrders);
      if (reasons.length) {
        r.reason = reasons.join("+");
        if (tier(r.request.action) <= 1) {
          s.mode = "PAUSED";
          warn(s, "SAFETY_UNAVAILABLE_MANUAL_REVIEW");
        }
        continue;
      }
      r.status = "IN_FLIGHT";
      r.sentAt = s.now;
      r.epoch = s.epoch;
      r.worker = c.worker;
      r.transportClosed = false;
      r.reason = "MOCK_DISPATCH_ONLY";
      break;
    }
  } else if (c.kind === "RESPONSE") {
    const r = s.records.find((r) => r.request.id === c.requestId);
    if (!r || r.sentAt === null || c.at < r.sentAt)
      throw Error("CONTROL_RESPONSE_WITHOUT_SEND");
    if (c.epoch !== r.epoch || c.epoch !== s.epoch) {
      warn(s, "OLD_CONNECTION_RESPONSE_IGNORED");
      return s;
    }
    if (r.responseAt !== null) return s;
    r.responseAt = c.at;
    r.transportClosed = true;
    if (c.code === "429")
      for (const rule of s.config.rules.filter((rule) =>
        applies(rule, routeFor(s, r.request.routeId)),
      ))
        s.cooldowns[rule.id] = Math.max(
          s.cooldowns[rule.id] ?? 0,
          c.at + Math.max(c.retryAfterMs, s.config.minBackoffMs),
        );
    // HTTP 성공은 주문의 체결·취소 확정이 아니다. 재발주는 대조 이후의 별도 계약이다.
    if (isWrite(r.request.action) && r.status !== "OK") {
      r.status = "UNKNOWN";
      r.reason = "WRITE_REQUIRES_ORDER_EVIDENCE";
      s.mode = "PAUSED";
    } else if (r.status === "IN_FLIGHT") {
      r.status = c.code === "OK" ? "OK" : "ERROR";
      r.reason = c.code;
    }
    if (c.code !== "OK") {
      s.mode = "PAUSED";
      warn(s, "RESPONSE_FAILURE_MANUAL_REVIEW");
    }
  } else if (c.kind === "TRANSPORT_CLOSED") {
    const r = s.records.find((r) => r.request.id === c.requestId);
    if (!r || r.sentAt === null || r.status === "IN_FLIGHT")
      throw Error("CONTROL_TRANSPORT_STILL_ACTIVE");
    r.transportClosed = true;
  } else if (c.kind === "PAUSE") s.mode = "PAUSED";
  else if (c.kind === "RESUME") {
    if (
      c.epoch !== s.epoch ||
      s.records.some((r) => r.status === "UNKNOWN" || !r.transportClosed) ||
      Object.values(s.cooldowns).some((at) => at > s.now)
    )
      throw Error("CONTROL_RESUME_UNSAFE");
    s.mode = "READY";
  }
  return s;
}
export function recoverControl(state: ControlState) {
  const s = controlStateSchema.parse(state);
  s.epoch++;
  s.mode = "PAUSED";
  for (const r of s.records)
    if (r.sentAt !== null && !r.transportClosed) {
      if (r.status !== "OK")
        r.status = isWrite(r.request.action) ? "UNKNOWN" : "ERROR";
      r.transportClosed = true;
      r.reason = "OWNED_PROCESS_RESTART";
    }
  // 미전송 진입은 재시작 후 재사용하지 않으며 사용 예산과 예약은 유지한다.
  for (const r of s.records)
    if (r.status === "QUEUED" && tier(r.request.action) >= 2) {
      r.status = "DROPPED";
      r.reason = "RESTART_REEVALUATION_REQUIRED";
    }
  warn(s, "RESTART_RECONCILE_MANUAL_RESUME");
  return s;
}
