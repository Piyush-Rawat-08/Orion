"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useCosmos } from "@/components/cosmos/CosmosProvider";
import { RiskDial } from "@/components/RiskDial";
import { EASE, Magnetic, Section, Spinner, TeamDot } from "@/components/ui";
import { get, post } from "@/lib/api";
import { useApi, useGalaxy } from "@/lib/hooks";
import { EFFECT_COLOR, LEVEL_COLOR } from "@/lib/palette";
import { useSession } from "@/lib/session";
import type { Galaxy, Universe } from "@/lib/types";

const OPS: { op: string; label: string; args: { key: string; kind: "service" | "person" | "team"; label: string }[] }[] = [
  { op: "retire_service", label: "Retire a service", args: [{ key: "service", kind: "service", label: "service" }, { key: "replacement", kind: "service", label: "move dependents to (optional)" }] },
  { op: "outage", label: "A service goes down", args: [{ key: "service", kind: "service", label: "service" }] },
  { op: "remove_person", label: "Someone leaves", args: [{ key: "person", kind: "person", label: "person" }] },
  { op: "merge_teams", label: "Merge two teams", args: [{ key: "team", kind: "team", label: "team" }, { key: "into", kind: "team", label: "into" }] },
  { op: "move_ownership", label: "Hand a service to a team", args: [{ key: "service", kind: "service", label: "service" }, { key: "team", kind: "team", label: "team" }] },
  { op: "add_dependency", label: "Add a dependency", args: [{ key: "service", kind: "service", label: "service" }, { key: "on", kind: "service", label: "depends on" }] },
  { op: "remove_dependency", label: "Remove a dependency", args: [{ key: "service", kind: "service", label: "service" }, { key: "on", kind: "service", label: "stops depending on" }] },
];

const PRESETS: { label: string; changes: Record<string, string>[] }[] = [
  { label: "Retire sso-legacy", changes: [{ op: "retire_service", service: "sso-legacy" }] },
  { label: "Migrate sso-legacy to identity", changes: [{ op: "retire_service", service: "sso-legacy", replacement: "identity" }] },
  { label: "Ines leaves", changes: [{ op: "remove_person", person: "Ines Okafor" }] },
  { label: "secrets-vault goes down", changes: [{ op: "outage", service: "secrets-vault" }] },
  { label: "Merge Signals into Platform", changes: [{ op: "merge_teams", team: "Signals", into: "Platform" }] },
];

type Change = Record<string, string>;

export default function MultiversePage() {
  return (
    <Suspense>
      <Multiverse />
    </Suspense>
  );
}

function Multiverse() {
  const params = useSearchParams();
  const router = useRouter();
  const { meta, refresh } = useSession();
  const { engine, setVeil, setHandlers } = useCosmos();
  const { data: base } = useGalaxy();
  const { data: list, reload: reloadList } = useApi<Universe[]>("universes");
  const [changes, setChanges] = useState<Change[]>([{ op: "retire_service", service: "" }]);
  const [mode, setMode] = useState<"whatif" | "plan" | "backtest">("whatif");
  const [on, setOn] = useState("2026-03-02");
  const [u, setU] = useState<Universe | null>(null);
  const [twin, setTwin] = useState<Universe | null>(null);
  const [ug, setUg] = useState<Galaxy | null>(null);
  const [view, setView] = useState<"universe" | "base">("universe");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => setVeil(0), [setVeil]);
  useEffect(() => {
    setHandlers({ select: (n) => n && engine?.flash(n.id, "#ffb547") });
    return () => setHandlers({});
  }, [setHandlers, engine]);

  // the sky shows the company now until a universe is open
  useEffect(() => {
    if (engine && base && !u) {
      engine.blackHole(null);
      engine.clearBlast();
      engine.setFocus(null);
      engine.setData(base);
      engine.setConstellations(null);
    }
  }, [engine, base, u]);

  const names = useMemo(() => ({
    service: base?.services.map((s) => s.label) ?? [],
    person: base?.people.map((p) => p.label) ?? [],
    team: base?.teams.map((t) => t.label) ?? [],
  }), [base]);

  const show = useCallback(async (rec: Universe, opts: { warp?: boolean } = {}) => {
    setU(rec);
    setView("universe");
    setErr(null);
    let g: Galaxy | null = null;
    try {
      g = await get<Galaxy>(`universes/${rec.uid}/galaxy`);
    } catch {
      g = null; // merged or discarded: its graph is gone; show the diff over today's sky
    }
    setUg(g);
    if (!engine) return;
    if (opts.warp) engine.warp(1500);
    setTimeout(() => {
      engine.clearBlast();
      engine.setData(g ?? base!, { animate: true });
      engine.setConstellations(null);
      const d = rec.diff;
      const roots = d.retired.map((r) => r.uid);
      const focus = [...roots, ...d.breaks.map((b) => b.uid), ...d.customers.map((c) => c.uid), ...d.orphans.map((o) => o.uid)];
      engine.setFocus(focus.length ? focus : null);
      if (roots[0]) {
        engine.flyTo(roots[0], 150);
        setTimeout(() => engine.blackHole(roots[0]), 700);
      } else engine.home();
      setTimeout(() => {
        engine.blast(roots, d.breaks.map((b) => ({ uid: b.uid, effect: b.effect, depth: b.depth, path: b.path })));
        d.orphans.forEach((o, i) => setTimeout(() => engine.flash(o.uid, "#ffb547"), i * 200));
        d.customers.forEach((c, i) => setTimeout(() => engine.flash(c.uid, EFFECT_COLOR[c.effect]), 1600 + i * 90));
      }, 1500);
    }, opts.warp ? 650 : 0);
  }, [engine, base]);

  // deep links: ?u=u12 opens a universe, ?op=...&service=... prefills a change
  useEffect(() => {
    const uid = params.get("u");
    const op = params.get("op");
    if (uid) get<Universe>(`universes/${uid}`).then((r) => show(r)).catch(() => {});
    else if (op) {
      const c: Change = { op };
      params.forEach((v, k) => { if (k !== "op") c[k] = v; });
      setChanges([c]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  async function fork(cs: Change[] = changes) {
    const clean = cs.map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v)));
    if (!clean.length || clean.some((c) => Object.keys(c).length < 2)) {
      setErr("Fill in what each change is about.");
      return;
    }
    setBusy(true);
    setErr(null);
    setNote(null);
    setTwin(null);
    engine?.warp(1800);
    try {
      if (mode === "backtest") {
        const [known, truth] = await Promise.all([
          post<Universe>("universes", { changes: clean, on, mode: "known" }),
          post<Universe>("universes", { changes: clean, on, mode: "true" }),
        ]);
        setTwin(known);
        await show(truth);
      } else {
        const rec = await post<Universe>("universes", { changes: clean, kind: mode === "plan" ? "plan" : "whatif" });
        await show(rec, { warp: false });
      }
      reloadList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve(force = false) {
    if (!u) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await post<Universe & { result: string; message?: string; waiting_for?: { team_name: string }[] }>(`universes/${u.uid}/approve`, { force });
      setNote(
        r.result === "merged" ? "Merged. The change is now part of the company, with a decision as its source."
          : r.result === "approved" ? `Approved for your team. Still waiting for ${r.waiting_for?.map((w) => w.team_name).join(", ")}.`
          : r.message ?? r.result,
      );
      if (r.result === "merged") {
        engine?.warp(1200);
        await refresh();
      }
      const fresh = await get<Universe>(`universes/${u.uid}`);
      await show(fresh);
      reloadList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function flip(to: "universe" | "base") {
    setView(to);
    if (!engine || !base) return;
    if (to === "base") {
      engine.blackHole(null);
      engine.clearBlast();
      engine.setData(base);
    } else if (u) show(u);
  }

  const mine = meta?.me.team;
  const d = u?.diff;

  return (
    <main className="pointer-events-none relative z-10 min-h-dvh">
      {/* builder */}
      <motion.aside initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.7, ease: EASE }}
                    className={`panel scroll-quiet pointer-events-auto fixed bottom-24 left-4 top-[88px] z-20 w-[calc(100vw-2rem)] overflow-y-auto rounded-xl p-4 md:bottom-6 md:left-6 md:block md:w-[340px] ${u ? "hidden" : ""}`}>
        <h1 className="display text-[30px] italic leading-none">Multiverse</h1>
        <p className="mt-2 text-[12px] leading-relaxed text-muted">
          Fork the whole company into a parallel universe, change it there, and see what breaks before anyone has to.
        </p>

        <div className="mt-4 grid grid-cols-3 gap-1 rounded-lg border border-white/[0.06] p-1">
          {([["whatif", "What if"], ["plan", "Plan"], ["backtest", "Backtest"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setMode(k)}
                    className={`rounded-md py-1.5 text-[12px] transition-colors ${mode === k ? "bg-white/[0.08] text-ink" : "text-muted hover:text-ink"}`}>{l}</button>
          ))}
        </div>
        <p className="mono mt-2 text-[10px] leading-relaxed text-faint">
          {mode === "whatif" && "Nothing is changed. Look, then discard or keep."}
          {mode === "plan" && "A proposal: the teams the graph says are affected must approve before it merges."}
          {mode === "backtest" && "Fork the past twice: as it was known that day, and as it really was."}
        </p>
        {mode === "backtest" && (
          <label className="mt-3 flex items-center gap-2 text-[12px] text-muted">
            on <input type="date" value={on} min="2024-01-01" max="2026-09-30" onChange={(e) => setOn(e.target.value)}
                      className="mono rounded border border-white/10 bg-black/30 px-2 py-1 text-[12px] text-ink" />
          </label>
        )}

        <div className="mt-4 space-y-3">
          {changes.map((c, i) => {
            const spec = OPS.find((o) => o.op === c.op)!;
            return (
              <div key={i} className="rounded-lg border border-white/[0.07] bg-black/20 p-2.5">
                <div className="flex items-center gap-2">
                  <select value={c.op} onChange={(e) => setChanges(changes.map((x, j) => (j === i ? { op: e.target.value } : x)))}
                          className="flex-1 rounded bg-transparent text-[13px] text-ink outline-none">
                    {OPS.map((o) => <option key={o.op} value={o.op} className="bg-surface">{o.label}</option>)}
                  </select>
                  {changes.length > 1 && (
                    <button onClick={() => setChanges(changes.filter((_, j) => j !== i))} className="mono text-[11px] text-faint hover:text-nova">remove</button>
                  )}
                </div>
                {spec.args.map((a) => (
                  <input key={a.key} list={`names-${a.kind}`} value={c[a.key] ?? ""} placeholder={a.label}
                         onChange={(e) => setChanges(changes.map((x, j) => (j === i ? { ...x, [a.key]: e.target.value } : x)))}
                         className="mono mt-2 w-full rounded border border-white/[0.08] bg-black/30 px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-faint focus:border-amber/40" />
                ))}
              </div>
            );
          })}
          {(["service", "person", "team"] as const).map((k) => (
            <datalist key={k} id={`names-${k}`}>{names[k].map((n) => <option key={n} value={n} />)}</datalist>
          ))}
          <button onClick={() => setChanges([...changes, { op: "remove_person" }])} className="mono text-[11px] text-muted hover:text-ink">+ another change in the same universe</button>
        </div>

        <Magnetic onClick={() => fork()} disabled={busy}
                  className="mt-4 w-full rounded-lg bg-amber py-2.5 text-[14px] text-void shadow-[0_0_50px_-12px_#ffb547] disabled:opacity-50">
          {busy ? "Opening a universe…" : mode === "backtest" ? "Fork the past" : "Fork the company"}
        </Magnetic>
        {err && <div className="mt-2 text-[12px] text-nova">{err}</div>}

        <div className="mt-5">
          <div className="mono mb-1.5 text-[10px] tracking-[0.12em] text-faint">TRY</div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.label} onClick={() => { setChanges(p.changes); fork(p.changes); }} disabled={busy}
                      className="rounded-full border border-white/[0.08] px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-amber/30 hover:text-ink">
                {p.label}
              </button>
            ))}
            <button onClick={() => { setMode("backtest"); setOn("2026-03-02"); const c = [{ op: "retire_service", service: "sso-legacy" }]; setChanges(c); }}
                    className="rounded-full border border-amber/25 px-2.5 py-1 text-[11px] text-amber hover:border-amber/50">
              Would Orion have predicted INC-311?
            </button>
          </div>
        </div>

        <div className="mt-6">
          <div className="mono mb-2 text-[10px] tracking-[0.12em] text-faint">UNIVERSES</div>
          <div className="space-y-1">
            {(list ?? []).map((x) => (
              <button key={x.uid} onClick={() => get<Universe>(`universes/${x.uid}`).then((r) => show(r, { warp: true }))}
                      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04] ${u?.uid === x.uid ? "bg-white/[0.05]" : ""}`}>
                <span className="mono w-9 text-[10px] text-faint">{x.uid}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink/85">{x.title}</span>
                <span className="mono text-[11px]" style={{ color: LEVEL_COLOR[x.level] }}>{x.risk}</span>
                <span className="mono w-14 text-right text-[10px] text-faint">{x.kind === "backtest" ? "backtest" : x.status}</span>
              </button>
            ))}
            {!list?.length && <div className="text-[12px] text-faint">None yet. Fork something.</div>}
          </div>
        </div>
      </motion.aside>

      {/* universe / base switch */}
      <AnimatePresence>
        {u && ug && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                      className="pointer-events-auto fixed left-1/2 top-[84px] z-20 hidden -translate-x-1/2 md:block">
            <div className="flex items-center gap-1 rounded-full border border-white/[0.08] bg-[#070a13]/80 p-1 backdrop-blur-xl">
              <button onClick={() => flip("base")} className={`rounded-full px-3 py-1 text-[12px] ${view === "base" ? "bg-white/[0.09] text-ink" : "text-muted"}`}>The company now</button>
              <span className="mono px-1 text-[10px] text-faint">⇄</span>
              <button onClick={() => flip("universe")} className={`rounded-full px-3 py-1 text-[12px] ${view === "universe" ? "bg-amber/90 text-void" : "text-muted"}`}>
                Universe {u.uid}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* the diff */}
      <AnimatePresence mode="wait">
        {u && d && (
          <motion.aside key={u.uid + u.status + u.risk} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }}
                        transition={{ duration: 0.6, ease: EASE }}
                        className="panel scroll-quiet pointer-events-auto fixed bottom-24 left-4 right-4 top-[88px] z-20 overflow-y-auto rounded-xl p-4 md:bottom-6 md:left-auto md:right-6 md:top-[132px] md:w-[390px]">
            <button onClick={() => { setU(null); setUg(null); }} className="mono mb-2 text-[11px] text-amber md:hidden">← fork something else</button>
            <div className="mono flex justify-between text-[10px] text-faint">
              <span>UNIVERSE {u.uid.toUpperCase()} · {u.kind}{u.on ? ` · ${u.on} · as ${u.mode === "known" ? "known" : "it was"}` : ""}</span>
              <span>{u.status}</span>
            </div>
            <h2 className="display mt-1 text-[22px] leading-tight">{u.title}</h2>

            <div className="mt-3 flex items-center gap-4">
              {twin ? (
                <div className="flex items-end gap-1">
                  <div className="text-center">
                    <RiskDial score={twin.risk} level={twin.level} size={150} label="known" />
                  </div>
                  <div className="text-center">
                    <RiskDial score={u.risk} level={u.level} size={150} label="true" />
                  </div>
                </div>
              ) : (
                <RiskDial score={u.risk} level={u.level} />
              )}
              {!twin && (
                <div className="mono space-y-1.5 text-[10px] text-faint">
                  <div><span className="text-ink/80">{d.breaks.filter((b) => b.effect === "break").length}</span> break</div>
                  <div><span className="text-ink/80">{d.breaks.filter((b) => b.effect !== "break").length}</span> degrade</div>
                  <div><span className="text-ink/80">{d.customers.length}</span> customers</div>
                  <div><span className="text-ink/80">{d.orphans.length}</span> unknown</div>
                  <div className="pt-1">forked in {u.ms?.total ?? "?"} ms</div>
                  <div>GRAPH.COPY {u.ms?.copy ?? "?"} ms</div>
                </div>
              )}
            </div>
            {twin && (
              <p className="mt-2 text-[12px] leading-relaxed text-muted">
                With what Corvane knew on {u.on}, this scored <b style={{ color: LEVEL_COLOR[twin.level] }}>{twin.risk}</b>. With what was really true,{" "}
                <b style={{ color: LEVEL_COLOR[u.level] }}>{u.risk}</b>.{" "}
                {d.breaks.some((b) => !twin.diff.breaks.find((x) => x.uid === b.uid)) &&
                  `The difference: ${d.breaks.filter((b) => !twin.diff.breaks.find((x) => x.uid === b.uid)).map((b) => b.name).join(", ")}, through a dependency nobody had written down.`}
              </p>
            )}

            {note && <div className="mt-3 rounded-md border border-amber/25 bg-amber/[0.06] px-3 py-2 text-[12px] text-ink/85">{note}</div>}
            {u.rebased_from !== undefined && u.rebased_from !== null && (
              <div className="mono mt-2 text-[11px] text-degrade">rebased: risk {u.rebased_from} → {u.risk}</div>
            )}

            <div className="mt-5 space-y-5">
              <Section title="Where the points come from" aside={`= ${d.risk.score}`}>
                <div className="space-y-1">
                  {d.risk.terms.slice(0, 10).map((t, i) => (
                    <button key={i} onMouseEnter={() => t.entity && engine?.flash(t.entity, "#ffb547")}
                            className="group flex w-full items-center gap-2 text-left">
                      <span className="relative h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-white/[0.06]">
                        <motion.span initial={{ width: 0 }} animate={{ width: `${Math.min(100, (t.points / 25) * 100)}%` }}
                                     transition={{ duration: 0.9, ease: EASE, delay: 0.4 + i * 0.05 }}
                                     className="absolute inset-y-0 left-0 rounded-full" style={{ background: t.term === "customer" ? "#d9d2c3" : t.term === "orphan" ? "#ffb547" : "#ff4d2e" }} />
                      </span>
                      <span className="mono w-9 shrink-0 text-right text-[11px] text-ink/80">+{t.points}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted group-hover:text-ink">{t.label}</span>
                    </button>
                  ))}
                  {!d.risk.terms.length && <div className="text-[12px] text-ok">Nothing breaks, nobody is exposed, no knowledge is lost.</div>}
                </div>
              </Section>

              {d.breaks.length > 0 && (
                <Section title="What breaks, and the path that proves it">
                  <div className="space-y-2">
                    {d.breaks.map((b) => (
                      <button key={b.uid} className="block w-full text-left"
                              onClick={() => engine?.blast(b.path.slice(-1), [{ uid: b.uid, effect: b.effect, depth: b.depth, path: b.path }], { hop: 500 })}>
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: EFFECT_COLOR[b.effect], boxShadow: `0 0 8px ${EFFECT_COLOR[b.effect]}` }} />
                          <span className="mono text-[12px] text-ink">{b.name}</span>
                          <span className="mono text-[10px]" style={{ color: EFFECT_COLOR[b.effect] }}>{b.effect}s</span>
                          <span className="mono ml-auto text-[10px] text-faint">tier {b.tier} · {b.owner_name}</span>
                        </div>
                        <div className="mono mt-0.5 pl-3.5 text-[10px] text-faint">{b.path_names.join(" → ")}</div>
                      </button>
                    ))}
                  </div>
                </Section>
              )}

              {d.customers.length > 0 && (
                <Section title="Customers it reaches" aside={`${d.customers.length}`}>
                  <div className="space-y-1">
                    {d.customers.map((c) => (
                      <div key={c.uid} className="flex items-center gap-2 text-[12px]">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: EFFECT_COLOR[c.effect] }} />
                        <span className="text-ink/85">{c.name}</span>
                        <span className="mono text-[10px] text-faint">{c.tier}</span>
                        <span className="mono ml-auto truncate text-[10px] text-faint">{c.tickets.join(" ") || c.via.join(", ")}</span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {d.orphans.length > 0 && (
                <Section title="What nobody would know">
                  {d.orphans.map((o) => (
                    <div key={o.uid} className="text-[12px] text-muted">
                      <span className="mono text-amber">{o.name}</span> (tier {o.tier}): only {o.knew.join(", ")} knew it.
                    </div>
                  ))}
                </Section>
              )}

              {(d.splits.length > 0 || d.bottlenecks.shifted || d.stranded.length > 0) && (
                <Section title="How the people graph shifts">
                  {d.splits.map((s, i) => <div key={i} className="text-[12px] text-muted">A group of {s.before} who work together falls into {s.parts}.</div>)}
                  {d.stranded.map((s, i) => <div key={i} className="text-[12px] text-muted">Lose every path to a team: {s.services.map((x) => x.name).join(", ")}.</div>)}
                  {d.bottlenecks.shifted && (
                    <div className="mono mt-1 text-[10px] text-faint">
                      bottlenecks: {d.bottlenecks.before.map((p) => p.name.split(" ")[0]).join(", ")} → {d.bottlenecks.after.map((p) => p.name.split(" ")[0]).join(", ")}
                    </div>
                  )}
                </Section>
              )}

              {u.kind !== "backtest" && u.kind !== "outage" && (
                <Section title="Who has to agree" aside="from the diff, not a list">
                  <div className="space-y-2">
                    {d.approvals.map((a) => {
                      const ok = u.approvals.find((x) => x.team === a.team);
                      return (
                        <div key={a.team} className="flex items-start gap-2.5">
                          <span className="mt-1.5"><TeamDot team={a.team} /></span>
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] text-ink/90">{a.team_name}</div>
                            <div className="text-[11px] text-faint">{a.why.join("; ")}</div>
                          </div>
                          <span className={`mono text-[10px] ${ok ? "text-ok" : "text-faint"}`}>{ok ? `✓ ${ok.by_name.split(" ")[0]}` : "waiting"}</span>
                        </div>
                      );
                    })}
                  </div>
                  {u.status === "open" && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {mine && u.required.includes(mine) && !u.approvals.find((x) => x.team === mine) && (
                        <button onClick={() => approve()} disabled={busy} className="rounded-full bg-ok/90 px-3 py-1.5 text-[12px] text-void">
                          Approve for {meta?.me.team_name}
                        </button>
                      )}
                      {d.dangling.length > 0 && u.approvals.length >= d.approvals.length && (
                        <button onClick={() => approve(true)} disabled={busy} className="rounded-full border border-nova/50 px-3 py-1.5 text-[12px] text-nova">
                          Merge anyway, keep the breakage visible
                        </button>
                      )}
                      <button onClick={async () => { await post(`universes/${u.uid}/discard`); setU(null); setUg(null); reloadList(); router.replace("/multiverse"); }}
                              className="rounded-full border border-white/10 px-3 py-1.5 text-[12px] text-muted hover:text-ink">
                        Discard
                      </button>
                    </div>
                  )}
                  {d.dangling.length > 0 && (
                    <div className="mono mt-2 text-[10px] leading-relaxed text-nova/80">
                      blocks a clean merge: {d.dangling.map((x) => `${x.dependent_name} → ${x.on_name}`).join(", ")}
                    </div>
                  )}
                  {u.status === "merged" && <div className="mono mt-2 text-[11px] text-ok">merged as {u.decision}</div>}
                  {u.status === "obsolete" && <div className="mono mt-2 text-[11px] text-faint">obsolete: {u.reason}</div>}
                </Section>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {busy && !u && (
        <div className="pointer-events-none fixed inset-0 z-10 flex items-center justify-center">
          <Spinner label="copying the company" />
        </div>
      )}
    </main>
  );
}
