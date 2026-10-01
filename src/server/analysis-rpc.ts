import { z } from "zod";
import { TextDecoder } from "node:util";
import type { AnalysisRequest } from "../core/codex-analysis-schema.js";

// 의도적으로 제한된 공식 문서 기반 부분집합. 실서버의 모든 확장/이벤트 호환을 주장하지 않는다.
export class AnalysisJsonLines {
  private pending = Buffer.alloc(0);
  private bytes = 0;
  private lines = 0;
  constructor(
    private receive: (message: unknown) => void,
    private limit = 256 * 1024,
  ) {}
  push(chunk: Buffer) {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) throw new Error("ANALYSIS_RPC_SIZE");
    this.pending = Buffer.concat([this.pending, chunk]);
    let end: number;
    while ((end = this.pending.indexOf(10)) !== -1) {
      const line = this.pending.subarray(0, end);
      this.pending = this.pending.subarray(end + 1);
      if (++this.lines > 16 || !line.length || line.length > 192 * 1024)
        throw new Error("ANALYSIS_RPC_FRAME");
      this.receive(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)),
      );
    }
    if (this.pending.length > 192 * 1024) throw new Error("ANALYSIS_RPC_FRAME");
  }
  end() {
    if (this.pending.length) throw new Error("ANALYSIS_RPC_TRUNCATED");
  }
}
const thread = z.strictObject({ id: z.literal("mock_thread") });
const turn = (status: "inProgress" | "completed") =>
  z.strictObject({
    id: z.literal("mock_turn"),
    status: z.literal(status),
    items: z.array(z.never()).length(0),
    error: z.null(),
  });
const response = (id: number, result: z.ZodType) =>
  z.strictObject({ id: z.literal(id), result });
const notice = (method: string, params: z.ZodType) =>
  z.strictObject({ method: z.literal(method), params });

export class AnalysisRpcSession {
  private step = 0;
  private output: string | null = null;
  private finished = false;
  constructor(
    private q: AnalysisRequest,
    private send: (v: unknown) => void,
  ) {}
  start() {
    this.send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "paper_lab_mock_client",
          title: "Offline paper review",
          version: "1.0.0",
        },
        capabilities: { experimentalApi: false },
      },
    });
  }
  receive(raw: unknown) {
    if (this.finished) throw new Error("ANALYSIS_RPC_AFTER_COMPLETE");
    // 서버가 파일/명령/인증/권한 등 클라이언트 행동을 요구해도 수행하지 않는다.
    const request = z
      .object({
        id: z.union([z.number().int(), z.string().max(100)]),
        method: z.string(),
      })
      .safeParse(raw);
    if (request.success) {
      this.send({
        id: request.data.id,
        error: {
          code: -32601,
          message: "Client actions disabled in local mock",
        },
      });
      throw new Error("ANALYSIS_RPC_ACTION_DENIED");
    }
    if (this.step === 0) {
      response(
        1,
        z.strictObject({
          userAgent: z.literal("paper-lab-restricted-mock/1"),
          platformFamily: z.literal("windows"),
          platformOs: z.literal("win32"),
        }),
      ).parse(raw);
      this.send({ method: "initialized" });
      this.send({
        id: 2,
        method: "thread/start",
        params: { approvalPolicy: "never", sandbox: "read-only" },
      });
    } else if (this.step === 1) {
      response(2, z.strictObject({ thread })).parse(raw);
    } else if (this.step === 2) {
      notice("thread/started", z.strictObject({ thread })).parse(raw);
      this.send({
        id: 3,
        method: "turn/start",
        params: {
          threadId: "mock_thread",
          input: [{ type: "text", text: JSON.stringify(this.q) }],
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        },
      });
    } else if (this.step === 3) {
      response(3, z.strictObject({ turn: turn("inProgress") })).parse(raw);
    } else if (this.step === 4) {
      notice(
        "turn/started",
        z.strictObject({
          threadId: z.literal("mock_thread"),
          turn: turn("inProgress"),
        }),
      ).parse(raw);
    } else if (this.step === 5) {
      const r = notice(
        "item/completed",
        z.strictObject({
          threadId: z.literal("mock_thread"),
          turnId: z.literal("mock_turn"),
          item: z.strictObject({
            id: z.literal("mock_item"),
            type: z.literal("agentMessage"),
            text: z.string().max(16384),
            phase: z.literal("final_answer"),
          }),
        }),
      ).parse(raw) as { params: { item: { text: string } } };
      this.output = r.params.item.text;
    } else if (this.step === 6) {
      notice(
        "turn/completed",
        z.strictObject({
          threadId: z.literal("mock_thread"),
          turn: turn("completed"),
        }),
      ).parse(raw);
      this.finished = true;
    } else throw new Error("ANALYSIS_RPC_SEQUENCE");
    this.step++;
  }
  interrupt() {
    if (this.step >= 4 && !this.finished)
      this.send({
        id: 4,
        method: "turn/interrupt",
        params: { threadId: "mock_thread", turnId: "mock_turn" },
      });
  }
  result() {
    if (!this.finished || this.output === null)
      throw new Error("ANALYSIS_RPC_INCOMPLETE");
    return this.output;
  }
}
