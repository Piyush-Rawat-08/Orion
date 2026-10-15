"use client";

// WebGL canvas for the company graph (Sigma.js v3 + graphology). Positions come from the cached
// ForceAtlas2 layout; everything else (highlight, diff colouring, time pulses) is done in reducers so
// changing it never rebuilds the graph.

import { useEffect, useRef } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import { edgeKey } from "@/lib/graph";
import { setGraphMode } from "./mode";
import { positionsFor } from "@/lib/layout";
import { C, EDGE_COLORS, NODE_COLORS } from "@/lib/theme";
import type { GEdge, GNode, GraphPayload } from "@/lib/types";

export interface DiffPaint {
  /** broken service uid -> hops from the retired service */
  broken: Map<string, number>;
  /** reveal broken services with hops <= this (drives the cascade animation) */
  revealHops: number;
  orphans: Set<string>;
  addedEdges: Set<string>;
  removedEdges: Set<string>;
  accent: string;
}

/** What the agent has touched while it works: lit in the canvas, walking out from `seed` one hop at a time. */
export interface Trail {
  /** changes with every finished tool call, so the walk replays from the newest call */
  key: string;
  nodes: string[];
  seed: string | null;
  /** the newest call's nodes */
  recent: string[];
}

/** The nodes and edges a canvas is showing, handed to edge clicks for context. */
export type EdgeGraph = { nodes: GNode[]; edges: GEdge[] };

export interface GraphCanvasProps {
  data: GraphPayload | null;
  layoutNs?: string;
  highlight?: string[] | null;
  highlightColor?: string;
  diff?: DiffPaint | null;
  /** edges to draw although they are not in `data` (e.g. removed in a universe), keyed like edgeKey() */
  ghostEdges?: GEdge[];
  pulse?: string[] | null;
  /** the agent's trail while it streams (3D lights it hop by hop; 2D shows it as a highlight) */
  trail?: Trail | null;
  pulseColor?: string;
  nodeColor?: (n: GNode) => string | undefined;
  nodeSize?: (n: GNode) => number | undefined;
  nodeFilter?: (n: GNode) => boolean;
  edgeFilter?: (e: GEdge) => boolean;
  forceLabels?: string[];
  onEdgeClick?: (e: GEdge, source: GNode | undefined, target: GNode | undefined, graph?: EdgeGraph) => void;
  onNodeClick?: (n: GNode) => void;
  fitToHighlight?: boolean;
  /** an answer about something stopping: what relies on `origin` goes red hop by hop, customers last (3D) */
  story?: { key: string; origin: string } | null;
  ariaLabel?: string;
  className?: string;
}


function baseSize(n: GNode): number {
  switch (n.type) {
    case "Team":
      return 9;
    case "Service":
      return n.tier === 1 ? 7 : n.tier === 2 ? 5.6 : 4.6;
    case "Decision":
      return 5;
    case "Customer":
    case "Project":
      return 4.6;
    default:
      return 3.2;
  }
}

function edgeSize(e: GEdge): number {
  if (e.type === "DEPENDS_ON" || e.type === "DEPENDS_ON_CLOSED") return 1.7;
  if (e.type === "OWNS" || e.type === "RAISED_ABOUT") return 1;
  if (e.type === "COLLABORATES") return Math.min(1.6, 0.3 + (e.weight ?? 1) / 8);
  if (e.type === "CO_CHANGES") return Math.min(3, 0.6 + (e.weight ?? 1) / 5);
  return 0.5;
}


/** Blend a hex colour toward the canvas background (WebGL alpha reads too bright on a dark canvas). */
function fade(hex: string, keep: number): string {
  if (!hex.startsWith("#")) return hex;
  const a = hex.replace("#", ""), b = C.night.replace("#", "");
  const ch = (s: string, i: number) => parseInt(s.slice(i, i + 2), 16);
  const out = [0, 2, 4].map((i) => Math.round(ch(a, i) * keep + ch(b, i) * (1 - keep)));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

type HoverData = { x: number; y: number; size: number; label?: string | null; color?: string };
type LabelSettings = { labelSize: number; labelFont: string; labelWeight: string };

function drawHover(ctx: CanvasRenderingContext2D, data: HoverData, settings: LabelSettings) {
  const label = data.label ?? "";
  const size = settings.labelSize + 1;
  ctx.font = `500 ${size}px ${settings.labelFont}`;
  const w = label ? ctx.measureText(label).width : 0;
  const r = data.size + 3;
  ctx.fillStyle = C.raised;
  ctx.strokeStyle = C.rule;
  ctx.lineWidth = 1;
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 16;
  roundRect(ctx, data.x - r - 4, data.y - Math.max(r, size / 2 + 7), (label ? w + 14 : 0) + 2 * r + 8, 2 * Math.max(r, size / 2 + 7), 8);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(data.x, data.y, data.size + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = data.color ?? C.text;
  ctx.fill();
  if (label) {
    ctx.fillStyle = C.text;
    ctx.fillText(label, data.x + r + 6, data.y + size / 3);
  }
}

export default function GraphCanvas(props: GraphCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const propsRef = useRef(props);
  const hovered = useRef<{ node: string | null; edge: string | null; nbrs: Set<string> }>({
    node: null,
    edge: null,
    nbrs: new Set(),
  });
  const lookup = useRef<{ nodes: Map<string, GNode>; edges: Map<string, GEdge> }>({
    nodes: new Map(),
    edges: new Map(),
  });
  propsRef.current = props;
  // first-load entrance: nodes light up from the centre outwards, edges follow once both ends are lit
  const bloom = useRef<{ start: number; delay: Map<string, number> } | null>(null);
  const bloomed = useRef(false);
  const lit = (node: string): number => {
    const b = bloom.current;
    if (!b) return 1;
    const t = (performance.now() - b.start) / 1000 - (b.delay.get(node) ?? 0);
    const x = Math.min(1, Math.max(0, t / 0.6));
    return 1 - Math.pow(1 - x, 3);
  };

  // ---- mount sigma once
  useEffect(() => {
    if (!container.current) return;
    const graph = new Graph({ type: "directed", multi: true });
    graphRef.current = graph;
    const font =
      getComputedStyle(document.documentElement).getPropertyValue("--font-geist").trim() || "system-ui, sans-serif";

    const sigma = new Sigma(graph, container.current, {
      allowInvalidContainer: true,
      enableEdgeEvents: true,
      renderEdgeLabels: false,
      defaultEdgeType: "line",
      labelColor: { color: C.label },
      labelFont: font,
      labelSize: 11.5,
      labelWeight: "500",
      labelDensity: 0.65,
      labelGridCellSize: 120,
      labelRenderedSizeThreshold: 7,
      zIndex: true,
      minCameraRatio: 0.08,
      maxCameraRatio: 3,
      defaultDrawNodeHover: drawHover as never,
      nodeReducer: (node, attrs) => {
        const p = propsRef.current;
        const res = { ...attrs } as Record<string, unknown>;
        const hl = p.highlight && p.highlight.length ? new Set(p.highlight) : null;
        const h = hovered.current;
        const n = lookup.current.nodes.get(node);
        const f = lit(node);
        if (f < 1) {
          res.size = (attrs.size as number) * f;
          if (f < 0.7) res.label = null;
        }

        if (p.diff && n) {
          const hops = p.diff.broken.get(node);
          if (hops !== undefined && hops <= p.diff.revealHops) {
            res.color = C.bad;
            res.size = (attrs.size as number) * 1.35;
            res.forceLabel = true;
            res.zIndex = 3;
          } else if (p.diff.orphans.has(node)) {
            res.color = C.orphan;
            res.size = (attrs.size as number) * 1.3;
            res.forceLabel = true;
            res.zIndex = 3;
          } else if (n.retired || n.former) {
            res.color = C.retired;
            res.forceLabel = true;
            res.zIndex = 2;
          }
        }
        if (p.pulse?.includes(node)) {
          res.color = p.pulseColor ?? C.added;
          res.size = (attrs.size as number) * 1.6;
          res.forceLabel = true;
          res.zIndex = 4;
        }
        if (hl) {
          if (hl.has(node)) {
            res.color = p.highlightColor ?? C.trunk;
            res.size = (attrs.size as number) * 1.45;
            res.forceLabel = true;
            res.zIndex = 5;
          } else {
            res.color = fade((res.color as string) ?? C.muted, 0.22);
            res.label = null;
            res.zIndex = 0;
          }
        }
        if (h.node) {
          if (node === h.node || h.nbrs.has(node)) {
            res.forceLabel = true;
            res.zIndex = 6;
          } else if (!hl) {
            res.color = fade((res.color as string) ?? C.muted, 0.3);
            res.label = null;
          }
        }
        if (p.forceLabels?.includes(node)) res.forceLabel = true;
        return res as never;
      },
      edgeReducer: (edge, attrs) => {
        const p = propsRef.current;
        const res = { ...attrs } as Record<string, unknown>;
        const g = graphRef.current!;
        const [s, t] = g.extremities(edge);
        const hl = p.highlight && p.highlight.length ? new Set(p.highlight) : null;
        const h = hovered.current;
        const ghost = attrs.ghost as boolean | undefined;
        if (bloom.current && Math.min(lit(s), lit(t)) < 0.9) return { ...res, hidden: true } as never;

        if (p.diff) {
          if (p.diff.addedEdges.has(edge)) {
            res.color = C.added;
            res.size = (attrs.size as number) + 1.2;
            res.zIndex = 3;
          } else if (ghost || p.diff.removedEdges.has(edge)) {
            res.color = fade(C.bad, 0.5);
            res.zIndex = 2;
          } else {
            const hs = p.diff.broken.get(s);
            const ht = p.diff.broken.get(t);
            const isDep = attrs.etype === "DEPENDS_ON";
            if (isDep && hs !== undefined && hs <= p.diff.revealHops && (ht !== undefined || g.getNodeAttribute(t, "retired"))) {
              res.color = fade(C.bad, 0.9);
              res.size = (attrs.size as number) + 0.8;
              res.zIndex = 3;
            }
          }
        }
        if (hl) {
          if (hl.has(s) && hl.has(t)) {
            res.color = p.highlightColor ?? C.trunk;
            res.size = (attrs.size as number) + 1;
            res.zIndex = 5;
          } else {
            res.hidden = attrs.etype === "COLLABORATES" || attrs.etype === "KNOWS";
            res.color = fade(C.rule, 0.5);
          }
        }
        if (h.node && !hl) {
          if (s === h.node || t === h.node) {
            res.color = C.trunk;
            res.zIndex = 6;
          } else res.color = fade(C.rule, 0.45);
        }
        if (h.edge === edge) {
          res.color = C.text;
          res.size = (attrs.size as number) + 1.5;
          res.zIndex = 7;
        }
        return res as never;
      },
    });
    sigmaRef.current = sigma;

    sigma.on("enterNode", ({ node }) => {
      hovered.current = { node, edge: null, nbrs: new Set(graph.neighbors(node)) };
      container.current?.style.setProperty("cursor", propsRef.current.onNodeClick ? "pointer" : "default");
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on("leaveNode", () => {
      hovered.current = { node: null, edge: null, nbrs: new Set() };
      container.current?.style.removeProperty("cursor");
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on("enterEdge", ({ edge }) => {
      hovered.current = { ...hovered.current, edge };
      container.current?.style.setProperty("cursor", "pointer");
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on("leaveEdge", () => {
      hovered.current = { ...hovered.current, edge: null };
      container.current?.style.removeProperty("cursor");
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on("clickEdge", ({ edge }) => {
      const e = lookup.current.edges.get(edge);
      if (!e) return;
      propsRef.current.onEdgeClick?.(e, lookup.current.nodes.get(e.source), lookup.current.nodes.get(e.target), {
        nodes: [...lookup.current.nodes.values()],
        edges: [...lookup.current.edges.values()],
      });
    });
    sigma.on("clickNode", ({ node }) => {
      const n = lookup.current.nodes.get(node);
      if (n) propsRef.current.onNodeClick?.(n);
    });

    const ro = new ResizeObserver(() => {
      sigma.resize();
      sigma.refresh();
    });
    ro.observe(container.current);

    return () => {
      ro.disconnect();
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, []);

  // ---- (re)build the graph when the data or filters change
  const { data, layoutNs = "main", nodeFilter, edgeFilter, nodeColor, nodeSize, ghostEdges } = props;
  useEffect(() => {
    const graph = graphRef.current;
    const sigma = sigmaRef.current;
    if (!graph || !sigma) return;
    graph.clear();
    lookup.current = { nodes: new Map(), edges: new Map() };
    if (!data) {
      sigma.refresh();
      return;
    }
    const nodes = nodeFilter ? data.nodes.filter(nodeFilter) : data.nodes;
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (edgeFilter ? data.edges.filter(edgeFilter) : data.edges).filter(
      (e) => ids.has(e.source) && ids.has(e.target),
    );
    const pos = positionsFor(layoutNs, nodes, edges);
    for (const n of nodes) {
      const p = pos[n.id] ?? { x: 0, y: 0 };
      graph.addNode(n.id, {
        x: p.x,
        y: p.y,
        size: nodeSize?.(n) ?? baseSize(n),
        color: nodeColor?.(n) ?? (n.retired || n.former ? C.retired : NODE_COLORS[n.type] ?? C.muted),
        label: n.type === "Decision" ? `${n.key ?? ""} ${n.name ?? ""}`.trim() : n.name ?? n.id,
        retired: n.retired,
      });
      lookup.current.nodes.set(n.id, n);
    }
    const addEdge = (e: GEdge, ghost: boolean) => {
      const key = edgeKey(e);
      if (graph.hasEdge(key) || !graph.hasNode(e.source) || !graph.hasNode(e.target)) return;
      const isDep = e.type === "DEPENDS_ON" || e.type === "DEPENDS_ON_CLOSED";
      graph.addDirectedEdgeWithKey(key, e.source, e.target, {
        size: edgeSize(e),
        color:
          e.type === "DEPENDS_ON" && e.declared === false ? C.undeclared : EDGE_COLORS[e.type] ?? C.rule,
        type: isDep ? "arrow" : "line",
        etype: e.type,
        ghost,
      });
      lookup.current.edges.set(key, e);
    };
    for (const e of edges) addEdge(e, false);
    for (const e of ghostEdges ?? []) addEdge(e, true);
    if (!bloomed.current && nodes.length && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      bloomed.current = true;
      let cx = 0,
        cy = 0;
      graph.forEachNode((_, a) => {
        cx += a.x;
        cy += a.y;
      });
      cx /= graph.order;
      cy /= graph.order;
      const dist = new Map<string, number>();
      let max = 0;
      graph.forEachNode((id, a) => {
        const d = Math.hypot(a.x - cx, a.y - cy);
        dist.set(id, d);
        max = Math.max(max, d);
      });
      const delay = new Map([...dist].map(([id, d]) => [id, (d / (max || 1)) * 0.9]));
      bloom.current = { start: performance.now(), delay };
      const tick = () => {
        if (!bloom.current || !sigmaRef.current) return;
        sigmaRef.current.refresh({ skipIndexation: true });
        if (performance.now() - bloom.current.start < 1650) requestAnimationFrame(tick);
        else {
          bloom.current = null;
          sigmaRef.current.refresh({ skipIndexation: true });
        }
      };
      requestAnimationFrame(tick);
    }
    sigma.refresh();
  }, [data, layoutNs, nodeFilter, edgeFilter, nodeColor, nodeSize, ghostEdges]);

  // ---- restyle on highlight / diff / pulse changes, and frame the highlighted nodes
  const { highlight, diff, pulse, fitToHighlight, highlightColor, forceLabels } = props;
  useEffect(() => {
    sigmaRef.current?.refresh({ skipIndexation: true });
  }, [diff, pulse, highlightColor, forceLabels]);

  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    sigma.refresh({ skipIndexation: true });
    if (!fitToHighlight) return;
    const cam = sigma.getCamera();
    const pts = (highlight ?? [])
      .map((id) => sigma.getNodeDisplayData(id))
      .filter((d): d is NonNullable<typeof d> => !!d);
    if (!pts.length) {
      cam.animate({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }, { duration: 450 });
      return;
    }
    const xs = pts.map((p) => p.x),
      ys = pts.map((p) => p.y);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const ratio = Math.min(1, Math.max(0.35, Math.max(maxX - minX, maxY - minY) * 1.5));
    cam.animate({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, ratio }, { duration: 500 });
  }, [highlight, fitToHighlight]);

  const cam = (dir: 1 | -1 | 0) => {
    const c = sigmaRef.current?.getCamera();
    if (!c) return;
    if (dir === 0) c.animatedReset({ duration: 300 });
    else if (dir === 1) c.animatedZoom({ duration: 200 });
    else c.animatedUnzoom({ duration: 200 });
  };

  return (
    <div className={`relative h-full w-full ${props.className ?? ""}`}>
      <div ref={container} role="img" aria-label={props.ariaLabel ?? "Company graph"} className="graph-surface h-full w-full" />
      <div className="zoom-controls" role="group" aria-label="Zoom">
        <button type="button" onClick={() => cam(1)} aria-label="Zoom in">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <button type="button" onClick={() => cam(-1)} aria-label="Zoom out">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M1.5 6h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <button type="button" onClick={() => cam(0)} aria-label="Reset view">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden><path d="M1.5 4.5v-3h3M10.5 4.5v-3h-3M1.5 7.5v3h3M10.5 7.5v3h-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button type="button" onClick={() => setGraphMode("3d")} aria-label="Switch to the 3D view" title="Switch to 3D" className="mono !text-[11px] font-semibold">
          3D
        </button>
      </div>
    </div>
  );
}
