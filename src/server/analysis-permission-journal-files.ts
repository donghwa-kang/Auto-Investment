import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  launchHashSchema,
  launchRunIdSchema,
  launchSha256,
} from "../core/analysis-launch-plan.js";
import { type ProvisionPlan } from "../core/analysis-provision.js";
import {
  journalBindingSchema,
  journalJson,
  permissionJournalBinding,
  permissionRecord,
  replayPermissionJournal,
  type PermissionEvent,
  type PermissionIntent,
} from "../core/analysis-permission-journal.js";
import {
  readLaunchFile,
  requireLaunchDirectory,
} from "./analysis-launch-files.js";

function layout(workspace: string, labId: string) {
  if (process.platform !== "win32" || process.versions.node !== "24.20.0")
    throw new Error("JOURNAL_RUNTIME");
  launchRunIdSchema.parse(labId);
  requireLaunchDirectory(workspace);
  const parent = join(workspace, "work", "analysis-recovery-lab");
  const directory = join(parent, `lab-${labId}`);
  return {
    parent,
    directory,
    binding: join(directory, "binding.json"),
    log: join(directory, "events.ndjson"),
    lock: join(directory, "writer.lock"),
  };
}
function writeAll(fd: number, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!count) throw new Error("JOURNAL_SHORT_WRITE_HOLD");
    offset += count;
  }
  fsyncSync(fd);
}
function freshFile(path: string, bytes: Buffer) {
  const fd = openSync(path, "wx");
  try {
    writeAll(fd, bytes);
  } finally {
    closeSync(fd);
  }
}
export function createPermissionJournal(
  workspace: string,
  plan: ProvisionPlan,
) {
  const binding = permissionJournalBinding(plan),
    labId = randomUUID(),
    paths = layout(workspace, labId);
  requireLaunchDirectory(join(workspace, "work"));
  if (!existsSync(paths.parent)) mkdirSync(paths.parent);
  requireLaunchDirectory(paths.parent);
  mkdirSync(paths.directory);
  requireLaunchDirectory(paths.directory);
  const wire = Buffer.from(journalJson(binding));
  freshFile(paths.binding, wire);
  freshFile(paths.log, Buffer.alloc(0));
  return {
    labId,
    bindingSha256: launchSha256(wire),
    head: launchSha256(wire),
    directory: paths.directory,
  };
}
export function readPermissionJournal(
  workspace: string,
  labId: string,
  bindingSha256: string,
  expectedHead?: string,
) {
  launchHashSchema.parse(bindingSha256);
  if (expectedHead !== undefined) launchHashSchema.parse(expectedHead);
  const paths = layout(workspace, labId);
  requireLaunchDirectory(paths.directory);
  const names = readdirSync(paths.directory).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(
      [
        "binding.json",
        "events.ndjson",
        ...(names.includes("writer.lock") ? ["writer.lock"] : []),
      ].sort(),
    )
  )
    throw new Error("JOURNAL_INVENTORY_HOLD");
  const wire = readLaunchFile(paths.binding, 8192);
  if (launchSha256(wire) !== bindingSha256)
    throw new Error("JOURNAL_BINDING_HOLD");
  const binding = journalBindingSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(wire),
    ),
  );
  if (journalJson(binding) !== wire.toString("utf8"))
    throw new Error("JOURNAL_BINDING_CONTRACT");
  const bytes = readLaunchFile(paths.log, 131072),
    state = replayPermissionJournal(binding, bytes);
  if (expectedHead !== undefined && expectedHead !== state.head)
    throw new Error("JOURNAL_HEAD_HOLD");
  const writerPresent = names.includes("writer.lock");
  return {
    binding,
    bytes,
    ...state,
    writerPresent,
    anchored: expectedHead !== undefined,
    status:
      writerPresent || expectedHead === undefined
        ? ("RECOVERY_HOLD" as const)
        : state.status,
  };
}

// 잠금은 협조하는 로컬 writer의 중복 방지다. 비정상 종료 후 잠금 파일을 자동 삭제하지 않는다.
export class PermissionJournalWriter {
  private readonly paths;
  private readonly lockFd: number;
  private readonly lockIdentity;
  private logFd: number | null = null;
  private head: string;
  private ownedOperation: string | null = null;
  private closed = false;
  private poisoned = false;
  constructor(
    private readonly workspace: string,
    private readonly labId: string,
    private readonly bindingSha256: string,
    expectedHead: string,
  ) {
    this.paths = layout(workspace, labId);
    const initial = readPermissionJournal(
      workspace,
      labId,
      bindingSha256,
      expectedHead,
    );
    if (initial.status === "RECOVERY_HOLD")
      throw new Error("JOURNAL_RESTART_REQUIRES_REVIEW");
    this.head = initial.head;
    this.lockFd = openSync(this.paths.lock, "wx");
    this.lockIdentity = fstatSync(this.lockFd);
    try {
      writeAll(
        this.lockFd,
        Buffer.from(
          journalJson({
            version: "WRITER_LOCK_V1",
            owner: randomUUID(),
            pid: process.pid,
          }),
        ),
      );
      const locked = readPermissionJournal(
        workspace,
        labId,
        bindingSha256,
        expectedHead,
      );
      if (locked.pending || locked.uncertain)
        throw new Error("JOURNAL_PENDING_HOLD");
      const before = lstatSync(this.paths.log);
      this.logFd = openSync(this.paths.log, "a");
      const opened = fstatSync(this.logFd);
      if (
        opened.ino !== before.ino ||
        opened.dev !== before.dev ||
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.size !== locked.bytes.length
      )
        throw new Error("JOURNAL_FILE_IDENTITY_HOLD");
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private append(event: PermissionEvent) {
    if (this.closed || this.poisoned || this.logFd === null)
      throw new Error("JOURNAL_WRITER_CLOSED");
    try {
      const lock = lstatSync(this.paths.lock);
      if (
        lock.ino !== this.lockIdentity.ino ||
        lock.dev !== this.lockIdentity.dev ||
        lock.nlink !== 1 ||
        !lock.isFile()
      )
        throw new Error("JOURNAL_LOCK_CHANGED_HOLD");
      const current = readPermissionJournal(
        this.workspace,
        this.labId,
        this.bindingSha256,
        this.head,
      );
      const opened = fstatSync(this.logFd),
        named = lstatSync(this.paths.log);
      if (
        opened.ino !== named.ino ||
        opened.dev !== named.dev ||
        opened.nlink !== 1 ||
        opened.size !== current.bytes.length
      )
        throw new Error("JOURNAL_FILE_CHANGED_HOLD");
      const row = permissionRecord(current.sequence + 1, this.head, event);
      const wire = Buffer.from(journalJson(row));
      replayPermissionJournal(
        current.binding,
        Buffer.concat([current.bytes, wire]),
      );
      writeAll(this.logFd, wire); // 변경 전 기록은 이 동기화가 성공한 뒤에만 반환한다.
      this.head = row.sha256;
      readPermissionJournal(
        this.workspace,
        this.labId,
        this.bindingSha256,
        this.head,
      );
      return this.head;
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }
  begin(intent: PermissionIntent) {
    const head = this.append({ type: "BEFORE", intent });
    this.ownedOperation = intent.operationId;
    return {
      operationId: intent.operationId,
      durableRecordSha256: head,
      mode: "MODEL_ONLY" as const,
    };
  }
  finish(operationId: string, observedSha256: string | null) {
    if (operationId !== this.ownedOperation)
      throw new Error("JOURNAL_NOT_OWNED_OPERATION");
    const result = this.append({
      type: "AFTER",
      operationId,
      outcome: observedSha256 === null ? "UNCERTAIN" : "VERIFIED",
      observedSha256,
    });
    this.ownedOperation = null;
    return result;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.logFd !== null) closeSync(this.logFd);
    closeSync(this.lockFd);
    // 자신이 생성한 일시 writer 잠금만 정상 종료 시 제거하며 기록은 보존한다.
    const lock = lstatSync(this.paths.lock);
    if (
      lock.ino !== this.lockIdentity.ino ||
      lock.dev !== this.lockIdentity.dev ||
      lock.nlink !== 1 ||
      !lock.isFile()
    )
      throw new Error("JOURNAL_LOCK_PRESERVED_HOLD");
    unlinkSync(this.paths.lock);
  }
}
