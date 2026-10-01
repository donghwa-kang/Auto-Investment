import { d } from "./math.js";
import { hash, policy, policyHash, spec } from "./policy.js";
import {
  parseMarketQuality,
  type QualityRecord,
  type QualityAsset,
} from "./market-quality-schema.js";

export const qualityReasons: Record<string, string> = {
  SOURCE_UNREGISTERED: "시험 출처가 없거나 해당 자료 종류를 허용하지 않습니다.",
  SOURCE_MISMATCH: "자료 출처와 대상에 지정된 출처가 다릅니다.",
  IDENTITY_MISMATCH: "종목 식별·시장·거래소·심볼·통화가 계약과 다릅니다.",
  CURRENCY_MISMATCH: "시장과 통화가 일치하지 않습니다.",
  IDENTITY_COLLISION:
    "같은 종목 또는 같은 시장·거래소·심볼이 여러 대상에 등록됐습니다.",
  SESSION_MISSING_OR_FUTURE: "현재 이용 가능한 시험 세션이 없습니다.",
  WINDOW_INVALID: "창이 비어 있거나 세션/1분 경계/판단 시점에 맞지 않습니다.",
  WINDOW_STALE: "시간 창이 시험 프로필의 신선도 한도를 넘었습니다.",
  PROFILE_MISSING: "필수 시험 신선도 가정이 정의되지 않았습니다.",
  ACTION_CONTEXT_UNRESOLVED:
    "분할 등 기업행동 가정이 없거나 미확인/미래/조정 필요 상태입니다.",
  BAR_MISSING: "요구된 시간 창에 1분봉이 빠져 있습니다.",
  BAR_TIME_INVALID: "봉 길이·세션·정렬·관측 시각이 맞지 않습니다.",
  BAR_INCOMPLETE_OR_HALTED:
    "완료되지 않았거나 거래정지 여부가 불명확/정지 상태입니다.",
  OHLCV_INVALID: "OHLC 범위·양의 가격·0 이상 거래량 조건이 맞지 않습니다.",
  ZERO_WINDOW_VOLUME:
    "창의 거래량 합계가 0이어서 VWAP 분모로 사용할 수 없습니다.",
  BASIS_NOT_RAW: "원시 가격이 아니거나 조정 여부를 모릅니다.",
  REVISION_CONFLICT: "같은 사건의 최신 동일 정정 버전에 상충 자료가 있습니다.",
  PRICE_MISSING: "현재 이용 가능한 가격이 없습니다.",
  PRICE_INVALID: "최근 가격이 누락되거나 0 이하입니다.",
  PRICE_STALE: "최근 가격의 관측 시각이 시험 신선도 한도를 넘었습니다.",
  QUOTE_MISSING: "현재 이용 가능한 호가가 없습니다.",
  QUOTE_STALE: "호가 관측 시각이 원본 정책 신선도 한도를 넘었습니다.",
  QUOTE_INVALID:
    "호가/잔량이 없거나 양수가 아니거나 매수호가가 매도호가보다 높습니다.",
  BENCHMARK_MAPPING_MISSING:
    "별도 벤치마크 시험 대상 매핑이 없거나 잘못됐습니다.",
  BENCHMARK_DATA_BLOCKED: "지정 벤치마크의 자료 품질 검사가 보류됐습니다.",
};
const ms = (value: string) => Date.parse(value);
const ordered = <T>(values: T[], key: (value: T) => string) =>
  [...values].sort((a, b) => key(a).localeCompare(key(b), "en"));
type Selected = { record: QualityRecord; recordHash: string };
type AssetResult = {
  assetKey: string;
  role: QualityAsset["role"];
  status: "TEST_WINDOW_VALID" | "BLOCKED";
  reasons: string[];
  expectedBars: number;
  validBars: number;
  totalVolume: string | null;
  selected: Selected[];
};

export function checkMarketQuality(raw: unknown) {
  const input = parseMarketQuality(raw),
    at = ms(input.asOf);
  const duration = spec.input_contract.source_bar_minutes * 60000;
  const sources = new Map(
    input.sources.map((source) => [source.sourceId, source]),
  );
  const assets = new Map(input.assets.map((asset) => [asset.assetKey, asset]));
  const diagnostics = {
    inputRecords: input.records.length,
    deferredRecords: 0,
    orphanRecords: 0,
    outsideWindowRecords: 0,
    duplicates: 0,
  };
  const rowsByAsset = new Map<string, Selected[]>();
  const seen = new Set<string>();
  for (const row of input.records) {
    const recordHash = hash(row);
    if (seen.has(recordHash)) {
      diagnostics.duplicates++;
      continue;
    }
    seen.add(recordHash);
    if (
      ms(row.availableAt) > at ||
      (row.kind === "BAR" && ms(row.closeAt) > at)
    ) {
      diagnostics.deferredRecords++;
      continue;
    }
    const asset = assets.get(row.assetKey);
    if (!asset) {
      diagnostics.orphanRecords++;
      continue;
    }
    if (
      row.kind === "BAR" &&
      (ms(row.openAt) < ms(asset.windowFrom) ||
        ms(row.openAt) >= ms(asset.windowTo))
    ) {
      diagnostics.outsideWindowRecords++;
      continue;
    }
    // 벤치마크 가격·호가는 이번 창 검사 대상이 아니며 통과 근거로 사용하지 않는다.
    if (asset.role === "BENCHMARK" && row.kind !== "BAR") {
      diagnostics.outsideWindowRecords++;
      continue;
    }
    const list = rowsByAsset.get(row.assetKey) ?? [];
    list.push({ record: row, recordHash });
    rowsByAsset.set(row.assetKey, list);
  }

  // 카탈로그에 연결되지 않은 독립 입력도 중복 식별로 서로 대체하지 않는다.
  const collisions = new Set<string>();
  for (const selector of [
    (a: QualityAsset) => `${a.identity.market}:${a.identity.instrumentId}`,
    (a: QualityAsset) =>
      `${a.identity.market}:${a.identity.venue}:${a.identity.symbol}`,
  ]) {
    const claims = new Map<string, string[]>();
    for (const asset of input.assets) {
      const key = selector(asset),
        owners = claims.get(key) ?? [];
      owners.push(asset.assetKey);
      claims.set(key, owners);
    }
    for (const owners of claims.values())
      if (owners.length > 1) for (const owner of owners) collisions.add(owner);
  }
  const items: AssetResult[] = ordered(input.assets, (a) => a.assetKey).map(
    (asset) => {
      const reasons = new Set<string>(),
        selected: Selected[] = [];
      const add = (reason: string) => reasons.add(reason);
      const source =
        asset.sourceId === null ? undefined : sources.get(asset.sourceId);
      const requiredKinds =
        asset.role === "INSTRUMENT"
          ? (["BAR", "PRICE", "QUOTE"] as const)
          : (["BAR"] as const);
      if (!source || requiredKinds.some((kind) => !source.kinds.includes(kind)))
        add("SOURCE_UNREGISTERED");
      if (
        asset.identity.currency !==
        (asset.identity.market === "KR" ? "KRW" : "USD")
      )
        add("CURRENCY_MISMATCH");
      if (collisions.has(asset.assetKey)) add("IDENTITY_COLLISION");
      const session = asset.session,
        from = ms(asset.windowFrom),
        to = ms(asset.windowTo);
      if (!session || ms(session.availableAt) > at)
        add("SESSION_MISSING_OR_FUTURE");
      const windowValid =
        !!session &&
        from < to &&
        to <= at &&
        ms(session.openAt) <= from &&
        to <= ms(session.closeAt) &&
        (from - ms(session.openAt)) % duration === 0 &&
        (to - from) % duration === 0;
      if (!windowValid) add("WINDOW_INVALID");
      if (
        input.profile.windowEndMaxAgeMs === null ||
        (asset.role === "INSTRUMENT" &&
          input.profile.lastPriceMaxAgeMs === null)
      )
        add("PROFILE_MISSING");
      if (
        input.profile.windowEndMaxAgeMs !== null &&
        at - to > input.profile.windowEndMaxAgeMs
      )
        add("WINDOW_STALE");
      if (
        !asset.actionContext ||
        ms(asset.actionContext.availableAt) > at ||
        asset.actionContext.status !== "NO_ACTIONS_IN_WINDOW"
      )
        add("ACTION_CONTEXT_UNRESOLVED");
      const groups = new Map<string, Selected[]>();
      for (const row of rowsByAsset.get(asset.assetKey) ?? []) {
        const key =
          row.record.kind === "BAR"
            ? `BAR:${row.record.openAt}`
            : row.record.kind;
        const list = groups.get(key) ?? [];
        list.push(row);
        groups.set(key, list);
      }
      const winners = new Map<string, QualityRecord>();
      for (const [key, rows] of groups) {
        // 가격/호가는 사건 시각을 먼저, 같은 사건의 정정 버전을 나중에 비교한다.
        const eventAt = Math.max(
          ...rows.map((row) =>
            row.record.kind === "BAR" ? 0 : ms(row.record.observedAt),
          ),
        );
        const current = rows.filter(
          (row) =>
            row.record.kind === "BAR" || ms(row.record.observedAt) === eventAt,
        );
        const revision = Math.max(...current.map((row) => row.record.revision));
        const latest = current.filter(
          (row) => row.record.revision === revision,
        );
        selected.push(...latest);
        if (latest.length > 1) add("REVISION_CONFLICT");
        for (const { record: row } of latest) {
          if (row.sourceId !== asset.sourceId) add("SOURCE_MISMATCH");
          if (!sources.get(row.sourceId)?.kinds.includes(row.kind))
            add("SOURCE_UNREGISTERED");
          if (hash(row.identity) !== hash(asset.identity))
            add("IDENTITY_MISMATCH");
          if (row.basis !== "RAW") add("BASIS_NOT_RAW");
        }
        if (latest.length === 1) winners.set(key, latest[0]!.record);
      }
      let validBars = 0,
        volume = d(0);
      const expectedBars = windowValid ? (to - from) / duration : 0;
      for (let slot = 0; slot < expectedBars; slot++) {
        const row = winners.get(
          `BAR:${new Date(from + slot * duration).toISOString()}`,
        );
        if (!row || row.kind !== "BAR") {
          add("BAR_MISSING");
          continue;
        }
        let valid =
          row.sourceId === asset.sourceId &&
          !!source?.kinds.includes("BAR") &&
          hash(row.identity) === hash(asset.identity) &&
          row.basis === "RAW";
        if (
          ms(row.closeAt) - ms(row.openAt) !== duration ||
          row.sessionId !== session!.sessionId ||
          ms(row.observedAt) < ms(row.closeAt)
        ) {
          add("BAR_TIME_INVALID");
          valid = false;
        }
        if (!row.completed || row.halted !== false) {
          add("BAR_INCOMPLETE_OR_HALTED");
          valid = false;
        }
        if (
          row.o === null ||
          row.h === null ||
          row.l === null ||
          row.c === null ||
          row.v === null ||
          [row.o, row.h, row.l, row.c].some((value) => d(value!).lte(0)) ||
          d(row.v).lt(0) ||
          d(row.h).lt(row.o) ||
          d(row.h).lt(row.c) ||
          d(row.h).lt(row.l) ||
          d(row.l).gt(row.o) ||
          d(row.l).gt(row.c)
        ) {
          add("OHLCV_INVALID");
          valid = false;
        }
        if (valid) {
          validBars++;
          volume = volume.plus(row.v!);
        }
      }
      // 창 안의 비정렬 여분 봉도 무시해서 완전한 자료로 승인하지 않는다.
      for (const { record: row } of selected)
        if (
          row.kind === "BAR" &&
          ((ms(row.openAt) - from) % duration !== 0 || ms(row.closeAt) > to)
        )
          add("BAR_TIME_INVALID");
      if (expectedBars > 0 && validBars === expectedBars && volume.isZero())
        add("ZERO_WINDOW_VOLUME");
      if (asset.role === "INSTRUMENT") {
        const price = winners.get("PRICE"),
          quote = winners.get("QUOTE");
        if (!price || price.kind !== "PRICE") add("PRICE_MISSING");
        else {
          if (price.price === null || d(price.price).lte(0))
            add("PRICE_INVALID");
          if (
            input.profile.lastPriceMaxAgeMs !== null &&
            at - ms(price.observedAt) > input.profile.lastPriceMaxAgeMs
          )
            add("PRICE_STALE");
        }
        if (!quote || quote.kind !== "QUOTE") add("QUOTE_MISSING");
        else {
          if (
            at - ms(quote.observedAt) >
            policy.execution.maximum_quote_age_seconds * 1000
          )
            add("QUOTE_STALE");
          if (
            [quote.bid, quote.ask, quote.bidSize, quote.askSize].some(
              (value) => value === null || d(value).lte(0),
            ) ||
            (quote.bid !== null &&
              quote.ask !== null &&
              d(quote.bid).gt(quote.ask))
          )
            add("QUOTE_INVALID");
        }
      }
      return {
        assetKey: asset.assetKey,
        role: asset.role,
        status: reasons.size ? "BLOCKED" : "TEST_WINDOW_VALID",
        reasons: [...reasons].sort(),
        expectedBars,
        validBars,
        totalVolume:
          expectedBars > 0 && validBars === expectedBars
            ? volume.toFixed()
            : null,
        selected: ordered(selected, (row) => row.recordHash),
      };
    },
  );
  const byKey = new Map(items.map((item) => [item.assetKey, item]));
  for (const item of items) {
    const asset = assets.get(item.assetKey)!;
    if (asset.role !== "INSTRUMENT") continue;
    const benchmark =
      asset.benchmarkKey === null ? undefined : byKey.get(asset.benchmarkKey);
    if (!benchmark || benchmark.role !== "BENCHMARK")
      item.reasons.push("BENCHMARK_MAPPING_MISSING");
    else {
      const contract = assets.get(benchmark.assetKey)!;
      if (
        contract.windowFrom !== asset.windowFrom ||
        contract.windowTo !== asset.windowTo
      )
        item.reasons.push("BENCHMARK_MAPPING_MISSING");
      if (benchmark.status === "BLOCKED")
        item.reasons.push("BENCHMARK_DATA_BLOCKED");
    }
    item.reasons.sort();
    item.status = item.reasons.length ? "BLOCKED" : "TEST_WINDOW_VALID";
  }
  const decision = {
    schemaVersion: "OFFLINE_MARKET_QUALITY_RESULT_V1",
    purpose: "TEST_ONLY",
    stage: "REQUESTED_WINDOW_DATA_QUALITY_ONLY",
    asOf: input.asOf,
    policyHash,
    strategySpecHash: hash(spec),
    contractHash: hash({
      profile: input.profile,
      sources: ordered(
        input.sources.map((source) => ({
          ...source,
          kinds: [...source.kinds].sort(),
        })),
        (source) => source.sourceId,
      ),
      assets: ordered(input.assets, (asset) => asset.assetKey),
    }),
    sourceAuthentication: "UNVERIFIED_TEST_INPUT",
    realDataReady: false,
    strategyReady: false,
    strategyEvaluated: false,
    selectionPerformed: false,
    paperOrdersEnabled: false,
    liveEnabled: false,
    splitAdjustmentPerformed: false,
    pendingChecks: [
      "REAL_SOURCE_CONTRACT_AND_AUTHENTICATION",
      "CALENDAR_AND_ACTION_FACTS",
      "VALIDATED_BENCHMARK_MAPPING",
      "FULL_WARMUP_AND_INDICATOR_PRECISION",
      "PIT_SPLIT_ADJUSTMENT",
      "COST_FORECAST_EXECUTION_PROFILES",
    ],
    status: items.every((item) => item.status === "TEST_WINDOW_VALID")
      ? "TEST_WINDOW_VALID"
      : "BLOCKED",
    items,
    counts: {
      assets: items.length,
      valid: items.filter((item) => item.status === "TEST_WINDOW_VALID").length,
      blocked: items.filter((item) => item.status === "BLOCKED").length,
    },
  };
  return {
    ...decision,
    decisionHash: hash(decision),
    inputHash: hash(input),
    diagnostics,
  };
}
