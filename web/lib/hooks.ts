"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "./api";
import { useSession } from "./session";
import type { Galaxy } from "./types";

/** Fetch a GET endpoint while signed in; refetch when the company changes (meta.version) or on demand. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const { meta } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const tick = useRef(0);
  const load = useCallback(async () => {
    if (!path || !meta) return;
    const mine = ++tick.current;
    setLoading(true);
    try {
      const d = await get<T>(path);
      if (mine === tick.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === tick.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === tick.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, meta?.version, meta?.me.uid, ...deps]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

export function useGalaxy(on?: string | null, mode: "true" | "known" = "true") {
  const q = on ? `galaxy?on=${encodeURIComponent(on)}&mode=${mode}` : "galaxy";
  return useApi<Galaxy>(q, [on, mode]);
}

export function useReducedMotion() {
  const [r, setR] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setR(m.matches);
    const on = () => setR(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return r;
}
