"use client";

// Hindsight: would Orion have caught it? Pick an incident; Orion finds the decision that led to it and replays it
// on the company as it stood that day, twice: with what had been written down (what anyone could have seen) and
// with what was actually true. The gap is the blind spot, shown with the record that finally wrote it down. Then
// the safe path Orion would have recommended on that day, and how long the real fix took.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import SafePath, { type PlanResult } from "@/components/multiverse/SafePath";
import IncidentTrack from "@/components/hindsight/IncidentTrack";
import { useApp } from "@/components/AppProvider";
import { CountUp, EASE, Rise } from "@/components/motion";
import { Empty, ErrorNote, Spinner } from "@/components/ui";
import { useFetch } from "@/lib/hooks";
import { fmtDate, plural } from "@/lib/format";
import { postStream } from "@/lib/sse";
import { C, riskColor } from "@/lib/theme";

interface Incident {
  uid: string;
  key: string;
  title: string;
  at: string;
  priority: string;
  names: string[];
  decision: { key: string; title: string; at: string } | null;
  replayable: boolean;
  lead_days: number | null;
}

interface Side {
  risk: number;
  level: string;
  broken: { service: string; hops: number; effect: string; tier: number }[];
  customers: string[];
  orphans: string[];
}

interface Fact {
  fact: string;
  source: string;
  target: string;
  true_since: string;
  recorded_at: string;
  recorded_in: string | null;
  recorded_by: string | null;
  quote: string | null;
  unwritten_days: number;
  after_incident_days: number;
}

interface Replay {
  incident: Incident;
  decision: { key: string; title: string; at: string };
  day: string;
  known: Side;
  true: Side;
  blind_spot: Fact[];
  safe_path: PlanResult;
  fix: { label: string } | null;
  fix_landed: { at: string } | null;
  fix_days_after: number | null;
  fix_waiting: { key: string; title: string; status: string; opened: string } | null;
  timeline: { at: string; kind: string; label: string }[];
}

const level = (r: number) => (r >= 40 ? "high" : r > 0 ? "medium" : "low");
const days = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000);

function Hindsight() {
  const params = useSearchParams();
  const router = useRouter();
  const list = useFetch<Incident[]>("/incidents");
  const first = list.data?.find((i) => i.replayable)?.key ?? list.data?.[0]?.key ?? null;
  const key = params.get("i") ?? first;
  const inc = list.data?.find((i) => i.key === key) ?? null;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-b border-rule px-4 py-5 lg:border-b-0 lg:border-r" aria-label="Incidents">
        <h2 className="pane-title mb-3">
          <span className="text-ink">Incidents</span> <span className="text-faint">newest first</span>
        </h2>
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        <ul className="space-y-2">
          {list.data?.map((i) => {
            const on = i.key === key;
            return (
              <li key={i.key}>
                <button
                  type="button"
                  onClick={() => router.replace(`/hindsight?i=${i.key}`, { scroll: false })}
                  className={`w-full rounded-xl border px-3.5 py-3 text-left transition-colors ${on ? "border-rule-strong bg-raised" : "border-rule bg-panel hover:border-rule-strong"}`}
                  aria-pressed={on}
                >
                  <div className="flex items-center gap-2">
                    <span className="mono text-[12px] font-semibold text-bad">{i.key}</span>
                    <span className="mono rounded border border-rule px-1 text-[10px] text-muted">{i.priority}</span>
                    <span className="ml-auto text-[11px] text-faint">{fmtDate(i.at)}</span>
                  </div>
                  <p className="mt-1 text-[13px] leading-snug text-ink">{i.title}</p>
                  <p className="mt-1.5 text-[11px] text-muted">
                    {i.replayable ? (
                      <>
                        <span className="text-ember">●</span> after {i.decision!.key}, {i.lead_days} days earlier
                      </>
                    ) : (
                      "no decision before it switched anything off"
                    )}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="min-h-0 overflow-y-auto" aria-label="The replay">
        {list.data && !inc && <div className="p-8"><Empty title="No incidents on record.">Incidents appear here once a ticket of kind incident exists.</Empty></div>}
        {inc && <ReplayView key={inc.key} inc={inc} />}
      </section>
    </div>
  );
}

function ReplayView({ inc }: { inc: Incident }) {
  const reduce = useReducedMotion();
  const { tenant } = useApp();
  const [status, setStatus] = useState<string>("");
  const [known, setKnown] = useState<Side | null>(null);
  const [truth, setTruth] = useState<Side | null>(null);
  const [spot, setSpot] = useState<Fact[] | null>(null);
  const [explored, setExplored] = useState(0);
  const [r, setR] = useState<Replay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!inc.replayable) return;
    const ac = new AbortController();
    postStream(
      `/incidents/${inc.key}/replay`,
      {},
      (e) => {
        const d = e.data as Record<string, unknown>;
        if (e.event === "status") setStatus(String(d.text ?? ""));
        else if (e.event === "known") setKnown(d as unknown as Side);
        else if (e.event === "true") setTruth(d as unknown as Side);
        else if (e.event === "blind_spot") setSpot(d.facts as Fact[]);
        else if (e.event === "universe") setExplored((n) => n + 1);
        else if (e.event === "done" && d.result) {
          const res = d.result as Replay;
          setR(res);
          setKnown(res.known);
          setTruth(res.true);
          setSpot(res.blind_spot);
        } else if (e.event === "error") setError(String(d.text ?? "The replay failed"));
      },
      ac.signal,
    ).catch((err) => (err as Error).name !== "AbortError" && setError((err as Error).message));
    return () => ac.abort();
  }, [inc]);

  const d = inc.decision;
  const hidden = known && truth ? truth.risk - known.risk : 0;

  return (
    <div className="mx-auto max-w-[1080px] px-6 py-8 lg:px-10">
      <Rise>
        <p className="text-[12px] text-muted">
          Hindsight · {inc.key} · {fmtDate(inc.at)}
        </p>
        <h1 className="heading mt-2 text-[clamp(1.9rem,3.4vw,2.9rem)] leading-[1.02] tracking-[-0.025em]">
          Would Orion have caught {inc.key}?
        </h1>
        <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-muted">
          {inc.title}.{" "}
          {d ? (
            <>
              {inc.lead_days} days earlier, <span className="text-ink">{d.key}</span> was approved: &ldquo;{d.title}&rdquo;. Orion
              rebuilds the company as it stood that day and tests the decision twice: on what had been written down, and on what
              was actually true.
            </>
          ) : (
            "No decision before it switched anything off, so there is no change to replay."
          )}
        </p>
      </Rise>

      {d && r && <IncidentTrack r={r} today={tenant?.clock} />}
      {d && !r && !error && (
        <p className="mt-8 flex items-center gap-2 text-[13px] text-muted" aria-live="polite">
          <Spinner size={12} /> {status || "Rebuilding the past"}
          {explored > 0 && <span className="mono text-faint">· {explored} companies explored</span>}
        </p>
      )}
      {error && <div className="mt-6"><ErrorNote error={error} /></div>}

      {d && (known || truth) && (
        <div className="mt-8 grid items-stretch gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <SidePanel
            side={known}
            title={`What the records said on ${fmtDate(d.at)}`}
            note="A what-if run that day, on everything written down by then."
            delay={0}
          />
          <div className="flex items-center justify-center md:flex-col" aria-hidden={!truth}>
            <AnimatePresence>
              {known && truth && (
                <motion.div
                  initial={reduce ? false : { opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.5, duration: 0.4, ease: EASE }}
                  className="rounded-full border border-bad/40 bg-bad/10 px-3 py-1.5 text-center"
                >
                  <p className="mono text-[18px] font-semibold leading-none text-bad">+{hidden}</p>
                  <p className="mt-0.5 text-[10px] leading-tight text-bad/80">risk nobody
                    <br />
                    could see</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <SidePanel side={truth} title="What was actually true" note="The same change on that day, with everything recorded since about what was true then." delay={0.25} danger />
        </div>
      )}

      {spot && spot.length > 0 && <BlindSpot facts={spot} />}

      {r && (
        <Rise delay={0.1}>
          <section className="mt-10 rounded-2xl border border-rule bg-panel p-6" aria-label="What Orion would have recommended">
            <p className="text-[12px] text-ember">What Orion would have said on {fmtDate(r.day)}</p>
            <h2 className="heading mt-1.5 text-[24px] leading-tight">
              {r.safe_path.best.risk === 0 ? "Don't switch it off yet. Do this first, and nothing breaks." : `The safest order found brings the risk to ${r.safe_path.best.risk}.`}
            </h2>
            <p className="mt-1.5 text-[13px] text-muted">
              Found by exploring {plural(r.safe_path.explored, "parallel copy", "parallel copies")} of the company as it was that day.
            </p>
            <ol className="mt-5 grid gap-2 md:grid-cols-3">
              {r.safe_path.steps.map((s, i) => (
                <motion.li
                  key={i}
                  initial={reduce ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 + i * 0.15, duration: 0.3, ease: EASE }}
                  className={`rounded-xl border px-4 py-3 ${i === 0 && r.fix ? "border-ember/60 bg-ember/[0.06]" : "border-rule bg-well"}`}
                >
                  <p className="mono text-[11px] text-faint">step {i + 1}</p>
                  <p className="mt-1 text-[14px] font-medium leading-snug text-ink">{s.label}</p>
                  <p className="mt-0.5 text-[12px] leading-snug text-muted">{s.why}</p>
                </motion.li>
              ))}
            </ol>
            {r.fix && (
              <p className="mt-5 text-[14px] leading-relaxed text-ink">
                Step 1 is the fix the company eventually made.{" "}
                {r.fix_landed ? (
                  <>It landed <span className="text-ember">{r.fix_days_after} days</span> after {r.decision.key}.</>
                ) : r.fix_waiting ? (
                  <>
                    It is <span className="mono">{r.fix_waiting.key}</span> ({r.fix_waiting.title}), opened {fmtDate(r.fix_waiting.opened)}, a week
                    after the outage, and <span className="text-ember">still {r.fix_waiting.status}</span>{" "}
                    {days(r.decision.at, new Date().toISOString())} days after the decision.
                  </>
                ) : null}
              </p>
            )}
            <button type="button" className="btn mt-5" onClick={() => setOpen(true)}>
              Watch the search on {fmtDate(r.day)}
            </button>
          </section>
        </Rise>
      )}
      <AnimatePresence>
        {open && r && (
          <SafePath
            ops={r.decision ? [{ op: "deprecate_service", service: r.safe_path.goal.replace(/^Switch off /, "") }] : []}
            title={r.safe_path.goal}
            asof={r.day}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function SidePanel({ side, title, note, delay, danger }: { side: Side | null; title: string; note: string; delay: number; danger?: boolean }) {
  const reduce = useReducedMotion();
  const c = side ? riskColor(level(side.risk)) : C.faint;
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: side ? 1 : 0.35, y: 0 }}
      transition={{ delay, duration: 0.35, ease: EASE }}
      className="relative overflow-hidden rounded-2xl border border-rule bg-panel p-5"
      style={{ borderColor: side && danger ? `color-mix(in oklab, ${c} 45%, var(--color-rule))` : undefined, boxShadow: side && danger ? `0 30px 80px -50px ${c}` : undefined }}
    >
      <p className="text-[12px] text-muted">{title}</p>
      <div className="mt-3 flex items-end gap-3">
        <span className="heading text-[64px] leading-[0.82] tracking-[-0.04em]" style={{ color: c }}>
          {side ? <CountUp value={side.risk} once={`hs:${title}:${side.risk}`} duration={0.9} /> : "–"}
        </span>
        {side && (
          <span className="pb-1 text-[13px]" style={{ color: c }}>
            {level(side.risk)} risk
          </span>
        )}
      </div>
      <p className="mt-2 text-[12px] text-faint">{note}</p>
      {side && (
        <ul className="mt-4 space-y-1.5">
          {side.broken.length === 0 && <li className="text-[13px] text-muted">Nothing stops working.</li>}
          {side.broken.map((b, i) => (
            <motion.li
              key={b.service}
              initial={reduce ? false : { opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: delay + 0.3 + i * 0.08 }}
              className="flex items-center gap-2 text-[13px]"
            >
              <span className="size-[7px] shrink-0 rounded-full" style={{ background: b.effect === "break" ? C.bad : C.partial }} />
              <span className="text-ink">{b.service}</span>
              <span className="text-faint">{b.effect === "break" ? "stops working" : "slows down"}</span>
            </motion.li>
          ))}
          {side.customers.length > 0 && (
            <li className="pt-1 text-[12px] text-muted">
              {plural(side.customers.length, "customer")} would notice
            </li>
          )}
        </ul>
      )}
    </motion.div>
  );
}

function BlindSpot({ facts }: { facts: Fact[] }) {
  const reduce = useReducedMotion();
  const f = facts[0];
  return (
    <Rise delay={0.15}>
      <section className="mt-10" aria-label="The blind spot">
        <p className="text-[12px] text-warn">The blind spot</p>
        <h2 className="heading mt-1.5 text-[26px] leading-tight">
          {facts.length === 1 ? "One dependency nobody had written down." : `${facts.length} facts nobody had written down.`}
        </h2>
        <div className="mt-5 rounded-2xl border border-warn/30 bg-panel p-6">
          <div className="flex flex-wrap items-center gap-3">
            <Pill name={f.source} />
            <svg width="190" height="26" viewBox="0 0 190 26" aria-hidden className="shrink-0">
              <motion.path
                d="M4 13 H178"
                stroke={C.undeclared}
                strokeWidth="2"
                strokeDasharray="6 5"
                fill="none"
                initial={reduce ? false : { pathLength: 0 }}
                animate={{ pathLength: 1, strokeDashoffset: reduce ? 0 : [0, -22] }}
                transition={{ pathLength: { duration: 0.8, ease: EASE }, strokeDashoffset: { duration: 1.2, repeat: Infinity, ease: "linear" } }}
              />
              <path d="M178 8l8 5-8 5z" fill={C.undeclared} />
              <text x="95" y="8" textAnchor="middle" className="text-[10px]" fill={C.undeclared}>
                relies on
              </text>
            </svg>
            <Pill name={f.target} />
          </div>
          <dl className="mt-6 grid gap-4 sm:grid-cols-3">
            <Big n={f.unwritten_days} unit="days" label={`true since ${fmtDate(f.true_since)}, in no catalog`} />
            <Big n={f.after_incident_days} unit="days" label="after the outage, it was finally written down" />
            <Big n={facts.length} unit={facts.length === 1 ? "fact" : "facts"} label="missing from the records on the day of the decision" />
          </dl>
          {f.quote && (
            <blockquote className="mt-6 border-l-2 border-warn/60 pl-4 text-[14px] leading-relaxed text-ink">
              &ldquo;{f.quote}&rdquo;
              <footer className="mt-1.5 text-[12px] text-muted">
                {f.recorded_by ?? "Someone"} in {f.recorded_in ?? "a record"}, {fmtDate(f.recorded_at)}
              </footer>
            </blockquote>
          )}
        </div>
      </section>
    </Rise>
  );
}

function Pill({ name }: { name: string }) {
  return <span className="mono rounded-lg border border-rule-strong bg-raised px-3 py-1.5 text-[14px] text-ink">{name}</span>;
}

function Big({ n, unit, label }: { n: number; unit: string; label: string }) {
  return (
    <div>
      <dt className="heading text-[36px] leading-none tracking-[-0.03em] text-ink">
        <CountUp value={n} once={`hsbig:${label}:${n}`} duration={0.9} />
        <span className="ml-1.5 text-[14px] font-normal text-muted">{unit}</span>
      </dt>
      <dd className="mt-1.5 text-[12px] leading-snug text-muted">{label}</dd>
    </div>
  );
}

export default function HindsightPage() {
  return (
    <Suspense>
      <Hindsight />
    </Suspense>
  );
}
