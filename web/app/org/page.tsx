"use client";

import { useCallback, useMemo, useState } from "react";
import { useApp } from "@/components/AppProvider";
import LazyGraphCanvas from "@/components/graph/GraphCanvasLazy";
import { motion } from "motion/react";
import { Rise } from "@/components/motion";
import { Handle, Pane, Split, useMedia } from "@/components/Split";
import Departures from "@/components/org/Departures";
import { ErrorNote, Spinner } from "@/components/ui";
import { useFetch } from "@/lib/hooks";
import { C, GROUP_COLORS } from "@/lib/theme";
import type { Communities, GEdge, GNode, GraphPayload, ToolResponse } from "@/lib/types";


export default function OrgPage() {
  const { openBlame } = useApp();
  const comm = useFetch<ToolResponse<Communities>>("/communities");
  const graph = useFetch<GraphPayload>("/graph");
  const [focus, setFocus] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const active = pinned ?? focus;
  const wide = useMedia("(min-width: 1024px)");

  const c = comm.data?.result;
  const groups = useMemo(() => {
    if (!c) return [];
    const count: Record<string, number> = {};
    return c.discovered.map((g, i) => {
      // a group belongs to a team only when most of its people are on it; otherwise it cuts across teams
      const [top, n] = Object.entries(g.official_teams).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
      const main = n * 2 > g.size ? top : "Across teams";
      const split = main === "Across teams" || c.teams_that_work_as_several_groups.includes(main);
      count[main] = (count[main] ?? 0) + 1;
      return { ...g, i, team: main, name: split ? `${main} ${String.fromCharCode(64 + count[main])}` : main, split, color: GROUP_COLORS[i % GROUP_COLORS.length] };
    });
  }, [c]);
  const across = groups.filter((g) => g.team === "Across teams");

  const people = useMemo(() => (graph.data?.nodes ?? []).filter((n) => n.type === "Person" && !n.former), [graph.data]);
  const uidByName = useMemo(() => new Map(people.map((p) => [p.name ?? "", p.id])), [people]);
  const groupOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) for (const name of g.members) {
      const id = uidByName.get(name);
      if (id) m.set(id, g.i);
    }
    return m;
  }, [groups, uidByName]);

  const teams = useMemo(() => [...new Set(people.map((p) => p.team).filter(Boolean) as string[])].sort(), [people]);
  const teamOf = useMemo(() => new Map(people.map((p) => [p.name ?? "", p.team ?? ""])), [people]);
  const bridges = c?.bridges ?? [];
  const bridgeIds = useMemo(() => bridges.map((b) => uidByName.get(b.name)).filter(Boolean) as string[], [bridges, uidByName]);

  // which groups each bridge person actually collaborates into
  const bridgeReach = useMemo(() => {
    const out = new Map<string, Set<number>>();
    for (const id of bridgeIds) out.set(id, new Set());
    for (const e of graph.data?.edges ?? []) {
      if (e.type !== "COLLABORATES") continue;
      for (const [a, b] of [[e.source, e.target], [e.target, e.source]]) {
        const g = groupOf.get(b);
        if (out.has(a) && g !== undefined) out.get(a)!.add(g);
      }
    }
    return out;
  }, [bridgeIds, graph.data, groupOf]);

  const nodeFilter = useCallback((n: GNode) => n.type === "Person" && !n.former, []);
  const edgeFilter = useCallback((e: GEdge) => e.type === "COLLABORATES", []);
  const nodeColor = useCallback((n: GNode) => {
    const g = groupOf.get(n.id);
    return g === undefined ? C.ghost : GROUP_COLORS[g % GROUP_COLORS.length];
  }, [groupOf]);
  const nodeSize = useCallback((n: GNode) => (bridgeIds.includes(n.id) ? 9 : 5), [bridgeIds]);

  const highlight = useMemo(() => {
    if (active === null) return null;
    const g = groups[active];
    return g ? (g.members.map((m) => uidByName.get(m)).filter(Boolean) as string[]) : null;
  }, [active, groups, uidByName]);

  const splitTeams = c?.teams_that_work_as_several_groups ?? [];

  return (
    <Split id="org" vertical={!wide}>
      <Pane id="story" defaultSize={wide ? "48" : "55"} minSize={wide ? 400 : 200}>
      <section className="h-full min-h-0 overflow-y-auto px-7 py-7" aria-label="Official teams against the groups people actually work in">
        {(comm.loading && !c) && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Working out who actually works with whom
          </p>
        )}
        {comm.error && <ErrorNote error={comm.error} onRetry={comm.reload} />}
        {c && (
          <>
            <h2 className="heading text-[clamp(1.9rem,3vw,2.7rem)] leading-[1] tracking-[-0.025em]">
              {c.official_team_count} teams on paper.
              <br />
              {c.discovered_count} groups in practice.
            </h2>
            {across.map((g) => {
              const from = Object.keys(g.official_teams).sort();
              return (
                <Rise key={`across-${g.i}`} delay={0.05}>
                <p className="mt-5 max-w-[60ch] text-[14px] leading-[1.7] text-muted">
                  One group works across teams: <span style={{ color: g.color }}>{g.members.join(", ")}</span> work together
                  most of the time, though they sit on {from.slice(0, -1).join(", ")}
                  {from.length > 1 ? " and " : ""}
                  {from[from.length - 1]}. No org chart shows it.
                </p>
                </Rise>
              );
            })}
            {splitTeams.map((team) => {
              const gs = groups.filter((g) => (g.official_teams[team] ?? 0) > 0);
              const via = bridges.filter((b) => {
                const id = uidByName.get(b.name);
                const reach = id ? bridgeReach.get(id) : undefined;
                return reach && gs.filter((g) => reach.has(g.i)).length > 1;
              });
              return (
                <Rise key={team} delay={0.05}>
                <p className="mt-5 max-w-[60ch] text-[14px] leading-[1.7] text-muted">
                  <span className="text-ink">{team}</span> works as {gs.length} separate groups
                  {gs.map((g, k) => (
                    <span key={g.i}>
                      {k === 0 ? ": " : k === gs.length - 1 ? " and " : ", "}
                      <span style={{ color: g.color }}>{g.members.filter((m) => teamOf.get(m) === team).slice(0, 4).join(", ")}</span>
                      {g.team !== team && (
                        <span className="text-faint">{g.team === "Across teams" ? " (in the group across teams)" : ` (working inside ${g.team})`}</span>
                      )}
                    </span>
                  ))}
                  {via.length > 0 ? (
                    <>
                      . The groups only connect through{" "}
                      {via.map((b, k) => (
                        <span key={b.name}>
                          {k > 0 && " and "}
                          <span className="font-medium text-ink underline decoration-warn decoration-2 underline-offset-4">{b.name}</span>
                        </span>
                      ))}
                      , so if {via.length === 1 ? "they are" : "both are"} away, the groups stop talking.
                    </>
                  ) : (
                    "."
                  )}
                </p>
                </Rise>
              );
            })}

            {/* matrix */}
            <h3 className="pane-title mb-3 mt-9">
              <span>
                <span className="text-ink">Each official team</span>, split by the groups its people actually work in
              </span>
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-xs">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-night p-1.5 text-left font-normal text-faint" scope="col">
                      Team
                    </th>
                    {groups.map((g) => (
                      <th key={g.i} scope="col" className={`px-0.5 pb-1.5 text-center align-bottom text-[11px] font-medium leading-tight transition-opacity ${active !== null && active !== g.i ? "opacity-40" : ""}`} style={{ color: g.color }}>
                        <button
                          type="button"
                          className="rounded px-1 py-1 transition-colors hover:bg-raised"
                          onMouseEnter={() => setFocus(g.i)}
                          onMouseLeave={() => setFocus(null)}
                          onClick={() => setPinned(pinned === g.i ? null : g.i)}
                          aria-pressed={pinned === g.i}
                        >
                          {g.name}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {teams.map((team) => {
                    const split = splitTeams.includes(team);
                    return (
                      <tr key={team} className="relative">
                        <th scope="row" className={`sticky left-0 z-10 bg-night py-1.5 pl-2.5 pr-3 text-left font-medium ${split ? "text-warn" : "text-ink"}`}>
                          {split && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-warn" aria-hidden />}
                          {team}
                        </th>
                        {groups.map((g) => {
                          const n = g.official_teams[team] ?? 0;
                          return (
                            <td key={g.i} className={`border-t border-rule-soft px-0.5 py-1 text-center transition-opacity ${active !== null && active !== g.i ? "opacity-30" : ""}`}>
                              {n > 0 ? (
                                <motion.span
                                  initial={{ scale: 0.96, opacity: 0 }}
                                  animate={{ scale: 1, opacity: 1 }}
                                  transition={{ duration: 0.16, ease: "easeOut", delay: g.i * 0.02 }}
                                  className="mono inline-grid size-7 place-items-center rounded text-[11px] font-semibold"
                                  style={{ background: `${g.color}${split ? "3a" : "1f"}`, color: g.color, boxShadow: split ? `inset 0 0 0 1px ${C.partial}` : undefined }}
                                >
                                  {n}
                                </motion.span>
                              ) : (
                                <span className="mx-auto block size-1 rounded-full bg-rule" aria-hidden />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* groups */}
            <h2 className="pane-title mb-2 mt-9"><span className="text-ink">The groups people actually work in</span></h2>
            <ul>
              {groups.map((g) => (
                <li key={g.i}>
                  <button
                    type="button"
                    onMouseEnter={() => setFocus(g.i)}
                    onMouseLeave={() => setFocus(null)}
                    onClick={() => setPinned(pinned === g.i ? null : g.i)}
                    aria-pressed={pinned === g.i}
                    className={`relative w-full border-b border-rule-soft py-3 pl-4 pr-2 text-left transition-colors duration-200 ${active === g.i ? "bg-raised" : "hover:bg-raised/50"}`}
                  >
                    <span className="absolute inset-y-3 left-0 w-[2px] rounded-full transition-[opacity,transform] duration-[120ms]" style={{ background: g.color, opacity: active === g.i ? 1 : 0.6 }} aria-hidden />
                    <span className="flex items-baseline gap-2">
                      <span className="text-[13px] font-medium" style={{ color: active === g.i ? g.color : undefined }}>{g.name}</span>
                      <span className="text-xs text-muted">{g.size} people</span>
                      <span className={`ml-auto text-xs ${g.matches_team && !g.split ? "text-muted" : "text-warn"}`}>
                        {g.split ? `part of ${g.team}` : g.matches_team ? "matches its team" : "crosses teams"}
                      </span>
                    </span>
                    <span className="mt-1 block text-[12px] leading-relaxed text-muted">
                      {g.members.map((m, k) => {
                        const isBridge = bridges.some((b) => b.name === m && b.score > 5);
                        return (
                          <span key={m}>
                            {k > 0 && <span className="text-faint"> · </span>}
                            <span className={isBridge ? "text-ink underline decoration-warn decoration-2 underline-offset-[3px]" : ""}>{m}</span>
                          </span>
                        );
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-[12px] leading-relaxed text-muted">
              Groups come from who reviews whose work and shares tasks with whom over the last six months. Underlined
              people are bridges: much of the work between groups passes through them.
            </p>
          </>
        )}
        <Departures />
      </section>
      </Pane>
      <Handle label="Resize the text and the map" />
      <Pane id="graph" minSize={wide ? 320 : 180}>
      <section className="relative h-full min-h-0" aria-label="Who works with whom, coloured by the group they actually work in">
        <LazyGraphCanvas
          data={graph.data}
          layoutNs="org"
          nodeFilter={nodeFilter}
          edgeFilter={edgeFilter}
          nodeColor={nodeColor}
          nodeSize={nodeSize}
          highlight={highlight}
          highlightColor={active !== null ? groups[active]?.color : undefined}
          forceLabels={bridgeIds}
          fitToHighlight
          onEdgeClick={(e, s, t, g) => openBlame({ fact: e.uid ?? null, edge: e, sourceName: s?.name, targetName: t?.name, source: s, target: t, graph: g })}
          ariaLabel="Who works with whom, coloured by the group they actually work in"
        />
        <div className="hud pointer-events-none absolute left-3.5 top-3.5 max-w-[300px] px-3.5 py-3 text-xs">
          <p className="font-medium text-ink">Who actually works with whom</p>
          <p className="mt-1 leading-relaxed text-muted">
            Each dot is a person, coloured by the group they actually work in. Bridges are drawn larger, and thicker
            lines mean two people work together more.
          </p>
          {bridges.length > 0 && (
            <ul className="mt-2 space-y-0.5 border-t border-rule pt-2">
              {bridges.map((b) => (
                <li key={b.name}>
                  <span className="text-ink">{b.name}</span> <span className="text-faint">bridge between groups</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {graph.error && (
          <div className="absolute inset-x-6 top-28">
            <ErrorNote error={graph.error} onRetry={graph.reload} />
          </div>
        )}
      </section>
      </Pane>
    </Split>
  );
}
