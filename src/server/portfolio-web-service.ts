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
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  runIdSchema,
  webRequestSchema,
  webSetupSchema,
  type WebSetup,
} from "../core/portfolio-web-schema.js";
import { assertOffline, hash } from "../core/policy.js";
import type { PortfolioWebView } from "./portfolio-web-run.js";

const requestSchema = z.strictObject({
  id: runIdSchema,
  createdAt: z.string().datetime(),
  setup: webSetupSchema,
});
export type WebRunRecord = z.infer<typeof requestSchema>;
export class PortfolioWebService {
  private worker: Worker | null = null;
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }[]
  >();
  private busy = false;
  private closing = false;
  private activeId: string | null = null;
  private current: PortfolioWebView | null = null;
  private phase: "IDLE" | "PREPARING" | "READY" | "ERROR" = "IDLE";
  constructor(
    readonly root: string,
    private intervalMs = 1000,
  ) {
    assertOffline(
      process.env.TRADING_MODE ?? "PAPER",
      process.env.LIVE_ENABLED ?? false,
    );
    mkdirSync(root, { recursive: true });
  }
  private directory(id: string) {
    const p = resolve(this.root, runIdSchema.parse(id));
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw new Error("WEB_RUN_LINK_DENIED");
    return p;
  }
  private record(id: string) {
    const path = resolve(this.directory(id), "request.json");
    if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 8192)
      throw new Error("WEB_REQUEST_INVALID");
    const record = requestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (record.id !== id) throw new Error("WEB_RUN_ID_MISMATCH");
    return record;
  }
  list() {
    const records: WebRunRecord[] = [];
    let unreadable = 0;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!runIdSchema.safeParse(entry.name).success) continue;
      try {
        records.push(this.record(entry.name));
      } catch {
        unreadable++;
      }
    }
    return {
      runs: records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      unreadable,
    };
  }
  view() {
    return {
      ...this.list(),
      activeId: this.activeId,
      phase: this.phase,
      view: this.current,
    };
  }
  async request(raw: unknown) {
    const request = webRequestSchema.parse(raw);
    if (this.closing) throw new Error("WEB_CLOSING");
    if (request.type === "control") {
      if (
        request.runId !== this.activeId ||
        this.phase !== "READY" ||
        !this.worker
      )
        throw new Error("WEB_RUN_NOT_READY");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.rejectAll("WEB_WORKER_TIMEOUT");
          this.phase = "ERROR";
          void this.worker?.terminate();
        }, 15000);
        const token = randomUUID();
        this.pending.set(token, [{ resolve, reject, timer }]);
        this.worker!.postMessage({
          type: "control",
          id: token,
          commandId: request.id,
          action: request.action,
        });
      });
    }
    const id = request.type === "create" ? request.id : request.runId;
    if (this.activeId === id) {
      if (
        request.type === "create" &&
        hash(this.record(id).setup) !== hash(request.setup)
      )
        throw new Error("COMMAND_ID_CONFLICT");
      if (this.phase !== "ERROR") return this.view();
    }
    if (this.busy || this.phase === "PREPARING")
      throw new Error("WEB_PREPARATION_BUSY");
    if (
      this.phase !== "ERROR" &&
      this.current &&
      (this.current.playing ||
        this.current.exposureCount ||
        this.current.pendingCount)
    )
      throw new Error("WEB_ACTIVE_EXPOSURE_OR_REPLAY");
    if (this.phase === "ERROR" && this.activeId !== id)
      throw new Error("WEB_REOPEN_ACTIVE_FIRST");
    if (this.list().unreadable) throw new Error("WEB_STORAGE_REVIEW_REQUIRED");
    this.busy = true;
    try {
      let record: WebRunRecord;
      let create = false;
      const directory = this.directory(id);
      if (request.type === "create" && !existsSync(directory)) {
        if (this.list().runs.length >= 20) throw new Error("WEB_RUN_LIMIT_20");
        mkdirSync(directory);
        record = {
          id,
          createdAt: new Date().toISOString(),
          setup: request.setup,
        };
        writeFileSync(
          resolve(directory, "request.json"),
          JSON.stringify(record),
          { flag: "wx", mode: 0o600 },
        );
        create = true;
      } else {
        record = this.record(id);
        if (
          request.type === "create" &&
          hash(record.setup) !== hash(request.setup)
        )
          throw new Error("COMMAND_ID_CONFLICT");
      }
      await this.closeWorker();
      this.activeId = id;
      this.current = null;
      this.phase = "PREPARING";
      this.launch(directory, record.setup, create);
      return this.view();
    } finally {
      this.busy = false;
    }
  }
  private launch(directory: string, setup: WebSetup, create: boolean) {
    const worker = new Worker(
      pathToFileURL(resolve("dist/runtime/src/server/portfolio-web-worker.js")),
      { workerData: { directory, setup, create, intervalMs: this.intervalMs } },
    );
    this.worker = worker;
    const timeout = setTimeout(() => {
      this.phase = "ERROR";
      void worker.terminate();
    }, 180000);
    worker.on(
      "message",
      (m: {
        type: string;
        view?: PortfolioWebView;
        id?: string;
        error?: string;
      }) => {
        if (worker !== this.worker) return;
        if (m.type === "fatal") {
          clearTimeout(timeout);
          this.phase = "ERROR";
          this.rejectAll("WEB_WORKER_FAILED");
          return;
        }
        if (m.type === "ready") {
          clearTimeout(timeout);
          this.phase = "READY";
        }
        if (m.view) {
          this.current = m.view;
          if (m.view.error) this.phase = "ERROR";
        }
        if (m.type === "reply" && m.id) {
          const waiting = this.pending.get(m.id) ?? [];
          this.pending.delete(m.id);
          for (const p of waiting) {
            clearTimeout(p.timer);
            if (m.error) p.reject(new Error(m.error));
            else p.resolve(this.view());
          }
        }
      },
    );
    worker.on("error", () => {
      clearTimeout(timeout);
      if (worker === this.worker) {
        this.phase = "ERROR";
        this.rejectAll("WEB_WORKER_FAILED");
      }
    });
    worker.on("exit", () => {
      clearTimeout(timeout);
      if (worker === this.worker) {
        this.phase = "ERROR";
        this.rejectAll("WEB_WORKER_EXITED");
      }
    });
  }
  private rejectAll(code: string) {
    for (const a of this.pending.values())
      for (const p of a) {
        clearTimeout(p.timer);
        p.reject(new Error(code));
      }
    this.pending.clear();
  }
  private async closeWorker() {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.rejectAll("WEB_WORKER_CLOSED");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void worker.terminate().then(() => resolve());
      }, 5000);
      worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      worker.postMessage({ type: "close" });
    });
  }
  async close() {
    this.closing = true;
    await this.closeWorker();
  }
}
export type PortfolioWebResponse = ReturnType<PortfolioWebService["view"]>;
