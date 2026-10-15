"use client";

import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useCosmos } from "@/components/cosmos/CosmosProvider";
import { EASE, Initials, Section } from "@/components/ui";
import { TEAM_ORDER } from "@/lib/cosmos/layout";
import { useApi, useGalaxy, useReducedMotion } from "@/lib/hooks";
import { hash01, teamColor } from "@/lib/palette";
import type { Galaxy, GService } from "@/lib/types";

type Insights = {
  org_vs_reality: { rows: { mismatches: { uid: string; service: string; declared_owner: string; actually: string; changes: number }[] } };
  hidden_teams: { rows: { people: { uid: string; name: string; team: string; team_name: string }[]; projects: { name: string }[] }[] };
};

export default function CrewPage() {
  const router = useRouter();
  const { engine, setVeil, setHandlers } = useCosmos();
  const { data: g } = useGalaxy();
  const { data: ins } = useApi<Insights>("insights");
  const reduced = useReducedMotion();
  const [person, setPerson] = useState<string | null>(null);
  const [svc, setSvc] = useState<string | null>(null);

  useEffect(() => {
    setVeil(0.82);
    engine?.setAutoRotate(true);
    return () => setVeil(0);
  }, [setVeil, engine]);
  useEffect(() => {
    if (engine && g) {
      engine.blackHole(null);
      engine.clearBlast();
      engine.setFocus(null);
      engine.setData(g);
    }
  }, [engine, g]);
  useEffect(() => {
    setHandlers({});
  }, [setHandlers]);

  const knowers = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const k of g?.knows ?? []) m.set(k.target, [...(m.get(k.target) ?? []), k.source]);
    return m;
  }, [g]);
  const names = useMemo(() => new Map(g?.people.map((p) => [p.id, p]) ?? []), [g]);
  const mismatch = new Map(ins?.org_vs_reality.rows.mismatches.map((m) => [m.uid, m]) ?? []);
  const selPerson = person ? names.get(person) : null;
  const theirs = person ? (g?.knows.filter((k) => k.source === person).map((k) => k.target) ?? []) : [];

  return (
    <main className="relative z-10 min-h-dvh px-4 pb-28 pt-[92px] md:px-6 md:pb-10">
      <div className="mx-auto max-w-[1400px]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="display text-[44px] italic leading-none md:text-[56px]">Who knows what</h1>
            <p className="mt-3 max-w-[620px] text-[14px] leading-relaxed text-muted">
              Each team is a star. Its services orbit it, and the people who know a service, from three or more
              changes or reviews in the last six months, circle it as moons. A planet with one moon is a single point
              of failure. A planet with none has nobody left who knows it.
            </p>
          </div>
          <div className="mono flex gap-4 text-[10px] text-faint">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border border-amber" />one person</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border border-dashed border-nova" />nobody</span>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {g && TEAM_ORDER.map((t, i) => {
            const team = g.teams.find((x) => x.id === t);
            if (!team) return null;
            const services = g.services.filter((s) => s.team === t);
            return (
              <motion.div key={t} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: EASE, delay: 0.1 + i * 0.08 }}
                          className="panel relative overflow-hidden rounded-2xl">
                <System team={t} label={team.label} size={team.size} services={services} knowers={knowers} g={g} reduced={reduced}
                        person={person} theirs={theirs} onPerson={setPerson} onService={setSvc} mismatch={mismatch} />
              </motion.div>
            );
          })}
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {ins?.hidden_teams.rows.map((h, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-10%" }}
                        transition={{ duration: 0.7, ease: EASE }} className="panel rounded-2xl p-5">
              <div className="mono text-[10px] tracking-[0.14em] text-[#b48cff]">A TEAM THE ORG CHART DOESN&apos;T SHOW</div>
              <h2 className="display mt-1 text-[28px] leading-tight">{h.projects[0]?.name ?? "Working together"}</h2>
              <p className="mt-1 text-[13px] text-muted">
                {h.people.length} people from {new Set(h.people.map((p) => p.team)).size} teams review each other&apos;s work more than they review their own teams&apos;.
                Found by connected components over collaboration that crosses team lines.
              </p>
              <Binary people={h.people} />
            </motion.div>
          ))}
          {ins && ins.org_vs_reality.rows.mismatches.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-10%" }}
                        transition={{ duration: 0.7, ease: EASE }} className="panel rounded-2xl p-5">
              <div className="mono text-[10px] tracking-[0.14em] text-amber">THE WIKI SAYS ONE THING</div>
              {ins.org_vs_reality.rows.mismatches.map((m) => (
                <div key={m.uid} className="mt-2">
                  <h2 className="display text-[28px] leading-tight"><span className="mono text-[24px]">{m.service}</span> is run by {m.actually}</h2>
                  <p className="mt-1 text-[13px] text-muted">
                    Declared owner: <span style={{ color: teamColor(TEAM_ORDER.find((t) => t.endsWith(m.declared_owner.toLowerCase()))) }}>{m.declared_owner}</span>.
                    Every one of its {m.changes} changes in the last six months came from {m.actually}.
                  </p>
                  <div className="mt-4 flex items-center gap-3">
                    <TeamBadge name={m.declared_owner} dashed />
                    <svg width="120" height="16" aria-hidden><line x1="0" y1="8" x2="120" y2="8" stroke="#ffb547" strokeDasharray="4 3" /><path d="M112 3 L120 8 L112 13" stroke="#ffb547" fill="none" /></svg>
                    <TeamBadge name={m.actually} />
                  </div>
                </div>
              ))}
            </motion.div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {selPerson && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.35, ease: EASE }}
                      className="panel fixed bottom-24 left-1/2 z-30 w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl p-4 md:bottom-8">
            <div className="flex items-center gap-3">
              <Initials name={selPerson.label} team={selPerson.team} size={38} />
              <div className="flex-1">
                <div className="display text-[22px] leading-none">{selPerson.label}</div>
                <div className="mt-1 text-[12px] text-muted">{selPerson.role}</div>
              </div>
              <button onClick={() => setPerson(null)} className="mono text-[11px] text-faint hover:text-ink">close</button>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {theirs.map((s) => {
                const solo = (knowers.get(s) ?? []).length === 1;
                return (
                  <span key={s} className={`mono rounded border px-2 py-0.5 text-[11px] ${solo ? "border-amber/50 text-amber" : "border-white/10 text-ink/80"}`}>
                    {g?.services.find((x) => x.id === s)?.label}{solo ? " · only them" : ""}
                  </span>
                );
              })}
            </div>
            <button onClick={() => router.push(`/multiverse?op=remove_person&person=${encodeURIComponent(selPerson.label)}`)}
                    className="mt-3 rounded-full bg-nova/90 px-3 py-1.5 text-[12px] text-void">What if {selPerson.label.split(" ")[0]} leaves?</button>
          </motion.div>
        )}
        {svc && !selPerson && (
          <ServiceCard key={svc} s={g?.services.find((x) => x.id === svc)} knowers={(knowers.get(svc) ?? []).map((k) => names.get(k)?.label ?? k)}
                       onClose={() => setSvc(null)} onFork={(name) => router.push(`/multiverse?op=outage&service=${encodeURIComponent(name)}`)} />
        )}
      </AnimatePresence>
    </main>
  );
}

function System({ team, label, size, services, knowers, g, reduced, person, theirs, onPerson, onService, mismatch }: {
  team: string; label: string; size: number; services: GService[]; knowers: Map<string, string[]>; g: Galaxy; reduced: boolean;
  person: string | null; theirs: string[]; onPerson: (p: string) => void; onService: (s: string) => void;
  mismatch: Map<string, { actually: string }>;
}) {
  const W = 420;
  const H = 360;
  const cx = W / 2;
  const cy = H / 2 + 6;
  const color = teamColor(team);
  // one ring per tier; planets on a ring are spaced evenly and share its speed, so they never collide
  const ring = (s: GService) => services.filter((x) => x.tier === s.tier);
  const radius = (s: GService) => 56 + (s.tier - 1) * 40 + (ring(s).length > 3 && ring(s).indexOf(s) % 2 ? 12 : 0);
  const lonely = services.filter((s) => (knowers.get(s.id) ?? []).length <= 1).length;
  return (
    <div className="relative">
      <div className="absolute left-5 top-4 z-10">
        <div className="display text-[26px] italic leading-none" style={{ color }}>{label}</div>
        <div className="mono mt-1 text-[10px] text-faint">{services.length} services · {size} people{lonely ? ` · ${lonely} at risk` : ""}</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
        <defs>
          <radialGradient id={`star-${team}`}>
            <stop offset="0" stopColor="#fff8ee" />
            <stop offset="0.25" stopColor={color} stopOpacity="0.9" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </radialGradient>
        </defs>
        {services.map((s) => (
          <circle key={s.id + "o"} cx={cx} cy={cy} r={radius(s)} fill="none"
                  stroke={(knowers.get(s.id) ?? []).length === 0 ? "rgba(255,77,46,.35)" : "rgba(236,232,220,.07)"}
                  strokeDasharray={(knowers.get(s.id) ?? []).length === 0 ? "3 5" : undefined} />
        ))}
        <circle cx={cx} cy={cy} r="42" fill={`url(#star-${team})`} opacity="0.55" />
        <circle cx={cx} cy={cy} r="7" fill="#fff8ee" />
        {services.map((s) => {
          const r = radius(s);
          const mates = ring(s);
          const start = (mates.indexOf(s) / mates.length) * 360 + hash01(team, s.tier) * 360;
          const period = 50 + s.tier * 28;
          const ks = knowers.get(s.id) ?? [];
          const solo = ks.length === 1;
          const none = ks.length === 0;
          const mine = person && theirs.includes(s.id);
          const pr = 5 + (4 - s.tier) * 2.2;
          return (
            <g key={s.id} style={{ transformOrigin: `${cx}px ${cy}px`, transform: `rotate(${start}deg)`, ["--s" as string]: `${start}deg`,
                                   animation: reduced ? undefined : `orbit ${period}s linear infinite` }}>
              <g transform={`translate(${cx + r} ${cy})`} className="cursor-pointer" onClick={() => onService(s.id)}>
                <g style={{ transformOrigin: "0 0", animation: reduced ? undefined : `orbit-rev ${period}s linear infinite`,
                            transform: `rotate(${-start}deg)` }}>
                  {solo && <circle r={pr + 9} fill="none" stroke="#ffb547" strokeOpacity="0.7" className="animate-pulse" />}
                  {mismatch.has(s.id) && <circle r={pr + 14} fill="none" stroke="#ffb547" strokeDasharray="2 3" strokeOpacity="0.8" />}
                  {none && <circle r={pr + 8} fill="none" stroke="#ff4d2e" strokeOpacity="0.5" strokeDasharray="1.5 3" />}
                  <circle r={pr} fill={none ? "rgba(255,77,46,.12)" : color} stroke={none ? "#ff6a3d" : "none"} strokeWidth={none ? 1.5 : 0} strokeDasharray={none ? "3 2" : undefined}
                          opacity={person && !mine ? 0.25 : 1} style={{ filter: none ? undefined : `drop-shadow(0 0 6px ${color})` }} />
                  {ks.map((k, j) => {
                    const a = (j / Math.max(1, ks.length)) * Math.PI * 2;
                    const mr = pr + 7;
                    const isHim = k === person;
                    return (
                      <circle key={k} cx={Math.cos(a) * mr} cy={Math.sin(a) * mr} r={isHim ? 3.4 : 2}
                              fill={isHim ? "#ffb547" : "#ece8dc"} opacity={person && !isHim ? 0.3 : 0.9}
                              className="cursor-pointer" onClick={(e) => { e.stopPropagation(); onPerson(k); }}>
                        <title>{g.people.find((p) => p.id === k)?.label}</title>
                      </circle>
                    );
                  })}
                  <text y={pr + 16} textAnchor="middle" className="mono" fontSize="9.5" fill={none ? "#ff7a52" : solo ? "#ffb547" : "rgba(236,232,220,.7)"}>
                    {s.label}{none ? " · nobody" : ""}
                  </text>
                </g>
              </g>
            </g>
          );
        })}
      </svg>
      <style>{`@keyframes orbit { from { transform: rotate(var(--s, 0deg)); } to { transform: rotate(calc(var(--s, 0deg) + 360deg)); } }
               @keyframes orbit-rev { from { transform: rotate(calc(-1 * var(--s, 0deg))); } to { transform: rotate(calc(-1 * var(--s, 0deg) - 360deg)); } }`}</style>
      <div className="flex flex-wrap gap-1 px-4 pb-4">
        {g.people.filter((p) => p.team === team).map((p) => (
          <button key={p.id} onClick={() => onPerson(p.id)}
                  className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${person === p.id ? "border-amber text-amber" : "border-white/[0.07] text-muted hover:text-ink"}`}>
            {p.label.split(" ")[0]}
          </button>
        ))}
      </div>
    </div>
  );
}

function Binary({ people }: { people: { uid: string; name: string; team: string; team_name: string }[] }) {
  const W = 520;
  const H = 170;
  const pts = people.map((p, i) => {
    const a = (i / people.length) * Math.PI * 2 - Math.PI / 2;
    return { ...p, x: W / 2 + Math.cos(a) * 150, y: H / 2 + Math.sin(a) * 58 };
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 block w-full">
      {pts.map((a, i) => pts.slice(i + 1).map((b) => (
        <line key={a.uid + b.uid} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#b48cff" strokeOpacity={a.team === b.team ? 0.15 : 0.5} strokeDasharray={a.team === b.team ? undefined : "4 3"} />
      )))}
      {pts.map((p) => (
        <g key={p.uid}>
          <circle cx={p.x} cy={p.y} r="16" fill={teamColor(p.team)} opacity="0.18" />
          <circle cx={p.x} cy={p.y} r="5" fill={teamColor(p.team)} />
          <text x={p.x} y={p.y + 28} textAnchor="middle" fontSize="11" fill="rgba(236,232,220,.85)">{p.name.split(" ")[0]}</text>
          <text x={p.x} y={p.y + 41} textAnchor="middle" className="mono" fontSize="9" fill={teamColor(p.team)}>{p.team_name}</text>
        </g>
      ))}
    </svg>
  );
}

function TeamBadge({ name, dashed }: { name: string; dashed?: boolean }) {
  const t = TEAM_ORDER.find((x) => x.endsWith(name.toLowerCase()));
  return (
    <span className={`rounded-full border px-3 py-1 text-[12px] ${dashed ? "border-dashed text-muted" : "text-ink"}`} style={{ borderColor: teamColor(t) }}>
      {name}
    </span>
  );
}

function ServiceCard({ s, knowers, onClose, onFork }: { s?: GService; knowers: string[]; onClose: () => void; onFork: (name: string) => void }) {
  if (!s) return null;
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.35, ease: EASE }}
                className="panel fixed bottom-24 left-1/2 z-30 w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl p-4 md:bottom-8">
      <div className="flex items-start justify-between">
        <div>
          <div className="mono text-[10px] text-faint">tier {s.tier} · {s.lang}</div>
          <div className="mono text-[18px]">{s.label}</div>
          <div className="mt-1 text-[12px] text-muted">{s.summary}</div>
        </div>
        <button onClick={onClose} className="mono text-[11px] text-faint hover:text-ink">close</button>
      </div>
      <Section title="Known by" className="mt-3">
        <div className="text-[13px] text-ink/85">{knowers.join(", ") || <span className="text-nova">nobody</span>}</div>
      </Section>
      <button onClick={() => onFork(s.label)} className="mt-3 rounded-full border border-white/10 px-3 py-1.5 text-[12px] text-muted hover:text-ink">What breaks if it goes down?</button>
    </motion.div>
  );
}
