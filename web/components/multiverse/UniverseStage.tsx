"use client";

import Link from "next/link";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../AppProvider";
import LazyGraphCanvas from "../graph/GraphCanvasLazy";
import type { DiffPaint, EdgeGraph } from "../graph/GraphCanvas";
import { LegendDot, UniverseTag } from "../ui";
import BlastRadius, { BlastLegend } from "./BlastRadius";
import { useFetch } from "@/lib/hooks";
import { edgeKey, edgeSetDiff } from "@/lib/graph";
import { C, universeAccent } from "@/lib/theme";
import type { GEdge, GNode, GraphPayload, UniverseDetail } from "@/lib/types";
import { scenarioLabel, STATUS_WORD } from "@/lib/words";

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
      <LegendDot color={C.bad} label="stops working" />
      <LegendDot color={C.orphan} label="nobody left who knows it" />
      <LegendDot color={C.retired} label="switched off or gone" />
      <LegendDot color={C.added} line label="new connection" />
      <LegendDot color={C.bad} line faded label="connection removed" />
    </ul>
  );
}

export default function UniverseStage({
  detail,
  main,
  mode,
}: {
  detail: UniverseDetail;
  main: GraphPayload | null;
  mode: "blast" | "split" | "overlay";
}) {
  const { openBlame } = useApp();
  const uid = detail.uid;
  const accent = universeAccent(uid);
  const ug = useFetch<GraphPayload>(mode === "blast" ? null : `/graph?universe=${uid}`);
  const [split, setSplit] = useState(false);
  const [reveal, setReveal] = useState(-1);

  const maxHops = Math.max(0, ...(detail.diff?.broken.map((b) => b.hops) ?? [0]));

  // The fork: start as one surface, split along a seam, then let the failure cascade hop by hop.
  useEffect(() => {
    setSplit(false);
    setReveal(-1);
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => setSplit(true), 80));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) timers.push(setTimeout(() => setReveal(99), 100));
    // the branch slides out (300 ms), then breakage travels hop by hop, 150 ms a hop, once
    else for (let h = 0; h <= maxHops; h++) timers.push(setTimeout(() => setReveal(h), 420 + h * 150));
    return () => timers.forEach(clearTimeout);
  }, [uid, maxHops]);

  const universeData = ug.data;
  const { added, removed } = useMemo(() => {
    if (!main || !universeData) return { added: [] as GEdge[], removed: [] as GEdge[] };
    return { added: edgeSetDiff(main, universeData), removed: edgeSetDiff(universeData, main) };
  }, [main, universeData]);

  const paint: DiffPaint | null = useMemo(() => {
    if (!detail.diff || reveal < 0) return null;
    return {
      broken: new Map(detail.diff.broken.map((b) => [b.uid, b.hops])),
      revealHops: reveal,
      orphans: new Set(detail.diff.new_orphans.map((o) => o.uid)),
      addedEdges: new Set(added.map(edgeKey)),
      removedEdges: new Set(removed.map(edgeKey)),
      accent,
    };
  }, [detail.diff, reveal, added, removed, accent]);

  const onEdgeClick = useCallback(
    (e: GEdge, s?: GNode, t?: GNode, g?: EdgeGraph) =>
      openBlame({ fact: e.uid ?? null, edge: e, sourceName: s?.name, targetName: t?.name, source: s, target: t, graph: g }),
    [openBlame],
  );

  const gone = ug.error && /410|deleted|merged|discarded/i.test(ug.error);
  const universePane = (
    <div className="relative h-full min-h-0">
      {gone ? (
        <div className="graph-surface flex h-full items-center justify-center p-6 text-center">
          <div className="max-w-sm">
            <p className="heading text-[20px] leading-tight">This what-if was {STATUS_WORD[detail.status] ?? detail.status}.</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {detail.status === "merged"
                ? "It was approved and made real, so its copy of the company was cleared away."
                : "Its copy of the company was cleared away."}{" "}
              The results below are kept as the record.
            </p>
            {detail.status === "merged" && (
              <Link href={`/certificate?u=${detail.uid}`} className="btn mt-4">
                Approval certificate
              </Link>
            )}
          </div>
        </div>
      ) : (
        <LazyGraphCanvas
          data={universeData}
          diff={paint}
          ghostEdges={removed}
          onEdgeClick={onEdgeClick}
          ariaLabel={`What-if ${scenarioLabel(uid)}: ${detail.title}`}
        />
      )}
      <div className="hud pointer-events-none absolute left-3.5 top-3.5 flex max-w-[calc(100%-28px)] items-center gap-2 px-2.5 py-1.5" style={{ borderColor: `${accent}55` }}>
        {mode === "split" && <span className="text-[12px] font-semibold text-ink">After</span>}
        <UniverseTag uid={uid} />
        <span className="truncate text-xs text-ink">{detail.title}</span>
      </div>
      <div className="hud pointer-events-none absolute bottom-3.5 left-3.5 max-w-[calc(100%-80px)] px-3 py-2">
        <Legend />
      </div>
      {ug.error && !gone && <p className="absolute inset-x-3 top-14 text-xs text-bad">{ug.error}</p>}
    </div>
  );

  if (mode === "blast") {
    const diff = detail.diff;
    return (
      <div className="h-full overflow-auto bg-panel px-5 py-5">
        {diff && diff.broken.length > 0 ? (
          <div className="space-y-4">
            <p className="max-w-[70ch] text-[13px] leading-relaxed text-muted">
              <span className="text-ink">
                {diff.structural.retired.length
                  ? `${diff.structural.retired.join(", ")} ${diff.structural.retired.length === 1 ? "is" : "are"} switched off`
                  : "The change is made"}
                {(() => {
                  const stop = diff.broken.filter((b) => (b.effect ?? "break") === "break").length;
                  const slow = diff.broken.length - stop;
                  return `: ${stop} ${stop === 1 ? "system stops" : "systems stop"} working${
                    slow ? `, ${slow} ${slow === 1 ? "slows down or goes stale" : "slow down or go stale"}` : ""
                  }`;
                })()}
                {diff.customers?.length ? `, and ${diff.customers.length} ${diff.customers.length === 1 ? "customer" : "customers"} could notice` : ""}.
              </span>{" "}
              Read it left to right: the systems that rely on it directly are hit first, then the ones that rely on those,
              and on the right, the teams responsible and the customers who use them.
            </p>
            <BlastRadius diff={diff} size="full" />
            <BlastLegend />
          </div>
        ) : (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-sm">
              <p className="text-[15px] font-semibold text-ink">Nothing breaks in this what-if.</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                Nothing relies on what this change switches off. Open &ldquo;Before and after&rdquo; to see what else moved.
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (mode === "overlay") return <div className="h-full">{universePane}</div>;

  return (
    <div className="split-stage h-full" data-split={split} style={{ ["--seam" as string]: accent }}>
      <div className="relative h-full min-h-0">
        <LazyGraphCanvas data={main} onEdgeClick={onEdgeClick} ariaLabel="The real company, as it is today" />
        <div className="hud pointer-events-none absolute left-3.5 top-3.5 px-2.5 py-1.5 text-[12px]">
          <span className="font-semibold text-ink">Before</span>
          <span className="ml-2 text-muted">the company today</span>
        </div>
      </div>
      {/* laid out at full size from the start (so its canvas sizes to the pane), then uncovered from the seam */}
      <div className="fork-pane relative h-full min-h-0 overflow-hidden">
        <span className="seam" aria-hidden />
        {universePane}
      </div>
    </div>
  );
}
