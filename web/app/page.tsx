"use client";

import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useCosmos } from "@/components/cosmos/CosmosProvider";
import { Belt } from "@/components/Shell";
import { EASE, Initials, Magnetic, RiseText } from "@/components/ui";
import { open, TENANT } from "@/lib/api";
import { teamColor } from "@/lib/palette";
import { useSession } from "@/lib/session";
import type { Person } from "@/lib/types";

export default function Landing() {
  const router = useRouter();
  const { meta, ready, signIn } = useSession();
  const { engine, setVeil } = useCosmos();
  const [people, setPeople] = useState<Person[]>([]);
  const [count, setCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [all, setAll] = useState(false);
  const [going, setGoing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setVeil(0);
    engine?.setAutoRotate(true);
    engine?.home();
  }, [engine, setVeil]);

  useEffect(() => {
    open<Person[]>(`${TENANT}/personas`).then(setPeople).catch((e) => setErr(String(e.message ?? e)));
  }, []);

  // the preloader counts the objects in the sky up to the real number
  const [target, setTarget] = useState<number | null>(null);
  useEffect(() => {
    open<{ nodes: number }>(`${TENANT}/census`).then((c) => setTarget(c.nodes)).catch(() => setTarget(0));
  }, []);
  useEffect(() => {
    if (target === null) return;
    const t0 = performance.now();
    let raf = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 1400);
      setCount(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
      else setTimeout(() => setLoaded(true), 250);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  async function enter(uid: string) {
    setGoing(uid);
    try {
      await signIn(uid);
      engine?.warp(1500);
      setTimeout(() => router.push("/sky"), 650);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setGoing(null);
    }
  }

  const leads = people.filter((p) => p.role.toLowerCase().includes("lead"));
  const shown = all ? people : leads;

  return (
    <main className="relative z-10 min-h-dvh overflow-hidden">
      <AnimatePresence>
        {!loaded && (
          <motion.div key="pre" exit={{ opacity: 0 }} transition={{ duration: 0.6, ease: EASE }}
                      className="fixed inset-0 z-50 flex flex-col items-start justify-end bg-void px-6 pb-10 md:px-12">
            <div className="mono text-[11px] tracking-[0.14em] text-faint">ALIGNING THE TELESCOPE</div>
            <div className="mono mt-2 text-[clamp(3.5rem,12vw,9rem)] leading-none tabular-nums text-ink/90">
              {count.toLocaleString("en-US").padStart(5, " ")}
            </div>
            <div className="mono mt-2 text-[11px] text-muted">objects in Corvane&apos;s graph: people, services, decisions, messages</div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="pointer-events-none fixed inset-x-0 top-0 z-20 flex items-start justify-between px-6 pt-5 md:px-12">
        <div className="flex items-center gap-3">
          <Belt className="h-4 w-10" />
          <span className="display text-2xl italic">Orion</span>
        </div>
        <div className="mono hidden text-right text-[10px] leading-relaxed text-faint sm:block">
          RA 05h 35m 17s · DEC −05° 23′ 28″<br />
          GRAPH ON FALKORDB
        </div>
      </div>

      {loaded && (
        <section className="relative flex min-h-dvh flex-col justify-end px-6 pb-10 pt-28 md:px-12 md:pb-14">
          <div className="max-w-[1100px]">
            <RiseText as="h1" text="See the company" delay={0.1}
                      className="display block text-[clamp(3.2rem,9.5vw,8.6rem)] leading-[0.92] tracking-[-0.035em]" />
            <RiseText as="h1" text="before you change it." delay={0.3}
                      className="display block text-[clamp(3.2rem,9.5vw,8.6rem)] italic leading-[0.92] tracking-[-0.035em] text-ink/80" />
            <motion.p initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease: EASE, delay: 0.75 }}
                      className="mt-7 max-w-[560px] text-[15px] leading-relaxed text-muted md:text-[16px]">
              Orion keeps Corvane&apos;s people, services, decisions and conversations in one graph. Fork it into a
              parallel universe, retire a service or lose a person, and watch what breaks there first.
            </motion.p>
          </div>

          <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease: EASE, delay: 0.95 }}
                      className="mt-10">
            <div className="mb-3 flex items-baseline gap-4">
              <span className="mono text-[10px] tracking-[0.14em] text-faint">
                {meta ? "WELCOME BACK" : "STEP IN AS SOMEONE AT CORVANE"}
              </span>
              {meta && (
                <Magnetic onClick={() => enter(meta.me.uid)}
                          className="rounded-full bg-amber px-4 py-1.5 text-[13px] text-void shadow-[0_0_40px_-8px_#ffb547]">
                  Return to the sky as {meta.me.name.split(" ")[0]}
                </Magnetic>
              )}
            </div>
            {err && <div className="mono mb-3 text-[12px] text-nova">The observatory is offline: {err}</div>}
            <div className="grid max-w-[1100px] grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((p, i) => (
                <motion.button key={p.uid} disabled={!!going || !ready}
                               initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                               transition={{ duration: 0.6, ease: EASE, delay: 1.05 + i * 0.05 }}
                               onClick={() => enter(p.uid)}
                               className="group panel reticle relative flex items-center gap-3 rounded-lg px-3.5 py-3 text-left transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-white/20">
                  <Initials name={p.name} team={p.team} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px]">{p.name}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {p.role} · <span style={{ color: teamColor(p.team) }}>{p.team_name}</span>
                    </span>
                  </span>
                  <span className="mono text-[10px] text-faint transition-colors group-hover:text-amber">
                    {going === p.uid ? "jumping" : "enter"}
                  </span>
                </motion.button>
              ))}
            </div>
            {people.length > leads.length && (
              <button onClick={() => setAll((a) => !a)} className="mono mt-3 text-[11px] text-muted underline-offset-4 hover:text-ink hover:underline">
                {all ? "only the team leads" : `everyone (${people.length})`}
              </button>
            )}
          </motion.div>

          <div className="mono mt-10 flex flex-wrap gap-x-6 gap-y-1 text-[10px] text-faint">
            <span>Corvane is fictional: generated data, no real people</span>
            <span>Built for Graph Hacks on FalkorDB</span>
          </div>
        </section>
      )}
    </main>
  );
}
