import { useEffect, useState, useCallback, type FormEvent } from "react";
import type { Engine } from "../server/engine.js";
import type { Config, Level } from "../core/policy.js";
type View = ReturnType<Engine["view"]>;
const tabs = ["운용 현황", "판단 근거", "테마 조사", "주문·보유", "검증·설정"];
const won = (v: string | number | null | undefined) =>
  v === null || v === undefined
    ? "자료 없음"
    : `${Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}원`;
const local = (at: number) =>
  new Date(at).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour12: false,
  });
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "요청 실패");
  return body as T;
}
export function App() {
  const [view, setView] = useState<View | null>(null),
    [csrf, setCsrf] = useState(""),
    [code, setCode] = useState(""),
    [active, setActive] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false),
    [notice, setNotice] = useState(""),
    [decisionPage, setDecisionPage] = useState(0);
  const refresh = useCallback(async () => {
    try {
      setView(await request<View>("/api/state"));
      setStale(false);
    } catch (e) {
      setStale(true);
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void request<{ csrf: string }>("/api/session")
      .then((x) => setCsrf(x.csrf))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!csrf) return;
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, 1500);
    return () => clearInterval(id);
  }, [csrf, refresh]);
  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const x = await request<{ csrf: string }>("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      setCsrf(x.csrf);
      setCode("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const command = async (command: unknown) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const x = await request<{ status: string }>("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ id: crypto.randomUUID(), command }),
      });
      setNotice(`엔진 확인 상태: ${x.status}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <header>
        <div>
          <span className="brand">PAPER / LAB</span>
          <h1>오프라인 모의매매 실험실</h1>
        </div>
        <div className="tags">
          <span>합성 데이터</span>
          <span>전략 미검증</span>
          <span className="locked">실거래 잠금</span>
        </div>
      </header>
      <div className="disclaimer">
        실제 주가·계좌·AI가 아닙니다. 합성 모의 손익은 투자 성과의 증거가
        아니며, 계획 위험은 손실 보장 상한이 아닙니다.
      </div>
      {!csrf ? (
        <main>
          <section className="panel login">
            <p className="eyebrow">LOCAL ACCESS</p>
            <h2>로컬 엔진 연결</h2>
            <p>
              프로젝트의 <code>data/local-pairing.txt</code>에 있는 일회용
              코드를 입력하세요. 외부 API 키를 입력하지 마세요.
            </p>
            <form
              onSubmit={(e) => {
                void login(e);
              }}
            >
              <label>
                연결 코드
                <input
                  type="password"
                  autoComplete="off"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </label>
              <button disabled={busy}>{busy ? "연결 중…" : "연결"}</button>
            </form>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </section>
        </main>
      ) : (
        <div className="layout">
          <nav aria-label="주 화면">
            {tabs.map((name, i) => (
              <button
                key={name}
                aria-current={active === i ? "page" : undefined}
                onClick={() => setActive(i)}
              >
                {String(i + 1).padStart(2, "0")} <span>{name}</span>
              </button>
            ))}
            <div className="nav-note">
              PAPER · SIMULATOR_ONLY
              <br />
              공통 정책 v2.3
              <br />
              테마 정책 v1.3
              <br />
              B/P 공유 정의 v1.0
            </div>
          </nav>
          <main>
            {stale && (
              <div role="alert" className="error">
                연결 지연/끊김 — 아래는 마지막 관측 상태입니다. 현재 거래·청산
                완료를 의미하지 않습니다.
              </div>
            )}
            {error && (
              <div role="alert" className="error">
                {error}
              </div>
            )}
            {notice && (
              <p role="status" className="notice">
                {notice}
              </p>
            )}
            {!view ? (
              <p role="status">엔진 상태를 불러오는 중…</p>
            ) : (
              <>
                <div className="section-head">
                  <div>
                    <p className="eyebrow">{tabs[active]}</p>
                    <h2>
                      {active === 0
                        ? "작은 위험부터, 확인 가능한 판단으로"
                        : tabs[active]}
                    </h2>
                  </div>
                  <div className="state">
                    <small>{stale ? "마지막 관측" : "엔진 상태"}</small>
                    <strong data-testid="engine-status">
                      {view.state.status}
                    </strong>
                  </div>
                </div>
                {active === 0 && (
                  <>
                    <div className="metrics">
                      <Metric
                        name="모의 순자산 · KRW"
                        value={
                          view.metrics ? won(view.metrics.equity) : "미배정"
                        }
                      />
                      <Metric
                        name="회당 계획 위험 상한"
                        value={won(view.metrics?.caps?.trade)}
                      />
                      <Metric
                        name="기존·예약 미청산 위험"
                        value={won(view.metrics?.openRisk)}
                      />
                      <Metric
                        name="신규 진입 잔여 위험"
                        value={won(view.metrics?.remainingRisk)}
                      />
                    </div>
                    <section className="panel">
                      <div className="section-head">
                        <h3>운용 제어</h3>
                        <span>가상 시각 {local(view.state.clock)} (서울)</span>
                      </div>
                      <p>
                        시작은 새 진입을 허용합니다. 중지해도 기존 보유의
                        보호·청산 관리는 이어집니다.
                      </p>
                      <div className="actions">
                        <button
                          disabled={busy || stale || !view.state.config}
                          onClick={() => void command({ type: "start" })}
                        >
                          모의 거래 시작
                        </button>
                        <button
                          className="secondary"
                          disabled={busy || stale || !view.state.config}
                          onClick={() => void command({ type: "pause" })}
                        >
                          신규 거래 중지
                        </button>
                        <button
                          className="secondary"
                          disabled={busy || stale}
                          onClick={() => {
                            if (
                              confirm(
                                "미체결 진입을 중지하고 저장 후 모의 엔진을 종료할까요? 전량 청산이 아닙니다.",
                              )
                            )
                              void command({ type: "shutdown", confirm: true });
                          }}
                        >
                          저장 후 엔진 종료
                        </button>
                        <button
                          className="secondary"
                          disabled={busy || stale || !view.state.config}
                          onClick={() =>
                            void command({ type: "step", seconds: 10 })
                          }
                        >
                          가상 시계 +10초
                        </button>
                        <button
                          className="secondary"
                          disabled={busy || stale || !view.state.config}
                          onClick={() => void command({ type: "reconcile" })}
                        >
                          저장 장부 대조
                        </button>
                      </div>
                    </section>
                    {!view.state.config ? (
                      <Configuration
                        busy={busy}
                        submit={(cfg) =>
                          void command({ type: "configure", config: cfg })
                        }
                      />
                    ) : (
                      <section className="panel">
                        <h3>같은 자금, 분리된 통화</h3>
                        <div className="two">
                          <div>
                            <p>
                              KRW 현금 {won(view.state.ledger.wallets.KRW.cash)}
                            </p>
                            <p>
                              USD 현금 {view.state.ledger.wallets.USD.cash} USD
                            </p>
                            <p>
                              외화 순자산 환산 {won(view.metrics?.foreignNet)} /
                              한도 {won(view.metrics?.caps?.foreign)}
                            </p>
                          </div>
                          <div>
                            <p>
                              배정 {won(view.state.config.capital)} ·{" "}
                              {view.state.config.level} ·{" "}
                              {view.state.config.stage}
                            </p>
                            <p>예측: {view.state.config.forecast}</p>
                            <p>
                              시나리오: {view.state.config.scenario} /{" "}
                              {view.state.config.market}
                            </p>
                            <p>자동 환전 없음 · 실제 통장 연결 없음</p>
                          </div>
                        </div>
                      </section>
                    )}
                    <section className="panel">
                      <h3>안전 상태</h3>
                      <p>
                        미확정 주문 {view.metrics?.unresolved ?? 0}개 · 프로그램
                        귀속 {view.metrics?.botQuantity ?? 0}주
                      </p>
                      <p>
                        중지 래치:{" "}
                        {view.state.ledger.halts.join(", ") ||
                          "없음 (안전 보장 아님)"}
                      </p>
                      <p>
                        낙폭 축소:{" "}
                        {view.state.ledger.drawdownReduced
                          ? "유지 중"
                          : "미발동"}{" "}
                        · 설정 epoch {view.state.epoch}
                      </p>
                      {view.runtime.runtimeError && (
                        <p role="alert" className="error">
                          {view.runtime.runtimeError}: 저장/대조를 확인하세요.
                        </p>
                      )}
                      {view.state.notices.slice(-3).map((n, i) => (
                        <p key={i}>{n}</p>
                      ))}
                    </section>
                  </>
                )}
                {active === 1 && (
                  <section className="panel">
                    <h3>조건별 판정 기록</h3>
                    <p>
                      차트 그림의 추측이나 AI 투표가 아닌 실제 계산 결과입니다.
                      누락은 0으로 대체하지 않습니다.
                    </p>
                    {view.state.decisions.length === 0 ? (
                      <Empty text="아직 판단이 없습니다. 자금을 배정하고 모의 거래를 시작하세요." />
                    ) : (
                      [...view.state.decisions]
                        .reverse()
                        .slice(decisionPage * 10, decisionPage * 10 + 10)
                        .map((x) => (
                          <details key={x.id} open>
                            <summary>
                              {local(x.at)} · {x.symbol} ·{" "}
                              {x.strategy ?? "신호 없음"} ·{" "}
                              <strong>{x.result}</strong> · {x.quantity}주
                            </summary>
                            <p className={x.reasons.length ? "error" : ""}>
                              {x.reasons.join(" / ") ||
                                "합성 시험 가드 통과. 성과 검증 아님."}
                            </p>
                            <div className="table-wrap">
                              <table>
                                <thead>
                                  <tr>
                                    <th>조건 ID</th>
                                    <th>입력</th>
                                    <th>문턱 / 비교</th>
                                    <th>결과</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {x.trace.map((t) => (
                                    <tr key={t.predicate_id}>
                                      <td>{t.predicate_id}</td>
                                      <td className="mono">
                                        {JSON.stringify(t.input_values)}
                                      </td>
                                      <td>
                                        {t.operator} {t.threshold}
                                      </td>
                                      <td>{t.result}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <small className="mono">
                              스냅샷 {x.snapshotHash ?? "승인 없음"}
                            </small>
                          </details>
                        ))
                    )}
                    <div className="actions">
                      <button
                        className="secondary"
                        disabled={!decisionPage}
                        onClick={() => setDecisionPage((p) => p - 1)}
                      >
                        이전
                      </button>
                      <span>{decisionPage + 1} 페이지</span>
                      <button
                        className="secondary"
                        disabled={
                          (decisionPage + 1) * 10 >= view.state.decisions.length
                        }
                        onClick={() => setDecisionPage((p) => p + 1)}
                      >
                        다음
                      </button>
                    </div>
                  </section>
                )}
                {active === 2 && (
                  <>
                    <section className="panel">
                      <h3>조사는 매수 허가가 아닙니다</h3>
                      <p>
                        MARKET_SCAN의 합성 경로만 작동합니다. THEME_FOCUS /
                        HYBRID는 선정 프로필 미정으로 비활성입니다. 새 기업
                        추천·자동 수집·AI 호출은 없습니다.
                      </p>
                      <p>
                        사용자 범위 정정: 기본예탁금 3,000만 원 이상이 필요한
                        단일종목 레버리지를 제외합니다. SOXL 같은 지수형
                        레버리지 ETF는 검증 후보에 포함하되, 계좌 자격·상품별
                        검증·실제 시세 연결은 아직 확인되지 않았습니다.
                      </p>
                    </section>
                    <div className="research">
                      {view.research.map((x) => (
                        <section className="panel" key={x.id}>
                          <p className="eyebrow">
                            {x.kind} · {x.state}
                          </p>
                          <h3>{x.id}</h3>
                          {x.validationCandidate && (
                            <p>
                              {x.validationCandidate ===
                              "INCLUDED_FOR_VALIDATION"
                                ? "검증 후보 포함 · 실제 시세 모의매매 미연결"
                                : x.validationCandidate === "EXCLUDED_BY_USER"
                                  ? "검증 후보: 사용자 기준 제외"
                                  : "검증 후보: 상품 분류 확인 필요"}
                            </p>
                          )}
                          <p>실거래 자격/승인: {x.tradePermission}</p>
                          <p>{x.thesis}</p>
                          <h4>반대 근거</h4>
                          {x.counterEvidence.map((e) => (
                            <p key={e}>{e}</p>
                          ))}
                          <h4>미확인 자료</h4>
                          <p>{x.unknowns.join(" / ")}</p>
                          <small>실제 조사 자료 없음 · 주문 허용 아님</small>
                        </section>
                      ))}
                    </div>
                  </>
                )}
                {active === 3 && (
                  <>
                    <section className="panel">
                      <h3>프로그램 귀속 청산</h3>
                      <p>
                        수동 보유는 변경하지 않습니다. 버튼 클릭은 청산 완료가
                        아니며 부분 체결·미체결·차단을 계속 확인해야 합니다.
                      </p>
                      <div className="actions">
                        <button
                          className="danger"
                          disabled={busy || stale || !view.state.config}
                          onClick={() => {
                            if (
                              confirm(
                                "합성 장부의 프로그램 매매분만 청산할까요?",
                              )
                            )
                              void command({
                                type: "liquidate",
                                confirm: true,
                              });
                          }}
                        >
                          프로그램 매매분 청산
                        </button>
                        <button
                          disabled
                          title="1차 범위 밖: 실제 계좌 전체 청산은 구현하지 않았습니다."
                        >
                          선택 계좌 전체 청산 · 비활성
                        </button>
                      </div>
                    </section>
                    <section className="panel">
                      <h3>모의 보유</h3>
                      {view.state.positions.length === 0 ? (
                        <Empty text="보유 내역이 없습니다." />
                      ) : (
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>종목 / 귀속</th>
                                <th>잔여 수량</th>
                                <th>손절 / 목표</th>
                                <th>보호 상태</th>
                                <th>모의 순손익</th>
                              </tr>
                            </thead>
                            <tbody>
                              {view.state.positions.slice(-50).map((p) => (
                                <tr key={p.id}>
                                  <td>
                                    {p.symbol}
                                    <br />
                                    {p.owner}
                                  </td>
                                  <td>{p.quantity}주</td>
                                  <td>
                                    {p.stop} / {p.target} {p.currency}
                                  </td>
                                  <td>
                                    {p.protection}
                                    <br />
                                    확인 수량 {p.protectedQuantity}
                                  </td>
                                  <td>{p.netPnl ? won(p.netPnl) : "미청산"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                    <section className="panel">
                      <h3>모의 주문 / 예약</h3>
                      <p>접수 ≠ 체결 · 취소 요청 ≠ 취소 확정</p>
                      {view.state.orders.length === 0 ? (
                        <Empty text="주문이 없습니다. 무거래도 정상 결과입니다." />
                      ) : (
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>의도</th>
                                <th>방향</th>
                                <th>상태</th>
                                <th>체결 / 주문</th>
                                <th>가격</th>
                                <th>예약 위험</th>
                              </tr>
                            </thead>
                            <tbody>
                              {view.state.orders.slice(-50).map((o) => (
                                <tr key={o.id}>
                                  <td className="mono">{o.id}</td>
                                  <td>{o.side}</td>
                                  <td>{o.status}</td>
                                  <td>
                                    {o.filled} / {o.quantity}
                                  </td>
                                  <td>
                                    {o.limit} {o.currency}
                                  </td>
                                  <td>{won(o.reservationRisk)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                  </>
                )}
                {active === 4 && (
                  <>
                    <section className="panel">
                      <h3>위험도 변경</h3>
                      <p>
                        상향: 중지·프로그램 보유 0·전 주문 대조가 필요합니다.
                        하향: 진입 취소 후 새 한도 적용·초과 노출 청산 대기.
                        손절선·손실 기록은 초기화하지 않습니다.
                      </p>
                      <div className="actions">
                        {(["LOW", "MEDIUM", "HIGH"] as Level[]).map((l, i) => (
                          <button
                            className="secondary"
                            key={l}
                            disabled={busy || stale || !view.state.config}
                            onClick={() => {
                              if (
                                confirm(
                                  `${["하", "중", "상"][i]} 위험도로 변경을 요청할까요?`,
                                )
                              )
                                void command({
                                  type: "level",
                                  level: l,
                                  confirm: true,
                                });
                            }}
                          >
                            {["하 · 1/4", "중 · 1/2", "상 · 1"][i]}
                          </button>
                        ))}
                      </div>
                      <p>
                        선택 {view.state.config?.level ?? "미선택"} · 변경 대기{" "}
                        {view.state.pendingLevel ?? "없음"}
                      </p>
                    </section>
                    <section className="panel">
                      <h3>검증 경계</h3>
                      <p>
                        코드 시험과 전략 성과 검증은 다릅니다. 실제 시장
                        백테스트·AI 예측·실체결·수익성은 미검증입니다. 실거래로
                        승격하는 스위치는 없습니다.
                      </p>
                      <dl>
                        <dt>실행 경로</dt>
                        <dd>SIMULATOR_ONLY</dd>
                        <dt>예측 성과</dt>
                        <dd>UNVALIDATED</dd>
                        <dt>원본 정책 SHA-256</dt>
                        <dd className="mono">{view.originalPolicyHash}</dd>
                        <dt>시험 프로필 해시</dt>
                        <dd className="mono">{view.profileHash}</dd>
                      </dl>
                      <details>
                        <summary>실험 명세 (TEST_ONLY)</summary>
                        <pre>
                          {JSON.stringify(view.state.manifest, null, 2)}
                        </pre>
                      </details>
                    </section>
                    <section className="panel">
                      <h3>합성 장애 주입</h3>
                      <p>
                        시험용 저장 장애는 실제 디스크를 채우지 않습니다. 오류
                        제거 후에도 대조·명시적 시작이 필요합니다.
                      </p>
                      <div className="actions">
                        {[
                          "DISK_FULL",
                          "QUEUE_BACKLOG",
                          "CLOCK_ERROR",
                          "STALE_QUOTE",
                          "NONE",
                        ].map((f) => (
                          <button
                            className="secondary"
                            disabled={busy || stale || !view.state.config}
                            key={f}
                            onClick={() =>
                              void command({ type: "fault", fault: f })
                            }
                          >
                            {f === "NONE" ? "장애 제거 (재개 안 함)" : f}
                          </button>
                        ))}
                      </div>
                    </section>
                  </>
                )}
                <footer>
                  가상 시각과 실제 관측 시각은 다릅니다. 브라우저 종료는 거래
                  중지·청산이 아닙니다.
                  <br />
                  마지막 관측 {local(view.runtime.observedAt)} (서울) · 저장
                  revision {view.state.revision}
                </footer>
              </>
            )}
          </main>
        </div>
      )}
    </>
  );
}
function Metric({ name, value }: { name: string; value: string }) {
  return (
    <section className="metric">
      <p>{name}</p>
      <strong>{value}</strong>
    </section>
  );
}
function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}
function Configuration({
  busy,
  submit,
}: {
  busy: boolean;
  submit: (c: Config) => void;
}) {
  const [capital, setCapital] = useState("5000000"),
    [usd, setUsd] = useState("0"),
    [level, setLevel] = useState<Level>("LOW"),
    [scenario, setScenario] = useState<Config["scenario"]>("B"),
    [market, setMarket] = useState<Config["market"]>("KR"),
    [forecast, setForecast] = useState<Config["forecast"]>("MISSING_PROFILE");
  return (
    <section className="panel">
      <h3>첫 모의 자금 배정</h3>
      <p>
        초기 배정은 한 번만 저장됩니다. 새로운 실험은 별도 DB를 사용하며 기존
        기록을 삭제하지 않습니다.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit({
            capital: Number(capital),
            usdCapitalKrw: Number(usd),
            level,
            market,
            scenario,
            forecast,
            mode: "PAPER",
            stage: "PILOT",
          });
        }}
      >
        <div className="form-grid">
          <label>
            총 운용금 (KRW)
            <input
              type="number"
              min="1"
              max="5000000"
              step="1"
              required
              value={capital}
              onChange={(e) => setCapital(e.target.value)}
            />
          </label>
          <label>
            그중 USD 초기 배정 (KRW 환산)
            <input
              type="number"
              min="0"
              step="1"
              value={usd}
              onChange={(e) => setUsd(e.target.value)}
            />
          </label>
          <label>
            위험도
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as Level)}
            >
              <option value="LOW">하 · 1/4</option>
              <option value="MEDIUM">중 · 1/2</option>
              <option value="HIGH">상 · 1</option>
            </select>
          </label>
          <label>
            합성 시장
            <select
              value={market}
              onChange={(e) => setMarket(e.target.value as Config["market"])}
            >
              <option>KR</option>
              <option>US</option>
            </select>
          </label>
          <label>
            시험 시나리오
            <select
              value={scenario}
              onChange={(e) =>
                setScenario(e.target.value as Config["scenario"])
              }
            >
              {[
                "B",
                "P",
                "NO_SIGNAL",
                "GAP",
                "PARTIAL_CANCEL",
                "UNKNOWN",
                "PROTECTION_FAILURE",
              ].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            예측 제공기
            <select
              value={forecast}
              onChange={(e) =>
                setForecast(e.target.value as Config["forecast"])
              }
            >
              <option value="MISSING_PROFILE">
                기본: 근거 없음 → 거래 보류
              </option>
              <option value="TEST_ONLY">
                명시적 합성 예측 시험 (실제 AI 아님)
              </option>
            </select>
          </label>
        </div>
        <button disabled={busy}>
          {busy ? "원천 1분봉 준비·검사 중…" : "사전 점검 · 모의 자금 배정"}
        </button>
      </form>
    </section>
  );
}
