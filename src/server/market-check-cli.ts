import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertOffline } from "../core/policy.js";
import {
  MarketDataError,
  readCredentials,
  TossMarketData,
} from "./toss-market-data.js";
import { runMarketCheck } from "./market-paper-check.js";

// 실행할 때마다 사용자의 명시적 연결 설정 필요. 키/토큰은 환경변수에 넣지 않는다.
async function main() {
  assertOffline(
    process.env.TRADING_MODE ?? "PAPER",
    process.env.LIVE_ENABLED ?? false,
  );
  if (process.env.TOSS_MARKET_DATA_ONLY !== "true")
    throw new MarketDataError("EXPLICIT_MARKET_DATA_ONLY_REQUIRED");
  const credentialPath = process.env.TOSS_CREDENTIAL_FILE;
  if (!credentialPath) throw new MarketDataError("CREDENTIAL_PATH_REQUIRED");
  const report = await runMarketCheck(
    new TossMarketData(),
    readCredentials(credentialPath),
  );
  mkdirSync("data/market-checks", { recursive: true });
  const path = resolve(
    `data/market-checks/${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
  );
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      connectionStatus: report.connectionStatus,
      failure: report.failure,
      decisions: report.decisions,
      realOrdersEnabled: false,
      paperOrderCount: report.paperOrders.length,
      requests: report.requests,
      reportPath: path,
    }),
  );
  if (report.failure) process.exitCode = 1;
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof MarketDataError ? error.code : "MARKET_CHECK_FAILED",
  );
  process.exitCode = 1;
});
