"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { AnswerCard } from "@/components/ClaimView";
import { useCosmos } from "@/components/cosmos/CosmosProvider";
import { EASE, Section, StatusMark } from "@/components/ui";
import { get, post } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { LEVEL_COLOR, STATUS_COLOR } from "@/lib/palette";
import { useSession } from "@/lib/session";
import type { Answer } from "@/lib/types";

type Inbox = {
  notifications: { uid: string; question: string; sentence: string; before: string; after: string; why: string; cause: string; at: string; read: boolean; answer: string }[];
  approvals: { uid: string; title: string; risk: number; level: "clear" | "watch" | "danger"; by: string; at: string }[];
};
type Mine = { uid: string; question: string; at: string; status: string; statuses: string[] }[];
type Memory = {
  sessions: { uid: string; started: string; last: string; questions: number; sample: string[] }[];
  beliefs: { text: string; valid_from: string; valid_to: string }[];
  procedures: { qtype: string; tools: string[]; ok: number; bad: number }[];
  topics: { uid: string; n: number }[];
};

export default function InboxPage() {
  const { meta, refresh } = useSession();
  const { setVeil, engine } = useCosmos();
  const { data: inbox, reload } = useApi<Inbox>("inbox");
  const { data: mine } = useApi<Mine>("answers?mine=true");
  const { data: mem } = useApi<Memory>("memory");
  const [open, setOpen] = useState<Answer | null>(null);

  useEffect(() => {
    setVeil(0.78);
    engine?.setAutoRotate(true);
    return () => setVeil(0);
  }, [setVeil, engine]);

  async function readAll() {
    await post("inbox/read");
    reload();
    refresh();
  }

  return (
    <main className="relative z-10 min-h-dvh px-4 pb-28 pt-[92px] md:px-6 md:pb-10">
      <div className="mx-auto max-w-[1300px]">
        <h1 className="display text-[44px] italic leading-none md:text-[56px]">For {meta?.me.name.split(" ")[0]}</h1>
        <p className="mt-3 max-w-[600px] text-[14px] text-muted">
          What needs your team&apos;s approval, answers of yours that the company has since changed, and what Orion remembers about how you work.
        </p>

        <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-4">
            <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE }} className="panel rounded-xl p-5">
              <Section title="Waiting for your approval" aside={meta?.me.team_name}>
                {!inbox?.approvals.length && <p className="text-[12px] text-faint">No plans need {meta?.me.team_name} right now.</p>}
                {inbox?.approvals.map((a) => (
                  <Link key={a.uid} href={`/multiverse?u=${a.uid}`} className="mb-2 flex items-center gap-3 rounded-lg border border-white/[0.07] p-3 transition-colors hover:border-white/20">
                    <span className="mono text-[22px]" style={{ color: LEVEL_COLOR[a.level] }}>{a.risk}</span>
                    <span className="flex-1">
                      <span className="block text-[13px]">{a.title}</span>
                      <span className="mono block text-[10px] text-faint">{a.uid} · proposed {a.at.replace("T", " ")}</span>
                    </span>
                    <span className="mono text-[11px] text-amber">review</span>
                  </Link>
                ))}
              </Section>
            </motion.section>

            <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE, delay: 0.08 }} className="panel rounded-xl p-5">
              <Section title="Answers that changed" aside={inbox?.notifications.some((n) => !n.read) ? <button onClick={readAll} className="hover:text-ink">mark all read</button> : undefined}>
                {!inbox?.notifications.length && <p className="text-[12px] text-faint">None of your answers have been touched by a change yet.</p>}
                {inbox?.notifications.map((n) => (
                  <button key={n.uid} onClick={() => get<Answer>(`answers/${n.answer}`).then(setOpen)}
                          className={`mb-2 block w-full rounded-lg border p-3 text-left transition-colors hover:border-white/20 ${n.read ? "border-white/[0.05] opacity-70" : "border-degrade/30 bg-degrade/[0.04]"}`}>
                    <div className="text-[10px] text-faint">{n.question}</div>
                    <div className="mt-0.5 text-[13px] text-ink/85">{n.sentence}</div>
                    <div className="mt-1 flex items-center gap-2"><StatusMark status={n.before} /><span className="text-faint">→</span><StatusMark status={n.after} />
                      <span className="mono ml-auto text-[10px] text-faint">{n.at.replace("T", " ")}</span></div>
                  </button>
                ))}
              </Section>
            </motion.section>

            {open && (
              <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="panel rounded-xl p-5">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="text-[12px] text-faint">{open.question}</div>
                  <button onClick={() => setOpen(null)} className="mono text-[11px] text-faint hover:text-ink">close</button>
                </div>
                <AnswerCard a={open} />
              </motion.section>
            )}
          </div>

          <div className="space-y-4">
            <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE, delay: 0.12 }} className="panel rounded-xl p-5">
              <Section title="Your questions" aside="kept between sessions">
                {!mine?.length && <p className="text-[12px] text-faint">Ask the Navigator something from the Sky.</p>}
                <div className="space-y-1.5">
                  {mine?.map((a) => (
                    <button key={a.uid} onClick={() => get<Answer>(`answers/${a.uid}`).then(setOpen)} className="flex w-full items-center gap-2 text-left">
                      <span className="flex gap-0.5">
                        {a.statuses.map((s, i) => <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[s] }} />)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink/85">{a.question}</span>
                      {a.status === "changed" && <span className="mono text-[10px] text-degrade">changed</span>}
                      <span className="mono text-[10px] text-faint">{a.at.slice(5).replace("T", " ")}</span>
                    </button>
                  ))}
                </div>
              </Section>
            </motion.section>

            <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE, delay: 0.16 }} className="panel rounded-xl p-5">
              <div className="mono text-[10px] tracking-[0.14em] text-faint">LOGBOOK · mem:corvane:{meta?.me.uid.split(":")[1]}</div>
              <p className="mt-1 text-[12px] text-muted">Your own memory graph. Nobody else can read it, not even other agents acting for other people.</p>
              <div className="mt-4 space-y-5">
                <Section title="What you told it to remember" aside="say “remember that …”">
                  {!mem?.beliefs.length && <p className="text-[12px] text-faint">Nothing yet.</p>}
                  {mem?.beliefs.map((b, i) => (
                    <div key={i} className={`text-[12px] ${b.valid_to === "9999-12-31" ? "text-ink/85" : "text-faint line-through"}`}>
                      {b.text} <span className="mono text-[10px] text-faint">{b.valid_from.slice(0, 10)}{b.valid_to !== "9999-12-31" ? ` – ${b.valid_to.slice(0, 10)}` : ""}</span>
                    </div>
                  ))}
                </Section>
                <Section title="How it learned to answer you" aside="procedures">
                  {!mem?.procedures.length && <p className="text-[12px] text-faint">It learns which tool sequences give checked answers.</p>}
                  {mem?.procedures.map((p, i) => (
                    <div key={i} className="mb-1.5 text-[11px]">
                      <span className="mono text-amber">{p.qtype}</span>{" "}
                      <span className="mono text-ink/75">{p.tools.join(" → ")}</span>{" "}
                      <span className="mono text-faint">{p.ok} ok{p.bad ? `, ${p.bad} not` : ""}</span>
                    </div>
                  ))}
                </Section>
                <Section title="Sessions">
                  {mem?.sessions.map((s) => (
                    <div key={s.uid} className="mb-1.5 text-[11px] text-muted">
                      <span className="mono text-faint">{s.last?.replace("T", " ")}</span> · {s.questions} questions · <span className="text-ink/70">{s.sample.join(" / ")}</span>
                    </div>
                  ))}
                </Section>
              </div>
            </motion.section>
          </div>
        </div>
      </div>
    </main>
  );
}
