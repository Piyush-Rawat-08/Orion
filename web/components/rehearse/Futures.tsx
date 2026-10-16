"use client";

// Scene three: the futures the safe-path search explored, as cards on its search tree. Each card is one full copy
// of the company with that preparation applied, drawn as a miniature of the same map (same positions), and says
// what changed, what still breaks, and why that is better or worse than the step before. Candidates the search
// turned down hang off the card they branched from, with the reason. When the search ends, the chosen line of
// cards stays lit and the rest step back.

import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PlanNode, PlanResult } from "../multiverse/SafePath";
import type { CompanyMap, PlanMove } from "@/lib/rehearsal";
import { human, humanLabel, plural, stateOfFuture, tally, waitsOn } from "@/lib/rehearsal";
import StageMap from "./StageMap";

export type Future = PlanNode & { effects?: Record<string, string>; moves?: PlanMove[] };

/** What a future leaves broken, in words, against the one it branched from. */
type Prereq = { key: string; blocks?: string };

export function outcome(f: Future, parent: Future | undefined, prereqs: Prereq[]) {
  const effects = f.effects ?? Object.fromEntries(f.broken.map((b) => [b, "break"]));
  const { stop, slow } = tally(effects);
  const offToo = (f.moves ?? []).filter((m) => m.off).map((m) => human(m.service));
  if (!f.broken.length && !f.customers)
    return {
      tone: "ok" as const,
      head: "Nothing in the model is hit",
      why: prereqs.length ? `Every system that relied on it has moved. ${waitsOn(prereqs)}.` : "Every system that relied on it has moved.",
    };
  if (!f.broken.length)
    return {
      tone: "warn" as const,
      head: `Nothing stops, but ${plural(f.customers, "customer")} lose ${offToo.join(", ") || "a system"}`,
      why: "Switching it off too takes away something customers use.",
    };
  // a few systems by name, many by count
  const verb = (b: string) => (effects[b] === "break" ? "stops" : "slows down");
  const named = f.broken.length <= 2 ? f.broken.map((b) => `${human(b)} ${verb(b)}`) : [stop && `${stop} stop`, slow && `${slow} slow down`];
  const head = [...named, f.customers && plural(f.customers, "customer")].filter(Boolean).join(" · ");
  if (!parent) return { tone: "bad" as const, head, why: "Every system that relies on it, directly or not, is hit." };
  const fixed = parent.broken.filter((b) => !f.broken.includes(b));
  const left = f.broken.map((b) => human(b));
  return {
    tone: "bad" as const,
    head,
    why: `${fixed.length ? `Fixes ${plural(fixed.length, "system")} and ${parent.customers - f.customers} customers; ` : ""}${left.join(", ")} still ${f.broken.length === 1 ? verb(f.broken[0]) : "hit"}.`,
  };
}

const TONE = { ok: "var(--color-ok)", warn: "var(--color-warn)", bad: "var(--color-bad)" };

function Card({
  f,
  parent,
  map,
  customersOf,
  chosen,
  done,
  prereqs,
  big,
}: {
  f: Future;
  parent?: Future;
  map: CompanyMap;
  customersOf: (names: string[]) => string[];
  chosen: boolean;
  done: boolean;
  prereqs: Prereq[];
  big: boolean;
}) {
  const reduce = useReducedMotion();
  const o = outcome(f, parent, prereqs);
  const state = stateOfFuture(f, map.nodes.find((n) => n.role === "root")!.id, customersOf);
  const move = (f.moves ?? []).filter((m) => !parent?.moves?.some((p) => p.service === m.service && p.to === m.to && p.off === m.off)).at(-1);
  // what this copy is in the story: the shutdown alone, a step of the chosen preparation, its outcome, or a road not taken
  const role =
    f.depth === 0
      ? "Retire immediately"
      : !done
        ? `Preparation · ${plural(f.depth, "step")}`
        : big
          ? "Proposed outcome · not done yet"
          : chosen
            ? `Preparation step ${f.depth}`
            : "Alternative considered";
  return (
    <motion.article
      layout="position"
      initial={reduce ? false : { opacity: 0, y: 14, scale: 0.96 }}
      animate={{ opacity: done && !chosen ? 0.46 : 1, y: 0, scale: done && chosen && big ? 1.03 : done && !chosen ? 0.97 : 1 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className={`relative w-full overflow-hidden rounded-xl border bg-panel ${done && chosen ? "border-ember/70 shadow-[0_0_0_1px_var(--color-ember),0_30px_80px_-40px_rgb(255_107_53/0.5)]" : "border-rule"}`}
    >
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
        <p className={`text-[12.5px] ${done && chosen ? "text-ember" : "text-faint"}`}>{role}</p>
        <p className="mono text-[11.5px] text-faint tnum" title="Orion's modelled risk score for this copy">
          risk {f.risk}
        </p>
      </div>
      {/* the consequence first, then what was changed to get it */}
      <h3 className="heading flex items-start gap-2 px-4 pt-1 text-[18px] leading-[1.2]">
        <span className="mt-[7px] size-2 shrink-0 rounded-full" style={{ background: TONE[o.tone] }} aria-hidden />
        {o.head}
      </h3>
      <p className="px-4 pt-1 text-[13.5px] leading-snug text-muted">
        {f.depth === 0 ? (
          "Nothing prepared: the shutdown alone."
        ) : (
          <>
            <span className="text-ink">Changed:</span> {move ? (move.off ? `also switched off ${human(move.service)}` : `moved ${human(move.service)} onto ${human(move.to!)}`) : humanLabel(f.label)}
          </>
        )}
      </p>
      <div className="mx-3 mt-2 rounded-lg bg-well px-1 py-1">
        <StageMap map={map} state={state} mini label={`${humanLabel(f.label)}: ${o.head}`} />
      </div>
      <div className="px-4 pb-4 pt-2.5">
        <p className="text-[13px] leading-snug text-muted">{o.why}</p>
        {chosen && done && prereqs.length > 0 && o.tone !== "ok" && <p className="mt-2 text-[12.5px] leading-snug text-warn">{waitsOn(prereqs)}</p>}
      </div>
    </motion.article>
  );
}

export default function Futures({
  nodes,
  result,
  rejected,
  map,
  customersOf,
}: {
  nodes: Future[];
  result: PlanResult | null;
  rejected: { label: string; why: string }[];
  map: CompanyMap;
  customersOf: (names: string[]) => string[];
}) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const onPath = useMemo(() => new Set(result?.path ?? []), [result]);
  const depth = Math.max(0, ...nodes.map((n) => n.depth));
  const cols = Array.from({ length: depth + 1 }, (_, d) =>
    nodes.filter((n) => n.depth === d).sort((a, b) => Number(onPath.has(b.id)) - Number(onPath.has(a.id)) || a.risk - b.risk),
  );
  // the prerequisites of each step, by the step's label, from the finished plan
  const prereqsOf = (f: Future) => {
    if (!result) return [];
    const labels = new Set(f.steps);
    return result.steps.filter((s) => labels.has(s.label)).flatMap((s) => s.prerequisites ?? []);
  };
  // a turned-down candidate hangs off the future whose next move it competed with: "Move X onto …" alternatives
  // branch from the parent of the explored "Move X …" future
  const ghosts = useMemo(() => {
    const out = new Map<string, { names: string[]; why: string }>();
    for (const r of rejected) {
      const m = /^Move (\S+) onto (\S+)$/.exec(r.label);
      if (!m) continue;
      const sib = nodes.find((n) => n.label.startsWith(`Move ${m[1]} `) || n.label.startsWith(`Switch ${m[1]} `));
      const at = sib?.parent ?? nodes[0]?.id;
      if (!at) continue;
      const g = out.get(at) ?? { names: [], why: r.why.replace(/^also run by \w+, but /, "") };
      g.names.push(human(m[2]));
      out.set(at, g);
    }
    return out;
  }, [rejected, nodes]);

  // connectors between cards, measured from the laid-out cards
  const box = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const [lines, setLines] = useState<{ id: string; d: string; lit: boolean }[]>([]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const b = el.getBoundingClientRect();
      const out: { id: string; d: string; lit: boolean }[] = [];
      for (const n of nodes) {
        if (!n.parent) continue;
        const a = cards.current.get(n.parent)?.getBoundingClientRect();
        const c = cards.current.get(n.id)?.getBoundingClientRect();
        if (!a || !c || c.left <= a.right) continue; // stacked (narrow screens): no connector
        const x1 = a.right - b.left,
          y1 = a.top + a.height / 2 - b.top,
          x2 = c.left - b.left,
          y2 = c.top + c.height / 2 - b.top;
        const mx = (x1 + x2) / 2;
        out.push({ id: n.id, d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, lit: onPath.has(n.id) && onPath.has(n.parent) });
      }
      setLines(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const t = setTimeout(measure, 650); // after the cards' entrance settles
    return () => {
      ro.disconnect();
      clearTimeout(t);
    };
  }, [nodes, onPath, result]);


  return (
    <div ref={box} className="relative">
      <svg className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible lg:block" aria-hidden>
        {lines.map((l) => (
          <motion.path
            key={l.id}
            d={l.d}
            fill="none"
            stroke={l.lit && result ? "var(--color-ember)" : "var(--color-rule-strong)"}
            strokeWidth={l.lit && result ? 2.4 : 1.5}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1, opacity: result && !l.lit ? 0.5 : 1 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          />
        ))}
      </svg>
      <div className="grid gap-5 lg:gap-x-14" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
        {cols.map((col, d) => (
          <div key={d} className="flex min-w-0 flex-col justify-center gap-5 max-lg:col-span-full">
            {col.map((n) => (
              <div key={n.id} className="min-w-0">
                <div ref={(el) => void (el ? cards.current.set(n.id, el) : cards.current.delete(n.id))}>
                  <Card
                    f={n}
                    parent={n.parent ? byId.get(n.parent) : undefined}
                    map={map}
                    customersOf={customersOf}
                    chosen={onPath.has(n.id)}
                    done={!!result}
                    prereqs={prereqsOf(n)}
                    big={result?.best.id === n.id}
                  />
                </div>
                {ghosts.get(n.id) && (
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: result ? 0.7 : 1 }}
                    className="mt-2.5 rounded-lg border border-dashed border-rule-strong px-3 py-2 text-[12.5px] leading-snug text-muted"
                  >
                    <span className="text-ink">Also considered, turned down:</span> moving onto {ghosts.get(n.id)!.names.join(", ")}.{" "}
                    {(() => {
                      const g = ghosts.get(n.id)!;
                      const w = g.names.length > 1 ? g.why.replace(/\bit can\b/, "any of them can") : g.why;
                      return w.charAt(0).toUpperCase() + w.slice(1);
                    })()}
                    .
                  </motion.p>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
