import type {
  RecordSummary,
  RecordDetail,
} from "../core/analysis-record-schema.js";

const states: Record<RecordDetail["status"], string> = {
  ABSTAIN: "진입 보류",
  NO_FILL_AS_OF: "종료 시점 체결 없음",
  OPEN_OR_UNRECONCILED: "미청산·대조 미확정",
  CLOSED_RECONCILED: "청산 대조 완료",
  COST_UNRESOLVED: "청산 완료·비용 미확정",
};
export function AnalysisRecordSummary({
  summary: s,
  records,
}: {
  summary: RecordSummary;
  records?: RecordDetail[];
}) {
  return (
    <div className="ca-record-summary">
      <h3>선택 기록 집계 · 실제 투자 성과 아님</h3>
      <p>
        판단 {s.decisions} · 승인 {s.approved} · 보류 {s.abstained} · 청산 대조{" "}
        {s.closedTrades}건
      </p>
      <p>
        미체결 진입 {s.noFillEntries} · 미청산/대조 미확정{" "}
        {s.openOrUnreconciledEntries} · 청산 후 비용 미확정{" "}
        {s.costUnresolvedClosures}건
      </p>
      <p>
        기간 밖 판단 {s.excludedDecisions} · 대상 밖 체결 {s.excludedFillEvents}
        건 (종료 시점까지). 운영비 사건 {s.operatingCostEventsAsOf}건은 임의
        배분하지 않습니다.
      </p>
      <div className="ca-money-grid">
        {(["KRW", "USD"] as const).map((currency) => {
          const t = s.totals[currency];
          return (
            <section key={currency}>
              <h4>
                {currency === "KRW" ? "원화" : "달러"} · {currency}
              </h4>
              <p>
                매수 체결 {t.buyQuantity}주 / {t.buyValue}
                <br />
                매도 체결 {t.sellQuantity}주 / {t.sellValue}
                <br />
                인식된 체결 수수료 {t.fillFees}
              </p>
              <p>
                확정 청산분 수수료 차감 손익
                <br />
                <strong data-testid={`record-net-${currency}`}>
                  {t.closedNetAfterRecordedFees ?? "미확정 또는 해당 청산 없음"}
                </strong>
              </p>
            </section>
          );
        })}
      </div>
      <p>
        숫자는 해당 거래 통화입니다. 통화를 합산하거나 원화 환산 장부 손익을
        달러 손익으로 복사하지 않습니다. 미청산 손익은 0으로 채우지 않습니다.
        실제 세금·환전·총비용·구독비 배분은 검증하지 않았습니다.
      </p>
      {records && (
        <details>
          <summary>판단별 최소 자료 {records.length}건 보기</summary>
          <div className="ca-record-table">
            <table>
              <thead>
                <tr>
                  <th>시각 (UTC)·근거 별칭</th>
                  <th>시장·전략·판단</th>
                  <th>조건 수</th>
                  <th>체결·상태</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.sourceRef}>
                    <td>
                      {r.at}
                      <br />
                      {r.sourceRef.slice(0, 12)}
                    </td>
                    <td>
                      {r.market} · {r.strategy ?? "없음"}
                      <br />
                      {r.action}
                    </td>
                    <td>
                      통과 {r.checks.pass}
                      <br />
                      실패 {r.checks.fail} / 누락 {r.checks.missing}
                    </td>
                    <td>
                      {r.fills}건 · {states[r.status]}
                      <br />
                      수수료 차감 손익{" "}
                      {r.netAfterRecordedFees ?? "미확정/해당 없음"}{" "}
                      {r.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
