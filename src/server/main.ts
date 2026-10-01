import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { Engine } from "./engine.js";
import { createApp } from "./http.js";
if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("검증 대상 Node.js 24 LTS가 필요합니다.");
if (!existsSync("dist/web/index.html"))
  throw new Error("먼저 npm run build를 실행하세요.");
const port = Number(process.env.PAPER_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PAPER_PORT 오류");
const engine = new Engine(resolve(process.env.PAPER_DB ?? "data/paper.sqlite"));
const app = createApp(engine, undefined, { shutdown });
const url = await app.listen(port);
// 연결 코드는 일반 로그/URL에 출력하지 않는다. 로컬 사용자만 읽는 짧은 수명의 파일이다.
mkdirSync("data", { recursive: true });
const pairingPath = resolve("data/local-pairing.txt");
writeFileSync(
  pairingPath,
  `로컬 연결 코드 (5분/1회 유효, 외부에 공유하지 마세요):\n${app.code}\n`,
  { mode: 0o600 },
);
chmodSync(pairingPath, 0o600);
console.log(
  `오프라인 PAPER: ${url}\n로컬 연결 코드는 data/local-pairing.txt에서 확인하세요. 실제 계좌·AI 키는 필요하지 않습니다.`,
);
const timer = setInterval(() => {
  void engine.tick();
}, 1000);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await app.close();
  try {
    engine.close();
  } catch {
    console.error("종료 저장 실패. 다음 시작에서 대조가 필요합니다.");
    process.exitCode = 1;
  }
  writeFileSync(pairingPath, "연결 코드 만료. 다음 실행에서 재발급합니다.\n", {
    mode: 0o600,
  });
}
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
