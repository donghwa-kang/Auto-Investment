import { z } from "zod";
import { hash, policy } from "./policy.js";
import {
  arrayEnvelope,
  bookRow,
  dec,
  detailRow,
  indicatorBar,
  krCalendar,
  listingRow,
  minuteMs,
  pageEnvelope,
  priceRow,
  singleEnvelope,
  stockBar,
  usCalendar,
  utc,
  type SourceCapture,
} from "./source-ingest-schema.js";

type Json = null | boolean | string | number | Json[] | { [key: string]: Json };
type ObjectData = { [key: string]: Json };
const jsonObject = (value: object): ObjectData =>
  JSON.parse(JSON.stringify(value)) as ObjectData;
export interface SourceObservation {
  observationId: string;
  captureId: string;
  kind: SourceCapture["request"]["kind"];
  logicalKey: string;
  sourceTimestampRaw: string | null;
  eventAt: string | null;
  sourcePublishedAt: null;
  sourceRevision: null;
  receivedAt: string;
  availableAt: string;
  localObservationVersion: number;
  duplicateOf: string | null;
  status: "MOCK_PARSED" | "BLOCKED";
  reasons: string[];
  identity: {
    symbol: string | null;
    market: string;
    currency: string | null;
    marketSegment: string | null;
    executionVenue: null;
    isinCode: string | null;
    basis: "RESPONSE_FIELDS" | "REQUEST_CONTEXT_UNVERIFIED";
  };
  data: ObjectData | null;
  payloadHash: string;
}
export interface CaptureResult {
  captureId: string;
  request: SourceCapture["request"];
  requestedAt: string;
  receivedAt: string;
  availableAt: string;
  responseHash: string;
  status: "MOCK_PARSED" | "BLOCKED";
  reasons: string[];
  observations: SourceObservation[];
  nextBefore: string | null;
  cursorPresent: boolean;
}
const country = (segment: string) =>
  ["KOSPI", "KOSDAQ", "KR_ETC"].includes(segment) ? "KR" : "US";
const expectedCurrency = (market: string) => (market === "KR" ? "KRW" : "USD");
function calendarIssues(
  value: z.infer<typeof krCalendar> | z.infer<typeof usCalendar>,
  capture: SourceCapture,
) {
  const issues: string[] = [];
  const kr = capture.request.kind === "CALENDAR_KR";
  const requestedDate = "date" in capture.request ? capture.request.date : "";
  if (
    value.today.date !== requestedDate ||
    value.previousBusinessDay.date >= value.today.date ||
    value.nextBusinessDay.date <= value.today.date
  )
    issues.push("CALENDAR_DATE_MISMATCH");
  for (const day of Object.values(value)) {
    const sessions = "integrated" in day ? day.integrated : day;
    if (sessions === undefined) {
      issues.push("SESSION_FIELD_MISSING");
      continue;
    }
    if (sessions === null) continue;
    const fields = kr
      ? ["preMarket", "regularMarket", "afterMarket"]
      : ["dayMarket", "preMarket", "regularMarket", "afterMarket"];
    const values = jsonObject(sessions);
    let previousEnd: number | null = null;
    for (const field of fields) {
      const session = values[field];
      if (session === undefined) {
        issues.push("SESSION_FIELD_MISSING");
        continue;
      }
      if (session === null) continue;
      const entry = session as ObjectData;
      const start = Date.parse(entry.startTime as string),
        end = Date.parse(entry.endTime as string);
      if (
        end <= start ||
        end - start > 86400000 ||
        (previousEnd !== null && start < previousEnd)
      )
        issues.push("SESSION_ORDER_INVALID");
      previousEnd = end;
      for (const name of [
        "singlePriceAuctionStartTime",
        "singlePriceAuctionEndTime",
      ]) {
        const boundary = entry[name];
        if (
          typeof boundary === "string" &&
          (Date.parse(boundary) < start || Date.parse(boundary) > end)
        )
          issues.push("AUCTION_BOUNDARY_INVALID");
      }
      if (field === "regularMarket") {
        const date = new Intl.DateTimeFormat("en-CA", {
          timeZone: kr ? "Asia/Seoul" : "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(start);
        if (date !== day.date) issues.push("SESSION_TRADING_DATE_MISMATCH");
      }
    }
  }
  return issues;
}

// 순수 변환기: 실제 인증·통신·자금·매매·파일 접근 없음.
export function normalizeSourceCapture(
  capture: SourceCapture,
  asOf: string,
): CaptureResult {
  const request = capture.request;
  const result: CaptureResult = {
    captureId: capture.captureId,
    request,
    requestedAt: utc(capture.requestedAt),
    receivedAt: utc(capture.receivedAt),
    availableAt: utc(capture.availableAt),
    responseHash: hash(capture.response ?? null),
    status: "MOCK_PARSED",
    reasons: [],
    observations: [],
    nextBefore: null,
    cursorPresent: false,
  };
  const block = (reason: string) => {
    result.reasons.push(reason);
    result.status = "BLOCKED";
  };
  if (Date.parse(capture.availableAt) > Date.parse(asOf))
    block("CAPTURE_NOT_AVAILABLE_AS_OF");
  if (capture.outcome === "TIMEOUT") {
    block("MOCK_TIMEOUT");
    return result;
  }
  if (capture.httpStatus !== 200) {
    block("MOCK_HTTP_FAILURE");
    return result;
  }
  const captureReasons = [...result.reasons];
  const add = (raw: unknown, schema: z.ZodType, index: number) => {
    const parsed = schema.safeParse(raw);
    const requestMarket =
      "target" in request
        ? request.target.market
        : request.kind === "LISTING"
          ? country(request.market)
          : request.kind === "CALENDAR_US"
            ? "US"
            : "KR";
    const row: SourceObservation = {
      observationId: `${capture.captureId}.${index}`,
      captureId: capture.captureId,
      kind: request.kind,
      logicalKey: `${request.kind}|INVALID|${capture.captureId}|${index}`,
      sourceTimestampRaw: null,
      eventAt: null,
      sourcePublishedAt: null,
      sourceRevision: null,
      receivedAt: result.receivedAt,
      availableAt: result.availableAt,
      localObservationVersion: 1,
      duplicateOf: null,
      status: "MOCK_PARSED",
      reasons: [...captureReasons],
      identity: {
        symbol:
          "target" in request
            ? request.target.symbol
            : "symbol" in request
              ? request.symbol
              : null,
        market: requestMarket,
        currency: null,
        marketSegment: null,
        executionVenue: null,
        isinCode: null,
        basis: "REQUEST_CONTEXT_UNVERIFIED",
      },
      data: null,
      payloadHash: hash(raw ?? null),
    };
    if (!parsed.success) {
      row.reasons.push("PAYLOAD_INVALID");
    } else {
      // 결과에는 allowlist 스키마를 통과한 필드만 복제한다. 오류 본문/알 수 없는 필드는 제외한다.
      const data = jsonObject(parsed.data as object);
      row.data = data;
      if (typeof data.symbol === "string") row.identity.symbol = data.symbol;
      if (typeof data.currency === "string")
        row.identity.currency = data.currency;
      if (typeof data.isinCode === "string")
        row.identity.isinCode = data.isinCode;
      if (request.kind === "LISTING")
        row.identity.marketSegment = request.market;
      if (request.kind === "DETAIL") {
        row.identity.marketSegment = data.market as string;
        row.identity.market = country(data.market as string);
        row.identity.basis = "RESPONSE_FIELDS";
        if (dec(data.sharesOutstanding as string).lt(0))
          row.reasons.push("VALUE_INVALID");
        if (row.identity.market === "US" && data.koreanMarketDetail != null)
          row.reasons.push("DETAIL_MARKET_MISMATCH");
        // 레버리지 배수는 기초자산 종류·예탁금·주문 자격을 증명하지 않는다.
        data.underlying = "UNKNOWN";
        data.requiredDepositKrw = null;
        data.corporateActionStatus = "UNKNOWN";
        data.sourceEffectiveAt = null;
      }
      if ("targets" in request) {
        const target = request.targets.find(
          (t) => t.symbol === row.identity.symbol,
        );
        if (!target) row.reasons.push("UNREQUESTED_SYMBOL");
        else {
          if (
            request.kind === "DETAIL" &&
            row.identity.market !== target.market
          )
            row.reasons.push("DETAIL_MARKET_MISMATCH");
          row.identity.market = target.market;
          if (data.currency !== target.currency)
            row.reasons.push("CURRENCY_MISMATCH");
        }
      }
      if ("target" in request && data.currency !== request.target.currency)
        row.reasons.push("CURRENCY_MISMATCH");
      if (
        data.currency != null &&
        data.currency !== expectedCurrency(row.identity.market)
      )
        row.reasons.push("CURRENCY_MISMATCH");
      if (typeof data.timestamp === "string") {
        row.sourceTimestampRaw = data.timestamp;
        row.eventAt = utc(data.timestamp);
        data.timestamp = row.eventAt;
        if (Date.parse(row.eventAt) > Date.parse(capture.receivedAt))
          row.reasons.push("SOURCE_TIME_AFTER_RECEIPT");
      } else if (["PRICES", "ORDERBOOK"].includes(request.kind))
        row.reasons.push("SOURCE_TIMESTAMP_MISSING");
      if (request.kind === "PRICES" && !dec(data.lastPrice as string).gt(0))
        row.reasons.push("VALUE_INVALID");
      if (request.kind === "ORDERBOOK") {
        const asks = data.asks as ObjectData[],
          bids = data.bids as ObjectData[];
        if (
          [...asks, ...bids].some(
            (p) =>
              !dec(p.price as string).gt(0) || dec(p.volume as string).lt(0),
          )
        )
          row.reasons.push("VALUE_INVALID");
        const best = (levels: ObjectData[], ascending: boolean) =>
          levels
            .filter((p) => dec(p.volume as string).gt(0))
            .sort(
              (a, b) =>
                (ascending ? 1 : -1) *
                dec(a.price as string).cmp(b.price as string),
            )[0];
        const ask = best(asks, true),
          bid = best(bids, false);
        data.bestAsk = ask?.price ?? null;
        data.bestBid = bid?.price ?? null;
        if (!ask || !bid) row.reasons.push("EMPTY_ORDERBOOK");
        else if (dec(bid.price as string).gt(ask.price as string))
          row.reasons.push("CROSSED_ORDERBOOK");
        if (
          row.eventAt &&
          Date.parse(asOf) - Date.parse(row.eventAt) >
            policy.execution.maximum_quote_age_seconds * 1000
        )
          row.reasons.push("QUOTE_STALE");
      }
      if (
        request.kind === "STOCK_CANDLES" ||
        request.kind === "INDICATOR_CANDLES"
      ) {
        const timestamp = Date.parse(data.timestamp as string);
        const openAt =
          request.kind === "STOCK_CANDLES" ? timestamp - minuteMs : timestamp;
        const closeAt = openAt + minuteMs;
        data.openAt = new Date(openAt).toISOString();
        data.closeAt = new Date(closeAt).toISOString();
        data.timestampConvention =
          request.kind === "STOCK_CANDLES" ? "CLOSE" : "OPEN";
        data.priceBasis =
          request.kind === "STOCK_CANDLES" ? "RAW_REQUESTED" : "INDEX_LEVEL";
        data.halted = null;
        data.corporateActionStatus = "UNKNOWN";
        if (request.kind === "INDICATOR_CANDLES") {
          row.identity.market = "KR";
          data.unit = "POINTS";
        }
        data.completedAtReceipt = closeAt <= Date.parse(capture.receivedAt);
        if (openAt % minuteMs !== 0) row.reasons.push("BAR_ALIGNMENT_INVALID");
        if (
          closeAt > Date.parse(capture.receivedAt) ||
          closeAt > Date.parse(asOf)
        )
          row.reasons.push("BAR_NOT_CLOSED");
        if (request.before && timestamp > Date.parse(request.before))
          row.reasons.push("BEFORE_BOUND_EXCEEDED");
        const o = dec(data.openPrice as string),
          h = dec(data.highPrice as string),
          l = dec(data.lowPrice as string),
          c = dec(data.closePrice as string);
        if (
          !o.gt(0) ||
          !l.gt(0) ||
          h.lt(l) ||
          h.lt(o) ||
          h.lt(c) ||
          l.gt(o) ||
          l.gt(c) ||
          dec(data.volume as string).lt(0)
        )
          row.reasons.push("OHLCV_INVALID");
      }
      if (request.kind === "CALENDAR_KR" || request.kind === "CALENDAR_US") {
        row.reasons.push(
          ...calendarIssues(
            parsed.data as
              z.infer<typeof krCalendar> | z.infer<typeof usCalendar>,
            capture,
          ),
        );
        data.sessionInterpretation =
          "PROVIDER_SESSIONS_NOT_APPROVED_STRATEGY_WINDOW";
      }
      const identity = row.identity;
      row.logicalKey = [
        request.kind,
        identity.market,
        identity.symbol ?? "CALENDAR",
        request.kind === "LISTING"
          ? request.market
          : (identity.marketSegment ?? ""),
        data.openAt ??
          row.eventAt ??
          ("date" in request ? request.date : "SNAPSHOT"),
      ].join("|");
      row.payloadHash = hash({ identity, data });
    }
    row.reasons = [...new Set(row.reasons)].sort();
    row.status = row.reasons.length ? "BLOCKED" : "MOCK_PARSED";
    if (row.status === "BLOCKED") block("ROW_BLOCKED");
    result.observations.push(row);
  };
  if (
    request.kind === "LISTING" ||
    request.kind === "DETAIL" ||
    request.kind === "PRICES"
  ) {
    const parsed = arrayEnvelope.safeParse(capture.response);
    if (!parsed.success) block("ENVELOPE_INVALID");
    else {
      const rows = parsed.data.result;
      if ("targets" in request && rows.length > 200)
        block("RESPONSE_COUNT_EXCEEDED");
      else
        rows.forEach((raw, index) =>
          add(
            raw,
            request.kind === "LISTING"
              ? listingRow
              : request.kind === "DETAIL"
                ? detailRow
                : priceRow,
            index,
          ),
        );
      if ("targets" in request) {
        const seen = new Set(result.observations.map((r) => r.identity.symbol));
        if (request.targets.some((t) => !seen.has(t.symbol)))
          block("REQUESTED_SYMBOL_MISSING");
      }
    }
  } else if (
    request.kind === "STOCK_CANDLES" ||
    request.kind === "INDICATOR_CANDLES"
  ) {
    const parsed = pageEnvelope.safeParse(capture.response);
    if (!parsed.success) block("ENVELOPE_INVALID");
    else {
      result.cursorPresent =
        Object.hasOwn(parsed.data.result, "nextBefore") &&
        parsed.data.result.nextBefore !== undefined;
      result.nextBefore = parsed.data.result.nextBefore
        ? utc(parsed.data.result.nextBefore)
        : null;
      if (parsed.data.result.candles.length > request.count)
        block("RESPONSE_COUNT_EXCEEDED");
      else
        parsed.data.result.candles.forEach((raw, index) =>
          add(
            raw,
            request.kind === "STOCK_CANDLES" ? stockBar : indicatorBar,
            index,
          ),
        );
    }
  } else {
    const parsed = singleEnvelope.safeParse(capture.response);
    if (!parsed.success) block("ENVELOPE_INVALID");
    else
      add(
        parsed.data.result,
        request.kind === "ORDERBOOK"
          ? bookRow
          : request.kind === "CALENDAR_KR"
            ? krCalendar
            : usCalendar,
        0,
      );
  }
  result.reasons = [...new Set(result.reasons)].sort();
  return result;
}

// 로컬 관측 버전은 공급자 정정 번호가 아니다. 상충을 최신 값으로 자동 해소하지 않는다.
type ReconciliationRow = Pick<
  SourceObservation,
  | "observationId"
  | "logicalKey"
  | "availableAt"
  | "payloadHash"
  | "duplicateOf"
  | "localObservationVersion"
  | "status"
  | "reasons"
>;
// 공급자 응답 구조와 무관한 관측 경계만 공유한다. 정규화/시각 해석은 공유하지 않는다.
export function reconcileSourceObservations(
  captures: {
    status: SourceObservation["status"];
    reasons: string[];
    observations: ReconciliationRow[];
  }[],
  asOf: string,
) {
  const groups = new Map<string, ReconciliationRow[]>();
  const rows = captures
    .flatMap((c) => c.observations)
    .sort(
      (a, b) =>
        Date.parse(a.availableAt) - Date.parse(b.availableAt) ||
        a.observationId.localeCompare(b.observationId, "en"),
    );
  for (const row of rows) {
    if (Date.parse(row.availableAt) > Date.parse(asOf)) continue;
    const group = groups.get(row.logicalKey) ?? [];
    groups.set(row.logicalKey, group);
    const duplicates = group.find((x) => x.payloadHash === row.payloadHash);
    row.duplicateOf = duplicates?.observationId ?? null;
    row.localObservationVersion =
      duplicates?.localObservationVersion ??
      new Set(group.map((x) => x.payloadHash)).size + 1;
    group.push(row);
  }
  for (const group of groups.values()) {
    if (new Set(group.map((r) => r.payloadHash)).size <= 1) continue;
    for (const row of group) {
      row.status = "BLOCKED";
      row.reasons = [
        ...new Set([...row.reasons, "SOURCE_REVISION_UNVERIFIED"]),
      ].sort();
    }
  }
  for (const capture of captures)
    if (capture.observations.some((r) => r.status === "BLOCKED")) {
      capture.status = "BLOCKED";
      capture.reasons = [
        ...new Set([...capture.reasons, "ROW_BLOCKED"]),
      ].sort();
    }
}
