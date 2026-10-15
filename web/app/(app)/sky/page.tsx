"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AskDock } from "@/components/AskDock";
import { useCosmos } from "@/components/cosmos/CosmosProvider";
import { EntityPanel } from "@/components/EntityPanel";
import { EASE, Magnetic, TeamDot } from "@/components/ui";
import { post } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useApi, useGalaxy } from "@/lib/hooks";
import { teamColor } from "@/lib/palette";
import type { Effect } from "@/lib/types";
import { TEAM_ORDER } from "@/lib/cosmos/layout";

type Insights = {
  bus_factor: { rows: { uid: string; name: string; tier: number; knowers: string[]; knower_uids: string[] }[] };
  org_vs_reality: { rows: { mismatches: { uid: string; service: string; declared_owner: string; actually: string; changes: number }[] } };
  hidden_teams: { rows: { people: { uid: string; name: string; team: string }[]; projects: { name: string }[] }[] };
  contradictions: { rows: { uid: string; topic: string; about_uids: string[] }[] };
  blocked_customers: { customer_uid: string; customer: string; ticket: string; blocked_by: string[] }[];
};

type Story = { key: string; label: string; detail: string; tone: "amber" | "nova" | "violet"; focus: string[]; select?: string; team?: string };

export default function SkyPage() {
  const { engine, setVeil, setHandlers } = useCosmos();
  const { data: galaxy } = useGalaxy();
  const { data: insights } = useApi<Insights>("insights");
  const [selected, setSelected] = useState<string | null>(null);
  const [team, setTeam] = useState<string | null>(null);
  const [story, setStory] = useState<string | null>(null);
  const [deps, setDeps] = useState(true);
  const [askOpen, setAskOpen] = useState(false);
  const [tour, setTour] = useState<number | null>(null);
  const router = useRouter();

  // ⌘K picks something anywhere in the app and lands here
  useEffect(() => {
    const on = (e: Event) => setSelected((e as CustomEvent<string>).detail);
    window.addEventListener("orion:select", on);
    return () => window.removeEventListener("orion:select", on);
  }, []);

  useEffect(() => {
    setVeil(0);
  }, [setVeil]);

  useEffect(() => {
    if (!engine || !galaxy) return;
    engine.blackHole(null);
    engine.clearBlast();
    engine.setData(galaxy);
    engine.setConstellations("all");
    engine.setAutoRotate(true);
  }, [engine, galaxy]);

  const pick = useCallback((id: string | null) => {
    setSelected(id);
    if (!engine) return;
    engine.select(id);
    engine.setKnowsFor(id);
    engine.setAutoRotate(!id);
    if (!id) {
      engine.setFocus(null);
      return;
    }
  }, [engine]);

  useEffect(() => {
    setHandlers({ select: (n) => pick(n?.id ?? null) });
    return () => setHandlers({});
  }, [setHandlers, pick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        pick(null);
        setTeam(null);
        setStory(null);
        engine?.setFocus(null);
        engine?.clearBlast();
        engine?.setConstellations("all");
        engine?.home();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, pick]);

  const stories = useMemo<Story[]>(() => {
    if (!insights) return [];
    const out: Story[] = [];
    for (const b of insights.bus_factor.rows) {
      if (b.knowers.length === 0)
        out.push({ key: `orphan-${b.uid}`, label: `Nobody knows ${b.name}`, detail: "everyone who did has left", tone: "nova", focus: [b.uid], select: b.uid });
      else if (b.tier === 1)
        out.push({ key: `bus-${b.uid}`, label: `Only ${b.knowers[0].split(" ")[0]} knows ${b.name}`, detail: `tier ${b.tier}, bus factor of one`, tone: "amber",
                   focus: [b.uid, ...b.knower_uids], select: b.uid });
    }
    for (const h of insights.hidden_teams.rows)
      out.push({ key: "hidden", label: "A team the org chart doesn't show", detail: `${h.people.length} people, ${new Set(h.people.map((p) => p.team)).size} teams · ${h.projects[0]?.name ?? ""}`,
                 tone: "violet", focus: h.people.map((p) => p.uid) });
    for (const m of insights.org_vs_reality.rows.mismatches)
      out.push({ key: `ovr-${m.uid}`, label: `${m.service} is run by ${m.actually}`, detail: `the wiki says ${m.declared_owner}`, tone: "amber", focus: [m.uid], select: m.uid });
    for (const c of insights.contradictions.rows)
      out.push({ key: c.uid, label: "Two people disagree", detail: c.topic, tone: "violet", focus: c.about_uids, select: c.about_uids[0] });
    for (const b of insights.blocked_customers)
      out.push({ key: `blk-${b.ticket}`, label: `${b.customer} is waiting`, detail: `${b.ticket} ← ${b.blocked_by.join(" ← ")}`, tone: "nova", focus: [b.customer_uid], select: b.customer_uid });
    return out;
  }, [insights]);

  function playStory(s: Story) {
    if (!engine) return;
    const on = story === s.key ? null : s.key;
    setStory(on);
    engine.clearBlast();
    if (!on) {
      engine.setFocus(null);
      engine.home();
      return;
    }
    engine.setFocus(s.focus);
    if (s.key === "hidden") {
      engine.setConstellations("all");
      engine.flyTo(s.focus[0], 120);
      setSelected(null);
    } else if (s.select) {
      pick(s.select);
    }
    s.focus.forEach((id, i) => setTimeout(() => engine.flash(id, s.tone === "nova" ? "#ff4d2e" : s.tone === "violet" ? "#b48cff" : "#ffb547"), 500 + i * 140));
  }

  function focusTeam(t: string | null) {
    setTeam(t);
    if (!engine || !galaxy) return;
    engine.setConstellations(t ?? "all");
    if (!t) {
      engine.setFocus(null);
      engine.home();
      return;
    }
    const ids = [t, ...galaxy.services.filter((s) => s.team === t).map((s) => s.id), ...galaxy.people.filter((p) => p.team === t).map((p) => p.id)];
    engine.setFocus(ids);
    engine.flyTo(t, 120);
  }

  function blast(root: string, hits: { uid: string; effect: Effect; depth: number; path: string[] }[]) {
    if (!engine) return;
    engine.setFocus([root, ...hits.map((h) => h.uid)]);
    engine.flyTo(root, 120);
    setTimeout(() => engine.blast([root], hits), 900);
  }

  const TOUR: { caption: string; sub: string; run: () => void }[] = [
    { caption: "This is Corvane.", sub: "Forty people, six teams, twenty-five running services. Each arm of the galaxy is a team.",
      run: () => { engine?.clearBlast(); engine?.setFocus(null); engine?.setConstellations("all"); engine?.home(); engine?.setAutoRotate(true); } },
    { caption: "Every star is a service.", sub: "Its size is how much depends on it (PageRank). The filaments are dependencies, pulsing in the direction of each call.",
      run: () => { engine?.setFocus(null); engine?.flyTo("svc:secrets-vault", 120); } },
    { caption: "Only Ines knows the ledger.", sub: "A tier-1 service with a bus factor of one: she is the only person with three or more changes or reviews in six months.",
      run: () => { const s = stories.find((x) => x.key.startsWith("bus-")); if (s) playStory(s); } },
    { caption: "Nobody knows reports-legacy.", sub: "Marcus Bell left in July. Pinecrest Bank's nightly CSV came out empty six weeks later.",
      run: () => { const s = stories.find((x) => x.key.startsWith("orphan-")); if (s) playStory(s); } },
    { caption: "A team the org chart doesn't show.", sub: "Five people from Runtime, Data and Signals work as one group. Connected components over collaboration across team lines.",
      run: () => { const s = stories.find((x) => x.key === "hidden"); if (s) playStory(s); } },
    { caption: "What if secrets-vault went down?", sub: "The failure travels out one hop at a time: red breaks, orange degrades, grey goes stale.",
      run: async () => {
        setStory(null);
        pick(null);
        try {
          const r = await post<{ rows: { dependents: { uid: string; effect: Effect; depth: number; path: string[] }[] } }>("tools/impact", { service: "secrets-vault" });
          blast("svc:secrets-vault", r.rows.dependents.map((d) => ({ uid: d.uid, effect: d.effect, depth: d.depth, path: d.path.map((n) => `svc:${n}`) })));
        } catch {}
      } },
  ];

  useEffect(() => {
    if (tour === null) return;
    if (tour >= TOUR.length) {
      setTour(null);
      return;
    }
    TOUR[tour].run();
    const t = setTimeout(() => setTour((x) => (x === null ? null : x + 1)), tour === TOUR.length - 1 ? 9000 : 6500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour]);

  return (
    <main className="pointer-events-none relative z-10 min-h-dvh">
      {/* the tour */}
      <AnimatePresence>
        {tour !== null && tour < TOUR.length && (
          <motion.div key={tour} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.7, ease: EASE }}
                      className="pointer-events-auto fixed inset-x-4 bottom-24 z-40 mx-auto max-w-[760px] text-center md:bottom-12">
            <div className="mono mb-2 text-[10px] tracking-[0.16em] text-faint">{tour + 1} / {TOUR.length}</div>
            <div className="display text-[clamp(2rem,5vw,3.6rem)] leading-[1.02] tracking-[-0.03em] [text-shadow:0_0_40px_rgba(4,5,10,.9)]">{TOUR[tour].caption}</div>
            <p className="mx-auto mt-3 max-w-[560px] text-[14px] leading-relaxed text-ink/75 [text-shadow:0_0_20px_rgba(4,5,10,.95)]">{TOUR[tour].sub}</p>
            <div className="mt-4 flex justify-center gap-2">
              <button onClick={() => setTour(null)} className="mono rounded-full border border-white/10 px-3 py-1 text-[11px] text-muted hover:text-ink">end tour</button>
              {tour < TOUR.length - 1 ? (
                <button onClick={() => setTour(tour + 1)} className="mono rounded-full border border-white/10 px-3 py-1 text-[11px] text-muted hover:text-ink">next</button>
              ) : (
                <button onClick={() => router.push("/multiverse?op=retire_service&service=sso-legacy")} className="rounded-full bg-amber px-3 py-1 text-[12px] text-void">
                  Now fork the company
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* storylines */}
      <div className="pointer-events-auto fixed left-4 top-[88px] z-20 hidden max-w-[calc(100vw-470px)] md:left-6 md:block">
        <div className="mb-2 flex items-center gap-3">
          <span className="mono text-[10px] tracking-[0.14em] text-faint">WHAT THE GRAPH NOTICED</span>
          <Magnetic onClick={() => setTour(0)} className="rounded-full bg-amber/90 px-3 py-0.5 text-[11px] text-void shadow-[0_0_24px_-6px_#ffb547]">
            Take the tour
          </Magnetic>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {stories.map((s, i) => (
            <motion.button key={s.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE, delay: 0.3 + i * 0.06 }}
                           onClick={() => playStory(s)}
                           className={`group rounded-full border px-3 py-1.5 text-left backdrop-blur-xl transition-colors duration-300 ${story === s.key ? "border-white/25 bg-white/[0.09]" : "border-white/[0.07] bg-[#070a13]/60 hover:border-white/15"}`}>
              <span className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.tone === "nova" ? "#ff4d2e" : s.tone === "violet" ? "#b48cff" : "#ffb547",
                                                                     boxShadow: `0 0 8px ${s.tone === "nova" ? "#ff4d2e" : s.tone === "violet" ? "#b48cff" : "#ffb547"}` }} />
                <span className="text-[12px] text-ink/90">{s.label}</span>
                <span className="hidden text-[11px] text-faint lg:inline">{s.detail}</span>
              </span>
            </motion.button>
          ))}
        </div>
      </div>

      {/* entity drawer */}
      <div className="fixed bottom-24 left-4 top-[150px] z-20 flex items-end md:bottom-6 md:left-6">
        <AnimatePresence mode="wait">
          {selected && (
            <EntityPanel key={selected} uid={selected} onClose={() => pick(null)} onBlast={blast}
                         onTrail={(ids) => { engine?.setEvidence(ids); }}
                         onFocus={(ids) => { engine?.setFocus(ids); engine?.setEvidence(ids); }} />
          )}
        </AnimatePresence>
      </div>

      {/* navigator: docked on wide screens, a sheet on phones */}
      <div className={`fixed bottom-24 right-4 top-[88px] z-30 items-start md:bottom-6 md:right-6 md:z-20 md:flex ${askOpen ? "left-4 flex" : "hidden"}`}>
        <AskDock onEvidence={(ids) => { engine?.setFocus(ids); engine?.setEvidence(ids); engine?.setAutoRotate(false); }} />
      </div>
      <button onClick={() => setAskOpen((o) => !o)}
              className="pointer-events-auto fixed bottom-[84px] right-4 z-30 rounded-full bg-amber px-4 py-2 text-[13px] text-void shadow-[0_0_40px_-8px_#ffb547] md:hidden">
        {askOpen ? "Back to the sky" : "Ask the Navigator"}
      </button>

      {/* legend: the arms */}
      {!selected && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.5 }}
                    className="pointer-events-auto fixed bottom-24 left-4 z-20 md:bottom-6 md:left-6">
          <div className="panel rounded-xl p-3">
            <div className="mono mb-2 flex items-center justify-between gap-6 text-[10px] tracking-[0.12em] text-faint">
              <span>ARMS OF THE GALAXY</span>
              <span>{galaxy ? `${galaxy.stats.services} services · ${galaxy.stats.people} people` : ""}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {TEAM_ORDER.map((t) => {
                const tm = galaxy?.teams.find((x) => x.id === t);
                if (!tm) return null;
                return (
                  <button key={t} onClick={() => focusTeam(team === t ? null : t)}
                          className={`flex items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] transition-colors ${team === t ? "bg-white/[0.07] text-ink" : "text-muted hover:text-ink"}`}>
                    <TeamDot team={t} />
                    <span className="flex-1">{tm.label}</span>
                    <span className="mono text-[10px] text-faint">{tm.size}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-4 border-t border-white/[0.06] pt-2.5">
              <Key color="#ece8dc" label="sync" />
              <Key color="#ece8dc" label="async" dashed />
              <Key color="#ffb547" label="cross-team tie" dashed />
              <button onClick={() => { setDeps(!deps); engine?.setFocus(deps ? (galaxy?.people.map((p) => p.id) ?? []) : null); }}
                      className="mono ml-auto text-[10px] text-faint hover:text-ink">{deps ? "people only" : "everything"}</button>
            </div>
          </div>
        </motion.div>
      )}

      <div className="mono pointer-events-none fixed bottom-6 left-1/2 z-10 hidden -translate-x-1/2 text-[10px] tracking-[0.1em] text-faint lg:block">
        DRAG TO ORBIT · SCROLL TO ZOOM · CLICK A STAR · ESC TO RESET
      </div>
      <span className="hidden" style={{ color: teamColor(null) }} />
    </main>
  );
}

function Key({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="mono flex items-center gap-1.5 text-[10px] text-faint">
      <svg width="18" height="4" aria-hidden><line x1="0" y1="2" x2="18" y2="2" stroke={color} strokeWidth="1.2" strokeDasharray={dashed ? "3 2" : undefined} /></svg>
      {label}
    </span>
  );
}
