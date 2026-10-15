"use client";

// Repo mode: public GitHub repositories loaded as their own read-only company graphs. Modules are the
// services, contributors are the people. Knowledge is shown as counts per module, never as people at risk.

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import LazyGraphCanvas from "@/components/graph/GraphCanvasLazy";
import { useApp } from "@/components/AppProvider";
import { Handle, Pane, Split, useMedia } from "@/components/Split";
import { Empty, ErrorNote, LegendDot, Spinner, UniverseTag } from "@/components/ui";
import { post } from "@/lib/api";
import { useFetch } from "@/lib/hooks";
import { fmtDate, fmtMs, plural } from "@/lib/format";
import { edgeKey } from "@/lib/graph";
import { C, KIND_COLORS, NODE_COLORS, universeAccent } from "@/lib/theme";
import type { Diff, GEdge, GNode, GraphPayload, Tenant } from "@/lib/types";

/** Kinds of folder in a project, in words. */
const PART_WORD: Record<string, string> = {
  code: "code",
  test: "tests",
  docs: "documentation",
  build: "build setup",
  config: "settings",
  ci: "automatic checks",
};

interface Receipt {
  graph: string;
  query: string;
  cypher: string;
  params: Record<string, unknown>;
  asof?: string;
}
interface Pair {
  a_uid: string;
  a: string;
  b_uid: string;
  b: string;
  together: number;
  jaccard: number;
  a_changes: number;
  b_changes: number;
  owners_a: string[];
  owners_b: string[];
  coupled_since: string | null;
  cross_tree: boolean;
}
interface ModuleKnowledge {
  uid: string;
  module: string;
  kind: string;
  tier: number;
  changes: number;
  authors: number;
  knowers: number;
  top_author_share: number;
}
interface Insights {
  tenant: string;
  asof: string;
  kinds: string[];
  hidden_coupling: { pairs: Pair[]; receipt: Receipt; note?: string };
  knowledge_concentration: {
    modules: ModuleKnowledge[];
    summary: Record<string, number>;
    receipt: Receipt;
    note?: string;
  };
  ms: number;
}
interface Impact {
  retired: string;
  uid: string;
  module: string;
  kind: string;
  tier: number;
  together: number;
  jaccard: number;
  share_of_retired_prs: number;
  knowers: number;
  know_both: number;
  owners: string[];
}
interface WhatIf {
  universe: string;
  graph: string;
  title: string;
  copy_ms: number;
  apply_ms: number;
  fork_ms: number;
  cochange_impact: Impact[];
  cochange_receipt: Receipt;
  diff: Pick<Diff, "risk" | "structural" | "diff_ms">;
}


function ReceiptView({ r, ms }: { r: Receipt; ms?: number }) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-faint transition-colors hover:text-ink">
        Technical details <span className="text-faint">(the lookup behind this{ms !== undefined ? `, ${fmtMs(ms)}` : ""})</span>
      </summary>
      <pre tabIndex={0} className="mt-2 overflow-x-auto rounded-lg border border-rule bg-well p-3 text-[11px] leading-relaxed text-muted">
        <code>{r.cypher}</code>
      </pre>
      {Object.keys(r.params ?? {}).length > 0 && (
        <p className="mono mt-1 break-all text-[11px] text-faint">params {JSON.stringify(r.params)}</p>
      )}
    </details>
  );
}

const SUMMARY_LABELS: [string, string][] = [
  ["active_modules", "Active parts"],
  ["known_by_nobody", "Known by nobody"],
  ["known_by_one", "Known by one person"],
  ["known_by_two", "Known by two"],
  ["known_by_three_or_more", "Known by three or more"],
  ["dominated_by_one_author", "Mostly one person's work"],
];

function Repos() {
  const params = useSearchParams();
  const router = useRouter();
  const { openBlame } = useApp();
  const tenants = useFetch<Tenant[]>("/api/tenants");
  const repos = useMemo(() => (tenants.data ?? []).filter((t) => t.kind === "repo"), [tenants.data]);
  const selected = params.get("t") ?? repos[0]?.id ?? null;
  const select = (id: string) => router.replace(`/repos?t=${encodeURIComponent(id)}`, { scroll: false });

  const graph = useFetch<GraphPayload>(selected ? `/api/${selected}/graph` : null);
  const insights = useFetch<Insights>(selected ? `/api/${selected}/insights` : null);

  const [url, setUrl] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestErr, setIngestErr] = useState<string | null>(null);
  const [ingested, setIngested] = useState<{ tenant: string; summary?: Record<string, unknown>; timings_ms?: Record<string, number> } | null>(null);

  const [focus, setFocus] = useState<{ key: string; nodes: string[]; color: string } | null>(null);
  const [module, setModule] = useState("");
  const [whatif, setWhatif] = useState<WhatIf | null>(null);
  const [forking, setForking] = useState(false);
  const [forkErr, setForkErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState<{ new_prs: number; sha: string; dependencies_opened: string[]; dependencies_closed: string[]; notifications: number } | null>(null);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const wide = useMedia("(min-width: 1024px)");

  // pull what merged on GitHub since the last sync: new PRs, and the import graph at HEAD through the Sentinel
  const sync = async () => {
    if (!selected || syncing) return;
    setSyncing(true);
    setSyncErr(null);
    try {
      setSynced(await post(`/api/${selected}/sync`, {}));
      graph.reload();
      insights.reload();
    } catch (e) {
      setSyncErr((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const ingest = async () => {
    if (!url.trim() || ingesting) return;
    setIngesting(true);
    setIngestErr(null);
    setIngested(null);
    try {
      const r = await post<{ tenant: string; summary?: Record<string, unknown>; timings_ms?: Record<string, number> }>("/api/repos", { url: url.trim() });
      setIngested(r);
      tenants.reload();
      select(r.tenant);
    } catch (e) {
      setIngestErr((e as Error).message);
    } finally {
      setIngesting(false);
    }
  };

  const runWhatIf = async () => {
    if (!selected || !module) return;
    setForking(true);
    setForkErr(null);
    try {
      setWhatif(await post<WhatIf>(`/api/${selected}/module-whatif`, { module }));
    } catch (e) {
      setForkErr((e as Error).message);
    } finally {
      setForking(false);
    }
  };

  const modules = useMemo(
    () => (graph.data?.nodes ?? []).filter((n) => n.type === "Service" && n.name).map((n) => n.name!).sort(),
    [graph.data],
  );

  // the hidden-coupling pairs are drawn as edges even when the graph payload leaves CO_CHANGES out
  const data = useMemo(() => {
    const g = graph.data;
    if (!g) return null;
    const have = new Set(g.edges.map(edgeKey));
    const extra: GEdge[] = (insights.data?.hidden_coupling.pairs ?? [])
      .map((p) => ({ source: p.a_uid, target: p.b_uid, type: "CO_CHANGES" as GEdge["type"], weight: p.together }))
      .filter((e) => !have.has(edgeKey(e)));
    return extra.length ? { ...g, edges: [...g.edges, ...extra] } : g;
  }, [graph.data, insights.data]);

  const nodeColor = useCallback((n: GNode) => (n.type === "Service" ? KIND_COLORS[n.kind ?? ""] ?? NODE_COLORS.Service : n.type === "Person" ? C.contributor : undefined), []);
  const nodeSize = useCallback((n: GNode) => (n.type === "Person" ? 2.6 : n.tier === 1 ? 7 : n.tier === 2 ? 5.5 : 4.5), []);

  const wiActive = whatif && whatif.graph.includes(`:${selected}:`) ? whatif : null;
  const retiredUid = wiActive ? graph.data?.nodes.find((n) => n.name === wiActive.cochange_impact[0]?.retired || n.name === module)?.id : undefined;
  const highlight = focus?.nodes ?? (wiActive ? [...(retiredUid ? [retiredUid] : []), ...wiActive.cochange_impact.map((i) => i.uid)] : null);
  const highlightColor = focus?.color ?? (wiActive ? universeAccent(wiActive.universe) : undefined);

  const ins = insights.data;
  const tenant = repos.find((r) => r.id === selected);

  return (
    <Split id="repos" vertical={!wide}>
      <Pane id="picker" defaultSize={wide ? 260 : "28"} minSize={wide ? 210 : 120} maxSize={wide ? 420 : undefined}>
      {/* repo picker */}
      <aside className="h-full min-h-0 overflow-y-auto px-3 py-4">
        <p className="pane-title mb-2 px-1">Projects</p>
        {tenants.error && <ErrorNote error={tenants.error} onRetry={tenants.reload} />}
        <ul className="space-y-1">
          {repos.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  select(r.id);
                  setFocus(null);
                }}
                aria-current={r.id === selected ? "true" : undefined}
                className={`relative w-full rounded-lg px-3 py-2.5 text-left transition-colors ${r.id === selected ? "bg-raised" : "hover:bg-raised/50"}`}
              >
                {r.id === selected && <span className="absolute inset-y-2.5 left-0 w-[2px] rounded-full bg-ember" aria-hidden />}
                <span className={`mono block truncate text-[12px] ${r.id === selected ? "text-ink" : "text-muted"}`}>{r.name}</span>
                <span className="text-[11px] text-faint">updated {fmtDate(r.clock)}</span>
              </button>
            </li>
          ))}
          {tenants.data && !repos.length && <li className="text-xs text-muted">No projects added yet.</li>}
        </ul>

        <form
          className="mt-6 space-y-2.5 border-t border-rule px-1 pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            ingest();
          }}
        >
          <label className="block">
            <span className="label">Add a public GitHub project</span>
            <input className="field mono mt-1" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="owner/name, or its GitHub link" />
          </label>
          <button type="submit" className="btn btn-primary w-full justify-center" disabled={ingesting || !url.trim()}>
            {ingesting && <Spinner />} {ingesting ? "Reading its history" : "Add project"}
          </button>
          <p className="text-[11px] leading-snug text-faint">
            Reads only the project&rsquo;s public history on GitHub: who changed and reviewed what. No AI involved. Takes
            10 to 60 seconds.
          </p>
          {ingestErr && <p role="alert" className="text-xs text-bad">{ingestErr}</p>}
          {ingested && (
            <div className="appear rounded-lg border border-ok/30 bg-ok/[0.06] p-3 text-xs">
              <p className="font-medium text-ok">Added</p>
              <ul className="mt-1 space-y-0.5 text-muted">
                {Object.entries(ingested.summary ?? {})
                  .filter(([, v]) => typeof v === "number" || typeof v === "string")
                  .slice(0, 8)
                  .map(([k, v]) => (
                    <li key={k}>
                      {k.replace(/_/g, " ")}: <span className="mono text-ink">{String(v)}</span>
                    </li>
                  ))}
                {ingested.timings_ms?.total !== undefined && <li>total {fmtMs(ingested.timings_ms.total)}</li>}
              </ul>
            </div>
          )}
        </form>
      </aside>
      </Pane>
      <Handle label="Resize the project list" />
      <Pane id="canvas" minSize={wide ? 320 : 200}>
      {/* canvas */}
      <section className="relative h-full min-h-0" aria-label="Map of the project">
        {selected ? (
          <>
            <LazyGraphCanvas
              data={data}
              layoutNs={`repo:${selected}`}
              nodeColor={nodeColor}
              nodeSize={nodeSize}
              highlight={highlight}
              highlightColor={highlightColor}
              fitToHighlight
              onEdgeClick={(e, s, t, g) => openBlame({ tenant: selected ?? undefined, fact: e.uid ?? null, edge: e, sourceName: s?.name, targetName: t?.name, source: s, target: t, graph: g })}
              ariaLabel={`The parts of, and people behind, ${tenant?.name ?? selected}`}
            />
            <div className="hud pointer-events-none absolute left-3.5 top-3.5 max-w-[calc(100%-28px)] px-3 py-2.5 text-[11px] text-muted">
              <p className="heading text-[20px] leading-none text-ink">{tenant?.name ?? selected}</p>
              <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {Object.entries(KIND_COLORS).map(([k, c]) => (
                  <LegendDot key={k} color={c} label={PART_WORD[k] ?? k} />
                ))}
                <LegendDot color={C.contributor} label="person" />
                <LegendDot color={C.partial} line label="always change together" />
              </ul>
            </div>
            {graph.error && (
              <div className="absolute inset-x-6 top-24">
                <ErrorNote error={graph.error} onRetry={graph.reload} />
              </div>
            )}
          </>
        ) : (
          <div className="grid h-full place-items-center p-8">
            <Empty title="Pick a project.">Or add any public GitHub project on the left to see who knows each part of it.</Empty>
          </div>
        )}
      </section>
      </Pane>
      <Handle label="Resize the findings" />
      <Pane id="insights" defaultSize={wide ? 420 : "40"} minSize={wide ? 320 : 160} maxSize={wide ? 640 : undefined}>
      {/* insights */}
      <aside className="h-full min-h-0 space-y-9 overflow-y-auto bg-panel px-5 py-5">
        {insights.loading && !ins && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Working it out
          </p>
        )}
        {insights.error && <ErrorNote error={insights.error} onRetry={insights.reload} />}
        {selected && (
          <div className="flex items-center gap-2 text-xs">
            <button type="button" className="btn" disabled={syncing} onClick={sync} title="Bring in changes made on GitHub since the last update">
              {syncing && <Spinner />} Update from GitHub
            </button>
            {synced && (
              <span className="text-muted">
                {plural(synced.new_prs, "new change")}, {plural(synced.dependencies_opened.length, "new link")} between parts,{" "}
                {synced.dependencies_closed.length} removed
                {synced.notifications ? `, ${plural(synced.notifications, "answer")} now out of date` : ""}
              </span>
            )}
            {syncErr && <span role="alert" className="text-bad">{syncErr}</span>}
          </div>
        )}
        {ins && (
          <>
            <section>
              <h2 className="heading text-[20px] leading-none">Parts that always change together</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                Parts of the code that keep being changed at the same time, but have different owners. Changing one
                without the other is a common cause of bugs.
              </p>
              {ins.hidden_coupling.pairs.length === 0 && <p className="mt-2 text-xs text-muted">No pairs like this yet.</p>}
              <ol className="mt-2 space-y-1.5">
                {ins.hidden_coupling.pairs.map((p) => {
                  const key = `${p.a_uid}|${p.b_uid}`;
                  return (
                    <li
                      key={key}
                      tabIndex={0}
                      aria-label={`${p.a} and ${p.b}: show on the map`}
                      onMouseEnter={() => setFocus({ key, nodes: [p.a_uid, p.b_uid], color: C.partial })}
                      onMouseLeave={() => setFocus(null)}
                      onFocus={() => setFocus({ key, nodes: [p.a_uid, p.b_uid], color: C.partial })}
                      onBlur={() => setFocus(null)}
                      // touch has no hover: a tap shows the pair on the map, a second tap hides it
                      onClick={() => setFocus((f) => (f?.key === key ? null : { key, nodes: [p.a_uid, p.b_uid], color: C.partial }))}
                      className={`relative cursor-pointer rounded-lg border px-3 py-2.5 text-xs transition-colors duration-200 ${focus?.key === key ? "border-warn/50 bg-raised" : "border-rule bg-well"}`}
                    >
                      <p className="mono break-all text-[12px] text-ink">
                        {p.a} <span className="text-warn">⇄</span> {p.b}
                      </p>
                      <p className="mt-1 flex flex-wrap gap-x-3 text-muted">
                        <span>
                          changed together <span className="text-ink">{p.together}</span> times
                        </span>
                        <span>{Math.round(p.jaccard * 100)}% of the time</span>
                        {p.coupled_since && <span>since {fmtDate(p.coupled_since)}</span>}
                        {p.cross_tree && <span className="text-warn">in different areas of the code</span>}
                      </p>
                    </li>
                  );
                })}
              </ol>
              {ins.hidden_coupling.note && <p className="mt-2 text-[11px] text-faint">{ins.hidden_coupling.note}</p>}
              <ReceiptView r={ins.hidden_coupling.receipt} ms={ins.ms} />
            </section>

            <section>
              <h2 className="heading text-[20px] leading-none">Who knows each part</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                How many people have recently changed or reviewed each active part. A part only one person knows is a
                risk if they leave.
              </p>
              <dl className="mt-4 grid grid-cols-3 gap-x-3 gap-y-4 text-xs">
                {SUMMARY_LABELS.filter(([k]) => k in ins.knowledge_concentration.summary).map(([k, label]) => (
                  <div key={k} className="border-l border-rule pl-3">
                    <dd className={`heading text-[28px] leading-none ${(k === "known_by_one" || k === "known_by_nobody") && ins.knowledge_concentration.summary[k] > 0 ? "text-warn" : "text-ink"}`}>
                      {ins.knowledge_concentration.summary[k]}
                    </dd>
                    <dt className="mt-1.5 text-[11px] leading-tight text-muted">{label}</dt>
                  </div>
                ))}
              </dl>
              <table className="mt-5 w-full text-xs">
                <thead className="text-left text-[11px] text-faint">
                  <tr>
                    <th className="py-1 font-medium">Part</th>
                    <th className="py-1 text-right font-medium" title="Changes in the last 180 days">Changes</th>
                    <th className="py-1 text-right font-medium" title="People who know it">Know it</th>
                    <th className="py-1 pl-2 font-medium" title="Share of the changes made by the most active person">By one person</th>
                  </tr>
                </thead>
                <tbody>
                  {ins.knowledge_concentration.modules.slice(0, 14).map((m) => (
                    <tr
                      key={m.uid}
                      className={`cursor-pointer border-t border-rule-soft transition-colors hover:bg-raised/50 ${focus?.key === m.uid ? "bg-raised" : ""}`}
                      tabIndex={0}
                      aria-label={`${m.module}: show on the map`}
                      onMouseEnter={() => setFocus({ key: m.uid, nodes: [m.uid], color: C.trunk })}
                      onMouseLeave={() => setFocus(null)}
                      onFocus={() => setFocus({ key: m.uid, nodes: [m.uid], color: C.trunk })}
                      onBlur={() => setFocus(null)}
                      onClick={() => setFocus((f) => (f?.key === m.uid ? null : { key: m.uid, nodes: [m.uid], color: C.trunk }))}
                    >
                      <td className="mono max-w-[11rem] truncate py-1 text-ink" title={m.module}>
                        {m.module}
                      </td>
                      <td className="mono py-1 text-right">{m.changes}</td>
                      <td className={`mono py-1 text-right ${m.knowers <= 1 ? "text-warn" : ""}`}>{m.knowers}</td>
                      <td className="py-1 pl-2">
                        <span className="flex items-center gap-1.5">
                          <span className="h-1.5 flex-1 rounded-full bg-rule-soft">
                            <span className="block h-full rounded-full" style={{ width: `${m.top_author_share}%`, background: m.top_author_share >= 75 ? C.partial : C.muted }} />
                          </span>
                          <span className="mono w-8 text-right text-muted">{m.top_author_share}%</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ins.knowledge_concentration.note && <p className="mt-2 text-[11px] text-faint">{ins.knowledge_concentration.note}</p>}
              <ReceiptView r={ins.knowledge_concentration.receipt} />
            </section>

            <section>
              <h2 className="heading text-[20px] leading-none">What if a part went away?</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                Tests removing it on a copy of the project and shows what usually changes along with it.
              </p>
              <div className="mt-2 flex gap-2">
                <label className="sr-only" htmlFor="module">
                  Part
                </label>
                <select id="module" className="field mono flex-1 text-xs" value={module} onChange={(e) => setModule(e.target.value)}>
                  <option value="">Choose a part…</option>
                  {modules.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-primary" disabled={!module || forking} onClick={runWhatIf}>
                  {forking && <Spinner />} Test it
                </button>
              </div>
              {forkErr && <p role="alert" className="mt-2 text-xs text-bad">{forkErr}</p>}
              {wiActive && (
                <div className="appear relative mt-3 overflow-hidden rounded-xl border border-rule bg-well p-3.5 text-xs">
                  <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: universeAccent(wiActive.universe) }} aria-hidden />
                  <p className="flex flex-wrap items-center gap-2">
                    <UniverseTag uid={wiActive.universe} />
                    <span className="font-medium text-ink">{wiActive.title}</span>
                  </p>
                  {wiActive.cochange_impact.length === 0 ? (
                    <p className="mt-2 text-muted">Nothing usually changes along with this part.</p>
                  ) : (
                    <table className="mt-2 w-full">
                      <thead className="text-left text-muted">
                        <tr>
                          <th className="py-1 font-medium">Changes along with it</th>
                          <th className="py-1 text-right font-medium" title="Share of the removed part's changes that also changed this one">How often</th>
                          <th className="py-1 text-right font-medium" title="People who know this module, and how many of them also know the retired one">Know both</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wiActive.cochange_impact.slice(0, 10).map((i) => (
                          <tr key={i.uid} className="border-t border-rule-soft">
                            <td className="mono max-w-[12rem] truncate py-1 text-ink" title={i.module}>
                              {i.module}
                            </td>
                            <td className="mono py-1 text-right">{i.share_of_retired_prs}%</td>
                            <td className="mono py-1 text-right">
                              {i.know_both}/{i.knowers}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <ReceiptView r={wiActive.cochange_receipt} />
                </div>
              )}
            </section>
          </>
        )}
      </aside>
      </Pane>
    </Split>
  );
}

export default function ReposPage() {
  return (
    <Suspense>
      <Repos />
    </Suspense>
  );
}
