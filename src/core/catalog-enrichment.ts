import {
  classifyCatalog,
  classifyCatalogFacts,
  type CatalogFacts,
  type CatalogStatus,
} from "./catalog.js";
import { hash } from "./policy.js";
import {
  enrichmentFields,
  parseEnrichment,
  type MetadataEvidence,
  type EnrichmentField,
} from "./catalog-enrichment-schema.js";

export const enrichmentReasons = {
  EVIDENCE_IDENTITY_MISMATCH:
    "근거의 심볼 또는 원본 기록 해시가 대상과 달라 결합하지 않습니다.",
  EVIDENCE_SOURCE_UNREGISTERED: "시험 계약에 등록되지 않은 출처입니다.",
  EVIDENCE_FIELD_NOT_AUTHORIZED:
    "시험 출처의 해당 필드 사용 범위가 명시되지 않았습니다.",
  EVIDENCE_REVISION_CONFLICT:
    "동일 출처/필드의 최신 동일 정정 번호 자료가 상충합니다.",
  EVIDENCE_STALE: "최신 근거가 명시된 시험 유효기간을 초과했습니다.",
  EVIDENCE_UNKNOWN:
    "최신 근거의 값이 null/UNKNOWN이므로 이전 값으로 복원하지 않습니다.",
  EVIDENCE_SOURCE_CONFLICT:
    "여러 출처의 최신 근거 값이 다릅니다. 다수결이나 임의 우선순위를 적용하지 않습니다.",
  EVIDENCE_BASE_CONFLICT:
    "새 근거와 원본의 확인된 값이 다릅니다. 원본을 조용히 덮어쓰지 않습니다.",
} as const;
type EvidenceReason = keyof typeof enrichmentReasons;
type FieldValue = CatalogFacts[EnrichmentField];
interface FieldResolution {
  field: EnrichmentField;
  state: "BASE" | "MISSING" | "ENRICHED" | "CORROBORATED" | "BLOCKED";
  baseValue: FieldValue;
  value: FieldValue;
  reasons: EvidenceReason[];
  evidence: MetadataEvidence[];
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const unknown = (value: FieldValue) => value === null || value === "UNKNOWN";
const unknownValue = (field: EnrichmentField): FieldValue =>
  ["currency", "kind", "underlying", "listingStatus"].includes(field)
    ? "UNKNOWN"
    : null;
const keyOf = (v: { market: string; instrumentId: string }) =>
  `${v.market}:${v.instrumentId}`;
const identityFailures = new Set([
  "RECORD_CONFLICT",
  "SYMBOL_COLLISION",
  "METADATA_STALE",
]);

export function enrichCatalog(raw: unknown) {
  const input = parseEnrichment(raw);
  const base = classifyCatalog(input.catalog);
  const sources = new Map(input.sources.map((s) => [s.sourceId, s]));
  const baseByKey = new Map(base.items.map((item) => [item.key, item]));
  const byTarget = new Map<string, MetadataEvidence[]>();
  const evidenceVenueClaims: {
    key: string;
    market: string;
    symbol: string;
    venue: string | null;
  }[] = [];
  let deferredEvidence = 0,
    orphanEvidence = 0,
    duplicates = 0;
  const seen = new Set<string>();
  const fingerprints = new Map<MetadataEvidence, string>();
  for (const evidence of input.evidence) {
    // 시점으로 먼저 제외하여 미래 정정/신규 종목이 과거 판단을 바꾸지 않게 한다.
    if (
      evidence.availableAt > input.catalog.asOf ||
      evidence.effectiveAt > input.catalog.asOf
    ) {
      deferredEvidence++;
      continue;
    }
    const fingerprint = hash(evidence);
    if (seen.has(fingerprint)) {
      duplicates++;
      continue;
    }
    seen.add(fingerprint);
    fingerprints.set(evidence, fingerprint);
    const key = keyOf(evidence.subject);
    if (!baseByKey.has(key)) {
      orphanEvidence++;
      continue;
    }
    const entries = byTarget.get(key) ?? [];
    entries.push(evidence);
    byTarget.set(key, entries);
  }
  const items = base.items.map((item) => {
    if (!item.record)
      return {
        key: item.key,
        symbol: null,
        baseRecordHash: item.recordHash,
        facts: null,
        fields: [] as FieldResolution[],
        status: "REVIEW_REQUIRED" as CatalogStatus,
        reasons: [...item.reasons] as string[],
      };
    const record = item.record;
    const facts: CatalogFacts = {
      market: record.market,
      venue: record.venue,
      currency: record.currency,
      kind: record.kind,
      underlying: record.underlying,
      leveraged: record.leveraged,
      requiredDepositKrw: record.requiredDepositKrw,
      listingStatus: record.listingStatus,
      brokerSupported: record.brokerSupported,
    };
    const targetEvidence = byTarget.get(item.key) ?? [];
    const fields: FieldResolution[] = enrichmentFields.map((field) => {
      const original = facts[field];
      const reasons = new Set<EvidenceReason>();
      const candidates = targetEvidence.filter((e) => e.field === field);
      const streams = new Map<string, MetadataEvidence[]>();
      const invalid: MetadataEvidence[] = [];
      for (const e of candidates) {
        const source = sources.get(e.sourceId);
        let valid = true;
        if (
          e.subject.symbol !== record.symbol ||
          e.subject.baseRecordHash !== item.recordHash
        ) {
          reasons.add("EVIDENCE_IDENTITY_MISMATCH");
          valid = false;
        }
        if (!source) {
          reasons.add("EVIDENCE_SOURCE_UNREGISTERED");
          valid = false;
        } else if (!source.allowedFields.includes(field)) {
          reasons.add("EVIDENCE_FIELD_NOT_AUTHORIZED");
          valid = false;
        }
        if (!valid) {
          invalid.push(e);
          continue;
        }
        const stream = streams.get(e.sourceId) ?? [];
        stream.push(e);
        streams.set(e.sourceId, stream);
      }
      const selected: MetadataEvidence[] = [...invalid];
      const values = new Map<string, FieldValue>();
      for (const [sourceId, stream] of streams) {
        const revision = stream.reduce((n, e) => Math.max(n, e.revision), 0);
        const latest = stream.filter((e) => e.revision === revision);
        selected.push(...latest);
        // 상충/만료로 최종 거래소 값이 null이 되더라도, 결합 검사를 통과한
        // 최신 주장 자체를 다른 종목의 심볼 충돌 검사에서 없애지 않는다.
        for (const e of latest) {
          if (e.field === "venue")
            evidenceVenueClaims.push({
              key: item.key,
              market: record.market,
              symbol: record.symbol,
              venue: e.value,
            });
        }
        if (latest.length !== 1) {
          reasons.add("EVIDENCE_REVISION_CONFLICT");
          continue;
        }
        const e = latest[0]!;
        if (
          Date.parse(input.catalog.asOf) - Date.parse(e.observedAt) >
          sources.get(sourceId)!.metadataMaxAgeMs
        )
          reasons.add("EVIDENCE_STALE");
        if (unknown(e.value)) reasons.add("EVIDENCE_UNKNOWN");
        values.set(hash(e.value), e.value);
      }
      if (values.size > 1) reasons.add("EVIDENCE_SOURCE_CONFLICT");
      const value = values.values().next().value as FieldValue | undefined;
      if (
        !unknown(original) &&
        [...values.values()].some((v) => !unknown(v) && original !== v)
      )
        reasons.add("EVIDENCE_BASE_CONFLICT");
      const blocked = reasons.size > 0;
      const resolved = blocked
        ? unknownValue(field)
        : value === undefined
          ? original
          : value;
      Object.assign(facts, { [field]: resolved });
      return {
        field,
        state: blocked
          ? "BLOCKED"
          : value === undefined
            ? unknown(original)
              ? "MISSING"
              : "BASE"
            : unknown(original)
              ? "ENRICHED"
              : "CORROBORATED",
        baseValue: original,
        value: resolved,
        reasons: [...reasons].sort(compare),
        evidence: selected.sort((a, b) =>
          compare(fingerprints.get(a)!, fingerprints.get(b)!),
        ),
      };
    });
    const classified = classifyCatalogFacts(facts);
    const extra = [
      ...item.reasons.filter((r) => identityFailures.has(r)),
      ...fields.flatMap((f) => f.reasons),
    ];
    const reasons = [...new Set([...classified.reasons, ...extra])]
      .filter((r) => r !== "METADATA_CLEAR" || extra.length === 0)
      .sort(compare);
    return {
      key: item.key,
      symbol: record.symbol,
      baseRecordHash: item.recordHash,
      facts,
      fields,
      status: extra.length
        ? ("REVIEW_REQUIRED" as CatalogStatus)
        : classified.status,
      reasons,
    };
  });
  // 보강된 거래소 때문에 새로 발생하는 심볼 충돌도 검사한다.
  const claims = new Map<string, Set<string>>();
  const addClaim = (
    market: string,
    venue: string | null,
    symbol: string,
    owner: string,
  ) => {
    // null은 실제 거래소 주장이 아니다. 보강 전/후의 결측을 서로 묶어
    // 이미 거래소가 확인된 상대 종목에 가짜 충돌을 만들지 않는다.
    // 원본 분류기가 발견한 결측 간 충돌 사유는 위에서 별도로 보존한다.
    if (venue === null) return;
    const key = JSON.stringify([market, venue, symbol]);
    const owners = claims.get(key) ?? new Set<string>();
    owners.add(owner);
    claims.set(key, owners);
  };
  // 원본 ID 상충으로 record=null인 항목도 모든 최신 주장을 보존한다.
  // 미래/이미 대체된 버전은 이 보수적 충돌 검사에도 포함하지 않는다.
  const visibleRecords = input.catalog.records.filter(
    (r) =>
      r.availableAt <= input.catalog.asOf &&
      r.effectiveAt <= input.catalog.asOf,
  );
  const latestRevision = new Map<string, number>();
  for (const record of visibleRecords) {
    const key = keyOf(record);
    latestRevision.set(
      key,
      Math.max(latestRevision.get(key) ?? 0, record.revision),
    );
  }
  for (const record of visibleRecords) {
    const key = keyOf(record);
    if (record.revision === latestRevision.get(key))
      addClaim(record.market, record.venue, record.symbol, key);
  }
  for (const claim of evidenceVenueClaims)
    addClaim(claim.market, claim.venue, claim.symbol, claim.key);
  for (const item of items) {
    if (!item.facts) continue;
    addClaim(item.facts.market, item.facts.venue, item.symbol!, item.key);
  }
  const collisions = new Set(
    [...claims.values()].filter((v) => v.size > 1).flatMap((v) => [...v]),
  );
  for (const item of items) {
    if (!collisions.has(item.key)) continue;
    item.status = "REVIEW_REQUIRED";
    item.reasons = [
      ...new Set([
        ...item.reasons.filter((r) => r !== "METADATA_CLEAR"),
        "SYMBOL_COLLISION",
      ]),
    ].sort(compare);
  }
  const decision = {
    schemaVersion: "OFFLINE_CATALOG_ENRICHMENT_RESULT_V1",
    purpose: "TEST_ONLY",
    stage: "EVIDENCE_BACKED_METADATA_CLASSIFICATION_ONLY",
    asOf: input.catalog.asOf,
    policyHash: base.policyHash,
    researchScopeHash: base.researchScopeHash,
    baseSourceId: base.sourceId,
    baseDecisionHash: base.decisionHash,
    sourceContractHash: hash(
      [...input.sources]
        .map((s) => ({
          ...s,
          allowedFields: [...s.allowedFields].sort(compare),
        }))
        .sort((a, b) => compare(a.sourceId, b.sourceId)),
    ),
    sourceAuthentication: "UNVERIFIED_TEST_INPUT",
    realMetadataReady: false,
    historicalUniverseReady: false,
    freshForTrading: false,
    ordering: "CANONICAL_KEY_NOT_INVESTMENT_RANK",
    selectionPerformed: false,
    strategyEvaluated: false,
    ordersEnabled: false,
    liveEnabled: false,
    pendingChecks: [
      ...base.pendingChecks,
      "REAL_SOURCE_CONTRACT_AND_AUTHENTICATION",
    ],
    items,
  } as const;
  return {
    ...decision,
    decisionHash: hash(decision),
    inputHash: hash(input),
    diagnostics: {
      inputEvidence: input.evidence.length,
      deferredEvidence,
      orphanEvidence,
      duplicates,
      base: base.diagnostics,
    },
    counts: {
      total: items.length,
      candidates: items.filter((i) => i.status === "REVIEW_CANDIDATE").length,
      excluded: items.filter((i) => i.status === "EXCLUDED").length,
      reviewRequired: items.filter((i) => i.status === "REVIEW_REQUIRED")
        .length,
      enrichedFields: items
        .flatMap((i) => i.fields)
        .filter((f) => f.state === "ENRICHED").length,
    },
  };
}
