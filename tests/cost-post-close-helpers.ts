import { hash } from "../src/core/policy.js";
import {
  postCloseContractHash,
  postCloseCommandSchema,
} from "../src/core/cost-post-close.js";
import type { PostCloseTarget } from "../src/core/cost-post-close.js";
import type { ReservationState } from "../src/core/cost-reservation.js";
import {
  finalizationConfig,
  closeRequest,
} from "./cost-finalization-helpers.js";
import { openedOperating, op, record } from "./cost-operating-helpers.js";

export function postCloseConfig() {
  const c = finalizationConfig();
  return {
    ...c,
    postClose: {
      contractHash: postCloseContractHash,
      followupEndExclusive: c.operating.periodEnd + 7 * 86400000,
    },
  };
}
export function closedPostClose(path = ":memory:", amount = "50") {
  const c = postCloseConfig();
  const f = { ...openedOperating(c, path), c };
  record(f.store, op(f.store.read(), "RECOGNIZE", "cost", amount));
  finishPostClose(f);
  return f;
}
export function finishPostClose(f: ReturnType<typeof openedOperating>) {
  return f.store.finalizeOperating(
    "close",
    "period",
    closeRequest(f),
    f.store.read(),
  );
}
export function paymentCommand(
  s: ReservationState,
  index = 0,
  businessEventId = `payment-${index}`,
  postedAt = s.seed.clock + 86400000,
) {
  const m = s.postClose!,
    b = m.basis!;
  return targetCommand(s, b.targets[index]!, businessEventId, postedAt);
}
export function targetCommand(
  s: ReservationState,
  target: PostCloseTarget,
  businessEventId: string,
  postedAt: number,
) {
  return postCloseCommandSchema.parse({
    ...target,
    contractHash: postCloseContractHash,
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    runHash: s.postClose!.configHash,
    sourceScope: s.postClose!.sourceScope,
    currency: "KRW",
    closeId: s.postClose!.basis!.closeId,
    checkpointHash: s.postClose!.basis!.checkpointHash,
    businessEventId,
    sourceHash: hash({ fixture: businessEventId }),
    occurredAt: postedAt,
    availableAt: postedAt,
    receivedAt: postedAt,
    postedAt,
  });
}
