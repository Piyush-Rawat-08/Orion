"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { STATUS_COLOR } from "@/lib/palette";
import type { Answer, Claim, Evidence } from "@/lib/types";
import { EASE, StatusMark } from "./ui";

/** One sentence of an answer with its verdict; opens to show what the graph returned and the Cypher behind it. */
export function ClaimRow({ c, evidence, onFocus }: { c: Claim; evidence: Evidence[]; onFocus?: (uids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const cited = (c.claim.evidence as string[] | undefined) ?? [];
  const ev = evidence.filter((e) => cited.includes(e.id));
  const last = c.history.at(-1);
  return (
    <div className="group border-l pl-3 transition-colors" style={{ borderColor: `${STATUS_COLOR[c.status]}66` }}>
      <button className="w-full text-left" onClick={() => { setOpen((o) => !o); onFocus?.(c.about); }}>
        <div className="flex items-start gap-2">
          <p className={`flex-1 text-[13px] leading-snug ${c.status === "outdated" || c.status === "contradicted" ? "text-ink/55 line-through decoration-nova/60" : "text-ink/90"}`}>
            {c.sentence}
          </p>
          <StatusMark status={c.status} compact />
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <StatusMark status={c.status} />
          <span className="mono text-[10px] text-faint">{c.type}</span>
          {last && <span className="mono text-[10px] text-degrade">changed {last.at.replace("T", " ")}</span>}
        </div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: EASE }} className="overflow-hidden">
            <div className="space-y-2 pb-1 pt-2 text-[12px] text-muted">
              {c.result.why && <div>{c.result.why}</div>}
              {Array.isArray(c.result.expected) && (
                <div><span className="text-faint">The graph says: </span>{(c.result.expected as string[]).join(", ") || "nothing"}</div>
              )}
              {typeof c.result.expected === "number" || typeof c.result.expected === "string" ? (
                <div><span className="text-faint">The graph says: </span>{String(c.result.expected)}</div>
              ) : null}
              {last && (
                <div className="rounded border border-degrade/25 bg-degrade/5 px-2 py-1.5 text-[11px]">
                  Was <b className="text-ink/80">{fmt(last.before.expected)}</b>, now <b className="text-ink/80">{fmt(last.after.expected)}</b>
                  <div className="mono mt-0.5 text-[10px] text-faint">because of {last.cause}</div>
                </div>
              )}
              {ev.map((e) => (
                <div key={e.id} className="rounded border border-white/[0.06] bg-black/30 p-2">
                  <div className="mono flex justify-between text-[10px] text-faint"><span>{e.id} · {e.tool}</span><span>{e.queries[0]?.graph}</span></div>
                  <div className="mt-1 text-[11px] text-ink/70">{e.summary}</div>
                  {e.queries.slice(0, 2).map((q, i) => (
                    <pre key={i} className="mono scroll-quiet mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-[#9fb7ff]">{q.cypher}</pre>
                  ))}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function fmt(v: unknown) {
  if (Array.isArray(v)) return v.join(", ") || "nothing";
  return v === undefined || v === null ? "—" : String(v);
}

export function AnswerCard({ a, onFocus, compact = false }: { a: Answer; onFocus?: (uids: string[]) => void; compact?: boolean }) {
  const counts = a.claims.reduce<Record<string, number>>((m, c) => ((m[c.status] = (m[c.status] ?? 0) + 1), m), {});
  return (
    <div className="space-y-3">
      {!compact && <p className="text-[14px] leading-relaxed text-ink/90">{a.text}</p>}
      <div className="mono flex flex-wrap gap-3 text-[10px] text-faint">
        {Object.entries(counts).map(([s, n]) => (
          <span key={s} style={{ color: STATUS_COLOR[s] }}>{n} {s}</span>
        ))}
        <span>{a.meta.steps} steps · {(a.meta.ms / 1000).toFixed(1)}s · {a.meta.usage.input + a.meta.usage.output} tokens</span>
      </div>
      <div className="space-y-2.5">
        {a.claims.map((c) => <ClaimRow key={c.uid} c={c} evidence={a.evidence} onFocus={onFocus} />)}
      </div>
    </div>
  );
}
