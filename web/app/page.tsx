"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/AppProvider";
import TurnView from "@/components/brain/TurnView";
import LazyGraphCanvas from "@/components/graph/GraphCanvasLazy";
import type { EdgeGraph, Trail } from "@/components/graph/GraphCanvas";
import { EASE, Rise, WordReveal } from "@/components/motion";
import { Handle, Pane, Split, useMedia } from "@/components/Split";
import { AgentsOff, ErrorNote, Kbd, NodeTypeLegend } from "@/components/ui";
import { useFetch } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import type { GEdge, GNode, GraphPayload } from "@/lib/types";

/** Three questions that show the three things Orion does, and what the asker will see happen. */
const STARTERS: [string, string][] = [
  ["If we switch off sso-legacy next quarter, what breaks, who needs to be involved, and have we tried this before?", "tests the change first"],
  ["Who actually knows the ledger?", "finds the experts"],
  ["What did Helio Robotics ask for, and was it resolved?", "customer history"],
];

export default function BrainPage() {
  const { turns, ask, asking, stop, clearChat, previous, resume, highlight, clearHighlight, openBlame, llm, restoring } = useApp();
  const off = llm === false;
  const graph = useFetch<GraphPayload>("/graph");
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const wide = useMedia("(min-width: 1024px)");
  // phones and small tablets: the conversation gets the screen; the graph is a sheet you open
  const sheetMode = !useMedia("(min-width: 768px)");
  const [sheet, setSheet] = useState(false);

  const submit = (text = draft) => {
    if (!text.trim() || asking || off) return;
    ask(text);
    setDraft("");
    stick.current = true;
  };

  // keep the newest step in view while the agent streams, unless the reader scrolled up
  const stepCount = turns.reduce((n, t) => n + t.steps.length + (t.answer ? 1 : 0), 0);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [stepCount, turns.length]);

  const onEdgeClick = useCallback(
    (e: GEdge, s?: GNode, t?: GNode, g?: EdgeGraph) =>
      openBlame({ fact: e.uid ?? null, edge: e, sourceName: s?.name, targetName: t?.name, source: s, target: t, graph: g }),
    [openBlame],
  );

  // only nodes that exist on the main canvas (evidence can also point at universes, sources or tickets)
  const onCanvas = useMemo(() => {
    if (!highlight || !graph.data) return null;
    const ids = new Set(graph.data.nodes.map((n) => n.id));
    return highlight.nodes.filter((id) => ids.has(id));
  }, [highlight, graph.data]);
  const hlNodes = onCanvas && onCanvas.length ? onCanvas : null;
  const inGraph = onCanvas?.length ?? 0;

  // today's company: people who left and retired services are on the graph (history) but not counted
  const census = useMemo(() => {
    const c: Record<string, number> = {};
    let former = 0,
      retired = 0;
    for (const n of graph.data?.nodes ?? []) {
      if (n.former) former++;
      else if (n.retired) retired++;
      else c[n.type] = (c[n.type] ?? 0) + 1;
    }
    const parts = ([
      [c.Person, "people"],
      [c.Team, "teams"],
      [c.Service, "systems"],
      [c.Decision, "decisions"],
      [c.Customer, "customers"],
    ].filter(([n]) => n) as [number, string][]).map(([n, l]) => `${n} ${l}`);
    const gone = [former && `${former} who left`, retired && `${retired} switched-off ${retired === 1 ? "system" : "systems"}`].filter(Boolean);
    // the map shows today's company; people who left and switched-off systems are history (see History)
    return parts.length
      ? `Orion knows ${parts.join(", ")} today${gone.length ? ` (plus ${gone.join(" and ")}, in History)` : ""}.`
      : null;
  }, [graph.data]);

  // the graph follows the agent: while it streams, what each finished tool call touched lights up, walking out
  // from the thing the call was about
  const live = turns[turns.length - 1]?.status === "streaming" ? turns[turns.length - 1] : null;
  const trail = useMemo<Trail | null>(() => {
    if (!live || !graph.data) return null;
    const done = live.steps.filter((s) => s.kind === "tool" && !s.pending && s.nodes?.length) as Extract<
      (typeof live.steps)[number],
      { kind: "tool" }
    >[];
    if (!done.length) return null;
    const ids = new Set(graph.data.nodes.map((n) => n.id));
    const nodes = [...new Set(done.flatMap((s) => s.nodes ?? []))].filter((id) => ids.has(id));
    if (!nodes.length) return null;
    const lastCall = done[done.length - 1];
    const names = Object.values(lastCall.args).filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase());
    const seed = graph.data.nodes.find((n) => names.includes((n.name ?? "").toLowerCase()) || names.includes(n.id))?.id ?? null;
    return { key: `${live.id}:${done.length}`, nodes, seed, recent: (lastCall.nodes ?? []).filter((id) => ids.has(id)) };
  }, [live, graph.data]);

  // the map becomes the answer: an answer that tested switching something off replays the breakage on the map,
  // hop by hop, from that system
  const story = useMemo(() => {
    const t = [...turns].reverse().find((x) => x.status === "done" && !x.restored);
    if (!t?.result || !graph.data) return null;
    for (const call of t.result.universes ?? []) {
      const ops = (call.args?.ops as { op?: string; service?: string }[] | undefined) ?? [];
      const off = ops.find((o) => o.op === "deprecate_service" && o.service);
      if (!off) continue;
      const want = String(off.service).toLowerCase();
      const n = graph.data.nodes.find((x) => x.id === off.service || (x.name ?? "").toLowerCase() === want);
      if (n) return { key: t.id, origin: n.id };
    }
    return null;
  }, [turns, graph.data]);

  // Esc closes the map sheet on phones
  useEffect(() => {
    if (!sheet) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setSheet(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [sheet]);

  const conversation = (
    <section aria-label="Conversation" className="flex h-full min-h-0 flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6 xl:px-8"
      >
        {turns.length === 0 && restoring ? (
          // the last conversation is on its way: its shape, not the welcome screen flashing first
          <div className="space-y-4 pt-2" aria-busy="true" aria-label="Loading your last conversation">
            <span className="skeleton block h-6 w-2/3" />
            <span className="skeleton block h-4 w-full" />
            <span className="skeleton block h-4 w-5/6" />
            <span className="skeleton mt-6 block h-24 w-full" />
          </div>
        ) : turns.length === 0 ? (
          <div className="flex min-h-full flex-col justify-between gap-8">
            <div className="pt-[4vh]">
              <h2 className="heading text-[clamp(2rem,3.5vw,3rem)] leading-[0.98] tracking-[-0.025em]">
                <WordReveal text="Ask anything about your company." id="ask-hero" />
              </h2>
              <Rise delay={0.2}>
                <p className="mt-5 max-w-[48ch] text-[15px] leading-[1.6] text-muted">
                  Orion keeps track of Corvane: who works on what, which systems rely on each other, what was
                  decided and why, and what customers asked for. Every point in an answer is checked against the records,
                  and it tells you when one stops being true.
                </p>
              </Rise>
              <Rise delay={0.25}>
                <button
                  type="button"
                  className="btn mt-6 h-9 gap-2 rounded-full pl-2 pr-3.5"
                  onClick={() => {
                    // on phones the map is a sheet: open it first, then start once the map is there
                    if (sheetMode) {
                      setSheet(true);
                      setTimeout(() => window.dispatchEvent(new Event("orion:tour")), 1200);
                    } else window.dispatchEvent(new Event("orion:tour"));
                  }}
                >
                  <span className="grid size-6 place-items-center rounded-full bg-ember/15 text-ember" aria-hidden>
                    <svg width="11" height="11" viewBox="0 0 12 12"><path d="M3.5 2.2v7.6L10 6 3.5 2.2Z" fill="currentColor" /></svg>
                  </span>
                  Take a one-minute tour of the company
                </button>
              </Rise>
              {previous && previous.turns.length > 0 && (
                <Rise delay={0.1}>
                  <div className="mt-6 max-w-[52ch] rounded-xl border border-rule bg-panel px-4 py-3">
                    <p className="text-[12px] text-muted">Last time you asked, on {fmtDate(previous.turns[previous.turns.length - 1].at)}</p>
                    <p className="mt-1 text-[14px] leading-snug text-ink">{previous.turns[previous.turns.length - 1].question}</p>
                    <div className="mt-2.5 flex items-center gap-3">
                      <button type="button" className="btn h-7 px-2.5 text-[12px]" onClick={resume}>
                        Pick up where you left off
                      </button>
                      {previous.turns.some((t) => t.status !== "fresh") && (
                        <Link href="/inbox" className="text-[12px] text-warn underline-offset-2 hover:underline">
                          Something it relied on has changed since
                        </Link>
                      )}
                    </div>
                  </div>
                </Rise>
              )}
            </div>

            <div>
              <p className="mb-1 text-[12px] text-muted">Questions to start with</p>
              <ul aria-label="Questions to start with">
                {STARTERS.map(([q, uses], i) => (
                  <motion.li
                    key={q}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, ease: EASE, delay: 0.15 + i * 0.04 }}
                    className="border-t border-rule"
                  >
                    <button
                      type="button"
                      disabled={off}
                      onClick={() => submit(q)}
                      className="group relative flex w-full items-start gap-4 py-3.5 pr-2 text-left disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <span className="absolute inset-y-0 -left-6 w-[2px] origin-top scale-y-0 bg-ember transition-transform duration-300 ease-[var(--ease-out-quint)] group-hover:scale-y-100 group-disabled:hidden xl:-left-8" aria-hidden />
                      <span className="flex-1 text-[14px] leading-snug text-muted transition-colors duration-200 group-hover:text-ink">{q}</span>
                      <span className="mt-[2px] hidden shrink-0 text-[12px] text-muted transition-colors group-hover:text-ink sm:inline">{uses}</span>
                    </button>
                  </motion.li>
                ))}
              </ul>
              <p className="border-t border-rule pt-3.5 text-[13px] leading-relaxed text-ink">
                <span className="font-medium">Try this:</span>{" "}
                <span className="text-muted">
                  ask the first question. Then open{" "}
                  <Link href="/inbox" className="text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink">
                    Inbox
                  </Link>
                  , post the ready-made #billing message, and watch Orion flag the answer as out of date.
                </span>
              </p>
              {census && <p className="mt-2 text-[12px] leading-relaxed text-muted">{census}</p>}
            </div>
          </div>
        ) : (
          <div className="space-y-12 pb-4">
            {turns.map((t, i) => (
              <TurnView key={t.id} turn={t} latest={i === turns.length - 1} />
            ))}
          </div>
        )}
      </div>

      <form
        className="shrink-0 px-4 pb-4 pt-2 xl:px-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {off && <AgentsOff className="mb-2.5 px-1" />}
        {sheetMode && (
          <button type="button" className="btn mb-2 w-full justify-center" onClick={() => setSheet(true)}>
            See it on the map
            {highlight && <span className="size-1.5 rounded-full" style={{ background: highlight.color }} aria-hidden />}
          </button>
        )}
        <div className="rounded-xl border border-rule bg-panel shadow-float transition-[border-color] duration-150 focus-within:border-faint">
          <label htmlFor="ask" className="sr-only">
            Ask a question about the company
          </label>
          <textarea
            id="ask"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={off}
            placeholder={off ? "Asking needs the AI service, which isn't set up yet" : "Ask about people, systems, decisions, customers, or what would happen if…"}
            className="block w-full resize-none bg-transparent px-4 pt-3.5 text-[14px] leading-snug text-ink outline-none placeholder:text-faint focus-visible:outline-none disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-2 px-3 pb-3 pt-1">
            {turns.length > 0 && (
              <button type="button" className="btn btn-ghost h-7 px-2 text-xs" onClick={clearChat} disabled={asking}>
                New conversation
              </button>
            )}
            <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-faint sm:flex">
              <Kbd>↵</Kbd> to ask
            </span>
            {asking ? (
              <button type="button" className="btn h-8" onClick={stop}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-primary h-8 rounded-lg" disabled={!draft.trim() || off}>
                Ask
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  );

  const canvas = (
    <section aria-label="Company map" className="relative h-full min-h-0">
      <LazyGraphCanvas
        data={graph.data}
        highlight={hlNodes}
        highlightColor={highlight?.color}
        trail={hlNodes ? null : trail}
        story={trail ? null : story}
        fitToHighlight
        onEdgeClick={onEdgeClick}
        ariaLabel="Company map: people, teams, systems, customers, projects and decisions"
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-3 p-3.5">
        <div className="hud pointer-events-auto px-3 py-2">
          <NodeTypeLegend />
        </div>
        {highlight && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="hud pointer-events-auto ml-auto flex items-center gap-2 px-3 py-2 text-xs"
          >
            <span className="size-2 rounded-full" style={{ background: highlight.color }} aria-hidden />
            <span className="text-muted">
              {inGraph
                ? `Showing what ${highlight.key.endsWith(":all") ? "the answer" : "this point"} is based on (${inGraph} ${inGraph === 1 ? "thing" : "things"})`
                : "This point is based on a what-if or a document, not something on the map"}
              {highlight.pinned ? ", pinned" : ""}
            </span>
            {highlight.pinned && (
              <button type="button" className="text-ink underline-offset-2 hover:underline" onClick={clearHighlight}>
                Clear
              </button>
            )}
          </motion.div>
        )}
      </div>
      {trail && !hlNodes && (
        <p className="hud pointer-events-none absolute bottom-4 left-4 hidden px-3 py-1.5 text-[12px] text-muted sm:block" role="status">
          Lit up: what the assistant has looked at so far
        </p>
      )}
      {!trail && (
        <p className="pointer-events-none absolute bottom-4 left-4 hidden max-w-[calc(100%-80px)] text-[12px] text-muted sm:block">
          Click anything on the map to explore it, or a line to see what the connection means
        </p>
      )}
      {graph.error && (
        <div className="absolute inset-x-6 top-20">
          <ErrorNote error={graph.error} onRetry={graph.reload} />
        </div>
      )}
    </section>
  );

  if (sheetMode)
    return (
      <>
        {conversation}
        <AnimatePresence>
          {sheet && (
            <motion.div
              className="fixed inset-0 z-[96] flex flex-col bg-night"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              transition={{ duration: 0.2, ease: EASE }}
              role="dialog"
              aria-modal="true"
              aria-label="The company map"
            >
              <div className="flex h-12 shrink-0 items-center gap-3 border-b border-rule px-4">
                <p className="flex-1 text-[14px] font-semibold">The company map</p>
                <button type="button" className="btn btn-ghost h-8 px-2.5" onClick={() => setSheet(false)}>
                  Done
                </button>
              </div>
              <div className="min-h-0 flex-1">{canvas}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );

  return (
    <Split id="brain" vertical={!wide}>
      <Pane id="conversation" defaultSize={wide ? "38" : "64"} minSize={wide ? 340 : 260}>
        {conversation}
      </Pane>
      <Handle label="Resize the conversation and the map" />
      <Pane id="graph" minSize={wide ? 320 : 180}>
        {canvas}
      </Pane>
    </Split>
  );
}
