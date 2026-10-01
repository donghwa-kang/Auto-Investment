import { useState } from "react";
import type {
  AnalysisJob,
  AnalysisCommand,
  AnalysisStatus,
} from "../core/codex-analysis-schema.js";
import { useCodexAnalysis } from "./useCodexAnalysis.js";
import "./codex-analysis.css";
import { AnalysisRecordPicker } from "./AnalysisRecordPicker.js";
import { AnalysisRecordSummary } from "./AnalysisRecordSummary.js";

const status: Record<AnalysisStatus, string> = {
  AWAITING_APPROVAL: "자료 확인 · 승인 대기",
  APPROVED: "승인 완료 · 실행 대기",
  RUNNING: "모형 실행 중",
  VERIFIED_MOCK: "모형 결과 검증 통과",
  REJECTED: "결과 검증 거절",
  CANCELLED: "취소됨",
  EXPIRED: "승인 기한 만료",
  TIMED_OUT: "실행 시간 초과",
  FAILED: "모형 실행 실패",
  INTERRUPTED: "중단됨 · 재실행 안 함",
};
const metricNames = {
  decisions: "판단 수",
  approved: "승인 판단 수",
  closedTrades: "확정 청산 수",
};
function JobCard({
  job: j,
  disabled,
  send,
}: {
  job: AnalysisJob;
  disabled: boolean;
  send: (c: AnalysisCommand) => Promise<void>;
}) {
  const [reviewed, setReviewed] = useState(false),
    [mockOnly, setMockOnly] = useState(false),
    [opened, setOpened] = useState(false);
  const q = j.request,
    recordBundle =
      q.bundle.version === "ENGINE_RECORD_ANALYSIS_BUNDLE_V1" ? q.bundle : null,
    active = ["AWAITING_APPROVAL", "APPROVED", "RUNNING"].includes(j.state);
  return (
    <section className="p-card ca-job">
      <div className="p-section-title">
        <h2>승인할 자료와 범위</h2>
        <span className="p-tag" data-testid="analysis-status">
          {status[j.state]}
        </span>
      </div>
      <p>
        목적: 합성 매매 기록 복기 · 대상:{" "}
        {recordBundle ? "선택 기간의 모의 판단 묶음" : q.bundle.symbol}
      </p>
      <p>
        자료 기간 (UTC): {q.bundle.periodStart} ~ {q.bundle.asOf}
      </p>
      <p>
        승인·실행 시작 기한: {new Date(q.expiresAt).toLocaleString("ko-KR")}.
        승인 후에도 별도로 실행해야 합니다.
      </p>
      <div className="ca-metrics">
        {Object.entries(q.bundle.source.metrics).map(([key, value]) => (
          <div key={key}>
            <span>{metricNames[key as keyof typeof metricNames]}</span>
            <strong>{value}건</strong>
          </div>
        ))}
      </div>
      <p>
        {recordBundle
          ? "위 수치는 선택한 모의 엔진의 기록에서 대조한 값입니다. 합성 가상 거래이며 현재 시장·실계좌 성과가 아닙니다. 종목/판단 ID는 해시 별칭으로 전달합니다."
          : "위 수치는 화면 연결 시험용 고정 예시입니다. 사용자 거래 기록·학습 결과·현재 시장 데이터가 아닙니다."}
      </p>
      {recordBundle && (
        <AnalysisRecordSummary
          summary={recordBundle.summary}
          records={recordBundle.records}
        />
      )}
      <dl className="ca-contract">
        <dt>전달 대상</dt>
        <dd>
          {q.execution
            ? "이 PC의 제한된 별도 프로세스 · stdio 모형. 외부 전송 없음"
            : "이 PC의 결정적 모형 함수만. 외부 전송 없음"}
        </dd>
        <dt>포함 자료</dt>
        <dd>
          {recordBundle
            ? "선택 판단의 결과·조건 수·진입/손절 계획가·체결 수량/대금/수수료·청산 상태/손익, 통화별 집계, 해시 별칭·기간·정책/출처/요청 해시와 실행 한도"
            : "위 3개 합성 수치, 가상 종목·기간, 출처 ID, 정책 해시, 요청 ID·시간·권한·한도"}
        </dd>
        <dt>제외 자료</dt>
        <dd>
          키·토큰·계좌·잔고·사용자 파일 경로·자유 텍스트/원문·뉴스·실계좌 거래
        </dd>
        <dt>호출 한도</dt>
        <dd>요청당 1회 / 3초 / 재시도 0 / 전체 저장 요청 100개</dd>
        <dt>금지 권한</dt>
        <dd>파일·네트워크·도구·주문·정책 수정·모델 교체</dd>
      </dl>
      {q.execution && (
        <div className="p-alert" data-testid="analysis-execution-boundary">
          고정 모형 전용: 파일/자식 실행 권한과 모듈·통신 API를 제한합니다. 악성
          코드용 OS 샌드박스가 아니며 실제 Codex 연결은 차단되어 있습니다.
          <p className="ca-hash">
            실행 코드 SHA-256 <code>{q.execution.workerSha256}</code>
            <br />
            Node {q.execution.nodeVersion} · {q.execution.protocol}
          </p>
        </div>
      )}
      <details
        onToggle={(e) => {
          if (e.currentTarget.open) setOpened(true);
        }}
      >
        <summary>전달 예정 자료 전체 보기 (JSON)</summary>
        <pre data-testid="analysis-payload">{JSON.stringify(q, null, 2)}</pre>
      </details>
      <p className="ca-hash">
        요청 ID <code>{q.id}</code>
        <br />
        승인 해시 <code>{j.requestHash}</code>
        <br />
        자료 해시 <code>{q.bundleHash}</code>
      </p>
      {j.state === "AWAITING_APPROVAL" && (
        <fieldset disabled={disabled} className="ca-consent">
          <legend>이 요청에만 적용되는 승인</legend>
          <label>
            <input
              type="checkbox"
              disabled={!opened}
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            전체 자료를 열어 확인했고, 이 해시의 자료만 모형에 전달하는 데
            동의합니다.
          </label>
          <label>
            <input
              type="checkbox"
              checked={mockOnly}
              onChange={(e) => setMockOnly(e.target.checked)}
            />
            실제 Codex 분석·외부 전송·거래 적용 승인이 아님을 이해합니다.
          </label>
          <button
            className="p-primary"
            disabled={!opened || !reviewed || !mockOnly}
            onClick={() => {
              void send({
                type: "approve",
                id: q.id,
                requestHash: j.requestHash,
                acknowledgeExactData: true,
                acknowledgeMockOnly: true,
              });
            }}
          >
            이 자료의 모형 전달 승인
          </button>
        </fieldset>
      )}
      <div className="p-actions">
        {j.state === "APPROVED" && (
          <button
            className="p-primary"
            disabled={disabled}
            onClick={() => {
              void send({ type: "run", id: q.id, requestHash: j.requestHash });
            }}
          >
            승인된 모형 1회 실행
          </button>
        )}
        {active && (
          <button
            disabled={disabled}
            onClick={() => {
              void send({
                type: "cancel",
                id: q.id,
                requestHash: j.requestHash,
              });
            }}
          >
            이 분석 취소
          </button>
        )}
      </div>
      {j.error && (
        <p role="status">
          처리 사유: {j.error}. 자동 재시도하지 않습니다. 이미 수행된 모형
          호출은 취소해도 기록에 남습니다.
        </p>
      )}
      {j.result && (
        <div className="ca-result">
          <h3>검증된 모형 제안 · 자동 적용 없음</h3>
          <p>
            검증 범위: 입력/요청 해시, 출처 ID, 기준 시점, 3개 수치와 출력 형식.
            투자 분석 능력이나 수익성 검증이 아닙니다.
          </p>
          {j.result.facts.map((f) => (
            <p className="ca-hash" key={f.metric}>
              {metricNames[f.metric]}: {f.value}건 · 근거 {f.sourceId}
            </p>
          ))}
          {j.result.version === "LOCAL_MOCK_RECORD_RESULT_V1" && (
            <AnalysisRecordSummary summary={j.result.summary} />
          )}
          <ul>
            {j.result.suggestions.map((s) => (
              <li key={s}>
                {s === "COLLECT_MORE_SYNTHETIC_RECORDS"
                  ? "합성 기록을 더 모아 검증 실험을 준비하세요."
                  : "기존 거래 승인·위험관리 조건을 유지하세요."}
              </li>
            ))}
          </ul>
          <p>
            외부 호출 0 · 추가 AI 토큰 0 · 모형 호출 {j.result.usage.mockCalls}
            회
          </p>
          <p className="ca-hash">
            결과 해시 <code>{j.resultHash}</code>
          </p>
        </div>
      )}
    </section>
  );
}
export function CodexAnalysisPanel({ csrf }: { csrf: string }) {
  const api = useCodexAnalysis(csrf);
  const [selected, setSelected] = useState<string | null>(null);
  const jobs = api.data?.jobs ?? [],
    job = jobs.find((j) => j.request.id === selected) ?? jobs[0];
  const active = jobs.some((j) =>
    ["AWAITING_APPROVAL", "APPROVED", "RUNNING"].includes(j.state),
  );
  const disabled = api.busy || api.stale || api.uncertain;
  return (
    <div className="ca-panel">
      <section className="p-card">
        <p className="p-eyebrow">CODEX ANALYSIS · LOCAL MOCK</p>
        <h2>분석 전에, 자료부터 확인해요</h2>
        <p>
          실제 Codex는 연결하지 않았습니다. 고정 합성 예시 또는 기록된 모의
          자료로 승인·실행·검증 절차만 시험합니다. 모형 연결은 거래 엔진과
          독립적이며 수익 예측을 제공하지 않습니다.
        </p>
        <p>
          외부 호출 0 · 추가 AI 사용량 0 ·{" "}
          {api.data
            ? `기록된 모형 호출 ${api.data.mockCalls}회`
            : "기록 확인 중"}
        </p>
        <button
          className="p-primary"
          disabled={disabled || active || jobs.length >= 100}
          onClick={() => {
            setSelected(null);
            void api.send({
              type: "create",
              id: crypto.randomUUID(),
              dataset: "SYNTHETIC_REVIEW_FIXTURE_V1",
            });
          }}
        >
          합성 자료로 분석 요청 만들기
        </button>
      </section>
      <AnalysisRecordPicker
        csrf={csrf}
        disabled={disabled || active || jobs.length >= 100}
        send={async (command) => {
          setSelected(null);
          await api.send(command);
        }}
      />
      {api.stale && (
        <div className="p-alert" role="alert">
          분석 상태를 확인할 수 없어 승인을 차단했습니다. 마지막 표시를 현재
          상태로 간주하지 마세요. 이 기능은 새 다종목 서버에서 제공됩니다.
        </div>
      )}
      {api.error && (
        <div className="p-alert" role="alert">
          요청 확인: {api.error}
          {api.uncertain && (
            <>
              <p>
                응답이 유실되어 처리 여부가 불확실합니다. 동일 요청으로 확인하며
                모형을 중복 실행하지 않습니다.
              </p>
              <button
                disabled={api.busy}
                onClick={() => {
                  void api.retry();
                }}
              >
                분석 동일 요청 재확인
              </button>
            </>
          )}
        </div>
      )}
      {job && (
        <JobCard
          key={job.requestHash}
          job={job}
          disabled={disabled}
          send={api.send}
        />
      )}
      {jobs.length > 0 && (
        <section className="p-card">
          <h2>분석 요청 기록</h2>
          {jobs.map((j) => (
            <button
              className="ca-history"
              key={j.request.id}
              onClick={() => setSelected(j.request.id)}
            >
              {new Date(j.request.createdAt).toLocaleString("ko-KR")} ·{" "}
              {status[j.state]} · {j.request.id.slice(0, 8)}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
