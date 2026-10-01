import type { PortfolioWebView } from "../server/portfolio-web-run.js";
export const number = (v: string | number) =>
  Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
export const won = (v: string | number) => `${number(v)}원`;
export const when = (v: number) =>
  new Date(v).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour12: false,
  });
export const symbol = (s: string) =>
  s
    .replace(/^(KR|US):/, "")
    .replace("REPLAY-", "합성 ")
    .replace(/-/g, " · ");
const sign = (value: string) =>
  Number(value) > 0 ? "p-up" : Number(value) < 0 ? "p-down" : "";
export function PortfolioOverview({ view: v }: { view: PortfolioWebView }) {
  return (
    <>
      <div className="p-columns">
        <section className="p-card">
          <p className="p-eyebrow">전체 가상 자산 · KRW 환산</p>
          <div className="p-balance" data-testid="portfolio-equity">
            {won(v.equity)}
          </div>
          <p className={sign(v.pnl)}>
            초기 배정 대비 {Number(v.pnl) > 0 ? "+" : ""}
            {won(v.pnl)} <span className="p-muted">· 비용 반영</span>
          </p>
          <div className="p-wallets">
            {(["KRW", "USD"] as const).map((c) => (
              <div key={c}>
                <span>{c === "KRW" ? "원화 현금" : "달러 현금"}</span>
                <strong>
                  {c === "KRW"
                    ? won(v.wallets[c].cash)
                    : `$${number(v.wallets[c].cash)}`}
                </strong>
                <small>
                  사용 가능{" "}
                  {c === "KRW"
                    ? won(v.available[c])
                    : `$${number(v.available[c])}`}
                </small>
                <small>
                  미수 {number(v.wallets[c].receivable)} / 미지급{" "}
                  {number(v.wallets[c].payable)} {c}
                </small>
              </div>
            ))}
          </div>
          <div className="p-info">
            합성 환율 1 USD = {won(v.fx)}
            <br />
            달러 부족 시 원화로 대신 매수하거나 자동 환전하지 않아요.
          </div>
        </section>
        <section className="p-card">
          <div className="p-section-title">
            <h2>위험관리</h2>
            <span className="p-tag">
              {{ LOW: "하", MEDIUM: "중", HIGH: "상" }[v.config.level]} ·{" "}
              {v.config.stage}
            </span>
          </div>
          <dl className="p-stats">
            <div>
              <dt>회당 계획 위험 상한</dt>
              <dd>{won(v.caps.trade)}</dd>
            </div>
            <div>
              <dt>현재 잔여 위험 예산</dt>
              <dd>{won(v.remainingRisk)}</dd>
            </div>
            <div>
              <dt>열린 위험 · 예약 포함</dt>
              <dd>{won(v.openRisk)}</dd>
            </div>
            <div>
              <dt>미체결 예약 위험</dt>
              <dd>{won(v.reservedRisk)}</dd>
            </div>
            <div>
              <dt>보유 / 미체결</dt>
              <dd>
                {v.exposureCount}종목 / {v.pendingCount}건
              </dd>
            </div>
          </dl>
          <div className="p-info">
            {v.halts.length
              ? `진입 잠금: ${v.halts.join(", ")}`
              : "위험 한도는 엔진이 주문 전에 다시 검사해요."}
            <br />
            손절 가격이나 최대 손실의 보장은 아닙니다.
          </div>
        </section>
      </div>
      <section className="p-card p-space">
        <div className="p-section-title">
          <h2>이번 실험의 종목</h2>
          <span className="p-muted">
            합성 {v.assets.length}종목 · 투자 순위 아님
          </span>
        </div>
        <div className="p-table-wrap">
          <table>
            <thead>
              <tr>
                <th>종목</th>
                <th>시장</th>
                <th>재생된 매수 호가</th>
                <th>최근 판단</th>
              </tr>
            </thead>
            <tbody>
              {v.assets.map((a, i) => {
                const decision = v.decisions.findLast(
                  (d) => d.symbol === a.key,
                );
                return (
                  <tr key={a.key}>
                    <td>
                      <div className="p-instrument">
                        <span className={`p-coin p-coin-${i % 2}`}>
                          {i === 0 ? "B" : "P"}
                        </span>
                        <div>
                          <strong>{symbol(a.symbol)}</strong>
                          <small>{a.symbol}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      {a.market === "KR" ? "국내" : "미국"} · {a.currency}
                    </td>
                    <td>
                      {a.quote
                        ? (a.currency === "USD" ? "$" : "") +
                          number(a.quote.bid) +
                          (a.currency === "KRW" ? "원" : "")
                        : "재생 전"}
                    </td>
                    <td>
                      {decision ? (
                        <span
                          className={
                            decision.result === "APPROVED"
                              ? "p-tag"
                              : "p-neutral"
                          }
                        >
                          {decision.result === "APPROVED" ? "승인" : "보류"}
                        </span>
                      ) : (
                        "판단 전"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
export function PortfolioDecisions({ view: v }: { view: PortfolioWebView }) {
  return (
    <section className="p-card">
      <h2>판단 근거</h2>
      <p>
        재생한 시점까지의 판단만 표시해요. 승인은 모의 주문 심사 통과이며 수익을
        뜻하지 않아요.
      </p>
      {!v.decisions.length ? (
        <div className="p-empty">
          아직 판단 기록이 없어요. 시나리오를 시작하면 이곳에 표시돼요.
        </div>
      ) : (
        [...v.decisions].reverse().map((d) => (
          <details key={d.id} className="p-detail">
            <summary>
              <span className={d.result === "APPROVED" ? "p-tag" : "p-neutral"}>
                {d.result === "APPROVED" ? "승인" : "보류"}
              </span>
              <strong>{symbol(d.symbol)}</strong>
              <span>
                {d.strategy ?? "—"} 전략 · {d.quantity}주
              </span>
              <small>{when(d.at)}</small>
            </summary>
            <div className="p-detail-body">
              <p>{d.reasons.join(" · ") || "모든 필수 심사 통과"}</p>
              {d.trace.map((t, i) => (
                <div className="p-trace" key={i}>
                  <strong>
                    {t.predicate_id} · {t.result}
                  </strong>
                  <p>{t.reason}</p>
                  <code>
                    {JSON.stringify(t.input_values)} {t.operator} {t.threshold}
                  </code>
                </div>
              ))}
              <small>
                판단 ID: {d.id}
                <br />
                스냅샷: {d.snapshotHash ?? "없음"}
              </small>
            </div>
          </details>
        ))
      )}
    </section>
  );
}
export function PortfolioOrders({ view: v }: { view: PortfolioWebView }) {
  return (
    <>
      <section className="p-card">
        <h2>프로그램 보유분</h2>
        <p>
          실제 계좌 잔고가 아니에요. 수량 0과 미체결 0을 확인해야 청산 완료로 볼
          수 있어요.
        </p>
        {!v.positions.length ? (
          <div className="p-empty">보유 기록이 없어요.</div>
        ) : (
          <div className="p-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>종목</th>
                  <th>잔여 수량</th>
                  <th>보호 상태</th>
                  <th>손절 / 목표</th>
                  <th>귀속</th>
                </tr>
              </thead>
              <tbody>
                {v.positions.map((p) => (
                  <tr key={p.id}>
                    <td>{symbol(p.symbol)}</td>
                    <td>{p.quantity}주</td>
                    <td>
                      <code>{p.protection}</code>
                      {p.exitReason && <small>청산 사유: {p.exitReason}</small>}
                    </td>
                    <td>
                      {number(p.stop)} / {number(p.target)} {p.currency}
                    </td>
                    <td>{p.owner}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="p-card p-space">
        <h2>모의 주문 내역</h2>
        {!v.orders.length ? (
          <div className="p-empty">
            아직 주문이 없어요. 보류는 오류가 아닐 수 있어요.
          </div>
        ) : (
          <div className="p-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>주문</th>
                  <th>종목</th>
                  <th>체결 / 요청</th>
                  <th>지정가</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {[...v.orders].reverse().map((o) => (
                  <tr key={o.id}>
                    <td className={o.side === "BUY" ? "p-up" : "p-down"}>
                      {o.side === "BUY" ? "매수" : "매도"}
                      <small>{o.id.slice(0, 12)}</small>
                    </td>
                    <td>
                      {symbol(
                        String(
                          o.snapshot?.instrument_id ??
                            v.positions.find((p) => p.id === o.positionId)
                              ?.symbol ??
                            "—",
                        ),
                      )}
                    </td>
                    <td>
                      {o.filled} / {o.quantity}주
                    </td>
                    <td>
                      {number(o.limit)} {o.currency}
                    </td>
                    <td>
                      <code>{o.status}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
