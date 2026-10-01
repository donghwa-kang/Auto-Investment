import { Decimal } from "decimal.js";
import { hash } from "./policy.js";
import type { LearningInput, LearningDecision } from "./learning-schema.js";

const Money = Decimal.clone({ precision: 40 });
export interface LearningRow {
  decision: LearningDecision;
  decisionHash: string;
  outcomeIds: string[];
  labelAvailableAt: string | null;
  closedAt: string | null;
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  status: "ELIGIBLE" | "EXCLUDED";
  reasons: string[];
}
export function buildLearningData(input: LearningInput) {
  const cutoff = Date.parse(input.asOf);
  const groups = new Map<string, LearningDecision[]>();
  for (const d of input.decisions) {
    if (Date.parse(d.availableAt) > cutoff) continue;
    const key = [
      d.instrumentId,
      d.market,
      d.signal,
      Date.parse(d.decisionAt),
    ].join("|");
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const duplicateIds = new Set<string>();
  for (const group of groups.values())
    if (group.length > 1) for (const d of group) duplicateIds.add(d.id);
  const decisionIds = new Set(input.decisions.map((d) => d.id));
  const outcomeGroups = new Map<string, LearningInput["outcomes"]>();
  for (const outcome of input.outcomes) {
    const group = outcomeGroups.get(outcome.decisionId) ?? [];
    group.push(outcome);
    outcomeGroups.set(outcome.decisionId, group);
  }
  const orphanOutcomeIds = input.outcomes
    .filter(
      (o) =>
        !decisionIds.has(o.decisionId) && Date.parse(o.availableAt) <= cutoff,
    )
    .map((o) => o.id)
    .sort();
  const rows: LearningRow[] = input.decisions
    .map((d) => {
      const reasons: string[] = [],
        decisionHash = hash(d),
        at = Date.parse(d.decisionAt);
      const all = outcomeGroups.get(d.id) ?? [];
      const available = all.filter((o) => Date.parse(o.availableAt) <= cutoff);
      if (Date.parse(d.availableAt) > cutoff || at > cutoff)
        reasons.push("FUTURE_DECISION");
      if (
        Date.parse(d.sourceAsOf) > Date.parse(d.availableAt) ||
        Date.parse(d.availableAt) > at
      )
        reasons.push("FEATURE_NOT_AVAILABLE_AT_DECISION");
      if (
        d.market !== input.market ||
        d.currency !== (input.market === "KR" ? "KRW" : "USD")
      )
        reasons.push("MARKET_CURRENCY_MISMATCH");
      if (d.action !== "PAPER_ENTRY" || d.signal !== input.signal)
        reasons.push("NOT_REGISTERED_ENTRY");
      if (duplicateIds.has(d.id)) reasons.push("DECISION_KEY_CONFLICT");
      const versions = new Set(
        available.map(({ id: _id, availableAt: _time, ...o }) => hash(o)),
      );
      if (versions.size > 1) reasons.push("OUTCOME_CONFLICT");
      const o = [...available].sort(
        (a, b) =>
          Date.parse(a.availableAt) - Date.parse(b.availableAt) ||
          a.id.localeCompare(b.id, "en"),
      )[0];
      const row: LearningRow = {
        decision: d,
        decisionHash,
        outcomeIds: available.map((o) => o.id).sort(),
        labelAvailableAt: o?.availableAt ?? null,
        closedAt: o?.closedAt ?? null,
        grossR: null,
        costR: null,
        netR: null,
        status: "EXCLUDED",
        reasons,
      };
      if (!o) reasons.push("OUTCOME_NOT_AVAILABLE");
      else {
        if (o.decisionHash !== decisionHash)
          reasons.push("DECISION_HASH_MISMATCH");
        if (o.currency !== d.currency)
          reasons.push("OUTCOME_CURRENCY_MISMATCH");
        if (o.kind !== "SIMULATED_CLOSED")
          reasons.push("UNCONFIRMED_OR_COUNTERFACTUAL");
        if (
          !o.closedAt ||
          Date.parse(o.closedAt) <= at ||
          Date.parse(o.closedAt) > Date.parse(o.availableAt)
        )
          reasons.push("LABEL_TIME_INVALID");
        if (o.grossPnl === null || o.costs === null)
          reasons.push("COST_OR_PNL_MISSING");
        else {
          const cost = Object.values(o.costs).reduce(
            (sum, n) => sum.plus(n),
            new Money(0),
          );
          const risk = new Money(d.riskUnit);
          row.grossR = new Money(o.grossPnl).div(risk).toNumber();
          row.costR = cost.div(risk).toNumber();
          row.netR = new Money(o.grossPnl).minus(cost).div(risk).toNumber();
          if (
            [row.grossR, row.costR, row.netR].some(
              (n) => !Number.isFinite(n) || Math.abs(n) > 1e6,
            )
          )
            reasons.push("LABEL_NUMERIC_RANGE");
        }
      }
      row.reasons = [...new Set(reasons)].sort();
      row.status = row.reasons.length ? "EXCLUDED" : "ELIGIBLE";
      return row;
    })
    .sort(
      (a, b) =>
        Date.parse(a.decision.decisionAt) - Date.parse(b.decision.decisionAt) ||
        a.decision.id.localeCompare(b.decision.id, "en"),
    );
  return {
    rows,
    orphanOutcomeIds,
    eligible: rows.filter((r) => r.status === "ELIGIBLE").length,
    excluded: rows.filter((r) => r.status !== "ELIGIBLE").length,
  };
}
