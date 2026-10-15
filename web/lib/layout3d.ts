// 3D positions ("homes") for the company graph, computed once per namespace and cached like the 2D layout.
// The 2D ForceAtlas2 layout seeds x/y, so the 3D graph keeps the shape people already know from the 2D
// view, and a short 3D force run lifts it into depth. Nodes that appear later (a universe's new ticket, a
// service that only existed in May) settle around their already-placed neighbours, so nothing jumps.

import { forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ } from "d3-force-3d";
import { positionsFor } from "./layout";

export type P3 = { x: number; y: number; z: number };

interface LayoutEdge {
  source: string;
  target: string;
  type: string;
  weight?: number | null;
}

const VERSION = "v2";
const mem: Record<string, Map<string, P3>> = {};
const storageKey = (ns: string) => `orion.layout3d.${ns}.${VERSION}`;

/** Rough radius the whole graph occupies, in scene units. */
export const RADIUS = 150;

function load(ns: string): Map<string, P3> {
  if (mem[ns]) return mem[ns];
  try {
    const raw = localStorage.getItem(storageKey(ns));
    if (raw) mem[ns] = new Map(Object.entries(JSON.parse(raw) as Record<string, P3>));
  } catch {
    /* private mode or blocked storage: compute in memory only */
  }
  return (mem[ns] ??= new Map());
}

function save(ns: string, p: Map<string, P3>) {
  mem[ns] = p;
  try {
    localStorage.setItem(storageKey(ns), JSON.stringify(Object.fromEntries(p)));
  } catch {
    /* ignore */
  }
}

function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Rest length per relationship: tight for team membership, loose for "knows". */
const DISTANCE: Record<string, number> = {
  MEMBER_OF: 20,
  OWNS: 30,
  ON_CALL_FOR: 40,
  DEPENDS_ON: 34,
  DEPENDS_ON_CLOSED: 40,
  USES: 36,
  AFFECTS: 30,
  WORKED_ON: 40,
  KNOWS: 46,
  COLLABORATES: 34,
  RAISED_ABOUT: 34,
  CO_CHANGES: 30,
};
const STRENGTH: Record<string, number> = { MEMBER_OF: 0.7, OWNS: 0.5, DEPENDS_ON: 0.45, KNOWS: 0.08, COLLABORATES: 0.18 };

type SimNode = P3 & { id: string; fx?: number; fy?: number; fz?: number };

export function homesFor(ns: string, nodes: { id: string }[], edges: LayoutEdge[]): Map<string, P3> {
  const cache = load(ns);
  const missing = nodes.filter((n) => !cache.has(n.id));
  if (!missing.length) return cache;
  const fresh = missing.length > nodes.length * 0.3;

  // seed from the 2D layout, scaled to RADIUS, with depth from a stable hash
  const flat = positionsFor(ns, nodes, edges);
  const pts = nodes.map((n) => flat[n.id]).filter(Boolean);
  const cx = pts.reduce((s, p) => s + p.x, 0) / (pts.length || 1);
  const cy = pts.reduce((s, p) => s + p.y, 0) / (pts.length || 1);
  const r = Math.max(1, ...pts.map((p) => Math.hypot(p.x - cx, p.y - cy)));
  const k = RADIUS / r;

  const sim: SimNode[] = nodes.map((n) => {
    const home = !fresh ? cache.get(n.id) : undefined;
    if (home) return { id: n.id, ...home, fx: home.x, fy: home.y, fz: home.z };
    const p = flat[n.id] ?? { x: cx, y: cy };
    return { id: n.id, x: (p.x - cx) * k, y: (p.y - cy) * k, z: (hash01(n.id, 11) - 0.5) * RADIUS * 1.1 };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const links = edges
    .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
    .map((e) => ({ source: e.source, target: e.target, type: e.type }));

  const simulation = forceSimulation(sim, 3)
    .force(
      "link",
      forceLink(links)
        .id((d: SimNode) => d.id)
        .distance((l: { type: string }) => DISTANCE[l.type] ?? 36)
        .strength((l: { type: string }) => STRENGTH[l.type] ?? 0.25),
    )
    .force("charge", forceManyBody().strength(-80).distanceMax(RADIUS * 1.4))
    // a gentle pull to the middle, so a customer with one link doesn't drift off into the dark
    .force("x", forceX(0).strength(0.05))
    .force("y", forceY(0).strength(0.05))
    .force("z", forceZ(0).strength(0.05))
    .stop();
  for (let i = 0; i < (fresh ? 260 : 120); i++) simulation.tick();

  // recentre a fresh layout so the camera orbits its middle
  if (fresh) {
    const m = sim.reduce((a, p) => ({ x: a.x + p.x / sim.length, y: a.y + p.y / sim.length, z: a.z + p.z / sim.length }), { x: 0, y: 0, z: 0 });
    for (const p of sim) {
      p.x -= m.x;
      p.y -= m.y;
      p.z -= m.z;
    }
  }
  const next = new Map(fresh ? [] : cache);
  for (const p of sim) next.set(p.id, { x: round(p.x), y: round(p.y), z: round(p.z) });
  save(ns, next);
  return next;
}

const round = (v: number) => Math.round(v * 100) / 100;
