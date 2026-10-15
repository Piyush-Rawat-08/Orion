"use client";

// One sky behind every page. Pages don't own a canvas; they tell the shared Cosmos what to show (useCosmos), so
// moving between pages is a camera move or a hyperspace jump, never a reload of the scene.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Cosmos, NodeInfo } from "@/lib/cosmos/engine";
import { teamColor } from "@/lib/palette";

type Handlers = { select?: (n: NodeInfo | null) => void };

type CosmosCtx = {
  engine: Cosmos | null;
  setVeil: (v: number) => void;
  setHandlers: (h: Handlers) => void;
};

const Ctx = createContext<CosmosCtx | null>(null);

export function CosmosProvider({ children }: { children: React.ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Cosmos | null>(null);
  const [veil, setVeil] = useState(0);
  const [hover, setHover] = useState<{ n: NodeInfo; x: number; y: number } | null>(null);
  const handlers = useRef<Handlers>({});

  useEffect(() => {
    let e: Cosmos | null = null;
    let cancelled = false;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const low = (navigator.hardwareConcurrency ?? 8) <= 4 || window.innerWidth < 700;
    import("@/lib/cosmos/engine").then((m) => {
      if (cancelled || !host.current) return;
      e = new m.Cosmos(host.current, { reducedMotion: reduced, quality: low ? "low" : "high" });
      e.onHover = (n, x, y) => setHover(n ? { n, x, y } : null);
      e.onSelect = (n) => handlers.current.select?.(n);
      setEngine(e);
      (window as unknown as { __orion?: unknown }).__orion = e; // handy in the console: __orion.flyTo("svc:ledger")
    });
    return () => {
      cancelled = true;
      e?.dispose();
    };
  }, []);

  const setHandlers = useCallback((h: Handlers) => {
    handlers.current = h;
  }, []);

  return (
    <Ctx.Provider value={{ engine, setVeil, setHandlers }}>
      <div ref={host} className="fixed inset-0 z-0" aria-hidden />
      <div
        className="pointer-events-none fixed inset-0 z-[1] transition-opacity duration-700"
        style={{
          opacity: veil,
          background: "radial-gradient(ellipse at 50% 40%, rgba(4,5,10,.55), rgba(4,5,10,.92) 70%)",
          backdropFilter: veil > 0.5 ? "blur(2px)" : undefined,
        }}
      />
      <AnimatePresence>
        {hover && veil < 0.5 && (
          <motion.div
            key={hover.n.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none fixed z-40"
            style={{ left: hover.x + 18, top: hover.y + 14 }}
          >
            <Tip n={hover.n} />
          </motion.div>
        )}
      </AnimatePresence>
      {children}
    </Ctx.Provider>
  );
}

function Tip({ n }: { n: NodeInfo }) {
  const m = n.meta as Record<string, string | number>;
  const kind = { service: "service", person: "person", customer: "customer", retired: "retired service", former: "left", team: "team" }[n.kind];
  return (
    <div className="panel min-w-44 max-w-64 rounded-md px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: n.kind === "customer" ? "#d9d2c3" : teamColor(n.team) }} />
        <span className="mono text-[10px] uppercase tracking-[0.12em] text-faint">{kind}</span>
        {n.kind === "service" && <span className="mono ml-auto text-[10px] text-muted">tier {m.tier}</span>}
      </div>
      <div className="mt-1 text-[13px] text-ink">{n.label}</div>
      {n.kind === "service" && <div className="mt-0.5 text-[11px] leading-snug text-muted">{String(m.summary ?? "")}</div>}
      {n.kind === "person" && <div className="mt-0.5 text-[11px] text-muted">{String(m.role ?? "")}</div>}
      {n.kind === "customer" && <div className="mt-0.5 text-[11px] text-muted">{String(m.industry)} · {String(m.tier)}</div>}
      {n.kind === "service" && Number(m.knowers) <= 1 && (
        <div className="mono mt-1.5 text-[10px] text-amber">{Number(m.knowers) === 0 ? "nobody knows this" : "one person knows this"}</div>
      )}
    </div>
  );
}

export function useCosmos() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCosmos outside CosmosProvider");
  return c;
}
