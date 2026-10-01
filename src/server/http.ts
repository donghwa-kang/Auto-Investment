import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { z } from "zod";
import type { Engine } from "./engine.js";
import type { PortfolioWebService } from "./portfolio-web-service.js";
import type { CodexAnalysisService } from "./codex-analysis-service.js";
import type { CostWebService } from "./cost-web-service.js";
const eq = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loginSchema = z.object({ code: z.string().min(10).max(128) }).strict();
const envelope = z
  .object({ id: z.string().max(100), command: z.unknown() })
  .strict();
export function createApp(
  engine: Engine,
  code = randomBytes(24).toString("base64url"),
  options: {
    shutdown?: () => Promise<void>;
    portfolio?: PortfolioWebService;
    analysis?: CodexAnalysisService;
    cost?: CostWebService;
  } = {},
) {
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const cookieName = options.portfolio ? "portfolio_session" : "paper_session";
  let port = 0,
    used = false,
    attempts = 0;
  const created = Date.now();
  const publicRoot = resolve("dist/web");
  const server = createServer((req, res) => {
    void route(req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = error instanceof Error ? error.message : "요청 실패";
      const internal =
        /SQLITE|disk|database|FENCED|STATE_CHECKSUM|AUDIT_CHAIN/.test(message);
      if (internal) engine.runtimeError = "STORAGE_FAILURE";
      respond(res, internal ? 503 : 400, {
        error: internal
          ? "저장소 오류. 신규 거래 차단, 대조 필요"
          : message.slice(0, 240),
      });
    });
  });
  function respond(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  }
  async function body(req: IncomingMessage) {
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      throw new Error("JSON_REQUIRED");
    let data = "";
    for await (const chunk of req) {
      data += String(chunk);
      if (Buffer.byteLength(data) > 8192) throw new Error("BODY_TOO_LARGE");
    }
    return JSON.parse(data) as unknown;
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    const origin = `http://127.0.0.1:${port}`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (req.headers.host !== `127.0.0.1:${port}`) {
      respond(res, 403, { error: "HOST_DENIED" });
      return;
    }
    const path = new URL(req.url ?? "/", origin).pathname;
    if (req.headers.origin && req.headers.origin !== origin) {
      respond(res, 403, { error: "ORIGIN_DENIED" });
      return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      respond(res, 405, { error: "METHOD_DENIED" });
      return;
    }
    if (req.method === "POST" && req.headers.origin !== origin) {
      respond(res, 403, { error: "ORIGIN_REQUIRED" });
      return;
    }
    if (path === "/api/health" && req.method === "GET") {
      respond(res, 200, { ok: true, mode: "OFFLINE_ONLY", live: false });
      return;
    }
    if (path === "/api/login" && req.method === "POST") {
      const input = loginSchema.parse(await body(req));
      attempts++;
      if (
        used ||
        attempts > 10 ||
        Date.now() - created > 300000 ||
        !eq(input.code, code)
      ) {
        respond(res, 401, {
          error: "연결 코드 오류/만료. 엔진 재시작으로 새 코드를 발급하세요.",
        });
        return;
      }
      used = true;
      const id = randomBytes(32).toString("base64url"),
        csrf = randomBytes(32).toString("base64url");
      sessions.set(id, { csrf, expires: Date.now() + 8 * 3600000 });
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      );
      respond(res, 200, { csrf });
      return;
    }
    if (path.startsWith("/api/")) {
      const id = req.headers.cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      const current = id ? sessions.get(id) : undefined;
      if (!current || current.expires < Date.now()) {
        respond(res, 401, { error: "로컬 연결 인증 필요" });
        return;
      }
      if (path === "/api/session" && req.method === "GET") {
        respond(res, 200, { csrf: current.csrf });
        return;
      }
      if (path === "/api/state" && req.method === "GET") {
        respond(res, 200, engine.view());
        return;
      }
      if (path === "/api/codex-analysis" || path === "/api/codex-records") {
        // 분석 저장/검증 실패는 거래 엔진의 오류 처리와 분리한다.
        if (!options.analysis) {
          respond(res, 503, { error: "ANALYSIS_UNAVAILABLE" });
          return;
        }
        if (req.method === "GET") {
          if (path === "/api/codex-records") {
            try {
              respond(res, 200, options.analysis.listRecords());
            } catch {
              respond(res, 503, { error: "ANALYSIS_RECORDS_UNAVAILABLE" });
            }
            return;
          }
          const view = options.analysis.view();
          respond(res, view.error ? 503 : 200, view);
          return;
        }
        if (req.headers["x-csrf-token"] !== current.csrf) {
          respond(res, 403, { error: "CSRF_DENIED" });
          return;
        }
        try {
          if (path === "/api/codex-records") {
            respond(res, 200, options.analysis.inspectRecord(await body(req)));
            return;
          }
          const view = options.analysis.request(await body(req));
          respond(res, view.error ? 503 : 200, view);
        } catch (e) {
          respond(res, 409, {
            error:
              e instanceof Error && /^ANALYSIS_[A-Z_]+$/.test(e.message)
                ? e.message
                : "ANALYSIS_REQUEST_REJECTED",
          });
        }
        return;
      }
      if (path === "/api/cost-lab/download" && req.method === "GET") {
        try {
          if (!options.cost) throw Error("COST_WEB_UNAVAILABLE");
          const query = new URL(req.url!, origin).searchParams;
          const text = options.cost.download(
            query.get("runId") ?? "",
            query.get("snapshotId") ?? "",
            query.get("artifact") ?? "",
          );
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="synthetic-cost-evidence.json"',
          });
          res.end(text);
        } catch {
          respond(res, 409, { error: "COST_APP_DOWNLOAD_NOT_READY" });
        }
        return;
      }
      if (path === "/api/cost-lab") {
        if (!options.cost) {
          respond(res, 503, { error: "COST_WEB_UNAVAILABLE" });
          return;
        }
        if (
          req.method === "POST" &&
          req.headers["x-csrf-token"] !== current.csrf
        ) {
          respond(res, 403, { error: "CSRF_DENIED" });
          return;
        }
        try {
          respond(
            res,
            200,
            req.method === "GET"
              ? options.cost.view()
              : await options.cost.request(await body(req)),
          );
        } catch (e) {
          const error =
            e instanceof Error && /^[A-Z_0-9]+$/.test(e.message)
              ? e.message
              : "COST_WEB_REQUEST_REJECTED";
          respond(res, error === "COST_WEB_WORKER_UNAVAILABLE" ? 503 : 409, {
            error,
          });
        }
        return;
      }
      if (path === "/api/portfolio" && options.portfolio) {
        if (req.method === "GET") {
          respond(res, 200, options.portfolio.view());
          return;
        }
        if (req.headers["x-csrf-token"] !== current.csrf) {
          respond(res, 403, { error: "CSRF_DENIED" });
          return;
        }
        try {
          respond(res, 200, await options.portfolio.request(await body(req)));
        } catch (e) {
          const code =
            e instanceof Error && /^[A-Z_0-9]+$/.test(e.message)
              ? e.message
              : "WEB_REQUEST_REJECTED";
          respond(res, 409, { error: code });
        }
        return;
      }
      if (path === "/api/audit" && req.method === "GET") {
        const value = new URL(req.url!, origin).searchParams.get("page") ?? "0";
        if (!/^\d{1,6}$/.test(value)) throw new Error("INVALID_PAGE");
        respond(res, 200, engine.repo.events(Number(value)));
        return;
      }
      if (path === "/api/command" && req.method === "POST") {
        if (req.headers["x-csrf-token"] !== current.csrf) {
          respond(res, 403, { error: "CSRF_DENIED" });
          return;
        }
        const input = envelope.parse(await body(req));
        if (
          typeof input.command === "object" &&
          input.command !== null &&
          "type" in input.command &&
          input.command.type === "shutdown"
        ) {
          z.object({ type: z.literal("shutdown"), confirm: z.literal(true) })
            .strict()
            .parse(input.command);
          if (!options.shutdown) {
            respond(res, 409, {
              error:
                "이 내장 시험 서버는 호스트 종료 기능을 제공하지 않습니다.",
            });
            return;
          }
          await engine.command(input.id, { type: "pause" });
          respond(res, 202, {
            status:
              "SHUTDOWN_REQUESTED: 저장 후 엔진 종료. 전량 청산을 뜻하지 않음",
          });
          setImmediate(() => {
            void options.shutdown!().catch(() => {
              engine.runtimeError = "SHUTDOWN_FAILURE";
            });
          });
          return;
        }
        const state = await engine.command(input.id, input.command);
        respond(res, 200, { status: state.status, revision: state.revision });
        return;
      }
      respond(res, 404, { error: "NOT_FOUND" });
      return;
    }
    if (req.method !== "GET") {
      respond(res, 405, { error: "METHOD_DENIED" });
      return;
    }
    const file =
      path === "/"
        ? resolve(publicRoot, "index.html")
        : path.startsWith("/assets/") &&
            /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)
          ? resolve(publicRoot, `.${path}`)
          : null;
    if (!file) {
      respond(res, 404, { error: "NOT_FOUND" });
      return;
    }
    try {
      const data = readFileSync(file);
      res.setHeader(
        "Content-Type",
        extname(file) === ".js"
          ? "text/javascript; charset=utf-8"
          : extname(file) === ".css"
            ? "text/css; charset=utf-8"
            : "text/html; charset=utf-8",
      );
      res.end(data);
    } catch {
      respond(res, 404, {
        error: "화면 빌드가 없습니다. npm run build 실행 후 다시 시작하세요.",
      });
    }
  }
  return {
    server,
    code,
    listen: async (requestedPort = 4173) => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(requestedPort, "127.0.0.1", () => resolve());
      });
      port = (server.address() as { port: number }).port;
      return `http://127.0.0.1:${port}`;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        sessions.clear();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
