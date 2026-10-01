import { hash, verifyPolicies } from "../core/policy.js";
import {
  costJournalConfigSchema,
  costJournalEventSchema,
  costJournalKind,
  journalFillIdentity,
  journalFillKey,
  replayCostJournal,
  replayCostJournalTrace,
} from "../core/cost-journal.js";
import type {
  CostJournalConfig,
  CostJournalEvent,
  CostJournalView,
} from "../core/cost-journal.js";
import { Repository } from "./repository.js";

export type JournalStage = "EVENT" | "FILL_INDEX" | "STATE" | "AUDIT";
interface JournalSnapshot {
  kind: typeof costJournalKind;
  epoch: number;
  revision: number;
  projection: CostJournalView;
}

// Versioned storage extension, not a second database or writer. Only explicit
// fresh synthetic runs use these tables; the legacy aggregate cannot coexist.
export class CostJournal {
  readonly #config: CostJournalConfig;
  constructor(
    private readonly repo: Repository,
    rawConfig: unknown,
    options: {
      initialize?: boolean;
      testStage?: (stage: JournalStage) => void;
    } = {},
  ) {
    verifyPolicies();
    this.#config = costJournalConfigSchema.parse(rawConfig);
    replayCostJournal(this.#config, []);
    this.testStage = options.testStage;
    if (
      repo.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name LIKE 'cost_reservation_%'",
        )
        .get()
    )
      throw Error("JOURNAL_RESERVATION_MODE_CONFLICT");
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
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cost_journal_run'",
            )
            .get()
        )
          throw Error("JOURNAL_REQUIRES_EMPTY_REPOSITORY");
        repo.db.exec(`
        CREATE TABLE cost_journal_run(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, config_hash TEXT NOT NULL, body TEXT NOT NULL, checksum TEXT NOT NULL);
        CREATE TABLE cost_journal_events(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, body TEXT NOT NULL, epoch INTEGER NOT NULL);
        CREATE TABLE cost_journal_fills(fill_key TEXT PRIMARY KEY, event_seq INTEGER NOT NULL UNIQUE, identity_hash TEXT NOT NULL, body TEXT NOT NULL, checksum TEXT NOT NULL);
      `);
        const snapshot = this.snapshot([], 0);
        this.writeState(snapshot);
        this.audit(snapshot, null);
      });
    this.read();
  }
  private readonly testStage?: (stage: JournalStage) => void;
  private snapshot(
    events: CostJournalEvent[],
    revision: number,
  ): JournalSnapshot {
    return {
      kind: costJournalKind,
      epoch: this.repo.epoch,
      revision,
      projection: replayCostJournal(this.#config, events),
    };
  }
  private writeState(s: JournalSnapshot) {
    this.repo.db
      .prepare(
        "INSERT INTO cost_journal_run VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,checksum=excluded.checksum",
      )
      .run(
        JSON.stringify(this.#config),
        hash(this.#config),
        JSON.stringify(s),
        hash(s),
      );
  }
  private audit(s: JournalSnapshot, event: CostJournalEvent | null) {
    const previous =
      this.repo.db
        .prepare("SELECT checksum FROM audit ORDER BY seq DESC LIMIT 1")
        .get()?.checksum ?? "GENESIS";
    const at = event?.at ?? this.#config.execution.initialAt;
    const body = {
      eventHash: event ? hash(event) : null,
      projectionHash: hash(s.projection),
      epoch: s.epoch,
      revision: s.revision,
    };
    const kind = "COST_JOURNAL_TRANSITION";
    this.repo.db
      .prepare(
        "INSERT INTO audit(at,kind,body,previous,checksum) VALUES(?,?,?,?,?)",
      )
      .run(
        at,
        kind,
        JSON.stringify(body),
        previous,
        hash({ previous, at, kind, event: body }),
      );
  }
  private decode(): { events: CostJournalEvent[]; snapshot: JournalSnapshot } {
    const db = this.repo.db;
    if (
      db
        .prepare(
          "SELECT 1 FROM aggregate UNION ALL SELECT 1 FROM commands LIMIT 1",
        )
        .get()
    )
      throw Error("JOURNAL_LEGACY_STATE_CONFLICT");
    const row = db
      .prepare(
        "SELECT config,config_hash,body,checksum FROM cost_journal_run WHERE id=1",
      )
      .get();
    if (!row) throw Error("JOURNAL_MISSING_RUN");
    const config: unknown = JSON.parse(String(row.config));
    if (row.config_hash !== hash(config) || hash(config) !== hash(this.#config))
      throw Error("JOURNAL_CONFIG_MISMATCH");
    // Snapshot is treated only as a checked cache. Every public read derives
    // authoritative money/cost/reserve state again from the original events.
    const cached: unknown = JSON.parse(String(row.body));
    if (hash(cached) !== row.checksum) throw Error("JOURNAL_CHECKSUM_MISMATCH");
    const rows = db
      .prepare(
        "SELECT seq,id,input_hash,body,epoch FROM cost_journal_events ORDER BY seq",
      )
      .all();
    const events = rows.map((row) => {
      const event = costJournalEventSchema.parse(JSON.parse(String(row.body)));
      if (
        row.seq !== event.seq ||
        row.id !== event.id ||
        row.input_hash !== hash(event) ||
        !Number.isSafeInteger(row.epoch) ||
        Number(row.epoch) < 1
      )
        throw Error("JOURNAL_EVENT_MISMATCH");
      return event;
    });
    const { projection, projectionHashes } = replayCostJournalTrace(
      this.#config,
      events,
    );
    const audits = db
      .prepare("SELECT at,kind,body FROM audit ORDER BY seq")
      .all();
    if (this.repo.verifyAudit() !== events.length + 1)
      throw Error("JOURNAL_AUDIT_COUNT");
    let epoch = 0;
    for (const [i, a] of audits.entries()) {
      const event = events[i - 1] ?? null;
      const data: unknown = JSON.parse(String(a.body));
      if (
        !data ||
        typeof data !== "object" ||
        !("epoch" in data) ||
        !Number.isSafeInteger(data.epoch) ||
        Number(data.epoch) < Math.max(1, epoch)
      )
        throw Error("JOURNAL_AUDIT_EPOCH");
      epoch = Number(data.epoch);
      if (i > 0 && rows[i - 1]!.epoch !== epoch)
        throw Error("JOURNAL_EVENT_EPOCH");
      if (
        a.kind !== "COST_JOURNAL_TRANSITION" ||
        a.at !== (event?.at ?? this.#config.execution.initialAt)
      )
        throw Error("JOURNAL_AUDIT_CONTEXT");
      const expected = {
        eventHash: event ? hash(event) : null,
        projectionHash: projectionHashes[i],
        epoch,
        revision: i,
      };
      if (hash(data) !== hash(expected))
        throw Error("JOURNAL_AUDIT_REPLAY_MISMATCH");
    }
    const snapshot: JournalSnapshot = {
      kind: costJournalKind,
      epoch,
      revision: events.length,
      projection,
    };
    if (hash(snapshot) !== row.checksum)
      throw Error("JOURNAL_STATE_REPLAY_MISMATCH");
    const fills = db
      .prepare(
        "SELECT fill_key,event_seq,identity_hash,body,checksum FROM cost_journal_fills ORDER BY event_seq",
      )
      .all();
    if (fills.length !== projection.postings.length)
      throw Error("JOURNAL_FILL_COUNT");
    for (const [i, f] of fills.entries()) {
      const posting = projection.postings[i]!;
      if (
        f.fill_key !== posting.key ||
        f.event_seq !== posting.eventSeq ||
        f.identity_hash !== posting.identityHash ||
        f.checksum !== hash(posting) ||
        hash(JSON.parse(String(f.body))) !== hash(posting)
      )
        throw Error("JOURNAL_FILL_REPLAY_MISMATCH");
    }
    return { events, snapshot };
  }
  read(): JournalSnapshot {
    // Multi-table validation must use a consistent read snapshot, even while
    // another connection commits. No lease is needed for a read-only snapshot.
    this.repo.db.exec("BEGIN");
    try {
      const result = this.decode().snapshot;
      this.repo.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.repo.db.exec("ROLLBACK");
      throw e;
    }
  }
  append(rawEvent: unknown): JournalSnapshot {
    verifyPolicies();
    const e = costJournalEventSchema.parse(rawEvent);
    return this.repo.writerTransaction(() => {
      const previous = this.decode();
      const prior = this.repo.db
        .prepare("SELECT input_hash FROM cost_journal_events WHERE id=?")
        .get(e.id);
      if (prior) {
        if (prior.input_hash !== hash(e))
          throw Error("JOURNAL_EVENT_ID_CONFLICT");
        return previous.snapshot;
      }
      if (e.kind === "FILL") {
        const fill = this.repo.db
          .prepare(
            "SELECT identity_hash FROM cost_journal_fills WHERE fill_key=?",
          )
          .get(journalFillKey(this.#config, e.fillId));
        if (fill) {
          if (fill.identity_hash !== journalFillIdentity(e))
            throw Error("JOURNAL_FILL_ID_CONFLICT");
          return previous.snapshot;
        }
      }
      const next = this.snapshot(
        [...previous.events, e],
        previous.snapshot.revision + 1,
      );
      this.repo.db
        .prepare("INSERT INTO cost_journal_events VALUES(?,?,?,?,?)")
        .run(e.seq, e.id, hash(e), JSON.stringify(e), this.repo.epoch);
      this.testStage?.("EVENT");
      // SQL primary/unique keys form the persistent latch. Do not upsert a
      // conflicting fill. Settlements only update already validated postings.
      for (const p of next.projection.postings) {
        if (p.eventSeq === e.seq)
          this.repo.db
            .prepare("INSERT INTO cost_journal_fills VALUES(?,?,?,?,?)")
            .run(p.key, p.eventSeq, p.identityHash, JSON.stringify(p), hash(p));
        else if (e.kind === "SETTLE" && e.fillIds.includes(p.fill.fillId))
          this.repo.db
            .prepare(
              "UPDATE cost_journal_fills SET body=?,checksum=? WHERE fill_key=?",
            )
            .run(JSON.stringify(p), hash(p), p.key);
      }
      this.testStage?.("FILL_INDEX");
      this.writeState(next);
      this.testStage?.("STATE");
      this.audit(next, e);
      this.testStage?.("AUDIT");
      return next;
    });
  }
}
