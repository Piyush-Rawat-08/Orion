// The guided rehearsal: one decision played out on the real API, in four scenes. This file holds what the
// scenes share: plain names for the systems in the story, the fixed map layout every scene draws on, and the
// recording a run leaves behind (so a run can be replayed, clearly labelled, when the API is asleep).

import type { AffectedCustomer, Diff, GraphPayload } from "./types";

/** Set once a browser has seen the rehearsal; until then the workspace's front door sends it there. */
export const SEEN_KEY = "orion.rehearsal";

/** The decision the rehearsal is about. */
export const GOAL = { op: "deprecate_service", service: "sso-legacy" } as const;
export const DECISION = "Retire the legacy authentication service";

/** Tomasz's message in #billing: the new fact of scene four. */
export const NEWS = {
  channel: "#billing",
  author: "person:tomasz-nowak",
  name: "Tomasz Nowak",
  text: "BILL-207 is merged: invoice-render now gets its signing token from identity. It no longer calls sso-legacy at all.",
};

/** What each system in the story does, in a reader's words (from Corvane's service catalog). The identifier
 *  stays underneath for technical viewers. */
const HUMAN: Record<string, string> = {
  "sso-legacy": "Legacy sign-on",
  identity: "Identity",
  "invoice-render": "Invoice PDFs",
  "reports-legacy": "Nightly reports",
  "billing-api": "Billing",
  onboarding: "Sign-up and trials",
  "web-console": "Customer console",
  "edge-gateway": "Edge gateway",
  "flag-eval": "Feature flags",
  "secrets-vault": "Secrets vault",
};

export const human = (name: string) => HUMAN[name] ?? name;
export const bare = (uid: string) => uid.replace(/^[a-z]+:/, "");

/** "Move invoice-render onto identity" -> "Move Invoice PDFs onto Identity". */
export function humanLabel(label: string) {
  return label
    .replace(/^Move (\S+) onto (\S+)$/, (_, a, b) => `Move ${human(a)} onto ${human(b)}`)
    .replace(/^Switch (\S+) off too$/, (_, a) => `Also switch off ${human(a)}`)
    .replace(/^Switch off (\S+)$/, (_, a) => `Retire ${human(a)} now`);
}

// ------------------------------------------------------------------ the map

export interface MapNode {
  id: string; // the system's name, e.g. "invoice-render"
  col: number; // steps from the system being retired
  x: number;
  y: number;
  role: "root" | "service" | "successor";
}

export interface MapEdge {
  /** "dependent>dependency" */
  id: string;
  dependent: string;
  dependency: string;
  kind: string;
  declared: boolean;
  fact: string | null;
}

export interface CompanyMap {
  nodes: MapNode[];
  edges: MapEdge[];
  /** customers who use any system on the map, and which */
  customers: { uid: string; name: string; uses: string[] }[];
  cust: { x: number; y: number };
  W: number;
  H: number;
}

export const MAP_W = 1000;
export const MAP_H = 540;

/** The neighbourhood of the retired system, laid out once from the live graph: every system that relies on it,
 *  directly or through others, one column per step, plus the declared successor beneath it and the customers who
 *  use them at the end. Every scene draws on these positions, so a system never moves between scenes. */
export function buildMap(g: GraphPayload, root: string = GOAL.service, successor = "identity"): CompanyMap | null {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const name = (id: string) => byId.get(id)?.name ?? bare(id);
  const deps = g.edges.filter((e) => e.type === "DEPENDS_ON");
  const rootId = g.nodes.find((n) => n.name === root)?.id;
  if (!rootId) return null;
  const dist = new Map<string, number>([[rootId, 0]]);
  let frontier = [rootId];
  while (frontier.length) {
    const next: string[] = [];
    for (const x of frontier)
      for (const e of deps)
        if (e.target === x && !dist.has(e.source) && !byId.get(e.source)?.retired) {
          dist.set(e.source, dist.get(x)! + 1);
          next.push(e.source);
        }
    frontier = next;
  }
  const inSet = new Set(dist.keys());
  const edges: MapEdge[] = deps
    .filter((e) => inSet.has(e.source) && inSet.has(e.target))
    .map((e) => ({
      id: `${name(e.source)}>${name(e.target)}`,
      dependent: name(e.source),
      dependency: name(e.target),
      kind: e.kind ?? "sync",
      declared: e.declared !== false,
      fact: e.uid ?? null,
    }));

  const cols: string[][] = [];
  for (const [id, d] of dist) (cols[d] ??= []).push(id);
  const last = cols.length - 1;
  // the first column's labels sit to its left, so the lines leaving it never cross them
  const x0 = 210;
  const x1 = 770;
  const colX = (c: number) => x0 + (last ? (c * (x1 - x0)) / last : 0);
  const top = 70;
  const bottom = MAP_H - 70;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((ids, c) => {
    // order each column by where the systems it relies on sit, so lines cross as little as they can
    if (c > 0)
      ids.sort((a, b) => {
        const avg = (id: string) => {
          const ys = edges.filter((e) => e.dependent === name(id)).map((e) => pos.get(e.dependency)?.y).filter((y): y is number => y !== undefined);
          return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : 0;
        };
        return avg(a) - avg(b) || name(a).localeCompare(name(b));
      });
    const gap = Math.min(190, (bottom - top) / Math.max(1, ids.length));
    const span = gap * (ids.length - 1);
    const mid = c === 0 ? (top + bottom) / 2 - 60 : (top + bottom) / 2 - 20;
    ids.forEach((id, i) => pos.set(name(id), { x: colX(c), y: mid - span / 2 + i * gap }));
  });
  const nodes: MapNode[] = [...dist].map(([id, d]) => ({ id: name(id), col: d, ...pos.get(name(id))!, role: d === 0 ? "root" : "service" }));
  if (successor && !nodes.some((n) => n.id === successor) && g.nodes.some((n) => n.name === successor))
    nodes.push({ id: successor, col: 0, x: colX(0), y: bottom + 6, role: "successor" });

  const svcIds = new Set([...dist.keys()]);
  const uses = new Map<string, string[]>();
  for (const e of g.edges)
    if (e.type === "USES" && svcIds.has(e.target)) uses.set(e.source, [...(uses.get(e.source) ?? []), name(e.target)]);
  const customers = [...uses]
    .map(([uid, u]) => ({ uid, name: byId.get(uid)?.name ?? bare(uid), uses: u }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { nodes, edges, customers, cust: { x: 905, y: (top + bottom) / 2 - 20 }, W: MAP_W, H: MAP_H };
}

/** What one company state looks like on the map. */
export interface MapState {
  /** systems switched off */
  off: string[];
  /** system -> how it is hit */
  effects: Record<string, "break" | "degrade" | "stale" | string>;
  /** edge ids that no longer exist in this state */
  removed: string[];
  /** edges this state added (a dependency moved onto a new system) */
  added: { dependent: string; dependency: string }[];
  /** customers who would notice, by uid */
  customers: string[];
}

export const CALM: MapState = { off: [], effects: {}, removed: [], added: [], customers: [] };

/** The state a what-if's diff describes. */
export function stateOfDiff(d: Diff): MapState {
  return {
    off: d.structural.retired,
    effects: Object.fromEntries(d.broken.map((b) => [b.service, b.effect ?? "break"])),
    removed: [],
    added: [],
    customers: (d.customers ?? []).map((c: AffectedCustomer) => c.uid),
  };
}

export interface PlanMove {
  service: string;
  to?: string;
  from?: string | null;
  off?: boolean;
}

/** The state one explored future describes: the moves it made, and what still breaks. */
export function stateOfFuture(
  f: { effects?: Record<string, string>; broken: string[]; moves?: PlanMove[] },
  root: string,
  customersOf: (names: string[]) => string[],
): MapState {
  const moves = f.moves ?? [];
  const off = [root, ...moves.filter((m) => m.off).map((m) => m.service)];
  const effects = f.effects ?? Object.fromEntries(f.broken.map((b) => [b, "break"]));
  return {
    off,
    effects,
    removed: moves.filter((m) => m.to && m.from).map((m) => `${m.service}>${m.from}`),
    added: moves.filter((m) => m.to).map((m) => ({ dependent: m.service, dependency: m.to! })),
    customers: customersOf([...Object.keys(effects), ...off.slice(1)]),
  };
}

// ------------------------------------------------------------------ results in words

export function tally(effects: Record<string, string>) {
  const v = Object.values(effects);
  return { stop: v.filter((e) => e === "break").length, slow: v.filter((e) => e !== "break").length };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 systems stop, 3 slow down" / "1 system stops, none slow down". */
export function hitLine(stop: number, slow: number) {
  const a = stop ? `${plural(stop, "system")} ${stop === 1 ? "stops" : "stop"}` : "Nothing stops";
  return `${a}, ${slow ? `${slow} ${stop ? "" : "systems "}slow down` : "none slow down"}`.replace("  ", " ");
}

/** "Waits on BILL-207, which IDN-58 blocks" from a step's prerequisites. */
export function waitsOn(ps: { key: string; blocks?: string }[]) {
  const main = ps.filter((p) => !p.blocks).map((p) => p.key);
  const blockers = ps.filter((p) => p.blocks);
  if (!main.length) return "";
  const by = blockers.map((b) => b.key);
  return `Waits on ${main.join(" and ")}${by.length ? `, which ${by.join(" and ")} ${by.length === 1 ? "blocks" : "block"}` : ""}`;
}

// ------------------------------------------------------------------ the recording

/** Everything a live run returned, in order: enough to replay the run without the API. */
export interface Recording {
  at: string;
  tenant: string;
  graph: GraphPayload;
  fork: { uid: string; copy_ms: number; apply_ms: number; ms: number };
  diff: Diff;
  source: Record<string, unknown> | null;
  /** each event with `t`, ms since the stream opened, so a replay keeps the run's rhythm */
  plan: { events: { event: string; data: Record<string, unknown>; t?: number }[]; ms: number };
  news: { events: { event: string; data: Record<string, unknown>; t?: number }[]; ms: number };
  after: { fork: { uid: string; copy_ms: number; apply_ms: number; ms: number }; diff: Diff } | null;
  answer: { before: AnswerLite | null; after: AnswerLite | null };
}

export interface AnswerLite {
  uid: string;
  question: string;
  at: string;
  summary: string;
  claims: { text: string; verdict: string; stale?: boolean | null; stale_reason?: string | null }[];
}
