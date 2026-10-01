import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Repository } from "./repository.js";
import { PortfolioProgram } from "../core/portfolio-program.js";
import {
  enableLearningCapture,
  learningJournal,
  captureLearningTransition,
} from "../core/paper-learning-capture.js";
import {
  portfolioCommandSchema,
  type PortfolioTick,
} from "../core/portfolio-schema.js";
import { assertOffline, hash, policy, verifyPolicies } from "../core/policy.js";
import { d, ceil } from "../core/math.js";
import { mark, settle, fxFor } from "../core/ledger.js";
import { costFor } from "../core/risk.js";
import { checkPortfolioInvariants } from "../core/portfolio-invariants.js";
import {
  cancelEntries,
  simulatorStep,
  orderInstrument,
  reconcileUnknown,
} from "../core/simulator.js";
import { submissionReasons } from "../core/submission.js";
import { terminal, type State } from "../core/types.js";
import {
  executionStressSchema,
  stressQuote,
  type ExecutionStress,
} from "../core/execution-stress.js";
import {
  webCheckpointSchema,
  type WebCheckpoint,
} from "../core/portfolio-web-schema.js";

export class PortfolioPaperEngine {
  readonly repo: Repository;
  readonly #program: PortfolioProgram;
  readonly #stress: Readonly<ExecutionStress> | undefined;
  constructor(
    program: PortfolioProgram,
    path = ":memory:",
    options: {
      resume?: boolean;
      now?: () => number;
      captureLearning?: boolean;
      executionStress?: unknown;
    } = {},
  ) {
    assertOffline(
      process.env.TRADING_MODE ?? "PAPER",
      process.env.LIVE_ENABLED ?? false,
    );
    verifyPolicies();
    this.#stress =
      options.executionStress === undefined
        ? undefined
        : Object.freeze(executionStressSchema.parse(options.executionStress));
    if (this.#stress && options.captureLearning)
      throw new Error("STRESS_LEARNING_UNSUPPORTED");
    this.#program = program;
    // 재개 전에 읽기 전용으로 종류/바인딩을 확인한다. 다른 앱 DB에 DDL/lease를 쓰지 않는다.
    if (path !== ":memory:") {
      if (!options.resume && existsSync(path))
        throw new Error("PORTFOLIO_NEW_DB_REQUIRED");
      if (options.resume) {
        if (!existsSync(path)) throw new Error("PORTFOLIO_RESUME_DB_MISSING");
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          const row = db
            .prepare("SELECT body,checksum FROM aggregate WHERE id=1")
            .get() as { body: string; checksum: string } | undefined;
          if (!row) throw new Error("PORTFOLIO_STATE_MISSING");
          const s = JSON.parse(row.body) as State;
          if (hash(s) !== row.checksum) throw new Error("PORTFOLIO_CHECKSUM");
          if (options.captureLearning && !learningJournal(s))
            throw new Error("PAPER_LEARNING_NEW_RUN_REQUIRED");
          this.validate(s);
        } finally {
          db.close();
        }
      }
    }
    this.repo = new Repository(path, options.now);
    try {
      this.repo.acquire();
      this.repo.verifyAudit();
      this.repo.transact(
        `portfolio-boot-${randomUUID()}`,
        { runHash: program.runHash },
        (old) => {
          const s = old ?? program.initial(this.repo.epoch);
          if (!old && this.#stress)
            s.manifest!.executionStress = { ...this.#stress };
          if (options.captureLearning && !old) enableLearningCapture(s);
          if (options.captureLearning && old && !learningJournal(s))
            throw new Error("PAPER_LEARNING_NEW_RUN_REQUIRED");
          this.validate(s);
          if (old) {
            s.status = "RECONCILING";
            cancelEntries(s, this.#stress);
            if (s.manifest?.webReplay) {
              const checkpoint = webCheckpointSchema.parse(
                s.manifest.webReplay,
              );
              s.manifest.webReplay = {
                ...checkpoint,
                entryEnabled: false,
                reconciledEpoch: 0,
              };
            }
            s.notices.push(
              "재시작: 미체결 취소/장부 대조 후 명시적으로 재개하세요.",
            );
          }
          s.epoch = this.repo.epoch;
          s.cleanShutdown = false;
          return s;
        },
      );
    } catch (e) {
      this.repo.close();
      throw e;
    }
  }
  private validate(s: State) {
    if (
      hash(s.manifest?.executionStress ?? null) !== hash(this.#stress ?? null)
    )
      throw new Error("STRESS_PROFILE_MISMATCH");
    if (this.#stress && learningJournal(s))
      throw new Error("STRESS_LEARNING_UNSUPPORTED");
    if (
      s.manifest?.kind !== "OFFLINE_PORTFOLIO_PAPER_V1" ||
      s.manifest.runHash !== this.#program.runHash ||
      !Array.isArray(s.manifest.processedSignals)
    )
      throw new Error("PORTFOLIO_RUN_MISMATCH");
    checkPortfolioInvariants(s, this.#program.initial(s.epoch));
  }
  state() {
    const s = this.repo.read();
    if (!s) throw new Error("PORTFOLIO_STATE_MISSING");
    this.validate(s);
    return s;
  }
  // 동기 SQLite BEGIN IMMEDIATE 안에서 최신 상태 재조회→심사→예약→감사 기록을 커밋한다.
  command(
    id: string,
    raw: unknown,
    web?: { expectedIndex: number; next: WebCheckpoint; requestHash?: string },
  ) {
    if (!/^[A-Za-z0-9:._-]{1,180}$/.test(id))
      throw new Error("PORTFOLIO_COMMAND_ID");
    const command = portfolioCommandSchema.parse(raw);
    verifyPolicies();
    const checkpoint = web ? webCheckpointSchema.parse(web.next) : undefined;
    const input = web?.requestHash
      ? {
          command,
          webRequest: web.requestHash,
          recipeHash: checkpoint!.recipeHash,
        }
      : web
        ? { command, web }
        : command;
    return this.repo.transact(id, input, (old) => {
      if (!old) throw new Error("PORTFOLIO_STATE_MISSING");
      const s = old;
      this.validate(s);
      const learningBefore = learningJournal(s) ? structuredClone(s) : null;
      if (web && checkpoint) {
        const prior = s.manifest?.webReplay
          ? webCheckpointSchema.parse(s.manifest.webReplay)
          : null;
        if (
          (prior?.index ?? 0) !== web.expectedIndex ||
          (prior && prior.recipeHash !== checkpoint.recipeHash) ||
          checkpoint.index < web.expectedIndex ||
          checkpoint.index > web.expectedIndex + 1
        )
          throw new Error("WEB_CHECKPOINT_CONFLICT");
        if (command.type === "start" && prior?.reconciledEpoch !== s.epoch)
          throw new Error("WEB_RECONCILIATION_REQUIRED");
      }
      if (command.type === "tick") {
        const tick = structuredClone(command);
        if (this.#stress) {
          for (const row of tick.quotes) {
            const asset = this.#program.asset(row.catalogKey);
            if (!asset) throw new Error("PORTFOLIO_UNKNOWN_INSTRUMENT");
            row.quote = stressQuote(
              row.quote,
              asset.identity.market,
              this.#stress,
            );
          }
        }
        this.advance(s, tick);
      } else if (command.type === "pause") {
        if (!web || s.status !== "RECONCILING") s.status = "ENTRY_PAUSED";
        cancelEntries(s, this.#stress);
      } else if (command.type === "liquidate") {
        s.status = "ENTRY_PAUSED";
        cancelEntries(s, this.#stress);
        for (const p of s.positions) if (p.quantity > 0) p.exitReason = "USER";
      } else if (command.type === "reconcile") {
        if (s.fault) throw new Error("PORTFOLIO_FAULT_UNRESOLVED");
        reconcileUnknown(s);
        if (s.orders.some((o) => o.side === "BUY" && !terminal(o)))
          throw new Error("PORTFOLIO_CANCEL_UNRESOLVED");
        this.validate(s);
        s.status = "ENTRY_PAUSED";
      } else {
        if (
          !["STOPPED", "ENTRY_PAUSED"].includes(s.status) ||
          s.fault ||
          s.ledger.halts.length ||
          s.positions.some(
            (p) =>
              p.quantity > 0 && (p.exitReason || p.protection !== "WATCHING"),
          ) ||
          s.orders.some((o) => !terminal(o))
        )
          throw new Error("PORTFOLIO_NOT_RECONCILED");
        s.status = "RUNNING";
      }
      if (checkpoint) s.manifest!.webReplay = checkpoint;
      if (learningBefore)
        captureLearningTransition(s, learningBefore, id, (decision) =>
          this.#program.learningFeatureSource(decision),
        );
      this.validate(s);
      return s;
    });
  }
  private advance(s: State, t: PortfolioTick) {
    if (t.at < s.clock || t.at === s.clock)
      throw new Error("PORTFOLIO_NON_MONOTONIC_TIME");
    if (
      t.at - s.clock > 1000 &&
      (s.positions.some((p) => p.quantity > 0) ||
        s.orders.some((o) => !terminal(o)))
    )
      throw new Error("PORTFOLIO_EXPOSED_TIME_GAP");
    for (const row of t.quotes)
      if (!this.#program.asset(row.catalogKey))
        throw new Error("PORTFOLIO_UNKNOWN_INSTRUMENT");
    s.clock = t.at;
    s.cursor++;
    if (s.cursor > 10000) throw new Error("PORTFOLIO_RUN_RESOURCE_LIMIT");
    const common: string[] = [];
    const actionBlocked = new Set(
      this.#program
        .assets()
        .filter(({ key }) => this.#program.actionBlocked(s, t.at, key))
        .map(({ key }) => key),
    );
    if (actionBlocked.size) {
      common.push("CORPORATE_ACTION_RECONCILIATION_REQUIRED");
      s.status = "RECONCILING";
      s.fault = "CORPORATE_ACTION_RECONCILIATION_REQUIRED";
    }
    if (
      t.accountAt > t.at ||
      t.at - t.accountAt >
        policy.execution.maximum_account_snapshot_age_seconds * 1000
    )
      common.push("ACCOUNT_STALE");
    if (
      t.fx.at > t.at ||
      t.at - t.fx.at > policy.execution.maximum_fx_age_seconds * 1000
    )
      common.push("FX_STALE");
    if (!common.includes("FX_STALE")) {
      s.ledger.fx = t.fx.rate;
      s.ledger.fxAt = t.fx.at;
    }
    // 환율 갱신은 실제 환전이 아니다. 이미 예약한 USD 위험의 KRW 환산도 재계산한다.
    for (const o of s.orders.filter((o) => o.side === "BUY" && !terminal(o))) {
      const n = o.quantity - o.filled,
        fx = fxFor(s.ledger, o.currency);
      const cost = costFor(n, o.limit, String(o.snapshot!.stop_price), fx);
      o.reservationRisk = ceil(
        d(o.limit)
          .minus(String(o.snapshot!.stop_price))
          .mul(n)
          .mul(fx)
          .plus(cost.stop),
      );
    }
    const active = new Set([
      ...s.positions.filter((p) => p.quantity > 0).map((p) => p.symbol),
      ...s.orders
        .filter((o) => !terminal(o))
        .map((o) => orderInstrument(s, o)!),
    ]);
    if ([...active].some((key) => this.#program.quoteReasons(t, key).length))
      common.push("ACTIVE_EXPOSURE_QUOTE_MISSING_OR_STALE");
    // 모든 보유의 현재 bid를 먼저 반영한 뒤 종목별 처리한다. 다른 종목 호가를 대입하지 않는다.
    for (const p of s.positions) {
      const row = t.quotes.find((q) => q.catalogKey === p.symbol);
      if (
        row &&
        !actionBlocked.has(p.symbol) &&
        !this.#program.quoteReasons(t, p.symbol).length
      )
        p.bid = row.quote.bid;
    }
    mark(s);
    s.ledger.accountAt = t.accountAt;
    if (common.length) {
      if (s.status === "RUNNING") s.status = "ENTRY_PAUSED";
      cancelEntries(s, this.#stress);
      s.notices.push(...common);
    }
    for (const row of [...t.quotes].sort((a, b) =>
      a.catalogKey.localeCompare(b.catalogKey, "en"),
    )) {
      if (
        s.fault ||
        actionBlocked.has(row.catalogKey) ||
        this.#program.quoteReasons(t, row.catalogKey).length
      )
        continue;
      for (const o of s.orders.filter(
        (o) =>
          o.side === "BUY" &&
          o.status === "INTENT_SAVED" &&
          orderInstrument(s, o) === row.catalogKey,
      )) {
        const reasons = submissionReasons(s, o, row.quote);
        if (reasons.length) {
          o.status = "REJECTED";
          o.reservationCash = "0";
          o.reservationRisk = "0";
          s.notices.push(`모의 접수 재검사 거절: ${reasons.join(",")}`);
        }
      }
      simulatorStep(s, row.quote, row.catalogKey, this.#stress);
      s.ledger.accountAt = t.accountAt;
    }
    // TEST_ONLY 합성 결제. 실계좌 결제일/T+N 모형이 아니다.
    settle(s, "KRW");
    settle(s, "USD");
    mark(s);
    s.ledger.accountAt = t.accountAt;
    this.#program.evaluate(s, t, common, this.#stress);
    s.notices = s.notices.slice(-100);
  }
  close() {
    this.repo.close();
  }
}
