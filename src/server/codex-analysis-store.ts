import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, resolve, parse } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash } from "../core/policy.js";
import { verifyAnalysisJob } from "../core/codex-analysis.js";
import {
  analysisHash,
  analysisJobSchema,
  type AnalysisJob,
} from "../core/codex-analysis-schema.js";

const appId = 74831208;
const storeSchema = z.strictObject({
  version: z.literal(1),
  jobs: z.array(analysisJobSchema).max(100),
  events: z
    .array(
      z.strictObject({
        seq: z.number().int().positive(),
        id: z.string().uuid(),
        at: z.string().datetime(),
        stateHash: analysisHash,
        previousHash: analysisHash,
        eventHash: analysisHash,
      }),
    )
    .max(500),
});
type StoreState = z.infer<typeof storeSchema>;
interface StoredRow {
  body: string;
  checksum: string;
}
interface Owner {
  token: string;
  pid: number;
}
const ensure = (ok: boolean) => {
  if (!ok) throw new Error("ANALYSIS_INTEGRITY");
};

// 전용 DB만 사용한다. 거래 DB를 받거나 기존 엔진에 쓰기 권한을 전달하지 않는다.
export class AnalysisStore {
  private db!: DatabaseSync;
  private token = randomUUID();
  private closed = false;
  constructor(readonly path: string) {
    try {
      const full = resolve(path);
      ensure(!full.startsWith("\\\\"));
      let segment = full;
      while (segment !== parse(segment).root) {
        if (existsSync(segment) && lstatSync(segment).isSymbolicLink())
          throw new Error("ANALYSIS_PATH_DENIED");
        segment = dirname(segment);
      }
      const existed = existsSync(full);
      if (existed) {
        const stat = lstatSync(full);
        ensure(stat.isFile() && stat.size <= 8 * 1024 * 1024);
        const probe = new DatabaseSync(full, { readOnly: true });
        try {
          ensure(
            (
              probe.prepare("PRAGMA application_id").get() as {
                application_id: number;
              }
            ).application_id === appId,
          );
        } finally {
          probe.close();
        }
      } else {
        mkdirSync(dirname(full), { recursive: true });
        closeSync(openSync(full, "wx", 0o600));
      }
      this.db = new DatabaseSync(full);
      this.db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!existed) {
          this.db.exec(`PRAGMA application_id=${appId}; PRAGMA user_version=1;
            CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
            CREATE TABLE owner(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,pid INTEGER NOT NULL) STRICT;`);
          const empty: StoreState = { version: 1, jobs: [], events: [] };
          this.db
            .prepare("INSERT INTO state VALUES(1,?,?)")
            .run(JSON.stringify(empty), hash(empty));
        }
        ensure(
          (
            this.db.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version === 1,
        );
        const owner = this.db
          .prepare("SELECT token,pid FROM owner WHERE id=1")
          .get() as Owner | undefined;
        if (owner) {
          let alive = true;
          try {
            process.kill(owner.pid, 0);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
          }
          if (alive) throw new Error("ANALYSIS_OWNER_ACTIVE");
        }
        this.readState();
        this.db
          .prepare("INSERT OR REPLACE INTO owner VALUES(1,?,?)")
          .run(this.token, process.pid);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    } catch (e) {
      this.db?.close();
      throw e;
    }
  }
  private owned() {
    if (this.closed) throw new Error("ANALYSIS_CLOSED");
    const owner = this.db
      .prepare("SELECT token,pid FROM owner WHERE id=1")
      .get() as Owner | undefined;
    if (owner?.token !== this.token) throw new Error("ANALYSIS_FENCED");
  }
  private readState(): StoreState {
    const row = this.db
      .prepare("SELECT body,checksum FROM state WHERE id=1")
      .get() as StoredRow | undefined;
    ensure(Boolean(row) && Buffer.byteLength(row!.body) <= 4 * 1024 * 1024);
    const s = storeSchema.parse(JSON.parse(row!.body));
    ensure(
      hash(s) === row!.checksum &&
        new Set(s.jobs.map((j) => j.request.id)).size === s.jobs.length,
    );
    let previous = "0".repeat(64);
    const latest = new Map<string, string>();
    for (const [i, event] of s.events.entries()) {
      const { eventHash, ...body } = event;
      ensure(
        event.seq === i + 1 &&
          body.previousHash === previous &&
          hash(body) === eventHash,
      );
      latest.set(event.id, event.stateHash);
      previous = eventHash;
    }
    ensure(latest.size === s.jobs.length);
    for (const j of s.jobs) {
      verifyAnalysisJob(j);
      ensure(latest.get(j.request.id) === hash(j));
    }
    ensure(
      s.jobs.filter((j) =>
        ["AWAITING_APPROVAL", "APPROVED", "RUNNING"].includes(j.state),
      ).length <= 1,
    );
    return s;
  }
  list(): AnalysisJob[] {
    this.owned();
    return this.readState().jobs;
  }
  update(change: (jobs: AnalysisJob[]) => void, now: number) {
    this.owned();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.owned();
      const s = this.readState(),
        before = new Map(s.jobs.map((j) => [j.request.id, hash(j)]));
      const previousEvents = s.events.length;
      change(s.jobs);
      ensure(
        [...before.keys()].every((id) =>
          s.jobs.some((j) => j.request.id === id),
        ),
      );
      for (const j of s.jobs) {
        verifyAnalysisJob(j);
        if (before.get(j.request.id) === hash(j)) continue;
        const event = {
          seq: s.events.length + 1,
          id: j.request.id,
          at: new Date(now).toISOString(),
          stateHash: hash(j),
          previousHash: s.events.at(-1)?.eventHash ?? "0".repeat(64),
        };
        s.events.push({ ...event, eventHash: hash(event) });
      }
      storeSchema.parse(s);
      const body = JSON.stringify(s);
      ensure(Buffer.byteLength(body) <= 4 * 1024 * 1024);
      if (s.events.length !== previousEvents)
        this.db
          .prepare("UPDATE state SET body=?,checksum=? WHERE id=1")
          .run(body, hash(s));
      this.readState();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    if (this.closed) return;
    try {
      this.db
        .prepare("DELETE FROM owner WHERE id=1 AND token=?")
        .run(this.token);
    } finally {
      this.closed = true;
      this.db.close();
    }
  }
}
