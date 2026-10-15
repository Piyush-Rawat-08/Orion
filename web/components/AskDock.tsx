"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { get, stream, StreamEvent } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Answer } from "@/lib/types";
import { AnswerCard } from "./ClaimView";
import { EASE, Spinner } from "./ui";

const EXAMPLES = [
  "If we retire sso-legacy next quarter, what breaks and who has to sign off?",
  "Who could take over the ledger if Ines is out?",
  "Why is sso-legacy still running?",
  "What is Helio Robotics waiting on?",
  "Which team actually runs alert-router?",
];

type Step = { id: string; name: string; args?: Record<string, unknown>; summary?: string; ms?: number; error?: string };

const SESSION = typeof window !== "undefined" ? `s-${Math.random().toString(36).slice(2, 8)}` : "s";

/** The Navigator, docked: ask in plain words, watch it walk the graph, read checked claims. */
export function AskDock({ onEvidence, onAnswer }: { onEvidence?: (uids: string[]) => void; onAnswer?: (a: Answer) => void }) {
  const { meta } = useSession();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [thinking, setThinking] = useState("");
  const [history, setHistory] = useState<Answer[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const abort = useRef<AbortController | null>(null);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setBusy(true);
    setErr(null);
    setSteps([]);
    setThinking("");
    setQ("");
    abort.current = new AbortController();
    const touched: string[] = [];
    try {
      await stream("ask", { question, session: SESSION }, (e: StreamEvent) => {
        if (e.type === "tool") setSteps((s) => [...s, { id: String(e.id), name: String(e.name), args: e.args as Record<string, unknown> }]);
        if (e.type === "tool_result") {
          touched.push(...((e.uids as string[]) ?? []));
          onEvidence?.([...touched]);
          setSteps((s) => s.map((x) => (x.id === e.id ? { ...x, summary: String(e.summary), ms: Number(e.ms) } : x)));
        }
        if (e.type === "tool_error") setSteps((s) => s.map((x) => (x.id === e.id ? { ...x, error: String(e.error) } : x)));
        if (e.type === "thinking") setThinking(String(e.text).slice(0, 400));
        if (e.type === "answer") {
          const a = e.answer as Answer;
          setHistory((h) => [a, ...h]);
          onAnswer?.(a);
          const ordered = [...new Set(a.claims.flatMap((c) => c.about))];
          onEvidence?.(ordered.length ? ordered : touched);
        }
      }, abort.current.signal);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function refresh(uid: string) {
    const a = await get<Answer>(`answers/${uid}`);
    setHistory((h) => h.map((x) => (x.uid === uid ? a : x)));
  }

  const llmOff = meta && !meta.llm.available;

  return (
    <motion.aside initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.8, ease: EASE, delay: 0.2 }}
                  className="panel pointer-events-auto flex max-h-[calc(100dvh-6.5rem)] w-full flex-col overflow-hidden rounded-xl md:w-[400px]">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center justify-between px-4 pb-2 pt-3 text-left">
        <div>
          <div className="display text-[20px] italic leading-none">Navigator</div>
          <div className="mono mt-1 text-[10px] text-faint">walks the graph · every claim is checked</div>
        </div>
        <span className="mono text-[10px] text-faint">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <>
          <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="px-4 pb-3">
            <div className="flex items-end gap-2 rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 focus-within:border-amber/50">
              <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={2} disabled={!!llmOff}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(q); } }}
                        placeholder={llmOff ? "No model key set: the graph tools still work" : "Ask how Corvane works, or what would break…"}
                        className="max-h-28 min-h-[2.5rem] flex-1 resize-none bg-transparent text-[13px] leading-snug text-ink outline-none placeholder:text-faint" />
              <button type="submit" disabled={busy || !q.trim()}
                      className="mono rounded-md bg-amber px-2.5 py-1 text-[11px] text-void transition-opacity disabled:opacity-30">
                ask
              </button>
            </div>
          </form>
          <div className="scroll-quiet flex-1 space-y-4 overflow-y-auto px-4 pb-4">
            {!history.length && !busy && (
              <div className="space-y-1.5">
                {EXAMPLES.map((x) => (
                  <button key={x} onClick={() => ask(x)} disabled={!!llmOff}
                          className="block w-full rounded-md border border-white/[0.05] px-3 py-2 text-left text-[12px] text-muted transition-colors hover:border-amber/30 hover:text-ink">
                    {x}
                  </button>
                ))}
              </div>
            )}
            <AnimatePresence>
              {busy && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-1.5">
                  <Spinner label={steps.length ? "walking the graph" : "planning"} />
                  {thinking && <p className="text-[11px] italic leading-snug text-faint">{thinking}</p>}
                  {steps.map((s) => (
                    <motion.div key={s.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, ease: EASE }}
                                className="mono flex gap-2 text-[11px]">
                      <span className="text-amber">{s.id}</span>
                      <span className="text-ink/80">{s.name}</span>
                      <span className="min-w-0 flex-1 truncate text-faint">{s.error ?? s.summary ?? JSON.stringify(s.args)}</span>
                      {s.ms !== undefined && <span className="text-faint">{s.ms}ms</span>}
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
            {err && <div className="text-[12px] text-nova">{err}</div>}
            {history.map((a, i) => (
              <motion.div key={a.uid} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}
                          className={`space-y-2 ${i ? "border-t border-white/[0.05] pt-4 opacity-80" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="text-[12px] text-faint">{a.question}</div>
                  {a.status === "changed" && (
                    <button onClick={() => refresh(a.uid)} className="mono shrink-0 text-[10px] text-degrade">changed · reload</button>
                  )}
                </div>
                <AnswerCard a={a} onFocus={onEvidence} />
                {i === 0 && a.meta.follow_ups?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {a.meta.follow_ups.map((f) => (
                      <button key={f} onClick={() => ask(f)} className="rounded-full border border-white/[0.08] px-2.5 py-1 text-[11px] text-muted hover:text-ink">
                        {f}
                      </button>
                    ))}
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        </>
      )}
    </motion.aside>
  );
}
