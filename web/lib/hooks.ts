"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "./api";

export interface Fetched<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** ms since epoch of the last successful load */
  at: number | null;
}

/** GET a backend path; re-fetches when `path` changes and every `intervalMs` if given. A null path skips. */
export function useFetch<T>(path: string | null, intervalMs?: number): Fetched<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    const n = ++latest.current;
    const ctrl = new AbortController();
    setLoading(true);
    get<T>(path, { signal: ctrl.signal })
      .then((d) => {
        if (n !== latest.current) return;
        setData(d);
        setError(null);
        setAt(Date.now());
      })
      .catch((e: Error) => {
        if (n !== latest.current || e.name === "AbortError") return;
        setError(e.message || "Request failed");
      })
      .finally(() => n === latest.current && setLoading(false));
    return () => ctrl.abort();
  }, [path, tick]);

  useEffect(() => {
    if (!path || !intervalMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setTick((x) => x + 1);
    }, intervalMs);
    return () => clearInterval(t);
  }, [path, intervalMs]);

  return { data, error, loading, reload, at };
}

/** Keeps the previous value while a new one loads, so canvases don't blank between time steps. */
export function useSticky<T>(value: T | null): T | null {
  const ref = useRef<T | null>(value);
  if (value !== null) ref.current = value;
  return ref.current;
}
