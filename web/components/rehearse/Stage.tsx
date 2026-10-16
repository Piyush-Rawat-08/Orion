"use client";

// The guided rehearsal: one consequential decision, played out on the real API in the visitor's own copy of
// Corvane. Four scenes on one stage, with the decision and the map in view throughout:
//
//   The change       retire sso-legacy, on a readable map of everything that relies on it
//   The consequences a full copy of the company is made and the failure walks out, column by column
//   Other futures    the safe-path search's explored copies, as cards on its tree; the chosen line stays lit
//   New evidence     a message lands in #billing, a dependency closes, the earlier answer goes out of date,
//                    and the decision is rehearsed again on the changed company
//
// Every number on screen comes from the run. When the API is asleep or a step fails, a recorded run can be
// played instead; it says Replay at the top for as long as it plays.

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../AppProvider";
import { Mark } from "../Shell";
import { EASE } from "../motion";
import { Spinner } from "../ui";
import type { PlanResult } from "../multiverse/SafePath";
import { currentTenant, get, post } from "@/lib/api";
import { fmtDate, fmtMs } from "@/lib/format";
import { checkReason } from "@/lib/words";
import { postStream } from "@/lib/sse";
import type { AnswerDetail, AnswerRow, Diff, GraphPayload } from "@/lib/types";
import {
  type AnswerLite,
  type CompanyMap,
  type MapState,
  type Recording,
  buildMap,
  CALM,
  DECISION,
  GOAL,
  hitLine,
  human,
  humanLabel,
  NEWS,
  plural,
  SEEN_KEY,
  stateOfDiff,
  stateOfFuture,
  tally,
} from "@/lib/rehearsal";
import Futures, { type Future } from "./Futures";
import StageMap from "./StageMap";

type Scene = "intro" | "change" | "cascade" | "futures" | "evidence" | "finale";
const STEPS: { scene: Scene; label: string }[] = [
  { scene: "change", label: "The change" },
  { scene: "cascade", label: "The consequences" },
  { scene: "futures", label: "Other futures" },
  { scene: "evidence", label: "New evidence" },
];
const ORDER: Scene[] = ["intro", "change", "cascade", "futures", "evidence", "finale"];

type Ev = { event: string; data: Record<string, unknown>; t?: number };
type Forked = { uid: string; copy_ms: number; apply_ms: number; ms: number; diff: Diff };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The search's status lines in words: "depth 1: forking 2 parallel companies" -> "Step 1: copying the company 2 times". */
const planWords = (t: string) =>
  t
    .replace(/^depth (\d+): forking (\d+) parallel compan(y|ies)$/, (_, d, n) => `Step ${d}: copying the company ${n === "1" ? "once" : `${n} times`}`)
    .replace(/^exploring ways to (.*) safely$/, (_, x) => `Looking for a safe way to ${x}`);

function toLite(a: AnswerDetail): AnswerLite {
  return {
    uid: a.uid,
    question: a.question,
    at: a.at,
    summary: a.summary,
    claims: a.claims.map((c) => ({ text: c.text, verdict: c.verdict, stale: c.stale ?? null, stale_reason: c.stale_reason ?? null })),
  };
}

/** The live API, recording what it returns; or a recording, played back at a readable pace. */
function useRunner(replay: Recording | null) {
  const rec = useRef<Partial<Recording>>({ plan: { events: [], ms: 0 }, news: { events: [], ms: 0 }, answer: { before: null, after: null } });
  const expose = () => {
    (window as unknown as { __orionRecording?: unknown }).__orionRecording = rec.current;
  };
  return useMemo(
    () => ({
      replay: !!replay,
      async graph(): Promise<GraphPayload> {
        if (replay) return replay.graph;
        const g = await get<GraphPayload>("/graph");
        rec.current.graph = g;
        return g;
      },
      async answer(phase: "before" | "after"): Promise<AnswerLite | null> {
        if (replay) return replay.answer[phase];
        const rows = await get<AnswerRow[]>(`/answers?user=${encodeURIComponent("person:priya-raman")}`).catch(() => []);
        const row = rows.find((r) => /sso-legacy/.test(r.question) && /switch off|retire|breaks/i.test(r.question));
        if (!row) return null;
        const a = toLite(await get<AnswerDetail>(`/answers/${encodeURIComponent(row.uid)}`));
        rec.current.answer = { ...(rec.current.answer ?? { before: null, after: null }), [phase]: a };
        expose();
        return a;
      },
      async fork(phase: "before" | "after"): Promise<Forked> {
        if (replay) {
          await wait(700);
          const r = phase === "before" ? { ...replay.fork, diff: replay.diff } : { ...replay.after!.fork, diff: replay.after!.diff };
          return r;
        }
        const t0 = performance.now();
        const r = await post<{ uid: string; copy_ms: number; apply_ms: number; diff: Diff }>("/fork", {
          ops: [GOAL],
          kind: "whatif",
          title: phase === "before" ? "Rehearsal: retire sso-legacy" : "Rehearsal again, after the #billing message",
        });
        const out = { uid: r.uid, copy_ms: r.copy_ms, apply_ms: r.apply_ms, ms: Math.round(performance.now() - t0), diff: r.diff };
        if (phase === "before") {
          rec.current.fork = { uid: out.uid, copy_ms: out.copy_ms, apply_ms: out.apply_ms, ms: out.ms };
          rec.current.diff = r.diff;
          rec.current.tenant = currentTenant();
          rec.current.at = new Date().toISOString();
        } else rec.current.after = { fork: { uid: out.uid, copy_ms: out.copy_ms, apply_ms: out.apply_ms, ms: out.ms }, diff: r.diff };
        expose();
        return out;
      },
      async source(fact: string): Promise<Record<string, unknown> | null> {
        if (replay) return replay.source;
        const r = await get<{ result: { sources: Record<string, unknown>[] } }>(`/blame?fact=${encodeURIComponent(fact)}`);
        rec.current.source = r.result.sources[0] ?? null;
        expose();
        return rec.current.source;
      },
      async stream(kind: "plan" | "news", on: (e: Ev) => void, signal?: AbortSignal) {
        if (replay) {
          // the run's own rhythm, sped up where it waited long (a replay should not sit still for half a minute)
          let last = 0;
          for (const e of replay[kind].events) {
            if (signal?.aborted) return;
            const gap = e.t !== undefined ? e.t - last : 700;
            last = e.t ?? last;
            await wait(Math.min(2400, Math.max(250, gap * 0.6)));
            on(e);
          }
          return;
        }
        const t0 = performance.now();
        const log: Ev[] = [];
        const cb = (e: { event: string; data: Record<string, unknown> }) => {
          log.push({ event: e.event, data: e.data, t: Math.round(performance.now() - t0) });
          on(e);
        };
        if (kind === "plan") await postStream("/plan", { ops: [GOAL] }, cb, signal);
        else await postStream("/messages", { channel: NEWS.channel, text: NEWS.text }, cb, signal, NEWS.author);
        rec.current[kind] = { events: log, ms: Math.round(performance.now() - t0) };
        expose();
      },
    }),
    [replay],
  );
}

export default function Stage() {
  const { awake, llm, openBlame, startOver, tenant } = useApp();
  const reduce = useReducedMotion();
  const [replay, setReplay] = useState<Recording | null>(null);
  const run = useRunner(replay);
  const [scene, setScene] = useState<Scene>("intro");
  const [reached, setReached] = useState(0);
  const [map, setMap] = useState<CompanyMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // scene 2
  const [before, setBefore] = useState<Forked | null>(null);
  const [reveal, setReveal] = useState(-1);
  const [source, setSource] = useState<Record<string, unknown> | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  // scene 3
  const [futures, setFutures] = useState<Future[]>([]);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [rejected, setRejected] = useState<{ label: string; why: string }[]>([]);
  const [planT0, setPlanT0] = useState(0);
  const [planStatus, setPlanStatus] = useState("Checking out today's company");
  const [now, setNow] = useState(0);
  // scene 4
  const [news, setNews] = useState<{ started: boolean; received: boolean; reader?: string; closed: { subject: string; object: string }[]; opened: { subject: string; object: string }[]; expired: { broken: number; total: number } | null; done: boolean }>({
    started: false,
    received: false,
    closed: [],
    opened: [],
    expired: null,
    done: false,
  });
  const [after, setAfter] = useState<Forked | null>(null);
  const [answer, setAnswer] = useState<{ before: AnswerLite | null; after: AnswerLite | null }>({ before: null, after: null });

  const scroller = useRef<HTMLDivElement>(null);
  const go = useCallback((s: Scene) => {
    setScene(s);
    setReached((r) => Math.max(r, ORDER.indexOf(s)));
    scroller.current?.scrollTo({ top: 0 });
  }, []);

  // seen once: the workspace's front door stops sending this browser here
  useEffect(() => {
    try {
      localStorage.setItem(SEEN_KEY, "seen");
    } catch {
      /* not remembered */
    }
  }, []);

  // the map, laid out once from the company as it is
  const load = useCallback(async () => {
    setError(null);
    try {
      const g = await run.graph();
      setMap(buildMap(g));
      setAnswer({ before: await run.answer("before"), after: null });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [run]);
  useEffect(() => {
    if (awake || replay) void load();
  }, [awake, replay, load]);

  // the introduction's background map, from the recorded run until this copy's own map arrives (same layout)
  const [backdrop, setBackdrop] = useState<CompanyMap | null>(null);
  useEffect(() => {
    fetch("/rehearsal-replay.json", { cache: "force-cache" })
      .then((r) => r.json())
      .then((rec: Recording) => setBackdrop(buildMap(rec.graph)))
      .catch(() => {});
  }, []);

  const ghost = map?.edges.find((e) => !e.declared && e.dependency === GOAL.service) ?? null;
  // this copy already took Tomasz's message (the Inbox demo was played here): the story has already happened
  const spent = !!map && !replay && !map.edges.some((e) => e.dependent === "invoice-render" && e.dependency === GOAL.service);

  // scene 1 -> 2: the copy
  const rehearse = async () => {
    setBusy(true);
    setError(null);
    try {
      const f = await run.fork("before");
      setBefore(f);
      setReveal(-1);
      go("cascade");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // scene 2: the failure walks out, a column at a time, then reaches the customers
  const lastCol = map ? Math.max(...map.nodes.filter((n) => n.role !== "successor").map((n) => n.col)) : 0;
  useEffect(() => {
    if (scene !== "cascade" || !before) return;
    if (reduce) {
      setReveal(Infinity);
      return;
    }
    const ts = Array.from({ length: lastCol + 2 }, (_, c) => setTimeout(() => setReveal(c), 900 + c * 900));
    const end = setTimeout(() => setReveal(Infinity), 900 + (lastCol + 2) * 900);
    return () => {
      ts.forEach(clearTimeout);
      clearTimeout(end);
    };
  }, [scene, before, lastCol, reduce]);
  const cascadeDone = reveal === Infinity;

  const openSource = async () => {
    setSourceOpen(true);
    if (!source && ghost?.fact) setSource(await run.source(ghost.fact).catch(() => null));
  };

  // scene 3: the search
  const abort = useRef<AbortController | null>(null);
  const explore = async () => {
    go("futures");
    if (futures.length) return;
    setPlanT0(performance.now());
    setError(null);
    const ac = new AbortController();
    abort.current = ac;
    try {
      await run.stream(
        "plan",
        (e) => {
          const d = e.data;
          if (e.event === "status") setPlanStatus(planWords(String(d.text ?? "")));
          else if (e.event === "universe") setFutures((xs) => (xs.some((x) => x.id === d.id) ? xs : [...xs, d as unknown as Future]));
          else if (e.event === "rejected") setRejected((xs) => [...xs, { label: String(d.label), why: String(d.why) }]);
          else if (e.event === "done" && d.result) setPlan(d.result as PlanResult);
          else if (e.event === "error") setError(String(d.text ?? "The search failed"));
        },
        ac.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    }
  };
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (scene !== "futures" || plan) return;
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [scene, plan]);

  // scene 4: the message, then the decision rehearsed again
  const deliver = async () => {
    setNews((n) => ({ ...n, started: true }));
    setError(null);
    try {
      await run.stream("news", (e) => {
        const d = e.data;
        if (e.event === "extracted") setNews((n) => ({ ...n, received: true, reader: d.reader ? String(d.reader) : undefined }));
        else if (e.event === "status") setNews((n) => ({ ...n, received: true }));
        else if (e.event === "fact_closed")
          setNews((n) => ({ ...n, received: true, closed: [...n.closed, { subject: String(d.subject), object: String(d.object) }] }));
        else if (e.event === "fact_opened")
          setNews((n) => ({ ...n, opened: [...n.opened, { subject: String(d.subject), object: String(d.object) }] }));
        else if (e.event === "answer_expired")
          setNews((n) => ({ ...n, expired: { broken: (d.broken_claims as string[])?.length ?? 0, total: Number(d.total_claims ?? 0) } }));
        else if (e.event === "error") setError(String(d.text));
      });
      const [f, a] = await Promise.all([run.fork("after"), run.answer("after")]);
      setAfter(f);
      setAnswer((x) => ({ ...x, after: a }));
      setNews((n) => ({ ...n, done: true }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // ------------------------------------------------------------------ derived

  const customersOf = useCallback(
    (names: string[]) => (map ? map.customers.filter((c) => c.uses.some((u) => names.includes(u))).map((c) => c.uid) : []),
    [map],
  );
  const beforeState = useMemo(() => (before ? stateOfDiff(before.diff) : CALM), [before]);
  const t = before ? tally(beforeState.effects) : { stop: 0, slow: 0 };
  const nCust = before?.diff.customers?.length ?? 0;
  const afterState = useMemo<MapState>(() => {
    const base = after ? stateOfDiff(after.diff) : { ...beforeState };
    const closed = news.closed.map((c) => `${c.subject}>${c.object}`);
    const opened = news.opened.filter((o) => map?.nodes.some((n) => n.id === o.subject) && map?.nodes.some((n) => n.id === o.object));
    return { ...base, removed: closed, added: opened.map((o) => ({ dependent: o.subject, dependency: o.object })) };
  }, [after, beforeState, news.closed, news.opened, map]);
  const ta = after ? tally(afterState.effects) : null;
  const nCustAfter = after?.diff.customers?.length ?? 0;

  // the plan's steps that still matter on the changed company (their system is still hit)
  const leftToDo = useMemo(() => {
    if (!plan || !after) return [];
    const hit = new Set(after.diff.broken.map((b) => b.service));
    return plan.steps.slice(0, -1).filter((s) => [...hit].some((h) => s.label.includes(` ${h} `)));
  }, [plan, after]);

  // the primary action of each scene, for the arrow key while presenting
  const primary = useRef<(() => void) | null>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      primary.current?.();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  useEffect(() => {
    if (scene !== "intro" || (!map && !replay)) return;
    primary.current = () => go("change");
    return () => {
      primary.current = null;
    };
  }, [scene, map, replay, go]);

  const seen = () => {
    try {
      localStorage.setItem(SEEN_KEY, "seen");
    } catch {
      /* not remembered */
    }
  };

  // ?replay opens on the recorded run (for a presentation over a bad connection); it still says Replay throughout
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("replay")) void playRecording(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const playRecording = async (start = true) => {
    setError(null);
    try {
      const r = await fetch("/rehearsal-replay.json", { cache: "force-cache" });
      const rec = (await r.json()) as Recording;
      abort.current?.abort();
      setBefore(null);
      setFutures([]);
      setPlan(null);
      setRejected([]);
      setAfter(null);
      setNews({ started: false, received: false, closed: [], opened: [], expired: null, done: false });
      setSource(null);
      setSourceOpen(false);
      setReplay(rec);
      if (start) go("change");
    } catch {
      setError("The recorded run couldn't be loaded.");
    }
  };

  // ------------------------------------------------------------------ render

  const [since] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (awake) return;
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [awake]);
  const waited = Math.round((Date.now() - since) / 1000);

  return (
    <div ref={scroller} className="relative flex h-dvh flex-col overflow-y-auto bg-night">
      {/* top bar */}
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-4 border-b border-rule bg-night/95 px-4 backdrop-blur-sm md:px-6">
        <Link href="/" onClick={seen} className="flex items-center gap-2" aria-label="Orion workspace">
          <Mark size={20} />
          <span className="hidden text-[14px] font-semibold tracking-[-0.01em] sm:inline">Orion</span>
        </Link>
        {scene !== "intro" && (
          <ol className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:justify-center md:gap-2" aria-label="Rehearsal">
            {STEPS.map((s, i) => {
              const done = ORDER.indexOf(s.scene) < ORDER.indexOf(scene) || scene === "finale";
              const here = s.scene === scene;
              const can = ORDER.indexOf(s.scene) <= reached && s.scene !== "change";
              return (
                <li key={s.scene} className="flex shrink-0 items-center gap-1 md:gap-2">
                  {i > 0 && <span className={`h-px w-4 md:w-8 ${done || here ? "bg-ember/70" : "bg-rule"}`} aria-hidden />}
                  <button
                    type="button"
                    disabled={!can || here}
                    onClick={() => go(s.scene)}
                    aria-current={here ? "step" : undefined}
                    className={`flex items-center gap-2 rounded-full px-2 py-1 text-[13px] transition-colors ${here ? "text-ink" : done ? "text-muted hover:text-ink" : "text-faint"} disabled:cursor-default`}
                  >
                    <span
                      className={`mono grid size-[22px] place-items-center rounded-full text-[11px] font-semibold ${
                        done ? "bg-ember text-night" : here ? "bg-ember/15 text-ember ring-1 ring-ember/60" : "ring-1 ring-rule"
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span className={here ? "" : "hidden lg:inline"}>{s.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        <div className={`flex items-center gap-3 ${scene === "intro" ? "ml-auto" : ""}`}>
          {replay ? (
            <span className="flex items-center gap-2 rounded-full border border-warn/60 bg-warn/10 px-3 py-1 text-[12px] text-warn" role="status">
              <span className="size-1.5 rounded-full bg-warn" aria-hidden />
              Replay of a recorded run{replay.at ? `, ${fmtDate(replay.at)}` : ""}
            </span>
          ) : (
            <span className="hidden text-[12px] text-faint md:inline" title="Corvane is a made-up company: every person, system and customer is synthetic">
              Corvane · synthetic demo company
            </span>
          )}
          <Link href="/" onClick={seen} className="btn btn-ghost h-8 px-2.5 text-[13px]">
            Explore the workspace
          </Link>
        </div>
      </header>

      {/* the decision, in view through every scene */}
      {scene !== "intro" && scene !== "finale" && (
        <section className="mx-auto w-full max-w-[1480px] px-4 pb-2 pt-6 md:px-8 md:pt-8">
          <p className="text-[14px] text-muted">The decision</p>
          <h1 className="heading mt-1 text-[clamp(2rem,4.2vw,3.5rem)] leading-[1.02] tracking-[-0.03em]">{DECISION}</h1>
          <p className="mono mt-2 text-[13px] text-faint">
            {GOAL.service} · {GOAL.op} · in {tenant?.personal ? "your own copy of Corvane" : "Corvane"}
          </p>
        </section>
      )}

      <AnimatePresence mode="wait">
        {scene === "intro" ? (
          <motion.section
            key="intro"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="relative flex flex-1 items-center overflow-hidden"
            aria-label="Orion"
          >
            {/* the working map, faint, behind the introduction: the first click goes straight into it */}
            <div className="pointer-events-none absolute inset-y-0 right-[-8%] hidden w-[72%] items-center opacity-30 md:flex" aria-hidden>
              {(map ?? backdrop) && <StageMap map={(map ?? backdrop)!} state={CALM} label="Corvane's map" />}
            </div>
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,var(--color-night)_32%,transparent_80%)]" aria-hidden />
            <div className="relative mx-auto w-full max-w-[1480px] px-5 py-16 md:px-10">
              <motion.h1
                initial={reduce ? false : { opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, ease: EASE }}
                className="heading text-[clamp(2.9rem,6.6vw,6.25rem)] leading-[0.96] tracking-[-0.045em]"
              >
                <span className="block">Break your company.</span>
                <span className="block text-muted">In a parallel universe.</span>
              </motion.h1>
              <motion.p
                initial={reduce ? false : { opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, ease: EASE, delay: 0.15 }}
                className="mt-7 max-w-[46ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.5] text-muted"
              >
                Rehearse a system change, see what breaks, and find a better sequence, before anything changes in production.
              </motion.p>
              <motion.div
                initial={reduce ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: EASE, delay: 0.28 }}
                className="mt-9 flex flex-wrap items-center gap-3"
              >
                <button
                  type="button"
                  onClick={() => go("change")}
                  disabled={!map && !replay}
                  className="btn btn-primary h-12 gap-2.5 rounded-full pl-2.5 pr-5 text-[16px]"
                >
                  <span className="grid size-8 place-items-center rounded-full bg-night/15" aria-hidden>
                    {map || replay ? (
                      <svg width="12" height="12" viewBox="0 0 12 12">
                        <path d="M3.5 2.2v7.6L10 6 3.5 2.2Z" fill="currentColor" />
                      </svg>
                    ) : (
                      <Spinner size={12} />
                    )}
                  </span>
                  Rehearse a shutdown
                </button>
                <Link href="/" onClick={seen} className="btn h-12 rounded-full px-5 text-[16px]">
                  Explore the workspace
                </Link>
              </motion.div>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="mt-8 space-y-1.5 text-[14px] text-muted">
                <p>
                  <span className="text-ink">Corvane is made up.</span> Its people, systems and customers are synthetic, so you can break it freely.
                  You get a copy of your own.
                </p>
                {!awake && !replay ? (
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="flex items-center gap-2">
                      <span className="relative flex size-[7px]" aria-hidden>
                        <span className="absolute inset-0 animate-ping rounded-full bg-warn opacity-70" />
                        <span className="absolute inset-0 rounded-full bg-warn" />
                      </span>
                      Waking the free API server, about a minute <span className="tnum text-faint">{waited}s</span>
                    </span>
                    {waited > 6 && (
                      <button type="button" onClick={() => void playRecording()} className="text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
                        Watch a recorded run meanwhile
                      </button>
                    )}
                  </p>
                ) : (
                  <p>About two minutes. Each step runs live on FalkorDB, on a real copy of the company graph.</p>
                )}
              </motion.div>
            </div>
          </motion.section>
        ) : scene === "finale" ? (
          <Finale
            key="finale"
            map={map}
            before={before}
            after={after}
            today={afterState}
            plan={plan}
            leftToDo={leftToDo}
            news={news}
            replay={!!replay}
            onAgain={() => (replay ? window.location.reload() : startOver("/rehearse"))}
            seen={seen}
          />
        ) : (
          <motion.div
            key="stage"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mx-auto grid w-full max-w-[1480px] flex-1 gap-6 px-4 pb-10 pt-4 md:px-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-10"
          >
            {/* the stage */}
            <section className="min-w-0" aria-label="Stage">
              {scene === "futures" ? (
                map && futures.length ? (
                  <Futures nodes={futures} result={plan} rejected={rejected} map={map} customersOf={customersOf} />
                ) : (
                  <div className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-rule-strong">
                    <p className="flex items-center gap-2.5 text-[15px] text-muted">
                      <Spinner size={13} /> {planStatus}
                    </p>
                  </div>
                )
              ) : (
                <div className="relative">
                  <motion.div
                    layout
                    className={`relative rounded-2xl border bg-panel p-3 md:p-5 ${scene === "change" ? "border-rule" : "border-ember/40 shadow-[0_40px_120px_-60px_rgb(255_107_53/0.45)]"}`}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                      {scene === "change" ? (
                        <span className="text-muted">Corvane today: everything that relies on {GOAL.service}, and who uses it</span>
                      ) : (
                        <>
                          <span className="flex items-center gap-1.5 text-ember">
                            <span className="size-1.5 rounded-full bg-ember" aria-hidden />
                            Rehearsal copy
                          </span>
                          {(scene === "evidence" && after ? after : before) && (
                            <span className="mono text-faint">
                              universe {(scene === "evidence" && after ? after : before)!.uid} · copied in{" "}
                              {fmtMs((scene === "evidence" && after ? after : before)!.copy_ms)}
                            </span>
                          )}
                          <span className="ml-auto rounded border border-rule px-1.5 py-px text-[11.5px] text-muted" title="Computed by walking the copied graph; not a measured outage">
                            modelled impact
                          </span>
                        </>
                      )}
                    </div>
                    {map && scene !== "change" && (
                      // the company as it is, shrunk into the corner: a faint reference while the copy takes the stage
                      <motion.div
                        layoutId="today"
                        transition={{ duration: 0.9, ease: EASE }}
                        className="absolute left-4 top-11 z-[1] hidden w-[19%] rounded-lg border border-rule bg-night/90 p-1.5 opacity-80 md:block"
                      >
                        <p className="px-1 text-[11.5px] text-muted">Corvane today · untouched</p>
                        <StageMap map={map} state={CALM} mini label="Corvane today, untouched" />
                      </motion.div>
                    )}
                    {map ? (
                      <motion.div
                        key={scene === "change" ? "today" : "copy"}
                        layoutId={scene === "change" ? "today" : undefined}
                        initial={scene === "change" ? false : { opacity: 0, scale: 0.985 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.7, ease: EASE, delay: scene === "change" ? 0 : 0.25 }}
                      >
                      <StageMap
                        map={map}
                        state={scene === "change" ? CALM : scene === "evidence" ? (news.closed.length || after ? afterState : beforeState) : beforeState}
                        reveal={scene === "cascade" ? reveal : Infinity}
                        focus={scene === "cascade" && cascadeDone ? ghost?.id : null}
                        onEdge={scene === "cascade" && cascadeDone ? () => void openSource() : undefined}
                      />
                      </motion.div>
                    ) : (
                      <div className="grid aspect-[1000/540] place-items-center text-[14px] text-muted">
                        {error ? null : <Spinner />}
                      </div>
                    )}
                    <Legend />
                  </motion.div>
                </div>
              )}
            </section>

            {/* the narration */}
            <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start" aria-live="polite">
              {error && (
                <div className="mb-4 rounded-xl border border-bad/50 bg-bad/5 px-4 py-3 text-[14px]" role="alert">
                  <p className="text-ink">That step didn&apos;t finish.</p>
                  <p className="mt-1 text-[13px] text-muted">{error}</p>
                  {!replay && (
                    <button type="button" onClick={() => void playRecording()} className="mt-2 text-[13px] text-ink underline underline-offset-4">
                      Watch the recorded run instead (labelled Replay)
                    </button>
                  )}
                </div>
              )}

              {scene === "change" && (
                <Narration title="The proposal">
                  <P>
                    Platform wants to switch off <b>{GOAL.service}</b>, the original SAML sign-on. ADR-005 named identity its successor in
                    January 2025.
                  </P>
                  <P>Before anyone touches production, Orion makes a full copy of the company graph and switches it off there.</P>
                  {spent && (
                    <div className="rounded-xl border border-warn/50 px-4 py-3 text-[14px]">
                      <p className="text-ink">Your copy has already changed: Tomasz&apos;s #billing message was posted in it.</p>
                      <button type="button" onClick={() => startOver("/rehearse")} className="mt-1.5 text-[13px] text-warn underline underline-offset-4">
                        Start over on a fresh copy
                      </button>
                    </div>
                  )}
                  <Primary onClick={rehearse} busy={busy} disabled={!map} bind={primary} label="Rehearse it on a copy" busyLabel="Copying the company" />
                </Narration>
              )}

              {scene === "cascade" && before && (
                <Narration title={cascadeDone ? "What breaks" : "Following the failure"}>
                  <AnimatePresence mode="wait">
                    {!cascadeDone ? (
                      <motion.div key="walk" exit={{ opacity: 0 }} className="space-y-3">
                        <P>
                          Copied in <b className="tnum">{fmtMs(before.copy_ms)}</b> and switched off in {fmtMs(before.apply_ms)}. Now Orion walks every
                          dependency in the copy, out from {GOAL.service}.
                        </P>
                        <Causal diff={before.diff} upto={reveal} />
                      </motion.div>
                    ) : (
                      <motion.div key="result" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }} className="space-y-5">
                        <Strip stop={t.stop} slow={t.slow} customers={nCust} />
                        <Causal diff={before.diff} upto={Infinity} />
                        {ghost && (
                          <div className="rounded-xl border border-warn/50 bg-panel px-4 py-3.5">
                            <p className="text-[15px] leading-snug text-ink">
                              The link that starts most of this was never written down.
                            </p>
                            <p className="mt-1 text-[14px] leading-snug text-muted">
                              {human(ghost.dependent)} relying on {human(ghost.dependency)} came from a #billing message, not the service catalog.
                            </p>
                            {!sourceOpen ? (
                              <button type="button" onClick={openSource} className="mt-2 text-[14px] text-warn underline decoration-warn/40 underline-offset-4 hover:decoration-warn">
                                Show where it came from
                              </button>
                            ) : (
                              <SourceCard s={source} onMore={() => ghost.fact && openBlame({ fact: ghost.fact })} />
                            )}
                          </div>
                        )}
                        {!!before.diff.required_approvers?.length && (
                          <P>
                            {before.diff.required_approvers.length} teams would have to sign off:{" "}
                            {before.diff.required_approvers.map((a) => a.team).join(", ")}.
                          </P>
                        )}
                        <Primary onClick={explore} bind={primary} label="Find a safer sequence" />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Narration>
              )}

              {scene === "futures" && (
                <Narration title={plan ? "Retire now, or prepare first" : "Rehearsing other futures"}>
                  {!plan ? (
                    <>
                      <P>
                        Instead of stopping at a warning, Orion tries the ways out it has evidence for: move a system onto a declared successor,
                        or switch it off too if nothing else relies on it. Each future is its own copy of the company, scored the same way.
                      </P>
                      <p className="flex items-center gap-2 text-[14px] text-muted">
                        <Spinner size={12} />
                        <span className="tnum text-ink">{futures.length}</span> {futures.length === 1 ? "copy" : "copies"} explored ·{" "}
                        <span className="tnum">{fmtMs(Math.max(0, now - planT0))}</span>
                      </p>
                    </>
                  ) : (
                    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }} className="space-y-4">
                      <Compare
                        left={{ title: "Retire now", tone: "bad", lines: [hitLine(t.stop, t.slow), `${nCust} customers affected`] }}
                        right={{
                          title: "Prepare first",
                          tone: plan.verdict === "residual" ? "warn" : "ok",
                          lines: [
                            `${plural(plan.steps.length - 1, "move")}, then retire`,
                            plan.verdict === "residual" ? `risk ${plan.best.risk} remains` : "Nothing in the model is hit",
                          ],
                        }}
                      />
                      <ol className="space-y-2">
                        {plan.steps.map((s, i) => (
                          <li key={i} className="flex gap-3 rounded-xl border border-rule bg-panel px-3.5 py-2.5">
                            <span className={`mono grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${i === plan.steps.length - 1 ? "bg-ember text-night" : "ring-1 ring-rule-strong"}`}>
                              {i + 1}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[15px] leading-snug text-ink">{humanLabel(s.label)}</span>
                              {!!s.prerequisites?.length && (
                                <span className="mt-0.5 block text-[13px] leading-snug text-warn">
                                  Waits on {s.prerequisites.map((p) => `${p.key} (${p.status}${p.blocks ? `, blocks ${p.blocks}` : ""})`).join(", ")}
                                </span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ol>
                      <p className="text-[13px] text-faint">
                        {plan.explored} copies in {fmtMs(plan.ms)}. Orion&apos;s model of the company, not a guarantee: what it rests on is listed on the
                        What-ifs screen.
                      </p>
                      <Primary onClick={() => go("evidence")} bind={primary} label="Meanwhile, in #billing…" />
                    </motion.div>
                  )}
                </Narration>
              )}

              {scene === "evidence" && (
                <Narration title={news.done ? "A new fact just changed this decision." : "New evidence"} big={news.done}>
                  {!news.started ? (
                    <>
                      <P>Two days later, Tomasz posts in #billing. Orion reads team chat to keep its records current.</P>
                      <Bubble />
                      {llm === false && !replay ? (
                        <p className="text-[14px] text-muted">Reading messages needs the AI service, which isn&apos;t set up on this server.</p>
                      ) : null}
                      <Primary onClick={deliver} bind={primary} disabled={llm === false && !replay} label="Let Orion read it" />
                    </>
                  ) : (
                    <div className="space-y-5">
                      <Bubble small />
                      <ol className="space-y-2.5">
                        <Beat
                          on={news.received}
                          label="New source received"
                          sub={`#billing, Tomasz Nowak${news.reader === "rules" ? " · read by Orion's sentence rules (the model was slow)" : news.reader ? " · read by the model" : ""}`}
                        />
                        <Beat
                          on={news.closed.length > 0}
                          label="Dependency updated"
                          sub={news.closed.length ? news.closed.map((c) => `${human(c.subject)} no longer relies on ${human(c.object)}`).join("; ") : "reading the message"}
                        />
                        <Beat
                          on={!!news.expired}
                          label="Earlier answer is now out of date"
                          sub={news.expired ? `Priya's answer: ${news.expired.broken} of ${news.expired.total} points no longer hold` : "checking every answer that relied on it"}
                        />
                        <Beat on={news.done} label="Decision rehearsed again" sub={after ? `on the changed company, universe ${after.uid}` : "copying the changed company"} />
                      </ol>
                      {news.done && after && ta && (
                        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }} className="space-y-4">
                          <Compare
                            left={{ title: "Rehearsed before", tone: "bad", lines: [hitLine(t.stop, t.slow), plural(nCust, "customer")] }}
                            right={{
                              title: "Rehearsed now",
                              tone: ta.stop + ta.slow ? "warn" : "ok",
                              lines: [hitLine(ta.stop, ta.slow), plural(nCustAfter, "customer")],
                            }}
                          />
                          <AnswerDelta a={answer.after ?? answer.before} />
                          <p className="border-l-2 border-ember pl-3 text-[16px] leading-snug text-ink">
                            Orion doesn&apos;t just remember the answer. It remembers what the answer depended on.
                          </p>
                          <Primary onClick={() => go("finale")} bind={primary} label="See the decision" />
                        </motion.div>
                      )}
                    </div>
                  )}
                </Narration>
              )}
            </aside>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function Narration({ title, big, children }: { title: string; big?: boolean; children: React.ReactNode }) {
  return (
    <motion.div key={title} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.45, ease: EASE }} className="space-y-4">
      <h2 className={`heading leading-[1.05] tracking-[-0.025em] ${big ? "text-[clamp(1.9rem,2.6vw,2.4rem)]" : "text-[28px]"}`}>{title}</h2>
      {children}
    </motion.div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-[16px] leading-[1.55] text-muted [&_b]:font-medium [&_b]:text-ink">{children}</p>;
}

function Primary({
  onClick,
  label,
  busy,
  busyLabel,
  disabled,
  bind,
}: {
  onClick: () => void;
  label: string;
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  bind: React.MutableRefObject<(() => void) | null>;
}) {
  useEffect(() => {
    bind.current = disabled || busy ? null : onClick;
    return () => {
      bind.current = null;
    };
  });
  return (
    <button type="button" onClick={onClick} disabled={disabled || busy} className="btn btn-primary h-11 w-full justify-center gap-2 rounded-xl text-[15px]">
      {busy && <Spinner size={13} />}
      {busy ? busyLabel ?? label : label}
      {!busy && (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M2.5 6h7M6.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/** The result strip: what the rehearsal found, large. */
function Strip({ stop, slow, customers }: { stop: number; slow: number; customers: number }) {
  const items = [
    { n: stop, label: stop === 1 ? "system stops" : "systems stop", c: "var(--color-bad)" },
    { n: slow, label: "slow down", c: "var(--color-warn)" },
    { n: customers, label: "customers affected", c: "var(--color-ink)" },
  ];
  return (
    <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-rule bg-panel">
      {items.map((x, i) => (
        <motion.div
          key={x.label}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 + i * 0.12, duration: 0.45, ease: EASE }}
          className={`px-3.5 py-3 ${i ? "border-l border-rule" : ""}`}
        >
          <p className="heading tnum text-[40px] leading-none" style={{ color: x.c }}>
            {x.n}
          </p>
          <p className="mt-1.5 text-[13px] leading-tight text-muted">{x.label}</p>
        </motion.div>
      ))}
    </div>
  );
}

/** What the walk reached, in causal order: changed system, directly affected, downstream. */
function Causal({ diff, upto }: { diff: Diff; upto: number }) {
  const rows = [...diff.broken].sort((a, b) => a.hops - b.hops || a.service.localeCompare(b.service));
  return (
    <ol className="space-y-1.5">
      {rows.map((b) => {
        const on = b.hops <= upto;
        const via = (b.path ?? []).slice(1, -1).map((u) => human(u.replace(/^svc:/, "")));
        return (
          <motion.li
            key={b.uid}
            initial={false}
            animate={{ opacity: on ? 1 : 0.28 }}
            className="flex items-baseline gap-2.5 text-[15px] leading-snug"
          >
            <span className="mt-[7px] size-2 shrink-0 self-start rounded-full" style={{ background: b.effect === "break" || !b.effect ? "var(--color-bad)" : "var(--color-warn)" }} aria-hidden />
            <span className="min-w-0">
              <span className="text-ink">{human(b.service)}</span>{" "}
              <span className="text-muted">{b.effect === "break" || !b.effect ? "stops" : "slows down"}</span>
              <span className="block text-[13px] text-faint">
                <span className="mono">{b.service}</span> · {b.hops === 1 ? "directly" : `${b.hops} steps away, through ${via.join(" → ")}`}
              </span>
            </span>
          </motion.li>
        );
      })}
    </ol>
  );
}

function SourceCard({ s, onMore }: { s: Record<string, unknown> | null; onMore: () => void }) {
  if (!s)
    return (
      <p className="mt-2 flex items-center gap-2 text-[13px] text-muted">
        <Spinner size={11} /> Finding the record
      </p>
    );
  return (
    <motion.figure initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }} className="mt-3 border-l-2 border-warn pl-3">
      <figcaption className="text-[13px] text-muted">
        <span className="text-ink">{String(s.author ?? "someone")}</span> in <span className="mono">{String(s.title ?? "")}</span> · {fmtDate(String(s.at ?? ""))}
      </figcaption>
      <blockquote className="mt-1 text-[14.5px] leading-[1.5] text-ink">&ldquo;{String(s.quote ?? s.text ?? "")}&rdquo;</blockquote>
      <button type="button" onClick={onMore} className="mt-1.5 text-[13px] text-muted underline underline-offset-4 hover:text-ink">
        The full record
      </button>
    </motion.figure>
  );
}

function Compare({
  left,
  right,
}: {
  left: { title: string; tone: "bad" | "warn" | "ok"; lines: string[] };
  right: { title: string; tone: "bad" | "warn" | "ok"; lines: string[] };
}) {
  const C = { bad: "var(--color-bad)", warn: "var(--color-warn)", ok: "var(--color-ok)" };
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {[left, right].map((x, i) => (
        <motion.div
          key={x.title}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.15, duration: 0.45, ease: EASE }}
          className="rounded-xl border bg-panel px-3.5 py-3"
          style={{ borderColor: `color-mix(in oklab, ${C[x.tone]} 45%, var(--color-rule))` }}
        >
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <span className="size-2 rounded-full" style={{ background: C[x.tone] }} aria-hidden />
            {x.title}
          </p>
          {x.lines.map((l, j) => (
            <p key={l} className={j ? "mt-0.5 text-[14px] leading-snug text-muted" : "heading mt-1.5 text-[18px] leading-tight"}>
              {l}
            </p>
          ))}
        </motion.div>
      ))}
    </div>
  );
}

function Bubble({ small }: { small?: boolean }) {
  return (
    <motion.figure layout className={`flex gap-3 rounded-xl border border-rule bg-panel ${small ? "px-3 py-2.5" : "px-4 py-3.5"}`}>
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-raised text-[12px] font-semibold text-muted ring-1 ring-rule" aria-hidden>
        TN
      </span>
      <div className="min-w-0">
        <figcaption className="flex items-baseline gap-2 text-[13px]">
          <span className="font-medium text-ink">{NEWS.name}</span>
          <span className="mono text-faint">{NEWS.channel}</span>
        </figcaption>
        <p className={`mt-0.5 leading-snug text-ink ${small ? "line-clamp-2 text-[13.5px]" : "text-[15px]"}`}>{NEWS.text}</p>
      </div>
    </motion.figure>
  );
}

function Beat({ on, label, sub }: { on: boolean; label: string; sub: string }) {
  return (
    <li className="flex gap-3">
      <span
        className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full transition-colors duration-300 ${on ? "bg-ember text-night" : "ring-1 ring-rule-strong"}`}
        aria-hidden
      >
        {on ? (
          <svg width="11" height="11" viewBox="0 0 12 12">
            <motion.path d="M2.5 6.2 5 8.6l4.6-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.3 }} />
          </svg>
        ) : (
          <Spinner size={10} />
        )}
      </span>
      <span className="min-w-0">
        <span className={`block text-[15px] leading-snug ${on ? "text-ink" : "text-muted"}`}>{label}</span>
        <span className="block text-[13px] leading-snug text-faint">{sub}</span>
      </span>
    </li>
  );
}

/** The earlier answer: the points the new fact undid, struck through with what is true now; the rest folded. */
function AnswerDelta({ a }: { a: AnswerLite | null }) {
  if (!a) return null;
  const gone = a.claims.filter((c) => c.stale);
  const held = a.claims.length - gone.length;
  const now = (r?: string | null) => {
    const m = /\(on today's company: (.*)\)$/.exec(r ?? "");
    return m ? `On today's company the change ${m[1]}.` : checkReason(r);
  };
  return (
    <div className="rounded-xl border border-rule bg-panel px-4 py-3.5">
      <p className="text-[13px] text-muted">
        Priya&apos;s answer from {fmtDate(a.at)}: &ldquo;{a.question}&rdquo;
      </p>
      <ul className="mt-2.5 space-y-2.5">
        {gone.map((c) => (
          <li key={c.text} className="text-[14px] leading-snug">
            <span className="text-faint line-through decoration-warn decoration-[1.5px]">{c.text}</span>
            <span className="mt-0.5 block text-[13px] text-warn">{now(c.stale_reason)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[13px] text-muted">
        {gone.length ? `The other ${plural(held, "point")} still ${held === 1 ? "holds" : "hold"}.` : "Every point still holds."}
      </p>
    </div>
  );
}

function Legend() {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
      <li className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-bad" aria-hidden /> stops working
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-warn" aria-hidden /> slows down
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block w-4 border-t-[1.5px] border-dashed border-warn" aria-hidden /> dependency nobody wrote down
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block w-4 border-t-2 border-ok" aria-hidden /> dependency moved
      </li>
    </ul>
  );
}

/** The last frame: the decision as it stands now, two ways, and what ran to get here. */
function Finale({
  map,
  before,
  after,
  today,
  plan,
  leftToDo,
  news,
  replay,
  onAgain,
  seen,
}: {
  map: CompanyMap | null;
  before: Forked | null;
  after: Forked | null;
  today: MapState;
  plan: PlanResult | null;
  leftToDo: PlanResult["steps"];
  news: { closed: unknown[]; expired: { broken: number; total: number } | null };
  replay: boolean;
  onAgain: () => void;
  seen: () => void;
}) {
  const now = after ?? before;
  const st = after ? today : now ? stateOfDiff(now.diff) : CALM;
  const tt = tally(st.effects);
  const hitNames = now?.diff.broken.map((b) => human(b.service)) ?? [];
  const custNames = now?.diff.customers?.map((c) => c.customer) ?? [];
  // the prepared company: the remaining moves made, then the switch-off; nothing modeled is hit
  const prepared: MapState = plan ? stateOfFuture(plan.best as Future, GOAL.service, () => []) : { ...CALM, off: [GOAL.service] };
  const steps = leftToDo.length ? leftToDo : plan?.steps.slice(0, -1) ?? [];
  return (
    <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="mx-auto w-full max-w-[1480px] px-4 pb-16 pt-8 md:px-8 md:pt-12">
      <p className="text-[14px] text-muted">{DECISION}</p>
      <h1 className="heading mt-1 text-[clamp(2.4rem,5vw,4rem)] leading-[1] tracking-[-0.035em]">The decision, rehearsed.</h1>
      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        <article className="rounded-2xl border border-bad/40 bg-panel p-5">
          <p className="flex items-center gap-2 text-[14px] text-muted">
            <span className="size-2 rounded-full bg-bad" aria-hidden /> Retire it today
          </p>
          <h2 className="heading mt-2 text-[26px] leading-tight">
            {tt.stop + tt.slow ? `${hitNames.join(", ")} ${tt.stop + tt.slow === 1 ? (tt.stop ? "stops" : "slows down") : "are hit"}` : "Nothing in the model is hit"}
          </h2>
          <p className="mt-1 text-[15px] leading-snug text-muted">
            {custNames.length ? `${plural(custNames.length, "customer")} use it: ${custNames.join(", ")}.` : "No customer uses an affected system."}
          </p>
          {map && (
            <div className="mt-4 rounded-xl bg-well p-2">
              <StageMap map={map} state={st} />
            </div>
          )}
        </article>
        <article className="rounded-2xl border border-ok/40 bg-panel p-5">
          <p className="flex items-center gap-2 text-[14px] text-muted">
            <span className="size-2 rounded-full bg-ok" aria-hidden /> Prepare first
          </p>
          <h2 className="heading mt-2 text-[26px] leading-tight">
            {steps.length ? `${steps.map((s) => humanLabel(s.label)).join(", then ")}, then retire` : "Retire it: nothing is left to move"}
          </h2>
          <p className="mt-1 text-[15px] leading-snug text-muted">
            No modeled problems after these steps.
            {steps.flatMap((s) => s.prerequisites ?? []).length
              ? ` Waits on ${steps.flatMap((s) => s.prerequisites ?? []).map((p) => p.key).join(" and ")}.`
              : ""}
          </p>
          {map && (
            <div className="mt-4 rounded-xl bg-well p-2">
              <StageMap map={map} state={prepared} />
            </div>
          )}
        </article>
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div>
          <p className="heading text-[clamp(1.5rem,2.4vw,2rem)] leading-[1.2] tracking-[-0.02em]">
            We test code before shipping it. Orion makes the decisions around that code rehearsable too.
          </p>
          <p className="mt-4 max-w-[62ch] text-[16px] leading-[1.6] text-muted">
            What you saw: copies of a synthetic company graph in FalkorDB, consequences computed by walking each copy, and the record behind
            each link. A model reads messages like Tomasz&apos;s; what breaks, and what a plan leaves broken, is computed from the graph.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/" onClick={seen} className="btn btn-primary h-11 rounded-full px-5 text-[15px]">
              Explore the workspace
            </Link>
            <button type="button" onClick={onAgain} className="btn h-11 rounded-full px-5 text-[15px]">
              {replay ? "Run it live" : "Rehearse again on a fresh copy"}
            </button>
          </div>
        </div>
        <div className="space-y-4">
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-rule bg-rule">
            {[
              { k: "to copy the company", v: before ? fmtMs(before.copy_ms) : "–" },
              { k: "futures rehearsed", v: plan ? `${plan.explored} in ${fmtMs(plan.ms)}` : "–" },
              { k: "answer flagged", v: news.expired ? `${news.expired.broken} of ${news.expired.total} points` : "–" },
            ].map((x) => (
              <div key={x.k} className="bg-panel px-3.5 py-3">
                <dt className="text-[12.5px] text-muted">{x.k}</dt>
                <dd className="heading tnum mt-1 text-[20px] leading-tight">{x.v}</dd>
              </div>
            ))}
          </dl>
          <Link href="/hindsight?i=INC-311" onClick={seen} className="group block rounded-xl border border-rule bg-panel px-4 py-3.5 transition-colors hover:border-rule-strong">
            <p className="text-[13px] text-muted">Encore: INC-311</p>
            <p className="mt-0.5 text-[16px] leading-snug text-ink">See what the company knew then, and what it learned too late.</p>
            <p className="mt-1 text-[13px] text-faint transition-colors group-hover:text-muted">The outage replayed against the records of the day →</p>
          </Link>
        </div>
      </div>
    </motion.section>
  );
}

