import { createHash } from "node:crypto";
import { z } from "zod";
import { CatalogError, MAX_CATALOG_RECORDS } from "../core/catalog-schema.js";
import {
  classifyTossListing,
  tossCatalogMarkets,
  type TossCatalogMarket,
} from "../core/toss-catalog.js";
import { hash, policyHash } from "../core/policy.js";
import { researchScope } from "../core/research-scope.js";
import type { Credentials } from "./toss-market-data.js";

export const CATALOG_RESPONSE_LIMIT = 4 * 1024 * 1024;
export const CATALOG_REQUEST_TIMEOUT_MS = 15_000;
export const CATALOG_REQUEST_INTERVAL_MS = 1_100;
const origin = "https://openapi.tossinvest.com";
const tokenSchema = z.object({
  access_token: z
    .string()
    .min(1)
    .max(16000)
    .regex(/^[A-Za-z0-9._~-]+$/),
  token_type: z.literal("Bearer"),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(86400 * 366),
});
interface Audit {
  operation: "TOKEN" | "LIST";
  market: TossCatalogMarket | null;
  status: number | null;
  requestedAt: string;
  receivedAt: string | null;
  responseHash: string | null;
  rateLimit: number | null;
  retryAfter: number | null;
}
type Batch = ReturnType<typeof classifyTossListing>;
export interface CatalogScopeResult {
  market: TossCatalogMarket;
  status: "RECEIVED" | "RECEIVED_EMPTY" | "FAILED" | "NOT_ATTEMPTED";
  receivedAt: string | null;
  error: string | null;
  batch: Batch | null;
}
function numericHeader(response: Response, key: string) {
  const value = response.headers.get(key);
  return value && /^\d{1,9}(\.\d{1,6})?$/.test(value) ? Number(value) : null;
}

// 통신/시계 주입은 단위시험용이다. CLI에는 임의 URL/경로/계좌 헤더 설정이 없다.
export class TossCatalogClient {
  #used = false;
  #token: string | null = null;
  #tokenUntil = 0;
  #lastListEnd: number | null = null;
  #audit: Audit[] = [];
  constructor(
    private readonly dependencies = {
      transport: globalThis.fetch,
      now: () => Date.now(),
      monotonic: () => performance.now(),
      sleep: (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
  ) {}

  async #request(market: TossCatalogMarket | null, credentials?: Credentials) {
    if (this.#audit.length >= 8)
      throw new CatalogError("CATALOG_REQUEST_BUDGET");
    if (market !== null && !tossCatalogMarkets.includes(market))
      throw new CatalogError("TOSS_CATALOG_MARKET_INVALID");
    if (market !== null && this.#lastListEnd !== null) {
      const wait =
        CATALOG_REQUEST_INTERVAL_MS -
        (this.dependencies.monotonic() - this.#lastListEnd);
      if (wait > 0) await this.dependencies.sleep(wait);
    }
    if (
      market !== null &&
      (!this.#token || this.dependencies.monotonic() >= this.#tokenUntil)
    )
      throw new CatalogError("CATALOG_TOKEN_EXPIRED");
    const path =
      market === null
        ? "/oauth2/token"
        : `/api/v1/stocks/all?market=${market}&status=ACTIVE`;
    const entry: Audit = {
      operation: market === null ? "TOKEN" : "LIST",
      market,
      status: null,
      requestedAt: new Date(this.dependencies.now()).toISOString(),
      receivedAt: null,
      responseHash: null,
      rateLimit: null,
      retryAfter: null,
    };
    this.#audit.push(entry);
    const signal = AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.dependencies.transport(origin + path, {
        method: market === null ? "POST" : "GET",
        redirect: "error",
        signal,
        headers:
          market === null
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
              }
            : {
                Authorization: `Bearer ${this.#token}`,
                Accept: "application/json",
              },
        ...(market === null
          ? {
              body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: credentials!.clientId,
                client_secret: credentials!.clientSecret,
              }).toString(),
            }
          : {}),
      });
      entry.status = response.status;
      entry.rateLimit = numericHeader(response, "X-RateLimit-Limit");
      entry.retryAfter = numericHeader(response, "Retry-After");
      reader = response.body?.getReader();
      if (response.status !== 200)
        throw new CatalogError(`CATALOG_HTTP_${response.status}`);
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new CatalogError("CATALOG_CONTENT_TYPE_INVALID");
      const cap = market === null ? 64 * 1024 : CATALOG_RESPONSE_LIMIT;
      const length = response.headers.get("content-length");
      if (length && /^\d+$/.test(length) && Number(length) > cap)
        throw new CatalogError("CATALOG_RESPONSE_TOO_LARGE");
      if (!reader) throw new CatalogError("CATALOG_EMPTY_BODY");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > cap) throw new CatalogError("CATALOG_RESPONSE_TOO_LARGE");
        chunks.push(part.value);
      }
      const bytes = Buffer.concat(chunks);
      // 인증 응답은 해시도 보관하지 않는다. 시세 원문과 헤더 전체도 저장하지 않는다.
      if (market !== null)
        entry.responseHash = createHash("sha256").update(bytes).digest("hex");
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      entry.receivedAt = new Date(this.dependencies.now()).toISOString();
      if (Date.parse(entry.receivedAt) < Date.parse(entry.requestedAt))
        throw new CatalogError("CATALOG_CLOCK_REGRESSED");
      return { value, receivedAt: entry.receivedAt };
    } catch (error: unknown) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError(
        signal.aborted
          ? "CATALOG_TIMEOUT"
          : "CATALOG_RESPONSE_OR_NETWORK_INVALID",
      );
    } finally {
      if (market !== null) this.#lastListEnd = this.dependencies.monotonic();
      // 오류 본문을 읽거나 출력하지 않고 전송 스트림을 해제한다.
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          /* 연결 종료 오류는 비공개 */
        }
      }
    }
  }

  async collect(credentials: Credentials) {
    if (this.#used) throw new CatalogError("CATALOG_CLIENT_ALREADY_USED");
    this.#used = true;
    const startedAt = new Date(this.dependencies.now()).toISOString();
    const scopes: CatalogScopeResult[] = tossCatalogMarkets.map((market) => ({
      market,
      status: "NOT_ATTEMPTED",
      receivedAt: null,
      error: null,
      batch: null,
    }));
    let failure: string | null = null;
    let active: CatalogScopeResult | undefined;
    let totalRows = 0;
    try {
      const tokenRequestStart = this.dependencies.monotonic();
      const tokenResponse = await this.#request(null, credentials);
      const token = tokenSchema.safeParse(tokenResponse.value);
      if (!token.success) throw new CatalogError("CATALOG_TOKEN_INVALID");
      this.#token = token.data.access_token;
      this.#tokenUntil = tokenRequestStart + token.data.expires_in * 1000;
      for (const scope of scopes) {
        active = scope;
        const response = await this.#request(scope.market);
        scope.receivedAt = response.receivedAt;
        const batch = classifyTossListing(response.value, scope.market);
        if (totalRows + batch.inputRecords > MAX_CATALOG_RECORDS)
          throw new CatalogError("CATALOG_TOTAL_RECORD_LIMIT");
        totalRows += batch.inputRecords;
        scope.batch = batch;
        scope.status = batch.inputRecords === 0 ? "RECEIVED_EMPTY" : "RECEIVED";
      }
    } catch (error: unknown) {
      failure =
        error instanceof CatalogError
          ? error.code
          : "CATALOG_COLLECTION_FAILED";
      if (active) {
        active.status = "FAILED";
        active.error = failure;
      }
    } finally {
      this.#token = null;
      this.#tokenUntil = 0;
    }
    const allScopesReceived = scopes.every(
      (s) => s.status === "RECEIVED" || s.status === "RECEIVED_EMPTY",
    );
    const items = scopes.flatMap((s) => s.batch?.items ?? []);
    const quarantined = scopes.reduce(
      (n, s) => n + (s.batch?.quarantined.length ?? 0),
      0,
    );
    const report = {
      schemaVersion: "TOSS_CATALOG_SNAPSHOT_V1",
      purpose: "REAL_REFERENCE_SNAPSHOT",
      source: origin + "/api/v1/stocks/all",
      sourceContractCheckedOn: "2026-09-12",
      startedAt,
      completedAt: new Date(this.dependencies.now()).toISOString(),
      sourceUpdatedAt: null,
      sourceEffectiveAt: null,
      sourceRevision: null,
      timestampBasis: "LOCAL_REQUEST_RECEIPT_ONLY",
      historicalUniverseReady: false,
      requestedStatus: "ACTIVE",
      securityTypeFilter: null,
      commonShareFilter: null,
      universeScope: "TOSS_SUPPORTED_ACTIVE_CATALOG_NOT_ENTIRE_EXCHANGE",
      allScopesReceived,
      dataQualityComplete:
        allScopesReceived &&
        quarantined === 0 &&
        items.every(
          (item) =>
            !item.reasons.includes("RECORD_CONFLICT") &&
            !item.reasons.includes("SYMBOL_COLLISION"),
        ),
      metadataReady: false,
      freshForTrading: false,
      selectionPerformed: false,
      strategyEvaluated: false,
      ordersEnabled: false,
      liveEnabled: false,
      ordering: "MARKET_THEN_CANONICAL_ISIN_NOT_INVESTMENT_RANK",
      policyHash,
      researchScopeHash: hash(researchScope),
      counts: {
        inputRecords: totalRows,
        instruments: items.length,
        duplicates: scopes.reduce((n, s) => n + (s.batch?.duplicates ?? 0), 0),
        quarantined,
        candidates: 0,
        reviewRequired: items.length,
      },
      pendingChecks: [
        "SOURCE_FRESHNESS",
        "PRODUCT_IDENTITY_AND_STRUCTURE",
        "CURRENCY_VENUE_TRADING_STATUS",
        "PRODUCT_AND_STRATEGY_PROFILES",
        "LIQUIDITY_PRICE_NEWS_RESEARCH",
      ],
      failure,
      scopes,
      requests: this.#audit.map((v) => ({ ...v })),
    } as const;
    return { ...report, reportHash: hash(report) };
  }
}
export type TossCatalogReport = Awaited<
  ReturnType<TossCatalogClient["collect"]>
>;
