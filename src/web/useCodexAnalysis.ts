import { useEffect, useRef, useState } from "react";
import type {
  AnalysisCommand,
  AnalysisView,
} from "../core/codex-analysis-schema.js";

export function useCodexAnalysis(csrf: string) {
  const [data, setData] = useState<AnalysisView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [stale, setStale] = useState(true);
  const pending = useRef<AnalysisCommand | null>(null),
    gate = useRef(false),
    sequence = useRef(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const seq = ++sequence.current;
      try {
        const response = await fetch("/api/codex-analysis", {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("ANALYSIS_UNAVAILABLE");
        const value = (await response.json()) as AnalysisView;
        if (live && seq === sequence.current) {
          setData(value);
          setStale(false);
        }
      } catch {
        if (live && seq === sequence.current) setStale(true);
      }
      if (live)
        timer = setTimeout(() => {
          void poll();
        }, 1000);
    }
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [csrf]);
  async function send(command: AnalysisCommand, retry = false) {
    if (gate.current || (pending.current && !retry)) return;
    gate.current = true;
    pending.current = command;
    setBusy(true);
    setError("");
    const seq = ++sequence.current;
    try {
      const response = await fetch("/api/codex-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(5000),
      });
      const value = (await response.json()) as AnalysisView & {
        error?: string;
      };
      if (!response.ok) {
        pending.current = null;
        setUncertain(false);
        throw new Error(value.error ?? "ANALYSIS_REQUEST_REJECTED");
      }
      if (seq === sequence.current) {
        setData(value);
        setStale(false);
      }
      pending.current = null;
      setUncertain(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ANALYSIS_UNAVAILABLE");
      setUncertain(pending.current !== null);
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  return {
    data,
    busy,
    stale,
    uncertain,
    error,
    send,
    retry: () => pending.current && send(pending.current, true),
  };
}
