import { useEffect, useRef, useState } from "react";
import type { PortfolioWebView } from "../server/portfolio-web-run.js";
import type { WebAction } from "../core/portfolio-web-schema.js";
import { when } from "./PortfolioPanels.js";
const statuses: Record<string, string> = {
  STOPPED: "시작 전",
  ENTRY_PAUSED: "신규 진입 중지",
  RUNNING: "진입 허용",
  RECONCILING: "대조 필요",
  HALTED: "위험 한도 잠금",
};
function ConfirmDialog({
  kind,
  onConfirm,
  onCancel,
}: {
  kind: "liquidate" | "freeze";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="p-dialog"
      aria-labelledby="p-confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id="p-confirm-title">
        {kind === "liquidate"
          ? "프로그램 보유분을 청산할까요?"
          : "시나리오 재생을 멈출까요?"}
      </h2>
      <p>
        {kind === "liquidate"
          ? "이 실행의 BOT 보유분에만 청산을 요청하고 남은 합성 호가를 재생해요. 요청은 체결 완료가 아니며 자료 종료·오류 시 보유분이 남을 수 있어요."
          : "신규 진입과 가상 시계를 멈춰요. 보유분은 청산되지 않고 보호 주문 처리도 멈춰요. 계속하려면 보호 처리 또는 명시적 재개가 필요해요."}
      </p>
      <div className="p-actions">
        <button autoFocus onClick={onCancel}>
          취소
        </button>
        <button className="p-primary" onClick={onConfirm}>
          {kind === "liquidate"
            ? "가상 보유분 청산 요청"
            : "저장된 위치에서 재생 정지"}
        </button>
      </div>
    </dialog>
  );
}
export function PortfolioControls({
  view: v,
  runId,
  disabled,
  send,
}: {
  view: PortfolioWebView;
  runId: string;
  disabled: boolean;
  send: (body: unknown) => Promise<boolean>;
}) {
  const [confirm, setConfirm] = useState<"liquidate" | "freeze" | null>(null);
  const control = (action: WebAction) =>
    send({ type: "control", runId, id: crypto.randomUUID(), action });
  return (
    <section className="p-card p-control">
      <div className="p-section-title">
        <div>
          <h2>합성 시나리오 재생</h2>
          <p>
            실행 {runId.slice(0, 8)} ·{" "}
            <span data-testid="portfolio-engine-status">
              {statuses[v.status] ?? v.status}
            </span>
          </p>
        </div>
        <span className="p-tag">TEST ONLY</span>
      </div>
      <div className="p-progress-row">
        <progress
          max={v.totalSteps}
          value={v.step}
          aria-label="시나리오 재생 진행"
        />
        <span>
          {v.step} / {v.totalSteps}
        </span>
      </div>
      <p className="p-clock">
        가상 시각: {when(v.clock)} KST · 실제 장 운영 시간이 아닙니다.
      </p>
      {v.recoveryRequired && (
        <div className="p-alert">
          복구 상태입니다. 미체결이 있으면 ‘보호 처리 계속’으로 취소 결과를
          처리한 뒤, 재생 정지 → ‘장부 대조’를 눌러 주세요. 이후 시작은 별도로
          눌러야 해요.
        </div>
      )}
      {v.finished && (
        <div className="p-info">
          재생 종료 ·{" "}
          {v.exposureCount === 0 && v.pendingCount === 0
            ? "잔여 보유·미체결 0건 확인"
            : "미해결 보유/주문 있음 — 청산 완료 아님. 추가 자료가 필요합니다."}{" "}
          · 실제 수익성 검증이 아닙니다.
        </div>
      )}
      {v.error && (
        <div className="p-alert">
          {v.error} · 서버를 저장 종료한 뒤 같은 실행 복구 검사가 필요해요.
        </div>
      )}
      <div className="p-actions">
        <button
          className="p-primary"
          disabled={
            disabled ||
            v.playing ||
            v.finished ||
            v.recoveryRequired ||
            Boolean(v.error)
          }
          onClick={() => {
            void control({ type: "start" });
          }}
        >
          {v.step ? "명시적 매매 재개" : "모의 거래 시작"}
        </button>
        <button
          disabled={disabled || v.finished}
          onClick={() => {
            void control({ type: "pause" });
          }}
        >
          신규 매수 중지
        </button>
        <button
          disabled={disabled || !v.playing}
          onClick={() => setConfirm("freeze")}
        >
          재생 정지
        </button>
        <button
          disabled={disabled || v.finished || v.playing}
          onClick={() => {
            void control({ type: "protect" });
          }}
        >
          보호 처리 계속
        </button>
        <button
          disabled={disabled || v.playing}
          onClick={() => {
            void control({ type: "reconcile" });
          }}
        >
          장부 대조
        </button>
        <button
          className="p-danger"
          disabled={disabled || (!v.exposureCount && !v.pendingCount)}
          onClick={() => setConfirm("liquidate")}
        >
          프로그램 보유분 청산
        </button>
      </div>
      <small>
        1초마다 시험 명령 1개를 재생해요. 샘플에는 예정 청산·다음 평가 재개가
        포함되지만 사용자 중지 의도를 넘지 않아요. 재생 정지는 보호 처리도
        멈춥니다.
      </small>
      {confirm && (
        <ConfirmDialog
          kind={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const kind = confirm;
            setConfirm(null);
            void control(
              kind === "liquidate"
                ? { type: "liquidate", confirm: true }
                : { type: "freeze" },
            );
          }}
        />
      )}
    </section>
  );
}
