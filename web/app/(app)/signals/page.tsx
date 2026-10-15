"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useCosmos } from "@/components/cosmos/CosmosProvider";
import { EASE, Initials, Section, Spinner, StatusMark } from "@/components/ui";
import { post, stream, StreamEvent } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useSession } from "@/lib/session";

type Msg = { uid: string; channel: string; at: string; text: string; author: string; author_uid: string; live: boolean | null };
type Deck = {
  agents: { name: string; role: string; status: string; beat: string }[];
  tasks: { uid: string; kind: string; status: string; agent: string; created: string; payload: Record<string, unknown>; result: Record<string, unknown> | null; follows: string | null; attempts: number }[];
};
type Review = { uid: string; change: Record<string, string>; author: string; authority: number; why: string; team: string; status: string; at: string };
type Recheck = { sentence: string; before: string; after: string; why: string; was: unknown; now: unknown; question: string };

const LIVE = "BILL-207 is merged: invoice-render now gets its signing token from identity. It no longer calls sso-legacy at all.";
const AGENTS = ["Cartographer", "Sentinel", "Verifier", "Navigator", "Simulator"] as const;

export default function SignalsPage() {
  const { meta, signIn, refresh } = useSession();
  const { engine, setVeil } = useCosmos();
  const { data: msgs, reload: reloadMsgs } = useApi<Msg[]>("messages");
  const { data: deck, reload: reloadDeck } = useApi<Deck>("deck");
  const { data: reviews, reload: reloadReviews } = useApi<Review[]>("reviews");
  const [text, setText] = useState("");
  const [channel, setChannel] = useState("#billing");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ t: string; text: string; tone?: string }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [packets, setPackets] = useState<{ id: number; from: string; to: string; color: string }[]>([]);
  const [rechecks, setRechecks] = useState<Recheck[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const pid = useRef(0);

  useEffect(() => {
    setVeil(0.6);
    engine?.setAutoRotate(true);
    return () => setVeil(0);
  }, [setVeil, engine]);

  function fly(from: string, to: string, color = "#ffb547") {
    const id = ++pid.current;
    setPackets((p) => [...p, { id, from, to, color }]);
    setTimeout(() => setPackets((p) => p.filter((x) => x.id !== id)), 1100);
  }

  async function send(body = text, ch = channel) {
    if (!body.trim()) return;
    setBusy(true);
    setErr(null);
    setLog([]);
    setRechecks([]);
    const say = (t: string, tone?: string) => setLog((l) => [...l, { t: new Date().toLocaleTimeString("en-GB"), text: t, tone }]);
    try {
      await stream("messages", { channel: ch, text: body }, (e: StreamEvent) => {
        if (e.type === "message") {
          say(`message ${e.uid} posted in ${ch}, naming ${(e.mentions as string[]).length} things in the graph`);
          fly("core", "Cartographer");
          setActive("Cartographer");
          (e.mentions as string[]).forEach((m, i) => setTimeout(() => engine?.flash(m, "#ffb547"), i * 150));
        }
        if (e.type === "extracted") {
          const cs = e.changes as Record<string, string>[];
          say(`Cartographer found ${cs.length} change${cs.length === 1 ? "" : "s"} of fact: ${cs.map((c) => `${c.op} ${c.service?.split(":")[1]} → ${c.on?.split(":")[1] ?? c.team?.split(":")[1]}`).join("; ")}`);
          fly("Cartographer", "Sentinel");
          setActive("Sentinel");
        }
        if (e.type === "sentinel") {
          const r = e.result as string;
          const c = e.change as Record<string, string>;
          say(`Sentinel: ${r} ${c.op} ${c.service?.split(":")[1]}${c.on ? " → " + c.on.split(":")[1] : ""} (authority ${Number(e.authority).toFixed(2)}, ${e.why})`,
              r === "applied" ? "ok" : r === "review" ? "amber" : "violet");
          if (r === "applied") {
            fly("Sentinel", "core", "#7ee0b5");
            setTimeout(() => fly("core", "Verifier", "#9fb7ff"), 500);
            setActive("Verifier");
            engine?.flash(c.service, "#7ee0b5");
          }
          const rc = (e.rechecked as Recheck[]) ?? [];
          if (rc.length) {
            setTimeout(() => {
              say(`Verifier re-checked the answers that relied on it: ${rc.length} claim${rc.length === 1 ? "" : "s"} changed`, "amber");
              rc.forEach((_, i) => setTimeout(() => fly("Verifier", "Navigator", "#ff9a3c"), i * 220));
              setActive("Navigator");
              setRechecks((x) => [...x, ...rc]);
            }, 900);
          }
        }
      });
      say("done");
      reloadMsgs();
      reloadDeck();
      reloadReviews();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setTimeout(() => setActive(null), 2500);
    }
  }

  async function asTomasz() {
    if (meta?.me.uid !== "person:tomasz-nowak") await signIn("person:tomasz-nowak");
    setChannel("#billing");
    setText(LIVE);
    setTimeout(() => send(LIVE, "#billing"), 300);
  }

  return (
    <main className="relative z-10 min-h-dvh px-4 pb-28 pt-[92px] md:px-6 md:pb-8">
      <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-4 lg:grid-cols-[360px_1fr_380px]">
        {/* the feed */}
        <motion.section initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.7, ease: EASE }}
                        className="panel flex max-h-[calc(100dvh-8.5rem)] flex-col overflow-hidden rounded-xl">
          <div className="border-b border-white/[0.06] p-4">
            <h1 className="display text-[30px] italic leading-none">Signals</h1>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              Corvane&apos;s chat, as it happens. Post something that changes a fact and watch the agents carry it into the graph.
            </p>
            <div className="mt-3 rounded-lg border border-white/[0.08] bg-black/25 p-2">
              <div className="flex items-center gap-2">
                <select value={channel} onChange={(e) => setChannel(e.target.value)} className="mono bg-transparent text-[11px] text-amber outline-none">
                  {["#billing", "#platform", "#runtime", "#signals", "#console", "#data", "#general"].map((c) => <option key={c} className="bg-surface">{c}</option>)}
                </select>
                <span className="mono ml-auto text-[10px] text-faint">as {meta?.me.name}</span>
              </div>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Write a message…"
                        className="mt-1 w-full resize-none bg-transparent text-[13px] leading-snug text-ink outline-none placeholder:text-faint" />
              <div className="flex items-center gap-2">
                <button onClick={() => send()} disabled={busy || !text.trim()} className="rounded-md bg-amber px-3 py-1 text-[12px] text-void disabled:opacity-40">Post</button>
                {busy && <Spinner label="agents at work" />}
              </div>
            </div>
            <button onClick={asTomasz} disabled={busy}
                    className="mt-2 w-full rounded-lg border border-amber/30 px-3 py-2 text-left text-[12px] text-ink/90 transition-colors hover:border-amber/60">
              <span className="mono block text-[10px] text-amber">THE DEMO MOMENT</span>
              Post Tomasz&apos;s update from #billing: BILL-207 is merged, invoice-render has moved off sso-legacy.
            </button>
            {err && <div className="mt-2 text-[12px] text-nova">{err}</div>}
          </div>
          <div className="scroll-quiet flex-1 space-y-3 overflow-y-auto p-4">
            {msgs?.map((m) => (
              <motion.div key={m.uid} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={`flex gap-2.5 ${m.live ? "rounded-lg bg-amber/[0.06] p-2" : ""}`}>
                <Initials name={m.author ?? "?"} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="mono flex gap-2 text-[10px] text-faint">
                    <span className="text-ink/70">{m.author}</span><span>{m.channel}</span><span className="ml-auto">{m.at.replace("T", " ").slice(2)}</span>
                  </div>
                  <div className="text-[12px] leading-snug text-ink/85">{m.text}</div>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.section>

        {/* the agents */}
        <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: EASE, delay: 0.1 }}
                        className="flex min-h-[520px] flex-col gap-4">
          <div className="panel relative flex-1 overflow-hidden rounded-xl">
            <div className="mono absolute left-4 top-3 z-10 text-[10px] tracking-[0.14em] text-faint">THE AGENTS, SHARING ONE GRAPH</div>
            <Constellation active={active} packets={packets} deck={deck} />
          </div>
          <div className="panel scroll-quiet max-h-[220px] overflow-y-auto rounded-xl p-4">
            <div className="mono mb-2 text-[10px] tracking-[0.14em] text-faint">{log.length ? "THIS MESSAGE" : "THE DECK: RECENT TASKS"}</div>
            {log.length > 0 ? (
              <div className="space-y-1.5">
                {log.map((l, i) => (
                  <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="mono flex gap-3 text-[11px]">
                    <span className="text-faint">{l.t}</span>
                    <span className={l.tone === "ok" ? "text-ok" : l.tone === "amber" ? "text-amber" : l.tone === "violet" ? "text-[#b48cff]" : "text-ink/80"}>{l.text}</span>
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="space-y-1">
                {deck?.tasks.slice(0, 14).map((t) => (
                  <div key={t.uid} className="mono flex gap-3 text-[11px]">
                    <span className="w-14 text-faint">{t.kind}</span>
                    <span className="w-24 text-ink/70">{t.agent}</span>
                    <span className={t.status === "done" ? "text-ok" : t.status === "dead" ? "text-nova" : "text-amber"}>{t.status}</span>
                    <span className="min-w-0 flex-1 truncate text-faint">{String(t.payload.question ?? t.payload.text ?? t.payload.title ?? t.payload.op ?? "")}</span>
                    {t.follows && <span className="text-faint">↳</span>}
                  </div>
                ))}
                {!deck?.tasks.length && <div className="text-[12px] text-faint">Nothing on the deck yet.</div>}
              </div>
            )}
          </div>
        </motion.section>

        {/* what changed */}
        <motion.section initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.7, ease: EASE, delay: 0.15 }}
                        className="panel scroll-quiet max-h-[calc(100dvh-8.5rem)] space-y-5 overflow-y-auto rounded-xl p-4">
          <Section title="Answers that changed under them" aside={rechecks.length ? `${rechecks.length}` : "re-checked by the graph"}>
            {!rechecks.length && <p className="text-[12px] leading-relaxed text-faint">
              When a fact changes, every claim that relied on it is checked again, with no model call. Ask the Navigator something
              about sso-legacy first, then post Tomasz&apos;s update.
            </p>}
            <AnimatePresence>
              {rechecks.map((r, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE, delay: i * 0.15 }}
                            className="mb-3 border-l-2 border-degrade/60 pl-3">
                  <div className="text-[10px] text-faint">{r.question}</div>
                  <motion.p initial={{ textDecorationColor: "rgba(255,77,46,0)" }} animate={{ textDecorationColor: "rgba(255,77,46,.7)" }} transition={{ delay: 0.6 + i * 0.15, duration: 0.6 }}
                            className="text-[13px] text-ink/70 line-through">{r.sentence}</motion.p>
                  <div className="mt-1 flex items-center gap-2"><StatusMark status={r.before} /><span className="text-faint">→</span><StatusMark status={r.after} /></div>
                  <div className="mono mt-1 text-[10px] text-muted">was {fmt(r.was)} · now {fmt(r.now)}</div>
                </motion.div>
              ))}
            </AnimatePresence>
          </Section>

          <Section title="Waiting for the owning team" aside="the Sentinel wouldn't apply these alone">
            {!reviews?.filter((r) => r.status === "waiting").length && <p className="text-[12px] text-faint">Nothing waiting.</p>}
            {reviews?.filter((r) => r.status === "waiting").map((r) => (
              <div key={r.uid} className="mb-2 rounded-md border border-white/[0.07] p-2.5 text-[12px]">
                <div className="mono text-[11px] text-ink/85">{r.change.op} {r.change.service?.split(":")[1]} {r.change.on ? `→ ${r.change.on.split(":")[1]}` : ""}</div>
                <div className="mt-0.5 text-[11px] text-faint">authority {r.authority.toFixed(2)}: {r.why}</div>
                {meta?.me.team === r.team && (
                  <div className="mt-2 flex gap-2">
                    <button onClick={async () => { await post(`reviews/${r.uid}`, { accept: true }); reloadReviews(); refresh(); }} className="rounded-full bg-ok/90 px-2.5 py-0.5 text-[11px] text-void">Accept</button>
                    <button onClick={async () => { await post(`reviews/${r.uid}`, { accept: false }); reloadReviews(); }} className="rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] text-muted">Reject</button>
                  </div>
                )}
              </div>
            ))}
          </Section>

          <Section title="How authority works">
            <p className="text-[12px] leading-relaxed text-muted">
              The Sentinel trusts a change most from the team that owns the service (0.95), less from anyone else (0.6), and half as much
              when the author hedges. At 0.8 or more it applies the change, with the message as its source. Below that, the owning team decides.
              The author is always the signed-in person, never a field in the request.
            </p>
          </Section>
        </motion.section>
      </div>
    </main>
  );
}

function fmt(v: unknown) {
  return Array.isArray(v) ? v.join(", ") || "nothing" : v === undefined || v === null ? "—" : String(v);
}

const POS: Record<string, [number, number]> = {
  core: [50, 52], Cartographer: [16, 26], Sentinel: [50, 12], Verifier: [84, 26], Navigator: [80, 82], Simulator: [20, 82],
};

function Constellation({ active, packets, deck }: { active: string | null; packets: { id: number; from: string; to: string; color: string }[]; deck: Deck | null }) {
  const counts = new Map<string, number>();
  for (const t of deck?.tasks ?? []) counts.set(t.agent, (counts.get(t.agent) ?? 0) + 1);
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
      <defs>
        <radialGradient id="core"><stop offset="0" stopColor="#fff6e8" /><stop offset="0.3" stopColor="#ffb547" stopOpacity="0.5" /><stop offset="1" stopColor="#ffb547" stopOpacity="0" /></radialGradient>
      </defs>
      {AGENTS.map((a) => (
        <line key={a} x1={POS.core[0]} y1={POS.core[1]} x2={POS[a][0]} y2={POS[a][1]} stroke="rgba(236,232,220,.1)" strokeWidth="0.25" strokeDasharray="0.8 0.8" />
      ))}
      <line x1={POS.Cartographer[0]} y1={POS.Cartographer[1]} x2={POS.Sentinel[0]} y2={POS.Sentinel[1]} stroke="rgba(236,232,220,.08)" strokeWidth="0.25" />
      <line x1={POS.Verifier[0]} y1={POS.Verifier[1]} x2={POS.Navigator[0]} y2={POS.Navigator[1]} stroke="rgba(236,232,220,.08)" strokeWidth="0.25" />
      {[10, 18, 26].map((r, i) => (
        <circle key={r} cx={POS.core[0]} cy={POS.core[1]} r={r} fill="none" stroke="rgba(236,232,220,.05)" strokeWidth="0.2">
          <animateTransform attributeName="transform" type="rotate" from={`0 50 52`} to={`${i % 2 ? -360 : 360} 50 52`} dur={`${60 + i * 30}s`} repeatCount="indefinite" />
        </circle>
      ))}
      <circle cx={POS.core[0]} cy={POS.core[1]} r="9" fill="url(#core)">
        <animate attributeName="r" values="8;10;8" dur="4s" repeatCount="indefinite" />
      </circle>
      <text x={POS.core[0]} y={POS.core[1] + 13} textAnchor="middle" fontSize="2.4" className="mono" fill="rgba(236,232,220,.55)">org:corvane</text>
      {AGENTS.map((a) => {
        const [x, y] = POS[a];
        const on = active === a;
        return (
          <g key={a}>
            {on && <circle cx={x} cy={y} r="6" fill="none" stroke="#ffb547" strokeWidth="0.3"><animate attributeName="r" values="4;8" dur="1s" repeatCount="indefinite" /><animate attributeName="opacity" values="1;0" dur="1s" repeatCount="indefinite" /></circle>}
            <circle cx={x} cy={y} r={on ? 2.6 : 1.9} fill={on ? "#ffb547" : "#ece8dc"} style={{ transition: "r .3s, fill .3s", filter: on ? "drop-shadow(0 0 2px #ffb547)" : undefined }} />
            <text x={x} y={y + 5.5} textAnchor="middle" fontSize="2.8" fill={on ? "#ffb547" : "rgba(236,232,220,.85)"} style={{ fontFamily: "var(--font-serif)", fontStyle: "italic" }}>{a}</text>
            <text x={x} y={y + 8.5} textAnchor="middle" fontSize="1.9" className="mono" fill="rgba(236,232,220,.4)">{counts.get(a) ?? 0} tasks</text>
          </g>
        );
      })}
      {packets.map((p) => (
        <motion.circle key={p.id} r="1.1" fill={p.color} initial={{ cx: POS[p.from][0], cy: POS[p.from][1], opacity: 1 }}
                       animate={{ cx: POS[p.to][0], cy: POS[p.to][1], opacity: [1, 1, 0.2] }} transition={{ duration: 0.9, ease: [0.65, 0, 0.35, 1] }}
                       style={{ filter: `drop-shadow(0 0 1.5px ${p.color})` }} />
      ))}
    </svg>
  );
}
