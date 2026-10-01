import { useEffect, useRef, useState } from "react";
import {
  costWebRequestSchema,
  type CostWebRequest,
} from "../core/cost-web-schema.js";
import type { CostWebResponse } from "../server/cost-web-service.js";

const pendingKey = "paperlab.cost-lab.pending.v1";
export function useCostLab(csrf: string) {
  const [data, setData] = useState<CostWebResponse | null>(null);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<CostWebRequest | null>(() => {
    try {
      const saved = localStorage.getItem(pendingKey);
      return saved ? costWebRequestSchema.parse(JSON.parse(saved)) : null;
    } catch {
      return null;
    } // Sending still checks storage and fails closed.
  });
  const gate = useRef(false),
    sequence = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!gate.current) {
        const seq = ++sequence.current;
        try {
          const response = await fetch("/api/cost-lab", {
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok)
            throw Error("COST_WEB_UNAVAILABLE_OR_SESSION_EXPIRED");
          const result = (await response.json()) as CostWebResponse;
          if (live && seq === sequence.current) {
            setData(result);
            setStale(false);
          }
        } catch {
          if (live && seq === sequence.current) setStale(true);
        }
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
  async function send(raw: CostWebRequest, retry = false) {
    if (gate.current || (!retry && pending)) return;
    gate.current = true;
    setBusy(true);
    setError("");
    const seq = ++sequence.current;
    let saved = false;
    try {
      const body = JSON.stringify(costWebRequestSchema.parse(raw));
      const old = localStorage.getItem(pendingKey);
      if (old && old !== body)
        throw Error("COST_WEB_PENDING_REQUEST_REVIEW_REQUIRED");
      localStorage.setItem(pendingKey, body); // Before dispatch, survives reload.
      saved = true;
      setPending(raw);
      const response = await fetch("/api/cost-lab", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
        body,
        signal: AbortSignal.timeout(25000),
      });
      const result = (await response.json()) as CostWebResponse & {
        error?: string;
      };
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        if (localStorage.getItem(pendingKey) !== body)
          throw Error("COST_WEB_PENDING_CHANGED");
        localStorage.removeItem(pendingKey);
        saved = false;
        if (mounted.current) setPending(null);
      }
      if (!response.ok) throw Error(result.error ?? "COST_WEB_REQUEST_FAILED");
      if (mounted.current && seq === sequence.current) {
        setData(result);
        setStale(false);
      }
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : "요청 실패");
        if (saved) setPending(raw);
      }
    } finally {
      gate.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { data, error, stale, busy, pending, send };
}
