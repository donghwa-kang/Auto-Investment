import { useEffect, useState, type FormEvent } from "react";
import { usePortfolio } from "./usePortfolio.js";
import { PortfolioSetup } from "./PortfolioSetup.js";
import {
  PortfolioOverview,
  PortfolioDecisions,
  PortfolioOrders,
  when,
  won,
} from "./PortfolioPanels.js";
import { PortfolioControls } from "./PortfolioControls.js";
import "./portfolio.css";
import "./portfolio-panels.css";
import { CodexAnalysisPanel } from "./CodexAnalysisPanel.js";
import { CostLabPanel } from "./CostLabPanel.js";

const tabs = [
  "모의 투자",
  "판단 근거",
  "주문·보유",
  "실행 기록",
  "Codex 분석 · 모형",
  "비용 코어 시험",
];
export function PortfolioApp() {
  const api = usePortfolio(),
    [code, setCode] = useState(""),
    [tab, setTab] = useState(
      new URLSearchParams(location.search).get("lab") === "cost" ? 5 : 0,
    ),
    [setup, setSetup] = useState(false);
  const data = api.data,
    v = data?.view,
    locked = api.busy || api.stale || api.uncertain;
  useEffect(() => {
    if (data?.activeId) setSetup(false);
  }, [data?.activeId]);
  async function connect(e: FormEvent) {
    e.preventDefault();
    await api.login(code);
    setCode("");
  }
  const status = !api.csrf
    ? "연결 전"
    : data?.phase === "PREPARING"
      ? "자료 검증 중"
      : data?.phase === "ERROR"
        ? "실행 오류"
        : v
          ? v.recoveryRequired
            ? "복구 대조 필요"
            : v.finished
              ? "재생 종료"
              : v.playing
                ? "시나리오 재생 중"
                : "재생 정지"
          : "실험 준비";
  return (
    <div className="portfolio-app">
      <header className="p-header">
        <a className="p-brand" href="/?view=portfolio">
          <span className="p-logo">p</span>페이퍼랩
        </a>
        <span className="p-tag">로컬 모의매매</span>
        <a className="p-legacy" href="/">
          단일 종목 실험 ↗
        </a>
      </header>
      <div className="p-safety">
        <span>실거래 연결 없음</span> 합성 데이터와 가상 자금으로만 작동해요.
        실제 시장·수익성은 미검증입니다.
      </div>
      <div className="p-layout">
        <aside className="p-nav">
          <p>내 실험실</p>
          {tabs.map((name, i) => (
            <button
              key={name}
              aria-current={tab === i ? "page" : undefined}
              disabled={!api.csrf && i > 0}
              onClick={() => {
                setTab(i);
                setSetup(false);
                const url = new URL(location.href);
                if (i === 5) url.searchParams.set("lab", "cost");
                else url.searchParams.delete("lab");
                history.replaceState(null, "", url);
              }}
            >
              <span aria-hidden="true" className="p-nav-icon">
                {["◫", "☷", "⇄", "▤", "◇", "≡"][i]}
              </span>
              <span className={i === 4 ? "ca-nav-label" : undefined}>
                {name}
              </span>
            </button>
          ))}
          <div className="p-nav-note">
            PAPER ONLY
            <br />
            거래 정책 v2.3
            <br />
            실주문 기능 없음
          </div>
        </aside>
        <main className="p-main">
          <div className="p-title">
            <div>
              <p className="p-eyebrow">PORTFOLIO LAB</p>
              <h1>
                {setup
                  ? "새 모의 실험"
                  : tab === 0
                    ? "내 모의 투자"
                    : tabs[tab]}
              </h1>
            </div>
            <span className="p-status" data-testid="portfolio-status">
              {tab === 5 ? "별도 비용 시험" : status}
            </span>
          </div>
          {api.csrf && api.stale && (
            <div className="p-alert" role="alert">
              연결 지연·끊김: 마지막 수신 값입니다. 현재 상태로 볼 수 없어요.
              화면 요청은 차단했지만 서버 재생은 계속될 수 있어요.
            </div>
          )}
          {api.error && (
            <div className="p-alert" role="alert">
              요청 확인: {api.error}
              {api.uncertain && (
                <>
                  <p>
                    응답 유실로 처리 여부를 확정할 수 없어요. 새 명령 대신 같은
                    요청을 재확인하세요.
                  </p>
                  <button
                    disabled={api.busy}
                    onClick={() => {
                      void api.retry();
                    }}
                  >
                    같은 요청 재확인
                  </button>
                </>
              )}
            </div>
          )}
          {!api.csrf ? (
            <div className="p-columns">
              <section className="p-card p-welcome">
                <span className="p-symbol">₩</span>
                <p className="p-eyebrow">나의 가상 자산</p>
                <h2>
                  안전한 실험부터
                  <br />
                  시작해 보세요
                </h2>
                <p>
                  실제 돈을 움직이지 않고, 매매 판단부터
                  <br />
                  주문과 위험관리까지 확인하는 공간이에요.
                </p>
                <div className="p-wallets">
                  <div>
                    <span>원화 장부</span>
                    <strong>배정 전</strong>
                  </div>
                  <div>
                    <span>달러 장부</span>
                    <strong>배정 전</strong>
                  </div>
                </div>
                <div className="p-info">
                  자금과 판단 기록은 이 PC에 저장돼요.
                  <br />
                  새로고침해도 자금을 다시 배정하지 않아요.
                </div>
              </section>
              <section className="p-card p-connect">
                <span className="p-tag">01 · 로컬 연결</span>
                <h2>실험실 열기</h2>
                <p>
                  서버가 만든 일회용 연결 코드를 입력해 주세요.
                  <br />
                  토스 API 키나 계좌 비밀번호가 아니에요.
                </p>
                <form
                  onSubmit={(e) => {
                    void connect(e);
                  }}
                >
                  <label htmlFor="p-code">연결 코드</label>
                  <input
                    id="p-code"
                    type="password"
                    autoComplete="off"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="일회용 코드 입력"
                  />
                  <button disabled={api.busy} className="p-primary">
                    {api.busy ? "연결 중…" : "연결"}
                  </button>
                </form>
                <div className="p-info">
                  기본 코드 파일: data/portfolio-web/local-pairing.txt
                  <br />
                  별도 실행 폴더를 썼다면 터미널의 경로를 확인하세요. 발급 후
                  5분, 한 번만 사용할 수 있어요.
                </div>
              </section>
            </div>
          ) : tab === 5 ? (
            <CostLabPanel csrf={api.csrf} />
          ) : tab === 4 ? (
            <CodexAnalysisPanel csrf={api.csrf} />
          ) : !data ? (
            <section className="p-card">
              <p role="status">로컬 실행 목록을 확인하고 있어요…</p>
            </section>
          ) : (
            <>
              {data.phase === "PREPARING" ? (
                <section className="p-card p-preparing" role="status">
                  <span className="p-spinner" />
                  <h2>원시 이력과 거래 기준을 대조하고 있어요</h2>
                  <p>
                    120개 완료 세션의 합성 봉을 다시 검사해요. 수십 초 이상 걸릴
                    수 있고, 준비가 끝나도 자동 시작하지 않아요.
                  </p>
                  <small>
                    실행 {data.activeId?.slice(0, 8)} · 새로고침해도 같은 작업을
                    표시합니다.
                  </small>
                </section>
              ) : data.phase === "ERROR" ? (
                <section className="p-card">
                  <h2>실행을 중단했어요</h2>
                  <p>
                    저장·자료 검증 또는 작업 프로세스 오류입니다. 보유·미체결이
                    해결됐다고 간주하지 않습니다.
                  </p>
                  <button
                    disabled={locked}
                    onClick={() => {
                      void api.send({ type: "open", runId: data.activeId });
                    }}
                  >
                    같은 실행 복구 검사
                  </button>
                </section>
              ) : setup ? (
                <PortfolioSetup
                  disabled={locked}
                  onCancel={() => setSetup(false)}
                  onCreate={async (s) => {
                    const ok = await api.send({
                      type: "create",
                      id: crypto.randomUUID(),
                      setup: s,
                    });
                    if (ok) {
                      setSetup(false);
                      setTab(0);
                    }
                    return ok;
                  }}
                />
              ) : tab === 3 ? (
                <section className="p-card">
                  <div className="p-section-title">
                    <h2>저장된 모의 실험</h2>
                    <button
                      className="p-primary"
                      disabled={
                        locked ||
                        Boolean(
                          v && (v.playing || v.exposureCount || v.pendingCount),
                        )
                      }
                      onClick={() => setSetup(true)}
                    >
                      새 모의 실험
                    </button>
                  </div>
                  <p>
                    서버 재시작 후에는 같은 입력·장부를 검사하고, 명시적으로
                    대조·재개해야 해요.
                  </p>
                  {data.unreadable > 0 && (
                    <div className="p-alert">
                      읽을 수 없는 실행 {data.unreadable}개. 새 실행 차단
                      중입니다. 파일을 임의 삭제하지 마세요.
                    </div>
                  )}
                  {!data.runs.length ? (
                    <div className="p-empty">아직 저장된 실험이 없어요.</div>
                  ) : (
                    data.runs.map((r) => (
                      <div key={r.id} className="p-run-row">
                        <div>
                          <strong>
                            {r.setup.sampleMarket === "KR" ? "국내" : "미국"}{" "}
                            합성 2종목 실험
                          </strong>
                          <small>
                            {when(Date.parse(r.createdAt))} · {r.id.slice(0, 8)}
                          </small>
                          <small>
                            {won(r.setup.capital)} · {r.setup.level} ·{" "}
                            {r.setup.forecast}
                          </small>
                        </div>
                        <button
                          disabled={
                            locked ||
                            Boolean(
                              v &&
                              (v.playing || v.exposureCount || v.pendingCount),
                            )
                          }
                          onClick={() => {
                            void api
                              .send({ type: "open", runId: r.id })
                              .then((ok) => {
                                if (ok) setTab(0);
                              });
                          }}
                        >
                          {r.id === data.activeId
                            ? "열린 실험"
                            : "기록 열기·복구 검사"}
                        </button>
                      </div>
                    ))
                  )}
                </section>
              ) : data.phase === "READY" && v ? (
                <>
                  <PortfolioControls
                    view={v}
                    runId={data.activeId!}
                    disabled={locked}
                    send={api.send}
                  />
                  {tab === 0 ? (
                    <PortfolioOverview view={v} />
                  ) : tab === 1 ? (
                    <PortfolioDecisions view={v} />
                  ) : (
                    <PortfolioOrders view={v} />
                  )}
                  <details className="p-card p-space p-metadata">
                    <summary>검증·저장 정보</summary>
                    <p>
                      감사 사건 {v.auditCount}개 · 저장 버전 {v.revision} ·{" "}
                      {v.config.forecast}
                    </p>
                    <p>
                      실행 해시 <code>{v.runHash}</code>
                    </p>
                    <p>
                      재생 해시 <code>{v.recipeHash}</code>
                    </p>
                    {v.notices.slice(-6).map((n, i) => (
                      <p key={i}>{n}</p>
                    ))}
                  </details>
                </>
              ) : (
                <section className="p-card p-welcome">
                  <span className="p-symbol">₩</span>
                  <h2>
                    {data.runs.length
                      ? "이어서 확인할 실험이 있어요"
                      : "첫 모의 실험을 만들어 보세요"}
                  </h2>
                  <p>
                    합성 2종목의 다종목 엔진 시험입니다.
                    <br />
                    실제 시장 검색이나 뉴스 분석은 아직 연결하지 않았어요.
                  </p>
                  <div className="p-actions">
                    <button
                      className="p-primary"
                      disabled={locked}
                      onClick={() => setSetup(true)}
                    >
                      새 모의 실험
                    </button>
                    {data.runs.length > 0 && (
                      <button onClick={() => setTab(3)}>
                        저장된 실행 보기
                      </button>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
          {!v && !setup && tab !== 4 && tab !== 5 && (
            <section className="p-card p-steps">
              <div>
                <span>01</span>
                <h3>가상 자금 배정</h3>
                <p>운용금과 위험도를 정해요.</p>
              </div>
              <div>
                <span>02</span>
                <h3>합성 시나리오 재생</h3>
                <p>검사된 다종목 엔진을 실행해요.</p>
              </div>
              <div>
                <span>03</span>
                <h3>판단과 결과 확인</h3>
                <p>승인·보류의 근거를 살펴봐요.</p>
              </div>
            </section>
          )}
          <footer className="p-footer">
            페이퍼랩은 개인용 시험 프로그램이며 토스증권의 공식 서비스가
            아닙니다.
          </footer>
        </main>
      </div>
    </div>
  );
}
