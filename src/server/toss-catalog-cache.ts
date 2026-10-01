import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { CatalogError } from "../core/catalog-schema.js";
import { hash } from "../core/policy.js";
import { writeTossCatalogReport } from "./catalog-fetch.js";
import {
  cacheDigestSchema,
  cacheTimeSchema,
  validateCachedCatalog,
} from "./toss-catalog-cache-validation.js";
import {
  CATALOG_REQUEST_INTERVAL_MS,
  type TossCatalogReport,
} from "./toss-catalog-client.js";

export const CATALOG_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const reportName = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9-]{36}\.json$/);
const stateSchema = z.strictObject({
  schemaVersion: z.literal("TOSS_CATALOG_DAILY_STATE_V1"),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dayBasis: z.literal("ASIA_SEOUL_LOCAL_CALL_BUDGET_NOT_SOURCE_DATE"),
  attemptId: z.uuid(),
  startedAt: cacheTimeSchema,
  completedAt: cacheTimeSchema.nullable(),
  status: z.enum(["STARTED", "COMPLETE", "FAILED"]),
  reportName: reportName.nullable(),
  reportHash: cacheDigestSchema.nullable(),
  checksum: cacheDigestSchema,
});
type State = z.infer<typeof stateSchema>;
type StateBody = Omit<State, "checksum">;

// KST 날짜는 로컬 호출 예산의 경계일 뿐, 거래일/토스 갱신일/자료 신선도가 아니다.
export function catalogCacheDay(now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253402268400000)
    throw new CatalogError("CATALOG_CACHE_CLOCK_INVALID");
  return new Date(now + 9 * 3600000).toISOString().slice(0, 10);
}
function paths(root: string) {
  const directory = resolve(root, "data", "toss-catalogs");
  return {
    directory,
    state: resolve(directory, "daily-state.json"),
    lock: resolve(directory, "daily-fetch.lock"),
  };
}
function readLocalJson(path: string, cap: number): unknown {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > cap)
      throw new Error("invalid local file");
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > cap ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev
    )
      throw new Error("changed local file");
    const bytes = readFileSync(fd);
    if (bytes.length > cap) throw new Error("oversized local file");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CatalogError("CATALOG_CACHE_INVALID");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function loadState(root: string, now: number): State | null {
  const location = paths(root);
  // 읽기 전용 명령은 없는 디렉터리/캐시를 만들지 않는다.
  try {
    lstatSync(location.state);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CatalogError("CATALOG_CACHE_INVALID");
  }
  const parsed = stateSchema.safeParse(readLocalJson(location.state, 8192));
  if (!parsed.success) throw new CatalogError("CATALOG_CACHE_INVALID");
  const { checksum, ...body } = parsed.data;
  if (
    hash(body) !== checksum ||
    catalogCacheDay(Date.parse(body.startedAt)) !== body.day ||
    body.startedAt > new Date(now).toISOString() ||
    (body.completedAt !== null &&
      (body.completedAt < body.startedAt ||
        body.completedAt > new Date(now).toISOString())) ||
    (body.status === "STARTED" && body.completedAt !== null) ||
    (body.status !== "STARTED" && body.completedAt === null) ||
    (body.status === "COMPLETE"
      ? !body.reportName || !body.reportHash
      : body.reportName !== null || body.reportHash !== null)
  )
    throw new CatalogError("CATALOG_CACHE_INVALID");
  return parsed.data;
}
function storeState(path: string, body: StateBody) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  // 단일 상태 파일만 원자 교체한다. 과거 결과/사용자 파일은 삭제하지 않는다.
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ ...body, checksum: hash(body) }) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
function cached(root: string, state: State, now: number) {
  if (state.day !== catalogCacheDay(now))
    throw new CatalogError("CATALOG_CACHE_STALE");
  if (state.status !== "COMPLETE")
    throw new CatalogError("CATALOG_DAILY_ATTEMPT_ALREADY_USED");
  const reportPath = resolve(paths(root).directory, state.reportName!);
  const verified = validateCachedCatalog(
    readLocalJson(reportPath, CATALOG_CACHE_MAX_BYTES),
  );
  if (
    verified.reportHash !== state.reportHash ||
    verified.startedAt < state.startedAt ||
    verified.completedAt > state.completedAt!
  )
    throw new CatalogError("CATALOG_CACHE_INVALID");
  return {
    result: "CATALOG_CACHE_REUSED",
    purpose: "REAL_REFERENCE_SNAPSHOT",
    cacheDay: state.day,
    cacheDayBasis: state.dayBasis,
    counts: verified.counts,
    allScopesReceived: true,
    dataQualityComplete: true,
    metadataReady: false,
    freshForTrading: false,
    ordersEnabled: false,
    liveEnabled: false,
    failure: null,
    networkRequestsThisRun: 0,
    reportPath,
    reportHash: verified.reportHash,
  } as const;
}
export function readDailyCatalogCache(root = process.cwd(), now = Date.now()) {
  catalogCacheDay(now);
  const state = loadState(root, now);
  if (!state) throw new CatalogError("CATALOG_CACHE_MISSING");
  return cached(root, state, now);
}

// 키 읽기를 포함한 collect를 지연 실행한다. 당일 캐시 경로에서는 호출하지 않는다.
export async function collectDailyCatalog(
  collect: () => Promise<TossCatalogReport>,
  root = process.cwd(),
  now = () => Date.now(),
  sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
) {
  const location = paths(root);
  const started = now();
  const day = catalogCacheDay(started);
  for (const directory of [resolve(root, "data"), location.directory]) {
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink())
      throw new CatalogError("CATALOG_LOCAL_DIRECTORY_REQUIRED");
  }
  const owner = randomUUID();
  let lock: number;
  try {
    lock = openSync(location.lock, "wx", 0o600);
  } catch {
    throw new CatalogError("CATALOG_CACHE_LOCKED_OR_UNWRITABLE");
  }
  try {
    writeFileSync(lock, owner);
    fsyncSync(lock);
  } finally {
    closeSync(lock);
  }
  try {
    const prior = loadState(root, started);
    if (prior?.day === day) return cached(root, prior, started);
    const state: StateBody = {
      schemaVersion: "TOSS_CATALOG_DAILY_STATE_V1",
      day,
      dayBasis: "ASIA_SEOUL_LOCAL_CALL_BUDGET_NOT_SOURCE_DATE",
      attemptId: owner,
      startedAt: new Date(started).toISOString(),
      completedAt: null,
      status: "STARTED",
      reportName: null,
      reportHash: null,
    };
    // 인증 전에 영속화: 예외/강제 종료/저장 실패가 발생해도 당일 예산은 복원하지 않는다.
    storeState(location.state, state);
    // 자정 경계를 낀 직전 실행과도 요청 간격을 확보한다.
    await sleep(CATALOG_REQUEST_INTERVAL_MS);
    const report = await collect();
    const reportPath = writeTossCatalogReport(report, root);
    const completed = now();
    if (
      completed < started ||
      Date.parse(report.startedAt) < started ||
      Date.parse(report.completedAt) > completed
    )
      throw new CatalogError("CATALOG_CACHE_CLOCK_INVALID");
    const complete =
      report.allScopesReceived &&
      report.dataQualityComplete &&
      report.failure === null;
    if (complete) {
      // 발행 직전에 실제 저장 파일까지 재검사한다.
      const verified = validateCachedCatalog(
        readLocalJson(reportPath, CATALOG_CACHE_MAX_BYTES),
      );
      if (verified.reportHash !== report.reportHash)
        throw new CatalogError("CATALOG_CACHE_INVALID");
    }
    storeState(location.state, {
      ...state,
      completedAt: new Date(completed).toISOString(),
      status: complete ? "COMPLETE" : "FAILED",
      reportName: complete ? basename(reportPath) : null,
      reportHash: complete ? report.reportHash : null,
    });
    return {
      result: report.allScopesReceived
        ? "CATALOG_SCOPES_RECEIVED"
        : "CATALOG_INCOMPLETE",
      purpose: report.purpose,
      cacheDay: day,
      cacheDayBasis: state.dayBasis,
      counts: report.counts,
      allScopesReceived: report.allScopesReceived,
      dataQualityComplete: report.dataQualityComplete,
      metadataReady: false,
      freshForTrading: false,
      ordersEnabled: false,
      liveEnabled: false,
      failure: report.failure,
      networkRequestsThisRun: report.requests.length,
      reportPath,
      reportHash: report.reportHash,
    } as const;
  } finally {
    // 자신이 만든 임시 잠금만 제거. 프로세스 강제 종료 시 남은 잠금은 자동 해제하지 않는다.
    if (
      lstatSync(location.lock).isFile() &&
      lstatSync(location.lock).size === owner.length &&
      readFileSync(location.lock, "utf8") === owner
    )
      unlinkSync(location.lock);
    else throw new CatalogError("CATALOG_CACHE_LOCK_OWNERSHIP_LOST");
  }
}
