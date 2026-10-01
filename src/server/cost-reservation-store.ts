import { z } from "zod";
import { hash, verifyPolicies } from "../core/policy.js";
import { costJournalConfigSchema } from "../core/cost-journal.js";
import {
  initialReservations,
  applyReservationCommand,
  evaluateLocalProposal,
  reservationCommandSchema,
  reservationExposure,
  reservationKind,
} from "../core/cost-reservation.js";
import type {
  ReservationConfig,
  ReservationState,
  ReservationCommand,
} from "../core/cost-reservation.js";
import { Repository } from "./repository.js";
import { quiesceCostLoopRuntime } from "./cost-loop-runtime.js";
import {
  initialHandoff,
  applyHandoffCommand,
  handoffCommandSchema,
  handoffCommandLimit,
  handoffExposure,
  evaluateHandoff,
  fillIndex,
  duplicateHandoffFill,
  extendedHandoffCommandSchema,
} from "../core/cost-handoff.js";
import type {
  HandoffConfig,
  ExtendedHandoffCommand,
} from "../core/cost-handoff.js";
import {
  operatingKind,
  operatingEventSchema,
  operatingRawSchema,
  operatingEventLimit,
  duplicateOperatingEvent,
} from "../core/cost-operating.js";
import type {
  OperatingConfig,
  OperatingEvent,
} from "../core/cost-operating.js";
import type { OutcomeConfig } from "../core/cost-outcome.js";
import type { CostJournalEvent } from "../core/cost-journal.js";
import { buildCostOutcomeReport } from "../core/cost-outcome-report.js";
import {
  costLoopTickSchema,
  costLoopPulseSchema,
} from "../core/cost-loop-schema.js";
import { buildCostOutcomeExport } from "../core/cost-outcome-export.js";
import { projectOperatingClose } from "../core/cost-operating-close.js";
import { outcomeKind } from "../core/cost-reservation.js";
import {
  finalizationCommandSchema,
  finalizationExtraSlots,
  postCloseInputLimit,
} from "../core/cost-finalization.js";
import type { FinalizationCommand } from "../core/cost-finalization.js";
import {
  postCloseCommandSchema,
  postCloseTargetLimit,
  isPostCloseCommand,
  applyPostClose,
  duplicatePostClose,
  postCloseIdentity,
  postCloseReport,
} from "../core/cost-post-close.js";
import type { PostCloseCommand } from "../core/cost-post-close.js";
import {
  partialSettlementCommandSchema,
  partialSettlementEventLimit,
  isPartialSettlementCommand,
  applyPartialSettlement,
  duplicatePartialSettlement,
  partialSettlementReport,
} from "../core/cost-partial-settlement.js";
import type { PartialSettlementCommand } from "../core/cost-partial-settlement.js";
import {
  initialOperatingReplay,
  applyOperatingReplay,
} from "../core/cost-operating-replay.js";
import { buildOperatingReport } from "../core/cost-operating-report.js";
import {
  buildOperatingEvidence,
  checkOperatingEvidenceConfig,
} from "../core/cost-operating-evidence.js";

const idSchema = costJournalConfigSchema.shape.runId;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(
        handoffCommandLimit +
          operatingEventLimit +
          finalizationExtraSlots +
          partialSettlementEventLimit,
      ),
    expectedStateHash: sha,
    epoch: z.number().int().safe().min(1),
    command: z.union([
      extendedHandoffCommandSchema,
      finalizationCommandSchema,
      postCloseCommandSchema,
      partialSettlementCommandSchema,
    ]),
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
export type ReservationWriteStage =
  "COMMAND" | "APPROVALS" | "FILL_INDEX" | "STATE" | "AUDIT";
export interface PreparedHandoff {
  kind: "PREPARED_SYNTHETIC_HANDOFF_V2";
  runHash: string;
  input: Input;
  orderSubmissionAllowed: false;
  learningAllowed: false;
  liveEnabled: false;
}
export interface PreparedLocalApproval {
  kind: "PREPARED_LOCAL_COST_APPROVAL_V1";
  runHash: string;
  input: Input;
  candidate: ReturnType<typeof evaluateLocalProposal>["candidate"];
  orderSubmissionAllowed: false;
  learningAllowed: false;
  liveEnabled: false;
}
interface Receipt {
  revision: number;
  stateHash: string;
}
interface RecordRow {
  id: string;
  input: Input;
  receipt: Receipt;
}

// Same Repository connection/lease/audit. No opening of a second money DB,
// network submission, or migration of a legacy/B account.
export class CostReservationStore {
  readonly #config:
    ReservationConfig | HandoffConfig | OutcomeConfig | OperatingConfig;
  readonly #issued = new WeakMap<
    PreparedLocalApproval | PreparedHandoff,
    string
  >();
  constructor(
    private readonly repo: Repository,
    config: ReservationConfig | HandoffConfig | OutcomeConfig | OperatingConfig,
    private readonly options: {
      initialize?: boolean;
      testStage?: (stage: ReservationWriteStage) => void;
    } = {},
  ) {
    verifyPolicies();
    this.#config = structuredClone(config);
    if (options.initialize)
      repo.writerTransaction(() => {
        if (
          repo.db
            .prepare(
              "SELECT 1 FROM aggregate UNION ALL SELECT 1 FROM commands UNION ALL SELECT 1 FROM audit LIMIT 1",
            )
            .get() ||
          repo.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('writer','aggregate','commands','audit','sqlite_sequence') LIMIT 1",
            )
            .get()
        )
          throw Error("LOCAL_RESERVATION_REQUIRES_EMPTY_REPOSITORY");
        const s = this.initial(repo.epoch);
        repo.db.exec(`
        CREATE TABLE cost_reservation_run(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, config_hash TEXT NOT NULL, initial_epoch INTEGER NOT NULL, body TEXT NOT NULL, checksum TEXT NOT NULL);
        CREATE TABLE cost_reservation_commands(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, body TEXT NOT NULL, receipt TEXT NOT NULL, receipt_hash TEXT NOT NULL);
        CREATE TABLE cost_reservation_approvals(id TEXT PRIMARY KEY, body TEXT NOT NULL, checksum TEXT NOT NULL);
      `);
        if (this.#config.kind !== reservationKind)
          repo.db.exec(
            "CREATE TABLE cost_reservation_fills(fill_key TEXT PRIMARY KEY, identity_hash TEXT NOT NULL, run_id TEXT NOT NULL, fill_id TEXT NOT NULL)",
          );
        this.syncFills(s);
        repo.db
          .prepare("INSERT INTO cost_reservation_run VALUES(1,?,?,?,?,?)")
          .run(
            JSON.stringify(this.#config),
            hash(this.#config),
            repo.epoch,
            JSON.stringify(s),
            hash(s),
          );
        options.testStage?.("STATE");
        this.audit(s, null);
        options.testStage?.("AUDIT");
      });
    this.read();
  }
  private initial(epoch: number) {
    if (
      this.#config.kind !== operatingKind &&
      "historyAdmission" in this.#config
    )
      throw Error("HISTORY_ADMISSION_OPT_IN_REQUIRED");
    if (this.#config.kind === operatingKind)
      return initialOperatingReplay(this.#config, epoch);
    const s =
      this.#config.kind === reservationKind
        ? initialReservations(this.#config, epoch)
        : initialHandoff(this.#config, epoch);
    if ("finalization" in this.#config) {
      throw Error("FINALIZATION_OPERATING_REQUIRED");
    }
    if ("postClose" in this.#config) {
      throw Error("POST_CLOSE_EXPLICIT_D8_REQUIRED");
    }
    if ("partialSettlement" in this.#config) {
      throw Error("PARTIAL_EXCLUSIVE_D8_REQUIRED");
    }
    return s;
  }
  private project(s: ReservationState, epoch = s.epoch) {
    return this.#config.kind !== reservationKind
      ? handoffExposure(s, epoch)
      : reservationExposure(s, epoch);
  }
  private apply(
    s: ReservationState,
    command:
      | ExtendedHandoffCommand
      | FinalizationCommand
      | PostCloseCommand
      | PartialSettlementCommand,
    epoch: number,
    records: readonly RecordRow[] = [],
  ) {
    if (this.#config.kind === operatingKind)
      return applyOperatingReplay(s, this.#config, command, epoch, records);
    if (isPostCloseCommand(command)) return applyPostClose(s, command, epoch);
    if (isPartialSettlementCommand(command))
      return applyPartialSettlement(s, command, epoch);
    if (
      command.kind === "FINALIZE_OPERATING" ||
      command.kind === "POST_CLOSE_INPUT"
    ) {
      throw Error("FINALIZATION_OPERATING_REQUIRED");
    }
    return this.#config.kind !== reservationKind
      ? applyHandoffCommand(s, command, epoch)
      : applyReservationCommand(
          s,
          reservationCommandSchema.parse(command),
          epoch,
        );
  }
  private parseInput(raw: unknown): Input {
    const parsed = inputSchema.parse(raw);
    const partial =
      this.#config.kind === operatingKind && this.#config.partialSettlement;
    if (!partial) {
      z.number()
        .max(
          handoffCommandLimit +
            operatingEventLimit +
            finalizationExtraSlots +
            postCloseTargetLimit,
        )
        .parse(parsed.expectedRevision);
      z.union([
        extendedHandoffCommandSchema,
        finalizationCommandSchema,
        postCloseCommandSchema,
      ]).parse(parsed.command);
    } else if (isPostCloseCommand(parsed.command)) {
      throw Error("PARTIAL_LEGACY_SETTLEMENT_BLOCKED");
    }
    if (
      !partial &&
      (this.#config.kind !== operatingKind || !this.#config.postClose)
    ) {
      z.number()
        .max(handoffCommandLimit + operatingEventLimit + finalizationExtraSlots)
        .parse(parsed.expectedRevision);
      z.union([extendedHandoffCommandSchema, finalizationCommandSchema]).parse(
        parsed.command,
      );
    }
    if (this.#config.kind !== operatingKind || !this.#config.finalization) {
      z.number()
        .max(handoffCommandLimit + operatingEventLimit)
        .parse(parsed.expectedRevision);
      extendedHandoffCommandSchema.parse(parsed.command);
    }
    if (this.#config.kind !== operatingKind) {
      z.number().max(handoffCommandLimit).parse(parsed.expectedRevision);
      handoffCommandSchema.parse(parsed.command);
    }
    if (this.#config.kind === reservationKind) {
      z.number().max(100).parse(parsed.expectedRevision);
      reservationCommandSchema.parse(parsed.command);
    }
    return parsed;
  }
  private syncFills(s: ReservationState) {
    if (s.kind === reservationKind) return;
    for (const f of fillIndex(s))
      this.repo.db
        .prepare("INSERT OR IGNORE INTO cost_reservation_fills VALUES(?,?,?,?)")
        .run(f.key, f.identityHash, f.runId, f.fillId);
  }
  private mode() {
    const names = this.repo.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cost_reservation_%' ORDER BY name",
      )
      .all()
      .map((r) => String(r.name));
    if (
      hash(names) !==
        hash([
          "cost_reservation_approvals",
          "cost_reservation_commands",
          ...(this.#config.kind !== reservationKind
            ? ["cost_reservation_fills"]
            : []),
          "cost_reservation_run",
        ]) ||
      this.repo.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name LIKE 'cost_journal_%'",
        )
        .get() ||
      this.repo.db
        .prepare(
          "SELECT 1 FROM aggregate UNION ALL SELECT 1 FROM commands LIMIT 1",
        )
        .get()
    )
      throw Error("LOCAL_RESERVATION_MODE_CONFLICT");
  }
  private decode(): {
    state: ReservationState;
    records: RecordRow[];
    loopFillReceipts: Map<string, RecordRow>;
  } {
    this.mode();
    const db = this.repo.db;
    const row = db
      .prepare(
        "SELECT config,config_hash,initial_epoch,body,checksum FROM cost_reservation_run WHERE id=1",
      )
      .get();
    if (
      !row ||
      row.config_hash !== hash(JSON.parse(String(row.config))) ||
      row.config_hash !== hash(this.#config)
    )
      throw Error("LOCAL_RESERVATION_CONFIG_MISMATCH");
    let state = this.initial(Number(row.initial_epoch));
    const rows = db
      .prepare(
        "SELECT seq,id,input_hash,body,receipt,receipt_hash FROM cost_reservation_commands ORDER BY seq",
      )
      .all();
    if (
      rows.length >
      (this.#config.kind === operatingKind
        ? handoffCommandLimit +
          operatingEventLimit +
          (this.#config.finalization ? finalizationExtraSlots : 0) +
          (this.#config.postClose ? postCloseTargetLimit : 0) +
          (this.#config.partialSettlement ? partialSettlementEventLimit : 0)
        : this.#config.kind !== reservationKind
          ? handoffCommandLimit
          : 100)
    )
      throw Error("LOCAL_COMMAND_LIMIT");
    const audits = db
      .prepare("SELECT at,kind,body FROM audit ORDER BY seq")
      .all();
    if (this.repo.verifyAudit() !== rows.length + 1)
      throw Error("LOCAL_AUDIT_COUNT");
    const checkAudit = (
      s: ReservationState,
      command: { id: string; input: Input } | null,
      index: number,
    ) => {
      const a = audits[index];
      const body = this.auditBody(s, command);
      if (
        !a ||
        a.kind !== "LOCAL_COST_RESERVATION_TRANSITION" ||
        a.at !== s.seed.clock ||
        hash(JSON.parse(String(a.body))) !== hash(body)
      )
        throw Error("LOCAL_AUDIT_REPLAY_MISMATCH");
    };
    checkAudit(state, null, 0);
    const records: RecordRow[] = [];
    const loopFillReceipts = new Map<string, RecordRow>();
    for (const [i, r] of rows.entries()) {
      const id = idSchema.parse(r.id),
        input = this.parseInput(JSON.parse(String(r.body)));
      if (
        r.seq !== i + 1 ||
        r.input_hash !== hash(input) ||
        input.expectedRevision !== state.revision ||
        input.expectedStateHash !== hash(state) ||
        input.epoch < state.epoch
      )
        throw Error("LOCAL_COMMAND_REPLAY_MISMATCH");
      const sourceOffsets = new Map(
        state.book.sources.map((s) => [s.config.runId, s.events.length]),
      );
      state = this.apply(state, input.command, input.epoch, records);
      const receipt = { revision: state.revision, stateHash: hash(state) };
      if (
        r.receipt_hash !== hash(receipt) ||
        hash(JSON.parse(String(r.receipt))) !== hash(receipt)
      )
        throw Error("LOCAL_RECEIPT_MISMATCH");
      const record = { id, input, receipt };
      records.push(record);
      // Reconstruct ownership from the verified replay, never from a client
      // timestamp or a guessed generated ID. No new persisted format/hash.
      if (input.command.kind === "COST_LOOP_TICK")
        for (const source of state.book.sources)
          for (const e of source.events.slice(
            sourceOffsets.get(source.config.runId) ?? 0,
          ))
            if (e.kind === "FILL")
              loopFillReceipts.set(
                hash({ runId: source.config.runId, fillId: e.fillId }),
                record,
              );
      checkAudit(state, { id, input }, i + 1);
    }
    if (
      hash(JSON.parse(String(row.body))) !== row.checksum ||
      row.checksum !== hash(state)
    )
      throw Error("LOCAL_STATE_REPLAY_MISMATCH");
    const stored = db
      .prepare(
        "SELECT id,body,checksum FROM cost_reservation_approvals ORDER BY id",
      )
      .all();
    const approvals = [...state.approvals].sort((a, b) =>
      a.id.localeCompare(b.id, "en"),
    );
    if (stored.length !== approvals.length) throw Error("LOCAL_APPROVAL_COUNT");
    for (const r of stored) {
      const a = approvals.find((a) => a.id === r.id);
      if (
        !a ||
        r.checksum !== hash(a) ||
        hash(JSON.parse(String(r.body))) !== hash(a)
      )
        throw Error("LOCAL_APPROVAL_REPLAY_MISMATCH");
    }
    if (state.kind !== reservationKind) {
      const fills = db
        .prepare(
          "SELECT fill_key,identity_hash,run_id,fill_id FROM cost_reservation_fills ORDER BY fill_key",
        )
        .all();
      const expected = fillIndex(state).map((f) => ({
        fill_key: f.key,
        identity_hash: f.identityHash,
        run_id: f.runId,
        fill_id: f.fillId,
      }));
      if (hash(fills) !== hash(expected))
        throw Error("HANDOFF_FILL_INDEX_REPLAY_MISMATCH");
    }
    return { state, records, loopFillReceipts };
  }
  read(): ReservationState {
    this.repo.db.exec("BEGIN");
    try {
      const result = this.decode().state;
      this.repo.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.repo.db.exec("ROLLBACK");
      throw e;
    }
  }
  context() {
    return this.project(this.read(), this.repo.epoch);
  }
  report() {
    verifyPolicies();
    // read() verifies one committed snapshot; the detached projection performs
    // no writes, lease renewal, risk reapproval, learning, or external I/O.
    return buildCostOutcomeReport(this.read(), hash(this.#config));
  }
  postCloseReport(asOf: number) {
    return postCloseReport(this.read(), asOf);
  }
  private operatingSnapshot() {
    verifyPolicies();
    if (this.#config.kind !== operatingKind)
      throw Error("OPERATING_REPORT_V4_REQUIRED");
    checkOperatingEvidenceConfig(this.#config);
    this.repo.db.exec("BEGIN");
    try {
      const { state, records } = this.decode();
      const row = this.repo.db
        .prepare("SELECT initial_epoch FROM cost_reservation_run WHERE id=1")
        .get()!;
      const snapshot = {
        config: structuredClone(this.#config),
        initialEpoch: z.number().int().safe().min(1).parse(row.initial_epoch),
        state,
        records,
      };
      this.repo.db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      this.repo.db.exec("ROLLBACK");
      throw error;
    }
  }
  operatingReport(asOf?: number) {
    const s = this.operatingSnapshot();
    return buildOperatingReport(s.config, s.state, s.records, asOf);
  }
  exportOperatingEvidence(asOf?: number) {
    const s = this.operatingSnapshot();
    return buildOperatingEvidence(
      s.config,
      s.initialEpoch,
      s.records,
      s.state,
      asOf,
    );
  }
  partialSettlementReport(asOf: number) {
    return partialSettlementReport(this.read(), asOf);
  }
  operatingClose(rawRequest: unknown) {
    verifyPolicies();
    if (this.#config.kind !== operatingKind)
      throw Error("OPERATING_CLOSE_V4_REQUIRED");
    this.repo.db.exec("BEGIN");
    try {
      // The entire journal and its projections belong to this one read
      // snapshot. No write, epoch acquisition, or automatic finalization.
      const { state, records } = this.decode();
      if (state.finalization?.checkpoint)
        throw Error("FINALIZATION_ALREADY_APPLIED");
      const report = projectOperatingClose(
        this.#config,
        state,
        records,
        rawRequest,
      );
      this.repo.db.exec("COMMIT");
      return report;
    } catch (error) {
      this.repo.db.exec("ROLLBACK");
      throw error;
    }
  }
  exportEvidence() {
    verifyPolicies();
    if (this.#config.kind !== outcomeKind)
      throw Error("COST_EXPORT_V3_REQUIRED");
    this.repo.db.exec("BEGIN");
    try {
      const { state, records } = this.decode();
      const row = this.repo.db
        .prepare("SELECT initial_epoch FROM cost_reservation_run WHERE id=1")
        .get()!;
      const result = buildCostOutcomeExport(
        this.#config,
        Number(row.initial_epoch),
        records.map((r) => ({
          ...r,
          input: {
            ...r.input,
            command: handoffCommandSchema.parse(r.input.command),
          },
        })),
        state,
      );
      this.repo.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.repo.db.exec("ROLLBACK");
      throw error;
    }
  }
  prepare(rawProposal: unknown): PreparedLocalApproval {
    z.number().int().safe().min(1).parse(this.repo.epoch);
    const s = this.read(),
      checked = evaluateLocalProposal(
        s,
        rawProposal,
        this.repo.epoch,
        (state, epoch) => this.project(state, epoch),
      );
    const prepared: PreparedLocalApproval = {
      kind: "PREPARED_LOCAL_COST_APPROVAL_V1",
      runHash: hash(this.#config),
      input: {
        expectedRevision: s.revision,
        expectedStateHash: hash(s),
        epoch: this.repo.epoch,
        command: {
          kind: "RESERVE",
          proposal: checked.proposal,
          basisHash: checked.basisHash,
        },
      },
      candidate: checked.candidate,
      orderSubmissionAllowed: false,
      learningAllowed: false,
      liveEnabled: false,
    };
    this.#issued.set(prepared, hash(prepared));
    return prepared;
  }
  reserve(commandId: string, prepared: PreparedLocalApproval) {
    if (
      prepared.kind !== "PREPARED_LOCAL_COST_APPROVAL_V1" ||
      prepared.runHash !== hash(this.#config) ||
      prepared.input.command.kind !== "RESERVE"
    )
      throw Error("UNISSUED_LOCAL_APPROVAL");
    const issued = this.#issued.get(prepared) === hash(prepared);
    return this.write(commandId, prepared.input, () => {
      if (!issued) throw Error("UNISSUED_LOCAL_APPROVAL");
    });
  }
  prepareHandoff(
    reservationId: string,
    acknowledgement: "CONFIRMED" | "UNKNOWN",
    currentHistory?: unknown,
  ): PreparedHandoff {
    const s = this.read(),
      checked = evaluateHandoff(
        s,
        reservationId,
        acknowledgement,
        this.repo.epoch,
        currentHistory,
      );
    const p: PreparedHandoff = {
      kind: "PREPARED_SYNTHETIC_HANDOFF_V2",
      runHash: hash(this.#config),
      input: {
        expectedRevision: s.revision,
        expectedStateHash: hash(s),
        epoch: this.repo.epoch,
        command: {
          kind: "HANDOFF",
          reservationId,
          acknowledgement,
          basisHash: checked.basisHash,
          ...(checked.operatingHistory
            ? { operatingHistory: checked.operatingHistory }
            : {}),
        },
      },
      orderSubmissionAllowed: false,
      learningAllowed: false,
      liveEnabled: false,
    };
    this.#issued.set(p, hash(p));
    return p;
  }
  handoff(commandId: string, prepared: PreparedHandoff) {
    if (
      prepared.kind !== "PREPARED_SYNTHETIC_HANDOFF_V2" ||
      prepared.runHash !== hash(this.#config) ||
      prepared.input.command.kind !== "HANDOFF"
    )
      throw Error("UNISSUED_HANDOFF");
    const issued = this.#issued.get(prepared) === hash(prepared);
    return this.write(commandId, prepared.input, () => {
      if (!issued) throw Error("UNISSUED_HANDOFF");
    });
  }
  execute(
    commandId: string,
    runId: string,
    event: CostJournalEvent,
    expected: ReservationState,
  ) {
    return this.write(commandId, {
      expectedRevision: expected.revision,
      expectedStateHash: hash(expected),
      epoch: this.repo.epoch,
      command: { kind: "EXECUTION", runId, event },
    });
  }
  tick(commandId: string, raw: unknown) {
    return this.loopCommand(commandId, costLoopTickSchema.parse(raw));
  }
  pulse(commandId: string, raw: unknown) {
    return this.loopCommand(commandId, costLoopPulseSchema.parse(raw));
  }
  heartbeat() {
    this.repo.heartbeat();
  }
  private loopCommand(commandId: string, command: ExtendedHandoffCommand) {
    verifyPolicies();
    // Read verified internal records, not the version-specific public export.
    // Both the command envelope and current state belong to one snapshot.
    this.repo.db.exec("BEGIN");
    let snapshot: ReturnType<CostReservationStore["decode"]>;
    try {
      snapshot = this.decode();
      this.repo.db.exec("COMMIT");
    } catch (error) {
      this.repo.db.exec("ROLLBACK");
      throw error;
    }
    // Reuse the original full envelope, not the new epoch/revision on retry.
    // The private writer still rechecks identity and lease under the DB lock.
    const previous = snapshot.records.find((r) => r.id === commandId);
    if (previous) {
      if (hash(previous.input.command) !== hash(command))
        throw Error("LOCAL_COMMAND_ID_CONFLICT");
      return this.write(commandId, previous.input);
    }
    const s = snapshot.state;
    return this.write(commandId, {
      expectedRevision: s.revision,
      expectedStateHash: hash(s),
      epoch: this.repo.epoch,
      command,
    });
  }
  operating(
    commandId: string,
    event: OperatingEvent,
    expected: ReservationState,
  ) {
    return this.operatingInput(commandId, JSON.stringify(event), expected);
  }
  finalizeOperating(
    commandId: string,
    closeId: string,
    request: unknown,
    expected: ReservationState,
  ) {
    const command = finalizationCommandSchema.parse({
      kind: "FINALIZE_OPERATING",
      closeId,
      request,
    });
    if (
      this.#config.kind === operatingKind &&
      this.#config.operatingLoop?.closeContract
    )
      quiesceCostLoopRuntime(this);
    return this.write(commandId, {
      expectedRevision: expected.revision,
      expectedStateHash: hash(expected),
      epoch: this.repo.epoch,
      command,
    });
  }
  postCloseInput(
    commandId: string,
    rawJson: string,
    observedAt: number,
    expected: ReservationState,
  ) {
    return this.write(commandId, {
      expectedRevision: expected.revision,
      expectedStateHash: hash(expected),
      epoch: this.repo.epoch,
      command: { kind: "POST_CLOSE_INPUT", rawJson, observedAt },
    });
  }
  settlePostClose(
    commandId: string,
    rawCommand: unknown,
    expected: ReservationState,
  ) {
    return this.write(commandId, {
      expectedRevision: expected.revision,
      expectedStateHash: hash(expected),
      epoch: this.repo.epoch,
      command: postCloseCommandSchema.parse(rawCommand),
    });
  }
  settlePartial(
    commandId: string,
    rawCommand: unknown,
    expected: ReservationState,
  ) {
    return this.write(commandId, {
      expectedRevision: expected.revision,
      expectedStateHash: hash(expected),
      epoch: this.repo.epoch,
      command: partialSettlementCommandSchema.parse(rawCommand),
    });
  }
  operatingInput(
    commandId: string,
    rawJson: string,
    expected: ReservationState,
  ) {
    if (this.#config.kind !== operatingKind)
      throw Error("OPERATING_V4_REQUIRED");
    operatingRawSchema.parse(rawJson);
    let raw: unknown;
    try {
      raw = JSON.parse(rawJson);
    } catch {
      raw = null;
    }
    const parsed = operatingEventSchema.safeParse(raw);
    return this.write(commandId, {
      expectedRevision: expected.revision,
      expectedStateHash: hash(expected),
      epoch: this.repo.epoch,
      command: parsed.success
        ? { kind: "OPERATING", event: parsed.data, rawJson }
        : { kind: "OPERATING_HOLD", rawJson },
    });
  }
  release(
    commandId: string,
    reservationId: string,
    expected: ReservationState,
  ) {
    return this.write(commandId, {
      expectedRevision: expected.revision,
      expectedStateHash: hash(expected),
      epoch: this.repo.epoch,
      command: { kind: "RELEASE_LOCAL", reservationId },
    });
  }
  observe(
    commandId: string,
    command: Extract<ReservationCommand, { kind: "OBSERVE" }>,
    expected: ReservationState,
  ) {
    return this.write(commandId, {
      expectedRevision: expected.revision,
      expectedStateHash: hash(expected),
      epoch: this.repo.epoch,
      command,
    });
  }
  private write(commandId: string, raw: unknown, requireIssued?: () => void) {
    verifyPolicies();
    const id = idSchema.parse(commandId),
      input = this.parseInput(raw);
    return this.repo.writerTransaction(() => {
      // Admission-only bound under the writer lock: a new raw command at
      // capacity need not replay every stored 8 KiB input just to reject it.
      // Existing IDs still go through full replay/hash checks for recovery.
      // This guard can only reject, never authorize or trust cached finances.
      if (
        input.command.kind === "POST_CLOSE_INPUT" &&
        !this.repo.db
          .prepare("SELECT 1 FROM cost_reservation_commands WHERE id=?")
          .get(id) &&
        this.repo.db
          .prepare(
            "SELECT 1 FROM cost_reservation_commands WHERE json_extract(body,'$.command.kind')='POST_CLOSE_INPUT' LIMIT 1 OFFSET ?",
          )
          .get(postCloseInputLimit - 1)
      )
        throw Error("POST_CLOSE_INPUT_LIMIT");
      const previous = this.decode(),
        prior = previous.records.find((r) => r.id === id);
      const checkpoint = previous.state.finalization?.checkpoint;
      if (input.command.kind === "FINALIZE_OPERATING" && checkpoint) {
        if (prior && prior.input.command.kind !== "FINALIZE_OPERATING")
          throw Error("LOCAL_COMMAND_ID_CONFLICT");
        if (
          checkpoint.closeId !== input.command.closeId ||
          hash(checkpoint.request) !== hash(input.command.request)
        )
          throw Error("FINALIZATION_ID_OR_CONTENT_CONFLICT");
        const original = previous.records.find(
          (r) => r.input.command.kind === "FINALIZE_OPERATING",
        );
        if (!original) throw Error("FINALIZATION_RECEIPT_MISSING");
        return {
          duplicate: true,
          receipt: original.receipt,
          current: previous.state,
        };
      }
      if (prior) {
        if (
          isPartialSettlementCommand(input.command) &&
          isPartialSettlementCommand(prior.input.command) &&
          hash({ ...prior.input, epoch: input.epoch }) === hash(input)
        )
          return {
            duplicate: true,
            receipt: prior.receipt,
            current: previous.state,
            originalCommandId: prior.id,
            originalBusinessEventId: prior.input.command.businessEventId,
          };
        // Epoch may change after restart, but reusing a command ID may not
        // change its request, expected snapshot, or delivery metadata.
        if (
          isPostCloseCommand(input.command) &&
          isPostCloseCommand(prior.input.command) &&
          hash({ ...prior.input, epoch: input.epoch }) === hash(input)
        )
          return {
            duplicate: true,
            receipt: prior.receipt,
            current: previous.state,
          };
        if (hash(prior.input) !== hash(input))
          throw Error("LOCAL_COMMAND_ID_CONFLICT");
        // Original receipt is not a fresh approval. Current state may be released
        // or from a newer epoch; duplicates never resurrect a reservation.
        return {
          duplicate: true,
          receipt: prior.receipt,
          current: previous.state,
        };
      }
      requireIssued?.();
      if (isPartialSettlementCommand(input.command)) {
        const old = duplicatePartialSettlement(previous.state, input.command);
        if (old) {
          const original = previous.records.find(
            (r) =>
              isPartialSettlementCommand(r.input.command) &&
              r.input.command.sourceEventKey === old.sourceEventKey,
          );
          if (!original) throw Error("PARTIAL_RECEIPT_MISSING");
          return {
            duplicate: true,
            receipt: original.receipt,
            current: previous.state,
            originalCommandId: original.id,
            originalBusinessEventId: old.businessEventId,
          };
        }
      }
      if (
        isPostCloseCommand(input.command) &&
        duplicatePostClose(previous.state, input.command)
      ) {
        const identity = postCloseIdentity(input.command);
        const original = previous.records.find(
          (r) =>
            isPostCloseCommand(r.input.command) &&
            postCloseIdentity(r.input.command) === identity,
        );
        if (!original) throw Error("POST_CLOSE_RECEIPT_MISSING");
        return {
          duplicate: true,
          receipt: original.receipt,
          current: previous.state,
        };
      }
      if (
        input.command.kind === "OPERATING" &&
        duplicateOperatingEvent(previous.state, input.command.event)
      ) {
        const eventId = input.command.event.eventId;
        // Earlier records may quarantine this same event. Once accepted, the
        // writer never appends another OPERATING with this ID, so the last
        // matching record (not the first rejected attempt) owns its receipt.
        const original = previous.records.findLast(
          (r) =>
            r.input.command.kind === "OPERATING" &&
            r.input.command.event.eventId === eventId,
        );
        if (!original) throw Error("OPERATING_RECEIPT_MISSING");
        return {
          duplicate: true,
          receipt: original.receipt,
          current: previous.state,
        };
      }
      if (
        previous.state.kind !== reservationKind &&
        input.command.kind !== "FINALIZE_OPERATING" &&
        input.command.kind !== "POST_CLOSE_INPUT" &&
        !isPostCloseCommand(input.command) &&
        !isPartialSettlementCommand(input.command) &&
        duplicateHandoffFill(previous.state, input.command)
      ) {
        let original = previous.records.find(
          (r) =>
            r.input.command.kind === "EXECUTION" &&
            r.input.command.event.kind === "FILL" &&
            input.command.kind === "EXECUTION" &&
            input.command.event.kind === "FILL" &&
            r.input.command.runId === input.command.runId &&
            r.input.command.event.fillId === input.command.event.fillId,
        );
        if (
          !original &&
          input.command.kind === "EXECUTION" &&
          input.command.event.kind === "FILL"
        )
          original = previous.loopFillReceipts.get(
            hash({
              runId: input.command.runId,
              fillId: input.command.event.fillId,
            }),
          );
        if (!original) throw Error("HANDOFF_FILL_RECEIPT_MISSING");
        return {
          duplicate: true,
          receipt: original.receipt,
          current: previous.state,
        };
      }
      if (
        input.epoch !== this.repo.epoch ||
        input.expectedRevision !== previous.state.revision ||
        input.expectedStateHash !== hash(previous.state)
      )
        throw Error("LOCAL_REAPPROVAL_REQUIRED");
      const next = this.apply(
        previous.state,
        input.command,
        this.repo.epoch,
        previous.records,
      );
      const receipt = { revision: next.revision, stateHash: hash(next) };
      this.repo.db
        .prepare("INSERT INTO cost_reservation_commands VALUES(?,?,?,?,?,?)")
        .run(
          next.revision,
          id,
          hash(input),
          JSON.stringify(input),
          JSON.stringify(receipt),
          hash(receipt),
        );
      this.options.testStage?.("COMMAND");
      for (const a of next.approvals)
        this.repo.db
          .prepare(
            "INSERT INTO cost_reservation_approvals VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,checksum=excluded.checksum",
          )
          .run(a.id, JSON.stringify(a), hash(a));
      this.options.testStage?.("APPROVALS");
      this.syncFills(next);
      if (next.kind !== reservationKind) this.options.testStage?.("FILL_INDEX");
      this.repo.db
        .prepare("UPDATE cost_reservation_run SET body=?,checksum=? WHERE id=1")
        .run(JSON.stringify(next), hash(next));
      this.options.testStage?.("STATE");
      this.audit(next, { id, input });
      this.options.testStage?.("AUDIT");
      return isPartialSettlementCommand(input.command)
        ? {
            duplicate: false,
            receipt,
            current: next,
            originalCommandId: id,
            originalBusinessEventId: input.command.businessEventId,
          }
        : { duplicate: false, receipt, current: next };
    });
  }
  private auditBody(
    s: ReservationState,
    command: { id: string; input: Input } | null,
  ) {
    return {
      commandId: command?.id ?? null,
      inputHash: command ? hash(command.input) : null,
      stateHash: hash(s),
      epoch: s.epoch,
      revision: s.revision,
    };
  }
  private audit(
    s: ReservationState,
    command: { id: string; input: Input } | null,
  ) {
    const previous =
      this.repo.db
        .prepare("SELECT checksum FROM audit ORDER BY seq DESC LIMIT 1")
        .get()?.checksum ?? "GENESIS";
    const event = this.auditBody(s, command),
      kind = "LOCAL_COST_RESERVATION_TRANSITION",
      at = s.seed.clock;
    this.repo.db
      .prepare(
        "INSERT INTO audit(at,kind,body,previous,checksum) VALUES(?,?,?,?,?)",
      )
      .run(
        at,
        kind,
        JSON.stringify(event),
        previous,
        hash({ previous, at, kind, event }),
      );
  }
}
