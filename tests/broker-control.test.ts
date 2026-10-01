import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlConfigSchema,
  controlStep,
  dispatchReasons,
  newControl,
  recoverControl,
  tier,
  type ControlState,
} from "../src/core/broker-control.js";
import {
  controlConfig,
  request,
  enqueue,
  dispatch,
  respond,
} from "./broker-control-helpers.js";

const sent = (s: ControlState) => s.records.filter((r) => r.sentAt !== null);
test("D02 unavailable or expired safety work latches new exposure pause", () => {
  let s = newControl(controlConfig(), 10000);
  s = dispatch(
    enqueue(
      s,
      request("stalled-safety", "MONITOR", 10000, { routeId: "sim-us-read" }),
    ),
  );
  s = enqueue(
    s,
    request("blocked-safety", "ORDER_QUERY", 10000, {
      routeId: "sim-us-read",
      deadlineAt: 11000,
    }),
  );
  s = enqueue(s, request("entry-while-blind", "ENTRY"));
  s = dispatch(s);
  assert.equal(s.mode, "PAUSED");
  assert.equal(sent(s).length, 1);
  let expired = enqueue(
    newControl(controlConfig(), 10000),
    request("deadline-safety", "ORDER_QUERY", 10000, { deadlineAt: 10001 }),
  );
  expired = controlStep(expired, { kind: "ADVANCE", at: 10001 });
  assert.equal(expired.mode, "PAUSED");
});
test("D02 REVIEW multiple workers never dispatch the same write intent twice", () => {
  const config = controlConfig();
  config.laneCapacity = 2;
  let s = newControl(config, 10000);
  for (const id of ["one", "two"])
    s = enqueue(s, request(id, "EXIT", 10000, { orderId: "same-order" }));
  s = dispatch(s, 10000, "sim-worker-a");
  s = dispatch(s, 10000, "sim-worker-b");
  assert.equal(sent(s).length, 1);
  s = dispatch(
    enqueue(
      s,
      request("cancel", "CANCEL", 10000, {
        orderId: "same-order",
        deadlineAt: 19000,
      }),
    ),
  );
  assert.equal(sent(s).length, 2);
  assert.equal(sent(s)[1]!.request.action, "CANCEL");
});
test("D02 scheduler strict TEST_ONLY configuration and all shared dimensions", () => {
  for (const mutate of [
    (c: ReturnType<typeof controlConfig>) => {
      c.rules.pop();
    },
    (c: ReturnType<typeof controlConfig>) => {
      c.rules[0]!.safetyReserve = 99;
    },
    (c: ReturnType<typeof controlConfig>) => {
      c.maxQueued = c.safetyQueueReserve;
    },
    (c: ReturnType<typeof controlConfig>) => {
      c.routes.push(c.routes[0]!);
    },
  ]) {
    const c = controlConfig();
    mutate(c);
    assert.equal(controlConfigSchema.safeParse(c).success, false);
  }
  assert.equal(
    controlConfigSchema.safeParse({ ...controlConfig(), token: "SYNTHETIC" })
      .success,
    false,
  );
  assert.equal(
    controlConfigSchema.safeParse({ ...controlConfig(), purpose: "LIVE" })
      .success,
    false,
  );
});
test("D02 priority, deadline, stable ties and no input mutation", () => {
  let s = newControl(controlConfig(), 10000);
  for (const r of [
    request("scan"),
    request("exit-z", "EXIT"),
    request("exit-a", "EXIT"),
    request("early", "ORDER_QUERY", 10000, { deadlineAt: 12000 }),
    request("monitor", "MONITOR"),
  ])
    s = enqueue(s, r);
  const copy = structuredClone(s);
  s = dispatch(s);
  assert.deepEqual(
    copy.records.map((r) => r.sentAt),
    [null, null, null, null, null],
  );
  assert.equal(sent(s)[0]!.request.id, "sim-early");
  s = respond(s, "sim-early");
  s = dispatch(s);
  assert.equal(
    s.records.find((r) => r.status === "IN_FLIGHT")!.request.id,
    "sim-exit-a",
  );
  assert.equal(tier("RISK_NEWS"), 1);
  assert.equal(tier("NEWS"), 3);
});
test("D02 queue and retained-record bounds preserve safety slots", () => {
  const c = controlConfig();
  c.maxQueued = 4;
  c.maxRecords = 4;
  c.safetyQueueReserve = 1;
  let s = newControl(c, 10000);
  for (let i = 0; i < 3; i++) s = enqueue(s, request(`scan-${i}`));
  assert.throws(() => enqueue(s, request("overflow")), /QUEUE_CAPACITY/);
  s = enqueue(s, request("safety", "ORDER_QUERY"));
  assert.throws(
    () => enqueue(s, request("safety-overflow", "ORDER_QUERY")),
    /QUEUE_CAPACITY/,
  );
  s = controlStep(s, { kind: "ADVANCE", at: 20000 });
  assert.equal(
    s.records.every((r) => r.status === "DROPPED"),
    true,
  );
  assert.throws(
    () => enqueue(s, request("new", "SCAN", 20000)),
    /QUEUE_CAPACITY/,
  );
  assert.ok(s.warnings.includes("SAFETY_DEADLINE_MANUAL_REVIEW"));
});
test("D02 deadlines exact and clock regression do not debit", () => {
  let s = newControl(controlConfig(), 10000);
  assert.throws(() => enqueue(s, request("expired", "SCAN", 0)), /DEADLINE/);
  s = enqueue(s, request("ends", "ORDER_QUERY", 10000, { deadlineAt: 10001 }));
  assert.equal(sent(dispatch(s, 10001)).length, 0);
  assert.equal(sent(dispatch(s, 10000)).length, 1);
  assert.throws(() => dispatch(s, 9999), /CLOCK_REGRESSION/);
});
test("D02 same ID idempotent, conflicting ID rejected", () => {
  const r = request("same");
  let s = enqueue(newControl(controlConfig(), 10000), r);
  s = enqueue(s, r);
  assert.equal(s.records.length, 1);
  assert.throws(() => enqueue(s, { ...r, deadlineAt: 20001 }), /ID_CONFLICT/);
});
test("D02 KR and US share account/provider budgets despite separate lanes", () => {
  const c = controlConfig(2, 0);
  let s = newControl(c, 10000);
  for (const [i, routeId] of [
    "sim-kr-read",
    "sim-us-read",
    "sim-kr-read",
  ].entries()) {
    s = enqueue(s, request(`shared-${i}`, "ORDER_QUERY", 10000, { routeId }));
    s = dispatch(s);
    if (i < 2) s = respond(s, `sim-shared-${i}`);
  }
  assert.equal(sent(s).length, 2);
  assert.match(s.records[2]!.reason, /BUDGET/);
  assert.equal(sent(dispatch(s, 10999)).length, 2);
  assert.equal(sent(dispatch(s, 11000)).length, 3);
});
test("D02 different keys cannot bypass shared account quota", () => {
  const c = controlConfig(1, 0);
  c.routes[2]!.key = "sim-other-key";
  c.rules.push({
    ...c.rules[2]!,
    id: "sim-other-key-rule",
    subject: "sim-other-key",
  });
  let s = enqueue(newControl(c, 10000), request("a", "ORDER_QUERY"));
  s = respond(dispatch(s), "sim-a");
  s = enqueue(
    s,
    request("b", "ORDER_QUERY", 10000, { routeId: "sim-us-read" }),
  );
  assert.equal(sent(dispatch(s)).length, 1);
});
test("D02 TR subgroup tighter limit and independent providers", () => {
  const c = controlConfig(8, 0);
  c.rules[3]!.capacity = 1;
  let s = enqueue(newControl(c, 10000), request("kr", "ORDER_QUERY"));
  s = respond(dispatch(s), "sim-kr");
  s = enqueue(s, request("kr-two", "ORDER_QUERY"));
  s = enqueue(
    s,
    request("us", "ORDER_QUERY", 10000, { routeId: "sim-us-read" }),
  );
  s = dispatch(s);
  assert.equal(sent(s)[1]!.request.id, "sim-us");
  const other = controlConfig(1, 0);
  const original = structuredClone(other.routes[2]!);
  original.id = "sim-other-route";
  original.provider = "sim-other-provider";
  other.routes.push(original);
  for (const [i, dimension] of (
    ["PROVIDER", "ACCOUNT", "KEY", "TR"] as const
  ).entries())
    other.rules.push({
      ...other.rules[i]!,
      id: `sim-other-${i}`,
      provider: original.provider,
      dimension,
      subject:
        dimension === "PROVIDER"
          ? original.provider
          : dimension === "ACCOUNT"
            ? original.account
            : dimension === "KEY"
              ? original.key
              : original.tr,
    });
  s = respond(
    dispatch(enqueue(newControl(other, 10000), request("one", "ORDER_QUERY"))),
    "sim-one",
  );
  s = dispatch(
    enqueue(
      s,
      request("other", "ORDER_QUERY", 10000, { routeId: original.id }),
    ),
  );
  assert.equal(sent(s).length, 2);
});
test("D02 entry needs capacity for write and three safety receipts", () => {
  let s = enqueue(
    newControl(controlConfig(3, 0), 10000),
    request("entry", "ENTRY"),
  );
  assert.equal(sent(dispatch(s)).length, 0);
  assert.throws(() =>
    enqueue(newControl(controlConfig(), 10000), {
      ...request("bad", "ENTRY"),
      safetyPlan: [],
    }),
  );
  const bad = request("bad-scope", "ENTRY");
  bad.safetyPlan[0]!.routeId = "sim-us-read";
  assert.throws(
    () => enqueue(newControl(controlConfig(), 10000), bad),
    /SCOPE_MISMATCH/,
  );
  s = dispatch(
    enqueue(newControl(controlConfig(4, 0), 10000), request("entry", "ENTRY")),
  );
  assert.equal(sent(s).length, 1);
  s = recoverControl(s);
  s = enqueue(s, request("unreserved", "ORDER_QUERY"));
  assert.equal(sent(dispatch(s)).length, 1);
  for (const [i, action] of (
    ["ORDER_QUERY", "FILL_QUERY", "POSITION_QUERY"] as const
  ).entries()) {
    const id = `reserved-${i}`;
    s = enqueue(
      s,
      request(id, action, 10000, {
        reservationFor: "sim-entry",
        deadlineAt: 19000,
      }),
    );
    s = dispatch(s);
    assert.equal(sent(s).at(-1)!.request.id, `sim-${id}`);
    s = respond(s, `sim-${id}`);
  }
  assert.equal(sent(s).length, 4);
});
test("D02 reservation cannot be stolen or concurrently claimed", () => {
  let s = dispatch(
    enqueue(newControl(controlConfig(), 10000), request("entry", "ENTRY")),
  );
  assert.throws(
    () =>
      enqueue(
        s,
        request("bad", "SCAN", 10000, { reservationFor: "sim-entry" }),
      ),
    /RESERVATION_MISMATCH/,
  );
  s = enqueue(
    s,
    request("first", "ORDER_QUERY", 10000, { reservationFor: "sim-entry" }),
  );
  assert.throws(
    () =>
      enqueue(
        s,
        request("second", "ORDER_QUERY", 10000, {
          reservationFor: "sim-entry",
        }),
      ),
    /RESERVATION_DUPLICATE/,
  );
});
for (const age of [1999, 2000, 2001, 3000])
  test(`D02 unchanged quote TTL ${age}ms`, () => {
    const s = enqueue(
      newControl(controlConfig(), 10000),
      request("entry", "ENTRY", 10000, {
        freshness: { quoteAt: 10000 - age, accountAt: 10000, fxAt: 10000 },
      }),
    );
    assert.equal(sent(dispatch(s)).length, age <= 2000 ? 1 : 0);
  });
test("D02 429 cooldown is shared, preserves debit and honors Retry-After", () => {
  let s = dispatch(
    enqueue(newControl(controlConfig(), 10000), request("a", "ORDER_QUERY")),
  );
  s = respond(s, "sim-a", "429", 10000, 2000);
  s = enqueue(
    s,
    request("b", "ORDER_QUERY", 10000, { routeId: "sim-us-read" }),
  );
  assert.equal(sent(dispatch(s, 11999)).length, 1);
  assert.equal(sent(dispatch(s, 12000)).length, 2);
  assert.equal(s.records[0]!.sentAt, 10000);
  assert.ok(s.warnings.includes("RESPONSE_FAILURE_MANUAL_REVIEW"));
});
test("D02 read retry requires closed failed transport and is bounded and charged", () => {
  let s = dispatch(
    enqueue(newControl(controlConfig(), 10000), request("a", "ORDER_QUERY")),
  );
  s = respond(s, "sim-a", "429");
  s = enqueue(s, request("b", "ORDER_QUERY", 10000, { retryOf: "sim-a" }));
  assert.equal(sent(dispatch(s, 10999)).length, 1);
  s = respond(dispatch(s, 11000), "sim-b", "ERROR", 11000);
  s = enqueue(s, request("c", "ORDER_QUERY", 11000, { retryOf: "sim-b" }));
  s = respond(dispatch(s), "sim-c", "ERROR");
  assert.equal(sent(s).length, 3);
  assert.throws(
    () => enqueue(s, request("d", "ORDER_QUERY", 11000, { retryOf: "sim-c" })),
    /RETRY_LIMIT/,
  );
  assert.throws(
    () =>
      enqueue(s, request("fork", "ORDER_QUERY", 11000, { retryOf: "sim-a" })),
    /RETRY_UNSAFE/,
  );
});
test("D02 HTTP OK/ERROR/429 never confirms or retries write", () => {
  for (const code of ["OK", "ERROR", "429"]) {
    let s = dispatch(
      enqueue(newControl(controlConfig(), 10000), request("exit", "EXIT")),
    );
    s = respond(s, "sim-exit", code);
    assert.equal(s.records[0]!.status, "UNKNOWN");
    assert.throws(
      () =>
        enqueue(s, request("retry", "EXIT", 10000, { retryOf: "sim-exit" })),
      /RETRY_UNSAFE/,
    );
    assert.throws(
      () => controlStep(s, { kind: "RESUME", at: 12000, epoch: 0 }),
      /RESUME_UNSAFE/,
    );
    assert.ok(
      dispatchReasons(s, request("other", "CANCEL")).includes(
        "UNRESOLVED_REQUEST",
      ),
    );
  }
});
test("D02 timeout retains occupied lane and late result cannot promote evidence", () => {
  let s = dispatch(
    enqueue(
      newControl(controlConfig(), 10000),
      request("stall", "ORDER_QUERY", 10000, { timeoutMs: 100 }),
    ),
  );
  s = enqueue(s, request("next", "ORDER_QUERY"));
  s = dispatch(s, 10100);
  assert.equal(s.records[0]!.status, "ERROR");
  assert.equal(sent(s).length, 1);
  assert.throws(
    () =>
      enqueue(
        s,
        request("retry", "ORDER_QUERY", 10100, { retryOf: "sim-stall" }),
      ),
    /RETRY_UNSAFE/,
  );
  s = respond(s, "sim-stall", "OK", 10101);
  assert.equal(s.records[0]!.status, "ERROR");
  assert.equal(sent(dispatch(s)).length, 2);
});
test("D02 US stall and work-lane stall do not consume KR safety lane", () => {
  let s = newControl(controlConfig(), 10000);
  s = dispatch(
    enqueue(s, request("us", "MONITOR", 10000, { routeId: "sim-us-read" })),
  );
  s = dispatch(enqueue(s, request("scan", "SCAN")));
  s = dispatch(enqueue(s, request("safety", "ORDER_QUERY")));
  assert.equal(sent(s).length, 3);
  s = enqueue(
    s,
    request("blocked", "MONITOR", 10000, { routeId: "sim-us-read" }),
  );
  s = dispatch(s);
  assert.equal(sent(s).length, 3);
  assert.ok(s.warnings.includes("SAFETY_UNAVAILABLE_MANUAL_REVIEW"));
});
test("D02 restart preserves all attempts, unknown write, holds and rejects old connection", () => {
  let s = dispatch(
    enqueue(newControl(controlConfig(), 10000), request("entry", "ENTRY")),
  );
  s = enqueue(s, request("scan", "SCAN"));
  const prior = structuredClone(s);
  s = recoverControl(s);
  assert.equal(s.epoch, 1);
  assert.equal(s.mode, "PAUSED");
  assert.equal(s.records[0]!.status, "UNKNOWN");
  assert.equal(s.records[1]!.status, "DROPPED");
  assert.deepEqual(
    s.records.map((r) => r.sentAt),
    prior.records.map((r) => r.sentAt),
  );
  s = controlStep(s, {
    kind: "RESPONSE",
    at: 10001,
    requestId: "sim-entry",
    epoch: 0,
    code: "OK",
    retryAfterMs: 0,
  });
  assert.equal(s.records[0]!.status, "UNKNOWN");
  assert.ok(s.warnings.includes("OLD_CONNECTION_RESPONSE_IGNORED"));
});
test("D02 lifetime attempt budget cannot reset with time or connection", () => {
  const c = controlConfig(8, 0);
  c.rules.forEach((r) => (r.maxAttempts = 1));
  let s = respond(
    dispatch(enqueue(newControl(c, 10000), request("one", "ORDER_QUERY"))),
    "sim-one",
  );
  s = recoverControl(s);
  s = enqueue(s, request("two", "ORDER_QUERY", 20000), 20000);
  assert.equal(sent(dispatch(s)).length, 1);
});

// 서버 오라클은 제품의 rolling counter를 재사용하지 않는다. 키움 한도 추정이 아니다.
function serverAccepts(
  model: "fixed" | "sliding" | "leaky",
  arrivals: number[],
  cap = 3,
) {
  const accepted: number[] = [];
  let count = 0,
    window = -1,
    level = 0,
    previous = 0;
  return arrivals.map((at) => {
    let ok: boolean;
    if (model === "fixed") {
      const next = Math.floor(at / 1000);
      if (next !== window) {
        count = 0;
        window = next;
      }
      ok = count < cap;
      if (ok) count++;
    } else if (model === "sliding") {
      ok = accepted.filter((t) => t > at - 1000).length < cap;
    } else {
      level = Math.max(0, level - ((at - previous) * cap) / 1000);
      previous = at;
      ok = level + 1 <= cap;
      if (ok) level++;
    }
    if (ok) accepted.push(at);
    return ok;
  });
}
for (const model of ["fixed", "sliding", "leaky"] as const)
  test(`D02 independent ${model} server overload produces charged 429 and backoff`, () => {
    let s = newControl(controlConfig(10, 0), 10000);
    const answers = serverAccepts(model, [10000, 10000, 10000, 10000]);
    assert.deepEqual(answers, [true, true, true, false]);
    for (const [i, ok] of answers.entries()) {
      s = dispatch(enqueue(s, request(`oracle-${i}`, "ORDER_QUERY")));
      s = respond(s, `sim-oracle-${i}`, ok ? "OK" : "429");
    }
    s = dispatch(enqueue(s, request("post-429", "ORDER_QUERY")));
    assert.equal(sent(s).length, 4);
    assert.equal(s.mode, "PAUSED");
    assert.match(s.records.at(-1)!.reason, /BACKOFF/);
  });
test("D02 jitter counterexample local 3 per second is not server 3 per second", () => {
  const sends = [800, 1134, 1468, 1802],
    arrivals = sends.map((s, i) => s + [200, 50, 50, 50][i]!);
  assert.ok(
    sends.every(
      (at) => sends.filter((t) => t <= at && t > at - 1000).length <= 3,
    ),
  );
  assert.deepEqual(arrivals, [1000, 1184, 1518, 1852]);
  assert.deepEqual(serverAccepts("fixed", arrivals), [true, true, true, false]);
  assert.deepEqual(serverAccepts("sliding", arrivals), [
    true,
    true,
    true,
    false,
  ]);
  assert.deepEqual(serverAccepts("leaky", arrivals), [true, true, true, true]);
});
