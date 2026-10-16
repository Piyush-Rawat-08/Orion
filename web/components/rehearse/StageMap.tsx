"use client";

// The rehearsal's map: the retired system on the left, everything that relies on it one column per step, the
// customers who use them on the right. Positions come from buildMap() once, so the same system sits in the same
// place in every scene and every miniature: the viewer learns one map, not a new puzzle per screen.
//
// A state colours it: switched off (struck through), stops (red), slows down (amber), a dependency moved (green
// line drawn in, the old one fading). `reveal` walks the consequences out column by column; each newly reached
// column gets a single spark along the dependency that carried the failure, then the drawing sits still.

import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import type { CompanyMap, MapEdge, MapState } from "@/lib/rehearsal";
import { human } from "@/lib/rehearsal";

const RED = "var(--color-bad)";
const AMBER = "var(--color-warn)";
const GREEN = "var(--color-ok)";
const QUIET = "var(--color-rule-strong)";

function curve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const mx = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
}

export default function StageMap({
  map,
  state,
  reveal = Infinity,
  mini = false,
  focus,
  onEdge,
  label,
  className = "",
}: {
  map: CompanyMap;
  state: MapState;
  /** how far the consequences have travelled: columns up to this one are lit; customers after the last */
  reveal?: number;
  mini?: boolean;
  /** an edge to point at (the dependency nobody wrote down) */
  focus?: string | null;
  onEdge?: (e: MapEdge) => void;
  label?: string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const pos = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map]);
  const colOf = (id: string) => pos.get(id)?.col ?? 0;
  const lastCol = Math.max(0, ...map.nodes.filter((n) => n.role !== "successor").map((n) => n.col));
  const off = new Set(state.off);
  const removed = new Set(state.removed);
  const hit = (id: string) => off.has(id) || !!state.effects[id];
  const shown = (id: string) => colOf(id) <= reveal;
  const r = mini ? 11 : 15;

  const edges = map.edges.map((e) => {
    const a = pos.get(e.dependency)!;
    const b = pos.get(e.dependent)!;
    const effect = state.effects[e.dependent];
    const lit = !removed.has(e.id) && hit(e.dependency) && !!effect && shown(e.dependent);
    return { e, a, b, effect, lit, gone: removed.has(e.id) };
  });
  const added = state.added
    .map((x) => ({ ...x, a: pos.get(x.dependency), b: pos.get(x.dependent) }))
    .filter((x): x is typeof x & { a: NonNullable<typeof x.a>; b: NonNullable<typeof x.b> } => !!x.a && !!x.b);

  const affected = new Set(state.customers);
  const custLit = reveal > lastCol;
  const perRow = 4;
  const cell = mini ? 22 : 19;
  const rows = Math.ceil(map.customers.length / perRow);
  const gx = map.cust.x - ((perRow - 1) * cell) / 2;
  const gy = map.cust.y - ((rows - 1) * cell) / 2;
  const custEdges = [...new Set(map.customers.flatMap((c) => c.uses))].map((s) => ({
    s,
    a: pos.get(s),
    lit: custLit && map.customers.some((c) => c.uses.includes(s) && affected.has(c.uid)),
  }));
  const nAffected = map.customers.filter((c) => affected.has(c.uid)).length;

  return (
    <svg
      viewBox={`0 0 ${map.W} ${map.H}`}
      className={`block h-auto w-full select-none ${className}`}
      role="img"
      aria-label={
        label ??
        `Map: ${map.nodes.map((n) => `${n.id}${off.has(n.id) ? " switched off" : state.effects[n.id] ? ` ${state.effects[n.id] === "break" ? "stops" : "slows down"}` : ""}`).join(", ")}; ${nAffected} of ${map.customers.length} customers affected`
      }
    >
      {/* the customers' lines: from each system they use to the block of customers */}
      {custEdges.map(({ s, a, lit }) =>
        a ? (
          <path
            key={`c-${s}`}
            d={curve({ x: a.x + r, y: a.y }, { x: gx - (mini ? 18 : 22), y: map.cust.y })}
            fill="none"
            stroke={lit ? RED : QUIET}
            strokeOpacity={lit ? 0.45 : 0.5}
            strokeWidth={mini ? 2 : 1.2}
            strokeDasharray={mini ? undefined : "2 4"}
            style={{ transition: "stroke 400ms ease-out, stroke-opacity 400ms ease-out" }}
          />
        ) : null,
      )}

      {/* dependencies */}
      {edges.map(({ e, a, b, effect, lit, gone }) => {
        const d = curve({ x: a.x + r, y: a.y }, { x: b.x - r, y: b.y });
        const color = gone ? QUIET : lit ? (effect === "break" ? RED : AMBER) : !e.declared ? AMBER : QUIET;
        const focused = focus === e.id;
        return (
          <g key={e.id}>
            {focused && !gone && (
              <motion.path
                d={d}
                fill="none"
                stroke={AMBER}
                strokeWidth={14}
                strokeLinecap="round"
                initial={{ strokeOpacity: 0 }}
                animate={{ strokeOpacity: reduce ? 0.18 : [0.08, 0.26, 0.08] }}
                transition={{ duration: 2.2, repeat: reduce ? 0 : Infinity, ease: "easeInOut" }}
              />
            )}
            <motion.path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={mini ? (lit ? 4 : 2.6) : lit ? 2.6 : 1.6}
              strokeDasharray={!e.declared ? (mini ? "7 5" : "6 5") : undefined}
              strokeLinecap="round"
              initial={false}
              animate={{ opacity: gone ? 0.14 : 1 }}
              transition={{ duration: 0.9 }}
              style={{ transition: "stroke 300ms ease-out, stroke-width 300ms ease-out" }}
            />
            {onEdge && !e.declared && !gone && (
              <path
                d={d}
                fill="none"
                stroke="transparent"
                strokeWidth={22}
                className="cursor-pointer"
                onClick={() => onEdge(e)}
                role="button"
                aria-label={`Where the link from ${e.dependent} to ${e.dependency} came from`}
              >
                <title>Nobody wrote this dependency down. Click to see where Orion found it.</title>
              </path>
            )}
            {/* one spark along the dependency that carried the failure, the moment its column is reached */}
            {lit && !mini && !reduce && reveal !== Infinity && colOf(e.dependent) === reveal && (
              <motion.circle
                key={`s-${reveal}`}
                r={5}
                fill={effect === "break" ? RED : AMBER}
                initial={{ offsetDistance: "0%", opacity: 1 }}
                animate={{ offsetDistance: "100%", opacity: [1, 1, 0] }}
                transition={{ duration: 0.75, ease: [0.65, 0, 0.35, 1] }}
                style={{ offsetPath: `path("${d}")` }}
              />
            )}
          </g>
        );
      })}

      {/* dependencies a state moved onto a new system */}
      {added.map((x) => {
        const d = curve({ x: x.a.x + r, y: x.a.y }, { x: x.b.x - r, y: x.b.y });
        return (
          <motion.path
            key={`add-${x.dependent}>${x.dependency}`}
            d={d}
            fill="none"
            stroke={GREEN}
            strokeWidth={mini ? 3.6 : 2.4}
            strokeLinecap="round"
            initial={reduce || mini ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.3 }}
          />
        );
      })}

      {/* systems */}
      {map.nodes.map((n) => {
        const isOff = off.has(n.id);
        const eff = state.effects[n.id];
        const on = shown(n.id);
        const color = isOff ? "var(--color-faint)" : eff && on ? (eff === "break" ? RED : AMBER) : n.role === "successor" ? "var(--color-ink)" : "var(--color-muted)";
        const tag = isOff ? "switched off" : eff && on ? (eff === "break" ? "stops" : "slows down") : n.role === "successor" ? "its successor" : null;
        return (
          <g key={n.id} transform={`translate(${n.x},${n.y})`}>
            <title>{`${human(n.id)} (${n.id})${tag ? `: ${tag}` : ""}`}</title>
            {eff && on && !isOff && (
              <motion.circle
                r={r + (mini ? 7 : 11)}
                fill={eff === "break" ? RED : AMBER}
                initial={reduce ? false : { scale: 0.4, opacity: 0.5 }}
                animate={{ scale: 1, opacity: 0.14 }}
                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              />
            )}
            <circle
              r={r}
              fill={eff && on && !isOff ? `color-mix(in oklab, ${eff === "break" ? RED : AMBER} 26%, var(--color-panel))` : "var(--color-panel)"}
              stroke={color}
              strokeWidth={mini ? 3.4 : 2}
              strokeDasharray={n.role === "successor" && !mini ? "3 3" : undefined}
              style={{ transition: "stroke 300ms ease-out, fill 300ms ease-out" }}
            />
            {isOff && (
              <motion.path
                d={`M ${-r * 0.62} ${r * 0.62} L ${r * 0.62} ${-r * 0.62}`}
                stroke="var(--color-faint)"
                strokeWidth={mini ? 3.4 : 2}
                strokeLinecap="round"
                initial={reduce || mini ? false : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.4 }}
              />
            )}
            {!mini && (
              <>
                <text
                  x={n.col === 0 ? -(r + 12) : 0}
                  y={n.col === 0 ? 1 : r + 24}
                  textAnchor={n.col === 0 ? "end" : "middle"}
                  fontSize={18}
                  fontWeight={600}
                  fontFamily="var(--font-display)"
                  fill={isOff ? "var(--color-faint)" : "var(--color-ink)"}
                  textDecoration={isOff ? "line-through" : undefined}
                  paintOrder="stroke"
                  stroke="var(--color-night)"
                  strokeWidth={5}
                >
                  {human(n.id)}
                </text>
                <text x={n.col === 0 ? -(r + 12) : 0} y={n.col === 0 ? 20 : r + 43} textAnchor={n.col === 0 ? "end" : "middle"} fontSize={13} fontFamily="var(--font-mono)" fill="var(--color-faint)" paintOrder="stroke" stroke="var(--color-night)" strokeWidth={4}>
                  {n.id}
                  {tag && n.col !== 0 ? ` · ${tag}` : ""}
                </text>
                {/* the first column has less room to its left: its tag gets a line of its own */}
                {tag && n.col === 0 && (
                  <text x={-(r + 12)} y={37} textAnchor="end" fontSize={13} fontFamily="var(--font-mono)" fill="var(--color-faint)" paintOrder="stroke" stroke="var(--color-night)" strokeWidth={4}>
                    {tag}
                  </text>
                )}
              </>
            )}
          </g>
        );
      })}

      {/* customers: one dot each */}
      <g>
        {map.customers.map((c, i) => {
          const lit = custLit && affected.has(c.uid);
          return (
            <motion.circle
              key={c.uid}
              cx={gx + (i % perRow) * cell}
              cy={gy + Math.floor(i / perRow) * cell}
              r={mini ? 6.5 : 6}
              initial={false}
              animate={{ scale: lit ? 1 : 0.85 }}
              transition={{ delay: lit && !reduce ? 0.04 * i : 0, duration: 0.3 }}
              fill={lit ? RED : "var(--color-panel)"}
              stroke={lit ? RED : "var(--color-muted)"}
              strokeWidth={mini ? 2.4 : 1.4}
              style={{ transition: `fill 300ms ease-out ${lit && !reduce ? 0.04 * i : 0}s, stroke 300ms ease-out` }}
            >
              <title>{`${c.name}: uses ${c.uses.join(", ")}`}</title>
            </motion.circle>
          );
        })}
        {!mini && (
          <>
            <text x={map.cust.x} y={gy + rows * cell + 22} textAnchor="middle" fontSize={18} fontWeight={600} fontFamily="var(--font-display)" fill="var(--color-ink)">
              {custLit && state.customers.length ? `${nAffected} of ${map.customers.length} customers` : `${map.customers.length} customers`}
            </text>
            <text x={map.cust.x} y={gy + rows * cell + 41} textAnchor="middle" fontSize={13} fontFamily="var(--font-mono)" fill="var(--color-faint)">
              {custLit && state.customers.length ? "use an affected system" : "use these systems"}
            </text>
          </>
        )}
      </g>
    </svg>
  );
}
