import { hash } from "../src/core/policy.js";
import {
  partialSettlementContractHash,
  partialSourceEventKey,
  partialSettlementCommandSchema,
  partialTargetReference,
} from "../src/core/cost-partial-settlement.js";
import type { PartialEvidence } from "../src/core/cost-partial-settlement.js";
import { postCloseTargetKey } from "../src/core/cost-post-close.js";
import type { ReservationState } from "../src/core/cost-reservation.js";
import { finalizationConfig } from "./cost-finalization-helpers.js";
import { finishPostClose } from "./cost-post-close-helpers.js";
import { openedOperating, op, record } from "./cost-operating-helpers.js";
import { postCloseConfig } from "./cost-post-close-helpers.js";
import { beginTrade, fillTrade, closeTrade } from "./cost-outcome-helpers.js";
import { Decimal } from "../src/core/math.js";

export type EvidencePlan = Pick<
  PartialEvidence,
  "target" | "receivable" | "payable"
> &
  Partial<Pick<PartialEvidence, "kind" | "occurredAt">>;
export function partialConfig(
  plan: EvidencePlan[] = ["20", "30"].map((payable) => ({
    target: { kind: "OPERATING", obligationId: "debt" },
    receivable: "0",
    payable,
  })),
) {
  const c = finalizationConfig();
  const evidence: PartialEvidence[] = plan.map((p, i) => ({
    ...p,
    kind: p.kind ?? "SETTLE_PARTIAL_TARGET",
    occurredAt: p.occurredAt ?? c.operating.periodEnd + 100 + i,
    paymentId: `transfer-${i}`,
    lineId: "1",
    sourceEventKey: partialSourceEventKey(c.sourceScope, `transfer-${i}`, "1"),
    sourceHash: hash({ fixture: "independent-plan", row: i, plan: p }),
  }));
  return {
    ...c,
    partialSettlement: {
      contractHash: partialSettlementContractHash,
      followupEndExclusive: c.operating.periodEnd + 7 * 86400000,
      evidenceHash: hash(evidence),
      evidence,
    },
  };
}
export function closedPartial(
  path = ":memory:",
  amount = "50",
  parts = ["20", "30"],
) {
  const c = partialConfig(
    parts.map((payable) => ({
      target: { kind: "OPERATING", obligationId: "debt" },
      receivable: "0",
      payable,
      kind: payable === "0" ? "CONFIRM_ZERO_TARGET" : "SETTLE_PARTIAL_TARGET",
    })),
  );
  const f = { ...openedOperating(c, path), c };
  record(f.store, op(f.store.read(), "RECOGNIZE", "cost", amount));
  finishPostClose(f);
  return f;
}
export function partialCommand(
  s: ReservationState,
  index = 0,
  businessEventId = `business-${index}`,
  postedAt?: number,
) {
  const m = s.partialSettlement!,
    b = m.basis!,
    proof = m.options.evidence[index]!;
  const target = b.targets.find(
    (t) => hash(partialTargetReference(t)) === hash(proof.target),
  );
  if (!target) throw Error("TEST_TARGET_NOT_FOUND");
  const { paymentId, lineId, ...fields } = proof;
  void paymentId;
  void lineId;
  const at = postedAt ?? Math.max(s.seed.clock, proof.occurredAt);
  return partialSettlementCommandSchema.parse({
    ...fields,
    contractHash: partialSettlementContractHash,
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    runHash: m.configHash,
    sourceScope: m.sourceScope,
    currency: "KRW",
    closeId: b.closeId,
    checkpointHash: b.checkpointHash,
    targetKey: postCloseTargetKey(target),
    originalHash: target.target.originalHash,
    businessEventId,
    availableAt: proof.occurredAt,
    receivedAt: proof.occurredAt,
    postedAt: at,
  });
}
export function tradePartialConfig() {
  const f = openedOperating(postCloseConfig());
  try {
    const run = beginTrade(f.store);
    fillTrade(f.store, run);
    closeTrade(f.store, run, "10022");
    const b = finishPostClose(f).current.postClose!.basis!;
    return partialConfig(
      b.targets.flatMap((t) => {
        if (t.kind !== "SETTLE_CLOSED_FILL") throw Error("TEST_FILL_REQUIRED");
        return ["0.25", "0.75"].map((fraction) => ({
          target: partialTargetReference(t),
          receivable: new Decimal(t.target.receivable).mul(fraction).toFixed(),
          payable: new Decimal(t.target.payable).mul(fraction).toFixed(),
        }));
      }),
    );
  } finally {
    f.repo.close();
  }
}
