// ForceAtlas2 layout, computed once per namespace and cached (memory + localStorage) so the company keeps
// the same shape across screens, time travel and universes. Nodes that appear later (a service that
// existed only in May, a universe's new ticket) are placed next to their neighbours instead of re-running
// the whole layout, so nothing jumps.

import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

export type XY = { x: number; y: number };
type Positions = Record<string, XY>;

interface LayoutEdge {
  source: string;
  target: string;
  type: string;
  weight?: number | null;
}

const VERSION = "v3";
const mem: Record<string, Positions> = {};

const storageKey = (ns: string) => `orion.layout.${ns}.${VERSION}`;

function load(ns: string): Positions {
  if (mem[ns]) return mem[ns];
  try {
    const raw = localStorage.getItem(storageKey(ns));
    if (raw) mem[ns] = JSON.parse(raw);
  } catch {
    /* private mode or blocked storage: compute in memory only */
  }
  return (mem[ns] ??= {});
}

function save(ns: string, p: Positions) {
  mem[ns] = p;
  try {
    localStorage.setItem(storageKey(ns), JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** Deterministic pseudo-random in [0,1) from a string, so a cold layout is reproducible. */
function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const EDGE_WEIGHT: Record<string, number> = {
  MEMBER_OF: 3,
  OWNS: 2,
  DEPENDS_ON: 1.6,
  ON_CALL_FOR: 0.6,
  USES: 1,
  AFFECTS: 0.8,
  WORKED_ON: 0.5,
  KNOWS: 0.35,
  RAISED_ABOUT: 0.8,
  CO_CHANGES: 1.2,
};

function weightOf(e: LayoutEdge): number {
  if (e.type === "COLLABORATES") return Math.min(2, (e.weight ?? 1) / 4);
  return EDGE_WEIGHT[e.type] ?? 0.5;
}

export function computeLayout(nodes: { id: string }[], edges: LayoutEdge[], iterations = 500): Positions {
  const g = new Graph({ type: "undirected", multi: false });
  for (const n of nodes) {
    const a = hash01(n.id) * Math.PI * 2;
    const r = 10 + hash01(n.id, 7) * 90;
    g.addNode(n.id, { x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  for (const e of edges) {
    if (!g.hasNode(e.source) || !g.hasNode(e.target) || e.source === e.target) continue;
    const w = weightOf(e);
    if (g.hasEdge(e.source, e.target)) g.updateEdgeAttribute(e.source, e.target, "weight", (v) => (v ?? 0) + w);
    else g.addEdge(e.source, e.target, { weight: w });
  }
  const settings = {
    ...forceAtlas2.inferSettings(g),
    gravity: 1,
    scalingRatio: 10,
    strongGravityMode: true,
    barnesHutOptimize: false,
    edgeWeightInfluence: 0.8,
    outboundAttractionDistribution: false,
    adjustSizes: false,
    slowDown: 2,
  };
  forceAtlas2.assign(g, { iterations, settings, getEdgeWeight: "weight" });
  const out: Positions = {};
  g.forEachNode((id, a) => (out[id] = { x: a.x as number, y: a.y as number }));
  return out;
}

/** Positions for every node, reusing the cached layout of `ns` and filling gaps near neighbours. */
export function positionsFor(ns: string, nodes: { id: string }[], edges: LayoutEdge[]): Positions {
  const cached = load(ns);
  const missing = nodes.filter((n) => !cached[n.id]);
  if (!missing.length) return cached;

  if (missing.length > nodes.length * 0.3) {
    const fresh = computeLayout(nodes, edges);
    const merged = { ...cached, ...fresh };
    save(ns, merged);
    return merged;
  }

  const next = { ...cached };
  // Place each missing node at the centroid of its already placed neighbours, with a small offset.
  for (let pass = 0; pass < 3; pass++) {
    for (const n of missing) {
      if (next[n.id]) continue;
      const nbrs: XY[] = [];
      for (const e of edges) {
        const other = e.source === n.id ? e.target : e.target === n.id ? e.source : null;
        if (other && next[other]) nbrs.push(next[other]);
      }
      if (!nbrs.length && pass < 2) continue;
      const cx = nbrs.length ? nbrs.reduce((s, p) => s + p.x, 0) / nbrs.length : 0;
      const cy = nbrs.length ? nbrs.reduce((s, p) => s + p.y, 0) / nbrs.length : 0;
      const a = hash01(n.id) * Math.PI * 2;
      const r = nbrs.length ? 6 + hash01(n.id, 3) * 6 : 60;
      next[n.id] = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
    }
  }
  save(ns, next);
  return next;
}

export function clearLayout(ns: string) {
  delete mem[ns];
  try {
    localStorage.removeItem(storageKey(ns));
  } catch {
    /* ignore */
  }
}
