import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { hash, assertOffline, verifyPolicies } from "../core/policy.js";
import {
  learningJournal,
  recordOrder,
  recordPosition,
} from "../core/paper-learning-capture.js";
import { verifyPaperExport } from "../core/paper-learning-verify.js";
import { PaperLearningError } from "../core/paper-learning-schema.js";
import type { State } from "../core/types.js";

// Repository는 DDL/lease를 쓰므로 사용하지 않는다. 읽기 트랜잭션 안에서 aggregate와 감사 꼬리를 함께 읽는다.
export function exportPaperLearning(path: string) {
  let db: DatabaseSync | undefined;
  try {
    assertOffline(
      process.env.TRADING_MODE ?? "PAPER",
      process.env.LIVE_ENABLED ?? false,
    );
    verifyPolicies();
    if (
      !path ||
      !path.endsWith(".sqlite") ||
      path.startsWith("\\\\") ||
      path.startsWith("//") ||
      /^[a-z]+:\/\//i.test(path) ||
      !lstatSync(path).isFile() ||
      lstatSync(path).isSymbolicLink()
    )
      throw new PaperLearningError("PAPER_LEARNING_LOCAL_DB_REQUIRED");
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only=ON; BEGIN;");
    const size = db
      .prepare(
        "SELECT length(CAST(body AS BLOB)) AS bytes FROM aggregate WHERE id=1",
      )
      .get() as { bytes: number } | undefined;
    if (!size || size.bytes > 16 * 1024 * 1024)
      throw new PaperLearningError("PAPER_LEARNING_STATE_SIZE");
    const row = db
      .prepare("SELECT body,checksum FROM aggregate WHERE id=1")
      .get() as { body: string; checksum: string };
    const s = JSON.parse(row.body) as State;
    if (
      hash(s) !== row.checksum ||
      s.manifest?.kind !== "OFFLINE_PORTFOLIO_PAPER_V1" ||
      s.manifest.purpose !== "TEST_ONLY" ||
      s.config?.mode !== "PAPER"
    )
      throw new PaperLearningError("PAPER_LEARNING_SOURCE_INVALID");
    const journal = learningJournal(s);
    if (!journal)
      throw new PaperLearningError("PAPER_LEARNING_CAPTURE_NOT_ENABLED");
    if (
      hash(journal.decisions) !== hash(s.decisions) ||
      journal.runHash !== s.manifest.runHash
    )
      throw new PaperLearningError("PAPER_LEARNING_SOURCE_INVALID");
    const stats = db
      .prepare(
        "SELECT count(*) AS n, coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM audit",
      )
      .get() as { n: number; bytes: number };
    if (stats.n > 11000 || stats.bytes > 32 * 1024 * 1024)
      throw new PaperLearningError("PAPER_LEARNING_AUDIT_SIZE");
    let head = "GENESIS",
      count = 0,
      lastState = "";
    const commands = new Set<string>();
    for (const a of db
      .prepare(
        "SELECT seq,at,kind,body,previous,checksum FROM audit ORDER BY seq",
      )
      .iterate()) {
      const event = JSON.parse(String(a.body)) as {
        command: string;
        input: unknown;
        stateHash: string;
        revision: number;
      };
      const bound = db
        .prepare("SELECT input_hash FROM commands WHERE id=?")
        .get(event.command) as { input_hash: string } | undefined;
      if (
        a.seq !== ++count ||
        a.previous !== head ||
        a.kind !== "TRANSITION" ||
        a.checksum !==
          hash({ previous: a.previous, at: a.at, kind: a.kind, event }) ||
        event.revision !== count ||
        commands.has(event.command) ||
        bound?.input_hash !== hash(event.input)
      )
        throw new PaperLearningError("PAPER_LEARNING_AUDIT_INVALID");
      commands.add(event.command);
      head = String(a.checksum);
      lastState = event.stateHash;
    }
    const commandCount = db
      .prepare("SELECT count(*) AS n FROM commands")
      .get() as { n: number };
    if (
      count !== s.revision ||
      count !== commandCount.n ||
      lastState !== row.checksum
    )
      throw new PaperLearningError("PAPER_LEARNING_AUDIT_INVALID");
    const body = {
      schemaVersion: "PAPER_LEARNING_EXPORT_V1" as const,
      purpose: "TEST_ONLY" as const,
      journal,
      asOf: s.clock,
      revision: s.revision,
      stateHash: row.checksum,
      auditHead: head,
      auditCount: count,
      orders: s.orders.map(recordOrder),
      positions: s.positions.map(recordPosition),
      costs: s.ledger.costs,
      liveEnabled: false as const,
    };
    const result = verifyPaperExport({ ...body, exportHash: hash(body) });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (error instanceof PaperLearningError) throw error;
    throw new PaperLearningError("PAPER_LEARNING_EXPORT_FAILED");
  } finally {
    db?.close();
  }
}
