import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { hash } from "../core/policy.js";
import {
  costWebControlSchema,
  type CostWebControl,
} from "../core/cost-web-schema.js";
import type { ReservationState } from "../core/cost-reservation.js";
import type { OperatingCloseRequest } from "../core/cost-operating-close.js";
import type { OperatingEvidence } from "../core/cost-operating-evidence.js";
import { CostLoopRuntime } from "./cost-loop-runtime.js";
import { CostReservationStore } from "./cost-reservation-store.js";
import {
  Repository,
  writerLeaseDiagnostic,
  type WriterLeaseDiagnostic,
} from "./repository.js";
import {
  costAppProgram,
  costAppRecipe,
  makeCostAppFixture,
  type CostAppFixture,
} from "./cost-app-fixture.js";
import {
  readCostAppPinned,
  readCostAppText,
  saveCostAppJson,
  saveCostAppText,
} from "./cost-app-files.js";
import {
  costLearningInputKind,
  createCostLearningInput,
  type CostLearningInputAnchor,
} from "./cost-learning-input.js";

interface CloseIntent {
  commandId: string;
  closeId: string;
  request: OperatingCloseRequest;
  expected: ReservationState;
  epoch: number;
}
export interface CostAppCapture {
  snapshotId: string;
  inputHash: string;
  exportHash: string;
  financialBasisHash: string;
  checkpointHash: string;
}
const sha = z.string().regex(/^[a-f0-9]{64}$/);

// One explicitly synthetic schedule on the existing V4 Store. No financial
// arithmetic, external input, DB migration or S10 replay runs in this adapter.
export class CostAppRun {
  readonly repo: Repository;
  readonly store: CostReservationStore;
  readonly runtime: CostLoopRuntime;
  readonly fixture: CostAppFixture;
  readonly recoveryRequired: boolean;
  private logicalAt: number;
  private cursor = 0;
  private feed = true;
  private controlRevision = 0;
  private error: string | null = null;
  private writerFailure: WriterLeaseDiagnostic | null = null;
  private timerCallback: (() => void) | null = null;
  private evidence: OperatingEvidence;
  private loop: NonNullable<ReservationState["loop"]>;
  private capture: CostAppCapture | null = null;
  private closeIntentStatus:
    "NONE" | "UNCOMMITTED_INSPECTION_ONLY" | "COMMITTED" = "NONE";
  constructor(
    private readonly directory: string,
    create: boolean,
  ) {
    const path = resolve(directory, "cost.sqlite");
    for (const p of [path, path + "-wal", path + "-shm"])
      if (existsSync(p) && lstatSync(p).isSymbolicLink())
        throw Error("COST_WEB_LINK_DENIED");
    if (create === existsSync(path)) throw Error("COST_WEB_DATABASE_STATE");
    if (create) {
      this.fixture = makeCostAppFixture();
      saveCostAppJson(directory, "fixture.json", this.fixture);
      saveCostAppJson(directory, "fixture-pin.json", {
        fixtureHash: hash(this.fixture),
      });
    } else {
      const pin = z
        .strictObject({ fixtureHash: sha })
        .parse(
          JSON.parse(readCostAppText(directory, "fixture-pin.json", 1024)),
        );
      this.fixture = readCostAppPinned<CostAppFixture>(
        directory,
        "fixture.json",
        pin.fixtureHash,
      );
    }
    const f = this.fixture;
    if (
      f.recipe !== costAppRecipe ||
      f.completeness.scheduleHash !== hash(f.schedule) ||
      !f.completeness.noOtherFinancialEvents ||
      f.schedule.length !== 13 ||
      f.completeness.periodStart !== f.config.operating.periodStart ||
      f.completeness.periodEnd !== f.config.operating.periodEnd
    )
      throw Error("COST_APP_FIXTURE_INVALID");
    const program = costAppProgram(f.sources);
    const adapter = program.operatingLoop({
      finalization: true,
      historyAdmission: true,
    });
    if (hash(adapter.config()) !== hash(f.config))
      throw Error("COST_APP_CONFIG_MISMATCH");
    this.logicalAt = f.config.seed.clock;
    this.recoveryRequired = !create;
    this.repo = new Repository(path);
    try {
      this.repo.acquire();
      this.store = new CostReservationStore(this.repo, f.config, {
        initialize: create,
      });
      if (create) {
        this.store.reserve(
          "app-reserve",
          adapter.prepareEntry(this.store, f.history),
        );
        this.store.handoff(
          "app-handoff",
          this.store.prepareHandoff(
            adapter.reservationId,
            "CONFIRMED",
            f.history,
          ),
        );
        this.repo.writerTransaction(() =>
          this.repo.db.exec(
            "CREATE TABLE cost_web_controls(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,input_hash TEXT NOT NULL)",
          ),
        );
      }
      this.controlRevision = Number(
        this.repo.db
          .prepare("SELECT COUNT(*) AS n FROM cost_web_controls")
          .get()!.n,
      );
      const state = this.store.read();
      this.loop = state.loop!;
      this.evidence = this.store.exportOperatingEvidence();
      this.verifySchedulePrefix();
      this.logicalAt = this.evidence.asOf;
      this.runtime = new CostLoopRuntime(this.store, {
        clock: {
          wallNow: () => this.logicalAt,
          monotonicNow: () => this.logicalAt - f.config.seed.clock,
        },
        // Explicit logical clock: one authored event per worker turn. This is
        // not a wall-clock latency benchmark or the V3 live elapsed-time mode.
        timer: {
          schedule: (_delay, callback) => {
            this.timerCallback = callback;
            return () => {
              if (this.timerCallback === callback) this.timerCallback = null;
            };
          },
        },
      });
      this.inspectCloseIntent();
      if (existsSync(resolve(directory, "snapshot.json"))) {
        this.capture = z
          .strictObject({
            snapshotId: sha,
            inputHash: sha,
            exportHash: sha,
            financialBasisHash: sha,
            checkpointHash: sha,
          })
          .parse(JSON.parse(readCostAppText(directory, "snapshot.json", 2048)));
        if (
          this.capture.snapshotId !==
            hash({
              input: this.capture.inputHash,
              financial: this.capture.exportHash,
            }) ||
          this.capture.exportHash !== this.evidence.exportHash ||
          this.capture.financialBasisHash !==
            this.evidence.report.financialBasisHash ||
          this.capture.checkpointHash !==
            this.evidence.report.financialEvidence.finalization.checkpointHash
        )
          throw Error("COST_APP_SNAPSHOT_MISMATCH");
        // Source files are checked here; S10 full verification remains a
        // separate explicit job on reopening, never an implicit model action.
        this.verificationInput();
      }
    } catch (e) {
      this.repo.close();
      throw e;
    }
  }
  private verifySchedulePrefix() {
    const records = this.evidence.records;
    if (records[0]?.id !== "app-reserve" || records[1]?.id !== "app-handoff")
      throw Error("COST_APP_PREFIX_INVALID");
    let count = 0;
    for (const r of records.slice(2)) {
      if (r.input.command.kind === "FINALIZE_OPERATING") continue;
      // Feed-loss pulses are intentionally outside the normal authored path.
      if (r.input.command.kind === "COST_LOOP_PULSE") continue;
      const event = this.fixture.schedule[count];
      if (
        !event ||
        r.id !== event.id ||
        hash(r.input.command) !== hash(this.eventCommand(event))
      )
        throw Error("COST_APP_SCHEDULE_MISMATCH");
      count++;
    }
    this.cursor = count;
  }
  private eventCommand(event: CostAppFixture["schedule"][number]) {
    const at = this.fixture.config.seed.clock + event.offset;
    if (event.kind === "QUOTE")
      return {
        kind: "COST_LOOP_TICK" as const,
        purpose: "TEST_ONLY" as const,
        instrument: "REPLAY-KR-B",
        at,
        quote: {
          at,
          bid: event.price!,
          ask: event.price!,
          bidSize: 1000,
          askSize: 1000,
          halted: false,
        },
      };
    const base = {
      eventId: event.id,
      sequence: event.kind === "RECOGNIZE" ? 1 : 2,
      occurredAt: at,
      availableAt: at,
      kind: event.kind,
      obligationId: "app-expense-obligation",
      amountKrw: "50",
    };
    const operating =
      event.kind === "RECOGNIZE"
        ? { ...base, kind: "RECOGNIZE" as const, reservationId: null }
        : { ...base, kind: "PAY" as const };
    return {
      kind: "OPERATING" as const,
      event: operating,
      rawJson: JSON.stringify(operating),
    };
  }
  private project(state: ReservationState) {
    const evidence = this.store.exportOperatingEvidence();
    if (hash(state) !== evidence.report.source.stateHash)
      throw Error("COST_APP_SNAPSHOT_RACE");
    this.evidence = evidence;
    this.loop = state.loop!;
  }
  private inspectCloseIntent() {
    if (!existsSync(resolve(this.directory, "close-intent.json"))) {
      if (
        this.evidence.records.some(
          (r) => r.input.command.kind === "FINALIZE_OPERATING",
        )
      )
        throw Error("COST_APP_CLOSE_INTENT_MISSING");
      return;
    }
    const saved = JSON.parse(
      readCostAppText(this.directory, "close-intent.json"),
    ) as { intent: CloseIntent; intentHash: string };
    if (hash(saved.intent) !== saved.intentHash)
      throw Error("COST_APP_CLOSE_INTENT_INVALID");
    const r = this.evidence.records.find(
      (r) => r.id === saved.intent.commandId,
    );
    if (!r) {
      this.closeIntentStatus = "UNCOMMITTED_INSPECTION_ONLY";
      return;
    }
    const c = r.input.command;
    if (
      c.kind !== "FINALIZE_OPERATING" ||
      c.closeId !== saved.intent.closeId ||
      hash(c.request) !== hash(saved.intent.request) ||
      r.input.expectedRevision !== saved.intent.expected.revision ||
      r.input.expectedStateHash !== hash(saved.intent.expected) ||
      r.input.epoch !== saved.intent.epoch
    )
      throw Error("COST_APP_CLOSE_INTENT_MISMATCH");
    this.closeIntentStatus = "COMMITTED";
  }
  view() {
    const report = this.evidence.report;
    const settled =
      report.financialEvidence.trades.length > 0 &&
      report.financialEvidence.trades.every(
        (t) =>
          t.quantity === 0 &&
          t.historicalPostings.every((p) => p.settledAt !== null) &&
          t.orders.every((o) => ["FILLED", "CANCELLED"].includes(o.status)),
      );
    return {
      recipe: costAppRecipe,
      runtime: this.runtime.status(),
      error: this.error,
      writerFailure: this.writerFailure,
      recoveryRequired: this.recoveryRequired,
      controlRevision: this.controlRevision,
      feedEnabled: this.feed,
      // A finalized synthetic input never opens the old new-run/HOLD gate.
      safeToLeave: false,
      finished: report.financialEvidence.finalization.status === "FINALIZED",
      settled,
      cursor: this.cursor,
      eventCount: this.fixture.schedule.length,
      logicalAt: this.logicalAt,
      clockMode: "FIXED_SYNTHETIC_EVENT_CLOCK" as const,
      report,
      loop: this.loop,
      closeIntentStatus: this.closeIntentStatus,
      capture: this.capture,
    };
  }
  control(raw: CostWebControl) {
    const c = costWebControlSchema.parse(raw),
      inputHash = hash(c);
    const prior = this.repo.db
      .prepare("SELECT input_hash FROM cost_web_controls WHERE id=?")
      .get(c.id);
    if (prior) {
      if (prior.input_hash !== inputHash) throw Error("COMMAND_ID_CONFLICT");
      return this.view();
    }
    if (c.expectedControl !== this.controlRevision)
      throw Error("COST_WEB_CONTROL_STALE");
    if (
      this.controlRevision >= 100 ||
      (this.controlRevision >= 99 && c.action !== "STOP")
    )
      throw Error("COST_WEB_CONTROL_LIMIT");
    if (this.recoveryRequired) throw Error("COST_WEB_RECOVERY_INSPECTION_ONLY");
    if (this.error || this.runtime.status().phase === "FAULT")
      throw Error("COST_WEB_FAULT_REVIEW_REQUIRED");
    if (
      c.action === "START" &&
      (this.view().finished || this.runtime.status().phase === "RUNNING")
    )
      throw Error("COST_WEB_START_BLOCKED");
    try {
      this.repo.writerTransaction(() =>
        this.repo.db
          .prepare("INSERT INTO cost_web_controls VALUES(?,?,?)")
          .run(this.controlRevision + 1, c.id, inputHash),
      );
      this.controlRevision++;
      if (c.action === "START") this.runtime.start();
      else if (c.action === "STOP") this.runtime.stop();
      else this.feed = c.action === "FEED_ON";
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
      if (this.recoveryRequired || this.runtime.status().phase !== "RUNNING")
        return;
      if (!this.feed) {
        this.logicalAt += 1000;
        this.timerCallback?.();
        this.project(this.store.read());
        return;
      }
      const event = this.fixture.schedule[this.cursor];
      if (!event) {
        this.finalize();
        return;
      }
      const at = this.fixture.config.seed.clock + event.offset;
      if (at < this.logicalAt) throw Error("COST_APP_SCHEDULE_TIME_PASSED");
      this.logicalAt = at;
      const command = this.eventCommand(event);
      const result =
        command.kind === "COST_LOOP_TICK"
          ? this.runtime.quote(event.id, command)
          : this.store.operating(event.id, command.event, this.store.read());
      this.cursor++;
      this.project(result.current);
    } catch (e) {
      this.fail(e);
    }
  }
  private finalize() {
    this.runtime.stop();
    this.verifySchedulePrefix();
    if (
      this.cursor !== this.fixture.schedule.length ||
      !this.view().settled ||
      // These existing entry/allocation HOLDs are expected after recognizing
      // current costs. D8 may close the complete financial period but never
      // removes those holds or grants another entry. Other faults still block.
      this.loop.holds.some(
        (h) =>
          ![
            "OPERATING_ADMISSION_INTEGRATION_PENDING",
            "OPERATING_ALLOCATION_NOT_FINAL",
          ].includes(h),
      ) ||
      this.evidence.records.some(
        (r) => r.input.command.kind === "COST_LOOP_PULSE",
      )
    )
      throw Error("COST_APP_PERIOD_INCOMPLETE");
    const expected = this.store.read(),
      f = this.fixture;
    const request: OperatingCloseRequest = {
      schemaVersion: "OPERATING_CLOSE_FIXTURE_REQUEST_V1",
      purpose: "TEST_ONLY",
      provenance: "SYNTHETIC_FIXTURE",
      asOf: f.completeness.periodEnd,
      manifest: {
        configHash: hash(f.config),
        stateHash: hash(expected),
        recordsHash: hash(this.evidence.records),
        recordCount: this.evidence.records.length,
        periodStart: f.completeness.periodStart,
        periodEnd: f.completeness.periodEnd,
        coverage: f.completeness.coverage,
        finalizedAt: f.completeness.periodEnd,
        availableAt: f.completeness.periodEnd,
      },
    };
    const intent: CloseIntent = {
      commandId: "app-close",
      closeId: "app-period",
      request,
      expected,
      epoch: this.repo.epoch,
    };
    saveCostAppJson(this.directory, "close-intent.json", {
      intent,
      intentHash: hash(intent),
    });
    this.closeIntentStatus = "UNCOMMITTED_INSPECTION_ONLY";
    const result = this.store.finalizeOperating(
      intent.commandId,
      intent.closeId,
      request,
      expected,
    );
    this.logicalAt = f.completeness.periodEnd;
    this.project(result.current);
    this.inspectCloseIntent();
    const financial = this.evidence;
    const encoded = createCostLearningInput({
      kind: costLearningInputKind,
      purpose: "TEST_ONLY",
      asOf: financial.asOf,
      ...f.sources,
      operatingEvidenceText: JSON.stringify(financial),
    });
    const anchor: CostLearningInputAnchor = {
      inputHash: encoded.inputHash,
      operating: { config: f.config, exportHash: financial.exportHash },
    };
    const capture: CostAppCapture = {
      snapshotId: hash({
        input: encoded.inputHash,
        financial: financial.exportHash,
      }),
      inputHash: encoded.inputHash,
      exportHash: financial.exportHash,
      financialBasisHash: financial.report.financialBasisHash,
      checkpointHash:
        financial.report.financialEvidence.finalization.checkpointHash!,
    };
    saveCostAppJson(this.directory, "financial.json", financial);
    saveCostAppText(this.directory, "learning-input.json", encoded.text);
    saveCostAppJson(this.directory, "anchor.json", anchor);
    // Publish only after every immutable artifact has been flushed.
    saveCostAppJson(this.directory, "snapshot.json", capture);
    this.capture = capture;
  }
  verificationInput() {
    if (!this.capture) throw Error("COST_APP_CAPTURE_NOT_READY");
    const text = readCostAppText(this.directory, "learning-input.json");
    const anchor = JSON.parse(
      readCostAppText(this.directory, "anchor.json"),
    ) as CostLearningInputAnchor;
    const financial = readCostAppPinned<OperatingEvidence>(
      this.directory,
      "financial.json",
      hash(this.evidence),
    );
    if (
      hash(JSON.parse(text)) !== this.capture.inputHash ||
      anchor.inputHash !== this.capture.inputHash ||
      anchor.operating.exportHash !== financial.exportHash ||
      hash(anchor.operating.config) !== hash(this.fixture.config)
    )
      throw Error("COST_APP_PIN_MISMATCH");
    return { text, anchor };
  }
  fail(e: unknown) {
    this.runtime?.stop();
    this.writerFailure = writerLeaseDiagnostic(e);
    this.error =
      e instanceof Error && /^[A-Z_0-9]+$/.test(e.message)
        ? e.message
        : "COST_APP_RUN_FAILURE";
  }
  close() {
    this.runtime.stop();
    this.repo.close();
  }
}
export type CostAppView = ReturnType<CostAppRun["view"]>;
