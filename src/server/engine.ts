import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Repository } from "./repository.js";
import {
  assertOffline,
  configSchema,
  hash,
  policy,
  policyHash,
  verifyPolicies,
  type Config,
  levelSchema,
} from "../core/policy.js";
import type { State, Quote } from "../core/types.js";
import { approveEvaluation } from "../core/approval.js";
import { terminal } from "../core/types.js";
import {
  caps,
  emptyLedger,
  equity,
  foreignNet,
  fxFor,
  mark,
  settle,
} from "../core/ledger.js";
import { remainingRisk, openRisk, notional, profile } from "../core/risk.js";
import { d, ceil, sum } from "../core/math.js";
import { fixtureQuote } from "../core/fixture.js";
import { type Evaluation } from "../core/strategy.js";
import { minute, type Session } from "../core/calendar.js";
import { submissionReasons } from "../core/submission.js";
import {
  cancelEntries,
  simulatorStep,
  reconcileUnknown,
} from "../core/simulator.js";
import { researchSamples } from "../core/providers.js";
const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("configure"), config: configSchema }).strict(),
  z.object({ type: z.literal("start") }).strict(),
  z.object({ type: z.literal("pause") }).strict(),
  z
    .object({
      type: z.literal("step"),
      seconds: z.number().int().min(1).max(120).default(1),
    })
    .strict(),
  z.object({ type: z.literal("liquidate"), confirm: z.literal(true) }).strict(),
  z
    .object({
      type: z.literal("level"),
      level: levelSchema,
      confirm: z.literal(true),
    })
    .strict(),
  z.object({ type: z.literal("reconcile") }).strict(),
  z
    .object({
      type: z.literal("fault"),
      fault: z.enum([
        "DISK_FULL",
        "WRITE_FAILURE",
        "QUEUE_BACKLOG",
        "CLOCK_ERROR",
        "STALE_QUOTE",
        "NONE",
      ]),
    })
    .strict(),
]);
type Prepared = {
  evaluation: Evaluation;
  session: Session;
  dataHash: string;
  at: number;
};
const preparedCache = new Map<string, Promise<Prepared>>();
async function cachedPrepare(config: Config, at?: number) {
  const key = hash({
    market: config.market,
    scenario: config.scenario,
    at: at ?? "INITIAL",
    profile: hash(profile),
    policy: policyHash,
  });
  let result = preparedCache.get(key);
  if (!result) {
    result = prepare(config, at);
    if (preparedCache.size >= 16)
      preparedCache.delete(preparedCache.keys().next().value!);
    preparedCache.set(key, result);
    result.catch(() => preparedCache.delete(key));
  }
  return structuredClone(await result);
}
function prepare(config: Config, at?: number): Promise<Prepared> {
  const workerUrl = pathToFileURL(
    resolve("dist/runtime/src/server/evaluator-worker.js"),
  );
  return new Promise((done, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { config, at },
      execArgv: [],
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("EVALUATOR_TIMEOUT"));
    }, 30000);
    worker.once("message", (data: Prepared) => {
      clearTimeout(timer);
      done(data);
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`EVALUATOR_EXIT:${code}`));
      }
    });
  });
}
const blank = (): State => ({
  version: 1,
  revision: 0,
  config: null,
  status: "STOPPED",
  clock: Date.parse("2026-08-31T00:45:00Z"),
  sessionOpen: 0,
  sessionClose: 0,
  cursor: 0,
  epoch: 0,
  pendingLevel: null,
  ledger: emptyLedger(Date.parse("2026-08-31T00:45:00Z")),
  positions: [],
  orders: [],
  decisions: [],
  notices: [],
  lastSignalAt: 0,
  manifest: null,
  manifestHistory: [],
  fault: null,
  cleanShutdown: true,
});
export class Engine {
  readonly repo: Repository;
  private prepared: Prepared | null = null;
  private queue = Promise.resolve();
  private queued = 0;
  runtimeError: string | null = null;
  private preparing = false;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  constructor(path: string, now: () => number = Date.now) {
    verifyPolicies();
    assertOffline(
      process.env.TRADING_MODE ?? "PAPER",
      process.env.LIVE_ENABLED,
    );
    this.repo = new Repository(path, now);
    try {
      this.repo.acquire();
      this.repo.verifyAudit();
      this.repo.transact(
        `boot-${randomUUID()}`,
        { type: "BOOT" },
        (previous) => {
          const s = previous ?? blank();
          if (previous?.config) {
            s.status = "RECONCILING";
            s.notices.push(
              "재시작: 저장된 주문·예약·보유 대조 후 명시적으로 재개하세요.",
            );
          }
          s.cleanShutdown = false;
          return s;
        },
      );
      this.leaseTimer = setInterval(() => {
        try {
          this.repo.heartbeat();
        } catch {
          this.runtimeError = "WRITER_LEASE_LOST";
        }
      }, 2000);
      this.leaseTimer.unref();
    } catch (e) {
      this.repo.close();
      throw e;
    }
  }
  state() {
    return this.repo.read()!;
  }
  view() {
    const s = this.state();
    const c = s.config ? caps(s) : null;
    return {
      state: s,
      metrics: s.config
        ? {
            equity: equity(s).toString(),
            foreignNet: foreignNet(s).toString(),
            openRisk: ceil(openRisk(s)),
            remainingRisk: remainingRisk(s),
            notional: notional(s).toString(),
            caps: c,
            unresolved: s.orders.filter((o) => !terminal(o)).length,
            botQuantity: s.positions
              .filter((p) => p.owner === "BOT")
              .reduce((a, p) => a + p.quantity, 0),
            unallocatedOperating: s.positions.some((p) => p.closedAt)
              ? null
              : sum(s.ledger.costs.map((x) => x.amount)).toString(),
          }
        : null,
      runtime: {
        executionAdapter: "SIMULATOR_ONLY",
        provenance: "SYNTHETIC_FIXTURE",
        liveEnabled: false,
        externalAdapters: "NOT_IMPLEMENTED",
        forecastValidated: false,
        runtimeError: this.runtimeError,
        preparing: this.preparing,
        observedAt: Date.now(),
      },
      research: researchSamples(s.clock),
      originalPolicyHash: policyHash,
      profileHash: hash(profile),
    };
  }
  command(id: string, input: unknown) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(id))
      return Promise.reject(new Error("INVALID_COMMAND_ID"));
    const parsed = commandSchema.parse(input);
    if (this.queued >= 32) {
      this.runtimeError = "QUEUE_BACKLOG";
      return Promise.reject(new Error("QUEUE_BACKLOG"));
    }
    this.queued++;
    let result: State;
    const work = this.queue
      .then(async () => {
        result = await this.execute(id, parsed);
      })
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          /DISK_FULL|WRITE_FAILURE|FENCED|database|SQLITE|CHECKSUM/.test(
            error.message,
          )
        )
          this.runtimeError = "STORAGE_FAILURE";
        throw error;
      })
      .finally(() => {
        this.queued--;
      });
    this.queue = work.catch(() => {});
    return work.then(() => result!);
  }
  private async execute(id: string, c: z.infer<typeof commandSchema>) {
    if (this.repo.commandExists(id, c)) return this.state();
    if (c.type === "start") {
      const before = this.state();
      if (!before.config) throw new Error("CONFIG_REQUIRED");
      if (
        before.status === "RECONCILING" ||
        before.pendingLevel ||
        before.ledger.halts.length ||
        before.fault ||
        before.orders.some((o) =>
          ["UNKNOWN", "CANCEL_UNKNOWN"].includes(o.status),
        )
      )
        throw new Error("PREFLIGHT_BLOCKED");
    }
    let prepared: Prepared | null = null;
    if (c.type === "configure") {
      const s = this.state();
      if (s.config)
        throw new Error(
          "ALLOCATION_ALREADY_EXISTS: 초기화 대신 새 별도 DB로 실험하세요.",
        );
      this.preparing = true;
      try {
        prepared = await cachedPrepare(c.config);
      } finally {
        this.preparing = false;
      }
    }
    if (c.type === "start" && !this.prepared) {
      const s = this.state();
      if (s.config) {
        this.preparing = true;
        try {
          this.prepared = await cachedPrepare(s.config, s.clock);
        } finally {
          this.preparing = false;
        }
      }
    }
    if (c.type === "fault") {
      if (c.fault === "DISK_FULL" || c.fault === "WRITE_FAILURE") {
        this.repo.failure = c.fault;
        this.runtimeError = c.fault;
        return this.state();
      }
      if (c.fault === "NONE") {
        this.repo.failure =
          null; /* 해제는 새 명령을 허용할 뿐 자동 RUNNING 복구가 아니다. */
      }
    }
    if (c.type === "step") {
      if (this.runtimeError)
        throw new Error(`RUNTIME_BLOCKED:${this.runtimeError}`);
      // 부분 실행 후 재시도에서도 같은 사용자 ID의 원 요청 범위를 고정한다.
      this.repo.transact(
        `${id}_batch_intent`,
        { type: "STEP_BATCH_INTENT", command: c },
        (previous) => {
          if (!previous?.config) throw new Error("CONFIG_REQUIRED");
          return previous;
        },
      );
      for (let i = 0; i < c.seconds; i++) {
        this.repo.transact(
          `${id}_slice_${i}`,
          { type: "SIMULATOR_TICK", batch: id, index: i },
          (previous) => {
            if (!previous?.config) throw new Error("CONFIG_REQUIRED");
            this.advance(previous);
            return previous;
          },
        );
      }
      return this.repo.transact(id, c, (previous) => previous!);
    }
    const state = this.repo.transact(id, c, (previous) => {
      const s = previous!;
      if (
        this.runtimeError &&
        c.type !== "fault" &&
        c.type !== "pause" &&
        c.type !== "reconcile"
      )
        throw new Error(`RUNTIME_BLOCKED:${this.runtimeError}`);
      if (c.type === "configure") {
        const cfg = configSchema.parse(c.config);
        assertOffline(cfg.mode);
        if (s.config) throw new Error("ALLOCATION_ALREADY_EXISTS");
        const p = prepared!;
        s.config = cfg;
        s.clock = p.at;
        s.sessionOpen = p.session.open;
        s.sessionClose = p.session.close;
        s.epoch++;
        s.ledger = emptyLedger(
          s.clock,
          String(cfg.capital),
          d(cfg.usdCapitalKrw).div(profile.fxKrwPerUsd).toString(),
          profile.fxKrwPerUsd,
        );
        s.manifest = {
          experiment_id: `experiment-${hash(cfg).slice(0, 16)}`,
          purpose: "TEST_ONLY",
          provenance: "SYNTHETIC_FIXTURE",
          allowed_mode: cfg.mode,
          policy_hash: policyHash,
          strategy_definition_hash:
            policy.shared_strategy_contract.definition_sha256,
          evaluator_version: "DECIMAL40_V1",
          indicator_precision_profile: profile.precision,
          market_profile: hash(profile),
          benchmark_mapping_version: profile.benchmark,
          data_snapshot_hash: p.dataHash,
          point_in_time_universe_hash: hash([p.evaluation.symbol]),
          selection_profile_hash: "NOT_APPLICABLE",
          model_and_prompt_version: cfg.forecast,
          recorded_model_output_hash: "NOT_APPLICABLE_UNTIL_DECISION",
          forecast_profile_hash:
            cfg.forecast === "TEST_ONLY"
              ? hash(profile.forecast)
              : "MISSING_PROFILE",
          execution_model_hash: hash(profile.execution),
          calendar_version: p.session.version,
          random_seed: profile.seed,
          initial_ledger_hash: hash(s.ledger),
          variant_id: profile.variant,
          as_of: s.clock,
          risk_level: cfg.level,
          risk_config_epoch: s.epoch,
          risk_level_profile_hash: hash({ level: cfg.level, stage: cfg.stage }),
          effective_caps_hash: hash(caps(s)),
          performance_qualified: false,
          initial_signal_price: p.evaluation.current?.c ?? null,
        };
        s.manifestHistory.push(structuredClone(s.manifest));
        s.status = "STOPPED";
      } else if (c.type === "start") {
        if (!s.config) throw new Error("CONFIG_REQUIRED");
        if (
          s.status === "RECONCILING" ||
          s.pendingLevel ||
          s.ledger.halts.length ||
          s.fault ||
          s.orders.some((o) => ["UNKNOWN", "CANCEL_UNKNOWN"].includes(o.status))
        )
          throw new Error("PREFLIGHT_BLOCKED");
        verifyPolicies();
        s.status = "RUNNING";
        this.decide(s, this.prepared!.evaluation);
      } else if (c.type === "pause") {
        s.status = "ENTRY_PAUSED";
        cancelEntries(s);
      } else if (c.type === "liquidate") {
        if (!s.config) throw new Error("CONFIG_REQUIRED");
        s.status = "ENTRY_PAUSED";
        cancelEntries(s);
        for (const p of s.positions) {
          if (p.owner === "BOT" && p.quantity > 0)
            p.exitReason = "USER_BOT_ONLY";
        }
      } else if (c.type === "level") {
        if (!s.config) throw new Error("CONFIG_REQUIRED");
        const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
        if (c.level === s.config.level) return s;
        if (rank[c.level] > rank[s.config.level]) {
          if (
            !["STOPPED", "ENTRY_PAUSED"].includes(s.status) ||
            s.positions.some((p) => p.owner === "BOT" && p.quantity > 0) ||
            s.orders.some((o) => !terminal(o)) ||
            s.ledger.halts.length ||
            s.fault
          )
            throw new Error("RAISE_REQUIRES_FLAT_STOPPED_RECONCILED");
          s.config.level = c.level;
        } else {
          s.status = "ENTRY_PAUSED";
          s.pendingLevel = c.level;
          cancelEntries(s);
        }
        s.epoch++;
        this.applyPendingLevel(s);
        if (s.manifest) {
          s.manifest = {
            ...s.manifest,
            risk_level: s.config.level,
            risk_config_epoch: s.epoch,
            risk_level_profile_hash: hash({
              level: s.config.level,
              stage: s.config.stage,
            }),
            effective_caps_hash: hash(caps(s)),
            as_of: s.clock,
          };
          s.manifestHistory.push(structuredClone(s.manifest));
        }
      } else if (c.type === "reconcile") {
        reconcileUnknown(s);
        cancelEntries(s);
        if (s.orders.some((o) => o.side === "BUY" && !terminal(o)))
          throw new Error("CANCELS_PENDING");
        s.status = s.ledger.halts.length ? "HALTED" : "ENTRY_PAUSED";
        s.notices.push("모의 저장 장부 대조 완료. 자동 재개하지 않습니다.");
      } else if (c.type === "fault") {
        s.fault = c.fault === "NONE" ? null : c.fault;
        s.status = "RECONCILING";
        s.notices.push(
          `시험 장애 ${c.fault}; 보호/청산 상태 확인 후 재개 필요`,
        );
        cancelEntries(s);
      }
      s.cleanShutdown = false;
      return s;
    });
    if (prepared) this.prepared = prepared;
    if (c.type === "fault" && c.fault === "NONE") this.runtimeError = null;
    return state;
  }
  private quote(s: State): Quote {
    const base =
      s.manifest?.initial_signal_price ??
      s.orders.find((o) => o.side === "BUY")?.snapshot?.signal_price ??
      (s.config!.market === "KR" ? "21400" : "214");
    const initial =
      s.sessionOpen + (s.config!.scenario === "P" ? 60 : 45) * minute;
    const q = fixtureQuote(s.config!, s.clock, String(base), initial);
    if (s.fault === "STALE_QUOTE") q.at -= 3000;
    return q;
  }
  private applyPendingLevel(s: State) {
    if (
      s.pendingLevel &&
      !s.orders.some((o) => o.side === "BUY" && !terminal(o))
    ) {
      s.config!.level = s.pendingLevel;
      s.pendingLevel = null;
      const c = caps(s);
      const excess =
        openRisk(s).gt(c.risk) ||
        openRisk(s).gt(c.group) ||
        notional(s).gt(c.notional) ||
        s.positions.some((p) =>
          d(p.bid)
            .mul(p.quantity)
            .mul(fxFor(s.ledger, p.currency))
            .gt(c.position),
        );
      s.status = excess ? "REDUCTION_PENDING" : "ENTRY_PAUSED";
      if (s.manifest)
        s.manifest = {
          ...s.manifest,
          risk_level: s.config!.level,
          risk_config_epoch: s.epoch,
          risk_level_profile_hash: hash({
            level: s.config!.level,
            stage: s.config!.stage,
          }),
          effective_caps_hash: hash(c),
          as_of: s.clock,
        };
    }
  }
  private advance(s: State) {
    s.clock += 1000;
    s.cursor++;
    s.ledger.fxAt = s.clock;
    s.ledger.accountAt = s.clock;
    const q = this.quote(s);
    for (const o of s.orders) {
      if (o.side !== "BUY" || o.status !== "INTENT_SAVED") continue;
      let reasons: string[];
      try {
        verifyPolicies();
        reasons = submissionReasons(s, o, q);
      } catch {
        reasons = ["POLICY_OR_SUBMISSION_ERROR"];
      }
      if (reasons.length) {
        o.status = "REJECTED";
        o.reservationCash = "0";
        o.reservationRisk = "0";
        s.notices.push(`접수 전 승인 폐기: ${reasons.join(", ")}`);
      }
    }
    if (q.at === s.clock && !q.halted) simulatorStep(s, q);
    else {
      s.status = "ENTRY_PAUSED";
      cancelEntries(s);
      s.notices.push("유효 호가 없음: 체결 추정 금지");
    }
    settle(s, "KRW");
    settle(s, "USD");
    mark(s);
    this.applyPendingLevel(s);
    if (
      s.status === "REDUCTION_PENDING" &&
      !s.positions.some((p) => p.owner === "BOT" && p.quantity > 0) &&
      s.orders.every(terminal)
    )
      s.status = "ENTRY_PAUSED";
    if (s.clock >= s.sessionClose) {
      s.status =
        s.orders.every(terminal) && !s.positions.some((p) => p.quantity > 0)
          ? "STOPPED"
          : "EXIT_BLOCKED";
    }
    if (
      this.prepared &&
      s.status === "RUNNING" &&
      this.prepared.evaluation.current?.closeAt !== s.lastSignalAt
    )
      this.decide(s, this.prepared.evaluation);
    s.notices = s.notices.slice(-50);
  }
  private decide(s: State, e: Evaluation) {
    const signalAt = e.current?.closeAt ?? s.clock;
    const decisionId = `decision-${e.symbol}-${s.epoch}-${signalAt}`;
    if (
      signalAt < s.lastSignalAt ||
      s.decisions.some((x) => x.id === decisionId)
    )
      return;
    s.lastSignalAt = signalAt;
    approveEvaluation(s, e, {
      quote: this.quote(s),
      market: s.config!.market,
      sessionClose: s.sessionClose,
      dataHash: this.prepared!.dataHash,
      decisionId,
    });
  }
  async tick() {
    if (this.queued) return;
    const s = this.state();
    if (!s.config) return;
    try {
      this.repo.heartbeat();
      if (
        s.clock < s.sessionClose &&
        [
          "RUNNING",
          "ENTRY_PAUSED",
          "RECONCILING",
          "REDUCTION_PENDING",
          "HALTED",
          "EXIT_BLOCKED",
        ].includes(s.status)
      ) {
        await this.command(`tick-${s.clock}`, { type: "step", seconds: 1 });
        const next = this.state();
        const bar =
          next.sessionOpen +
          Math.floor((next.clock - next.sessionOpen) / (15 * minute)) *
            15 *
            minute;
        if (
          next.status === "RUNNING" &&
          bar > next.lastSignalAt &&
          !this.preparing
        ) {
          this.preparing = true;
          cachedPrepare(next.config!, next.clock)
            .then((p) => {
              this.prepared = p;
            })
            .catch(() => {
              this.runtimeError = "EVALUATOR_FAILURE";
            })
            .finally(() => {
              this.preparing = false;
            });
        }
      }
    } catch (e) {
      this.runtimeError = e instanceof Error ? e.message : "STORAGE_FAILURE";
    }
  }
  close() {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    try {
      this.repo.transact(
        `shutdown-${randomUUID()}`,
        { type: "SHUTDOWN" },
        (s) => {
          s!.status = "RECONCILING";
          cancelEntries(s!);
          s!.cleanShutdown = true;
          return s!;
        },
      );
    } finally {
      this.repo.close();
    }
  }
}
