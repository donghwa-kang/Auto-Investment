import { useCallback, useEffect, useRef, useState } from "react";
import type { PortfolioWebResponse } from "../server/portfolio-web-service.js";

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    signal: AbortSignal.timeout(20000),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "LOCAL_SESSION_REQUIRED"
        : (result.error ?? "REQUEST_FAILED"),
    );
  return result;
}
export function usePortfolio() {
  const [csrf, setCsrf] = useState("");
  const [data, setData] = useState<PortfolioWebResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const gate = useRef(false),
    pending = useRef<unknown>(null),
    sequence = useRef(0);
  const accept = useCallback((value: PortfolioWebResponse, seq: number) => {
    if (seq === sequence.current) setData(value);
  }, []);
  useEffect(() => {
    let live = true;
    void request<{ csrf: string }>("/api/session")
      .then((x) => {
        if (live) setCsrf(x.csrf);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!csrf) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const seq = ++sequence.current;
      try {
        const result = await request<PortfolioWebResponse>("/api/portfolio");
        if (live) {
          accept(result, seq);
          setStale(false);
        }
      } catch (e) {
        if (live) {
          setStale(true);
          if (e instanceof Error && e.message === "LOCAL_SESSION_REQUIRED")
            setCsrf("");
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
  }, [csrf, accept]);
  async function login(code: string) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    try {
      const x = await request<{ csrf: string }>("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      setCsrf(x.csrf);
    } catch (e) {
      setError(e instanceof Error ? e.message : "연결 실패");
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  async function send(body: unknown, retry = false) {
    if (gate.current || (!retry && pending.current)) return false;
    gate.current = true;
    setBusy(true);
    setError("");
    pending.current = body;
    const seq = ++sequence.current;
    try {
      const response = await fetch("/api/portfolio", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const result = (await response.json()) as PortfolioWebResponse & {
        error?: string;
      };
      if (!response.ok) {
        pending.current = null;
        setUncertain(false);
        throw new Error(result.error ?? "WEB_REQUEST_REJECTED");
      }
      accept(result, seq);
      pending.current = null;
      setUncertain(false);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청 실패");
      setUncertain(pending.current !== null);
      return false;
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  return {
    csrf,
    data,
    error,
    busy,
    stale,
    uncertain,
    login,
    send,
    retry: () => send(pending.current, true),
  };
}
