import { hash, verifyPolicies } from "../core/policy.js";
import {
  newAnalysisJob,
  verifyAnalysisResult,
} from "../core/codex-analysis.js";
import {
  analysisCommandSchema,
  type AnalysisJob,
  type AnalysisView,
} from "../core/codex-analysis-schema.js";
import { AnalysisStore } from "./codex-analysis-store.js";
import { localAnalysisMock, type AnalysisMock } from "./codex-analysis-mock.js";
import type { AnalysisRecordSources } from "./analysis-record-source.js";
import type { AnalysisProcessRunner } from "./analysis-process.js";

const active = (j: AnalysisJob) =>
  ["AWAITING_APPROVAL", "APPROVED", "RUNNING"].includes(j.state);
function finish(
  j: AnalysisJob,
  state: AnalysisJob["state"],
  error: AnalysisJob["error"],
  now: number,
) {
  j.state = state;
  j.error = error;
  j.finishedAt = new Date(now).toISOString();
}
export class CodexAnalysisService {
  private store: AnalysisStore;
  private closed = false;
  private fault: string | null = null;
  private controllers = new Map<string, AbortController>();
  private work = new Set<Promise<void>>();
  constructor(
    path: string,
    private mock: AnalysisMock = localAnalysisMock,
    private now = Date.now,
    private records?: AnalysisRecordSources,
    private runner?: AnalysisProcessRunner,
  ) {
    verifyPolicies();
    this.store = new AnalysisStore(path);
    try {
      this.store.update((jobs) => {
        for (const j of jobs.filter(active))
          finish(
            j,
            j.state === "RUNNING" ? "INTERRUPTED" : "CANCELLED",
            "RESTART_REQUIRES_NEW_REQUEST",
            this.now(),
          );
      }, this.now());
    } catch (e) {
      this.store.close();
      throw e;
    }
  }
  private refresh() {
    if (this.closed) throw new Error("ANALYSIS_CLOSED");
    if (this.fault) throw new Error(this.fault);
    try {
      verifyPolicies();
      this.store.update((jobs) => {
        for (const j of jobs)
          if (
            ["AWAITING_APPROVAL", "APPROVED"].includes(j.state) &&
            this.now() >= Date.parse(j.request.expiresAt)
          )
            finish(j, "EXPIRED", "APPROVAL_EXPIRED", this.now());
      }, this.now());
    } catch {
      this.fault = "ANALYSIS_STORE_OR_POLICY_FAILED";
      throw new Error(this.fault);
    }
  }
  view(): AnalysisView {
    try {
      this.refresh();
      const jobs = this.store.list();
      return {
        mode: "MOCK_ONLY",
        jobs: jobs.toReversed(),
        mockCalls: jobs.reduce((n, j) => n + j.calls, 0),
        externalCalls: 0,
        automaticApplication: false,
        error: null,
      };
    } catch {
      return {
        mode: "MOCK_ONLY",
        jobs: [],
        mockCalls: null,
        externalCalls: 0,
        automaticApplication: false,
        error: this.fault ?? "ANALYSIS_UNAVAILABLE",
      };
    }
  }
  request(raw: unknown): AnalysisView {
    const c = analysisCommandSchema.parse(raw);
    this.refresh();
    let launch = false;
    this.store.update((jobs) => {
      if (c.type === "create" || c.type === "create-record") {
        const previous = jobs.find((j) => j.request.id === c.id);
        if (previous) {
          const b = previous.request.bundle;
          if (
            c.type === "create"
              ? b.version !== "MOCK_ANALYSIS_BUNDLE_V1"
              : b.version !== "ENGINE_RECORD_ANALYSIS_BUNDLE_V1" ||
                b.source.id !== c.sourceId ||
                Date.parse(b.periodStart) !== Date.parse(c.period.from) ||
                Date.parse(b.asOf) !== Date.parse(c.period.to)
          )
            throw new Error("ANALYSIS_CREATE_CONFLICT");
          return;
        }
        if (jobs.some(active)) throw new Error("ANALYSIS_REQUEST_ACTIVE");
        if (jobs.length >= 100) throw new Error("ANALYSIS_JOB_LIMIT");
        const bundle =
          c.type === "create-record"
            ? this.recordSources().bundle(c.sourceId, c.period)
            : undefined;
        jobs.push(
          newAnalysisJob(c.id, this.now(), bundle, this.runner?.binding),
        );
        return;
      }
      const j = jobs.find((j) => j.request.id === c.id);
      if (!j) throw new Error("ANALYSIS_NOT_FOUND");
      if (j.requestHash !== c.requestHash)
        throw new Error("ANALYSIS_APPROVAL_MISMATCH");
      if (
        (c.type === "approve" || c.type === "run") &&
        j.calls === 0 &&
        j.request.bundle.version === "ENGINE_RECORD_ANALYSIS_BUNDLE_V1"
      )
        this.recordSources().verify(j.request.bundle);
      if (c.type === "cancel") {
        if (active(j)) finish(j, "CANCELLED", "USER_CANCELLED", this.now());
      } else if (c.type === "approve") {
        if (j.state === "APPROVED") return;
        if (j.state !== "AWAITING_APPROVAL")
          throw new Error("ANALYSIS_NOT_AWAITING_APPROVAL");
        j.approvedHash = j.requestHash;
        j.approvedAt = new Date(this.now()).toISOString();
        j.state = "APPROVED";
      } else {
        if (j.calls === 1) return; // 상태 조회만 수행하며 실패/취소 후에도 재호출하지 않는다.
        if (j.state !== "APPROVED" || j.approvedHash !== j.requestHash)
          throw new Error("ANALYSIS_APPROVAL_REQUIRED");
        if (
          j.request.execution &&
          hash(j.request.execution) !== hash(this.runner?.binding ?? null)
        )
          throw new Error("ANALYSIS_EXECUTION_BINDING");
        j.calls = 1;
        j.startedAt = new Date(this.now()).toISOString();
        j.state = "RUNNING";
        launch = true;
      }
    }, this.now());
    if (c.type === "cancel") this.controllers.get(c.id)?.abort();
    if (launch) {
      const task = this.execute(c.id);
      this.work.add(task);
      void task.finally(() => this.work.delete(task));
    }
    return this.view();
  }
  private recordSources() {
    if (!this.records) throw new Error("ANALYSIS_RECORDS_UNAVAILABLE");
    return this.records;
  }
  listRecords() {
    this.refresh();
    return this.recordSources().list();
  }
  inspectRecord(raw: unknown) {
    this.refresh();
    return this.recordSources().inspect(raw);
  }
  private async execute(id: string) {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const j = this.store.list().find((j) => j.request.id === id)!;
      const abort = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("ABORTED")),
          { once: true },
        );
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, j.request.budget.timeoutMs);
      });
      const output = await Promise.race([
        Promise.resolve().then(() =>
          j.request.execution
            ? this.runner!.execute(
                structuredClone(j.request),
                controller.signal,
              )
            : this.mock(structuredClone(j.request), controller.signal),
        ),
        abort,
      ]);
      if (this.closed) return;
      if (j.request.bundle.version === "ENGINE_RECORD_ANALYSIS_BUNDLE_V1")
        this.recordSources().verify(j.request.bundle);
      this.store.update((jobs) => {
        const current = jobs.find((x) => x.request.id === id)!;
        if (current.state !== "RUNNING") return;
        if (
          this.now() - Date.parse(current.startedAt!) >=
          current.request.budget.timeoutMs
        ) {
          finish(current, "TIMED_OUT", "TIMEOUT", this.now());
          return;
        }
        // raw 문서는 명시 크기 이내만 보존하며 오류 본문/스택을 사용자에게 전파하지 않는다.
        current.rawOutput =
          typeof output === "string" && Buffer.byteLength(output) <= 16384
            ? output
            : null;
        try {
          if (current.rawOutput === null) throw new Error("INVALID_RESULT");
          const result = verifyAnalysisResult(
            current.rawOutput,
            current,
            this.now(),
          );
          current.result = result;
          current.resultHash = hash(result);
          finish(current, "VERIFIED_MOCK", null, this.now());
        } catch {
          finish(current, "REJECTED", "INVALID_RESULT", this.now());
        }
      }, this.now());
    } catch {
      if (!this.closed) {
        try {
          this.store.update((jobs) => {
            const j = jobs.find((j) => j.request.id === id)!;
            if (j.state === "RUNNING")
              finish(
                j,
                timedOut ? "TIMED_OUT" : "FAILED",
                timedOut ? "TIMEOUT" : "MOCK_FAILURE",
                this.now(),
              );
          }, this.now());
        } catch {
          this.fault = "ANALYSIS_STORE_OR_POLICY_FAILED";
        }
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(id);
    }
  }
  async idle() {
    await Promise.all(this.work);
    await this.runner?.idle();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.controllers.values()) c.abort();
    try {
      this.store.update((jobs) => {
        for (const j of jobs.filter(active))
          finish(
            j,
            j.calls ? "INTERRUPTED" : "CANCELLED",
            "SHUTDOWN_INTERRUPTED",
            this.now(),
          );
      }, this.now());
    } finally {
      await this.idle();
      this.store.close();
    }
  }
}
