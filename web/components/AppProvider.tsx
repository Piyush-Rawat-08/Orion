"use client";

// App-wide state: who you are acting as, the Brain conversation (kept while you move between screens),
// the claim highlight shared with the canvas, the blame drawer, and the unread inbox count.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { get, setApiUser } from "@/lib/api";
import { postStream } from "@/lib/sse";
import type { AskResult, Claim, GraphUse, ClaimCheck, GEdge, GNode, LastSession, Notification, Person, Tenant, Verdict } from "@/lib/types";

export type Step =
  | { id: number; kind: "status"; agent: string; text: string }
  | { id: number; kind: "thinking"; text: string }
  | { id: number; kind: "narration"; text: string }
  | {
      id: number;
      kind: "tool";
      tool: string;
      args: Record<string, unknown>;
      pending: boolean;
      ms?: number;
      ok?: boolean;
      evidence?: string[];
      /** graph nodes the call touched (lit on the canvas while the agent works) */
      nodes?: string[];
    }
  | { id: number; kind: "error"; text: string };

export interface Turn {
  id: string;
  question: string;
  user: string;
  startedAt: number;
  status: "streaming" | "done" | "error";
  steps: Step[];
  verdicts: Record<number, { verdict: Verdict; reason: string; check?: ClaimCheck | null }>;
  answer?: { answer?: string; summary: string; claims: Claim[]; follow_ups: string[]; ms: number; graph?: GraphUse | null };
  result?: AskResult;
  error?: string;
  /** brought back from an earlier visit: when it was asked, and whether its answer still holds */
  restored?: { at: string; status: string };
}

export interface BlameTarget {
  /** tenant the fact lives in (defaults to the demo tenant) */
  tenant?: string;
  fact?: string | null;
  edge?: GEdge;
  sourceName?: string | null;
  targetName?: string | null;
  source?: GNode;
  target?: GNode;
  /** the canvas the edge was clicked on, for context like "one of 3 people who know it" */
  graph?: { nodes: GNode[]; edges: GEdge[] } | null;
}

export interface Highlight {
  key: string;
  nodes: string[];
  color: string;
  pinned: boolean;
}

interface Ctx {
  user: string;
  setUser: (u: string) => void;
  people: Person[];
  personName: (uid?: string | null) => string;
  tenant: Tenant | null;
  refreshTenant: () => void;

  turns: Turn[];
  asking: boolean;
  ask: (question: string) => void;
  stop: () => void;
  clearChat: () => void;
  /** the user's last conversation from an earlier visit, while it isn't on screen */
  previous: LastSession | null;
  resume: () => void;

  highlight: Highlight | null;
  /** hover: show these nodes unless something is pinned */
  hoverHighlight: (key: string, nodes: string[], color: string) => void;
  hoverEnd: () => void;
  /** click: pin (or unpin when the same key is pinned) */
  pinHighlight: (key: string, nodes: string[], color: string) => void;
  clearHighlight: () => void;

  blame: BlameTarget | null;
  openBlame: (b: BlameTarget) => void;
  closeBlame: () => void;

  unread: number;
  refreshInbox: () => void;

  /** whether the backend has an LLM key (null until /api/health answers) */
  llm: boolean | null;
  /** the last conversation is still being fetched (at most 600 ms) */
  restoring: boolean;
  /** whether the API has answered yet: false while a sleeping free-tier server wakes up */
  awake: boolean;
  /** answers whose inbox note says something they relied on changed: flagged wherever they are on screen */
  staleAnswers: Set<string>;
}

const AppCtx = createContext<Ctx | null>(null);

export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
};

const DEFAULT_USER = "person:priya-raman";

function applyEvent(t: Turn, type: string, d: Record<string, unknown>, nextId: () => number): Turn {
  const steps = [...t.steps];
  switch (type) {
    case "status":
      steps.push({ id: nextId(), kind: "status", agent: String(d.agent ?? ""), text: String(d.text ?? "") });
      return { ...t, steps };
    case "thinking":
      steps.push({ id: nextId(), kind: "thinking", text: String(d.text ?? "") });
      return { ...t, steps };
    case "narration":
      steps.push({ id: nextId(), kind: "narration", text: String(d.text ?? "") });
      return { ...t, steps };
    case "tool_call":
      steps.push({
        id: nextId(),
        kind: "tool",
        tool: String(d.tool),
        args: (d.args as Record<string, unknown>) ?? {},
        pending: true,
      });
      return { ...t, steps };
    case "tool_result": {
      let i = steps.length - 1;
      while (i >= 0 && !(steps[i].kind === "tool" && (steps[i] as { tool: string }).tool === d.tool && (steps[i] as { pending: boolean }).pending)) i--;
      const patch = {
        pending: false,
        ms: Number(d.ms),
        ok: Boolean(d.ok),
        evidence: (d.evidence as string[]) ?? [],
        nodes: (d.nodes as string[]) ?? [],
      };
      if (i >= 0) steps[i] = { ...(steps[i] as Extract<Step, { kind: "tool" }>), ...patch };
      else
        steps.push({
          id: nextId(),
          kind: "tool",
          tool: String(d.tool),
          args: (d.args as Record<string, unknown>) ?? {},
          ...patch,
        });
      return { ...t, steps };
    }
    case "verdict":
      return {
        ...t,
        verdicts: {
          ...t.verdicts,
          [Number(d.index)]: { verdict: d.verdict as Verdict, reason: String(d.reason ?? ""), check: (d.check as ClaimCheck | null) ?? null },
        },
      };
    case "answer":
      return { ...t, answer: d as unknown as Turn["answer"] };
    case "error":
      steps.push({ id: nextId(), kind: "error", text: String(d.text ?? "error") });
      return { ...t, steps, error: String(d.text ?? "error") };
    case "done": {
      const result = (d.result as AskResult | null) ?? undefined;
      return {
        ...t,
        status: result && !result.error ? "done" : "error",
        result,
        error: t.error ?? result?.error ?? (result ? undefined : "The assistant stopped without an answer."),
        steps: steps.map((s) => (s.kind === "tool" && s.pending ? { ...s, pending: false } : s)),
      };
    }
    default:
      return t;
  }
}

/** A stored conversation, as turns the Brain can show (no trace: it ran on an earlier visit). */
function restoredTurns(last: LastSession, user: string): Turn[] {
  return last.turns.map((t) => ({
    id: `r-${t.answer}`,
    question: t.question,
    user,
    startedAt: 0,
    status: "done",
    steps: [],
    verdicts: {},
    result: {
      ...t.result,
      answer: t.answer,
      session: last.session,
      question: t.question,
      tool_calls: [],
      asof: t.at,
      ms: 0,
    },
    restored: { at: t.at, status: t.status },
  }));
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState(DEFAULT_USER);
  const [people, setPeople] = useState<Person[]>([]);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [highlight, setHighlightState] = useState<Highlight | null>(null);
  const [blame, setBlame] = useState<BlameTarget | null>(null);
  const [unread, setUnread] = useState(0);
  const [llm, setLlm] = useState<boolean | null>(null);
  const [awake, setAwake] = useState(false);
  const [staleAnswers, setStaleAnswers] = useState<Set<string>>(() => new Set());
  const [ready, setReady] = useState(false);
  const [previous, setPrevious] = useState<LastSession | null>(null);
  // true until the last conversation has come back (or 600 ms have passed): the Ask screen shows its shape
  // instead of flashing the welcome screen first
  const [restoring, setRestoring] = useState(true);
  const session = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const idc = useRef(0);

  useEffect(() => {
    try {
      const u = localStorage.getItem("orion.user");
      if (u) {
        setApiUser(u); // requests from here on carry this persona's token
        setUserState(u);
      }
    } catch {
      /* ignore */
    }
    setReady(true);
    // a free-tier server sleeps when nobody uses it and takes about a minute to wake: keep knocking until it answers
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const knock = () =>
      get<{ llm?: boolean }>("/api/health")
        .then((h) => {
          if (stop) return;
          setLlm(h.llm !== false);
          setAwake(true);
        })
        .catch(() => {
          if (!stop) timer = setTimeout(knock, 4000);
        });
    knock();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  // the people list (and the company) once the server is up: asked for again if the first try hit a sleeping server
  useEffect(() => {
    if (!awake) return;
    get<Person[]>("/people").then(setPeople).catch(() => setPeople([]));
  }, [awake]);

  const refreshTenant = useCallback(() => {
    get<Tenant[]>("/api/tenants")
      .then((ts) => setTenant(ts.find((t) => t.id === "corvane") ?? ts[0] ?? null))
      .catch(() => setTenant(null));
  }, []);
  useEffect(() => {
    if (awake) refreshTenant();
  }, [awake, refreshTenant]);

  const setUser = useCallback((u: string) => {
    setApiUser(u);
    setUserState(u);
    session.current = null;
    try {
      localStorage.setItem("orion.user", u);
    } catch {
      /* ignore */
    }
  }, []);

  const personName = useCallback(
    (uid?: string | null) => (uid ? people.find((p) => p.uid === uid)?.name ?? uid.replace(/^person:/, "") : "someone"),
    [people],
  );

  const refreshInbox = useCallback(() => {
    get<Notification[]>(`/inbox?user=${encodeURIComponent(user)}`)
      .then((ns) => {
        setUnread(ns.filter((n) => !n.read).length);
        setStaleAnswers((prev) => {
          const next = new Set(ns.map((n) => n.answer_uid));
          return next.size === prev.size && [...next].every((a) => prev.has(a)) ? prev : next;
        });
      })
      .catch(() => {});
  }, [user]);
  useEffect(() => {
    refreshInbox();
    const t = setInterval(refreshInbox, 10000);
    return () => clearInterval(t);
  }, [refreshInbox]);

  const asking = turns.some((t) => t.status === "streaming");

  // Memory across visits: on load (and when the persona changes) the Brain picks up that person's last
  // conversation where it left off, answers and receipts included.
  useEffect(() => {
    if (!ready || !awake) return;
    let cancelled = false;
    setPrevious(null);
    setRestoring(true);
    const cap = setTimeout(() => setRestoring(false), 600);
    get<LastSession>(`/sessions/last?user=${encodeURIComponent(user)}`)
      .then((last) => {
        if (cancelled) return;
        setTurns((ts) => {
          // never replace a conversation in progress, or one this person is having right now
          if (ts.some((t) => t.status === "streaming" || (t.user === user && !t.restored))) return ts;
          if (!last.turns.length) return ts.filter((t) => t.user === user);
          session.current = last.session;
          return restoredTurns(last, user);
        });
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(cap);
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(cap);
    };
  }, [ready, awake, user]);

  const ask = useCallback(
    (question: string) => {
      const qn = question.trim();
      if (!qn || abort.current) return;
      const id = `t${Date.now()}`;
      const turn: Turn = {
        id,
        question: qn,
        user,
        startedAt: Date.now(),
        status: "streaming",
        steps: [],
        verdicts: {},
      };
      setTurns((ts) => [...ts, turn]);
      setHighlightState(null);
      const ctrl = new AbortController();
      abort.current = ctrl;
      const nextId = () => ++idc.current;
      const update = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));

      postStream(
        "/ask",
        { question: qn, user, session: session.current },
        ({ event, data }) => {
          if (event === "done") {
            const r = data.result as AskResult | null;
            if (r?.session) session.current = r.session;
          }
          update((t) => applyEvent(t, event, data, nextId));
        },
        ctrl.signal,
      )
        .catch((e: Error) => {
          const msg = e.name === "AbortError" ? "Stopped." : e.message || "Something went wrong.";
          update((t) => ({ ...t, status: "error", error: msg }));
        })
        .finally(() => {
          abort.current = null;
          update((t) => (t.status === "streaming" ? { ...t, status: t.answer ? "done" : "error", error: t.error ?? (t.answer ? undefined : "The connection dropped before the answer finished.") } : t));
          refreshInbox();
        });
    },
    [user, refreshInbox],
  );

  const stop = useCallback(() => abort.current?.abort(), []);
  const clearChat = useCallback(() => {
    abort.current?.abort();
    // keep what was on screen, so the empty Brain can offer to pick it up again
    setTurns((ts) => {
      const done = ts.filter((t) => t.result && !t.result.error);
      if (done.length)
        setPrevious({
          session: session.current,
          turns: done.map((t) => ({
            question: t.question,
            at: t.restored?.at ?? t.result!.asof,
            answer: t.result!.answer,
            status: t.restored?.status ?? "fresh",
            result: t.result!,
          })),
        });
      return [];
    });
    session.current = null;
    setHighlightState(null);
  }, []);
  const resume = useCallback(() => {
    if (!previous || abort.current) return;
    session.current = previous.session;
    setTurns(restoredTurns(previous, user));
    setPrevious(null);
  }, [previous, user]);

  const hoverHighlight = useCallback((key: string, nodes: string[], color: string) => {
    setHighlightState((p) => (p?.pinned ? p : { key, nodes, color, pinned: false }));
  }, []);
  const hoverEnd = useCallback(() => setHighlightState((p) => (p?.pinned ? p : null)), []);
  const pinHighlight = useCallback((key: string, nodes: string[], color: string) => {
    setHighlightState((p) => (p?.pinned && p.key === key ? null : { key, nodes, color, pinned: true }));
  }, []);
  const clearHighlight = useCallback(() => setHighlightState(null), []);
  const closeBlame = useCallback(() => setBlame(null), []);

  const value = useMemo<Ctx>(
    () => ({
      user,
      setUser,
      people,
      personName,
      tenant,
      refreshTenant,
      turns,
      asking,
      ask,
      stop,
      clearChat,
      previous,
      resume,
      highlight,
      hoverHighlight,
      hoverEnd,
      pinHighlight,
      clearHighlight,
      blame,
      openBlame: setBlame,
      closeBlame,
      unread,
      refreshInbox,
      llm,
      restoring,
      awake,
      staleAnswers,
    }),
    [user, setUser, people, personName, tenant, refreshTenant, turns, asking, ask, stop, clearChat, previous, resume, highlight, hoverHighlight, hoverEnd, pinHighlight, clearHighlight, blame, closeBlame, unread, refreshInbox, llm, restoring, awake, staleAnswers],
  );

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

