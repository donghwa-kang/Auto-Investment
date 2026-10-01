import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { makeSignalReplayFixture } from "../core/signal-replay-fixture.js";
import { portfolioFixture } from "../core/portfolio-fixture.js";
import { PortfolioProgram } from "../core/portfolio-program.js";
import { portfolioCommandSchema } from "../core/portfolio-schema.js";
import {
  webSetupSchema,
  webCheckpointSchema,
  webActionSchema,
  type WebSetup,
  type WebAction,
} from "../core/portfolio-web-schema.js";
import { hash } from "../core/policy.js";
import { equity, availableCash, caps } from "../core/ledger.js";
import { openRisk, remainingRisk } from "../core/risk.js";
import { sum } from "../core/math.js";
import { terminal } from "../core/types.js";
import { readCatalogFile } from "./catalog-file.js";
import { loadPortfolioPlan } from "./portfolio-file.js";
import { PortfolioPaperEngine } from "./portfolio-engine.js";

// 생성된 원시 이력과 명령은 별도 실행 폴더에 한 번만 기록한다. 웹 입력은 경로를 받지 않는다.
export function prepareWebPlan(directory: string, raw: WebSetup) {
  const setup = webSetupSchema.parse(raw);
  const input = makeSignalReplayFixture(setup.sampleMarket);
  const fixture = portfolioFixture(input);
  fixture.settings.config = {
    ...fixture.settings.config,
    capital: setup.capital,
    usdCapitalKrw: setup.usdCapitalKrw,
    level: setup.level,
    stage: setup.stage,
    forecast: setup.forecast,
  };
  mkdirSync(directory, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFileSync(resolve(directory, name), JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
  const histories = input.histories.map((h, i) => {
    const file = `history-${i}.json`;
    write(file, h);
    return { assetKey: h.assetKey, file, snapshotHash: hash(h) };
  });
  write("replay.json", {
    ...input,
    schemaVersion: "OFFLINE_SIGNAL_REPLAY_MANIFEST_V1",
    histories,
  });
  write("plan.json", {
    schemaVersion: "OFFLINE_PORTFOLIO_PLAN_V1",
    purpose: "TEST_ONLY",
    replayFile: "replay.json",
    replayInputHash: hash(input),
    settings: fixture.settings,
    commands: fixture.commands,
  });
}

export class PortfolioWebRun {
  readonly engine: PortfolioPaperEngine;
  readonly recipeHash: string;
  readonly program: PortfolioProgram;
  readonly commands;
  playing = false;
  error: string | null = null;
  constructor(readonly directory: string) {
    const request = readCatalogFile(resolve(directory, "request.json")) as {
      setup: unknown;
    };
    const setup = webSetupSchema.parse(request.setup);
    if (!existsSync(resolve(directory, "plan.json")))
      throw new Error("WEB_PLAN_INCOMPLETE");
    const { plan, input } = loadPortfolioPlan(resolve(directory, "plan.json"));
    const c = plan.settings.config;
    if (
      hash([c.capital, c.usdCapitalKrw, c.level, c.stage, c.forecast]) !==
        hash([
          setup.capital,
          setup.usdCapitalKrw,
          setup.level,
          setup.stage,
          setup.forecast,
        ]) ||
      input.histories.some((h) => h.identity.market !== setup.sampleMarket)
    )
      throw new Error("WEB_SETUP_BINDING");
    this.program = new PortfolioProgram(input, plan.settings);
    this.commands = plan.commands.filter(
      (c, i) => !(i === 0 && c.type === "start"),
    );
    this.recipeHash = hash({
      commands: this.commands,
      runHash: this.program.runHash,
    });
    const db = resolve(directory, "paper.sqlite");
    if (existsSync(db)) {
      const inspect = new DatabaseSync(db, { readOnly: true });
      try {
        const row = inspect
          .prepare("SELECT body,checksum FROM aggregate WHERE id=1")
          .get() as { body: string; checksum: string } | undefined;
        if (!row) throw new Error("WEB_STATE_MISSING");
        const saved = JSON.parse(row.body) as {
          manifest?: { webReplay?: unknown };
        };
        if (hash(saved) !== row.checksum) throw new Error("WEB_STATE_CHECKSUM");
        const checkpoint = webCheckpointSchema.parse(saved.manifest?.webReplay);
        if (
          checkpoint.recipeHash !== this.recipeHash ||
          checkpoint.index > this.commands.length
        )
          throw new Error("WEB_RECIPE_BINDING");
      } finally {
        inspect.close();
      }
    }
    this.engine = new PortfolioPaperEngine(this.program, db, {
      resume: existsSync(db),
    });
    try {
      const checkpoint = this.engine.state().manifest?.webReplay;
      if (checkpoint) {
        const saved = webCheckpointSchema.parse(checkpoint);
        if (
          saved.recipeHash !== this.recipeHash ||
          saved.index > this.commands.length
        )
          throw new Error("WEB_RECIPE_BINDING");
      } else {
        this.engine.command(
          "web-initialize",
          { type: "pause" },
          {
            expectedIndex: 0,
            next: {
              recipeHash: this.recipeHash,
              index: 0,
              entryEnabled: false,
              reconciledEpoch: this.engine.state().epoch,
            },
          },
        );
      }
    } catch (e) {
      this.engine.close();
      throw e;
    }
  }
  checkpoint() {
    return webCheckpointSchema.parse(this.engine.state().manifest!.webReplay);
  }
  control(id: string, raw: WebAction) {
    const action = webActionSchema.parse(raw);
    const command =
      action.type === "freeze" || action.type === "protect"
        ? { type: "pause" as const }
        : action;
    const input = {
      command,
      webRequest: hash(action),
      recipeHash: this.recipeHash,
    };
    // UI/HTTP 응답 유실 후 재전송도 시계/진입 의도를 다시 변경하지 않는다.
    const receipt = `web-control-${id}`;
    if (this.engine.repo.commandExists(receipt, input)) return this.view();
    const checkpoint = this.checkpoint();
    if (this.error) throw new Error("WEB_REOPEN_REQUIRED");
    if (
      (action.type === "start" || action.type === "protect") &&
      checkpoint.index >= this.commands.length
    )
      throw new Error("WEB_REPLAY_FINISHED");
    // HTTP 요청 식별자·매매 명령·재생 체크포인트가 한 트랜잭션에서 저장된다.
    this.engine.command(receipt, command, {
      requestHash: hash(action),
      expectedIndex: checkpoint.index,
      next: {
        ...checkpoint,
        entryEnabled: action.type === "start",
        reconciledEpoch:
          action.type === "reconcile"
            ? this.engine.state().epoch
            : checkpoint.reconciledEpoch,
      },
    });
    this.playing =
      action.type === "start" ||
      action.type === "protect" ||
      action.type === "liquidate" ||
      (action.type === "pause" && this.playing);
    return this.view();
  }
  step() {
    if (!this.playing || this.error) return;
    const checkpoint = this.checkpoint();
    if (checkpoint.index >= this.commands.length) {
      this.playing = false;
      return;
    }
    let command = this.commands[checkpoint.index]!;
    const state = this.engine.state();
    // 시나리오의 예정 재개는 사용자의 신규 진입 허용 의도를 넘지 못한다.
    if (
      (command.type === "start" || command.type === "reconcile") &&
      (!checkpoint.entryEnabled ||
        state.fault ||
        state.ledger.halts.length ||
        state.status === "RECONCILING")
    )
      command = { type: "pause" };
    this.engine.command(
      `web-step-${checkpoint.index}`,
      portfolioCommandSchema.parse(command),
      {
        expectedIndex: checkpoint.index,
        next: { ...checkpoint, index: checkpoint.index + 1 },
      },
    );
    if (checkpoint.index + 1 === this.commands.length) this.playing = false;
  }
  heartbeat() {
    this.engine.repo.heartbeat();
  }
  fail() {
    this.playing = false;
    this.error = "WEB_RUN_BLOCKED_REOPEN_REQUIRED";
  }
  view() {
    const s = this.engine.state(),
      checkpoint = this.checkpoint();
    const positions = s.positions.filter((p) => p.quantity > 0),
      pending = s.orders.filter((o) => !terminal(o));
    const latestTick = this.commands
      .slice(0, checkpoint.index)
      .findLast((c) => c.type === "tick");
    return {
      revision: s.revision,
      status: s.status,
      clock: s.clock,
      epoch: s.epoch,
      playing: this.playing,
      error: this.error,
      finished: checkpoint.index === this.commands.length,
      recoveryRequired: checkpoint.reconciledEpoch !== s.epoch,
      step: checkpoint.index,
      totalSteps: this.commands.length,
      entryEnabled: checkpoint.entryEnabled,
      config: s.config!,
      runHash: this.program.runHash,
      recipeHash: this.recipeHash,
      equity: equity(s).toString(),
      pnl: equity(s).minus(s.config!.capital).toString(),
      wallets: s.ledger.wallets,
      available: {
        KRW: availableCash(s, "KRW").toString(),
        USD: availableCash(s, "USD").toString(),
      },
      fx: s.ledger.fx,
      halts: s.ledger.halts,
      fault: s.fault,
      fees: sum(s.ledger.costs.map((c) => c.amount)).toString(),
      reservedRisk: sum(pending.map((o) => o.reservationRisk)).toString(),
      caps: caps(s),
      openRisk: openRisk(s).toString(),
      remainingRisk: remainingRisk(s),
      positions: s.positions,
      orders: s.orders,
      decisions: s.decisions,
      notices: s.notices,
      exposureCount: positions.length,
      pendingCount: pending.length,
      assets: this.program.assets().map(({ key, asset }) => ({
        key,
        symbol: asset.identity.symbol,
        market: asset.identity.market,
        currency: asset.identity.currency,
        quote:
          latestTick?.type === "tick"
            ? (latestTick.quotes.find((q) => q.catalogKey === key)?.quote ??
              null)
            : null,
      })),
      auditCount: Number(
        (
          this.engine.repo.db
            .prepare("SELECT COUNT(*) AS n FROM audit")
            .get() as { n: number }
        ).n,
      ),
    };
  }
  close() {
    this.playing = false;
    try {
      const c = this.checkpoint();
      this.engine.command(
        `web-close-${randomUUID()}`,
        { type: "pause" },
        { expectedIndex: c.index, next: { ...c, entryEnabled: false } },
      );
    } finally {
      this.engine.close();
    }
  }
}
export type PortfolioWebView = ReturnType<PortfolioWebRun["view"]>;
