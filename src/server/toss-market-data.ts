import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { d } from "../core/math.js";

// 계좌·주문·취소·환전 경로와 임의 URL/헤더를 받는 공개 메서드를 제공하지 않는다.
const origin = "https://openapi.tossinvest.com";
export const marketSymbols = ["SOXL", "SOXX"] as const;
export type MarketSymbol = (typeof marketSymbols)[number];
const symbolSchema = z.enum(marketSymbols);
const positive = z
  .string()
  .max(30)
  .regex(/^\d+(\.\d+)?$/)
  .refine((v) => /^\d+(\.\d+)?$/.test(v) && v.length <= 30 && d(v).gt(0));
const nonnegative = z
  .string()
  .max(30)
  .regex(/^\d+(\.\d+)?$/);
const timestamp = z.iso.datetime({ offset: true });
const priceSchema = z.object({
  symbol: symbolSchema,
  timestamp: timestamp.nullish(),
  lastPrice: positive,
  currency: z.literal("USD"),
});
const bookSchema = z.object({
  timestamp: timestamp.nullish(),
  currency: z.literal("USD"),
  asks: z.array(z.object({ price: positive, volume: nonnegative })).max(100),
  bids: z.array(z.object({ price: positive, volume: nonnegative })).max(100),
});
const candleSchema = z
  .object({
    timestamp,
    openPrice: positive,
    highPrice: positive,
    lowPrice: positive,
    closePrice: positive,
    volume: nonnegative,
    currency: z.literal("USD"),
  })
  .refine(
    (b) =>
      d(b.highPrice).gte(b.openPrice) &&
      d(b.highPrice).gte(b.closePrice) &&
      d(b.lowPrice).lte(b.openPrice) &&
      d(b.lowPrice).lte(b.closePrice) &&
      d(b.highPrice).gte(b.lowPrice),
  );
const sessionSchema = z
  .object({ startTime: timestamp, endTime: timestamp })
  .refine((s) => Date.parse(s.endTime) > Date.parse(s.startTime));
const daySchema = z.object({
  date: z.iso.date(),
  dayMarket: sessionSchema.nullable(),
  preMarket: sessionSchema.nullable(),
  regularMarket: sessionSchema.nullable(),
  afterMarket: sessionSchema.nullable(),
});
const calendarSchema = z.object({
  today: daySchema,
  previousBusinessDay: daySchema,
  nextBusinessDay: daySchema,
});
const candlesSchema = z.object({
  candles: z.array(candleSchema).max(200),
  nextBefore: timestamp.nullish(),
});
const tokenSchema = z.object({
  access_token: z
    .string()
    .min(1)
    .max(16000)
    .regex(/^[A-Za-z0-9._~-]+$/),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
});

export interface Credentials {
  clientId: string;
  clientSecret: string;
}
export interface RequestRecord {
  operation: string;
  status: number | null;
  at: string;
}
export class MarketDataError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MarketDataError";
  }
}

export function parseCredentials(text: string): Credentials {
  // 사용자가 지정한 라벨/다음 줄 형식만 허용. 파일 내용을 코드나 지시로 해석하지 않는다.
  if (text.length > 8192) throw new MarketDataError("CREDENTIAL_FILE_INVALID");
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  const values = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const match = /^(client[ _-]?(id|secret))\s*[:=]?\s*(.*)$/i.exec(lines[i]!);
    if (!match) continue;
    const key = match[2]!.toLowerCase();
    if (values.has(key)) throw new MarketDataError("CREDENTIAL_FILE_INVALID");
    const value = match[3] || lines[++i];
    if (!value || !/^[A-Za-z0-9._~+\/-]{8,4096}$/.test(value))
      throw new MarketDataError("CREDENTIAL_FILE_INVALID");
    values.set(key, value);
  }
  if (!values.get("id") || !values.get("secret"))
    throw new MarketDataError("CREDENTIAL_FILE_INVALID");
  return { clientId: values.get("id")!, clientSecret: values.get("secret")! };
}
export function readCredentials(path: string): Credentials {
  try {
    if (statSync(path).size > 8192) throw new Error();
    return parseCredentials(readFileSync(path, "utf8"));
  } catch {
    throw new MarketDataError("CREDENTIAL_FILE_INVALID");
  }
}

// 테스트에서만 가짜 transport 주입. 운영 CLI는 기본 fetch와 고정 origin만 사용한다.
export class TossMarketData {
  #token: string | null = null;
  #expiresAt = 0;
  #authAttempted = false;
  #requests: RequestRecord[] = [];
  #closed = false;
  constructor(private readonly transport: typeof fetch = fetch) {}
  get audit(): RequestRecord[] {
    return this.#requests.map((x) => ({ ...x }));
  }
  close() {
    this.#token = null;
    this.#expiresAt = 0;
    this.#closed = true;
  }
  async #request(
    path: string,
    method: "GET" | "POST",
    body?: URLSearchParams,
  ): Promise<unknown> {
    const url = new URL(path, origin);
    const allowedGet = [
      "/api/v1/prices",
      "/api/v1/orderbook",
      "/api/v1/candles",
      "/api/v1/market-calendar/US",
    ];
    if (
      this.#closed ||
      url.origin !== origin ||
      (method === "POST"
        ? path !== "/oauth2/token"
        : !allowedGet.includes(url.pathname))
    )
      throw new MarketDataError("ENDPOINT_DENIED");
    if (this.#requests.length >= 8)
      throw new MarketDataError("REQUEST_BUDGET_EXCEEDED");
    if (method === "GET" && (!this.#token || Date.now() >= this.#expiresAt))
      throw new MarketDataError("AUTH_REQUIRED");
    const record: RequestRecord = {
      operation: `${method} ${url.pathname}`,
      status: null,
      at: new Date().toISOString(),
    };
    this.#requests.push(record);
    let response: Response;
    try {
      response = await this.transport(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers:
          method === "POST"
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
              }
            : {
                Authorization: `Bearer ${this.#token}`,
                Accept: "application/json",
              },
        body: body?.toString(),
      });
      record.status = response.status;
    } catch {
      throw new MarketDataError("NETWORK_FAILED");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new MarketDataError(`HTTP_${response.status}`);
    }
    try {
      if (!response.headers.get("content-type")?.includes("application/json"))
        throw new Error();
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512000) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new MarketDataError("RESPONSE_INVALID");
    }
  }
  async authenticate(credentials: Credentials) {
    if (this.#authAttempted)
      throw new MarketDataError("AUTH_ALREADY_ATTEMPTED");
    this.#authAttempted = true;
    const result = await this.#request(
      "/oauth2/token",
      "POST",
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
    );
    const parsed = tokenSchema.safeParse(result);
    if (!parsed.success) throw new MarketDataError("AUTH_RESPONSE_INVALID");
    this.#token = parsed.data.access_token;
    this.#expiresAt = Date.now() + parsed.data.expires_in * 1000 - 5000;
  }
  async #data<T>(
    path: string,
    schema: z.ZodType<T>,
  ): Promise<{ receivedAt: string; data: T }> {
    const raw = await this.#request(path, "GET");
    try {
      const parsed = z.object({ result: schema }).safeParse(raw);
      if (!parsed.success) throw new Error();
      return { receivedAt: new Date().toISOString(), data: parsed.data.result };
    } catch {
      // 커스텀 산식/스키마 검증 예외도 원문/응답 값을 출력하지 않는다.
      throw new MarketDataError("MARKET_RESPONSE_INVALID");
    }
  }
  prices() {
    return this.#data(
      "/api/v1/prices?symbols=SOXL%2CSOXX",
      z
        .array(priceSchema)
        .length(2)
        .refine((rows) => new Set(rows.map((x) => x.symbol)).size === 2),
    );
  }
  async orderbook(symbol: MarketSymbol) {
    if (!symbolSchema.safeParse(symbol).success)
      throw new MarketDataError("SYMBOL_DENIED");
    return this.#data(`/api/v1/orderbook?symbol=${symbol}`, bookSchema);
  }
  async candles(symbol: MarketSymbol) {
    if (!symbolSchema.safeParse(symbol).success)
      throw new MarketDataError("SYMBOL_DENIED");
    // 수정주가/기업행동을 임의 가정하지 않는다. 공식 1m timestamp는 봉 종료 시각이다.
    return this.#data(
      `/api/v1/candles?symbol=${symbol}&interval=1m&count=200&adjusted=false`,
      candlesSchema,
    );
  }
  async calendar(date: string) {
    if (!z.iso.date().safeParse(date).success)
      throw new MarketDataError("DATE_INVALID");
    return this.#data(
      `/api/v1/market-calendar/US?date=${date}`,
      calendarSchema,
    );
  }
}
