"use client";

import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { get } from "@/lib/api";
import { EFFECT_COLOR } from "@/lib/palette";
import type { Effect } from "@/lib/types";
import { EASE, Initials, Section, Spinner, TeamDot } from "./ui";

type Fact = {
  uid: string; rel: string; from: string; to: string; kind?: string; valid_from: string; valid_to: string; recorded_at: string;
  source_uid: string; source: string; source_at: string; source_text: string; author: string; closed_by: string; open: boolean;
  known_late: boolean;
};
type Impact = { uid: string; name: string; tier: number; effect: Effect; depth: number; path: string[]; not_in_catalog: { from: string; recorded_at: string }[] };
type Entity = {
  uid: string;
  labels: string[];
  props: Record<string, string | number>;
  neighbors: { rel: string; out: boolean; uid: string; name: string; label: string }[];
  changes: { key: string; title: string; at: string; by: string }[];
  sources: { uid: string; kind: string; title: string; at: string; text: string; author: string }[];
  knows?: { service: string; knows: { uid: string; name: string; team: string; changes: number }[]; owner: { team: string } | null; left: { name: string; left: string; changes: number }[] };
  impact?: { service: string; dependents: Impact[] };
  decisions?: { uid: string; key: string; title: string; status: string; at: string; summary: string; team: string; decided_by: string[]; supersedes: string; how: string; superseded_by: string; by_how: string; sources: { uid: string; title: string; at: string; text: string }[] }[];
  facts?: Fact[];
  findings?: { universe: string; title: string; risk: number; level: string; at: string; summary: string }[];
  story?: { customer: string; tier: string; industry: string; tickets: { key: string; title: string; status: string; kind: string; opened: string; services: string[]; blocked_by: string[][] }[]; uses: { name: string }[] };
};

export function EntityPanel({ uid, onClose, onBlast, onTrail, onFocus }: {
  uid: string;
  onClose: () => void;
  onBlast: (root: string, hits: { uid: string; effect: Effect; depth: number; path: string[] }[]) => void;
  onTrail: (uids: string[]) => void;
  onFocus: (uids: string[]) => void;
}) {
  const router = useRouter();
  const [e, setE] = useState<Entity | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setE(null);
    setErr(null);
    get<Entity>(`entity/${uid}`).then(setE).catch((x) => setErr(String(x.message ?? x)));
  }, [uid]);

  const kind = e?.labels.includes("Service") ? "service" : e?.labels.includes("Person") ? "person" : e?.labels.includes("Customer") ? "customer"
    : e?.labels.includes("Team") ? "team" : e?.labels.includes("Decision") ? "decision" : "thing";
  const team = e?.neighbors.find((n) => (n.rel === "OWNS" && !n.out) || (n.rel === "MEMBER_OF" && n.out))?.uid ?? (kind === "team" ? uid : null);
  const name = String(e?.props.name ?? e?.props.key ?? uid);

  function fork(op: Record<string, string>) {
    const q = new URLSearchParams(op).toString();
    router.push(`/multiverse?${q}`);
  }

  return (
    <motion.aside key={uid} initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }}
                  transition={{ duration: 0.5, ease: EASE }}
                  className="panel pointer-events-auto flex max-h-[calc(100dvh-6.5rem)] w-full flex-col overflow-hidden rounded-xl md:w-[380px]">
      <div className="flex items-start gap-3 border-b border-white/[0.06] px-4 pb-3 pt-4">
        {kind === "person" ? <Initials name={name} team={team} size={36} /> : <span className="mt-2"><TeamDot team={team} size={9} /></span>}
        <div className="min-w-0 flex-1">
          <div className="mono text-[10px] uppercase tracking-[0.12em] text-faint">
            {kind}{e?.props.tier ? ` · tier ${e.props.tier}` : ""}{e?.props.lang ? ` · ${e.props.lang}` : ""}
          </div>
          <h2 className={`truncate text-[22px] leading-tight ${kind === "service" ? "mono text-[19px]" : "display"}`}>{name}</h2>
          {e?.props.summary && <p className="mt-1 text-[12px] leading-snug text-muted">{e.props.summary}</p>}
          {e?.props.role && <p className="mt-0.5 text-[12px] text-muted">{e.props.role}</p>}
          {e?.props.mission && <p className="mt-1 text-[12px] leading-snug text-muted">{e.props.mission}</p>}
        </div>
        <button onClick={onClose} className="mono text-[11px] text-faint hover:text-ink" aria-label="close">esc</button>
      </div>

      <div className="scroll-quiet flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {!e && !err && <Spinner label="reading the graph" />}
        {err && <div className="text-[12px] text-nova">{err}</div>}

        {e && kind === "service" && (
          <>
            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => e.impact && onBlast(uid, e.impact.dependents.map((d) => ({
                        uid: d.uid, effect: d.effect, depth: d.depth, path: d.path.map((n) => `svc:${n}`) })))}
                      className="rounded-full bg-nova/90 px-3 py-1 text-[12px] text-void shadow-[0_0_30px_-8px_#ff4d2e]">
                Show the blast radius
              </button>
              <button onClick={() => fork({ op: "outage", service: name })} className="rounded-full border border-white/10 px-3 py-1 text-[12px] text-muted hover:text-ink">
                Fork: it goes down
              </button>
              <button onClick={() => fork({ op: "retire_service", service: name })} className="rounded-full border border-white/10 px-3 py-1 text-[12px] text-muted hover:text-ink">
                Fork: retire it
              </button>
            </div>

            {e.knows && (
              <Section title="Who knows it" aside="3+ changes or reviews in 180 days">
                {e.knows.knows.length === 0 && <div className="text-[12px] text-amber">Nobody. Everyone who knew it has moved on.</div>}
                <div className="space-y-1.5">
                  {e.knows.knows.map((k) => (
                    <button key={k.uid} onClick={() => onFocus([k.uid, uid])} className="flex w-full items-center gap-2 text-left">
                      <Initials name={k.name} size={22} />
                      <span className="flex-1 text-[12px]">{k.name}</span>
                      <span className="mono text-[10px] text-faint">{k.team}</span>
                      <span className="mono w-8 text-right text-[11px] text-ink/70">{k.changes}</span>
                    </button>
                  ))}
                </div>
                {e.knows.knows.length === 1 && <div className="mono mt-2 text-[10px] text-amber">bus factor of one</div>}
                {e.knows.left.length > 0 && (
                  <div className="mt-2 text-[11px] text-faint">
                    Knew it, left: {e.knows.left.map((l) => `${l.name} (${l.changes} changes, left ${l.left})`).join(", ")}
                  </div>
                )}
              </Section>
            )}

            {e.impact && (
              <Section title="If it went dark" aside={`${e.impact.dependents.length} dependents`}>
                <div className="space-y-1">
                  {e.impact.dependents.map((d) => (
                    <div key={d.uid} className="flex items-center gap-2 text-[12px]">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: EFFECT_COLOR[d.effect] }} />
                      <span className="mono flex-1 truncate">{d.name}</span>
                      <span className="mono text-[10px]" style={{ color: EFFECT_COLOR[d.effect] }}>{d.effect}</span>
                      <span className="mono w-10 text-right text-[10px] text-faint">{d.depth} hop{d.depth > 1 ? "s" : ""}</span>
                    </div>
                  ))}
                  {e.impact.dependents.some((d) => d.not_in_catalog.length) && (
                    <div className="mt-2 rounded border border-amber/25 bg-amber/5 px-2.5 py-2 text-[11px] text-ink/80">
                      Some of these paths aren&apos;t in the service catalog. They were found in conversation:
                      {e.impact.dependents.filter((d) => d.not_in_catalog.length).map((d) => (
                        <div key={d.uid} className="mono mt-1 text-[10px] text-amber">{d.name}: {d.not_in_catalog.map((n) => `${n.from}, recorded ${n.recorded_at}`).join("; ")}</div>
                      ))}
                    </div>
                  )}
                </div>
              </Section>
            )}
          </>
        )}

        {e && kind === "person" && (
          <>
            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => fork({ op: "remove_person", person: name })}
                      className="rounded-full bg-nova/90 px-3 py-1 text-[12px] text-void shadow-[0_0_30px_-8px_#ff4d2e]">
                Fork: {name.split(" ")[0]} leaves
              </button>
            </div>
            <Section title="Knows">
              <div className="flex flex-wrap gap-1.5">
                {e.neighbors.filter((n) => n.rel === "KNOWS").map((n) => (
                  <span key={n.uid} className="mono rounded border border-white/[0.08] px-2 py-0.5 text-[11px]">{n.name}</span>
                ))}
                {!e.neighbors.some((n) => n.rel === "KNOWS") && <span className="text-[12px] text-faint">No service in the last 180 days.</span>}
              </div>
            </Section>
            <Section title="Works closely with">
              <div className="flex flex-wrap gap-1.5">
                {e.neighbors.filter((n) => n.rel === "COLLABORATES" && n.out).map((n) => (
                  <button key={n.uid} onClick={() => onFocus([uid, n.uid])} className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[11px] text-muted hover:text-ink">{n.name}</button>
                ))}
              </div>
            </Section>
          </>
        )}

        {e && kind === "customer" && e.story && (
          <Section title="Tickets" aside={`${e.story.tier} · since ${e.props.since}`}>
            <div className="space-y-2">
              {e.story.tickets.map((t) => (
                <div key={t.key} className="text-[12px]">
                  <div className="flex gap-2">
                    <span className="mono text-[11px] text-ink/70">{t.key}</span>
                    <span className="flex-1 text-ink/85">{t.title}</span>
                    <span className={`mono text-[10px] ${t.status === "open" ? "text-amber" : "text-faint"}`}>{t.status}</span>
                  </div>
                  {t.blocked_by.map((ch, i) => (
                    <div key={i} className="mono mt-0.5 pl-12 text-[10px] text-nova/90">blocked by {ch.slice(1).join(" ← ")}</div>
                  ))}
                </div>
              ))}
            </div>
          </Section>
        )}

        {e && kind === "team" && (
          <Section title="Owns">
            <div className="flex flex-wrap gap-1.5">
              {e.neighbors.filter((n) => n.rel === "OWNS").map((n) => (
                <button key={n.uid} onClick={() => onFocus([n.uid])} className="mono rounded border border-white/[0.08] px-2 py-0.5 text-[11px] hover:border-white/20">{n.name}</button>
              ))}
            </div>
          </Section>
        )}

        {e?.decisions && e.decisions.length > 0 && (
          <Section title="Decisions" aside="oldest first">
            <ol className="relative space-y-3 border-l border-white/[0.08] pl-4">
              {e.decisions.map((d) => (
                <li key={d.uid} className="relative">
                  <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full"
                        style={{ background: d.status === "accepted" ? "#7ee0b5" : d.status === "reversed" ? "#ff4d2e" : "#7f8fb3" }} />
                  <div className="mono text-[10px] text-faint">{d.key} · {d.at} · {d.team} · {d.status}</div>
                  <div className="text-[12px] text-ink/90">{d.title}</div>
                  {d.superseded_by && <div className="mono text-[10px] text-nova/80">{d.by_how === "reverses" ? "reversed" : "superseded"} by {d.superseded_by}</div>}
                  {d.sources.slice(0, 1).map((s) => (
                    <div key={s.uid} className="mt-1 border-l-2 border-amber/40 pl-2 text-[11px] italic text-muted">&ldquo;{s.text}&rdquo;</div>
                  ))}
                </li>
              ))}
            </ol>
          </Section>
        )}

        {e?.facts && e.facts.length > 0 && (
          <Section title="Where each fact comes from" aside="blame">
            <div className="space-y-2">
              {e.facts.filter((f) => f.rel === "DEPENDS_ON" || f.rel === "OWNS" || f.rel === "MEMBER_OF").slice(0, 14).map((f) => (
                <button key={f.uid} onClick={() => onTrail(trailOf(f, e))}
                        className={`block w-full rounded-md border px-2.5 py-2 text-left transition-colors hover:border-white/20 ${f.known_late ? "border-amber/30 bg-amber/[0.04]" : "border-white/[0.06]"}`}>
                  <div className="mono flex justify-between gap-2 text-[11px]">
                    <span className={f.open ? "text-ink/85" : "text-faint line-through"}>{f.from} {arrow(f.rel)} {f.to}{f.kind ? ` (${f.kind})` : ""}</span>
                    <span className="text-faint">{f.valid_from.slice(0, 10)}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {f.source ?? f.source_uid}{f.author ? `, ${f.author}` : ""}{f.closed_by ? ` · closed by ${f.closed_by}` : ""}
                  </div>
                  {f.known_late && (
                    <div className="mono mt-1 text-[10px] text-amber">true since {f.valid_from.slice(0, 10)}, written down {f.recorded_at.slice(0, 10)}</div>
                  )}
                  {f.known_late && f.source_text && <div className="mt-1 text-[11px] italic text-ink/70">&ldquo;{f.source_text}&rdquo;</div>}
                </button>
              ))}
            </div>
          </Section>
        )}

        {e?.findings && e.findings.length > 0 && (
          <Section title="Simulated before">
            {e.findings.map((f) => (
              <button key={f.universe} onClick={() => router.push(`/multiverse?u=${f.universe}`)} className="block text-left text-[12px] text-muted hover:text-ink">
                <span className="mono text-[10px] text-faint">{f.universe} · {f.at}</span> {f.summary}
              </button>
            ))}
          </Section>
        )}

        {e && e.sources.length > 0 && (
          <Section title="Mentioned in">
            <div className="space-y-2">
              {e.sources.slice(0, 6).map((s) => (
                <div key={s.uid} className="text-[12px]">
                  <div className="mono text-[10px] text-faint">{s.title} · {s.author} · {s.at?.replace("T", " ")}</div>
                  <div className="leading-snug text-ink/80">{s.text}</div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {e && e.changes.length > 0 && (
          <Section title="Recent changes">
            <div className="space-y-1">
              {e.changes.slice(0, 8).map((c) => (
                <div key={c.key + c.at} className="flex gap-2 text-[11px]">
                  <span className="mono text-faint">{c.at.slice(0, 10)}</span>
                  <span className="min-w-0 flex-1 truncate text-ink/75">{c.title}</span>
                  <span className="text-faint">{c.by?.split(" ")[0]}</span>
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </motion.aside>
  );
}

function arrow(rel: string) {
  return rel === "DEPENDS_ON" ? "→" : rel === "OWNS" ? "owns" : rel === "MEMBER_OF" ? "in" : rel;
}

function trailOf(f: Fact, e: Entity): string[] {
  const ids = [f.from, f.to].map((n) => e.neighbors.find((x) => x.name === n)?.uid ?? (e.props.name === n ? e.uid : null));
  return ids.filter((x): x is string => !!x);
}
