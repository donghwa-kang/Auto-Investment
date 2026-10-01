import { bindSnapshot, hash, policy, policyHash } from "./policy.js";
import { caps, fxFor } from "./ledger.js";
import { economic, guards, profile, size } from "./risk.js";
import { d } from "./math.js";
import type { Order, Quote, State } from "./types.js";
// 승인 후 DB 예약과 별개로, 어댑터 접수 직전에 현재 입력을 다시 검사한다.
export function submissionReasons(
  s: State,
  o: Order,
  q: Quote,
  operatingHistory?: unknown,
) {
  const reasons: string[] = [];
  const snap = o.snapshot;
  if (!snap || !o.snapshotHash) return ["MISSING_APPROVAL"];
  if (
    (s.manifest?.executionStress || snap.execution_stress_hash) &&
    snap.execution_stress_hash !== hash(s.manifest?.executionStress ?? null)
  )
    reasons.push("STRESS_APPROVAL_MISMATCH");
  try {
    if (bindSnapshot(snap) !== o.snapshotHash)
      reasons.push("SNAPSHOT_HASH_MISMATCH");
  } catch {
    reasons.push("SNAPSHOT_BINDING_MISSING");
  }
  if (o.epoch !== s.epoch || snap.risk_config_epoch !== s.epoch)
    reasons.push("STALE_EPOCH");
  if (
    snap.policy_hash !== policyHash ||
    snap.mode !== s.config!.mode ||
    snap.risk_level !== s.config!.level ||
    snap.quantity !== o.quantity ||
    snap.entry_price !== o.limit ||
    snap.fx_rate !== fxFor(s.ledger, o.currency) ||
    snap.execution_model_hash !== hash(profile.execution) ||
    snap.forecast_profile_hash !== hash(profile.forecast) ||
    snap.effective_caps_hash !== hash(caps(s))
  )
    reasons.push("APPROVAL_INPUT_CHANGED");
  const signalAt = Number(snap.signal_at);
  if (
    !Number.isFinite(signalAt) ||
    s.clock >
      signalAt + policy.execution.signal_valid_seconds_after_bar_close * 1000
  )
    reasons.push("SIGNAL_EXPIRED");
  if (
    d(q.ask).gt(o.limit) ||
    q.at < s.clock - policy.execution.maximum_quote_age_seconds * 1000 ||
    q.at > s.clock
  )
    reasons.push("PRICE_OR_QUOTE_CHANGED");
  const withoutSelf = { ...s, orders: s.orders.filter((x) => x.id !== o.id) };
  reasons.push(
    ...guards(
      withoutSelf,
      q,
      signalAt,
      String(snap.instrument_id),
      operatingHistory,
    ),
  );
  const solved = size(
    withoutSelf,
    o.limit,
    String(snap.stop_price),
    q,
    o.currency,
    operatingHistory,
  );
  reasons.push(...solved.operating.reasons);
  // 저장된 승인 자료를 현재 증거로 재활용하지 않는다. 같은 금액이어도
  // 출처/완료 위험일 창이 달라지거나 구형 승인이면 재승인이 필요하다.
  if (
    !solved.operating.binding ||
    hash(snap.operating_cost_binding ?? null) !==
      hash(solved.operating.binding) ||
    snap.estimated_operating_cost_krw !== solved.operating.amount
  )
    reasons.push("OPERATING_COST_EVIDENCE_CHANGED");
  if (solved.quantity !== o.quantity || solved.cost !== snap.estimated_cost)
    reasons.push("SIZE_OR_COST_CHANGED");
  const R0 = d(o.limit)
    .minus(String(snap.stop_price))
    .mul(o.quantity)
    .mul(fxFor(s.ledger, o.currency))
    .toString();
  if (
    !economic(
      String(snap.expected_gross_pnl),
      String(snap.estimated_cost),
      R0,
      String(snap.net_pnl_q05),
      caps(s).trade,
    )
  )
    reasons.push("ECONOMIC_RECHECK_FAILED");
  return [...new Set(reasons)];
}
