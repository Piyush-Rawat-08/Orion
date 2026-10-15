"use client";

// Start here: the three beats that show what Orion is for, in the order the demo video plays them. A step ticks
// itself off when the thing it asks for has happened (the what-if was opened, the answer went stale, the incident was
// replayed), not when its button was pressed. Progress is a per-browser convenience, so it lives in localStorage.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "./AppProvider";
import { EASE } from "./motion";

const KEY = "orion.start";
type Saved = { seen: string[]; open: boolean; gone: boolean };

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && Array.isArray(v.seen)) return { seen: v.seen, open: !!v.open, gone: !!v.gone };
  } catch {
    /* fresh */
  }
  return { seen: [], open: true, gone: false };
}

function save(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* not remembered */
  }
}

/** A ring that fills as steps are done. */
function Ring({ done, total }: { done: number; total: number }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="-rotate-90" aria-hidden>
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--color-rule-strong)" strokeWidth="2" />
      <motion.circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        stroke="var(--color-ember)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={c}
        initial={false}
        animate={{ strokeDashoffset: c * (1 - done / total) }}
        transition={{ duration: 0.7, ease: EASE }}
      />
    </svg>
  );
}

export default function StartHere() {
  const path = usePathname();
  const { turns, staleAnswers } = useApp();
  const reduce = useReducedMotion();
  const [s, setS] = useState<Saved | null>(null);
  useEffect(() => setS(load()), []);
  const update = useCallback(
    (fn: (x: Saved) => Saved) =>
      setS((x) => {
        const next = fn(x ?? load());
        save(next);
        return next;
      }),
    [],
  );

  // the what-if Priya's answer made, to open straight away
  const whatif = useMemo(() => {
    for (const t of turns)
      for (const e of t.result?.evidence ?? []) {
        const m = /^universe:[^:]+:(u\d+)$/.exec(e.graph);
        if (m) return m[1];
      }
    return null;
  }, [turns]);

  // a step is done when its screen was visited (or, for the second, when an answer actually went stale)
  useEffect(() => {
    const step = path.startsWith("/multiverse") ? "fork" : path.startsWith("/hindsight") ? "hindsight" : null;
    if (step) update((x) => (x.seen.includes(step) ? x : { ...x, seen: [...x.seen, step] }));
  }, [path, update]);
  useEffect(() => {
    if (staleAnswers.size) update((x) => (x.seen.includes("stale") ? x : { ...x, seen: [...x.seen, "stale"] }));
  }, [staleAnswers, update]);
  // "Start here" on the Ask screen opens it again, even after it was put away
  useEffect(() => {
    const open = () => update((x) => ({ ...x, open: true, gone: false }));
    window.addEventListener("orion:start", open);
    return () => window.removeEventListener("orion:start", open);
  }, [update]);

  if (!s || s.gone) return null;

  const steps = [
    {
      id: "fork",
      title: "Switch off sso-legacy, on a copy",
      body: "Priya's answer forked the company and switched sso-legacy off there. Open that copy, see what breaks, then press Find the safe path.",
      href: whatif ? `/multiverse?u=${whatif}` : "/multiverse",
      cta: "Open the what-if",
    },
    {
      id: "stale",
      title: "Watch the answer go stale",
      body: "Post Tomasz's message in #billing: BILL-207 is merged. Orion re-reads the graph and flags the part of Priya's answer it no longer supports.",
      href: "/inbox",
      cta: "Post the message",
    },
    {
      id: "hindsight",
      title: "Would Orion have caught INC-311?",
      body: "The outage replayed against what the records said on the day of the decision, and what was true.",
      href: "/hindsight?i=INC-311",
      cta: "Replay the outage",
    },
  ];
  const done = steps.filter((x) => s.seen.includes(x.id)).length;
  const next = steps.find((x) => !s.seen.includes(x.id));

  return (
    <div className="pointer-events-none fixed bottom-[calc(var(--tab-h)+env(safe-area-inset-bottom)+12px)] right-3 z-[80] sm:bottom-4 sm:right-4">
      <AnimatePresence mode="wait" initial={false}>
        {s.open ? (
          <motion.section
            key="open"
            aria-label="Start here"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.28, ease: EASE }}
            style={{ transformOrigin: "bottom right" }}
            className="pointer-events-auto w-[min(350px,calc(100vw-24px))] overflow-hidden rounded-xl border border-rule bg-panel/95 shadow-modal backdrop-blur-md"
          >
            <header className="flex items-center gap-2.5 border-b border-rule-soft px-3.5 py-2.5">
              <Ring done={done} total={steps.length} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold leading-tight text-ink">Start here</p>
                <p className="text-[11px] leading-tight text-faint">
                  {done === steps.length ? "All three done" : `${done} of ${steps.length} · about two minutes`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => update((x) => ({ ...x, open: false }))}
                className="grid size-7 place-items-center rounded text-faint transition-colors hover:bg-raised hover:text-ink"
                aria-label="Fold the walkthrough"
                title="Fold"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                  <path d="M3 7.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </header>
            <ol className="relative px-3.5 py-2">
              {steps.map((x, i) => {
                const ok = s.seen.includes(x.id);
                const current = x === next;
                return (
                  <li key={x.id} className="relative flex gap-3 py-2">
                    {i < steps.length - 1 && (
                      <span className="absolute left-[10.5px] top-[30px] h-[calc(100%-26px)] w-px bg-rule" aria-hidden>
                        <motion.span
                          className="absolute inset-x-0 top-0 block bg-ember"
                          initial={false}
                          animate={{ height: ok ? "100%" : "0%" }}
                          transition={{ duration: 0.5, ease: EASE }}
                        />
                      </span>
                    )}
                    <span
                      className={`relative z-[1] mt-[1px] grid size-[22px] shrink-0 place-items-center rounded-full text-[11px] font-semibold transition-colors duration-300 ${
                        ok ? "bg-ember text-night" : current ? "bg-ember/15 text-ember ring-1 ring-ember/50" : "bg-raised text-faint ring-1 ring-rule"
                      }`}
                    >
                      {ok ? (
                        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
                          <motion.path
                            d="M2.5 6.2 5 8.6l4.6-5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 0.35, ease: EASE }}
                          />
                        </svg>
                      ) : (
                        i + 1
                      )}
                      {current && !reduce && <span className="pulse-soft absolute inset-0 rounded-full" aria-hidden />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={`text-[13px] leading-snug ${ok ? "text-muted" : "text-ink"}`}>{x.title}</p>
                      <AnimatePresence initial={false}>
                        {current && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: EASE }}
                            className="overflow-hidden"
                          >
                            <p className="mt-1 text-[12px] leading-relaxed text-muted">{x.body}</p>
                            <Link href={x.href} className="btn btn-primary mt-2 h-7 rounded-lg px-3 text-[12px]">
                              {x.cta}
                            </Link>
                          </motion.div>
                        )}
                      </AnimatePresence>
                      {!current && !ok && (
                        <Link href={x.href} className="mt-0.5 inline-block text-[11px] text-faint underline-offset-2 hover:text-muted hover:underline">
                          Skip to this
                        </Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {done === steps.length && (
              <p className="border-t border-rule-soft px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">
                Then see how it holds up:{" "}
                <Link href="/proof" className="text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink">
                  Proof
                </Link>{" "}
                puts Orion against the same model reading the same records.{" "}
                <button type="button" className="text-faint underline-offset-2 hover:text-muted hover:underline" onClick={() => update((x) => ({ ...x, gone: true }))}>
                  Close
                </button>
              </p>
            )}
          </motion.section>
        ) : (
          <motion.button
            key="folded"
            type="button"
            onClick={() => update((x) => ({ ...x, open: true }))}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="pointer-events-auto flex h-9 items-center gap-2 rounded-full border border-rule bg-panel/95 pl-2 pr-3.5 text-[12px] text-ink shadow-float backdrop-blur-md transition-colors hover:border-rule-strong"
            aria-label={`Start here: ${done} of ${steps.length} done`}
          >
            <Ring done={done} total={steps.length} />
            Start here
            <span className="tnum text-faint">
              {done}/{steps.length}
            </span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
