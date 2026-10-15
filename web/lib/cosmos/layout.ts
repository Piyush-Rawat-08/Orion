// Where everything sits in the sky. The company is a spiral galaxy: each team is an arm, services are the bright
// stars along it (tier 1 closest to the core), people are the smaller stars around their team's services,
// customers form a tilted halo far out, and people who left drift beyond the rim. Positions depend only on uid
// and team, so the same star is in the same place now, in 2024, and in any universe.

import { hash01 } from "@/lib/palette";
import type { Galaxy } from "@/lib/types";

export const TEAM_ORDER = ["team:platform", "team:billing", "team:runtime", "team:signals", "team:console", "team:data"];
export const R_CORE = 14;
export const R_ARM = 118;
export const R_HALO = 178;
export const TWIST = 2.15;

export type Kind = "service" | "person" | "customer" | "retired" | "former" | "team";
export type Placed = { id: string; kind: Kind; x: number; y: number; z: number };

function armIndex(team: string | null | undefined): number {
  const i = team ? TEAM_ORDER.indexOf(team) : -1;
  return i >= 0 ? i : Math.floor(hash01(team ?? "none") * TEAM_ORDER.length);
}

/** A point on a team's arm: t in 0..1 from the core outward, `side` across the arm, `lift` above the disk. */
export function armPoint(team: string | null | undefined, t: number, side = 0, lift = 0): [number, number, number] {
  const k = armIndex(team);
  const base = (k / TEAM_ORDER.length) * Math.PI * 2;
  const r = R_CORE + (R_ARM - R_CORE) * t;
  const a = base + TWIST * t;
  // across the arm = perpendicular to the radius in the disk
  const x = r * Math.cos(a) - side * Math.sin(a);
  const z = r * Math.sin(a) + side * Math.cos(a);
  return [x, lift, z];
}

const TIER_BAND: Record<number, [number, number]> = { 1: [0.16, 0.52], 2: [0.42, 0.76], 3: [0.66, 0.94] };

export function servicePos(id: string, team: string | null, tier: number): [number, number, number] {
  const [lo, hi] = TIER_BAND[tier] ?? [0.3, 0.9];
  const t = lo + (hi - lo) * hash01(id, 1);
  return armPoint(team, t, (hash01(id, 2) - 0.5) * 18, (hash01(id, 3) - 0.5) * 6);
}

export function personPos(id: string, team: string | null): [number, number, number] {
  const t = 0.12 + 0.84 * hash01(id, 4);
  const side = (hash01(id, 5) < 0.5 ? -1 : 1) * (9 + hash01(id, 6) * 13);
  return armPoint(team, t, side, (hash01(id, 7) - 0.5) * 12);
}

export function customerPos(id: string, tier: string): [number, number, number] {
  const a = hash01(id, 8) * Math.PI * 2;
  const r = R_HALO + (tier === "enterprise" ? -8 : tier === "growth" ? 6 : 18) + hash01(id, 9) * 10;
  const tilt = 0.22; // the halo is inclined to the disk
  return [r * Math.cos(a), Math.sin(a) * r * Math.sin(tilt) + (hash01(id, 10) - 0.5) * 8, r * Math.sin(a) * Math.cos(tilt)];
}

export function formerPos(id: string): [number, number, number] {
  const a = hash01(id, 11) * Math.PI * 2;
  const r = R_ARM + 26 + hash01(id, 12) * 20;
  return [r * Math.cos(a), (hash01(id, 13) - 0.5) * 30, r * Math.sin(a)];
}

export function teamPos(team: string): [number, number, number] {
  return armPoint(team, 0.55, 0, 0);
}

export function place(g: Galaxy): Placed[] {
  const out: Placed[] = [];
  for (const t of g.teams) out.push({ id: t.id, kind: "team", ...xyz(teamPos(t.id)) });
  for (const s of g.services) out.push({ id: s.id, kind: "service", ...xyz(servicePos(s.id, s.team, s.tier)) });
  for (const s of g.retired) out.push({ id: s.id, kind: "retired", ...xyz(servicePos(s.id, s.team, s.tier)) });
  for (const p of g.people) out.push({ id: p.id, kind: "person", ...xyz(personPos(p.id, p.team)) });
  for (const p of g.former) out.push({ id: p.id, kind: "former", ...xyz(formerPos(p.id)) });
  for (const c of g.customers) out.push({ id: c.id, kind: "customer", ...xyz(customerPos(c.id, c.tier)) });
  return out;
}

function xyz([x, y, z]: [number, number, number]) {
  return { x, y, z };
}
