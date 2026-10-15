"use client";

// The blast radius of a fork, drawn left to right: what the change retires in the first column, everything that
// breaks by its distance from it (1, 2, 3, 4+ hops), and the teams and customers behind them last. Breakage
// travels column by column once, 150 ms a column, the first time a universe is shown; then the drawing sits
// still. Dependencies nobody wrote down are dashed amber. Readable at any size, phones included.

import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFirstTime } from "../motion";
import { C } from "@/lib/theme";
import type { Diff } from "@/lib/types";

type Size = "full" | "compact" | "mini";

interface BNode {
  id: string;
  label: string;
  col: number;
  kind: "root" | "service" | "team" | "customer";
  effect?: "break" | "degrade" | "stale";
  tier?: number;
  x: number;
  y: number;
}

interface BEdge {
  a: string;
  b: string;
  undeclared: boolean;
  col: number;
  soft: boolean;
}

const GEOM: Record<Size, { colW: number; rowH: number; r: number; pad: number; perCol: number; labels: boolean }> = {
  full: { colW: 172, rowH: 30, r: 5, pad: 26, perCol: 16, labels: true },
  compact: { colW: 150, rowH: 26, r: 4.5, pad: 18, perCol: 10, labels: true },
  mini: { colW: 22, rowH: 5, r: 1.6, pad: 3, perCol: 6, labels: false },
};

const short = (uid: string) => uid.replace(/^[a-z]+:/, "");

/** Columns, positions and edges for the drawing. Pure, so it is computed once per diff. */
function layout(diff: Diff, size: Size, avail: number | null) {
  const base = GEOM[size];
  // universes forked before witness paths were recorded only know each service's distance from what retired it:
  // they are drawn from that root straight to their column
  const broken = diff.broken.map((b) =>
    b.path && b.path.length > 1
      ? b
      : { ...b, path: [`root:${b.because_of}`, ...Array.from({ length: Math.max(0, b.hops - 1) }, (_, i) => `gap:${b.uid}:${i}`), b.uid], fact_uids: [] },
  );
  const nodes = new Map<string, BNode>();
  const edges = new Map<string, BEdge>();
  const nameByUid = new Map(diff.broken.map((b) => [b.uid, b.service]));
  const uidByName = new Map(diff.broken.map((b) => [b.service, b.uid]));
  // a service can be on several paths: it keeps its nearest column, and its own effect and tier
  const put = (id: string, n: Omit<BNode, "x" | "y" | "id">) => {
    const old = nodes.get(id);
    const known = Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined)) as Partial<BNode>;
    nodes.set(id, {
      id,
      x: 0,
      y: 0,
      ...old,
      ...known,
      label: old?.label ?? n.label,
      kind: old?.kind === "root" ? "root" : n.kind,
      col: old ? Math.min(old.col, n.col) : n.col,
    });
  };
  for (const b of broken) {
    const path = b.path!;
    // fact uids run from this service back to the root; turn them around to line up with the path
    const facts = [...b.fact_uids].reverse();
    path.forEach((u, i) =>
      !u.startsWith("gap:") &&
      put(u, {
        label: i === 0 ? b.because_of : nameByUid.get(u) ?? short(u),
        col: Math.min(i, 4),
        kind: i === 0 ? "root" : "service",
        effect: i === path.length - 1 ? b.effect ?? "break" : undefined,
        tier: i === path.length - 1 ? b.tier : undefined,
      }),
    );
    for (let i = 1; i < path.length; i++) {
      if (path[i].startsWith("gap:") || path[i - 1].startsWith("gap:")) continue;
      const k = `${path[i - 1]}>${path[i]}`;
      if (!edges.has(k))
        edges.set(k, {
          a: path[i - 1],
          b: path[i],
          undeclared: b.via_undeclared.includes(facts[i - 1]),
          col: Math.min(i, 4),
          soft: (b.effect ?? "break") !== "break" && i === path.length - 1,
        });
    }
  }
  for (const b of broken)
    if (b.path!.some((u) => u.startsWith("gap:")))
      edges.set(`${b.path![0]}>${b.uid}`, {
        a: b.path![0],
        b: b.uid,
        undeclared: b.via_undeclared.length > 0,
        col: Math.min(b.hops, 4),
        soft: (b.effect ?? "break") !== "break",
      });
  if (!nodes.size) return null;
  const last = Math.max(...[...nodes.values()].map((n) => n.col)) + 1;
  // the full drawing spreads its columns over the width it has (between 120 and 200 px a column)
  const g =
    size === "full" && avail
      ? { ...base, colW: Math.max(120, Math.min(200, (avail - base.pad * 2 - 130) / last)) }
      : base;
  // the people behind what breaks: owning teams and exposed customers
  const owners = new Map<string, string[]>();
  for (const b of broken) for (const t of b.owners) owners.set(t, [...(owners.get(t) ?? []), b.uid]);
  for (const [team, svcs] of owners) {
    put(`team:${team}`, { label: team, col: last, kind: "team" });
    for (const s of svcs) edges.set(`${s}>team:${team}`, { a: s, b: `team:${team}`, undeclared: false, col: last, soft: true });
  }
  for (const c of diff.customers ?? []) {
    put(c.uid, { label: c.customer, col: last, kind: "customer" });
    for (const s of c.services) {
      const su = uidByName.get(s);
      if (su) edges.set(`${su}>${c.uid}`, { a: su, b: c.uid, undeclared: false, col: last, soft: true });
    }
  }

  // columns, each ordered by where its parents sit, so lines cross as little as they can
  const cols: BNode[][] = Array.from({ length: last + 1 }, () => []);
  for (const n of nodes.values()) cols[n.col].push(n);
  const hidden = new Map<number, number>();
  const parents = new Map<string, string[]>();
  for (const e of edges.values()) parents.set(e.b, [...(parents.get(e.b) ?? []), e.a]);
  const rows = Math.min(g.perCol, Math.max(...cols.map((c) => c.length)));
  const H = g.pad * 2 + Math.max(1, rows - 1) * g.rowH + (size === "full" ? 22 : 0);
  const top = g.pad + (size === "full" ? 22 : 0);
  cols.forEach((col, ci) => {
    if (ci > 0)
      col.sort((p, q) => {
        const avg = (n: BNode) => {
          const ys = (parents.get(n.id) ?? []).map((u) => nodes.get(u)?.y ?? 0);
          return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
        };
        // teams before customers in the last column; otherwise by parent position, then by tier
        return (p.kind === q.kind ? 0 : p.kind === "team" ? -1 : q.kind === "team" ? 1 : 0) || avg(p) - avg(q) || (p.tier ?? 9) - (q.tier ?? 9);
      });
    if (col.length > g.perCol) {
      hidden.set(ci, col.length - g.perCol + 1);
      for (const n of col.splice(g.perCol - 1)) nodes.delete(n.id);
    }
    const span = (Math.max(1, col.length) - 1) * g.rowH;
    const y0 = top + ((rows - 1) * g.rowH - span) / 2;
    col.forEach((n, i) => {
      n.x = g.pad + ci * g.colW;
      n.y = col.length === 1 ? top + ((rows - 1) * g.rowH) / 2 : y0 + i * g.rowH;
    });
  });
  const W = g.pad * 2 + last * g.colW + (g.labels ? 130 : 0);
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].filter((e) => nodes.has(e.a) && nodes.has(e.b)),
    last,
    W,
    H,
    hidden,
    cols,
    colW: g.colW,
  };
}

export default function BlastRadius({
  diff,
  size = "full",
  className = "",
}: {
  diff: Diff;
  size?: Size;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (size !== "full" || !el) return;
    const ro = new ResizeObserver(() => setAvail(Math.round(el.clientWidth / 20) * 20 || null));
    ro.observe(el);
    return () => ro.disconnect();
  }, [size]);
  const L = useMemo(() => layout(diff, size, avail), [diff, size, avail]);
  const reduce = useReducedMotion();
  const first = useFirstTime(`blast:${size}:${diff.universe}`);
  const end = L ? L.last : 0;
  const [step, setStep] = useState(first && !reduce ? -1 : end);
  useEffect(() => {
    if (!first || reduce) {
      setStep(end);
      return;
    }
    const timers = Array.from({ length: end + 1 }, (_, c) => setTimeout(() => setStep(c), 300 + c * 150));
    return () => timers.forEach(clearTimeout);
  }, [first, reduce, end]);
  if (!L) return <div ref={box} />;
  const g = { ...GEOM[size], colW: L.colW };

  const byId = new Map(L.nodes.map((n) => [n.id, n]));
  const hit = (col: number) => step >= col;
  const red = C.bad;
  const amber = C.undeclared;
  const nodeColor = (n: BNode) =>
    n.kind === "team" ? C.text : n.kind === "customer" ? C.partial : n.effect && n.effect !== "break" ? C.partial : red;
  // every customer who would notice, including any the column had no room to draw
  const customers = diff.customers?.length ?? 0;
  const header = ["Switched off", "Directly", "2 steps away", "3 steps away", "4+ steps away"];

  return (
    <div ref={box} className="w-full min-w-0 overflow-x-auto">
    <svg
      width={L.W}
      height={L.H}
      viewBox={`0 0 ${L.W} ${L.H}`}
      className={`block max-w-none ${className}`}
      role="img"
      aria-label={`How it spreads: ${diff.broken.length} systems stop working, by how far they are from what the change switches off; ${customers} customers and the teams responsible`}
    >
      {size === "full" &&
        Array.from({ length: L.last + 1 }, (_, c) => (
          <text key={c} x={g.pad + c * g.colW - g.r} y={14} fontSize={11} fill="var(--color-muted)" fontFamily="var(--font-sans)">
            {c === L.last ? (customers ? `Teams and ${customers} customer${customers === 1 ? "" : "s"}` : "Teams responsible") : header[c]}
          </text>
        ))}
      {L.edges.map((e) => {
        const p = byId.get(e.a)!;
        const q = byId.get(e.b)!;
        const mx = (p.x + q.x) / 2;
        const on = hit(e.col);
        const color = e.undeclared ? amber : on ? (e.soft ? C.muted : red) : C.retired;
        return (
          <path
            key={`${e.a}>${e.b}`}
            d={`M${p.x + g.r} ${p.y} C${mx} ${p.y}, ${mx} ${q.y}, ${q.x - g.r} ${q.y}`}
            fill="none"
            stroke={color}
            strokeOpacity={e.undeclared ? 0.95 : on ? (e.soft ? 0.45 : 0.7) : 0.35}
            strokeWidth={size === "mini" ? 0.8 : on && !e.soft ? 1.6 : 1.1}
            strokeDasharray={e.undeclared ? (size === "mini" ? "2 1.5" : "4 3") : undefined}
            style={{ transition: "stroke 150ms ease-out, stroke-opacity 150ms ease-out, stroke-width 150ms ease-out" }}
          >
            {e.undeclared && size !== "mini" && <title>Nobody wrote this connection down: Orion found it in a conversation</title>}
          </path>
        );
      })}
      {L.nodes.map((n) => {
        const on = hit(n.col);
        const c = nodeColor(n);
        const r = n.kind === "root" ? g.r + (size === "mini" ? 0.6 : 1.5) : g.r;
        return (
          <g key={n.id} transform={`translate(${n.x},${n.y})`}>
            <title>{n.label}</title>
            {n.kind === "team" ? (
              <rect
                x={-r}
                y={-r}
                width={r * 2}
                height={r * 2}
                rx={1.5}
                fill={on ? c : "var(--color-panel)"}
                stroke={on ? c : C.retired}
                strokeWidth={1.3}
                style={{ transition: "fill 150ms ease-out, stroke 150ms ease-out" }}
              />
            ) : (
              <circle
                r={r}
                fill={n.kind === "root" || (on && n.kind !== "customer") ? (on ? c : C.retired) : "var(--color-panel)"}
                stroke={on ? c : C.retired}
                strokeWidth={n.kind === "customer" ? 2 : 1.3}
                style={{ transition: "fill 150ms ease-out, stroke 150ms ease-out" }}
              />
            )}
            {g.labels && (
              <text
                x={r + 6}
                y={3.8}
                fontSize={11}
                fontWeight={500}
                fontFamily="var(--font-sans)"
                fill={on ? "var(--color-ink)" : "var(--color-muted)"}
                paintOrder="stroke"
                stroke="var(--color-panel)"
                strokeWidth={3}
                style={{ transition: "fill 150ms ease-out" }}
              >
                {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
              </text>
            )}
          </g>
        );
      })}
      {g.labels &&
        [...L.hidden].map(([col, n]) => (
          <text key={col} x={g.pad + col * g.colW + g.r + 6} y={L.H - 6} fontSize={11} fill="var(--color-muted)" fontFamily="var(--font-sans)">
            and {n} more
          </text>
        ))}
    </svg>
    </div>
  );
}

/** The legend for the full drawing. */
export function BlastLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
      <li className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full" style={{ background: C.bad }} /> stops working
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full" style={{ background: C.partial }} /> slows down or gets out-of-date data
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className="inline-block w-4 border-t-[1.5px] border-dashed" style={{ borderColor: C.undeclared }} /> connection nobody wrote down
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded" style={{ background: C.text }} /> team responsible
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full border-2" style={{ borderColor: C.partial }} /> customer
      </li>
    </ul>
  );
}
