import { z } from "zod";
import { hash, policyHash } from "./policy.js";
import { dec, utc } from "./source-ingest-schema.js";
import { reconcileSourceObservations } from "./source-ingest-normalize.js";
import {
  KIWOOM_SPEC_COMMIT,
  KIWOOM_SPEC_SHA256,
  MAX_KIWOOM_ROWS,
  parseKiwoomInput,
  type KiwoomCapture,
  type KiwoomPagePlan,
} from "./kiwoom-ingest-schema.js";

type Status = "MOCK_PARSED" | "BLOCKED";
type Fields = Record<string, string>;
interface Observation {
  observationId: string;
  logicalKey: string;
  availableAt: string;
  receivedAt: string;
  sourceTimestampRaw: string | null;
  // 문자열이 표현하는 최소 단위일 뿐 정확도·시간대·봉 확정의 증명이 아니다.
  sourceTimePrecision: "DAY" | "MINUTE" | "SECOND" | null;
  eventAt: null;
  payloadHash: string;
  localObservationVersion: number;
  duplicateOf: string | null;
  status: Status;
  reasons: string[];
  data: Fields | null;
}
interface CaptureResult {
  captureId: string;
  apiId: KiwoomCapture["request"]["apiId"];
  request: KiwoomCapture["request"];
  requestContinuation: KiwoomCapture["requestContinuation"];
  connectionEpoch: number;
  requestedAt: string;
  identity: {
    symbol: string;
    market: "KR" | "US";
    currency: "KRW" | "USD";
    venue: string;
    basis: "REQUEST_CONTEXT_UNVERIFIED";
  };
  receivedAt: string;
  availableAt: string;
  responseHash: string;
  status: Status;
  reasons: string[];
  semanticHolds: string[];
  observations: Observation[];
  continuation: KiwoomCapture["responseContinuation"];
}
const numberText = z
  .string()
  .max(30)
  .regex(/^[+-]?\d{1,18}(\.\d{1,4})?$/);
const quantity = z
  .string()
  .max(18)
  .regex(/^\d{1,18}$/);
const clockText = z.string().regex(/^\d{14}$/);
const ohlcv = z.object({
  cur_prc: numberText,
  open_pric: numberText,
  high_pric: numberText,
  low_pric: numberText,
  trde_qty: quantity,
  cntr_tm: clockText,
});
const krBar = ohlcv.extend({
  pred_pre: numberText.optional(),
  pred_pre_sig: z.string().max(2).optional(),
  acc_trde_qty: quantity.optional(),
});
const usBar = ohlcv.extend({
  bus_dt: z.string().regex(/^\d{8}$/),
  upd_stkpc_tp: z.string().max(4),
  upd_rt: z.string().max(30),
});
const envelope = z.object({
  return_code: z.number().int(),
  return_msg: z.string().max(1000).optional(),
});
const krPage = envelope.extend({
  stk_cd: z.string(),
  stk_min_pole_chart_qry: z.array(z.unknown()).max(MAX_KIWOOM_ROWS),
});
const usPage = envelope.extend({
  result_list: z.array(z.unknown()).max(MAX_KIWOOM_ROWS),
});
const krBook = envelope.extend({
  bid_req_base_tm: z.string().max(20),
  sel_fpr_bid: numberText,
  buy_fpr_bid: numberText,
  sel_fpr_req: quantity,
  buy_fpr_req: quantity,
});
const usBook = envelope.extend({
  stex_tp: z.enum(["NA", "ND", "NY"]),
  stk_cd: z.string(),
  dt: z.string().regex(/^\d{8}$/),
  bid_tm: z.string().regex(/^\d{2}:\d{2}$/),
  sel_1bid: numberText,
  buy_1bid: numberText,
  sel_1bid_req: quantity,
  buy_1bid_req: quantity,
});
const venues = { NA: "AMEX", ND: "NASDAQ", NY: "NYSE" };
const isChart = (c: KiwoomCapture) =>
  c.request.apiId === "ka10080" || c.request.apiId === "usa06011";

// 날짜/시각의 형식만 검사한다. 시간대·거래일·봉 시작/종료 의미를 추정하지 않는다.
function validCivilTime(value: string): boolean {
  if (!/^\d{14}$/.test(value) || Number(value.slice(0, 4)) < 1900) return false;
  const parts = [0, 4, 6, 8, 10, 12].map((start, index, a) =>
    Number(value.slice(start, a[index + 1] ?? 14)),
  );
  const [y, m, d, h, min, s] = parts;
  const time = new Date(Date.UTC(y!, m! - 1, d!, h!, min!, s!));
  return (
    time.getUTCFullYear() === y &&
    time.getUTCMonth() + 1 === m &&
    time.getUTCDate() === d &&
    time.getUTCHours() === h &&
    time.getUTCMinutes() === min &&
    time.getUTCSeconds() === s
  );
}
function pricesValid(values: string[], kr: boolean, signed: boolean) {
  return values.every(
    (v) =>
      (signed || !v.startsWith("-")) &&
      dec(v).abs().gt(0) &&
      (!kr || dec(v).isInteger()),
  );
}
function normalize(c: KiwoomCapture, asOf: string): CaptureResult {
  const kr = c.request.apiId.startsWith("ka");
  const venue =
    "stex_tp" in c.request.body ? venues[c.request.body.stex_tp] : "KRX";
  const result: CaptureResult = {
    captureId: c.captureId,
    apiId: c.request.apiId,
    request: c.request,
    requestContinuation: c.requestContinuation,
    connectionEpoch: c.connectionEpoch,
    requestedAt: utc(c.requestedAt),
    identity: {
      symbol: c.request.body.stk_cd,
      market: kr ? "KR" : "US",
      currency: kr ? "KRW" : "USD",
      venue,
      basis: "REQUEST_CONTEXT_UNVERIFIED",
    },
    receivedAt: utc(c.receivedAt),
    availableAt: utc(c.availableAt),
    responseHash: hash(c.response ?? null),
    status: "MOCK_PARSED",
    reasons: [],
    continuation: c.responseContinuation,
    observations: [],
    semanticHolds: isChart(c)
      ? [
          "SOURCE_TIMEZONE_UNVERIFIED",
          "BAR_BOUNDARY_UNVERIFIED",
          "PRICE_ADJUSTMENT_UNVERIFIED",
          "HISTORY_COVERAGE_UNVERIFIED",
        ]
      : [
          "SOURCE_TIME_UNVERIFIED",
          "QUOTE_FRESHNESS_UNVERIFIED",
          "TOP_LEVEL_ONLY",
        ],
  };
  if (!kr && isChart(c)) result.semanticHolds.push("US_VOLUME_UNIT_UNVERIFIED");
  if (kr || !isChart(c))
    result.semanticHolds.push("PRICE_SIGN_INTERPRETATION_UNVERIFIED");
  const block = (reason: string) => {
    result.status = "BLOCKED";
    result.reasons.push(reason);
  };
  if (Date.parse(c.availableAt) > Date.parse(asOf))
    block("CAPTURE_NOT_AVAILABLE_AS_OF");
  if (c.outcome !== "RESPONSE") {
    block(c.outcome === "TIMEOUT" ? "MOCK_TIMEOUT" : "MOCK_DISCONNECTED");
    return result;
  }
  if (c.httpStatus !== 200) {
    block("MOCK_HTTP_FAILURE");
    return result;
  }
  if (c.responseApiId !== c.request.apiId) {
    block("RESPONSE_TR_MISMATCH");
    return result;
  }
  const common = envelope.safeParse(c.response);
  if (!common.success) {
    block("ENVELOPE_INVALID");
    return result;
  }
  if (common.data.return_code !== 0) {
    block("PROVIDER_ERROR");
    return result;
  }
  const inherited = [...result.reasons];
  const add = (
    raw: unknown,
    data: Fields | null,
    rawTime: string | null,
    issues: string[],
    index: number,
    precision: Observation["sourceTimePrecision"],
  ) => {
    const reasons = [...inherited, ...issues];
    result.observations.push({
      observationId: `${c.captureId}.${index}`,
      logicalKey:
        data && rawTime
          ? `KIWOOM|${c.request.apiId}|${venue}|${c.request.body.stk_cd}|${rawTime}`
          : `INVALID|${c.captureId}|${index}`,
      receivedAt: result.receivedAt,
      availableAt: result.availableAt,
      sourceTimestampRaw: rawTime,
      sourceTimePrecision: precision,
      eventAt: null,
      payloadHash: hash(raw),
      localObservationVersion: 1,
      duplicateOf: null,
      status: reasons.length ? "BLOCKED" : "MOCK_PARSED",
      reasons,
      data,
    });
    if (reasons.length) block("ROW_BLOCKED");
  };
  if (isChart(c)) {
    const page = kr
      ? krPage.safeParse(c.response)
      : usPage.safeParse(c.response);
    if (!page.success) {
      block("ENVELOPE_INVALID");
      return result;
    }
    if ("stk_cd" in page.data && page.data.stk_cd !== c.request.body.stk_cd) {
      block("RESPONSE_SYMBOL_MISMATCH");
      return result;
    }
    const rows =
      "stk_min_pole_chart_qry" in page.data
        ? page.data.stk_min_pole_chart_qry
        : page.data.result_list;
    rows.forEach((raw, index) => {
      const parsed = kr ? krBar.safeParse(raw) : usBar.safeParse(raw);
      if (!parsed.success) {
        add(raw, null, null, ["ROW_INVALID"], index, null);
        return;
      }
      const v = parsed.data,
        issues: string[] = [];
      const prices = [v.open_pric, v.high_pric, v.low_pric, v.cur_prc];
      if (!pricesValid(prices, kr, kr)) issues.push("PRICE_INVALID");
      const [o, h, l, close] = prices.map((v) => dec(v).abs());
      if (h!.lt(l!) || o!.lt(l!) || o!.gt(h!) || close!.lt(l!) || close!.gt(h!))
        issues.push("OHLC_INVALID");
      const timeValid = validCivilTime(v.cntr_tm);
      // cntr_tm은 초까지 있는 형식이다. 00초 정렬이나 봉 시작/종료는 미확인이다.
      if (!timeValid) issues.push("SOURCE_LOCAL_TIME_INVALID");
      if ("bus_dt" in v && !validCivilTime(`${v.bus_dt}000000`))
        issues.push("BUSINESS_DATE_INVALID");
      if ("upd_stkpc_tp" in v && !["", "0"].includes(v.upd_stkpc_tp))
        issues.push("RESPONSE_ADJUSTMENT_CONFLICT");
      const data: Fields = {
        open: o!.toFixed(),
        high: h!.toFixed(),
        low: l!.toFixed(),
        close: close!.toFixed(),
        volume: dec(v.trde_qty).toFixed(),
        currency: kr ? "KRW" : "USD",
        priceBasis: "UNVERIFIED",
      };
      if ("bus_dt" in v) {
        data.businessDateRaw = v.bus_dt;
        data.adjustmentRaw = v.upd_stkpc_tp;
        data.adjustmentRatioRaw = v.upd_rt;
      }
      add(raw, data, v.cntr_tm, issues, index, timeValid ? "SECOND" : null);
    });
  } else {
    const parsed = kr
      ? krBook.safeParse(c.response)
      : usBook.safeParse(c.response);
    if (!parsed.success) {
      block("ORDERBOOK_FIELDS_INVALID");
      return result;
    }
    const v = parsed.data,
      issues: string[] = [];
    if (
      "stk_cd" in v &&
      (v.stk_cd !== c.request.body.stk_cd ||
        !("stex_tp" in c.request.body) ||
        v.stex_tp !== c.request.body.stex_tp)
    )
      issues.push("RESPONSE_IDENTITY_MISMATCH");
    const ask = "sel_fpr_bid" in v ? v.sel_fpr_bid : v.sel_1bid;
    const bid = "buy_fpr_bid" in v ? v.buy_fpr_bid : v.buy_1bid;
    const askQty = "sel_fpr_req" in v ? v.sel_fpr_req : v.sel_1bid_req;
    const bidQty = "buy_fpr_req" in v ? v.buy_fpr_req : v.buy_1bid_req;
    if (!pricesValid([ask, bid], kr, true)) issues.push("PRICE_INVALID");
    if (dec(askQty).lte(0) || dec(bidQty).lte(0))
      issues.push("EMPTY_TOP_LEVEL");
    if (dec(bid).abs().gte(dec(ask).abs()))
      issues.push("LOCKED_OR_CROSSED_ORDERBOOK");
    // KR 명세의 YYYYMMDD 설명과 HHmmss 예시가 상충한다. 날짜를 수신일로 채우지 않는다.
    const rawTime =
      "bid_req_base_tm" in v ? v.bid_req_base_tm : `${v.dt} ${v.bid_tm}`;
    let precision: Observation["sourceTimePrecision"] = null;
    if ("bid_req_base_tm" in v) {
      if (
        v.bid_req_base_tm.length === 6 &&
        validCivilTime(`20000101${v.bid_req_base_tm}`)
      )
        precision = "SECOND";
      else if (
        v.bid_req_base_tm.length === 8 &&
        validCivilTime(`${v.bid_req_base_tm}000000`)
      )
        precision = "DAY";
    } else if (validCivilTime(`${v.dt}${v.bid_tm.replace(":", "")}00`))
      precision = "MINUTE";
    if (precision === null) issues.push("SOURCE_LOCAL_TIME_INVALID");
    add(
      c.response,
      {
        ask: dec(ask).abs().toFixed(),
        bid: dec(bid).abs().toFixed(),
        askQuantity: dec(askQty).toFixed(),
        bidQuantity: dec(bidQty).toFixed(),
        currency: kr ? "KRW" : "USD",
      },
      rawTime,
      issues,
      0,
      precision,
    );
  }
  result.reasons = [...new Set(result.reasons)].sort();
  return result;
}

function runPages(plan: KiwoomPagePlan, asOf: string) {
  const captures: CaptureResult[] = [],
    reasons: string[] = [];
  const cursors = new Set<string>(),
    rows = new Set<string>();
  const first = plan.replies[0]!;
  let expected = { contYn: "N", nextKey: "" },
    stop = "PAGE_BUDGET_EXHAUSTED";
  for (let i = 0; i < plan.maxPages; i++) {
    const c = plan.replies[i];
    if (!c) {
      reasons.push("MOCK_REPLY_MISSING");
      stop = "BLOCKED";
      break;
    }
    const parsed = normalize(c, asOf);
    captures.push(parsed);
    if (!isChart(c)) reasons.push("PAGE_TR_UNSUPPORTED");
    if (
      hash(c.request) !== hash(first.request) ||
      hash(c.requestContinuation) !== hash(expected)
    )
      reasons.push("PAGE_REQUEST_MISMATCH");
    if (c.connectionEpoch !== first.connectionEpoch)
      reasons.push("RECONNECT_REQUIRES_NEW_PLAN");
    const previous = plan.replies[i - 1];
    if (
      previous &&
      Date.parse(c.requestedAt) < Date.parse(previous.availableAt)
    )
      reasons.push("PAGE_CAPTURE_ORDER_INVALID");
    reconcileSourceObservations(captures, asOf);
    if (captures.some((c) => c.status === "BLOCKED"))
      reasons.push("PAGE_DATA_BLOCKED");
    if (reasons.length) {
      parsed.status = "BLOCKED";
      parsed.reasons = [...new Set([...parsed.reasons, ...reasons])].sort();
      for (const row of parsed.observations) {
        row.status = "BLOCKED";
        row.reasons = [...new Set([...row.reasons, ...reasons])].sort();
      }
      stop = "BLOCKED";
      break;
    }
    const next = c.responseContinuation;
    if (!next) {
      reasons.push("CONTINUATION_UNKNOWN");
      stop = "BLOCKED";
      break;
    }
    if (!parsed.observations.length && next.contYn === "Y") {
      reasons.push("EMPTY_PAGE_WITH_CONTINUATION");
      stop = "BLOCKED";
      break;
    }
    if (parsed.observations.length) {
      const before = rows.size;
      for (const row of parsed.observations) rows.add(row.logicalKey);
      if (rows.size === before) {
        reasons.push("PAGE_NO_PROGRESS");
        stop = "BLOCKED";
        break;
      }
    }
    if (next.contYn === "N") {
      stop = "SOURCE_EXHAUSTED";
      break;
    }
    if (cursors.has(next.nextKey)) {
      reasons.push("CURSOR_REPEATED");
      stop = "BLOCKED";
      break;
    }
    cursors.add(next.nextKey);
    expected = next;
  }
  if (stop === "PAGE_BUDGET_EXHAUSTED") reasons.push(stop);
  return {
    planId: plan.planId,
    stop,
    reasons,
    captures,
    attempts: captures.length,
    unusedMockReplies: plan.replies.length - captures.length,
    historyCoverageVerified: false as const,
  };
}

// 입력된 모형 응답만 처리한다. URL·키·인증·전송 함수·주문·파일 저장 경로가 없다.
export function ingestMockKiwoom(raw: unknown) {
  const input = parseKiwoomInput(raw);
  const captures = input.captures.map((c) => normalize(c, input.asOf));
  const pagePlans = input.pagePlans.map((p) => runPages(p, input.asOf));
  const all = [...captures, ...pagePlans.flatMap((p) => p.captures)];
  reconcileSourceObservations(all, input.asOf);
  for (const plan of pagePlans)
    if (plan.captures.some((c) => c.status === "BLOCKED")) {
      plan.stop = "BLOCKED";
      plan.reasons = [
        ...new Set([...plan.reasons, "GLOBAL_OBSERVATION_BLOCKED"]),
      ].sort();
    }
  const report = {
    schemaVersion: "OFFLINE_KIWOOM_INGEST_REPORT_V1",
    source: "KIWOOM_REST",
    purpose: input.purpose,
    dataOrigin: input.dataOrigin,
    sourceSpecCommit: KIWOOM_SPEC_COMMIT,
    sourceSpecSha256: KIWOOM_SPEC_SHA256,
    asOf: utc(input.asOf),
    inputHash: hash(raw),
    policyHash,
    status:
      all.some((c) => c.status === "BLOCKED") ||
      pagePlans.some((p) => p.reasons.length)
        ? "HAS_BLOCKS"
        : "MOCK_FORMAT_PARSED_SEMANTICS_HOLD",
    sourceAuthentication: "UNVERIFIED_MOCK",
    realCollectionEnabled: false,
    realDataReady: false,
    strategyReady: false,
    strategyEvaluated: false,
    historicalPointInTimeVerified: false,
    paperOrdersEnabled: false,
    liveEnabled: false,
    networkRequests: 0,
    semanticHolds: [...new Set(all.flatMap((c) => c.semanticHolds))].sort(),
    captures,
    pagePlans,
    counts: {
      captures: all.length,
      observations: all.reduce((n, c) => n + c.observations.length, 0),
      duplicates: all
        .flatMap((c) => c.observations)
        .filter((r) => r.duplicateOf !== null).length,
    },
  };
  return { ...report, reportHash: hash(report) };
}
