"use client";

// The safe path: Orion searches parallel copies of the company for the preparation that leaves a change with no
// modeled problems. Each company it explores arrives over the stream and takes its place in a tree (one column per step of
// preparation, coloured by its risk); when the search ends, the winning branch lights up and the plan reads out
// beside it, with the risk falling step by step. One click sends the plan to the teams as a proposal.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { post } from "@/lib/api";
import { fmtMs } from "@/lib/format";
import { postStream } from "@/lib/sse";
import { C, riskColor } from "@/lib/theme";
import { EASE } from "../motion";
import { Spinner } from "../ui";

export interface PlanNode {
  id: string;
  parent: string | null;
  depth: number;
  label: string;
  why: string;
  risk: number;
  level: string;
  broken: string[];
  customers: number;
  effort: number;
  ms: number;
  steps: string[];
}

export interface Prerequisite {
  key: string;
  title: string;
  status: string;
  blocks?: string;
}

export interface PlanResult {
  goal: string;
  asof: string;
  /** clear: nothing modeled is left; prerequisites: once the open tickets land; residual: nothing found reaches 0 */
  verdict: "clear" | "prerequisites" | "residual";
  rejected: { label: string; why: string }[];
  prerequisites: Prerequisite[];
  assumptions: string[];
  baseline: PlanNode;
  best: PlanNode;
  path: string[];
  steps: { label: string; why: string; evidence?: string | null; prerequisites?: Prerequisite[]; ops: Record<string, string>[] }[];
  curve: { after: string; risk: number }[];
  plan_ops: Record<string, string>[];
  explored: number;
  ms: number;
  universes: PlanNode[];
}

const COL = 230;
const ROW = 58;

/** Lay the explored companies out as a tree: depth across, siblings down, each parent centred on its children. */
function layout(nodes: PlanNode[]) {
  const kids = new Map<string | null, PlanNode[]>();
  for (const n of nodes) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const pos = new Map<string, { x: number; y: number }>();
  let row = 0;
  const place = (n: PlanNode): number => {
    const ch = kids.get(n.id) ?? [];
    const y = ch.length ? ch.map(place).reduce((a, b) => a + b, 0) / ch.length : row++ * ROW;
    pos.set(n.id, { x: n.depth * COL, y });
    return y;
  };
  for (const r of kids.get(null) ?? []) place(r);
  const depth = Math.max(0, ...nodes.map((n) => n.depth));
  return { pos, w: depth * COL + 200, h: Math.max(ROW, row * ROW) };
}

export default function SafePath({
  ops,
  title,
  onClose,
  asof,
}: {
  ops: Record<string, string>[];
  title: string;
  onClose: () => void;
  asof?: string;
}) {
  const reduce = useReducedMotion();
  const router = useRouter();
  const [nodes, setNodes] = useState<PlanNode[]>([]);
  const [status, setStatus] = useState("Starting the search");
  const [result, setResult] = useState<PlanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [t0] = useState(() => performance.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    postStream(
      "/plan",
      { ops, asof },
      (e) => {
        const d = e.data as Record<string, unknown>;
        if (e.event === "status") setStatus(String(d.text ?? ""));
        else if (e.event === "universe") setNodes((ns) => [...ns, d as unknown as PlanNode]);
        else if (e.event === "done" && d.result) setResult(d.result as PlanResult);
        else if (e.event === "error") setError(String(d.text ?? "The search failed"));
      },
      ac.signal,
    ).catch((err) => {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    });
    return () => ac.abort();
  }, [ops, asof]);

  useEffect(() => {
    if (result || error) return;
    const id = setInterval(() => setElapsed(performance.now() - t0), 50);
    return () => clearInterval(id);
  }, [result, error, t0]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { pos, w, h } = useMemo(() => layout(nodes), [nodes]);
  const treeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!result || !treeRef.current) return;
    const p = pos.get(result.best.id);
    if (p) treeRef.current.scrollTo({ top: Math.max(0, p.y - treeRef.current.clientHeight / 2 + 60), behavior: reduce ? "auto" : "smooth" });
  }, [result, pos, reduce]);
  const onPath = useMemo(() => new Set(result?.path ?? []), [result]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const pathD = useMemo(() => {
    if (!result) return "";
    return result.path
      .map((id) => pos.get(id))
      .filter(Boolean)
      .map((p, i) => `${i ? "L" : "M"} ${p!.x + 100} ${p!.y + 40}`)
      .join(" ");
  }, [result, pos]);

  const send = async () => {
    if (!result) return;
    setSending(true);
    try {
      const r = await post<{ uid: string }>("/fork", { ops: result.plan_ops, kind: "dryrun", title: `Safe path: ${result.goal}` });
      router.push(`/review?u=${r.uid}`);
    } catch (e) {
      setError((e as Error).message);
      setSending(false);
    }
  };

  const before = result?.baseline.risk ?? nodes[0]?.risk;
  const after = result?.best.risk;

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={`The safe path for: ${title}`}
      className="fixed inset-0 z-[120] flex flex-col bg-night/95 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* header */}
      <div className="flex shrink-0 items-center gap-4 border-b border-rule px-6 py-4">
        <div className="min-w-0">
          <p className="text-[12px] text-muted">The safe path{asof ? `, as of ${asof}` : ""}</p>
          <h2 className="heading truncate text-[22px] leading-tight">{title}</h2>
        </div>
        <div className="ml-auto flex items-center gap-6">
          <Stat label="companies explored" value={String(result?.explored ?? nodes.length)} live={!result} />
          <Stat label="search time" value={fmtMs(result?.ms ?? elapsed)} live={!result} />
          {before !== undefined && (
            <div className="text-right">
              <p className="mono text-[20px] leading-none tnum">
                <span style={{ color: riskColor(before >= 40 ? "high" : before > 0 ? "medium" : "low") }}>{before}</span>
                <span className="mx-1.5 text-faint">→</span>
                <span style={{ color: after === undefined ? C.faint : riskColor(after >= 40 ? "high" : after > 0 ? "medium" : "low") }}>
                  {after ?? "…"}
                </span>
              </p>
              <p className="mt-1 text-[11px] text-faint">risk, before → after</p>
            </div>
          )}
          <button type="button" className="btn btn-ghost h-8 w-8 justify-center px-0" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* the search tree */}
        <section ref={treeRef} className="relative min-h-0 overflow-auto px-6 py-6" aria-label="Every company the search explored">
          <p className="mb-4 flex items-center gap-2 text-[12px] text-muted" aria-live="polite">
            {!result && !error && <Spinner size={11} />}
            {error ? <span className="text-bad">{error}</span> : result ? `Done. ${result.explored} parallel companies, each a full copy of the company with the plan applied.` : status}
          </p>
          <svg width={Math.max(w, 400)} height={h + 30} className="overflow-visible" role="img" aria-label="Search tree">
            <defs>
              <filter id="sp-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="4" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {/* columns */}
            {Array.from({ length: Math.max(1, ...nodes.map((n) => n.depth + 1)) }, (_, d) => (
              <text key={`c${d}`} x={d * COL + 100} y={-6} textAnchor="middle" className="fill-[var(--color-faint)] text-[10px]">
                {d === 0 ? "the change alone" : `step ${d} of preparation`}
              </text>
            ))}
            {/* edges */}
            {nodes.map((n) => {
              if (!n.parent) return null;
              const a = pos.get(n.parent),
                b = pos.get(n.id);
              if (!a || !b) return null;
              const lit = onPath.has(n.id) && onPath.has(n.parent);
              const mid = (a.x + b.x) / 2 + 100;
              const dPath = `M ${a.x + 100} ${a.y + 40} C ${mid} ${a.y + 40}, ${mid} ${b.y + 40}, ${b.x + 100} ${b.y + 40}`;
              // the glow is a wider, fainter stroke underneath (an SVG filter drops perfectly straight lines)
              return (
                <g key={`e${n.id}`}>
                  {lit && <path d={dPath} fill="none" stroke={C.ember} strokeOpacity={0.25} strokeWidth={8} strokeLinecap="round" />}
                  <motion.path
                    d={dPath}
                    fill="none"
                    stroke={lit ? C.ember : C.rule}
                    strokeWidth={lit ? 2.2 : 1.2}
                    initial={reduce ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1, opacity: result && !lit ? 0.45 : 1 }}
                    transition={{ duration: 0.45, ease: EASE }}
                  />
                </g>
              );
            })}
            {/* a spark running along the winning branch */}
            {result && pathD && !reduce && (
              <motion.circle
                r={3.5}
                fill="#fff"
                filter="url(#sp-glow)"
                initial={{ offsetDistance: "0%" }}
                animate={{ offsetDistance: "100%" }}
                transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut", repeatDelay: 0.6 }}
                style={{ offsetPath: `path("${pathD}")` }}
              />
            )}
            {/* companies */}
            {nodes.map((n) => {
              const p = pos.get(n.id);
              if (!p) return null;
              const c = riskColor(n.level);
              const lit = onPath.has(n.id);
              const dim = result && !lit;
              return (
                <motion.g
                  key={n.id}
                  initial={reduce ? false : { opacity: 0, scale: 0.6 }}
                  animate={{ opacity: dim ? 0.42 : 1, scale: 1 }}
                  transition={{ duration: 0.35, ease: EASE }}
                  style={{ transformOrigin: `${p.x + 100}px ${p.y + 40}px` }}
                >
                  <title>{`${n.label}: risk ${n.risk}${n.broken.length ? `, still breaks ${n.broken.join(", ")}` : ", nothing breaks"}`}</title>
                  <circle cx={p.x + 100} cy={p.y + 40} r={lit ? 21 : 17} fill={`color-mix(in oklab, ${c} 16%, var(--color-panel))`} stroke={lit ? C.ember : c} strokeWidth={lit ? 2.4 : 1.5} filter={lit ? "url(#sp-glow)" : undefined} />
                  <text x={p.x + 100} y={p.y + 44} textAnchor="middle" className="mono text-[11px] font-semibold" fill={c}>
                    {n.risk}
                  </text>
                  <text x={p.x + 100} y={p.y + 68} textAnchor="middle" className={`text-[10.5px] ${lit ? "fill-[var(--color-ink)]" : "fill-[var(--color-muted)]"}`}>
                    {n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label}
                  </text>
                </motion.g>
              );
            })}
          </svg>
        </section>

        {/* the plan */}
        <aside className="min-h-0 overflow-y-auto border-t border-rule bg-panel px-6 py-6 lg:border-l lg:border-t-0" aria-label="The plan">
          <AnimatePresence mode="wait">
            {!result ? (
              <motion.div key="wait" exit={{ opacity: 0 }} className="space-y-3">
                <h3 className="heading text-[20px] leading-tight">Looking for the safest order</h3>
                <p className="text-[13px] leading-relaxed text-muted">
                  For every system that would stop working, Orion tries the ways out it has evidence for: move it onto a
                  declared successor or where other systems already moved, or switch it off too if no system relies on
                  it. Each try is a full copy of the company, scored the same way as a what-if. The safest few go on.
                </p>
              </motion.div>
            ) : (
              <motion.div key="plan" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }}>
                <h3 className="heading text-[22px] leading-tight">
                  {result.verdict === "residual"
                    ? `No plan avoids every modeled problem: risk ${result.best.risk} at best`
                    : "No modeled problems after these steps"}
                </h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                  {result.steps.length - 1} {result.steps.length - 1 === 1 ? "step" : "steps"} of preparation, then the change itself.
                  {result.verdict === "prerequisites" &&
                    ` ${result.prerequisites.length} open ${result.prerequisites.length === 1 ? "ticket has" : "tickets have"} to land first.`}
                </p>
                <RiskCurve curve={result.curve} />
                <ol className="mt-5 space-y-2">
                  {result.steps.map((s, i) => (
                    <motion.li
                      key={i}
                      initial={reduce ? false : { opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.15 + i * 0.12, duration: 0.3, ease: EASE }}
                      className={`relative rounded-xl border px-4 py-3 ${i === result.steps.length - 1 ? "border-rule-strong bg-raised" : "border-rule bg-well"}`}
                    >
                      <div className="flex items-start gap-3">
                        <span className={`mono grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${i === result.steps.length - 1 ? "bg-ember text-night" : "border border-rule-strong text-ink"}`}>
                          {i + 1}
                        </span>
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium leading-snug text-ink">{s.label}</p>
                          <p className="mt-0.5 text-[12px] leading-snug text-muted">{s.why}</p>
                          {!!s.prerequisites?.length && (
                            <ul className="mt-2 space-y-1 border-l border-warn/50 pl-2.5">
                              {s.prerequisites.map((p) => (
                                <li key={p.key} className="text-[12px] leading-snug text-muted">
                                  <span className="mono text-warn">{p.key}</span> {p.status}
                                  {p.blocks ? `, blocks ${p.blocks}` : ""}: {p.title}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </motion.li>
                  ))}
                </ol>
                {result.rejected.length > 0 && (
                  <div className="mt-5">
                    <p className="text-[12px] font-medium text-ink">Turned down</p>
                    <ul className="mt-1.5 space-y-1.5">
                      {result.rejected.map((x) => (
                        <li key={x.label} className="text-[12px] leading-snug text-muted">
                          <span className="text-ink line-through decoration-faint">{x.label}</span>: {x.why}.
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <details className="mt-4 text-[12px] leading-relaxed text-muted">
                  <summary className="cursor-pointer text-faint hover:text-muted">What this rests on</summary>
                  <ul className="mt-1.5 list-disc space-y-1 pl-4">
                    {result.assumptions.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </details>
                <button type="button" className="btn btn-primary mt-5 h-9 w-full justify-center" onClick={send} disabled={sending}>
                  {sending ? <Spinner size={12} /> : null}
                  Send the plan for approval
                </button>
                <p className="mt-2 text-center text-[11px] text-faint">
                  The teams it touches approve it, like any change. Approving updates Orion&apos;s records; it deploys nothing.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </aside>
      </div>
    </motion.div>
  );
}

function Stat({ label, value, live }: { label: string; value: string; live: boolean }) {
  return (
    <div className="text-right">
      <p className={`mono text-[20px] leading-none tnum ${live ? "text-ink" : "text-ink"}`}>{value}</p>
      <p className="mt-1 text-[11px] text-faint">{label}</p>
    </div>
  );
}

/** The risk after each step of the plan: a falling line. */
function RiskCurve({ curve }: { curve: { after: string; risk: number }[] }) {
  const reduce = useReducedMotion();
  const ref = useRef<SVGSVGElement>(null);
  const W = 360,
    H = 96,
    pad = 18;
  const max = Math.max(1, ...curve.map((c) => c.risk));
  const pts = curve.map((c, i) => [pad + (i * (W - 2 * pad)) / Math.max(1, curve.length - 1), pad + (1 - c.risk / max) * (H - 2 * pad)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${y}`).join(" ");
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H + 16}`} className="mt-4 w-full" role="img" aria-label={`Risk ${curve.map((c) => c.risk).join(" then ")}`}>
      <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} stroke={C.rule} />
      <motion.path d={d} fill="none" stroke={C.ember} strokeWidth="2.2" strokeLinejoin="round" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: EASE, delay: 0.1 }} />
      {pts.map(([x, y], i) => (
        <g key={i}>
          <motion.circle cx={x} cy={y} r={4} fill={riskColor(curve[i].risk >= 40 ? "high" : curve[i].risk > 0 ? "medium" : "low")} initial={reduce ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.2 + i * 0.15 }} />
          <text x={x} y={y - 8} textAnchor="middle" className="mono text-[10px]" fill={C.text}>
            {curve[i].risk}
          </text>
        </g>
      ))}
      <text x={pad} y={H + 12} className="text-[10px]" fill={C.faint}>
        the change alone
      </text>
      <text x={W - pad} y={H + 12} textAnchor="end" className="text-[10px]" fill={C.faint}>
        after the plan
      </text>
    </svg>
  );
}
