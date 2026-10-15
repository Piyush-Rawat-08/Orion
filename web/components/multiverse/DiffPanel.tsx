"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { DeltaBar } from "../ui";
import { useApp } from "../AppProvider";
import { CountUp, useFirstTime } from "../motion";
import BlastRadius from "./BlastRadius";
import { useFetch } from "@/lib/hooks";
import { C, riskColor } from "@/lib/theme";
import type { Diff, RiskTerm } from "@/lib/types";
import { factWords, hopsWord, plainWhy, tierWord } from "@/lib/words";

const TERM_LABEL: Record<RiskTerm["kind"], string> = {
  break: "stops",
  customer: "customer",
  orphan: "no expert",
  stranded: "no owner",
  split: "team splits",
  bottleneck: "key people",
};

const EFFECT_TEXT = { break: "stops working", degrade: "slows down", stale: "gets out-of-date data" } as const;

const short = (uid: string) => uid.replace(/^(svc|person|team|customer):/, "");

function Section({ title, count, children, tone }: { title: string; count?: number; children: React.ReactNode; tone?: string }) {
  return (
    <section className="min-w-0">
      <h3 className="pane-title mb-3">
        <span className="flex items-center gap-2 text-ink">
          {tone && <span className="size-[7px] shrink-0 rounded-full" style={{ background: tone }} aria-hidden />}
          {title}
          {count !== undefined && <span className="mono text-[11px] font-normal text-faint">{count}</span>}
        </span>
      </h3>
      {children}
    </section>
  );
}

export function RiskBlock({ diff }: { diff: Diff }) {
  const c = riskColor(diff.risk.level);
  const first = useFirstTime(`risk:${diff.universe}`);
  return (
    <Section title="Risk">
      <div className="flex items-end gap-4">
        <span className="heading text-[56px] leading-[0.8] tracking-[-0.03em]" style={{ color: c }}>
          <CountUp value={diff.risk.score} once={`risk:${diff.universe}`} />
        </span>
        <div className="pb-0.5">
          <p className="text-[13px] font-medium" style={{ color: c }}>
            {diff.risk.level.charAt(0).toUpperCase() + diff.risk.level.slice(1)} risk <span className="font-normal text-muted">out of 100</span>
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {diff.required_approvers?.length
              ? `${diff.required_approvers.length} team${diff.required_approvers.length === 1 ? " has" : "s have"} to agree`
              : diff.risk.auto_approve
                ? "Low enough to go ahead without sign-off"
                : "Needs someone to sign off"}
          </p>
        </div>
      </div>
      <div className="relative mt-4 h-[3px] w-full overflow-hidden rounded-full bg-rule-soft" aria-hidden>
        <motion.div
          className="absolute inset-y-0 left-0 w-full origin-left rounded-full"
          style={{ background: c }}
          initial={{ scaleX: first ? 0 : diff.risk.score / 100 }}
          animate={{ scaleX: diff.risk.score / 100 }}
          transition={{ duration: 0.4, ease: [0.25, 1, 0.5, 1] }}
        />
        {[40].map((t) => (
          <span key={t} className="absolute inset-y-0 w-px bg-night" style={{ left: `${t}%` }} />
        ))}
      </div>
      {diff.risk.terms && diff.risk.terms.length > 0 ? (
        <>
          <p className="mt-4 text-[11px] text-faint">Where the points come from</p>
          <ul className="mt-1.5 space-y-1.5 text-[12px] leading-snug" aria-label="Where the risk score comes from">
            {diff.risk.terms.map((t, i) => (
              <motion.li
                key={`${t.kind}:${t.subject}`}
                className="grid grid-cols-[4.6rem_1fr_auto] items-baseline gap-2"
                initial={first ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2, delay: Math.min(i, 6) * 0.03 }}
                title={t.why}
              >
                <span className="text-[11px] text-muted">{TERM_LABEL[t.kind]}</span>
                <span className="min-w-0">
                  <span className="text-ink">{t.subject}</span>
                  <span className="block truncate text-[11px] text-muted">{plainWhy(t.why)}</span>
                </span>
                <span className="mono text-right text-[12px]" style={{ color: c }}>
                  +{t.points % 1 ? t.points.toFixed(1) : t.points}
                </span>
              </motion.li>
            ))}
          </ul>
          <p className="mt-3 border-t border-rule-soft pt-2 text-[11px] text-faint">
            Total {diff.risk.uncapped ?? diff.risk.score}
            {diff.risk.uncapped && diff.risk.uncapped > 100 ? ", capped at 100" : ""}. Business-critical systems count most.
          </p>
        </>
      ) : diff.risk.reasons.length > 0 ? (
        <ul className="mt-4 space-y-1.5 text-[12px] leading-snug text-muted">
          {diff.risk.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-xs text-muted">Nothing breaks, nothing is left without someone who knows it, and the key people stay the same.</p>
      )}
    </Section>
  );
}

/** steps from what was switched off, drawn as a little chain */
function Hops({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center" aria-label={hopsWord(n)} title={`Affected ${hopsWord(n)}`}>
      {Array.from({ length: n + 1 }, (_, i) => (
        <span key={i} className="inline-flex items-center">
          {i > 0 && <span className="h-px w-2.5 bg-bad/50" />}
          <span className={`size-[5px] rounded-full ${i === n ? "bg-bad" : "border border-bad/60"}`} />
        </span>
      ))}
    </span>
  );
}

/** "2 stop working · 3 slow down": the split, not one count under the harshest heading. */
function affectedTitle(broken: { effect?: string }[]) {
  if (!broken.length) return "What would stop working";
  const n = (e: string) => broken.filter((b) => (b.effect ?? "break") === e).length;
  const parts = [
    n("break") && `${n("break")} would stop working`,
    n("degrade") && `${n("degrade")} would slow down`,
    n("stale") && `${n("stale")} would go stale`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function BrokenBlock({ diff }: { diff: Diff }) {
  const { openBlame } = useApp();
  return (
    <Section title={affectedTitle(diff.broken)} tone={C.bad}>
      {diff.broken.length === 0 ? (
        <p className="text-xs text-muted">Nothing relies on what this change switches off.</p>
      ) : (
        <ol className="space-y-3">
          {diff.broken.map((b, i) => (
            <motion.li
              key={b.uid}
              className="text-xs"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2, delay: Math.min(i, 6) * 0.03 }}
            >
              <p className="flex flex-wrap items-center gap-x-2.5">
                <Hops n={b.hops} />
                <span className="text-[13px] font-medium text-ink">{b.service}</span>
                <span className="text-[11px]" style={{ color: b.effect === "break" || !b.effect ? C.bad : C.partial }}>
                  {EFFECT_TEXT[b.effect ?? "break"]}
                </span>
                <span className="text-[11px] text-faint">
                  {tierWord(b.tier)} · {hopsWord(b.hops)}
                </span>
              </p>
              {b.path && b.path.length > 2 && (
                <p className="mt-0.5 truncate pl-[2px] text-[11px] text-faint" title={b.path.map(short).join(", which relies on ")}>
                  {b.path.map(short).reverse().join(" → ")}
                </p>
              )}
              <p className="mt-1 pl-[2px] text-muted">
                Team responsible: {b.owners.join(", ") || "none"} · Recent work on it: {b.people_who_know_it.slice(0, 4).join(", ") || "nobody"}
              </p>
              {b.via_undeclared.length > 0 && (
                <p className="mt-0.5 text-warn">
                  Only through a connection nobody wrote down:{" "}
                  {b.via_undeclared.map((f) => (
                    <button
                      key={f}
                      type="button"
                      className="underline decoration-dotted underline-offset-2 hover:text-ink"
                      onClick={() => openBlame({ fact: f })}
                      title="See where Orion found it"
                    >
                      {factWords(f)}
                    </button>
                  ))}
                </p>
              )}
            </motion.li>
          ))}
        </ol>
      )}
    </Section>
  );
}

interface Tell {
  title: string;
  customers: {
    uid: string;
    customer: string;
    tier: string;
    services: string[];
    open_tickets: { key: string; title: string; status: string; priority: string; related: boolean }[];
    contact: { name: string; team: string | null; n: number } | null;
  }[];
  teams: { team: string; because: string[] }[];
}

/** Who to tell: an owner's next step. Every customer who would notice, their open tickets, and the person who
 *  has dealt with them most; plus "Copy the list" for an email or a message. */
export function CustomersBlock({ diff }: { diff: Diff }) {
  const cs = diff.customers ?? [];
  const tell = useFetch<Tell>(cs.length ? `/universes/${diff.universe}/who-to-tell` : null);
  const [copied, setCopied] = useState(false);
  const byUid = new Map((tell.data?.customers ?? []).map((c) => [c.uid, c]));
  const copy = async () => {
    const t = tell.data;
    if (!t) return;
    const lines = [`If we go ahead with "${t.title}", tell:`, ""];
    for (const c of t.customers) {
      lines.push(`${c.customer} (${c.tier}): uses ${c.services.join(", ")}`);
      if (c.contact) lines.push(`  who to call: ${c.contact.name}${c.contact.team ? `, ${c.contact.team}` : ""}`);
      for (const k of c.open_tickets) lines.push(`  open: ${k.key} ${k.title} (${k.status})`);
    }
    if (t.teams.length) lines.push("", `Teams to bring in: ${t.teams.map((x) => x.team).join(", ")}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <Section title="Who to tell" count={cs.length} tone={cs.length ? C.partial : undefined}>
      {cs.length === 0 ? (
        <p className="text-xs text-muted">No customer uses, or has reported problems with, anything that breaks.</p>
      ) : (
        <>
          <ul className="space-y-2.5 text-xs">
            {cs.map((c) => {
              const t = byUid.get(c.uid);
              return (
                <li key={c.uid}>
                  <p>
                    <span className="text-[13px] font-medium text-ink">{c.customer}</span>{" "}
                    <span className="text-[11px] text-muted">{c.tier}</span>
                  </p>
                  <p className="mt-0.5 text-muted">
                    {c.tickets.length > 0 && <>reported problems ({c.tickets.slice(0, 3).join(", ")}) with </>}
                    {c.tickets.length === 0 && "uses "}
                    {c.services.slice(0, 3).join(", ")}
                  </p>
                  {t?.contact && (
                    <p className="mt-0.5 text-muted">
                      Who to call: <span className="text-ink">{t.contact.name}</span>
                      {t.contact.team ? `, ${t.contact.team}` : ""}
                    </p>
                  )}
                  {t && t.open_tickets.length > 0 && (
                    <p className="mt-0.5 text-muted">
                      Open: {t.open_tickets.map((k) => (
                        <span key={k.key} className={`mr-1.5 ${k.related ? "text-warn" : ""}`} title={k.title}>
                          {k.key}
                        </span>
                      ))}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <button type="button" className="btn btn-ghost mt-3 h-7 px-2 text-[12px]" onClick={copy} disabled={!tell.data} aria-live="polite">
            {copied ? "Copied" : "Copy the list"}
          </button>
        </>
      )}
    </Section>
  );
}

/** Who has to approve, from the graph: the owners of what breaks and of what the change touches. */
export function ApproversBlock({ diff, approvedBy }: { diff: Diff; approvedBy?: Record<string, string[]> }) {
  const { personName } = useApp();
  const req = diff.required_approvers ?? [];
  return (
    <Section title="Who has to agree" count={req.length}>
      {req.length === 0 ? (
        <p className="text-xs text-muted">No team is responsible for anything this changes or breaks, so one approval is enough.</p>
      ) : (
        <ul className="space-y-2 text-xs">
          {req.map((r) => {
            const by = approvedBy?.[r.team_uid] ?? r.approved_by ?? [];
            return (
              <li key={r.team_uid} className="flex gap-2.5">
                <span
                  className={`mt-[3px] grid size-[14px] shrink-0 place-items-center rounded-full border ${by.length ? "border-ok bg-ok/15 text-ok" : "border-rule-strong text-transparent"}`}
                  aria-label={by.length ? "approved" : "waiting"}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden><path d="M1.5 4.2l1.6 1.6 3.4-3.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
                <span className="min-w-0">
                  <span className="text-[13px] font-medium text-ink">{r.team}</span>
                  {by.length > 0 && <span className="text-ok"> approved by {by.map(personName).join(", ")}</span>}
                  <span className="block text-muted">{r.because.join("; ")}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** Only what the change affects, as a chain: what it switches off, what breaks by distance from it, and the
 *  teams and customers behind them. Readable where the full map is not. */
export function AffectedGraph({ diff }: { diff: Diff }) {
  if (!diff.broken.length) return null;
  return (
    <Section title="How it spreads" count={diff.broken.length}>
      <div className="-mx-1 overflow-x-auto px-1">
        <BlastRadius diff={diff} size="compact" />
      </div>
    </Section>
  );
}

export function PeopleBlock({ diff }: { diff: Diff }) {
  const shift = diff.bottlenecks.shift;
  const max = Math.max(1, ...shift.flatMap((s) => [s.before, s.after]), ...diff.bottlenecks.before.map((b) => b.score));
  return (
    <Section title="Key people" count={shift.length}>
      <p className="mb-2 text-xs text-muted">The people most work flows through, and how much more (or less) would rest on them.</p>
      {shift.length === 0 ? (
        <>
          <p className="mb-2 text-xs text-muted">No change. They stay the same:</p>
          <ul className="space-y-1.5">
            {diff.bottlenecks.after.slice(0, 4).map((b) => (
              <li key={b.uid} className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-2 text-xs">
                <span className="truncate">{b.name}</span>
                <DeltaBar before={b.score} after={b.score} max={max} color={C.muted} />
                <span className="mono text-right text-muted">{b.score.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <ul className="space-y-1.5">
          {shift.slice(0, 6).map((s) => (
            <li key={s.uid} className="grid grid-cols-[7.5rem_1fr_4.2rem] items-center gap-2 text-xs">
              <span className="truncate">{s.name}</span>
              <DeltaBar before={s.before} after={s.after} max={max} color={s.delta > 0 ? C.partial : C.verified} />
              <span className={`mono text-right ${s.delta > 0 ? "text-warn" : "text-ok"}`}>
                {s.delta > 0 ? "+" : ""}
                {s.delta.toFixed(1)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {diff.influence.shift.length > 0 && (
        <p className="mt-3 text-xs text-muted">
          Influence shifts most for{" "}
          {diff.influence.shift
            .slice(0, 3)
            .map((s) => `${s.name} ${s.delta > 0 ? "+" : ""}${(s.delta * 100).toFixed(1)}%`)
            .join(", ")}
        </p>
      )}
    </Section>
  );
}

export function StructureBlock({ diff }: { diff: Diff }) {
  const s = diff.structural;
  const rows: [string, string[], string][] = [
    ["Switched off", s.retired, C.muted],
    ["Leaves the company", s.former, C.muted],
    ["No longer relies on", s.closed_dependencies.map((d) => `${d.source} on ${d.target}`), C.bad],
    ["New tasks", s.proposed_tickets.map((t) => `${t.title} (${t.service})`), C.added],
    ["Nobody left who knows", diff.new_orphans.map((o) => `${o.service} (${tierWord(o.tier)})`), C.orphan],
  ];
  return (
    <Section title="Other changes">
      <dl className="space-y-2 text-xs">
        {rows
          .filter(([, v]) => v.length)
          .map(([k, v, c]) => (
            <div key={k}>
              <dt className="text-muted">{k}</dt>
              <dd className="mt-0.5 font-medium" style={{ color: c }}>
                {v.join(", ")}
              </dd>
            </div>
          ))}
        {diff.collaboration_splits.map((sp, i) => (
          <div key={i}>
            <dt className="text-muted">A group that works together splits into</dt>
            <dd className="mt-0.5 space-y-0.5">
              {sp.groups.map((g, j) => (
                <p key={j} className="font-medium text-warn">
                  {g.join(", ")}
                </p>
              ))}
            </dd>
          </div>
        ))}
        {rows.every(([, v]) => !v.length) && !diff.collaboration_splits.length && (
          <p className="text-muted">Nothing else changes.</p>
        )}
      </dl>
    </Section>
  );
}

export default function DiffPanel({ diff }: { diff: Diff }) {
  return (
    <div className="grid gap-x-10 gap-y-8 md:grid-cols-2 2xl:grid-cols-4">
      <RiskBlock diff={diff} />
      <BrokenBlock diff={diff} />
      <CustomersBlock diff={diff} />
      <ApproversBlock diff={diff} />
      {diff.broken.length > 0 && (
        <div className="md:col-span-2 2xl:col-span-4">
          <AffectedGraph diff={diff} />
        </div>
      )}
      <PeopleBlock diff={diff} />
      <StructureBlock diff={diff} />
    </div>
  );
}
