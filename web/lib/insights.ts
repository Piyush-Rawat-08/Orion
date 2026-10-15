// Things the map can tell you on its own, without asking the assistant: what would stop working if a system went
// down (worked out from the "relies on" connections on screen), and the stops of the guided tour (the biggest
// team, the system most others rely on, knowledge held by too few people...). Both read only the nodes and
// connections the canvas is showing, so they cost nothing and answer instantly.

import { nameOf } from "./explain";
import type { GEdge, GNode } from "./types";

export interface Impact {
  origin: string;
  /** system id -> how many steps away from the one that went down (1 = relies on it directly) */
  broken: Map<string, number>;
  maxHops: number;
  teams: string[];
  customers: string[];
}

/** If `origin` stopped working: everything that relies on it, directly or through others, and who would feel it. */
export function impactOf(origin: string, nodes: GNode[], edges: GEdge[]): Impact {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // who relies on whom, read backwards: target -> the systems that rely on it
  const reliers = new Map<string, string[]>();
  for (const e of edges)
    if (e.type === "DEPENDS_ON") {
      if (!reliers.has(e.target)) reliers.set(e.target, []);
      reliers.get(e.target)!.push(e.source);
    }
  const broken = new Map<string, number>();
  let frontier = [origin];
  let hops = 0;
  while (frontier.length) {
    hops++;
    const next: string[] = [];
    for (const id of frontier)
      for (const s of reliers.get(id) ?? [])
        if (s !== origin && !broken.has(s) && !byId.get(s)?.retired) {
          broken.set(s, hops);
          next.push(s);
        }
    frontier = next;
  }
  const hit = new Set([origin, ...broken.keys()]);
  const teams = new Set<string>();
  const customers = new Set<string>();
  for (const e of edges) {
    if (!hit.has(e.target)) continue;
    if (e.type === "OWNS" || e.type === "ON_CALL_FOR") teams.add(e.source);
    if ((e.type === "USES" || e.type === "RAISED_ABOUT") && byId.get(e.source)?.type === "Customer") customers.add(e.source);
  }
  return { origin, broken, maxHops: Math.max(0, ...broken.values()), teams: [...teams], customers: [...customers] };
}

export interface TourStop {
  /** the node the camera visits; null frames the whole map */
  id: string | null;
  title: string;
  body: string;
}

const list = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A one-minute walk through the company: what it is made of, then the few things worth knowing about it. */
export function tourOf(nodes: GNode[], edges: GEdge[]): TourStop[] {
  const live = nodes.filter((n) => !n.retired && !n.former);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const of = (t: GNode["type"]) => live.filter((n) => n.type === t);
  const name = (id: string) => nameOf(byId.get(id));
  const tally = (pick: (e: GEdge) => string | null) => {
    const m = new Map<string, number>();
    for (const e of edges) {
      const k = pick(e);
      if (k && byId.has(k)) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const top = (m: Map<string, number>, ok: (id: string) => boolean = () => true) =>
    [...m.entries()].filter(([id]) => ok(id) && !byId.get(id)?.retired && !byId.get(id)?.former).sort((a, b) => b[1] - a[1])[0];

  const people = of("Person").length,
    teams = of("Team").length,
    systems = of("Service").length,
    customers = of("Customer").length;
  const stops: TourStop[] = [
    {
      id: null,
      title: "Your company, as one map",
      body: `${count(people, "person", "people")} in ${count(teams, "team", "teams")}, running ${count(systems, "system", "systems")}${
        customers ? ` for ${count(customers, "customer", "customers")}` : ""
      }. Every line is a real connection Orion found in the company's records and conversations.`,
    },
  ];

  const members = tally((e) => (e.type === "MEMBER_OF" ? e.target : null));
  const owned = tally((e) => (e.type === "OWNS" ? e.source : null));
  const team = top(members);
  if (team) {
    const o = owned.get(team[0]) ?? 0;
    stops.push({
      id: team[0],
      title: name(team[0]),
      body: `The biggest team: ${count(team[1], "person", "people")}${o ? `, responsible for ${count(o, "system", "systems")}` : ""}. The ring around it is the team; the dots around it are its people.`,
    });
  }

  // the system the most others would go down with, counting knock-on effects
  let hub: { id: string; n: number } | null = null;
  for (const s of of("Service")) {
    const n = impactOf(s.id, nodes, edges).broken.size;
    if (n && (!hub || n > hub.n)) hub = { id: s.id, n };
  }
  if (hub)
    stops.push({
      id: hub.id,
      title: name(hub.id),
      body: `The system the most others depend on: if it stopped, ${count(hub.n, "other system", "other systems")} would stop with it. Open it and press “What if this stopped working?” to watch it happen.`,
    });

  // knowledge held by too few people: the most important system the fewest people know
  const knowers = new Map<string, string[]>();
  for (const e of edges)
    if (e.type === "KNOWS" && !byId.get(e.source)?.former) {
      if (!knowers.has(e.target)) knowers.set(e.target, []);
      knowers.get(e.target)!.push(e.source);
    }
  const fragile = of("Service")
    .filter((s) => s.id !== hub?.id)
    .map((s) => ({ s, k: knowers.get(s.id) ?? [] }))
    .sort((a, b) => (a.s.tier ?? 3) - (b.s.tier ?? 3) || a.k.length - b.k.length)
    .find((x) => x.k.length <= 1 && (x.s.tier ?? 3) <= 2);
  if (fragile)
    stops.push({
      id: fragile.s.id,
      title: nameOf(fragile.s),
      body: fragile.k.length
        ? `Only ${name(fragile.k[0])} knows how this ${fragile.s.tier === 1 ? "business-critical" : "important"} system works. If they left, nobody would.`
        : `Nobody still at the company has worked on this ${fragile.s.tier === 1 ? "business-critical" : "important"} system recently.`,
    });

  const collab = tally((e) => (e.type === "COLLABORATES" ? e.source : null));
  for (const [k, v] of tally((e) => (e.type === "COLLABORATES" ? e.target : null))) collab.set(k, (collab.get(k) ?? 0) + v);
  const hubPerson = top(collab);
  if (hubPerson)
    stops.push({
      id: hubPerson[0],
      title: name(hubPerson[0]),
      body: `Works with ${count(hubPerson[1], "person", "people")}, more than anyone else. A lot of the company's work passes through them.`,
    });

  const custLinks = tally((e) => ((e.type === "USES" || e.type === "RAISED_ABOUT") && byId.get(e.source)?.type === "Customer" ? e.source : null));
  const cust = top(custLinks);
  if (cust) {
    const raised = edges.filter((e) => e.source === cust[0] && e.type === "RAISED_ABOUT").map((e) => name(e.target));
    stops.push({
      id: cust[0],
      title: name(cust[0]),
      body: raised.length
        ? `A customer who has raised problems about ${list(raised)}. Anything that changes there, they will notice first.`
        : `A customer that relies on ${cust[1] === 1 ? "one of your systems" : `${cust[1]} of your systems`}. Anything that changes there, they will notice.`,
    });
  }

  const shapes = tally((e) => (e.type === "AFFECTS" ? e.source : null));
  const dec = top(shapes);
  if (dec) {
    const d = byId.get(dec[0])!;
    stops.push({
      id: dec[0],
      title: d.name ? `${nameOf(d)}: ${d.name}` : nameOf(d),
      body: `A decision that shapes ${count(dec[1], "system", "systems")}. Orion keeps the reasons behind decisions next to what they affect.`,
    });
  }

  stops.push({
    id: null,
    title: "That's the tour",
    body: "Click anything to see how it connects, or open What-ifs to test a change before you make it.",
  });
  // never visit the same thing twice
  const seen = new Set<string>();
  return stops.filter((s) => !s.id || (!seen.has(s.id) && (seen.add(s.id), true)));
}
