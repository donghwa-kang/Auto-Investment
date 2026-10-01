import { Worker } from "node:worker_threads";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  costWebRequestSchema,
  costWebRecordSchema,
  type CostWebRecord,
} from "../core/cost-web-schema.js";
import { assertOffline } from "../core/policy.js";
import type { CostWebView } from "./cost-web-run.js";
import type { CostAppView } from "./cost-app-run.js";
import type {
  CostLearningInputAnchor,
  CostLearningResult,
} from "./cost-learning-input.js";

type AppView = CostWebView | CostAppView;
interface VerifyJob {
  runId: string;
  snapshotId: string;
  phase: "PREPARING" | "RUNNING" | "DONE" | "FAILED";
  error: string | null;
  durationMs: number | null;
  inputBytes: number | null;
  result: Pick<
    CostLearningResult,
    | "status"
    | "inputHash"
    | "resultHash"
    | "reasons"
    | "trainingLabel"
    | "learningAllowed"
    | "orderSubmissionAllowed"
    | "automaticResumeAllowed"
  > | null;
}

export class CostWebService {
  private worker: Worker | null = null;
  private activeId: string | null = null;
  private current: AppView | null = null;
  private verifyWorker: Worker | null = null;
  private verifyTimer: ReturnType<typeof setTimeout> | null = null;
  private job: VerifyJob | null = null;
  private downloads: Record<
    "financial" | "input" | "anchor" | "result",
    string
  > | null = null;
  private phase: "IDLE" | "PREPARING" | "READY" | "FAULT" = "IDLE";
  private busy = false;
  private closing = false;
  private lastMessageAt = 0;
  private verifiedFlat = new Set<string>();
  private pending = new Map<
    string,
    {
      resolve: (input?: {
        text: string;
        anchor: CostLearningInputAnchor;
      }) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(readonly root: string) {
    assertOffline(
      process.env.TRADING_MODE ?? "PAPER",
      process.env.LIVE_ENABLED ?? false,
    );
    if (existsSync(root) && lstatSync(root).isSymbolicLink())
      throw Error("COST_WEB_LINK_DENIED");
    mkdirSync(root, { recursive: true });
  }
  private directory(id: string) {
    const path = resolve(this.root, costWebRecordSchema.shape.id.parse(id));
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw Error("COST_WEB_LINK_DENIED");
    return path;
  }
  list() {
    const runs: CostWebRecord[] = [];
    let unreadable = 0;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!costWebRecordSchema.shape.id.safeParse(entry.name).success) continue;
      try {
        const path = resolve(this.directory(entry.name), "request.json"),
          stat = lstatSync(path);
        if (stat.isSymbolicLink() || stat.size > 2048)
          throw Error("COST_WEB_RECORD_INVALID");
        const r = costWebRecordSchema.parse(
          JSON.parse(readFileSync(path, "utf8")),
        );
        if (r.id !== entry.name) throw Error("COST_WEB_RECORD_MISMATCH");
        runs.push(r);
      } catch {
        unreadable++;
      }
    }
    return {
      runs: runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      unreadable,
    };
  }
  view() {
    const records = this.list();
    const workerStale =
      this.phase === "READY" && Date.now() - this.lastMessageAt > 5000;
    return {
      ...records,
      activeId: this.activeId,
      phase: this.phase,
      view: this.current,
      verification: this.job,
      workerStale,
      canCreate:
        !workerStale &&
        !this.closing &&
        !this.busy &&
        !["PREPARING", "FAULT"].includes(this.phase) &&
        !records.unreadable &&
        records.runs.length < 20 &&
        records.runs.every((r) => this.verifiedFlat.has(r.id)),
    };
  }
  async request(raw: unknown) {
    const request = costWebRequestSchema.parse(raw);
    if (this.closing) throw Error("COST_WEB_CLOSING");
    if (request.type === "verify") {
      if (
        request.runId !== this.activeId ||
        this.phase !== "READY" ||
        !this.current ||
        !("recipe" in this.current) ||
        this.current.capture?.snapshotId !== request.snapshotId
      )
        throw Error("COST_APP_CAPTURE_NOT_READY");
      if (
        this.job?.snapshotId === request.snapshotId &&
        this.job.runId === request.runId
      )
        return this.view();
      if (this.verifyWorker || this.job?.phase === "PREPARING")
        throw Error("COST_APP_VERIFY_BUSY");
      if (this.view().workerStale || this.pending.size >= 8)
        throw Error("COST_WEB_REQUEST_BUSY");
      this.job = {
        runId: request.runId,
        snapshotId: request.snapshotId,
        phase: "PREPARING",
        error: null,
        durationMs: null,
        inputBytes: null,
        result: null,
      };
      this.downloads = null;
      // Detached job: POST does not wait for full parsing/replay/RVOL work.
      void this.beginVerification(this.job);
      return this.view();
    }
    if (request.type === "control") {
      if (
        this.phase !== "READY" ||
        request.runId !== this.activeId ||
        !this.worker
      )
        throw Error("COST_WEB_NOT_READY");
      if (this.view().workerStale) throw Error("COST_WEB_WORKER_STALE");
      if (this.pending.size >= 8) throw Error("COST_WEB_REQUEST_BUSY");
      const token = randomUUID();
      await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => this.fault(), 20000);
        this.pending.set(token, { resolve, reject, timer });
        this.worker!.postMessage({ type: "control", token, command: request });
      });
      return this.view();
    }
    const id = request.type === "create" ? request.id : request.runId;
    const saved = this.list().runs.find((r) => r.id === id);
    const recipe =
      request.type === "create"
        ? (request.recipe ?? "COST_WEB_SYNTHETIC_KRW_V1")
        : saved?.recipe;
    // Check immutable recipe identity even for an already-active UUID retry.
    if (saved && request.type === "create" && saved.recipe !== recipe)
      throw Error("COST_WEB_RECIPE_CONFLICT");
    if (this.activeId === id && this.phase !== "FAULT") return this.view();
    if (this.busy || this.phase === "PREPARING")
      throw Error("COST_WEB_PREPARATION_BUSY");
    if (
      this.current &&
      (!this.current.safeToLeave || this.current.runtime.phase === "RUNNING") &&
      this.activeId !== id
    )
      throw Error("COST_WEB_UNRESOLVED_RUN");
    if (this.phase === "FAULT" && this.activeId !== id)
      throw Error("COST_WEB_REOPEN_ACTIVE_FIRST");
    const directory = this.directory(id),
      exists = existsSync(directory),
      create = request.type === "create" && !exists;
    if (request.type === "open" && !exists) throw Error("COST_WEB_RUN_MISSING");
    if (create && !this.view().canCreate)
      throw Error("COST_WEB_INSPECT_SAVED_RUNS_FIRST");
    if (!create && !this.list().runs.some((r) => r.id === id))
      throw Error("COST_WEB_RECORD_INVALID");
    this.busy = true;
    try {
      if (create) {
        mkdirSync(directory);
        writeFileSync(
          resolve(directory, "request.json"),
          JSON.stringify({
            id,
            createdAt: new Date().toISOString(),
            recipe,
          }),
          { flag: "wx", mode: 0o600 },
        );
      }
      await this.closeWorker();
      this.activeId = id;
      this.current = null;
      this.phase = "PREPARING";
      this.launch(directory, create, recipe!);
    } finally {
      this.busy = false;
    }
    return this.view();
  }
  private launch(
    directory: string,
    create: boolean,
    recipe: CostWebRecord["recipe"],
  ) {
    const worker = new Worker(
      pathToFileURL(resolve("dist/runtime/src/server/cost-web-worker.js")),
      { workerData: { directory, create, recipe } },
    );
    this.worker = worker;
    const startup = setTimeout(() => this.fault(), 180000);
    worker.on(
      "message",
      (m: {
        type: string;
        view?: AppView;
        input?: { text: string; anchor: CostLearningInputAnchor };
        token?: string;
        error?: string;
      }) => {
        if (worker !== this.worker) return;
        this.lastMessageAt = Date.now();
        if (m.type === "fatal") {
          clearTimeout(startup);
          this.fault();
          return;
        }
        if (m.type === "ready") {
          clearTimeout(startup);
          this.phase = "READY";
        }
        if (m.view) {
          this.current = m.view;
          if (m.view.safeToLeave) this.verifiedFlat.add(this.activeId!);
          else this.verifiedFlat.delete(this.activeId!);
        }
        if (m.type === "reply" && m.token) {
          const p = this.pending.get(m.token);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(m.token);
            if (m.error) p.reject(Error(m.error));
            else p.resolve(m.input);
          }
        }
      },
    );
    worker.on("error", () => {
      clearTimeout(startup);
      if (worker === this.worker) this.fault();
    });
    worker.on("exit", () => {
      clearTimeout(startup);
      if (worker === this.worker) this.fault();
    });
  }
  private async beginVerification(job: VerifyJob) {
    const started = Date.now();
    try {
      const token = randomUUID();
      const input = await new Promise<
        { text: string; anchor: CostLearningInputAnchor } | undefined
      >((resolve, reject) => {
        const timer = setTimeout(() => this.fault(), 20000);
        this.pending.set(token, { resolve, reject, timer });
        this.worker!.postMessage({ type: "capture", token });
      });
      if (!input || this.closing || this.job !== job)
        throw Error("COST_APP_VERIFY_CANCELLED");
      job.inputBytes = Buffer.byteLength(input.text);
      const worker = new Worker(
        pathToFileURL(
          resolve("dist/runtime/src/server/cost-app-verify-worker.js"),
        ),
        {
          workerData: input,
          resourceLimits: { maxOldGenerationSizeMb: 512 },
        },
      );
      this.verifyWorker = worker;
      job.phase = "RUNNING";
      const fail = (code: string) => {
        if (this.verifyWorker !== worker) return;
        job.phase = "FAILED";
        job.error = code;
        job.durationMs = Date.now() - started;
        if (this.verifyTimer) clearTimeout(this.verifyTimer);
        this.verifyTimer = null;
        this.verifyWorker = null;
        void worker.terminate();
      };
      this.verifyTimer = setTimeout(
        () => fail("COST_APP_VERIFY_TIMEOUT"),
        180000,
      );
      worker.on(
        "message",
        (m: {
          result?: CostLearningResult;
          error?: string;
          downloads?: NonNullable<CostWebService["downloads"]>;
        }) => {
          if (this.verifyWorker !== worker || this.job !== job) return;
          if (m.error || !m.result || !m.downloads) {
            fail(m.error ?? "COST_APP_VERIFY_FAILED");
            return;
          }
          const r = m.result;
          if (
            r.inputHash !== input.anchor.inputHash ||
            r.audit.financialExportHash !== input.anchor.operating.exportHash
          ) {
            fail("COST_APP_VERIFY_BINDING");
            return;
          }
          job.result = {
            status: r.status,
            inputHash: r.inputHash,
            resultHash: r.resultHash,
            reasons: r.reasons,
            trainingLabel: r.trainingLabel,
            learningAllowed: r.learningAllowed,
            orderSubmissionAllowed: r.orderSubmissionAllowed,
            automaticResumeAllowed: r.automaticResumeAllowed,
          };
          job.phase = "DONE";
          job.durationMs = Date.now() - started;
          this.downloads = m.downloads;
          if (this.verifyTimer) clearTimeout(this.verifyTimer);
          this.verifyTimer = null;
          this.verifyWorker = null;
        },
      );
      worker.on("error", () => fail("COST_APP_VERIFY_WORKER_FAILED"));
      worker.on("exit", () => fail("COST_APP_VERIFY_WORKER_EXITED"));
    } catch (e) {
      job.phase = "FAILED";
      job.error =
        e instanceof Error && /^[A-Z_0-9]+$/.test(e.message)
          ? e.message
          : "COST_APP_VERIFY_FAILED";
      job.durationMs = Date.now() - started;
    }
  }
  download(runId: string, snapshotId: string, artifact: string) {
    if (
      !this.downloads ||
      this.job?.phase !== "DONE" ||
      this.job.runId !== runId ||
      this.job.snapshotId !== snapshotId ||
      runId !== this.activeId ||
      !["financial", "input", "anchor", "result"].includes(artifact)
    )
      throw Error("COST_APP_DOWNLOAD_NOT_READY");
    // Exact bytes captured by the read-only verifier; no file path or JSON
    // parse on the HTTP lane and no file reread after verification (TOCTOU).
    return this.downloads[
      artifact as keyof NonNullable<CostWebService["downloads"]>
    ];
  }
  private fault() {
    this.phase = "FAULT";
    if (this.activeId) this.verifiedFlat.delete(this.activeId);
    const worker = this.worker;
    this.worker = null;
    if (worker) void worker.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("COST_WEB_WORKER_UNAVAILABLE"));
    }
    this.pending.clear();
  }
  private async closeWorker() {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        void worker.terminate().then(() => resolve());
      }, 5000);
      worker.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      worker.postMessage({ type: "close" });
    });
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("COST_WEB_CLOSED"));
    }
    this.pending.clear();
  }
  async close() {
    this.closing = true;
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = null;
    const verifier = this.verifyWorker;
    this.verifyWorker = null;
    if (verifier) await verifier.terminate();
    if (this.job && ["PREPARING", "RUNNING"].includes(this.job.phase)) {
      this.job.phase = "FAILED";
      this.job.error = "COST_APP_VERIFY_CANCELLED";
    }
    await this.closeWorker();
  }
}
export type CostWebResponse = ReturnType<CostWebService["view"]>;
