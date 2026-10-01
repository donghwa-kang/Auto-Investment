import { useEffect, useRef, useState } from "react";
import type { AnalysisCommand } from "../core/codex-analysis-schema.js";
import type { RecordSourceInfo } from "../core/analysis-record-schema.js";

export function AnalysisRecordPicker({
  csrf,
  disabled,
  send,
}: {
  csrf: string;
  disabled: boolean;
  send: (c: AnalysisCommand) => Promise<void>;
}) {
  const [runs, setRuns] = useState<string[]>([]),
    [runId, setRunId] = useState("");
  const [source, setSource] = useState<RecordSourceInfo | null>(null),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const gate = useRef(false);
  useEffect(() => {
    let live = true;
    void fetch("/api/codex-records", { signal: AbortSignal.timeout(5000) })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "기록 목록을 읽을 수 없습니다. 기록 연결이 제공되는 새 서버인지 확인하세요.",
          );
        const value = (await response.json()) as { runs: string[] };
        if (live) {
          setRuns(value.runs);
          setRunId(value.runs[0] ?? "");
        }
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : "기록 목록 오류");
      });
    return () => {
      live = false;
    };
  }, [csrf]);
  async function inspect() {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    setSource(null);
    try {
      const response = await fetch("/api/codex-records", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ type: "inspect", runId }),
        signal: AbortSignal.timeout(20000),
      });
      const value = (await response.json()) as RecordSourceInfo & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(value.error ?? "ANALYSIS_SOURCE_REJECTED");
      setSource(value);
      setFrom(value.from);
      setTo(value.to);
    } catch (e) {
      setError(e instanceof Error ? e.message : "기록 확인 실패");
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  const valid =
    source &&
    Number.isFinite(Date.parse(from)) &&
    Number.isFinite(Date.parse(to)) &&
    Date.parse(from) <= Date.parse(to) &&
    Date.parse(from) >= Date.parse(source.from) &&
    Date.parse(to) <= Date.parse(source.to);
  return (
    <section className="p-card ca-record-picker">
      <h2>모의 엔진 기록으로 분석 준비</h2>
      <p>
        기록 전용 실행을 선택하면 원본 장부·감사를 읽기 전용으로 대조하고 별도
        스냅샷을 보관합니다. 아직 모형을 실행하거나 외부로 전송하지 않습니다.
      </p>
      {!runs.length && (
        <p>
          선택할 기록 전용 실행이 없습니다. 기존 기록 CLI로 생성한 실행만
          표시하며, 기록을 켜지 않은 웹 실험은 소급 변환하지 않습니다.
        </p>
      )}
      {error && (
        <p className="p-alert" role="alert">
          {error}
        </p>
      )}
      <label>
        기록 전용 실행
        <select
          aria-label="기록 전용 실행"
          disabled={disabled || busy || !runs.length}
          value={runId}
          onChange={(e) => {
            setRunId(e.target.value);
            setSource(null);
          }}
        >
          {!runs.length && <option value="">기록 없음</option>}
          {runs.map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>
      </label>
      <button
        disabled={disabled || busy || !runId}
        onClick={() => {
          void inspect();
        }}
      >
        {busy ? "원본 장부 대조 중…" : "선택 기록 읽기 전용으로 가져오기"}
      </button>
      {source && (
        <div data-testid="record-source-info">
          <p>
            확인된 판단 {source.decisions}건 · 부분 체결 {source.fillEvents}건 ·
            장부 버전 {source.revision}
          </p>
          <p className="ca-hash">
            실험 해시 <code>{source.runHash}</code>
            <br />
            스냅샷 해시 <code>{source.sourceId}</code>
          </p>
          <p>
            아래 구간에 발생한 판단과 그 판단에 연결된 종료 시각까지의 사건만
            포함합니다. 기간 전 보유의 손익이나 전체 계좌 일별 수익률은
            아닙니다. 시간은 UTC입니다.
          </p>
          <label>
            분석 시작 (UTC)
            <input
              aria-label="분석 시작 (UTC)"
              value={from}
              disabled={disabled || busy}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            분석 종료 (UTC)
            <input
              aria-label="분석 종료 (UTC)"
              value={to}
              disabled={disabled || busy}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          {!valid && (
            <p role="alert">
              스냅샷 범위 안의 ISO UTC 시각(예: 2026-09-10T01:00:00.000Z)을
              입력하세요.
            </p>
          )}
          <button
            className="p-primary"
            disabled={disabled || busy || !valid}
            onClick={() => {
              void send({
                type: "create-record",
                id: crypto.randomUUID(),
                sourceId: source.sourceId,
                period: { from, to },
              });
            }}
          >
            이 기록·기간으로 분석 요청 만들기
          </button>
        </div>
      )}
    </section>
  );
}
