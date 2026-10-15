"use client";

// Proof: Orion against the same model reading the same records. Every question has an answer the graph itself
// computes, so both can be graded the same way. Headline numbers race in, then the breakdown by kind of question,
// then every question with both answers side by side.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { CountUp, EASE, Rise } from "@/components/motion";
import { ErrorNote, Spinner } from "@/components/ui";
import { useFetch } from "@/lib/hooks";
import { fmtMs } from "@/lib/format";
import { C } from "@/lib/theme";

interface Graded {
  correct: boolean;
  precision: number;
  recall: number;
  made_up: string[];
  said: unknown;
  ms: number;
  answer: string;
  claims?: { text: string; verdict: string }[];
}
interface Row {
  kind: string;
  q: string;
  truth: string[] | string | number;
  orion: Graded;
  baseline: Graded;
}
interface Side {
  correct: number;
  total: number;
  accuracy: number;
  precision: number;
  recall: number;
  made_up_answers: number;
  made_up_names: number;
  median_ms: number;
}
interface Results {
  ran_at: string;
  model: { provider: string; smart: string };
  k_docs: number;
  questions: Row[];
  summary: { orion: Side; baseline: Side; by_kind: Record<string, { orion: Side; baseline: Side }> };
}

const KIND_WORD: Record<string, string> = {
  knows: "Who actually knows a system",
  depends: "What a system relies on, at any depth",
  breaks: "What breaks if a system is switched off",
  count: "How many would break",
  decided: "Whether a decision still holds",
};

export default function Proof() {
  const res = useFetch<Results>("/eval");
  const r = res.data;
  const reduce = useReducedMotion();
  if (res.error) return <div className="p-8"><ErrorNote error={res.error} onRetry={res.reload} /></div>;
  if (!r) return <p className="flex items-center gap-2 p-8 text-sm text-muted"><Spinner size={12} /> Loading the results</p>;
  const o = r.summary.orion,
    b = r.summary.baseline;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-6 py-8 lg:px-10">
        <Rise>
          <p className="text-[12px] text-muted">Proof · {r.questions.length} questions · run {r.ran_at.replace("T", " ")}</p>
          <h1 className="heading mt-2 text-[clamp(1.9rem,3.4vw,2.9rem)] leading-[1.02] tracking-[-0.025em]">Grounded, not guessed.</h1>
          <p className="mt-3 max-w-[66ch] text-[15px] leading-relaxed text-muted">
            The same questions, the same model ({r.model.smart}), the same company. One reads the {r.k_docs} records most relevant to
            each question, as a retrieval assistant would. The other is Orion, walking the graph. Every question has an answer the
            records settle, so both are graded the same way.
          </p>
        </Rise>

        {/* the headline */}
        <section className="mt-8 grid gap-4 md:grid-cols-2" aria-label="Correct answers">
          <Score name="Orion" sub="graph tools, typed claims, checked before shown" side={o} accent={C.ember} delay={0.1} />
          <Score name="The same model, reading the records" sub={`retrieval over every message, document, ticket and pull request (top ${r.k_docs})`} side={b} accent={C.muted} delay={0.25} />
        </section>

        <section className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Details">
          <Duel label="Names it got right (precision)" o={o.precision} b={b.precision} unit="%" />
          <Duel label="Of the right names, how many it found (recall)" o={o.recall} b={b.recall} unit="%" />
          <Duel label="Answers that named someone or something wrong" o={o.made_up_answers} b={b.made_up_answers} unit="" lowerIsBetter />
          <Duel label="Median time to answer" o={o.median_ms / 1000} b={b.median_ms / 1000} unit="s" lowerIsBetter decimals={1} />
        </section>

        {/* by kind */}
        <section className="mt-10" aria-label="By kind of question">
          <h2 className="pane-title mb-4">
            <span className="text-ink">By kind of question</span> <span className="text-faint">correct answers</span>
          </h2>
          <div className="space-y-3">
            {Object.entries(r.summary.by_kind).map(([k, v], i) => (
              <div key={k} className="grid items-center gap-x-4 gap-y-1 sm:grid-cols-[260px_minmax(0,1fr)]">
                <p className="text-[13px] text-ink">
                  {KIND_WORD[k] ?? k} <span className="mono text-[11px] text-faint">{v.orion.total}</span>
                </p>
                <div className="space-y-1">
                  <Bar value={v.orion.accuracy} color={C.ember} delay={0.1 + i * 0.08} label={`${v.orion.correct}/${v.orion.total}`} />
                  <Bar value={v.baseline.accuracy} color={C.muted} delay={0.15 + i * 0.08} label={`${v.baseline.correct}/${v.baseline.total}`} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 flex gap-4 text-[11px] text-faint">
            <span className="flex items-center gap-1.5"><span className="h-[3px] w-4 rounded-full bg-ember" /> Orion</span>
            <span className="flex items-center gap-1.5"><span className="h-[3px] w-4 rounded-full bg-muted" /> reading the records</span>
          </p>
        </section>

        {/* every question */}
        <section className="mt-10" aria-label="Every question">
          <h2 className="pane-title mb-3">
            <span className="text-ink">Every question</span> <span className="text-faint">open one to read both answers</span>
          </h2>
          <ul className="overflow-hidden rounded-xl border border-rule">
            {r.questions.map((q, i) => (
              <Question key={i} q={q} i={i} reduce={!!reduce} />
            ))}
          </ul>
        </section>

        <section className="mt-10 max-w-[70ch] text-[12px] leading-relaxed text-muted" aria-label="How it was measured">
          <h2 className="mb-2 text-[13px] font-medium text-ink">How it was measured</h2>
          The questions are generated from the graph of a fresh copy of the company: who has made or reviewed at least three
          changes to a system in 180 days, what a system relies on at any depth, what stops working if it is switched off and how
          many, and the status of decision records. An answer is correct when the names of the right kind it gives are exactly the
          right ones (people for &ldquo;who knows&rdquo;, systems for the others), or the number or status is right. Names in a
          sentence that rules them out (&ldquo;X has touched it but doesn&rsquo;t know it&rdquo;) don&rsquo;t count. Run it again with{" "}
          <span className="mono text-ink">uv run python -m orion.evals</span>.
        </section>
      </div>
    </div>
  );
}

function Score({ name, sub, side, accent, delay }: { name: string; sub: string; side: Side; accent: string; delay: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.35, ease: EASE }}
      className="relative overflow-hidden rounded-2xl border border-rule bg-panel p-6"
      style={{ borderColor: accent === C.ember ? `color-mix(in oklab, ${accent} 40%, var(--color-rule))` : undefined }}
    >
      <p className="text-[14px] font-medium text-ink">{name}</p>
      <p className="mt-0.5 text-[12px] text-muted">{sub}</p>
      <div className="mt-5 flex items-end gap-3">
        <span className="heading text-[84px] leading-[0.8] tracking-[-0.05em]" style={{ color: accent === C.ember ? accent : C.text }}>
          <CountUp value={side.accuracy} once={`proof:${name}`} duration={1.1} />
          <span className="text-[34px] tracking-[-0.02em]">%</span>
        </span>
        <span className="pb-1.5 text-[13px] text-muted">
          correct
          <br />
          <span className="mono text-ink">
            {side.correct}/{side.total}
          </span>
        </span>
      </div>
      <div className="mt-5 h-[6px] overflow-hidden rounded-full bg-rule-soft">
        <motion.div
          className="h-full rounded-full"
          style={{ background: accent, transformOrigin: "left" }}
          initial={reduce ? false : { scaleX: 0 }}
          animate={{ scaleX: side.accuracy / 100 }}
          transition={{ delay: delay + 0.2, duration: 1.1, ease: EASE }}
        />
      </div>
    </motion.div>
  );
}

function Duel({ label, o, b, unit, lowerIsBetter, decimals = 0 }: { label: string; o: number; b: number; unit: string; lowerIsBetter?: boolean; decimals?: number }) {
  const better = lowerIsBetter ? o <= b : o >= b;
  return (
    <div className="rounded-xl border border-rule bg-panel px-4 py-3.5">
      <p className="text-[12px] leading-snug text-muted">{label}</p>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="heading text-[28px] leading-none" style={{ color: better ? C.ember : C.text }}>
          <CountUp value={o} once={`duel:${label}:o`} decimals={decimals} duration={0.9} />
          <span className="text-[14px]">{unit}</span>
        </span>
        <span className="text-[12px] text-faint">vs</span>
        <span className="heading text-[20px] leading-none text-muted">
          <CountUp value={b} once={`duel:${label}:b`} decimals={decimals} duration={0.9} />
          <span className="text-[12px]">{unit}</span>
        </span>
      </div>
    </div>
  );
}

function Bar({ value, color, delay, label }: { value: number; color: string; delay: number; label: string }) {
  const reduce = useReducedMotion();
  return (
    <div className="flex items-center gap-3">
      <div className="h-[8px] min-w-0 flex-1 overflow-hidden rounded-full bg-rule-soft">
        <motion.div
          className="h-full rounded-full"
          style={{ background: color, transformOrigin: "left" }}
          initial={reduce ? false : { scaleX: 0 }}
          animate={{ scaleX: Math.max(0.005, value / 100) }}
          transition={{ delay, duration: 0.8, ease: EASE }}
        />
      </div>
      <span className="mono w-12 text-right text-[11px] text-muted">{label}</span>
    </div>
  );
}

function Mark({ ok }: { ok: boolean }) {
  return (
    <span className={`mono grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${ok ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad"}`} aria-label={ok ? "correct" : "wrong"}>
      {ok ? "✓" : "✕"}
    </span>
  );
}

function Question({ q, i, reduce }: { q: Row; i: number; reduce: boolean }) {
  const [open, setOpen] = useState(false);
  const truth = Array.isArray(q.truth) ? (q.truth.length ? q.truth.join(", ") : "nobody") : String(q.truth);
  return (
    <li className={i ? "border-t border-rule" : ""}>
      <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="flex gap-1.5">
          <Mark ok={q.orion.correct} />
          <Mark ok={q.baseline.correct} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{q.q}</span>
        <span className="hidden text-[11px] text-faint sm:inline">{q.kind}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="grid gap-3 px-4 pb-4 md:grid-cols-2">
              <p className="text-[12px] text-muted md:col-span-2">
                The records say: <span className="text-ink">{truth}</span>
              </p>
              <Answer who="Orion" g={q.orion} accent={C.ember} />
              <Answer who="Reading the records" g={q.baseline} accent={C.muted} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function Answer({ who, g, accent }: { who: string; g: Graded; accent: string }) {
  return (
    <div className="rounded-lg border border-rule bg-well p-3">
      <p className="flex items-center gap-2 text-[12px] font-medium" style={{ color: accent === C.ember ? accent : C.text }}>
        {who} <Mark ok={g.correct} /> <span className="ml-auto mono text-[11px] font-normal text-faint">{fmtMs(g.ms)}</span>
      </p>
      <p className="mt-2 whitespace-pre-line text-[12px] leading-relaxed text-ink">{g.answer.trim()}</p>
      {g.made_up.length > 0 && (
        <p className="mt-2 text-[11px] text-bad">
          Named wrongly: {g.made_up.join(", ")}
        </p>
      )}
    </div>
  );
}
