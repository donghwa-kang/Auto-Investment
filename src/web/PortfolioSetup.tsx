import { useState, type FormEvent } from "react";
import type { WebSetup } from "../core/portfolio-web-schema.js";

export function PortfolioSetup({
  disabled,
  onCreate,
  onCancel,
}: {
  disabled: boolean;
  onCreate: (s: WebSetup) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [capital, setCapital] = useState("5000000"),
    [usd, setUsd] = useState("0");
  const [level, setLevel] = useState<WebSetup["level"]>("LOW"),
    [stage, setStage] = useState<WebSetup["stage"]>("PILOT");
  const [market, setMarket] = useState<WebSetup["sampleMarket"]>("KR"),
    [forecast, setForecast] = useState(false),
    [ack, setAck] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    await onCreate({
      capital: Number(capital),
      usdCapitalKrw: Number(usd),
      level,
      stage,
      sampleMarket: market,
      forecast: forecast ? "TEST_ONLY" : "MISSING_PROFILE",
      acknowledgeSynthetic: true,
    });
  }
  return (
    <section className="p-card p-setup">
      <div className="p-section-title">
        <h2>새 모의 실험</h2>
        <button type="button" onClick={onCancel} disabled={disabled}>
          닫기
        </button>
      </div>
      <p>새 실행에만 자금을 배정해요. 기존 실행의 자금·기록은 바뀌지 않아요.</p>
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <fieldset disabled={disabled}>
          <div className="p-form-grid">
            <label>
              총 가상 운용금 (원)
              <input
                type="number"
                min="1"
                max="5000000"
                step="1"
                required
                value={capital}
                onChange={(e) => setCapital(e.target.value)}
              />
              <small>최대 500만 원 · 실제 입금 없음</small>
            </label>
            <label>
              달러 배정액 (원화 환산)
              <input
                type="number"
                min="0"
                max={Math.floor(Number(capital) * 0.4)}
                step="1"
                required
                value={usd}
                onChange={(e) => setUsd(e.target.value)}
              />
              <small>총액의 최대 40% · 합성 환율로 분리</small>
            </label>
            <label>
              위험도
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value as WebSetup["level"])}
              >
                <option value="LOW">하 · 보수적</option>
                <option value="MEDIUM">중</option>
                <option value="HIGH">상</option>
              </select>
            </label>
            <label>
              노출 단계
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value as WebSetup["stage"])}
              >
                <option value="PILOT">PILOT · 초기 시험</option>
                <option value="STANDARD">STANDARD · 표준 한도</option>
              </select>
            </label>
            <label>
              합성 시나리오
              <select
                value={market}
                onChange={(e) =>
                  setMarket(e.target.value as WebSetup["sampleMarket"])
                }
              >
                <option value="KR">국내 합성 2종목 · B/P</option>
                <option value="US">미국 합성 2종목 · B/P</option>
              </select>
            </label>
          </div>
          <label className="p-check">
            <input
              type="checkbox"
              checked={forecast}
              onChange={(e) => setForecast(e.target.checked)}
            />
            <span>
              합성 예측값으로 모의 주문 경로 시험
              <small>
                기본은 예측 근거 없음 → 주문 보류. 실제 AI 분석이 아닙니다.
              </small>
            </span>
          </label>
          <label className="p-check">
            <input
              type="checkbox"
              required
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>
              시험용 가격·비용·체결·처리 순서와 예정 청산이 포함된 합성
              시나리오임을 확인했어요.
            </span>
          </label>
          <div className="p-info">
            전체 시장 검색·실제 뉴스·SOXL/SOXX 거래는 이 화면에 연결되지
            않았어요. 위험도는 기존 정책의 배율만 적용하며, 손실 방지나 수익을
            보장하지 않아요.
          </div>
          <button className="p-primary" disabled={disabled || !ack}>
            가상 자금 배정 · 실험 생성
          </button>
        </fieldset>
      </form>
    </section>
  );
}
