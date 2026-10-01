import {
  controlStep,
  type ControlAction,
  type ControlConfig,
  type ControlRequest,
  type ControlState,
} from "../src/core/broker-control.js";
import {
  BrokerControlLab,
  brokerLabData,
} from "../src/server/broker-control-lab.js";
import { PortfolioPaperEngine } from "../src/server/portfolio-engine.js";
import {
  injectUnknownSell,
  prepareSell,
  sellOrder,
  sellProgram,
  sellBase,
  type UnknownSellStatus,
} from "./sell-unknown-helpers.js";
import { laterTick } from "../src/core/portfolio-fixture.js";
import { d } from "../src/core/math.js";
import type { ReconciliationEvidence } from "../src/core/broker-reconciliation.js";

export function controlConfig(capacity = 8, reserve = 3): ControlConfig {
  const routes: ControlConfig["routes"] = (["KR", "US"] as const).flatMap(
    (market) =>
      ["read", "write"].map((group) => ({
        id: `sim-${market.toLowerCase()}-${group}`,
        provider: "sim-broker",
        account: "sim-account",
        key: "sim-key",
        environment: "SYNTHETIC" as const,
        market,
        tr: `sim-${market.toLowerCase()}-${group}`,
      })),
  );
  const dimensions: {
    dimension: ControlConfig["rules"][number]["dimension"];
    subject: string;
  }[] = [
    { dimension: "PROVIDER", subject: "sim-broker" },
    { dimension: "ACCOUNT", subject: "sim-account" },
    { dimension: "KEY", subject: "sim-key" },
    ...routes.map((r) => ({ dimension: "TR" as const, subject: r.tr })),
  ];
  return {
    schemaVersion: "OFFLINE_BROKER_CONTROL_V1",
    purpose: "TEST_ONLY",
    routes,
    rules: dimensions.map((r, i) => ({
      ...r,
      id: `sim-rule-${i}`,
      provider: "sim-broker",
      environment: "SYNTHETIC",
      capacity,
      safetyReserve: reserve,
      windowMs: 1000,
      maxAttempts: 80,
      totalSafetyReserve: reserve,
    })),
    maxQueued: 12,
    safetyQueueReserve: 3,
    laneCapacity: 1,
    maxRecords: 120,
    minBackoffMs: 1000,
    maxRetries: 2,
  };
}
export function request(
  id: string,
  action: ControlAction = "SCAN",
  at = 10000,
  extra: Partial<ControlRequest> = {},
): ControlRequest {
  const write = ["ENTRY", "EXIT", "CANCEL"].includes(action);
  return {
    id: `sim-${id}`,
    action,
    orderId: null,
    routeId: write ? "sim-kr-write" : "sim-kr-read",
    deadlineAt: at + 10000,
    timeoutMs: 5000,
    caseId: null,
    retryOf: null,
    reservationFor: null,
    safetyPlan:
      action === "ENTRY"
        ? (["ORDER_QUERY", "FILL_QUERY", "POSITION_QUERY"] as const).map(
            (action) => ({ action, routeId: "sim-kr-read" }),
          )
        : [],
    freshness:
      action === "ENTRY" ? { quoteAt: at, accountAt: at, fxAt: at } : null,
    ...extra,
  };
}
export const enqueue = (s: ControlState, r: ControlRequest, at = s.now) =>
  controlStep(s, { kind: "ENQUEUE", at, request: r });
export const dispatch = (s: ControlState, at = s.now, worker = "sim-worker") =>
  controlStep(s, { kind: "DISPATCH", at, worker });
export const respond = (
  s: ControlState,
  id: string,
  code = "OK",
  at = s.now,
  retryAfterMs = 0,
) =>
  controlStep(s, {
    kind: "RESPONSE",
    requestId: id,
    at,
    epoch: s.epoch,
    code,
    retryAfterMs,
  });
export function labWithSell(
  status: UnknownSellStatus = "UNKNOWN",
  path = ":memory:",
  partial = false,
  beforeOpen?: (lab: BrokerControlLab) => string[] | void,
  config = controlConfig(),
) {
  const paper = new PortfolioPaperEngine(sellProgram);
  let seed;
  try {
    prepareSell(paper, partial);
    seed = injectUnknownSell(paper, status);
  } finally {
    paper.close();
  }
  const lab = new BrokerControlLab(sellProgram.initial(0), config, path);
  // 결함 주입은 시험 안에서만 한다. 제품에는 종목·잔고 주입 API가 없다.
  lab.repo.transact("test-seed-unknown", { status }, (current) => {
    if (!current) throw Error("TEST_SEED_MISSING");
    const data = brokerLabData(current);
    data.control.now = seed.clock;
    return {
      ...seed,
      epoch: lab.repo.epoch,
      manifest: { ...seed.manifest, brokerControlLab: data },
    };
  });
  const requestIds = beforeOpen?.(lab) ?? [];
  lab.command("open-case", {
    kind: "OPEN_CASE",
    case: {
      id: "sim-case",
      orderId: sellOrder(seed).id,
      routeId: "sim-kr-read",
      requestIds,
    },
  });
  return lab;
}
export function evidenceFor(
  lab: BrokerControlLab,
  round: string,
  filled = 1,
  status: ReconciliationEvidence["order"]["status"] = "CANCELLED",
): ReconciliationEvidence {
  const before = lab.state(),
    order = before.orders.find(
      (o) => o.id === brokerLabData(before).cases[0]!.orderId,
    )!,
    asOf = before.clock + 10;
  const actions = ["ORDER_QUERY", "FILL_QUERY", "POSITION_QUERY"] as const;
  const data = brokerLabData(before);
  const origin = data.control.records.find(
    (r) =>
      data.cases[0]!.requestIds.includes(r.request.id) &&
      r.request.action === "ENTRY",
  );
  const receipts = actions.map((action, i) => {
    const at = asOf + i * 2,
      id = `${round}-${i}`;
    lab.command(`enqueue-${id}`, {
      kind: "CONTROL",
      command: {
        kind: "ENQUEUE",
        at,
        request: request(id, action, at, {
          caseId: "sim-case",
          reservationFor: origin?.request.id ?? null,
        }),
      },
    });
    lab.command(`dispatch-${id}`, {
      kind: "CONTROL",
      command: { kind: "DISPATCH", at, worker: `sim-worker-${i}` },
    });
    lab.command(`response-${id}`, {
      kind: "CONTROL",
      command: {
        kind: "RESPONSE",
        at: at + 1,
        requestId: `sim-${id}`,
        epoch: brokerLabData(lab.state()).control.epoch,
        code: "OK",
        retryAfterMs: 0,
      },
    });
    return {
      requestId: `sim-${id}`,
      asOf,
      availableAt: at + 1,
      coverageFrom: order.submittedAt,
      complete: true,
    };
  });
  const items = Array.from({ length: filled }, (_, i) => ({
    id: `sim-fill-${i}`,
    at: order.submittedAt,
    quantity: 1,
    value: order.limit,
  }));
  return {
    schemaVersion: "OFFLINE_RECONCILIATION_V1",
    purpose: "TEST_ONLY",
    caseId: "sim-case",
    orderId: order.id,
    positionId: order.positionId,
    symbol:
      before.positions[0]?.symbol ?? String(order.snapshot?.instrument_id),
    routeId: "sim-kr-read",
    asOf,
    order: {
      ...receipts[0]!,
      filled,
      value: d(order.limit).mul(filled).toString(),
      status,
    },
    fills: { ...receipts[1]!, items },
    position: {
      ...receipts[2]!,
      quantity:
        (before.positions[0]?.quantity ?? 0) +
        (order.side === "BUY" ? 1 : -1) * (filled - order.filled),
    },
  };
}
export function labWithBuy(
  status: UnknownSellStatus,
  partial: boolean,
  beforeOpen?: (lab: BrokerControlLab) => string[] | void,
  config = controlConfig(),
) {
  const paper = new PortfolioPaperEngine(sellProgram);
  let seed;
  try {
    paper.command("buy-start", { type: "start" });
    paper.command("buy-frame", sellBase);
    paper.command("buy-accept", laterTick(sellBase, 0.1));
    if (partial) paper.command("buy-partial", laterTick(sellBase, 0.2));
    seed = paper.state();
    seed.orders[0]!.status = status;
    seed.status = "RECONCILING";
  } finally {
    paper.close();
  }
  const lab = new BrokerControlLab(sellProgram.initial(0), config);
  lab.repo.transact("test-buy-seed", { status }, (current) => {
    if (!current) throw Error("TEST_SEED_MISSING");
    const data = brokerLabData(current);
    data.control.now = seed.clock;
    return {
      ...seed,
      epoch: lab.repo.epoch,
      manifest: { ...seed.manifest, brokerControlLab: data },
    };
  });
  const requestIds = beforeOpen?.(lab) ?? [];
  lab.command("open-case", {
    kind: "OPEN_CASE",
    case: {
      id: "sim-case",
      orderId: seed.orders[0]!.id,
      routeId: "sim-kr-read",
      requestIds,
    },
  });
  return lab;
}
