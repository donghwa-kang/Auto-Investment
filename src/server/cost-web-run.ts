import { performance } from "node:perf_hooks";
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { hash } from "../core/policy.js";
import {
  costWebControlSchema,
  type CostWebControl,
} from "../core/cost-web-schema.js";
import { buildCostOutcomeReport } from "../core/cost-outcome-report.js";
import { CostLoopRuntime } from "./cost-loop-runtime.js";
import { CostReservationStore } from "./cost-reservation-store.js";
import {
  Repository,
  writerLeaseDiagnostic,
  type WriterLeaseDiagnostic,
} from "./repository.js";
import type { CostSignalProgram } from "./cost-signal-bridge.js";

export class CostWebRun {
  readonly repo: Repository;
  readonly store: CostReservationStore;
  readonly runtime: CostLoopRuntime;
  readonly recoveryRequired: boolean;
  private anchor: number | null = null;
  private sampled: number;
  private elapsed = 0;
  private nextQuote = 1000;
  private feed = true;
  private error: string | null = null;
  private writerFailure: WriterLeaseDiagnostic | null = null;
  private controlRevision = 0;
  private readonly configHash: string;
  private snapshot;
  constructor(
    directory: string,
    program: CostSignalProgram,
    create: boolean,
    private readonly changed: () => void = () => {},
    private readonly now = () => performance.now(),
  ) {
    const path = resolve(directory, "cost.sqlite");
    for (const name of [path, path + "-wal", path + "-shm"])
      if (existsSync(name) && lstatSync(name).isSymbolicLink())
        throw Error("COST_WEB_LINK_DENIED");
    if (create === existsSync(path)) throw Error("COST_WEB_DATABASE_STATE");
    this.repo = new Repository(path);
    this.recoveryRequired = !create;
    const config = program.config();
    this.configHash = hash(config);
    this.sampled = config.seed.clock;
    try {
      this.repo.acquire();
      this.store = new CostReservationStore(this.repo, config, {
        initialize: create,
      });
      if (create) {
        this.store.reserve("web-reserve", program.prepareEntry(this.store));
        this.store.handoff(
          "web-handoff",
          this.store.prepareHandoff(program.reservationId, "CONFIRMED"),
        );
        this.repo.writerTransaction(() =>
          this.repo.db.exec(
            "CREATE TABLE cost_web_controls(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, input_hash TEXT NOT NULL)",
          ),
        );
      }
      this.controlRevision = Number(
        (
          this.repo.db
            .prepare("SELECT COUNT(*) AS n FROM cost_web_controls")
            .get() as { n: number }
        ).n,
      );
      this.snapshot = this.project();
      this.runtime = new CostLoopRuntime(this.store, {
        clock: {
          wallNow: () => this.sampled,
          monotonicNow: () => this.elapsed,
        },
        timer: {
          schedule: (delay, callback) => {
            const timer = setTimeout(() => {
              try {
                this.sample();
                const before = this.runtime.status().pulses;
                callback();
                if (this.runtime.status().pulses !== before)
                  this.snapshot = this.project();
                this.changed();
              } catch (e) {
                this.fail(e);
              }
            }, delay);
            return () => clearTimeout(timer);
          },
        },
      });
    } catch (e) {
      this.repo.close();
      throw e;
    }
  }
  private sample() {
    if (this.anchor === null) return;
    const elapsed = Math.floor(this.now() - this.anchor);
    if (!Number.isSafeInteger(elapsed) || elapsed < this.elapsed)
      throw Error("COST_WEB_CLOCK_REGRESSION");
    this.sampled += elapsed - this.elapsed;
    this.elapsed = elapsed;
  }
  private project(state = this.store.read()) {
    return {
      report: buildCostOutcomeReport(state, this.configHash),
      loop: state.loop!,
    };
  }
  view() {
    const { report, loop } = this.snapshot;
    const trades = report.financialEvidence.trades;
    const finished = trades.every(
      (t) =>
        t.quantity === 0 &&
        t.unsettledFillCount === 0 &&
        t.orders.every((o) => ["FILLED", "CANCELLED"].includes(o.status)),
    );
    const safeToLeave =
      !this.error &&
      this.runtime.status().phase !== "FAULT" &&
      loop.holds.length === 0 &&
      report.financialEvidence.admissionHolds.length === 0 &&
      finished;
    return {
      runtime: this.runtime.status(),
      error: this.error,
      writerFailure: this.writerFailure,
      recoveryRequired: this.recoveryRequired,
      controlRevision: this.controlRevision,
      feedEnabled: this.feed,
      safeToLeave,
      finished,
      report,
      loop,
    };
  }
  control(raw: CostWebControl) {
    const command = costWebControlSchema.parse(raw),
      inputHash = hash(command);
    const prior = this.repo.db
      .prepare("SELECT input_hash FROM cost_web_controls WHERE id=?")
      .get(command.id) as { input_hash: string } | undefined;
    if (prior) {
      if (prior.input_hash !== inputHash) throw Error("COMMAND_ID_CONFLICT");
      return this.view(); // A late retry must never restart a stopped runner.
    }
    if (command.expectedControl !== this.controlRevision)
      throw Error("COST_WEB_CONTROL_STALE");
    if (
      this.controlRevision >= 100 ||
      (this.controlRevision >= 99 && command.action !== "STOP")
    )
      throw Error("COST_WEB_CONTROL_LIMIT");
    if (this.recoveryRequired) throw Error("COST_WEB_RECOVERY_INSPECTION_ONLY");
    if (this.error || this.runtime.status().phase === "FAULT")
      throw Error("COST_WEB_FAULT_REVIEW_REQUIRED");
    if (
      command.action === "START" &&
      (this.runtime.status().phase === "RUNNING" || this.view().finished)
    )
      throw Error("COST_WEB_START_BLOCKED");
    // Persist the control intent before changing memory/timers. A cold restart
    // is inspection-only: an ambiguous intent is never automatically replayed.
    try {
      this.repo.writerTransaction(() =>
        this.repo.db
          .prepare("INSERT INTO cost_web_controls VALUES(?,?,?)")
          .run(this.controlRevision + 1, command.id, inputHash),
      );
      this.controlRevision++;
      if (command.action === "STOP") this.runtime.stop();
      else if (command.action === "START") {
        this.anchor ??= this.now();
        this.sample();
        this.runtime.start();
      } else this.feed = command.action === "FEED_ON";
      this.snapshot = this.project();
    } catch (e) {
      this.fail(e);
      throw e;
    }
    return this.view();
  }
  step() {
    if (this.error || this.runtime.status().phase === "FAULT") return;
    try {
      this.repo.heartbeat();
      if (this.runtime.status().phase !== "RUNNING") return;
      this.sample();
      if (!this.feed || this.elapsed < this.nextQuote) return;
      if (this.snapshot.loop.ticks >= 32) throw Error("COST_WEB_SAMPLE_LIMIT");
      // Synthetic observations are generated NOW, never backdated catch-up.
      // One quote per wakeup; a delayed callback must remain visibly delayed.
      this.nextQuote = this.elapsed + 1000;
      const tick = this.snapshot.loop.ticks,
        price = tick < 4 ? "21400" : "22000";
      const committed = this.runtime.quote(`web-quote-${tick}`, {
        kind: "COST_LOOP_TICK",
        purpose: "TEST_ONLY",
        instrument: "REPLAY-KR-B",
        at: this.sampled,
        quote: {
          at: this.sampled,
          bid: tick < 4 ? "21399" : price,
          ask: price,
          bidSize: 1000,
          askSize: 1000,
          halted: false,
        },
      });
      // The writer has already replayed, checked CAS/lease and committed this
      // detached state. Project that same commit, not a second full DB replay.
      this.snapshot = this.project(committed.current);
      if (this.view().finished) this.runtime.stop();
    } catch (e) {
      this.fail(e);
    }
  }
  fail(e: unknown) {
    this.runtime?.stop();
    this.writerFailure = writerLeaseDiagnostic(e);
    this.error =
      e instanceof Error && /^[A-Z_0-9]+$/.test(e.message)
        ? e.message
        : "COST_WEB_STORAGE_OR_RUN_FAILURE";
    // Keep the last verified snapshot, explicitly marked as stale by error.
    this.changed();
  }
  close() {
    this.runtime.stop();
    this.repo.close();
  }
}
export type CostWebView = ReturnType<CostWebRun["view"]>;
