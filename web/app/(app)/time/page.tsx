"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCosmos } from "@/components/cosmos/CosmosProvider";
import { EASE, Section } from "@/components/ui";
import { get } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Galaxy, TimelineEvent } from "@/lib/types";

type Timeline = { events: TimelineEvent[]; activity: { month: string; n: number }[]; start: string; now: string };

const DAY = 86400000;
const toDays = (iso: string, start: string) => Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(start)) / DAY);
const fromDays = (d: number, start: string) => new Date(Date.parse(start) + d * DAY).toISOString().slice(0, 10);

const MARK: Record<TimelineEvent["kind"], { color: string; label: string }> = {
  born: { color: "#7ee0b5", label: "goes live" },
  retired: { color: "#ff6a3d", label: "retired" },
  joined: { color: "#9fb7ff", label: "joins" },
  left: { color: "#8b90a0", label: "leaves" },
  decision: { color: "#ece8dc", label: "decision" },
  incident: { color: "#ff4d2e", label: "incident" },
  discovered: { color: "#ffb547", label: "found out" },
};

export default function TimePage() {
  const { engine, setVeil, setHandlers } = useCosmos();
  const { data: tl } = useApi<Timeline>("timeline");
  const [day, setDay] = useState<number | null>(null);
  const [mode, setMode] = useState<"true" | "known">("true");
  const [g, setG] = useState<Galaxy | null>(null);
  const [now, setNow] = useState<Galaxy | null>(null);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState<TimelineEvent | null>(null);
  const req = useRef(0);

  useEffect(() => setVeil(0), [setVeil]);
  useEffect(() => {
    setHandlers({ select: (n) => n && engine?.flash(n.id, "#ffb547") });
    return () => setHandlers({});
  }, [setHandlers, engine]);
  useEffect(() => {
    get<Galaxy>("galaxy").then(setNow).catch(() => {});
  }, []);

  const span = tl ? toDays(tl.now, tl.start) : 1000;
  useEffect(() => {
    if (tl && day === null) setDay(toDays("2026-03-02", tl.start));
  }, [tl, day]);

  const date = tl && day !== null ? fromDays(day, tl.start) : null;

  // load the epoch for the date (debounced while dragging)
  useEffect(() => {
    if (!date || !engine) return;
    const mine = ++req.current;
    const t = setTimeout(async () => {
      try {
        const epoch = await get<Galaxy>(`galaxy?on=${date}&mode=${mode}`);
        if (mine !== req.current) return;
        setG(epoch);
        engine.blackHole(null);
        engine.clearBlast();
        engine.setFocus(null);
        engine.setData(epoch, { animate: true });
        engine.setConstellations("all");
      } catch {}
    }, playing ? 0 : 160);
    return () => clearTimeout(t);
  }, [date, mode, engine, playing]);

  // timelapse: a month every 1.1 s
  useEffect(() => {
    if (!playing || !tl) return;
    const id = setInterval(() => {
      setDay((d) => {
        const n = (d ?? 0) + 30;
        if (n >= span) {
          setPlaying(false);
          return span;
        }
        return n;
      });
    }, 1100);
    return () => clearInterval(id);
  }, [playing, tl, span]);

  const near = useMemo(() => {
    if (!tl || !date) return [];
    const d = toDays(date, tl.start);
    return tl.events.filter((e) => Math.abs(toDays(e.at, tl.start) - d) <= 45).slice(-8);
  }, [tl, date]);

  const ghost = useMemo(() => {
    if (!g) return null;
    const dep = g.deps.find((x) => x.source === "svc:invoice-render" && x.target === "svc:sso-legacy");
    return dep ? "visible" : "hidden";
  }, [g]);

  const flipMode = useCallback((m: "true" | "known") => {
    setMode(m);
    setTimeout(() => {
      engine?.flash("svc:invoice-render", m === "known" ? "#8b90a0" : "#ffb547");
      engine?.flyTo("svc:invoice-render", 110);
    }, 500);
  }, [engine]);

  const services = new Set(g?.services.map((s) => s.label));
  const nowServices = new Set(now?.services.map((s) => s.label));
  const notYet = [...nowServices].filter((s) => !services.has(s));
  const gone = [...services].filter((s) => !nowServices.has(s));

  return (
    <main className="pointer-events-none relative z-10 min-h-dvh">
      {/* the epoch */}
      <motion.aside initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.7, ease: EASE }}
                    className="panel scroll-quiet pointer-events-auto fixed left-4 top-[88px] z-20 max-h-[calc(100dvh-300px)] w-[calc(100vw-2rem)] overflow-y-auto rounded-xl p-4 md:left-6 md:w-[330px]">
        <div className="mono text-[10px] tracking-[0.14em] text-faint">CHECKOUT</div>
        <AnimatePresence mode="wait">
          <motion.div key={date} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}
                      className="display mt-1 text-[40px] leading-none">
            {date ? new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "…"}
          </motion.div>
        </AnimatePresence>
        <div className="mono mt-1.5 text-[10px] text-faint">epoch:corvane:{date}:{mode}</div>

        <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg border border-white/[0.06] p-1">
          <button onClick={() => flipMode("true")} className={`rounded-md py-1.5 text-[12px] ${mode === "true" ? "bg-white/[0.08] text-ink" : "text-muted"}`}>As it was</button>
          <button onClick={() => flipMode("known")} className={`rounded-md py-1.5 text-[12px] ${mode === "known" ? "bg-white/[0.08] text-ink" : "text-muted"}`}>As it was known</button>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          {mode === "true"
            ? "Every fact that was true on this date, including ones nobody had written down yet."
            : "Only what had been recorded by this date. The difference is what Corvane didn't know it didn't know."}
        </p>
        {ghost && date && date >= "2024-06-10" && date < "2026-03-24" && (
          <div className={`mt-3 rounded-md border px-3 py-2 text-[11px] leading-relaxed ${ghost === "visible" ? "border-amber/30 bg-amber/[0.06] text-ink/85" : "border-white/10 text-muted"}`}>
            {ghost === "visible"
              ? "invoice-render already calls sso-legacy for its signing token on this date, but nobody writes it down until 24 March 2026."
              : "As known on this date, invoice-render doesn't depend on sso-legacy at all. Switch to “as it was” to see the call that took invoicing down."}
          </div>
        )}

        {g && (
          <div className="mt-4 space-y-4">
            <div className="mono grid grid-cols-3 gap-2 text-center">
              {[["services", g.stats.services], ["people", g.stats.people], ["dependencies", g.stats.deps]].map(([k, v]) => (
                <div key={k} className="rounded-md border border-white/[0.06] py-2">
                  <div className="text-[18px] text-ink">{v}</div>
                  <div className="text-[9px] uppercase tracking-[0.1em] text-faint">{k}</div>
                </div>
              ))}
            </div>
            {(notYet.length > 0 || gone.length > 0) && (
              <Section title="Compared with now">
                {notYet.length > 0 && <div className="text-[11px] text-muted"><span className="text-ok">not born yet:</span> {notYet.join(", ")}</div>}
                {gone.length > 0 && <div className="mt-1 text-[11px] text-muted"><span className="text-nova">retired since then:</span> {gone.join(", ")}</div>}
                {g.former.length > 0 && <div className="mt-1 text-[11px] text-muted"><span className="text-faint">had already left:</span> {g.former.map((p) => p.label).join(", ")}</div>}
              </Section>
            )}
            {near.length > 0 && (
              <Section title="Around this time">
                <div className="space-y-1.5">
                  {near.map((e) => (
                    <button key={e.at + e.uid} onClick={() => setDay(toDays(e.at, tl!.start))} className="flex w-full gap-2 text-left text-[11px]">
                      <span className="mono shrink-0 text-faint">{e.at.slice(5)}</span>
                      <span className="h-1.5 w-1.5 shrink-0 translate-y-1 rounded-full" style={{ background: MARK[e.kind].color }} />
                      <span className="text-ink/80">{e.label}</span>
                    </button>
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}
      </motion.aside>

      {/* the chronograph */}
      {tl && day !== null && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: EASE, delay: 0.2 }}
                    className="panel pointer-events-auto fixed inset-x-4 bottom-24 z-20 rounded-xl px-4 pb-3 pt-3 md:inset-x-6 md:bottom-6">
          <div className="mb-2 flex items-center gap-3">
            <button onClick={() => { if (day >= span) setDay(0); setPlaying((p) => !p); }}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-amber text-void shadow-[0_0_30px_-6px_#ffb547]" aria-label={playing ? "pause" : "play"}>
              {playing ? <svg width="10" height="10"><rect x="1" width="3" height="10" fill="currentColor" /><rect x="6" width="3" height="10" fill="currentColor" /></svg>
                : <svg width="10" height="10"><path d="M1 0 L10 5 L1 10 Z" fill="currentColor" /></svg>}
            </button>
            <div className="mono text-[10px] tracking-[0.12em] text-faint">PLAY THE COMPANY FROM JANUARY 2024</div>
            <div className="mono ml-auto hidden gap-3 text-[10px] text-faint md:flex">
              {Object.entries(MARK).map(([k, m]) => (
                <span key={k} className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />{m.label}</span>
              ))}
            </div>
          </div>
          <Chrono tl={tl} day={day} span={span} onDay={(d) => { setPlaying(false); setDay(d); }} onHover={setHover} />
          <div className="mono mt-1 h-4 text-[11px] text-muted">{hover ? `${hover.at} · ${hover.label}` : ""}</div>
        </motion.div>
      )}
    </main>
  );
}

function Chrono({ tl, day, span, onDay, onHover }: { tl: Timeline; day: number; span: number; onDay: (d: number) => void; onHover: (e: TimelineEvent | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1000);
  useEffect(() => {
    const ro = new ResizeObserver(() => setW(ref.current?.clientWidth ?? 1000));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const H = 92;
  const x = (d: number) => (d / span) * w;
  const max = Math.max(...tl.activity.map((a) => a.n), 1);
  const drag = useRef(false);
  const set = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    onDay(Math.max(0, Math.min(span, Math.round(((clientX - r.left) / r.width) * span))));
  };
  const lanes: Record<string, number> = { decision: 18, incident: 18, discovered: 18, born: 34, retired: 34, joined: 50, left: 50 };
  return (
    <div ref={ref} className="relative cursor-ew-resize select-none" style={{ height: H }}
         onPointerDown={(e) => { drag.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); set(e.clientX); }}
         onPointerMove={(e) => drag.current && set(e.clientX)}
         onPointerUp={() => (drag.current = false)}>
      <svg width={w} height={H} className="absolute inset-0 overflow-visible">
        <defs>
          <linearGradient id="spec" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#6f9bff" stopOpacity="0.15" />
            <stop offset="0.6" stopColor="#b48cff" stopOpacity="0.45" />
            <stop offset="1" stopColor="#ffb547" stopOpacity="0.9" />
          </linearGradient>
        </defs>
        {/* spectrogram of changes per month */}
        {tl.activity.map((a) => {
          const d0 = toDays(a.month + "-01", tl.start);
          const bw = Math.max(2, x(30) - 2);
          const h = (a.n / max) * 30;
          return <rect key={a.month} x={x(d0)} y={H - 6 - h} width={bw} height={h} fill="url(#spec)" rx="1" opacity={d0 <= day ? 1 : 0.35} />;
        })}
        {/* years */}
        {["2024-01-01", "2025-01-01", "2026-01-01"].map((y) => (
          <g key={y}>
            <line x1={x(toDays(y, tl.start))} y1={8} x2={x(toDays(y, tl.start))} y2={H - 4} stroke="rgba(236,232,220,.08)" />
            <text x={x(toDays(y, tl.start)) + 4} y={H - 40} className="mono" fontSize="10" fill="rgba(236,232,220,.35)">{y.slice(0, 4)}</text>
          </g>
        ))}
        {tl.events.map((e, i) => {
          const ex = x(toDays(e.at, tl.start));
          const y = lanes[e.kind];
          const c = MARK[e.kind].color;
          return (
            <g key={i} onPointerEnter={() => onHover(e)} onPointerLeave={() => onHover(null)} className="cursor-pointer">
              {e.kind === "incident" ? (
                <path d={`M ${ex} ${y - 6} L ${ex + 2} ${y - 2} L ${ex + 6} ${y} L ${ex + 2} ${y + 2} L ${ex} ${y + 6} L ${ex - 2} ${y + 2} L ${ex - 6} ${y} L ${ex - 2} ${y - 2} Z`} fill={c} />
              ) : e.kind === "decision" ? (
                <rect x={ex - 3} y={y - 3} width="6" height="6" transform={`rotate(45 ${ex} ${y})`} fill="none" stroke={c} strokeWidth="1.2"
                      opacity={e.status === "accepted" ? 1 : 0.5} />
              ) : (
                <circle cx={ex} cy={y} r={e.kind === "discovered" ? 4 : 2.6} fill={c} />
              )}
              {e.kind === "discovered" && <circle cx={ex} cy={y} r="8" fill="none" stroke={c} strokeOpacity="0.5" />}
              <rect x={ex - 6} y={y - 8} width="12" height="16" fill="transparent" />
            </g>
          );
        })}
        {/* playhead */}
        <g style={{ transform: `translateX(${x(day)}px)`, transition: "transform .25s cubic-bezier(.22,1,.36,1)" }}>
          <line x1={0} y1={0} x2={0} y2={H} stroke="#ffb547" strokeWidth="1.5" />
          <circle cx={0} cy={4} r="4" fill="#ffb547" />
          <rect x={-1} y={0} width={2} height={H} fill="#ffb547" opacity="0.15" filter="blur(4px)" />
        </g>
      </svg>
    </div>
  );
}
