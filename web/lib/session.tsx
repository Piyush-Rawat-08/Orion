"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { get, open, setToken, TENANT } from "./api";
import type { Meta, Person } from "./types";

type SessionState = {
  ready: boolean;
  meta: Meta | null;
  signIn: (person: string) => Promise<void>;
  signOut: () => void;
  refresh: () => Promise<void>;
};

const Ctx = createContext<SessionState | null>(null);
const KEY = `orion:${TENANT}:token`;

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMeta(await get<Meta>("meta"));
    } catch {
      setToken(null);
      try {
        localStorage.removeItem(KEY);
      } catch {}
      setMeta(null);
    }
  }, []);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {}
    if (saved) {
      setToken(saved);
      refresh().finally(() => setReady(true));
    } else {
      setReady(true);
    }
  }, [refresh]);

  const signIn = useCallback(
    async (person: string) => {
      const r = await open<{ token: string; me: Person }>(`${TENANT}/login`, {
        method: "POST",
        body: JSON.stringify({ person }),
      });
      setToken(r.token);
      try {
        localStorage.setItem(KEY, r.token);
      } catch {}
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(() => {
    setToken(null);
    try {
      localStorage.removeItem(KEY);
    } catch {}
    setMeta(null);
  }, []);

  return <Ctx.Provider value={{ ready, meta, signIn, signOut, refresh }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
}
