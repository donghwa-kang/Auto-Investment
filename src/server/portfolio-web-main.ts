import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Engine } from "./engine.js";
import { createApp } from "./http.js";
import { PortfolioWebService } from "./portfolio-web-service.js";
import { CodexAnalysisService } from "./codex-analysis-service.js";
import { AnalysisRecordSources } from "./analysis-record-source.js";
import { RestrictedAnalysisProcess } from "./analysis-process.js";
import { CostWebService } from "./cost-web-service.js";

if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("NODE_24_REQUIRED");
if (!existsSync("dist/web/index.html")) throw new Error("BUILD_REQUIRED");
const root = resolve(process.env.PORTFOLIO_WEB_ROOT ?? "data/portfolio-web");
const port = Number(process.env.PORTFOLIO_WEB_PORT ?? 4184);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORTFOLIO_WEB_PORT_INVALID");
mkdirSync(root, { recursive: true });
// 기존 앱의 DB 및 pairing 파일과 독립적이다. legacy 화면도 이 폴더의 별도 DB만 사용한다.
const engine = new Engine(resolve(root, "legacy.sqlite"));
const portfolio = new PortfolioWebService(resolve(root, "runs"));
const cost = new CostWebService(resolve(root, "cost-runs"));
let analysis: CodexAnalysisService | undefined;
try {
  analysis = new CodexAnalysisService(
    resolve(root, "codex-analysis", "mock.sqlite"),
    undefined,
    Date.now,
    new AnalysisRecordSources(
      resolve(process.env.PORTFOLIO_RECORDS_ROOT ?? "data/paper-learning-runs"),
      resolve(root, "codex-analysis", "sources"),
    ),
    new RestrictedAnalysisProcess(
      resolve(root, "codex-analysis", "executions"),
    ),
  );
} catch {
  console.error(
    "Codex 모형 분석 비활성: Windows·Node 24.20.0·빌드/전용 저장소/정책 확인 필요. 거래 엔진과 독립된 오류입니다.",
  );
}
let closing = false;
const pairingPath = resolve(root, "local-pairing.txt");
const app = createApp(engine, undefined, {
  portfolio,
  analysis,
  cost,
  shutdown,
});
let url: string;
try {
  url = await app.listen(port);
} catch (e) {
  await analysis?.close();
  await portfolio.close();
  await cost.close();
  engine.close();
  throw e;
}
writeFileSync(
  pairingPath,
  `로컬 모의매매 연결 코드 (5분/1회, 외부 API 키가 아님):\n${app.code}\n`,
  { mode: 0o600 },
);
console.log(
  `오프라인 다종목: ${url}/?view=portfolio\n연결 코드 파일: ${pairingPath}\n실제 계좌·시세·주문 연결 없음`,
);
const timer = setInterval(() => {
  void engine.tick();
}, 1000);
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await app.close();
  try {
    await analysis?.close();
  } catch {
    process.exitCode = 1;
  }
  await portfolio.close();
  await cost.close();
  try {
    engine.close();
  } catch {
    process.exitCode = 1;
  }
  writeFileSync(
    pairingPath,
    "연결 코드 만료. 서버 재실행 후 새 코드를 확인하세요.\n",
    { mode: 0o600 },
  );
}
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
