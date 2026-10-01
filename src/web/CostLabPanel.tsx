import { useState } from "react";
import { useCostLab } from "./useCostLab.js";
import type { CostWebControl } from "../core/cost-web-schema.js";
import type { CostWebRecord } from "../core/cost-web-schema.js";
import { CostAppReportPanel } from "./CostAppReportPanel.js";
import "./cost-lab.css";

// Display the exact decimal string; no Number conversion or monetary arithmetic.
const amount = (v: string) => v.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "원";
export function CostLabPanel({ csrf }: { csrf: string }) {
  const api = useCostLab(csrf),
    [ack, setAck] = useState(false),
    [recipe, setRecipe] = useState<CostWebRecord["recipe"]>(
      "COST_WEB_SYNTHETIC_KRW_V1",
    ),
    [confirmStop, setConfirmStop] = useState(false);
  const data = api.data,
    view = data?.view;
  const legacy = view && !("recipe" in view) ? view : undefined;
  const operating = view && "recipe" in view ? view : undefined;
  const unavailable =
    api.stale ||
    api.busy ||
    Boolean(api.pending) ||
    data?.workerStale ||
    data?.phase !== "READY";
  const blocked =
    unavailable ||
    Boolean(view?.error || view?.recoveryRequired) ||
    view?.runtime.phase === "FAULT";
  const quotaReserved = (view?.controlRevision ?? 0) >= 99;
  const control = (action: CostWebControl["action"]) => {
    if (!data?.activeId || !view) return;
    void api.send({
      type: "control",
      id: crypto.randomUUID(),
      runId: data.activeId,
      expectedControl: view.controlRevision,
      action,
    });
  };
  const account = legacy?.report.financialEvidence.accounts.find(
    (a) => a.currency === "KRW",
  );
  return (
    <section className="cost-lab" aria-label="비용 코어 합성 시험">
      <div className="p-card">
        <span className="p-tag">TEST_ONLY · 단일 KRW</span>
        <h2>체결부터 장부까지, 하나의 근거</h2>
        <p>
          가상 500만원 · 합성 종목 REPLAY-KR-B의 고정 가격 경로입니다. 실제
          시세·투자 수익성 검증이 아니며 기존 다종목 실험과 별도 저장됩니다.
        </p>
        <p className="p-info">
          실주문 OFF · 외부 AI OFF · 학습 HOLD
          <br />
          시작하면 합성 부분 체결과 목표가 청산을 시험합니다. V4 경로만 현재
          운영비·기간 마감·입력 검증을 연결하며 학습이나 실제 거래는 하지
          않습니다.
        </p>
        {api.stale && (
          <p role="alert" className="p-alert">
            비용 시험 연결 확인 필요. 아래 값은 마지막 검증 값일 수 있으며 서버
            실행은 계속될 수 있습니다. 새 요청을 차단합니다.
          </p>
        )}
        {api.error && (
          <p role="alert" className="p-alert">
            {api.error}
          </p>
        )}
        {data?.workerStale && (
          <p role="alert" className="p-alert">
            작업기 응답 지연. 표시된 RUNNING은 마지막 수신 상태이며 현재 감시를
            보장하지 않습니다. 조작을 차단합니다.
          </p>
        )}
        {api.pending && (
          <div className="p-alert" role="alert">
            <p>
              처리 결과 미확정. 발송 전 저장한 같은 요청으로 재확인하세요.
              새로고침은 취소나 정지를 뜻하지 않습니다.
            </p>
            <button
              disabled={api.busy}
              onClick={() => {
                void api.send(api.pending!, true);
              }}
            >
              저장된 같은 요청 재확인
            </button>
          </div>
        )}
        {!data ? (
          <p role="status">비용 시험 목록 확인 중…</p>
        ) : (
          <>
            {data.unreadable > 0 && (
              <p role="alert">
                읽을 수 없는 실행 {data.unreadable}개. 파일을 삭제하지 말고
                보존하세요.
              </p>
            )}
            <label className="cw-ack">
              <span className="cw-recipe-label">시험 경로</span>
              <select
                aria-label="비용 시험 경로"
                disabled={!data.canCreate}
                value={
                  data.canCreate
                    ? recipe
                    : (data.runs.find((r) => r.id === data.activeId)?.recipe ??
                      recipe)
                }
                onChange={(e) =>
                  setRecipe(e.target.value as CostWebRecord["recipe"])
                }
              >
                <option value="COST_WEB_SYNTHETIC_KRW_V1">
                  기존 V3 · 거래비용
                </option>
                <option value="COST_WEB_OPERATING_KRW_V1">
                  V4 · 운영비·마감·입력 검증
                </option>
              </select>
            </label>
            <label className="cw-ack">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              고정 합성 가격·비용으로 새 전용 실행을 만드는 것에 동의합니다.
            </label>
            <button
              className="p-primary"
              disabled={
                !ack ||
                !data.canCreate ||
                api.busy ||
                api.stale ||
                Boolean(api.pending)
              }
              onClick={() => {
                void api.send({
                  type: "create",
                  id: crypto.randomUUID(),
                  acknowledgeSynthetic: true,
                  recipe,
                });
              }}
            >
              새 비용 시험 생성
            </button>
            {!data.canCreate && data.runs.length > 0 && (
              <p className="cw-note">
                기존 실행을 먼저 검사합니다. 보유·미체결·미결제·HOLD 또는 읽기
                오류가 남으면 새 시험을 만들지 않습니다.
              </p>
            )}
            {data.phase === "PREPARING" && (
              <p role="status">
                합성 이력·정책·장부 검증 중… 수십 초 이상 걸릴 수 있으며 자동
                시작하지 않습니다.
              </p>
            )}
            {data.phase === "FAULT" && (
              <p role="alert" className="p-alert">
                작업기 FAULT. 아래는 마지막 수신 값이며 현재 장부 상태가 아닐 수
                있습니다. 같은 실행의 저장 기록을 검사하세요.
              </p>
            )}
          </>
        )}
      </div>
      {view && (
        <>
          <section className="p-card p-space" aria-label="실행과 감시 상태">
            <div className="p-section-title">
              <h2>실행과 감시</h2>
              <strong data-testid="cost-phase">
                {data?.phase === "FAULT" || view.error
                  ? "FAULT"
                  : view.runtime.phase}
              </strong>
            </div>
            <p data-testid="cost-loop">
              장부 루프 {view.loop.status} · 호가 {view.loop.ticks}개 · 시간
              점검 {view.loop.watchdog?.pulses ?? 0}건
            </p>
            <p>
              합성 입력 {view.feedEnabled ? "공급 중" : "단절 시험 중"} · 청산
              사유 {view.loop.reason ?? "없음"}
            </p>
            <p className="cw-note">
              마지막 유효 호가{" "}
              {view.loop.watchdog?.lastQuoteAt
                ? new Date(view.loop.watchdog.lastQuoteAt).toISOString()
                : "아직 없음"}{" "}
              · 시간 감시 {view.runtime.timerPending ? "예약됨" : "중지됨"}
            </p>
            {view.runtime.error && (
              <p role="alert" className="p-alert">
                실행기 FAULT: {view.runtime.error}. 실제 보호·청산 완료가
                아닙니다.
              </p>
            )}
            {view.error && (
              <p className="p-alert" role="alert">
                {view.error} · 마지막 검증 장부입니다. 저장 성공이나 전량 청산을
                의미하지 않습니다.
              </p>
            )}
            {view.recoveryRequired && (
              <p className="p-alert" role="alert">
                서버 재시작·다시 열기: 기록 검사 전용. 자동 재개·예약 반환·HOLD
                해제는 하지 않습니다.
              </p>
            )}
            <div className="p-actions">
              <button
                className="p-primary"
                disabled={
                  blocked ||
                  quotaReserved ||
                  view.runtime.phase === "RUNNING" ||
                  view.finished
                }
                onClick={() => control("START")}
              >
                {view.runtime.phase === "STOPPED"
                  ? "같은 실행 재개"
                  : "비용 시험 시작"}
              </button>
              <button
                disabled={blocked || view.runtime.phase !== "RUNNING"}
                onClick={() => setConfirmStop(true)}
              >
                실행 중지
              </button>
              <button
                disabled={
                  blocked || quotaReserved || view.runtime.phase !== "RUNNING"
                }
                onClick={() =>
                  control(view.feedEnabled ? "FEED_OFF" : "FEED_ON")
                }
              >
                {view.feedEnabled ? "합성 입력 끊기" : "합성 입력 다시 공급"}
              </button>
            </div>
            {confirmStop && (
              <div className="p-alert" role="group" aria-label="실행 중지 확인">
                <p>
                  중지하면 체결 루프와 시간 감시가 멈춥니다.
                  보유·미체결·미결제·예약은 그대로 남습니다. 청산 버튼이
                  아닙니다.
                </p>
                <button
                  disabled={blocked}
                  onClick={() => {
                    control("STOP");
                    setConfirmStop(false);
                  }}
                >
                  청산 없이 실행 중지 확인
                </button>
                <button onClick={() => setConfirmStop(false)}>돌아가기</button>
              </div>
            )}
            <p className="cw-note">
              {operating
                ? "고정 합성 사건 시계이며 STOP 중에는 사건 커서가 멈춥니다."
                : "재개 시 경과 시간을 반영합니다."}{" "}
              입력을 복구하거나 매도가 완료돼도 기록된 HOLD는 자동 해제되지
              않습니다.
            </p>
            <ul data-testid="cost-holds">
              {[
                ...new Set([
                  ...view.loop.holds,
                  ...view.report.financialEvidence.admissionHolds,
                ]),
              ].map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
            {quotaReserved && (
              <p role="status">
                제어 요청 한도에 도달했습니다. 마지막 한 칸은 실행 중지 전용이며
                사용 후 기록 검사만 가능합니다.
              </p>
            )}
          </section>
          {legacy && (
            <section className="p-card p-space" aria-label="검증 장부">
              <h2>검증된 원화 장부</h2>
              <p>
                금융 기록 시각{" "}
                {new Date(legacy.report.source.asOf).toISOString()} · 합성
                시각입니다.
              </p>
              {account && (
                <dl className="cw-balances">
                  {[
                    ["현금", account.cash],
                    ["가용현금", account.availableCash],
                    ["예약금", account.reservedCash],
                    ["미수금", account.receivable],
                    ["미지급금", account.payable],
                    ["누적 거래비용", account.tradingFees],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd
                        data-testid={
                          label === "누적 거래비용" ? "cost-fees" : undefined
                        }
                      >
                        {amount(value!)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {legacy.report.financialEvidence.trades.map((t) => (
                <div key={t.runId}>
                  <h3>
                    {t.symbol} · 잔여 {t.quantity}주
                  </h3>
                  <p>
                    미결제 체결 {t.unsettledFillCount}건 · 확정 거래손익{" "}
                    {t.outcome ? amount(t.outcome.netPnlNative) : "미확정"}{" "}
                    (운영비 제외)
                  </p>
                  <div className="cw-table">
                    <table>
                      <caption>합성 주문 상태</caption>
                      <thead>
                        <tr>
                          <th>방향</th>
                          <th>상태</th>
                          <th>주문 수량</th>
                          <th>체결 수량</th>
                          <th>예약금</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.orders.map((o) => (
                          <tr key={o.id}>
                            <td>{o.side}</td>
                            <td>{o.status}</td>
                            <td>{o.quantity}</td>
                            <td>{o.filled}</td>
                            <td>{amount(o.reservedCash)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              <details className="cw-evidence">
                <summary>동일 비용 근거와 학습 보류 사유</summary>
                <p>
                  학습 상태: {legacy.report.learningEvidence.status} ·
                  학습·실주문 권한 false
                </p>
                <ul>
                  {legacy.report.learningEvidence.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <p>
                  장부·보고·학습 공통 근거{" "}
                  <code>{view.report.financialBasisHash}</code>
                </p>
                <p>
                  보고 해시 <code>{view.report.reportHash}</code>
                </p>
              </details>
            </section>
          )}
          {operating && data?.activeId && (
            <CostAppReportPanel
              view={operating}
              runId={data.activeId}
              verification={data.verification}
              disabled={Boolean(unavailable)}
              verify={() => {
                if (operating.capture)
                  void api.send({
                    type: "verify",
                    runId: data.activeId!,
                    snapshotId: operating.capture.snapshotId,
                  });
              }}
            />
          )}
        </>
      )}
      {data && (
        <section className="p-card p-space">
          <h2>저장된 비용 시험</h2>
          {!data.runs.length ? (
            <p>아직 생성한 비용 시험이 없습니다.</p>
          ) : (
            data.runs.map((r) => (
              <div className="p-run-row" key={r.id}>
                <div>
                  <strong>{r.id.slice(0, 8)}</strong>
                  <small>{r.createdAt}</small>
                </div>
                <button
                  disabled={
                    api.busy ||
                    api.stale ||
                    Boolean(api.pending) ||
                    data.phase === "PREPARING" ||
                    (data.activeId === r.id && data.phase === "READY") ||
                    Boolean(
                      view &&
                      (!view.safeToLeave || view.runtime.phase === "RUNNING") &&
                      data.activeId !== r.id,
                    )
                  }
                  onClick={() => {
                    void api.send({ type: "open", runId: r.id });
                  }}
                >
                  {data.activeId === r.id && data.phase === "READY"
                    ? "열린 비용 시험"
                    : "저장 기록 검사"}
                </button>
              </div>
            ))
          )}
        </section>
      )}
    </section>
  );
}
