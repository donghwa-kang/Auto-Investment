import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hash } from "../core/policy.js";
import type { State } from "../core/types.js";
export interface WriterLeaseDiagnostic {
  kind: "WRITER_LEASE_DIAGNOSTIC";
  rowPresent: boolean;
  ownerMatches: boolean;
  epochMatches: boolean;
  remainingMs: number | null;
}
export function writerLeaseDiagnostic(
  error: unknown,
): WriterLeaseDiagnostic | null {
  if (!(error instanceof Error) || error.message !== "FENCED_WRITER")
    return null;
  const c = error.cause;
  if (
    !c ||
    typeof c !== "object" ||
    !("kind" in c) ||
    c.kind !== "WRITER_LEASE_DIAGNOSTIC" ||
    !("rowPresent" in c) ||
    typeof c.rowPresent !== "boolean" ||
    !("ownerMatches" in c) ||
    typeof c.ownerMatches !== "boolean" ||
    !("epochMatches" in c) ||
    typeof c.epochMatches !== "boolean" ||
    !("remainingMs" in c) ||
    !(
      c.remainingMs === null ||
      (typeof c.remainingMs === "number" && Number.isSafeInteger(c.remainingMs))
    )
  )
    return null;
  return {
    kind: "WRITER_LEASE_DIAGNOSTIC",
    rowPresent: c.rowPresent,
    ownerMatches: c.ownerMatches,
    epochMatches: c.epochMatches,
    remainingMs: c.remainingMs,
  };
}
export class Repository {
  readonly db: DatabaseSync;
  readonly owner = randomUUID();
  epoch = 0;
  failure: "DISK_FULL" | "WRITE_FAILURE" | null = null;
  constructor(
    path: string,
    private now: () => number = Date.now,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; CREATE TABLE IF NOT EXISTS writer(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, epoch INTEGER NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS aggregate(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, checksum TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, input_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, previous TEXT NOT NULL, checksum TEXT NOT NULL);",
    );
  }
  acquire() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT owner,epoch,expires FROM writer WHERE id=1")
        .get() as { owner: string; epoch: number; expires: number } | undefined;
      if (row && row.expires > this.now() && row.owner !== this.owner)
        throw new Error("WRITER_BUSY");
      this.epoch = (row?.epoch ?? 0) + 1;
      this.db
        .prepare(
          "INSERT INTO writer VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,epoch=excluded.epoch,expires=excluded.expires",
        )
        .run(this.owner, this.epoch, this.now() + 10000);
      this.db.exec("COMMIT");
    } catch (e) {
      this.rollback(e);
    }
  }
  private rollback(error: unknown): never {
    // FULL/IOERR can end the transaction inside SQLite. A second ROLLBACK
    // would replace the actual failure with "no transaction is active".
    if (this.db.isTransaction) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "TRANSACTION_ROLLBACK_FAILED",
          { cause: error },
        );
      }
    }
    throw error;
  }
  private assertOwner() {
    const row = this.db
      .prepare("SELECT owner,epoch,expires FROM writer WHERE id=1")
      .get() as { owner: string; epoch: number; expires: number } | undefined;
    const checkedAt = this.now();
    if (
      !row ||
      row.owner !== this.owner ||
      row.epoch !== this.epoch ||
      row.expires <= checkedAt
    )
      throw new Error("FENCED_WRITER", {
        // Bounded diagnostic facts, not account/owner IDs or permission to retry.
        cause: {
          kind: "WRITER_LEASE_DIAGNOSTIC",
          rowPresent: Boolean(row),
          ownerMatches: row?.owner === this.owner,
          epochMatches: row?.epoch === this.epoch,
          remainingMs: row ? row.expires - checkedAt : null,
        },
      });
  }
  private assertLegacyMode() {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name LIKE 'cost_reservation_%'",
        )
        .get()
    )
      throw new Error("COST_RESERVATION_REQUIRES_VERSIONED_READER");
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cost_journal_run'",
        )
        .get()
    )
      throw new Error("COST_JOURNAL_REQUIRES_VERSIONED_READER");
  }
  // Synchronous internal extension boundary; the same connection owns the lock,
  // lease, journal and projections. A lease expiring during work cannot revive.
  writerTransaction<T>(
    change: () => T & (T extends PromiseLike<unknown> ? never : unknown),
  ): T {
    // Check native async functions BEFORE invocation: rolling back a returned
    // Promise cannot cancel its continuation. Callbacks remain trusted internal
    // code; this is not isolation from arbitrary callbacks with external effects.
    if (Object.prototype.toString.call(change) === "[object AsyncFunction]")
      throw new Error("ASYNC_WRITER_TRANSACTION");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertOwner();
      const result = change();
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        "then" in result &&
        typeof result.then === "function"
      )
        throw new Error("ASYNC_WRITER_TRANSACTION");
      if (this.failure) throw new Error(this.failure);
      this.assertOwner();
      this.db
        .prepare(
          "UPDATE writer SET expires=? WHERE id=1 AND owner=? AND epoch=?",
        )
        .run(this.now() + 10000, this.owner, this.epoch);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.rollback(error);
    }
  }
  read(): State | null {
    this.assertLegacyMode();
    const row = this.db
      .prepare("SELECT body,checksum FROM aggregate WHERE id=1")
      .get() as { body: string; checksum: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.body) as State;
    if (hash(value) !== row.checksum)
      throw new Error("STATE_CHECKSUM_MISMATCH");
    return value;
  }
  commandExists(id: string, input: unknown) {
    const row = this.db
      .prepare("SELECT input_hash FROM commands WHERE id=?")
      .get(id) as { input_hash: string } | undefined;
    if (row && row.input_hash !== hash(input))
      throw new Error("COMMAND_ID_CONFLICT");
    return Boolean(row);
  }
  transact(
    id: string,
    input: unknown,
    change: (current: State | null) => State,
  ): State {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertOwner();
      this.assertLegacyMode();
      const prior = this.db
        .prepare("SELECT input_hash FROM commands WHERE id=?")
        .get(id) as { input_hash: string } | undefined;
      const inputHash = hash(input);
      if (prior) {
        if (prior.input_hash !== inputHash)
          throw new Error("COMMAND_ID_CONFLICT");
        const previous = this.read();
        if (!previous) throw new Error("EMPTY_COMMAND_STATE");
        this.db.exec("COMMIT");
        return previous;
      }
      const state = change(this.read());
      state.revision++;
      if (this.failure) throw new Error(this.failure);
      const body = JSON.stringify(state),
        checksum = hash(state);
      this.db
        .prepare(
          "INSERT INTO aggregate VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,checksum=excluded.checksum",
        )
        .run(body, checksum);
      this.db.prepare("INSERT INTO commands VALUES(?,?)").run(id, inputHash);
      const prev = this.db
        .prepare("SELECT checksum FROM audit ORDER BY seq DESC LIMIT 1")
        .get() as { checksum: string } | undefined;
      const event = {
        command: id,
        input,
        stateHash: checksum,
        status: state.status,
        revision: state.revision,
        epoch: state.epoch,
      };
      const previous = prev?.checksum ?? "GENESIS";
      const eventHash = hash({
        previous,
        at: state.clock,
        kind: "TRANSITION",
        event,
      });
      this.db
        .prepare(
          "INSERT INTO audit(at,kind,body,previous,checksum) VALUES(?,?,?,?,?)",
        )
        .run(
          state.clock,
          "TRANSITION",
          JSON.stringify(event),
          previous,
          eventHash,
        );
      this.db
        .prepare(
          "UPDATE writer SET expires=? WHERE id=1 AND owner=? AND epoch=?",
        )
        .run(this.now() + 10000, this.owner, this.epoch);
      this.db.exec("COMMIT");
      return state;
    } catch (e) {
      this.rollback(e);
    }
  }
  heartbeat() {
    this.assertOwner();
    this.db
      .prepare("UPDATE writer SET expires=? WHERE id=1 AND owner=? AND epoch=?")
      .run(this.now() + 10000, this.owner, this.epoch);
  }
  events(page = 0) {
    return this.db
      .prepare(
        "SELECT seq,at,kind,body,previous,checksum FROM audit ORDER BY seq DESC LIMIT 50 OFFSET ?",
      )
      .all(page * 50);
  }
  verifyAudit() {
    const rows = this.db
      .prepare("SELECT at,kind,body,previous,checksum FROM audit ORDER BY seq")
      .iterate();
    let prev = "GENESIS";
    let count = 0;
    for (const r of rows) {
      const event = JSON.parse(r.body as string) as unknown;
      const expected = hash({
        previous: r.previous,
        at: r.at,
        kind: r.kind,
        event,
      });
      if (r.previous !== prev || r.checksum !== expected)
        throw new Error("AUDIT_CHAIN_MISMATCH");
      prev = r.checksum as string;
      count++;
    }
    return count;
  }
  close() {
    try {
      this.db
        .prepare(
          "UPDATE writer SET expires=0 WHERE id=1 AND owner=? AND epoch=?",
        )
        .run(this.owner, this.epoch);
    } finally {
      this.db.close();
    }
  }
}
