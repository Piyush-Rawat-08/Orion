"use client";

import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useGalaxy } from "@/lib/hooks";
import { teamColor } from "@/lib/palette";
import { useCosmos } from "./cosmos/CosmosProvider";
import { EASE } from "./ui";

type Item = { id: string; label: string; kind: string; team: string | null; hint: string };

/** ⌘K: find any person, service, team or customer and fly to it. */
export function CommandPalette() {
  const router = useRouter();
  const path = usePathname();
  const { engine } = useCosmos();
  const { data: g } = useGalaxy();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  useEffect(() => {
    if (open) {
      setQ("");
      setI(0);
      setTimeout(() => input.current?.focus(), 30);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!g) return [];
    return [
      ...g.services.map((s) => ({ id: s.id, label: s.label, kind: "service", team: s.team, hint: `tier ${s.tier} · ${s.summary}` })),
      ...g.people.map((p) => ({ id: p.id, label: p.label, kind: "person", team: p.team, hint: p.role })),
      ...g.teams.map((t) => ({ id: t.id, label: t.label, kind: "team", team: t.id, hint: t.mission })),
      ...g.customers.map((c) => ({ id: c.id, label: c.label, kind: "customer", team: null, hint: `${c.tier} · ${c.industry}` })),
    ];
  }, [g]);

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items.filter((x) => x.kind === "service").slice(0, 8);
    return items
      .map((x) => ({ x, score: x.label.toLowerCase().startsWith(s) ? 0 : x.label.toLowerCase().includes(s) ? 1 : x.hint.toLowerCase().includes(s) ? 2 : 9 }))
      .filter((r) => r.score < 9)
      .sort((a, b) => a.score - b.score || a.x.label.localeCompare(b.x.label))
      .slice(0, 9)
      .map((r) => r.x);
  }, [q, items]);

  function go(it: Item) {
    setOpen(false);
    const select = () => {
      engine?.select(it.id);
      engine?.setKnowsFor(it.id);
      engine?.setAutoRotate(false);
      window.dispatchEvent(new CustomEvent("orion:select", { detail: it.id }));
    };
    if (path !== "/sky") {
      router.push("/sky");
      setTimeout(select, 900);
    } else select();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
                    className="fixed inset-0 z-50 flex items-start justify-center bg-void/60 px-4 pt-[16vh] backdrop-blur-sm" onClick={() => setOpen(false)}>
          <motion.div initial={{ y: -10, scale: 0.98 }} animate={{ y: 0, scale: 1 }} transition={{ duration: 0.25, ease: EASE }}
                      className="panel reticle w-full max-w-[560px] overflow-hidden rounded-xl" onClick={(e) => e.stopPropagation()}>
            <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setI(0); }}
                   onKeyDown={(e) => {
                     if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(hits.length - 1, x + 1)); }
                     if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
                     if (e.key === "Enter" && hits[i]) go(hits[i]);
                   }}
                   placeholder="Find a person, service, team or customer…"
                   className="w-full border-b border-white/[0.07] bg-transparent px-4 py-3.5 text-[15px] text-ink outline-none placeholder:text-faint" />
            <div className="max-h-[50vh] overflow-y-auto p-1.5">
              {hits.map((h, k) => (
                <button key={h.id} onMouseEnter={() => setI(k)} onClick={() => go(h)}
                        className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left ${k === i ? "bg-white/[0.07]" : ""}`}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: h.kind === "customer" ? "#d9d2c3" : teamColor(h.team) }} />
                  <span className={`text-[13px] ${h.kind === "service" ? "mono" : ""}`}>{h.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-faint">{h.hint}</span>
                  <span className="mono text-[10px] text-faint">{h.kind}</span>
                </button>
              ))}
              {!hits.length && <div className="px-3 py-3 text-[12px] text-faint">Nothing by that name.</div>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
