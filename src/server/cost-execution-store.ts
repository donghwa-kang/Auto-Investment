import { closeSync, existsSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { hash, verifyPolicies } from "../core/policy.js";
import {
  costExecutionConfigSchema,
  costExecutionEventSchema,
  costExecutionKind,
  replayCostExecutions,
} from "../core/cost-execution.js";
import type {
  CostExecutionConfig,
  CostExecutionEvent,
  CostExecutionView,
} from "../core/cost-execution.js";

// A distinct database format: never migrates or opens an app/account database
// for writing. Every mutation is serialized and replayed inside one transaction.
export class CostExecutionStore {
  readonly #db: DatabaseSync;
  readonly #config: CostExecutionConfig;
  failure: "WRITE_FAILURE" | null = null;
  constructor(
    rawConfig: unknown,
    path = ":memory:",
    options: { resume?: boolean } = {},
  ) {
    verifyPolicies();
    const parsed = costExecutionConfigSchema.safeParse(rawConfig);
    if (!parsed.success) throw Error("INVALID_EXECUTION_CONFIG");
    this.#config = parsed.data;
    const initial = replayCostExecutions(this.#config, []);
    if (initial.status !== "OK") throw Error(initial.reasons[0]);
    const existing = path !== ":memory:" && existsSync(path);
    if (existing) {
      if (!options.resume) throw Error("COST_STORE_RESUME_REQUIRED");
      const check = new DatabaseSync(path, { readOnly: true });
      try {
        this.decode(check);
      } finally {
        check.close();
      }
    } else if (options.resume) throw Error("COST_STORE_MISSING_FOR_RESUME");
    // Exclusive creation prevents races from turning a new-path request into
    // an overwrite of an existing file. An initialization failure leaves it.
    if (!existing && path !== ":memory:") closeSync(openSync(path, "wx"));
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250;",
      );
      if (!existing) {
        this.#db.exec(
          "CREATE TABLE cost_execution (id INTEGER PRIMARY KEY CHECK(id=1), kind TEXT NOT NULL, config TEXT NOT NULL, journal TEXT NOT NULL, result_hash TEXT NOT NULL, checksum TEXT NOT NULL)",
        );
        this.write([], initial);
      }
      this.read();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  private decode(db: DatabaseSync): {
    events: CostExecutionEvent[];
    result: CostExecutionView;
  } {
    let row;
    try {
      row = db
        .prepare(
          "SELECT kind,config,journal,result_hash,checksum FROM cost_execution WHERE id=1",
        )
        .get();
    } catch {
      throw Error("COST_STORE_NOT_A_COST_DATABASE");
    }
    if (!row || row.kind !== costExecutionKind)
      throw Error("COST_STORE_NOT_A_COST_DATABASE");
    let config: unknown, events: unknown;
    try {
      config = JSON.parse(String(row.config));
      events = JSON.parse(String(row.journal));
    } catch {
      throw Error("COST_STORE_INVALID_JSON");
    }
    if (hash(config) !== hash(this.#config))
      throw Error("COST_STORE_CONFIG_MISMATCH");
    if (
      hash({ kind: row.kind, config, events, resultHash: row.result_hash }) !==
      row.checksum
    )
      throw Error("COST_STORE_CHECKSUM_MISMATCH");
    const result = replayCostExecutions(config, events);
    if (result.status !== "OK" || hash(result) !== row.result_hash)
      throw Error("COST_STORE_REPLAY_MISMATCH");
    // Replay has already validated each event. Parse again to retain an explicit
    // typed boundary rather than casting an untrusted JSON array.
    if (!Array.isArray(events)) throw Error("COST_STORE_INVALID_EVENTS");
    return {
      events: events.map((e) => costExecutionEventSchema.parse(e)),
      result,
    };
  }
  private write(events: CostExecutionEvent[], result: CostExecutionView) {
    const resultHash = hash(result),
      checksum = hash({
        kind: costExecutionKind,
        config: this.#config,
        events,
        resultHash,
      });
    this.#db
      .prepare(
        "INSERT INTO cost_execution VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, config=excluded.config, journal=excluded.journal, result_hash=excluded.result_hash, checksum=excluded.checksum",
      )
      .run(
        costExecutionKind,
        JSON.stringify(this.#config),
        JSON.stringify(events),
        resultHash,
        checksum,
      );
  }
  read() {
    return this.decode(this.#db).result;
  }
  append(rawEvent: unknown): CostExecutionView {
    verifyPolicies();
    const parsed = costExecutionEventSchema.safeParse(rawEvent);
    if (!parsed.success) throw Error("INVALID_EXECUTION_EVENT");
    const event = parsed.data;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.decode(this.#db),
        duplicate = previous.events.find((e) => e.id === event.id);
      if (duplicate) {
        if (hash(duplicate) !== hash(event))
          throw Error("EXECUTION_EVENT_ID_CONFLICT");
        this.#db.exec("COMMIT");
        return previous.result;
      }
      const events = [...previous.events, event],
        result = replayCostExecutions(this.#config, events);
      if (result.status !== "OK") throw Error(result.reasons[0]);
      this.write(events, result);
      if (this.failure) throw Error(this.failure);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.#db.close();
  }
}
