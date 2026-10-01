import { hash } from "./policy.js";
import {
  minuteMs,
  utc,
  type CandleRequest,
  type PagePlan,
} from "./source-ingest-schema.js";
import {
  normalizeSourceCapture,
  reconcileSourceObservations,
  type CaptureResult,
} from "./source-ingest-normalize.js";

const sameRequest = (a: CandleRequest, b: unknown) =>
  hash({ ...a, before: null }) === hash({ ...(b as object), before: null });
export function runMockPagePlan(plan: PagePlan, asOf: string) {
  const captures: CaptureResult[] = [];
  const reasons: string[] = [];
  let before = plan.request.before ? utc(plan.request.before) : null;
  let stop:
    "WINDOW_REACHED" | "SOURCE_EXHAUSTED" | "BLOCKED" | "BUDGET_EXHAUSTED" =
    "BUDGET_EXHAUSTED";
  const from = Date.parse(plan.windowFrom),
    to = Date.parse(plan.windowTo);
  if (to > Date.parse(asOf)) {
    reasons.push("WINDOW_NOT_CLOSED");
    stop = "BLOCKED";
  }
  const seen = new Set<string>();
  const cursors = new Set<string>();
  for (
    let index = 0;
    index < plan.maxPages && stop === "BUDGET_EXHAUSTED";
    index++
  ) {
    // 미리 입력된 응답만 소비한다. 통신·대기·인증·재시도는 구현하지 않는다.
    const reply = plan.replies[index];
    if (!reply) {
      reasons.push("MOCK_REPLY_MISSING");
      stop = "BLOCKED";
      break;
    }
    const result = normalizeSourceCapture(reply, asOf);
    captures.push(result); // 실패와 잘못된 요청도 한 번의 시도로 기록한다.
    const replyBefore =
      "before" in reply.request && reply.request.before
        ? utc(reply.request.before)
        : null;
    if (!sameRequest(plan.request, reply.request) || before !== replyBefore) {
      reasons.push("PAGE_REQUEST_MISMATCH");
      stop = "BLOCKED";
      break;
    }
    const prior = captures.at(-2);
    if (prior && Date.parse(reply.requestedAt) < Date.parse(prior.receivedAt)) {
      reasons.push("PAGE_CAPTURE_ORDER_INVALID");
      stop = "BLOCKED";
      break;
    }
    reconcileSourceObservations(captures, asOf);
    if (captures.some((c) => c.status === "BLOCKED")) {
      reasons.push("PAGE_DATA_BLOCKED");
      stop = "BLOCKED";
      break;
    }
    const rows = result.observations;
    if (!rows.length) {
      if (!result.cursorPresent || result.nextBefore !== null) {
        reasons.push("EMPTY_PAGE_UNRESOLVED");
        stop = "BLOCKED";
      } else stop = "SOURCE_EXHAUSTED";
      break;
    }
    const times = rows.map((r) => Date.parse(r.eventAt!));
    if (times.some((t, i) => i > 0 && t > times[i - 1]!)) {
      reasons.push("PAGE_ORDER_INVALID");
      stop = "BLOCKED";
      break;
    }
    const beforeSize = seen.size;
    for (const row of rows) seen.add(row.logicalKey);
    if (seen.size === beforeSize) {
      reasons.push("PAGE_NO_PROGRESS");
      stop = "BLOCKED";
      break;
    }
    if (result.nextBefore !== null) {
      const next = Date.parse(result.nextBefore);
      if (
        (before !== null && next >= Date.parse(before)) ||
        next > Math.min(...times) ||
        cursors.has(result.nextBefore)
      ) {
        reasons.push("CURSOR_NOT_PROGRESSING");
        stop = "BLOCKED";
        break;
      }
      cursors.add(result.nextBefore);
    }
    if (rows.some((r) => Date.parse(r.data!.openAt as string) <= from)) {
      stop = "WINDOW_REACHED";
      break;
    }
    if (!result.cursorPresent) {
      reasons.push("CURSOR_MISSING");
      stop = "BLOCKED";
      break;
    }
    if (result.nextBefore === null) {
      stop = "SOURCE_EXHAUSTED";
      break;
    }
    before = result.nextBefore;
  }
  if (stop === "BUDGET_EXHAUSTED") reasons.push("PAGE_BUDGET_EXHAUSTED");
  const slots = new Set(
    captures
      .flatMap((c) => c.observations)
      .filter((r) => r.status === "MOCK_PARSED")
      .map((r) => Date.parse(r.data!.openAt as string))
      .filter((at) => at >= from && at < to),
  );
  const missing: string[] = [];
  for (let at = from; at < to; at += minuteMs)
    if (!slots.has(at)) missing.push(new Date(at).toISOString());
  if (missing.length) reasons.push("WINDOW_GAPS");
  return {
    planId: plan.planId,
    request: plan.request,
    windowFrom: utc(plan.windowFrom),
    windowTo: utc(plan.windowTo),
    attempts: captures.length,
    unusedMockReplies: plan.replies.length - captures.length,
    stop,
    status: reasons.length
      ? ("INCOMPLETE" as const)
      : ("MOCK_WINDOW_COVERED" as const),
    reasons: [...new Set(reasons)].sort(),
    expectedBars: (to - from) / minuteMs,
    observedSlots: slots.size,
    missing,
    captures,
    realHistoryCoverageVerified: false,
  };
}
