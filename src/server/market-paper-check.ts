import { policy } from "../core/policy.js";
import { d } from "../core/math.js";
import {
  MarketDataError,
  marketSymbols,
  TossMarketData,
  type Credentials,
  type MarketSymbol,
} from "./toss-market-data.js";

type Prices = Awaited<ReturnType<TossMarketData["prices"]>>;
type Book = Awaited<ReturnType<TossMarketData["orderbook"]>>;
type Candles = Awaited<ReturnType<TossMarketData["candles"]>>;
type Calendar = Awaited<ReturnType<TossMarketData["calendar"]>>;
export interface Observation {
  prices: Prices | null;
  calendar: Calendar | null;
  books: Partial<Record<MarketSymbol, Book>>;
  candles: Partial<Record<MarketSymbol, Candles>>;
}
export function checkMarketPaper(observation: Observation, at: number) {
  const decisions = marketSymbols.map((symbol) => {
    // 원본 필수 프로필을 실제 자료 연결만으로 채우거나 합성 예측/비용을 승계하지 않는다.
    const reasons = [
      "MISSING_REAL_FORECAST_PROFILE",
      "MISSING_PRODUCT_COST_EXECUTION_PROFILE",
      "MISSING_PIT_HISTORY_AND_BENCHMARK",
      "MISSING_CORPORATE_ACTION_AND_EVENT_DATA",
      "USD_VIRTUAL_FUNDS_NOT_ALLOCATED",
    ];
    const price = observation.prices?.data.find((x) => x.symbol === symbol);
    const book = observation.books[symbol]?.data;
    const candleBatch = observation.candles[symbol];
    const sourceAt = price?.timestamp ? Date.parse(price.timestamp) : null;
    if (!price || sourceAt === null) reasons.push("PRICE_TIME_MISSING");
    else if (sourceAt > at) reasons.push("PRICE_FROM_FUTURE");
    const quoteAt = book?.timestamp ? Date.parse(book.timestamp) : null;
    if (quoteAt === null) reasons.push("QUOTE_TIME_MISSING");
    else if (
      quoteAt > at ||
      at - quoteAt > policy.execution.maximum_quote_age_seconds * 1000
    )
      reasons.push("QUOTE_STALE_OR_FUTURE");
    const bestAsk = book?.asks
      .filter((x) => d(x.volume).gt(0))
      .sort((a, b) => d(a.price).cmp(b.price))[0];
    const bestBid = book?.bids
      .filter((x) => d(x.volume).gt(0))
      .sort((a, b) => d(b.price).cmp(a.price))[0];
    if (!bestAsk || !bestBid) reasons.push("ORDERBOOK_EMPTY");
    else if (d(bestBid.price).gt(bestAsk.price))
      reasons.push("ORDERBOOK_CROSSED");
    const sessions = observation.calendar
      ? Object.values(observation.calendar.data)
          .map((x) => x.regularMarket)
          .filter((x) => x !== null)
      : [];
    const open = sessions.some(
      (s) => at >= Date.parse(s.startTime) && at < Date.parse(s.endTime),
    );
    if (!observation.calendar) reasons.push("MARKET_CALENDAR_MISSING");
    else if (!open) reasons.push("OUTSIDE_REGULAR_SESSION");
    // 공식 1분봉 timestamp는 종료 시각이다. 수신 시각을 과거로 소급하지 않는다.
    const complete =
      candleBatch?.data.candles.filter(
        (b) =>
          Date.parse(b.timestamp) <= Date.parse(candleBatch.receivedAt) &&
          Date.parse(b.timestamp) <= at,
      ) ?? [];
    if (!complete.length) reasons.push("COMPLETED_BARS_MISSING");
    return {
      symbol,
      result: "ABSTAIN" as const,
      quantity: 0,
      reasons,
      lastPrice: price?.lastPrice ?? null,
      currency: "USD",
      sourceAt,
      quoteAt,
      quoteAgeMs: quoteAt === null ? null : at - quoteAt,
      regularSessionOpen: open,
      completedMinuteBars: complete.length,
      bestBid: bestBid?.price ?? null,
      bestAsk: bestAsk?.price ?? null,
      strategyEvaluated: false,
    };
  });
  return {
    at: new Date(at).toISOString(),
    mode: "REAL_DATA_PAPER_PREFLIGHT_ONLY" as const,
    realOrdersEnabled: false,
    accountAccessEnabled: false,
    strategyEvaluated: false,
    syntheticForecastUsed: false,
    virtualWallet: { KRW: "5000000", USD: "0" },
    paperOrders: [],
    decisions,
  };
}

export async function runMarketCheck(
  client: TossMarketData,
  credentials: Credentials,
) {
  const observation: Observation = {
    prices: null,
    calendar: null,
    books: {},
    candles: {},
  };
  let failure: string | null = null;
  try {
    await client.authenticate(credentials);
    credentials.clientId = "";
    credentials.clientSecret = "";
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    observation.prices = await client.prices();
    observation.calendar = await client.calendar(date);
    // 호출 횟수를 제한하고 오류 즉시 중단한다. 자동 재인증/무기한 폴링은 하지 않는다.
    for (const symbol of marketSymbols) {
      observation.books[symbol] = await client.orderbook(symbol);
      observation.candles[symbol] = await client.candles(symbol);
    }
  } catch (error) {
    failure =
      error instanceof MarketDataError ? error.code : "UNEXPECTED_FAILURE";
  } finally {
    credentials.clientId = "";
    credentials.clientSecret = "";
    client.close();
  }
  return {
    ...checkMarketPaper(observation, Date.now()),
    connectionStatus: failure
      ? observation.prices
        ? "PARTIAL_FAILED"
        : "FAILED"
      : "CONNECTED_SNAPSHOT_ONLY",
    failure,
    requests: client.audit,
    observation,
    limitations: [
      "짧은 REST 스냅샷 점검이며 지속 실행/전체 전략 평가가 아닙니다.",
      "모의 주문은 필수 프로필이 없어 보류하며 실제 주문/계좌/환전 경로는 없습니다.",
      "가상 500만원은 별도 시험 장부이며 실제 잔고 조회나 기존 합성 DB 변경이 아닙니다.",
    ],
  };
}
