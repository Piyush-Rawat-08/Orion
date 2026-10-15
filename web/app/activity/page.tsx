"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Empty, ErrorNote, Spinner } from "@/components/ui";
import { useFetch } from "@/lib/hooks";
import { fmtMs, plural } from "@/lib/format";
import { C, NODE_COLORS, UNIVERSE_ACCENTS } from "@/lib/theme";
import type { Activity, Stats } from "@/lib/types";
import { agentName, scenarioText, TASK_STATUS_WORD, TASK_WORD } from "@/lib/words";

/** Who did a job: "inline:83831" ran inside the server; "simulator-2" is one of the simulators. */
function workerWord(w: string): string {
  if (w.startsWith("inline")) return "The server, directly";
  const [role] = w.split("-");
  return agentName(w, role);
}

function freshness(ageMs: number) {
  if (ageMs < 6000) return { color: C.verified, text: "running" };
  if (ageMs < 20000) return { color: C.partial, text: "slow to respond" };
  return { color: C.bad, text: "not responding" };
}

function graphTone(graph: string) {
  if (graph.startsWith("universe:")) return NODE_COLORS.Project;
  if (graph.startsWith("snap:")) return NODE_COLORS.Service;
  if (graph.startsWith("ops:")) return NODE_COLORS.Decision;
  if (graph.startsWith("mem")) return UNIVERSE_ACCENTS[3];
  return C.trunk;
}

/** An ECG trace that beats each time the worker heartbeats. */
function Pulse({ color, beat }: { color: string; beat: number }) {
  return (
    <svg width="64" height="18" viewBox="0 0 64 18" fill="none" aria-hidden>
      <path d="M0 9h22l3-6 4 12 3-9 2 3h30" stroke={color} strokeOpacity="0.18" strokeWidth="1.3" />
      <motion.path
        key={beat}
        d="M0 9h22l3-6 4 12 3-9 2 3h30"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0, opacity: 1 }}
        animate={{ pathLength: 1, opacity: 0.25 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      />
    </svg>
  );
}

export default function ActivityPage() {
  const act = useFetch<Activity>("/activity", 2000);
  const stats = useFetch<Stats>("/stats", 10000);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const a = act.data;
  // tasks grouped into chains (a message's extract -> apply, an ask's forks), newest chain first
  const chains = useMemo(() => {
    const by = new Map<string, Activity["tasks"]>();
    for (const t of a?.tasks ?? []) by.set(t.root ?? t.uid, [...(by.get(t.root ?? t.uid) ?? []), t]);
    return [...by.values()]
      .map((ts) => ts.sort((x, y) => x.created_at - y.created_at))
      .sort((x, y) => y[y.length - 1].created_at - x[x.length - 1].created_at);
  }, [a?.tasks]);
  // the server's clock, advanced locally between polls, so ages tick smoothly
  const serverNow = a ? a.now + (now - (act.at ?? now)) : now;
  const maxMs = Math.max(1, ...(a?.queries ?? []).map((q) => q.ms));
  // the agents' queries, grouped by the board task they ran for (newest group first)
  const byTask = useMemo(() => {
    const kindOf = new Map((a?.tasks ?? []).map((t) => [t.uid, t.kind]));
    const groups: { task: string | null; kind?: string; qs: Activity["queries"] }[] = [];
    for (const q of a?.queries ?? []) {
      const last = groups[groups.length - 1];
      if (last && last.task === q.task) last.qs.push(q);
      else groups.push({ task: q.task, kind: q.task ? kindOf.get(q.task) : undefined, qs: [q] });
    }
    return groups;
  }, [a?.queries, a?.tasks]);
  const workers = stats.data?.workers ?? 0;

  return (
    <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-[1440px] space-y-10 px-6 py-7">
      {act.error && <ErrorNote error={act.error} onRetry={act.reload} />}

      {stats.data && (
        <dl className="grid grid-cols-2 gap-y-6 xl:grid-cols-4">
          {(
            [
              ["what-ifs tested", stats.data.universes, ""],
              ["connections on record", stats.data.relationships, ""],
              ["updates to the records", stats.data.version, ""],
              ["to copy the whole company", stats.data.copy_ms_median ?? 0, " ms"],
            ] as [string, number, string, string?][]
          ).map(([k, v, unit, pre], i) => (
            <div key={k} className={`px-5 ${i % 2 ? "border-l border-rule" : i ? "xl:border-l xl:border-rule" : ""}`}>
              <dd className="text-[28px] font-semibold leading-none tracking-[-0.02em] tnum">
                {pre}
                {v.toFixed(unit === " ms" && v < 100 ? 1 : 0)}
                <span className="text-[15px] font-normal text-muted">{unit}</span>
              </dd>
              <dt className="mt-2 text-[12px] text-muted">{k}</dt>
            </div>
          ))}
        </dl>
      )}

      <div className="grid gap-10 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-10">
          <section aria-labelledby="agents-h">
            <h2 id="agents-h" className="pane-title mb-3">
              <span className="text-ink">Assistants</span>
              {workers > 0 && (
                <span className="inline-flex items-center gap-1.5 text-ink">
                  <span className="live size-[6px] rounded-full bg-ok text-ok" aria-hidden />
                  {workers} {workers === 1 ? "simulator" : "simulators"} running
                </span>
              )}
              <span className="text-muted">each checks in every 5 seconds</span>
              {act.loading && <Spinner size={11} className="text-faint" />}
            </h2>
            {!a && !act.error && <p className="text-sm text-muted">Loading…</p>}
            <ul className="grid gap-2 sm:grid-cols-2">
              {a?.agents.map((ag) => {
                const age = serverNow - ag.heartbeat_at;
                const f = freshness(age);
                return (
                  <li key={ag.name} className="rounded-xl border border-rule bg-panel px-4 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <span key={ag.heartbeat_at} className="beat size-2 rounded-full" style={{ background: f.color, color: f.color }} aria-hidden />
                      <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[13px] font-medium" title={ag.name}>{agentName(ag.name, ag.role)}</span>
                      <span className="shrink-0 text-xs" style={{ color: ag.status === "busy" ? C.partial : C.muted }}>
                        {ag.status === "busy" ? "working" : ag.status === "idle" ? "ready" : ag.status}
                      </span>
                    </div>
                    <p className="mt-1.5 flex items-center gap-3 text-xs text-muted">
                      <span style={{ color: f.color }}>{f.text}</span>
                      <Pulse color={f.color} beat={ag.heartbeat_at} />
                      <span className="ml-auto whitespace-nowrap">checked in {(age / 1000).toFixed(0)} s ago</span>
                    </p>
                  </li>
                );
              })}
              {a && !a.agents.length && (
                <li className="sm:col-span-2">
                  <Empty title="The assistants aren't running.">
                    They start with the Orion server. If you run it yourself, start it with{" "}
                    <span className="mono text-ink">make api</span>.
                  </Empty>
                </li>
              )}
            </ul>
          </section>

          <section aria-labelledby="tasks-h">
            <h2 id="tasks-h" className="pane-title mb-3">
              <span className="text-ink">Jobs</span> <span className="text-faint">newest first; a job started by another sits under it</span>
            </h2>
            <div className="overflow-x-auto rounded-xl border border-rule">
              <table className="w-full whitespace-nowrap text-xs">
                <thead className="bg-panel text-left text-[11px] text-faint">
                  <tr>
                    <th className="px-3 py-2 font-medium">Job</th>
                    <th className="px-3 py-2 font-medium">Done by</th>
                    <th className="px-3 py-2 text-right font-medium">Waited</th>
                    <th className="px-3 py-2 text-right font-medium">Took</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {chains.flat().map((t) => {
                    const wait = t.claimed_at ? t.claimed_at - t.created_at : serverNow - t.created_at;
                    const ran = t.done_at && t.claimed_at ? t.done_at - t.claimed_at : t.claimed_at ? serverNow - t.claimed_at : null;
                    const color = t.status === "done" ? C.verified : t.status === "failed" ? C.bad : t.status === "claimed" ? C.partial : C.muted;
                    return (
                      <tr key={t.uid} className={`border-t border-rule-soft ${t.status === "claimed" || t.status === "open" ? "scanning" : ""}`}>
                        <td className={`px-3 py-1.5 ${t.follows ? "pl-7" : ""}`}>
                          {t.follows && <span className="mono text-faint">↳ </span>}
                          <span className="text-ink">{TASK_WORD[t.kind] ?? t.kind}</span>{" "}
                          <span style={{ color }}>{TASK_STATUS_WORD[t.status] ?? t.status}</span>
                          {(t.attempts ?? 0) > 1 && <span className="text-warn"> (try {t.attempts})</span>}
                        </td>
                        <td className="px-3 py-1.5">{t.worker ? workerWord(t.worker) : <span className="text-faint">not started</span>}</td>
                        <td className="mono px-3 py-1.5 text-right text-muted">{fmtMs(wait)}</td>
                        <td className="mono px-3 py-1.5 text-right">{ran === null ? "—" : fmtMs(ran)}</td>
                        <td className="max-w-[22rem] truncate px-3 py-1.5 text-muted" title={t.summary ? scenarioText(t.summary) : ""}>
                          {t.summary ? scenarioText(t.summary) : ""}
                        </td>
                      </tr>
                    );
                  })}
                  {a && !a.tasks.length && (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-muted">
                        No jobs yet. Ask a question, post a message in Inbox, or test a what-if: each becomes a job one of
                        the assistants picks up.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <details aria-labelledby="q-h" className="min-w-0 self-start">
          <summary className="cursor-pointer">
            <h2 id="q-h" className="pane-title inline">
              <span className="text-ink">Technical log</span>{" "}
              <span className="text-muted">every database lookup the assistants ran, for engineers</span>
            </h2>
          </summary>
          {a && !a.queries.length && <p className="mt-3 text-xs text-muted">No lookups since the server started.</p>}
          <div className="mt-3 space-y-4">
            {byTask.map((g, gi) => (
              <div key={`${g.task ?? "none"}-${gi}`}>
                <p className="mb-1.5 flex items-baseline gap-2 text-[12px]">
                  {g.task ? (
                    <>
                      <span className="font-medium text-ink">{TASK_WORD[g.kind ?? ""] ?? g.kind ?? "job"}</span>
                      <span className="mono text-[11px] text-faint">{g.task}</span>
                    </>
                  ) : (
                    <span className="font-medium text-ink">Not part of a job</span>
                  )}
                  <span className="ml-auto text-muted">{plural(g.qs.length, "lookup")}</span>
                </p>
                <ol className="overflow-hidden rounded-xl border border-rule bg-well">
                  {g.qs.map((q) => (
                    <li key={`${q.at}-${q.graph}-${q.ms}`} className="border-b border-rule-soft last:border-b-0">
                      <details>
                        <summary className="grid cursor-pointer grid-cols-[minmax(0,9rem)_1fr_4.5rem_5.5rem] items-center gap-3 px-3.5 py-2 text-xs transition-colors hover:bg-raised/50">
                          <span className="mono truncate" style={{ color: graphTone(q.graph) }} title={q.graph}>
                            {q.graph}
                          </span>
                          <span className="mono truncate text-muted">{q.cypher.replace(/\s+/g, " ")}</span>
                          <span className="text-right text-muted">
                            {q.rows} {q.rows === 1 ? "row" : "rows"}
                          </span>
                          <span className="flex items-center justify-end gap-1.5">
                            <span className="h-1 rounded-full" style={{ width: `${Math.max(2, (q.ms / maxMs) * 36)}px`, background: q.read_only ? C.muted : C.ember }} aria-hidden />
                            <span className="mono">{fmtMs(q.ms)}</span>
                          </span>
                        </summary>
                        <pre tabIndex={0} className="overflow-x-auto border-t border-rule-soft px-3 py-2 text-[11px] leading-relaxed text-muted">
                          <code>{q.cypher}</code>
                        </pre>
                        <p className="border-t border-rule-soft px-3 py-1 text-[11px] text-muted">
                          {q.read_only ? "GRAPH.RO_QUERY" : "GRAPH.QUERY (write)"}
                        </p>
                      </details>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
    </div>
  );
}
