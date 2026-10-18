"use client";

// The guided rehearsal: one consequential decision, played out on the real API in the visitor's own copy of
// Corvane. The introduction states the proposal; one press copies the company and the story runs:
//
//   What breaks      the failure walks out from sso-legacy in the copy, column by column, to the customers
//   A safer plan     the safe-path search's explored copies, as cards on its tree; retire now against prepare first
//   New evidence     one step of the plan is reported done in #billing: a dependency closes, the earlier answer
//                    goes out of date, and the shutdown is rehearsed again on the updated company
//   The decision     whether it can be retired now, and what remains if not
//
// Each scene leads with what it found. A track above the stage says which company is on screen: a copy of today's,
// a simulated future, or the company after the real update.
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
  waitsOn,
} from "@/lib/rehearsal";
import Futures, { type Future } from "./Futures";
import Intro from "./Intro";
import StageMap from "./StageMap";

type Scene = "intro" | "cascade" | "futures" | "evidence" | "finale";
const STEPS: { scene: Scene; label: string }[] = [
  { scene: "cascade", label: "What breaks" },
  { scene: "futures", label: "A safer plan" },
  { scene: "evidence", label: "New evidence" },
  { scene: "finale", label: "The decision" },
];
const ORDER: Scene[] = ["intro", "cascade", "futures", "evidence", "finale"];

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

  // scene 1
  const [before, setBefore] = useState<Forked | null>(null);
  const [reveal, setReveal] = useState(-1);
  const [source, setSource] = useState<Record<string, unknown> | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  // scene 2
  const [futures, setFutures] = useState<Future[]>([]);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [rejected, setRejected] = useState<{ label: string; why: string }[]>([]);
  const [planT0, setPlanT0] = useState(0);
  const [planStatus, setPlanStatus] = useState("Checking out today's company");
  const [now, setNow] = useState(0);
  // scene 3
  const [news, setNews] = useState<{
    started: boolean;
    received: boolean;
    reader?: string;
    closed: { subject: string; object: string }[];
    opened: { subject: string; object: string }[];
    expired: { broken: number; total: number } | null;
    done: boolean;
  }>({ started: false, received: false, closed: [], opened: [], expired: null, done: false });
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

  // the recorded run the introduction's preview plays
  const [preview, setPreview] = useState<Recording | null>(null);
  useEffect(() => {
    fetch("/rehearsal-replay.json", { cache: "force-cache" })
      .then((r) => r.json())
      .then((rec: Recording) => setPreview(rec))
      .catch(() => {});
  }, []);

  const ghost = map?.edges.find((e) => !e.declared && e.dependency === GOAL.service) ?? null;
  // this copy already took Tomasz's message (the Inbox demo was played here): the story has already happened
  const spent = !!map && !replay && !map.edges.some((e) => e.dependent === "invoice-render" && e.dependency === GOAL.service);

  // the opening's one action: copy the company and switch the system off in the copy
  const rehearse = async () => {
    setBusy(true);
    setError(null);
    setBefore(null);
    setReveal(-1);
    go("cascade");
    try {
      setBefore(await run.fork("before"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // scene 1: the failure walks out, a column at a time, then reaches the customers
  const lastCol = map ? Math.max(...map.nodes.filter((n) => n.role !== "successor").map((n) => n.col)) : 0;
  useEffect(() => {
    if (scene !== "cascade" || !before) return;
    if (reduce) {
      setReveal(Infinity);
      return;
    }
    // a skipped walk stays finished
    const ts = Array.from({ length: lastCol + 2 }, (_, c) => setTimeout(() => setReveal((r) => (r === Infinity ? r : c)), 700 + c * 850));
    const end = setTimeout(() => setReveal(Infinity), 700 + (lastCol + 2) * 850);
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

  // scene 2: the search. A finished search is kept; one that failed halfway can be started again.
  const abort = useRef<AbortController | null>(null);
  const searching = useRef(false);
  const explore = async (restart = false) => {
    go("futures");
    if (plan || (searching.current && !restart)) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    searching.current = true;
    setFutures([]);
    setRejected([]);
    setPlanStatus("Checking out today's company");
    setPlanT0(performance.now());
    setError(null);
    let finished = false;
    try {
      await run.stream(
        "plan",
        (e) => {
          const d = e.data;
          if (e.event === "status") setPlanStatus(planWords(String(d.text ?? "")));
          else if (e.event === "universe") setFutures((xs) => (xs.some((x) => x.id === d.id) ? xs : [...xs, d as unknown as Future]));
          else if (e.event === "rejected") setRejected((xs) => [...xs, { label: String(d.label), why: String(d.why) }]);
          else if (e.event === "done" && d.result) {
            finished = true;
            setPlan(d.result as PlanResult);
          } else if (e.event === "error") setError(String(d.text ?? "The search failed"));
        },
        ac.signal,
      );
      if (!finished && !ac.signal.aborted) setError((x) => x ?? "The search ended without a result.");
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (abort.current === ac) searching.current = false;
    }
  };
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (scene !== "futures" || plan) return;
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [scene, plan]);

  // scene 3: the message, then the decision rehearsed again
  const deliver = async () => {
    setNews((n) => ({ ...n, started: true }));
    setError(null);
    // the decision is rehearsed again the moment the change is recorded, while Orion is still re-checking answers
    let again: Promise<Forked> | null = null;
    try {
      await run.stream("news", (e) => {
        const d = e.data;
        if (e.event === "recorded" && !again) again = run.fork("after");
        if (e.event === "extracted") setNews((n) => ({ ...n, received: true, reader: d.reader ? String(d.reader) : undefined }));
        else if (e.event === "status") setNews((n) => ({ ...n, received: true }));
        else if (e.event === "fact_closed")
          setNews((n) => ({ ...n, received: true, closed: [...n.closed, { subject: String(d.subject), object: String(d.object) }] }));
        else if (e.event === "fact_opened") setNews((n) => ({ ...n, opened: [...n.opened, { subject: String(d.subject), object: String(d.object) }] }));
        else if (e.event === "answer_expired")
          setNews((n) => ({ ...n, expired: { broken: (d.broken_claims as string[])?.length ?? 0, total: Number(d.total_claims ?? 0) } }));
        else if (e.event === "error") setError(String(d.text));
      });
      const [f, a] = await Promise.all([again ?? run.fork("after"), run.answer("after")]);
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
    primary.current = () => void rehearse();
    return () => {
      primary.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, map, replay]);

  const seen = () => {
    try {
      localStorage.setItem(SEEN_KEY, "seen");
    } catch {
      /* not remembered */
    }
  };

  // a recorded run, clearly labelled. Started from a failed step or the waiting screen, it plays from the top;
  // ?replay opens it on the introduction (for a presentation over a bad connection)
  const [autostart, setAutostart] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("replay")) void playRecording(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!autostart || !replay) return;
    setAutostart(false);
    void rehearse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart, replay]);

  const playRecording = async (start = true) => {
    setError(null);
    try {
      const r = await fetch("/rehearsal-replay.json", { cache: "force-cache" });
      const rec = (await r.json()) as Recording;
      abort.current?.abort();
      searching.current = false;
      setBefore(null);
      setFutures([]);
      setPlan(null);
      setRejected([]);
      setAfter(null);
      setNews({ started: false, received: false, closed: [], opened: [], expired: null, done: false });
      setSource(null);
      setSourceOpen(false);
      setReplay(rec);
      if (start) setAutostart(true);
    } catch {
      setError("The recorded run couldn't be loaded.");
    }
  };

  // ------------------------------------------------------------------ what each scene says

  const shown = scene === "evidence" && after ? after : before;
  const plannedMoves = plan ? plan.steps.length - 1 : 0;
  const headline = (() => {
    if (scene === "cascade") {
      if (!before) return { h: "Copying today's company", sub: "A full copy of the company graph, so the shutdown can be tested without touching anything real." };
      if (!cascadeDone) return { h: `Following the failure out from ${human(GOAL.service)}`, sub: "Orion walks every dependency in the copy, one step at a time." };
      return { h: blastHeadline(before.diff, ghost?.dependent ?? null), sub: null };
    }
    if (scene === "futures") {
      if (!plan) return { h: "Looking for a safer sequence", sub: "Each future is a full copy of the company with preparation applied. None of it has happened." };
      const clear = !plan.best.broken.length && !plan.best.customers;
      return {
        h: clear ? `There is a safer sequence: ${plural(plannedMoves, "move")}, then retire.` : `Preparing first cuts the risk from ${plan.baseline.risk} to ${plan.best.risk}.`,
        sub: "A simulated outcome. None of these moves has happened yet.",
      };
    }
    if (scene === "evidence") {
      if (!news.started)
        return { h: "One step of the plan has been reported complete.", sub: "Orion checks the update against the company graph and recalculates what remains." };
      if (!news.done || !ta) return { h: "Checking the update", sub: "Reading the message, updating the graph, and re-checking everything that relied on it." };
      const left = ta.stop + ta.slow;
      return {
        h: left
          ? `A new fact changed the answer: ${plural(left, "system")} and ${plural(nCustAfter, "customer")} still at risk.`
          : "A new fact changed the answer: nothing is at risk now.",
        sub: null,
      };
    }
    return { h: "", sub: null };
  })();

  // ------------------------------------------------------------------ render

  const [since] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (awake) return;
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [awake]);
  const waited = Math.round((Date.now() - since) / 1000);

  const retry = scene === "cascade" && !before ? rehearse : scene === "futures" && !plan ? () => explore(true) : null;

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
              const done = ORDER.indexOf(s.scene) < ORDER.indexOf(scene);
              const here = s.scene === scene;
              const can = ORDER.indexOf(s.scene) <= reached;
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
              Replay<span className="hidden md:inline"> of a recorded run{replay.at ? `, ${fmtDate(replay.at)}` : ""}</span>
            </span>
          ) : (
            <span className="hidden items-center gap-2 text-[12px] text-muted md:flex" title="Every step calls the API and runs on FalkorDB">
              <span className="size-1.5 rounded-full bg-ok" aria-hidden />
              Live
            </span>
          )}
          <Link href="/" onClick={seen} className="btn btn-ghost h-8 px-2.5 text-[13px]">
            <span className="hidden sm:inline">Explore the workspace</span>
            <span className="sm:hidden">Workspace</span>
          </Link>
        </div>
      </header>

      {/* what is being rehearsed, which company is on screen, and the technical details for whoever wants them */}
      {scene !== "intro" && (
        <div className="mx-auto w-full max-w-[1480px] px-4 pt-4 md:px-8">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule pb-3">
            <p className="text-[14px] text-muted">
              Rehearsing: <span className="text-ink">retire {human(GOAL.service)}</span>
              <span className="hidden sm:inline"> · Corvane · {replay ? "recorded run" : "simulation"}</span>
              <span className="hidden text-faint md:inline">
                {" "}
                · on screen:{" "}
                {scene === "cascade" ? "a copy of today's company" : scene === "futures" ? "simulated plans, none of it done" : "the company after the update"}
              </span>
            </p>
            <details className="group relative ml-auto text-[12.5px]">
              <summary className="cursor-pointer list-none text-faint hover:text-muted [&::-webkit-details-marker]:hidden">
                Technical details <span className="inline-block transition-transform group-open:rotate-180">▾</span>
              </summary>
              <div className="mono absolute right-0 z-20 mt-2 w-[min(340px,90vw)] space-y-1 rounded-lg border border-rule bg-panel p-3 text-[12px] leading-relaxed text-muted shadow-float">
                <p>
                  op <span className="text-ink">{GOAL.op}</span> · service <span className="text-ink">{GOAL.service}</span>
                </p>
                <p>tenant {replay ? replay.tenant : tenant?.id ?? currentTenant()}</p>
                {shown && (
                  <p>
                    universe {shown.uid} · copy {fmtMs(shown.copy_ms)} · apply {fmtMs(shown.apply_ms)} · total {fmtMs(shown.ms)}
                  </p>
                )}
                {plan && (
                  <p>
                    search: {plan.explored} copies in {fmtMs(plan.ms)} · verdict {plan.verdict}
                  </p>
                )}
                {news.reader && <p>message read by {news.reader === "rules" ? "sentence rules (model too slow)" : "the model"}</p>}
              </div>
            </details>
          </div>
        </div>
      )}

      {/* the result of the scene: the biggest thing on screen */}
      {scene !== "intro" && scene !== "finale" && (
        <section className="mx-auto w-full max-w-[1480px] px-4 pb-1 pt-5 md:px-8">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={headline.h} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.4, ease: EASE }}>
              <h1 className="heading max-w-[34ch] text-[clamp(1.7rem,2.7vw,2.7rem)] leading-[1.08] tracking-[-0.03em]">{headline.h}</h1>
              {scene === "cascade" && cascadeDone && before ? (
                <ResultLine stop={t.stop} slow={t.slow} customers={nCust} />
              ) : scene === "evidence" && news.done && ta ? (
                <ResultLine stop={ta.stop} slow={ta.slow} customers={nCustAfter} was={{ stop: t.stop, slow: t.slow, customers: nCust }} />
              ) : headline.sub ? (
                <p className="mt-2 max-w-[70ch] text-[16px] leading-snug text-muted">{headline.sub}</p>
              ) : null}
            </motion.div>
          </AnimatePresence>
        </section>
      )}

      <AnimatePresence mode="wait">
        {scene === "intro" ? (
          <Intro
            key="intro"
            preview={preview}
            ready={!!map || !!replay}
            awake={awake}
            replay={!!replay}
            waited={waited}
            spent={spent}
            onFresh={() => startOver("/rehearse")}
            onStart={() => void rehearse()}
            onReplay={() => void playRecording()}
            seen={seen}
          />
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
            className="mx-auto grid w-full max-w-[1480px] flex-1 gap-6 px-4 pb-10 pt-4 md:px-8 xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-8"
          >
            {/* the stage */}
            <section className="min-w-0" aria-label="Stage">
              {scene === "futures" ? (
                map && futures.length ? (
                  <Futures nodes={futures} result={plan} rejected={rejected} map={map} customersOf={customersOf} />
                ) : (
                  <div className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-rule-strong">
                    <p className="flex items-center gap-2.5 text-[15px] text-muted">
                      {!error && <Spinner size={13} />} {error ? "The search stopped." : planStatus}
                    </p>
                  </div>
                )
              ) : (
                <div className="relative rounded-2xl border border-ember/40 bg-panel p-3 shadow-[0_40px_120px_-60px_rgb(255_107_53/0.45)] md:p-4">
                  <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                    <span className="flex items-center gap-1.5 text-ember">
                      <span className="size-1.5 rounded-full bg-ember" aria-hidden />
                      Simulation
                    </span>
                    <span className="text-muted">
                      {scene === "cascade"
                        ? `A copy of today's company with ${human(GOAL.service)} retired`
                        : news.closed.length || after
                          ? `The updated company with ${human(GOAL.service)} retired`
                          : `Retire now, as rehearsed before the update`}
                    </span>
                    <span
                      className="ml-auto rounded border border-rule px-1.5 py-px text-[11.5px] text-muted"
                      title="Computed by walking the copied graph; not a measured outage"
                    >
                      modelled impact
                    </span>
                  </div>
                  {map && scene === "cascade" && (
                    // the company as it is, in the corner: a faint reference while the copy takes the stage
                    <motion.div
                      initial={reduce ? false : { opacity: 0, scale: 1.4, x: 40, y: 30 }}
                      animate={{ opacity: 0.85, scale: 1, x: 0, y: 0 }}
                      transition={{ duration: 0.9, ease: EASE, delay: 0.2 }}
                      className="absolute left-4 top-10 z-[1] hidden w-[17%] origin-top-left rounded-lg border border-rule bg-night/90 p-1.5 md:block"
                    >
                      <p className="px-1 text-[11.5px] text-muted">Today&apos;s company · untouched</p>
                      <StageMap map={map} state={CALM} mini label="Today's company, untouched" />
                    </motion.div>
                  )}
                  {map ? (
                    // phones: the map keeps a readable size and scrolls sideways; larger screens: it fits the viewport's height
                    <div className="-mx-3 overflow-x-auto px-3 md:mx-0 md:overflow-visible md:px-0">
                      <motion.div
                        className="relative mx-auto min-w-[640px] md:min-w-0 md:max-w-[calc((100dvh_-_330px)_*_1.85)]"
                        initial={reduce ? false : { opacity: 0, scale: 0.985 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.7, ease: EASE }}
                      >
                        <StageMap
                          map={map}
                          state={scene === "evidence" ? (news.closed.length || after ? afterState : beforeState) : beforeState}
                          reveal={scene === "cascade" ? reveal : Infinity}
                          focus={scene === "cascade" && cascadeDone ? ghost?.id : null}
                          onEdge={scene === "cascade" && cascadeDone ? () => void openSource() : undefined}
                        />
                        {scene === "cascade" && !before && <CopyingVeil />}
                      </motion.div>
                    </div>
                  ) : (
                    <div className="grid aspect-[1000/540] place-items-center text-[14px] text-muted">{error ? null : <Spinner />}</div>
                  )}
                  <Legend />
                </div>
              )}
            </section>

            {/* one finding, one next action; the depth behind it */}
            <aside className="min-w-0 space-y-4 xl:sticky xl:top-20 xl:self-start" aria-live="polite">
              {error && (
                <div className="rounded-xl border border-bad/50 bg-bad/5 px-4 py-3 text-[14px]" role="alert">
                  <p className="text-ink">That step didn&apos;t finish.</p>
                  <p className="mt-1 text-[13px] text-muted">{error}</p>
                  <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]">
                    {retry && (
                      <button type="button" onClick={() => void retry()} className="text-ink underline underline-offset-4">
                        {scene === "futures" ? "Retry this search" : "Try again"}
                      </button>
                    )}
                    {!replay && (
                      <button type="button" onClick={() => void playRecording()} className="text-muted underline underline-offset-4 hover:text-ink">
                        Watch the recorded run (labelled Replay)
                      </button>
                    )}
                  </div>
                </div>
              )}

              {scene === "cascade" &&
                (!before ? (
                  !error && (
                    <p className="flex items-center gap-2.5 text-[15px] text-muted">
                      <Spinner size={13} /> Copying the company graph
                    </p>
                  )
                ) : !cascadeDone ? (
                  <Panel key="walk" title="What the walk reaches">
                    <Causal diff={before.diff} upto={reveal} />
                    <button type="button" onClick={() => setReveal(Infinity)} className="text-[13px] text-muted underline underline-offset-4 hover:text-ink">
                      Show the result
                    </button>
                  </Panel>
                ) : (
                  <Panel key="found" title="What this means">
                    {ghost ? (
                      <div className="rounded-xl border border-warn/50 bg-panel px-4 py-3.5">
                        <p className="text-[15.5px] leading-snug text-ink">
                          {human(ghost.dependent)} relies on {human(GOAL.service)}, and that link was never written down.
                        </p>
                        <p className="mt-1 text-[14px] leading-snug text-muted">
                          It starts most of this. Orion found it in a #billing message, not in the service catalog.
                        </p>
                        {!sourceOpen ? (
                          <button
                            type="button"
                            onClick={openSource}
                            className="mt-2 text-[14px] text-warn underline decoration-warn/40 underline-offset-4 hover:decoration-warn"
                          >
                            Inspect the evidence
                          </button>
                        ) : (
                          <SourceCard s={source} onMore={() => ghost.fact && openBlame({ fact: ghost.fact })} />
                        )}
                      </div>
                    ) : (
                      <P>Every system that relies on it, directly or through others, is hit.</P>
                    )}
                    <Primary onClick={() => void explore()} bind={primary} label="Find a safer sequence" />
                    <More title="Everything that breaks, in order">
                      <Causal diff={before.diff} upto={Infinity} />
                      {!!before.diff.required_approvers?.length && (
                        <p className="mt-3 text-[13.5px] text-muted">
                          {before.diff.required_approvers.length} teams would have to sign off:{" "}
                          {before.diff.required_approvers.map((a) => a.team).join(", ")}.
                        </p>
                      )}
                    </More>
                  </Panel>
                ))}

              {scene === "futures" &&
                (!plan ? (
                  <Panel key="searching" title="How the search works">
                    <P>
                      Orion only tries moves it has evidence for: move a system onto its declared successor, or switch it off too if nothing else
                      relies on it. Every future is scored the same way.
                    </P>
                    {!error && (
                      <p className="flex items-center gap-2 text-[14px] text-muted">
                        <Spinner size={12} />
                        <span className="tnum text-ink">{futures.length}</span> {futures.length === 1 ? "future" : "futures"} explored ·{" "}
                        <span className="tnum">{fmtMs(Math.max(0, now - planT0))}</span>
                      </p>
                    )}
                  </Panel>
                ) : (
                  <Panel key="plan" title="Retire now, or prepare first">
                    <Compare
                      left={{ title: "Retire now", tone: "bad", lines: [hitLine(t.stop, t.slow), `${nCust} customers affected`] }}
                      right={{
                        title: "Prepare first",
                        tone: plan.verdict === "residual" ? "warn" : "ok",
                        lines: [
                          plan.verdict === "residual" ? `Risk ${plan.best.risk} remains` : "Nothing in the model is hit",
                          `after ${plural(plannedMoves, "move")}`,
                        ],
                      }}
                    />
                    <Primary onClick={() => go("evidence")} bind={primary} label="Next: new evidence" />
                    <More title="The plan, step by step">
                      <Steps steps={plan.steps} />
                      <p className="mt-3 text-[13px] text-faint">Orion&apos;s model of the company, not a guarantee. What it rests on is listed on the What-ifs screen.</p>
                    </More>
                  </Panel>
                ))}

              {scene === "evidence" && (
                <Panel key={news.started ? "reading" : "message"} title={news.started ? "What Orion did with it" : "New in #billing"}>
                  {!news.started ? (
                    <>
                      <Bubble />
                      <P>That is step one of the plan. Orion reads team chat to keep its records current.</P>
                      {llm === false && !replay ? (
                        <p className="text-[14px] text-muted">Reading messages needs the AI service, which isn&apos;t set up on this server.</p>
                      ) : null}
                      <Primary onClick={deliver} bind={primary} disabled={llm === false && !replay} label="Let Orion read it" />
                    </>
                  ) : (
                    <>
                      <Bubble small />
                      <ol className="space-y-2.5">
                        <Beat
                          on={news.received}
                          label="New source received"
                          sub={`#billing, Tomasz Nowak${news.reader === "rules" ? " · read by Orion's sentence rules" : news.reader ? " · read by the model" : ""}`}
                        />
                        <Beat
                          on={news.closed.length > 0}
                          label="Company graph updated"
                          sub={
                            news.closed.length
                              ? news.closed.map((c) => `${human(c.subject)} no longer relies on ${human(c.object)}`).join("; ")
                              : "reading the message"
                          }
                        />
                        <Beat
                          on={!!news.expired}
                          label="Earlier answer marked out of date"
                          sub={news.expired ? `Priya's answer: ${news.expired.broken} of ${news.expired.total} points no longer hold` : "checking every answer that relied on it"}
                        />
                        <Beat on={news.done} label="Shutdown rehearsed again" sub={after ? "on the updated company" : "copying the updated company"} />
                      </ol>
                      {news.done && after && ta && (
                        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }} className="space-y-4">
                          <Primary onClick={() => go("finale")} bind={primary} label="See the decision" />
                          <AnswerDelta a={answer.after ?? answer.before} />
                        </motion.div>
                      )}
                    </>
                  )}
                </Panel>
              )}
            </aside>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------------ pieces

/** "An undocumented dependency puts Billing in the blast radius." The most important system the hidden link reaches. */
function blastHeadline(diff: Diff, hidden: string | null) {
  if (hidden) {
    const reached = diff.broken
      .filter((b) => b.service !== hidden && b.via_undeclared?.length)
      .sort((a, b) => a.tier - b.tier || a.hops - b.hops || a.service.localeCompare(b.service));
    if (reached[0]) return `An undocumented dependency puts ${human(reached[0].service)} in the blast radius.`;
    return `An undocumented dependency means ${human(hidden)} stops.`;
  }
  const n = diff.broken.length;
  return n ? `Retiring it now hits ${plural(n, "system")}.` : "Retiring it now hits nothing in the model.";
}

/** The scene's result in numbers, under its headline; with `was`, against the earlier rehearsal. */
function ResultLine({
  stop,
  slow,
  customers,
  was,
}: {
  stop: number;
  slow: number;
  customers: number;
  was?: { stop: number; slow: number; customers: number };
}) {
  const items = [
    { n: stop, label: stop === 1 ? "system stops" : "systems stop", c: "var(--color-bad)", w: was?.stop },
    { n: slow, label: "slow down", c: "var(--color-warn)", w: was?.slow },
    { n: customers, label: customers === 1 ? "customer affected" : "customers affected", c: "var(--color-ink)", w: was?.customers },
  ];
  return (
    <p className="mt-2.5 flex flex-wrap items-baseline gap-x-5 gap-y-1">
      {items.map((x, i) => (
        <motion.span
          key={x.label}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 + i * 0.12, duration: 0.45, ease: EASE }}
          className="flex items-baseline gap-1.5"
        >
          {x.w !== undefined && x.w !== x.n && <span className="heading tnum text-[20px] text-faint line-through decoration-[1.5px]">{x.w}</span>}
          <span className="heading tnum text-[28px] leading-none" style={{ color: x.n ? x.c : "var(--color-muted)" }}>
            {x.n}
          </span>
          <span className="text-[15px] text-muted">{x.label}</span>
        </motion.span>
      ))}
      <span className="rounded border border-rule px-1.5 py-px text-[11.5px] text-faint" title="Computed by walking the copied graph; not a measured outage">
        modelled
      </span>
    </p>
  );
}

/** The light that crosses the map while the company is being copied. */
function CopyingVeil() {
  const reduce = useReducedMotion();
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg" aria-hidden>
      {!reduce && (
        <motion.span
          className="absolute inset-y-0 left-0 w-[30%]"
          style={{ background: "linear-gradient(90deg, transparent, rgb(255 107 53 / 0.12) 75%, rgb(255 107 53 / 0.55) 99%, transparent)" }}
          initial={{ x: "-110%" }}
          animate={{ x: "340%" }}
          transition={{ duration: 1.3, ease: [0.65, 0, 0.35, 1], repeat: Infinity, repeatDelay: 0.25 }}
        />
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.45, ease: EASE }} className="space-y-4">
      <h2 className="text-[13px] font-medium text-muted">{title}</h2>
      {children}
    </motion.div>
  );
}

/** Depth for whoever wants it, folded by default. */
function More({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-xl border border-rule bg-panel/60 px-4 py-2.5">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[13.5px] text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        {title}
        <span className="transition-transform group-open:rotate-180" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="pb-1.5 pt-3">{children}</div>
    </details>
  );
}

function Steps({ steps }: { steps: PlanResult["steps"] }) {
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span
            className={`mono grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${i === steps.length - 1 ? "bg-ember text-night" : "ring-1 ring-rule-strong"}`}
          >
            {i + 1}
          </span>
          <span className="min-w-0">
            <span className="block text-[14.5px] leading-snug text-ink">{humanLabel(s.label)}</span>
            {!!s.prerequisites?.length && <span className="mt-0.5 block text-[13px] leading-snug text-warn">{waitsOn(s.prerequisites)}</span>}
          </span>
        </li>
      ))}
    </ol>
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

/** Systems a visitor can rehearse switching off next, on the What-ifs screen (which takes ?try=<system>). */
const NEXT_TRIES = ["reports-legacy", "flag-eval", "edge-gateway"];

/** The last frame: the decision as it stands now, what remains before it can be made, and where to go next. */
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
  news: { closed: { subject: string; object: string }[]; opened: { subject: string; object: string }[]; expired: { broken: number; total: number } | null };
  replay: boolean;
  onAgain: () => void;
  seen: () => void;
}) {
  const reduce = useReducedMotion();
  const now = after ?? before;
  const st = after ? today : now ? stateOfDiff(now.diff) : CALM;
  const tt = tally(st.effects);
  const hit = tt.stop + tt.slow;
  const hitNames = now?.diff.broken.map((b) => human(b.service)) ?? [];
  const custNames = now?.diff.customers?.map((c) => c.customer) ?? [];
  // the prepared company: the remaining moves made, then the switch-off
  const prepared: MapState = plan ? stateOfFuture(plan.best as Future, GOAL.service, () => []) : { ...CALM, off: [GOAL.service] };
  const steps = after ? leftToDo : (plan?.steps.slice(0, -1) ?? []);
  const moved = news.opened.map((o) => `${human(o.subject)} now uses ${human(o.object)}.`).join(" ");
  const verdict = hit ? "Don't retire it yet." : "It can be retired.";
  const why = hit
    ? `${moved ? `${moved} ` : ""}${steps.length ? `${plural(steps.length, "step")} ${steps.length === 1 ? "remains" : "remain"} before the shutdown is safe.` : "Something is still hit."}`
    : `${moved ? `${moved} ` : ""}Nothing in the model is hit any more.`;
  const C = (d: number) => ({
    initial: reduce ? false : { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.6, ease: EASE, delay: d },
  });
  return (
    <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="mx-auto w-full max-w-[1480px] px-4 pb-16 pt-6 md:px-8 md:pt-8">
      <motion.p {...C(0)} className="text-[14px] text-muted">
        The decision, on the company as it is now
      </motion.p>
      <motion.h1 {...C(0.05)} className="heading mt-1 text-[clamp(2.6rem,5.4vw,4.6rem)] leading-[1] tracking-[-0.04em]">
        {verdict}
      </motion.h1>
      <motion.p {...C(0.15)} className="mt-3 max-w-[60ch] text-[clamp(1.05rem,1.5vw,1.3rem)] leading-snug text-muted">
        {why}
      </motion.p>

      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        {/* what remains: the useful part, first */}
        <motion.article {...C(0.25)} className="rounded-2xl border border-ember/50 bg-panel p-5 shadow-[0_40px_120px_-60px_rgb(255_107_53/0.5)]">
          <p className="flex items-center gap-2 text-[14px] text-muted">
            <span className="size-2 rounded-full bg-ember" aria-hidden /> {steps.length ? "What remains" : "Ready"}
          </p>
          {steps.length ? (
            <ol className="mt-3 space-y-3">
              {[...steps, { label: `Switch off ${GOAL.service}`, prerequisites: [] as NonNullable<PlanResult["steps"][number]["prerequisites"]> }].map((s, i, all) => (
                <li key={s.label} className="flex gap-3">
                  <span
                    className={`mono grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${i === all.length - 1 ? "ring-1 ring-rule-strong" : "bg-ember text-night"}`}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="heading block text-[22px] leading-tight">{humanLabel(s.label)}</span>
                    {!!s.prerequisites?.length && <span className="mt-0.5 block text-[14px] text-warn">{waitsOn(s.prerequisites)}</span>}
                    {i === all.length - 1 && <span className="mt-0.5 block text-[14px] text-muted">Then nothing in the model is hit.</span>}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <h2 className="heading mt-2 text-[24px] leading-tight">Switch off {human(GOAL.service)}: nothing is left to move.</h2>
          )}
          {map && (
            <div className="mt-4 rounded-xl bg-well p-2">
              <StageMap map={map} state={prepared} label="After the remaining steps: nothing in the model is hit" />
            </div>
          )}
        </motion.article>
        <motion.article {...C(0.35)} className="rounded-2xl border border-rule bg-panel p-5" style={{ borderColor: hit ? "color-mix(in oklab, var(--color-bad) 40%, var(--color-rule))" : undefined }}>
          <p className="flex items-center gap-2 text-[14px] text-muted">
            <span className="size-2 rounded-full" style={{ background: hit ? "var(--color-bad)" : "var(--color-ok)" }} aria-hidden /> If you retire it today
          </p>
          <h2 className="heading mt-2 text-[22px] leading-tight">
            {hit ? `${hitNames.join(", ")} ${hit === 1 ? (tt.stop ? "stops" : "slows down") : "are hit"}` : "Nothing in the model is hit"}
          </h2>
          <p className="mt-1 text-[15px] leading-snug text-muted">
            {custNames.length ? `${plural(custNames.length, "customer")} would notice: ${custNames.join(", ")}.` : "No customer uses an affected system."}
          </p>
          {map && (
            <div className="mt-4 rounded-xl bg-well p-2">
              <StageMap map={map} state={st} label="Retiring it today" />
            </div>
          )}
        </motion.article>
      </div>

      {/* one credible next experiment */}
      <motion.div {...C(0.45)} className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-rule bg-panel px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="heading text-[20px] leading-tight">Try another change</p>
          <p className="mt-0.5 text-[14px] text-muted">Pick a system and Orion rehearses switching it off the same way, on your copy.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {NEXT_TRIES.map((s) => (
            <Link key={s} href={`/multiverse?try=${s}`} onClick={seen} className="btn h-10 rounded-full px-4 text-[14px]">
              Switch off {human(s)}
            </Link>
          ))}
        </div>
      </motion.div>

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div>
          <p className="heading text-[clamp(1.4rem,2.2vw,1.9rem)] leading-[1.2] tracking-[-0.02em]">
            We test code before shipping it. Orion makes the decisions around that code rehearsable too.
          </p>
          <p className="mt-4 max-w-[62ch] text-[15.5px] leading-[1.6] text-muted">
            What you saw: copies of a synthetic company graph in FalkorDB, consequences computed by walking each copy, and the record behind each
            link. A model reads messages like Tomasz&apos;s; what breaks, and what a plan leaves broken, is computed from the graph.
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
            <p className="mt-1 text-[13px] text-faint transition-colors group-hover:text-muted">The outage replayed against the records of the day</p>
          </Link>
        </div>
      </div>
    </motion.section>
  );
}
