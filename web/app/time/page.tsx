"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/AppProvider";
import LazyGraphCanvas from "@/components/graph/GraphCanvasLazy";
import type { DiffPaint, EdgeGraph } from "@/components/graph/GraphCanvas";
import { EASE } from "@/components/motion";
import { Handle, Pane, Split, useMedia } from "@/components/Split";
import { ErrorNote, Kbd, NodeTypeLegend, Spinner } from "@/components/ui";
import { useFetch, useSticky } from "@/lib/hooks";
import { dateFromIndex, dayIndex, fmtDate, fmtMonth } from "@/lib/format";
import { edgeKey } from "@/lib/graph";
import { C } from "@/lib/theme";
import type { GEdge, GNode, GraphPayload, Timeline } from "@/lib/types";
import { NODE_WORD, relWord } from "@/lib/words";

const STRUCTURAL = new Set(["DEPENDS_ON", "OWNS", "MEMBER_OF", "USES", "AFFECTS", "ON_CALL_FOR"]);

type Stop = { i: number; date: string; kind: "month" | "decision" | "event" | "now"; label: string };

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-b border-rule px-5 py-5 last:border-b-0">
      <h2 className="pane-title mb-3">
        <span className="text-ink">{title}</span>
        {aside}
      </h2>
      {children}
    </section>
  );
}

/** "41 people, 7 teams and 27 systems": who and what the company had on the selected date. */
function census(nodes: GNode[]): string {
  const c: Record<string, number> = {};
  for (const n of nodes) if (!n.former && !n.retired) c[n.type] = (c[n.type] ?? 0) + 1;
  const parts = ([
    [c.Person, "people"],
    [c.Team, "teams"],
    [c.Service, "systems"],
    [c.Customer, "customers"],
    [c.Decision, "decisions on record"],
  ].filter(([n]) => n) as [number, string][]).map(([n, l]) => `${n} ${l}`);
  if (!parts.length) return "";
  return `${parts.slice(0, -1).join(", ")}${parts.length > 1 ? " and " : ""}${parts[parts.length - 1]}.`;
}

export default function TimePage() {
  const { openBlame } = useApp();
  const wide = useMedia("(min-width: 1024px)");
  const tl = useFetch<Timeline>("/timeline");
  const t = tl.data;
  const start = t?.start ?? "2024-01-01";
  const end = t ? t.now.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const total = dayIndex(end, start);

  const stops: Stop[] = useMemo(() => {
    if (!t) return [];
    const s: Stop[] = t.months
      .filter((m) => m <= end)
      .map((m) => ({ i: dayIndex(m, start), date: m, kind: "month" as const, label: fmtMonth(m) }));
    for (const d of t.decisions) s.push({ i: dayIndex(d.at, start), date: d.at.slice(0, 10), kind: "decision", label: d.key });
    for (const e of t.events) s.push({ i: dayIndex(e.at, start), date: e.at.slice(0, 10), kind: "event", label: e.label });
    s.push({ i: total, date: end, kind: "now", label: "Now" });
    return s.filter((x) => x.i >= 0 && x.i <= total).sort((a, b) => a.i - b.i);
  }, [t, start, end, total]);

  const [pos, setPos] = useState<number | null>(null); // live thumb position while dragging
  const [committed, setCommitted] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const cur = committed ?? total;
  const live = pos ?? cur;

  const snap = useCallback(
    (i: number) => {
      if (!stops.length) return i;
      return stops.reduce((best, s) => (Math.abs(s.i - i) < Math.abs(best - i) ? s.i : best), stops[0].i);
    },
    [stops],
  );

  const commit = (i: number) => {
    const s = snap(i);
    setPos(null);
    setCommitted(s);
  };

  const uniq = useMemo(() => [...new Set(stops.map((s) => s.i))], [stops]);
  const step = useCallback(
    (dir: 1 | -1) => {
      const next = dir === 1 ? uniq.find((i) => i > cur) : [...uniq].reverse().find((i) => i < cur);
      if (next !== undefined) setCommitted(next);
      return next !== undefined;
    },
    [uniq, cur],
  );

  // play history: from the first stop to now, one stop at a time
  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => {
      if (!step(1)) setPlaying(false);
    }, 1300);
    return () => clearTimeout(id);
  }, [playing, cur, step]);
  const play = () => {
    if (playing) return setPlaying(false);
    if (cur >= total && uniq.length) setCommitted(uniq[0]);
    setPlaying(true);
  };

  const date = dateFromIndex(cur, start);
  const isNow = cur >= total;
  const graph = useFetch<GraphPayload>(t ? (isNow ? "/graph" : `/graph?asof=${date}`) : null);
  const shown = useSticky(graph.data);

  // what changed since the previous stop: drives the pulse and the green/red edges
  const prev = useRef<GraphPayload | null>(null);
  const [changes, setChanges] = useState<{ from: string; appeared: GNode[]; gone: GNode[]; added: GEdge[]; removed: GEdge[] } | null>(null);
  useEffect(() => {
    const g = graph.data;
    if (!g) return;
    const p = prev.current;
    prev.current = g;
    if (!p || p === g) return;
    const pn = new Set(p.nodes.map((n) => n.id));
    const gn = new Set(g.nodes.map((n) => n.id));
    const pe = new Set(p.edges.filter((e) => STRUCTURAL.has(e.type)).map(edgeKey));
    const ge = new Set(g.edges.filter((e) => STRUCTURAL.has(e.type)).map(edgeKey));
    setChanges({
      from: p.asof,
      appeared: g.nodes.filter((n) => !pn.has(n.id)),
      gone: p.nodes.filter((n) => !gn.has(n.id)),
      added: g.edges.filter((e) => STRUCTURAL.has(e.type) && !pe.has(edgeKey(e))),
      removed: p.edges.filter((e) => STRUCTURAL.has(e.type) && !ge.has(edgeKey(e))),
    });
  }, [graph.data]);

  const paint: DiffPaint | null = useMemo(
    () =>
      changes
        ? {
            broken: new Map(),
            revealHops: 0,
            orphans: new Set(),
            addedEdges: new Set(changes.added.map(edgeKey)),
            removedEdges: new Set(changes.removed.map(edgeKey)),
            accent: C.trunk,
          }
        : null,
    [changes],
  );
  const pulse = useMemo(() => changes?.appeared.map((n) => n.id) ?? null, [changes]);

  const onEdgeClick = useCallback(
    (e: GEdge, s?: GNode, tt?: GNode, g?: EdgeGraph) =>
      openBlame({ fact: e.uid ?? null, edge: e, sourceName: s?.name, targetName: tt?.name, source: s, target: tt, graph: g }),
    [openBlame],
  );

  const decisions = (shown?.nodes ?? []).filter((n) => n.type === "Decision").sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const pct = (i: number) => `calc(8px + (100% - 16px) * ${total ? i / total : 0})`;
  const nm = (id: string) => shown?.nodes.find((n) => n.id === id)?.name ?? prev.current?.nodes.find((n) => n.id === id)?.name ?? id;
  const liveDate = dateFromIndex(live, start);

  // the full record, grouped by year (the background ADRs go back to 2024)
  const history = useMemo(() => {
    if (!t) return [];
    const rows = [
      ...t.decisions.map((d) => ({ at: d.at.slice(0, 10), text: d.title, ref: d.key, kind: "decision" as const })),
      ...t.events.map((e) => ({ at: e.at.slice(0, 10), text: e.label, ref: e.kind.replace("dependency ", ""), kind: "event" as const })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const years = new Map<string, typeof rows>();
    for (const r of rows) years.set(r.at.slice(0, 4), [...(years.get(r.at.slice(0, 4)) ?? []), r]);
    return [...years.entries()];
  }, [t]);

  const canvas = (
    <section className="relative h-full min-h-0" aria-label="The company on the selected date">
      <LazyGraphCanvas
        data={shown}
        diff={paint}
        ghostEdges={changes?.removed}
        pulse={pulse}
        pulseColor={C.added}
        onEdgeClick={onEdgeClick}
        ariaLabel={`The company as it was on ${fmtDate(date, true)}`}
      />
      <div className="pointer-events-none absolute left-5 top-5">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.p
            key={liveDate}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16, ease: EASE }}
            className="heading text-[clamp(1.9rem,3.2vw,2.75rem)] leading-none tracking-[-0.02em]"
          >
            {fmtDate(liveDate, true)}
          </motion.p>
        </AnimatePresence>
        <p className="mt-2 flex items-center gap-2 text-[12px] text-muted">
          {isNow && pos === null ? (
            <>
              <span className="size-[6px] rounded-full bg-ok" /> today
            </>
          ) : (
            <>
              <span className="size-[6px] rounded-full bg-ember" /> the company as it was on this day
            </>
          )}
          {graph.loading && <Spinner size={11} className="text-ember" />}
        </p>
      </div>
      <div className="hud pointer-events-none absolute right-3.5 top-3.5 max-w-[60%] px-3 py-2">
        <NodeTypeLegend />
      </div>
      {graph.error && (
        <div className="absolute inset-x-6 top-28">
          <ErrorNote error={graph.error} onRetry={graph.reload} />
        </div>
      )}
    </section>
  );

  const scrubber = (
    <section aria-label="Pick a date" className="shrink-0 border-t border-rule bg-panel px-5 pb-3 pt-3">
      <div className="flex items-center gap-3">
        <button type="button" className="btn h-8 w-[84px] justify-center" onClick={play} disabled={!t} aria-pressed={playing}>
          {playing ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 1.5v7M8 1.5v7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 1.2l6.5 3.8L2 8.8z" fill="currentColor" /></svg>
          )}
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" className="btn btn-ghost h-8 w-8 justify-center px-0" onClick={() => step(-1)} aria-label="Previous event" disabled={!t}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M6.5 1.5L3 5l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
        <div className="relative min-w-0 flex-1">
          {/* decisions */}
          <div className="relative h-6" aria-hidden>
            {stops
              .filter((s) => s.kind === "decision")
              .map((s) => (
                <span
                  key={`d${s.i}${s.label}`}
                  className="absolute top-0 -translate-x-1/2 text-center"
                  style={{ left: pct(s.i) }}
                  title={s.label}
                >
                  <span className={`mono block text-[11px] font-medium ${s.i <= live ? "text-ink" : "text-faint"}`}>{s.label.replace("ADR-0", "").replace("ADR-", "")}</span>
                  <span className={`mx-auto mt-0.5 block size-[6px] rotate-45 ${s.i <= live ? "bg-ink" : "bg-faint"}`} />
                </span>
              ))}
          </div>
          <div className="relative">
            {/* weeks */}
            {Array.from({ length: Math.floor(total / 7) + 1 }, (_, w) => (
              <span key={w} className="absolute top-[13px] h-[6px] w-px bg-rule" style={{ left: pct(w * 7) }} aria-hidden />
            ))}
            {/* travelled part of the track */}
            <span className="absolute top-[15.5px] h-px bg-ember/60" style={{ left: 8, width: `calc((100% - 16px) * ${total ? live / total : 0})` }} aria-hidden />
            {stops
              .filter((s) => s.kind === "event")
              .map((s, k) => (
                <span key={`e${k}`} className="absolute top-[9px] h-[14px] w-[2px] rounded-full bg-warn/80" style={{ left: pct(s.i) }} aria-hidden />
              ))}
            <input
              type="range"
              className="scrub relative"
              min={0}
              max={total}
              step={1}
              value={live}
              disabled={!t}
              aria-label="Date"
              aria-valuetext={fmtDate(liveDate, true)}
              onChange={(e) => {
                setPlaying(false);
                setPos(Number(e.target.value));
              }}
              onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
              onKeyDown={(e) => {
                if (["ArrowRight", "ArrowUp"].includes(e.key)) {
                  e.preventDefault();
                  step(1);
                } else if (["ArrowLeft", "ArrowDown"].includes(e.key)) {
                  e.preventDefault();
                  step(-1);
                }
              }}
              onBlur={() => pos !== null && commit(pos)}
            />
          </div>
          <div className="relative h-4" aria-hidden>
            {stops
              .filter((s) => s.kind === "month")
              // a long history shows every third month, and each January as its year
              .filter((s, _, all) => all.length <= 12 || Number(s.date.slice(5, 7)) % 3 === 1)
              .map((s, _, all) => (
                <span key={`m${s.i}`} className="mono absolute top-0 -translate-x-1/2 text-[11px] text-faint" style={{ left: pct(s.i) }}>
                  {all.length > 4 && s.date.slice(5, 7) === "01" ? s.date.slice(0, 4) : s.label}
                </span>
              ))}
          </div>
        </div>
        <button type="button" className="btn btn-ghost h-8 w-8 justify-center px-0" onClick={() => step(1)} aria-label="Next event" disabled={!t}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M3.5 1.5L7 5 3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 pl-[100px] text-[11px] text-faint">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-[6px] rotate-45 bg-ink" /> decision
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[10px] w-[2px] rounded-full bg-warn" /> systems start or stop relying on each other
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> jump between events
        </span>
      </p>
      {tl.error && <ErrorNote error={tl.error} onRetry={tl.reload} />}
    </section>
  );

  const side = (
    <aside className="h-full min-h-0 overflow-y-auto bg-panel text-sm">
      <Section title={isNow ? "Today" : fmtDate(date, true)}>
        <p className="text-[13px] leading-relaxed text-muted">
          {census(shown?.nodes ?? [])}
          {!isNow && " Everything on the map, and every answer about this date, uses only what was true and known then."}
        </p>
        {isNow && (
          <p className="mt-2 text-[12px] leading-relaxed text-faint">
            Press Play, or drag the slider below, to watch the company change since January 2024.
          </p>
        )}
      </Section>

      {changes && (
        <Section title={`What changed since ${fmtDate(changes.from.slice(0, 10), true)}`}>
          {!changes.appeared.length && !changes.gone.length && !changes.added.length && !changes.removed.length && (
            <p className="text-xs text-muted">Nothing about who works where, or what relies on what, changed.</p>
          )}
          <ul className="space-y-1 text-[12px] leading-snug">
            {changes.appeared.map((n) => (
              <li key={n.id} className="text-ok">New {(NODE_WORD[n.type] ?? n.type).toLowerCase()}: {n.name}</li>
            ))}
            {changes.gone.map((n) => (
              <li key={n.id} className="text-bad">
                {n.type === "Person" ? "Left" : n.type === "Service" ? "Switched off" : "Gone"}: {n.name}
              </li>
            ))}
            {changes.added.map((e) => (
              <li key={edgeKey(e)} className="text-ok">
                Started: {nm(e.source)} {relWord(e.type)} {nm(e.target)}
              </li>
            ))}
            {changes.removed.map((e) => (
              <li key={edgeKey(e)} className="text-bad">
                Ended: {nm(e.source)} {relWord(e.type)} {nm(e.target)}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Decisions on record" aside={<span className="mono text-[11px] text-faint">{decisions.length}</span>}>
        <ul className="space-y-2">
          {decisions.length === 0 && <li className="text-xs text-muted">None yet on this date.</li>}
          {decisions.map((d) => (
            <li key={d.id} className="grid grid-cols-[3.6rem_1fr] gap-2 text-xs leading-snug">
              <span className="mono text-faint">{d.key}</span>
              <span>
                <span className="text-ink">{d.name}</span>{" "}
                <span className={d.status === "accepted" ? "text-ok" : "text-warn"}>{d.status}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      {t && (
        <Section title="Everything that happened">
          <div className="space-y-5">
            {history.map(([year, rows]) => (
              <div key={year}>
                <p className="heading mb-2 text-[20px] leading-none text-muted">{year}</p>
                <ol className="relative ml-[3px] space-y-2 border-l border-rule pl-4">
                  {rows.map((e, i) => {
                    const past = e.at <= date;
                    return (
                      <li key={i} className="relative text-xs leading-snug">
                        <span
                          className={`absolute -left-[20.5px] top-[5px] size-[6px] ${e.kind === "decision" ? "rotate-45" : "rounded-full"}`}
                          style={{ background: past ? (e.kind === "decision" ? C.text : C.partial) : C.rule }}
                          aria-hidden
                        />
                        <span className={past ? "text-ink" : "text-faint"}>
                          <span className="mono mr-2 text-[11px] text-faint">{fmtDate(e.at).replace(/, \d{4}$/, "")}</span>
                          {e.kind === "decision" && <span className="mono mr-1.5 text-muted">{e.ref}</span>}
                          {e.text}
                          {e.kind === "event" && <span className="text-faint"> {e.ref}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        </Section>
      )}
    </aside>
  );

  return (
    <Split id="time" vertical={!wide}>
      <Pane id="canvas" minSize={wide ? 480 : 260}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1">{canvas}</div>
          {scrubber}
        </div>
      </Pane>
      <Handle label="Resize the side panel" />
      <Pane id="side" defaultSize={wide ? 340 : "35"} minSize={wide ? 260 : 140} maxSize={wide ? 560 : undefined}>
        {side}
      </Pane>
    </Split>
  );
}
