import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hash } from "../core/policy.js";
import { evaluateLearning, type LearningReport } from "../core/learning.js";
import {
  learningId,
  LearningError,
  parseLearningInput,
  type LearningInput,
} from "../core/learning-schema.js";

const appId = 74831207;
const maximumStoredBytes = 128 * 1024 * 1024;
type State = "REGISTERED" | "RUNNING" | "COMPLETE" | "FAILED";
interface RecordRow {
  id: string;
  input_hash: string;
  input_json: string;
  state: State;
  report_json: string | null;
  error_code: string | null;
}
interface AuditRow {
  seq: number;
  previous_hash: string;
  event: string;
  payload: string;
  at: string;
  event_hash: string;
}
const safeId = (id: string) => {
  if (!learningId.safeParse(id).success)
    throw new LearningError("LEARNING_ID_INVALID");
};
const assert = (test: boolean) => {
  if (!test) throw new LearningError("LEARNING_REGISTRY_INTEGRITY");
};
const researchOnly = (r: Omit<LearningReport, "reportHash">) =>
  r.schemaVersion === "LEARNING_RESEARCH_REPORT_V1" &&
  r.purpose === "TEST_ONLY" &&
  ["DECLARED_SYNTHETIC", "ENGINE_RECORDED_SYNTHETIC"].includes(r.dataOrigin) &&
  r.selectedModel === null &&
  r.accountPerformance === null &&
  r.networkRequests === 0 &&
  typeof r.featuresRebuiltFromSource === "boolean" &&
  (!r.featuresRebuiltFromSource ||
    r.dataOrigin === "ENGINE_RECORDED_SYNTHETIC") &&
  [
    r.realDataReady,
    r.forecastValidated,
    r.profitabilityValidated,
    r.finalHoldoutEvaluated,
    r.operatingCostAllocationValidated,
    r.automaticPromotion,
    r.strategyEvaluated,
    r.paperOrdersEnabled,
    r.liveEnabled,
  ].every((v) => v === false);

export class LearningRegistry {
  private db!: DatabaseSync;
  readonly path: string;
  constructor(base = process.cwd(), allowCreate = true) {
    this.path = resolve(base, "data", "learning-lab", "registry.sqlite");
    try {
      const existed = existsSync(this.path);
      if (!existed && !allowCreate)
        throw new LearningError("LEARNING_REGISTRY_MISSING");
      if (existed) {
        // 알 수 없는 SQLite 파일을 먼저 읽기 전용으로 확인한다. 기존 거래 DB를 스키마로 덮지 않는다.
        const probe = new DatabaseSync(this.path, { readOnly: true });
        try {
          assert(
            (
              probe.prepare("PRAGMA application_id").get() as {
                application_id: number;
              }
            ).application_id === appId,
          );
        } finally {
          probe.close();
        }
      }
      mkdirSync(join(base, "data", "learning-lab"), { recursive: true });
      this.db = new DatabaseSync(this.path);
      this.db.exec("PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;");
      if (!existed)
        this.db.exec(`BEGIN IMMEDIATE;
        PRAGMA application_id=${appId}; PRAGMA user_version=1;
        CREATE TABLE experiments(id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL,report_json TEXT,error_code TEXT) STRICT;
        CREATE TABLE exposures(experiment_id TEXT NOT NULL REFERENCES experiments(id),fold_id TEXT NOT NULL,market TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,PRIMARY KEY(experiment_id,fold_id)) STRICT;
        CREATE TABLE audit(seq INTEGER PRIMARY KEY,previous_hash TEXT NOT NULL,event TEXT NOT NULL,payload TEXT NOT NULL,at TEXT NOT NULL,event_hash TEXT NOT NULL) STRICT;
        COMMIT;`);
      this.db.exec("PRAGMA synchronous=FULL;");
      this.verify();
    } catch (error) {
      this.db?.close();
      if (error instanceof LearningError) throw error;
      throw new LearningError("LEARNING_STORE_FAILED");
    }
  }
  close() {
    this.db.close();
  }
  private storedBytes() {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(length(CAST(input_json AS BLOB))+COALESCE(length(CAST(report_json AS BLOB)),0)),0) AS n FROM experiments",
        )
        .get() as { n: number }
    ).n;
  }
  private rows() {
    return this.db
      .prepare("SELECT * FROM experiments ORDER BY id")
      .all() as unknown as RecordRow[];
  }
  private get(id: string): RecordRow {
    safeId(id);
    const row = this.db
      .prepare("SELECT * FROM experiments WHERE id=?")
      .get(id) as unknown as RecordRow | undefined;
    if (!row) throw new LearningError("LEARNING_EXPERIMENT_MISSING");
    return row;
  }
  private snapshot(row: RecordRow) {
    return {
      id: row.id,
      inputHash: row.input_hash,
      state: row.state,
      reportHash: row.report_json
        ? (JSON.parse(row.report_json) as LearningReport).reportHash
        : null,
      errorCode: row.error_code,
    };
  }
  private audit(event: string, row: RecordRow) {
    const previous = this.db
      .prepare("SELECT seq,event_hash FROM audit ORDER BY seq DESC LIMIT 1")
      .get() as { seq: number; event_hash: string } | undefined;
    const entry = {
      seq: (previous?.seq ?? 0) + 1,
      previousHash: previous?.event_hash ?? "0".repeat(64),
      event,
      payload: this.snapshot(row),
      at: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)")
      .run(
        entry.seq,
        entry.previousHash,
        event,
        JSON.stringify(entry.payload),
        entry.at,
        hash(entry),
      );
  }
  private verify() {
    assert(this.storedBytes() <= maximumStoredBytes);
    assert(
      (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version === 1,
    );
    const rows = this.rows();
    assert(rows.length <= 100);
    const audits = this.db
      .prepare("SELECT * FROM audit ORDER BY seq")
      .all() as unknown as AuditRow[];
    assert(audits.length <= 400);
    let seq = 0,
      previousHash = "0".repeat(64);
    const last = new Map<string, unknown>();
    for (const a of audits) {
      const payload = JSON.parse(a.payload) as ReturnType<
        LearningRegistry["snapshot"]
      >;
      assert(a.seq === ++seq && a.previous_hash === previousHash);
      assert(
        hash({
          seq: a.seq,
          previousHash,
          event: a.event,
          payload,
          at: a.at,
        }) === a.event_hash,
      );
      previousHash = a.event_hash;
      last.set(payload.id, payload);
    }
    assert(last.size === rows.length);
    let expectedExposures = 0;
    for (const row of rows) {
      const input = parseLearningInput(JSON.parse(row.input_json));
      assert(
        input.experimentId === row.id &&
          hash(input) === row.input_hash &&
          hash(last.get(row.id)) === hash(this.snapshot(row)),
      );
      assert(
        ["REGISTERED", "RUNNING", "COMPLETE", "FAILED"].includes(row.state),
      );
      if (row.state === "COMPLETE") {
        assert(row.report_json !== null);
        const { reportHash, ...report } = JSON.parse(
          row.report_json!,
        ) as LearningReport;
        assert(
          hash(report) === reportHash &&
            report.inputHash === row.input_hash &&
            report.experimentId === row.id &&
            report.dataOrigin === input.dataOrigin &&
            report.featuresRebuiltFromSource ===
              (input.schemaVersion === "ENGINE_LEARNING_RESEARCH_V2") &&
            researchOnly(report),
        );
      } else assert(row.report_json === null);
      const exposures = this.db
        .prepare(
          "SELECT fold_id,market,start_at,end_at FROM exposures WHERE experiment_id=? ORDER BY start_at",
        )
        .all(row.id);
      if (row.state === "REGISTERED") assert(exposures.length === 0);
      else {
        const expected = input.validation.folds.map((f) => ({
          fold_id: f.id,
          market: input.market,
          start_at: Date.parse(f.testFrom),
          end_at: Date.parse(f.testTo),
        }));
        assert(hash(exposures) === hash(expected));
        expectedExposures += expected.length;
      }
    }
    assert(
      (
        this.db.prepare("SELECT COUNT(*) AS n FROM exposures").get() as {
          n: number;
        }
      ).n === expectedExposures,
    );
  }
  private transaction<T>(fn: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.verify();
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 진입 실패인 경우 활성 트랜잭션 없음 */
      }
      if (error instanceof LearningError) throw error;
      throw new LearningError("LEARNING_STORE_FAILED");
    }
  }
  register(raw: unknown) {
    const input = parseLearningInput(raw),
      inputHash = hash(input);
    return this.transaction(() => {
      const found = this.db
        .prepare("SELECT * FROM experiments WHERE id=?")
        .get(input.experimentId) as unknown as RecordRow | undefined;
      if (found) {
        if (found.input_hash !== inputHash)
          throw new LearningError("LEARNING_EXPERIMENT_CONFLICT");
        return this.snapshot(found);
      }
      if (this.rows().length >= 100)
        throw new LearningError("LEARNING_REGISTRY_FULL");
      if (
        this.storedBytes() + Buffer.byteLength(JSON.stringify(input)) >
        maximumStoredBytes
      )
        throw new LearningError("LEARNING_REGISTRY_FULL");
      this.db
        .prepare("INSERT INTO experiments VALUES(?,?,?,'REGISTERED',NULL,NULL)")
        .run(input.experimentId, inputHash, JSON.stringify(input));
      const row = this.get(input.experimentId);
      this.audit("REGISTER", row);
      return this.snapshot(row);
    });
  }
  status(id: string) {
    return this.transaction(() => this.snapshot(this.get(id)));
  }
  run(
    id: string,
    trainer: (input: LearningInput) => LearningReport = evaluateLearning,
  ) {
    const claim = this.transaction(() => {
      const row = this.get(id),
        input = parseLearningInput(JSON.parse(row.input_json));
      if (row.state === "COMPLETE")
        return {
          reused: true as const,
          report: JSON.parse(row.report_json!) as LearningReport,
        };
      if (row.state !== "REGISTERED")
        throw new LearningError("LEARNING_REVIEW_REQUIRED");
      for (const f of input.validation.folds) {
        const conflict = this.db
          .prepare(
            "SELECT experiment_id FROM exposures WHERE market=? AND start_at<? AND end_at>? LIMIT 1",
          )
          .get(input.market, Date.parse(f.testTo), Date.parse(f.testFrom));
        if (conflict)
          throw new LearningError("LEARNING_EVALUATION_WINDOW_USED");
      }
      for (const f of input.validation.folds)
        this.db
          .prepare("INSERT INTO exposures VALUES(?,?,?,?,?)")
          .run(
            id,
            f.id,
            input.market,
            Date.parse(f.testFrom),
            Date.parse(f.testTo),
          );
      this.db
        .prepare("UPDATE experiments SET state='RUNNING' WHERE id=?")
        .run(id);
      this.audit("CLAIM_EVALUATION", this.get(id));
      return { reused: false as const, input };
    });
    if (claim.reused) return claim;
    try {
      const report = trainer(claim.input),
        { reportHash, ...content } = report;
      if (
        hash(content) !== reportHash ||
        report.inputHash !== hash(claim.input) ||
        report.experimentId !== id ||
        report.dataOrigin !== claim.input.dataOrigin ||
        report.featuresRebuiltFromSource !==
          (claim.input.schemaVersion === "ENGINE_LEARNING_RESEARCH_V2") ||
        !researchOnly(report)
      )
        throw new LearningError("LEARNING_REPORT_INVALID");
      const json = JSON.stringify(report);
      if (Buffer.byteLength(json) > 64 * 1024 * 1024)
        throw new LearningError("LEARNING_REPORT_TOO_LARGE");
      this.transaction(() => {
        if (this.get(id).state !== "RUNNING")
          throw new LearningError("LEARNING_STATE_CONFLICT");
        if (this.storedBytes() + Buffer.byteLength(json) > maximumStoredBytes)
          throw new LearningError("LEARNING_REGISTRY_FULL");
        this.db
          .prepare(
            "UPDATE experiments SET state='COMPLETE',report_json=? WHERE id=?",
          )
          .run(json, id);
        this.audit("COMPLETE", this.get(id));
      });
      return { reused: false, report };
    } catch (error) {
      const code =
        error instanceof LearningError
          ? error.code
          : "LEARNING_EVALUATION_FAILED";
      this.transaction(() => {
        if (this.get(id).state !== "RUNNING")
          throw new LearningError("LEARNING_STATE_CONFLICT");
        this.db
          .prepare(
            "UPDATE experiments SET state='FAILED',error_code=? WHERE id=?",
          )
          .run(code, id);
        this.audit("FAILED", this.get(id));
      });
      throw new LearningError(code);
    }
  }
}
