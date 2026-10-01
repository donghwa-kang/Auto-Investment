import type { CostAppView } from "../server/cost-app-run.js";
import type { CostWebResponse } from "../server/cost-web-service.js";
const amount = (v: string | null) =>
  v === null ? "미확정" : v.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "원";
export function CostAppReportPanel({
  view,
  runId,
  verification,
  disabled,
  verify,
}: {
  view: CostAppView;
  runId: string;
  verification: CostWebResponse["verification"];
  disabled: boolean;
  verify: () => void;
}) {
  const report = view.report,
    financial = report.financialEvidence;
  const job =
    verification?.runId === runId &&
    verification.snapshotId === view.capture?.snapshotId
      ? verification
      : null;
  const a = financial.currentAccounts.find((a) => a.currency === "KRW")!;
  return (
    <section className="p-card p-space" aria-label="V4 운영비 마감 입력 검증">
      <span className="p-tag">V4 · TEST_ONLY · 고정 합성 사건 시계</span>
      <h2>운영비부터 마감까지</h2>
      <p>
        과거 120세션을 각 60분으로 구성하고 현재 세션을 보존한 별도 합성
        자료입니다. 실제 시장·수익성 검증이 아닙니다.
      </p>
      <p>
        사건 {view.cursor}/{view.eventCount} · 합성 시각{" "}
        {new Date(view.logicalAt).toISOString()}
      </p>
      <p>
        청산·결제 {view.settled ? "완료" : "미완료"} · 기간 마감{" "}
        <strong data-testid="cost-app-finalization">
          {financial.finalization.status}
        </strong>
      </p>
      <p>마감 요청 복구 상태: {view.closeIntentStatus}</p>
      <dl className="cw-balances">
        {[
          ["현금", a.cash],
          ["가용현금", a.availableCash],
          ["예약금", a.reservedCash],
          ["미수금", a.receivable],
          ["전체 미지급금", a.totalPayable],
          ["거래비용", a.tradingFees],
          ["운영비 발생", financial.operating.current.incurredKrw],
          ["운영비 지급", financial.operating.current.paidKrw],
          ["순자산가치", a.netAssetValue],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{amount(value!)}</dd>
          </div>
        ))}
      </dl>
      {financial.trades.map((t) => (
        <div key={t.runId}>
          <h3>
            {t.symbol} · 잔여 {t.quantity}주
          </h3>
          <p>
            거래비 후 손익 {amount(t.tradingNetPnlKrw)} · 운영비 배분{" "}
            {amount(t.operatingAllocationKrw)}
          </p>
          <p>
            최종 손익{" "}
            <strong data-testid="cost-app-net">
              {amount(t.finalNetPnlKrw)}
            </strong>
          </p>
          <p>
            {t.orders
              .map((o) => `${o.side} ${o.status} (${o.filled}/${o.quantity})`)
              .join(" · ")}
          </p>
        </div>
      ))}
      <h3>학습 입력 검증 — 모델 실행 아님</h3>
      <p>
        금융 보고: {report.status} · 입력 검증:{" "}
        <strong data-testid="cost-app-verification">
          {job?.result?.status ?? job?.phase ?? "미실행"}
        </strong>
      </p>
      <p>
        입력 적격은 운용 승인·새 시험 허가가 아닙니다. 학습/등록/승격/주문/새
        지출/자동 재개 권한은 모두 false입니다.
      </p>
      <button
        disabled={disabled || !view.capture || Boolean(job)}
        onClick={verify}
      >
        고정 입력 검증 요청
      </button>
      {job?.error && (
        <p role="alert">{job.error} · 금융 마감은 변경하지 않았습니다.</p>
      )}
      {job?.phase === "RUNNING" && (
        <p role="status">별도 읽기 작업에서 재생·RVOL 대조 중…</p>
      )}
      {job?.result && (
        <p>
          검증 라벨 최종 손익{" "}
          {amount(job.result.trainingLabel?.finalNetPnlKrw ?? null)}
        </p>
      )}
      {job?.phase === "DONE" && !disabled && (
        <div className="p-actions">
          {(["financial", "input", "anchor", "result"] as const).map(
            (artifact) => (
              <a
                key={artifact}
                href={`/api/cost-lab/download?${new URLSearchParams({ runId, snapshotId: job.snapshotId, artifact })}`}
                download={`synthetic-${artifact}.json`}
              >
                {
                  {
                    financial: "금융 근거",
                    input: "원래 입력",
                    anchor: "참고 pin",
                    result: "검증 결과",
                  }[artifact]
                }{" "}
                내려받기
              </a>
            ),
          )}
        </div>
      )}
      <details className="cw-evidence">
        <summary>동일 snapshot 및 보류 사유</summary>
        <p>
          금융 근거 <code>{report.financialBasisHash}</code>
        </p>
        <p>
          마감 <code>{financial.finalization.checkpointHash ?? "미마감"}</code>
        </p>
        <p>
          snapshot <code>{view.capture?.snapshotId ?? "미생성"}</code>
        </p>
        <ul>
          {[
            ...report.diagnostics.learningReasons,
            ...(job?.result?.reasons ?? []),
          ].map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
