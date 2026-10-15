"use client";

// What happened around an incident, drawn to scale: one lane per thread of the story (the decision, what the records
// said, what customers saw, the fix), on a ruler of real days. The fact nobody had written down is a hatched band that
// runs in from before the chart and only ends when someone finally wrote it down; the gaps that matter (how long there
// was to see it coming, how long it took to find the cause) are measured above the lanes. A playhead walks the days
// once, and everything appears as it passes; afterwards the pointer reads off any day.

import { animate, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EASE } from "@/components/motion";

export interface TrackInput {
  incident: { key: string; title: string; at: string; priority: string };
  decision: { key: string; title: string; at: string };
  known: { risk: number };
  true: { risk: number; customers: string[] };
  blind_spot: { source: string; target: string; true_since: string; recorded_at: string; recorded_by: string | null; recorded_in: string | null; unwritten_days: number }[];
  fix_landed: { at: string } | null;
  fix_waiting: { key: string; title: string; opened: string } | null;
}

const DAY = 86_400_000;
const when = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00` : s);
const short = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const long = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const LANES = [
  { id: "decision", label: "Decision" },
  { id: "record", label: "On record" },
  { id: "customers", label: "Customers" },
  { id: "fix", label: "The fix" },
] as const;
const LANE_H = 52;

/** One event on a lane: a dot with a halo, its words beside it. */
function Mark({ left, on, color, ring = false, side = "right", children }: { left: string; on: boolean; color: string; ring?: boolean; side?: "right" | "left"; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className="absolute top-1/2 z-[2] flex -translate-y-1/2 items-center"
      style={{ left }}
      initial={false}
      animate={{ opacity: on ? 1 : 0, scale: on ? 1 : 0.6 }}
      transition={{ duration: 0.35, ease: EASE }}
    >
      <span
        className={`relative -ml-[6px] block size-3 shrink-0 rounded-full ${ring && !reduce ? "pulse-soft" : ""}`}
        style={{ background: color, boxShadow: `0 0 0 3px var(--color-night), 0 0 16px ${color}` }}
      />
      <span className={`absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[12px] leading-tight ${side === "right" ? "left-3.5" : "right-3.5 text-right"}`}>
        {children}
      </span>
    </motion.div>
  );
}

export default function IncidentTrack({ r, today }: { r: TrackInput; today?: string | null }) {
  const reduce = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(reduce ? 1 : 0); // how far the playhead has walked, 0..1
  const [hover, setHover] = useState<number | null>(null);

  const m = useMemo(() => {
    const decided = when(r.decision.at);
    const broke = when(r.incident.at);
    const spot = r.blind_spot[0] ?? null;
    const written = spot ? when(spot.recorded_at) : null;
    const opened = r.fix_waiting ? when(r.fix_waiting.opened) : null;
    const landed = r.fix_landed ? when(r.fix_landed.at) : null;
    // the decision names its date ("Retire sso-legacy on 2026-03-17"): the day the switch was actually thrown
    const planned = /(\d{4}-\d{2}-\d{2})/.exec(r.decision.title)?.[1];
    const thrown = planned ? when(planned) : null;
    const last = Math.max(broke, written ?? 0, opened ?? 0, landed ?? 0);
    const start = decided - 4 * DAY;
    const end = last + 6 * DAY;
    const x = (t: number) => Math.min(1, Math.max(0, (t - start) / (end - start)));
    const days: number[] = [];
    for (let t = Math.ceil(start / DAY) * DAY; t <= end; t += DAY) days.push(t);
    const now = today ? when(today) : null;
    return { decided, broke, spot, written, opened, landed, thrown, start, end, x, days, now };
  }, [r, today]);

  useEffect(() => {
    if (reduce) return setP(1);
    setP(0);
    const c = animate(0, 1, { duration: 2.8, ease: [0.45, 0, 0.2, 1], delay: 0.25, onUpdate: setP });
    return () => c.stop();
  }, [reduce, r]);

  const seen = (t: number) => p >= m.x(t) - 0.002;
  const pct = (t: number) => `${m.x(t) * 100}%`;
  const head = m.start + p * (m.end - m.start);
  const readout = hover ?? (p < 1 ? head : null);
  const gaps = [
    { from: m.decided, to: m.broke, text: `${Math.round((m.broke - m.decided) / DAY)} days to see it coming`, color: "var(--color-ink)" },
    ...(m.written
      ? [{ from: m.broke, to: m.written, text: `${Math.round((m.written - m.broke) / DAY)} days to find the cause`, color: "var(--color-warn)" }]
      : []),
  ];
  const openFor = m.opened && m.now && !m.landed ? Math.round((m.now - m.opened) / DAY) : null;

  const onMove = (e: React.PointerEvent) => {
    if (p < 1 || !box.current) return;
    const b = box.current.getBoundingClientRect();
    const f = (e.clientX - b.left) / b.width;
    setHover(f < 0 || f > 1 ? null : Math.round((m.start + f * (m.end - m.start)) / DAY) * DAY);
  };

  return (
    <figure className="mt-10" aria-label="What happened, to scale">
      <div className="overflow-x-auto pb-1">
        <div className="grid min-w-[720px] grid-cols-[96px_minmax(0,1fr)]">
          {/* gaps that matter, measured */}
          <div />
          <div className="relative h-[46px]">
            {gaps.map((g) => (
              <motion.div
                key={g.text}
                className="absolute top-[14px] h-[18px]"
                style={{ left: pct(g.from), width: `calc(${pct(g.to)} - ${pct(g.from)})` }}
                initial={false}
                animate={{ opacity: seen(g.to) ? 1 : 0 }}
                transition={{ duration: 0.4 }}
              >
                <span className="absolute inset-x-0 bottom-0 h-[7px] rounded-t-[3px] border-x border-t" style={{ borderColor: g.color, opacity: 0.55 }} />
                <span className="mono absolute -top-[6px] left-1/2 -translate-x-1/2 whitespace-nowrap bg-night px-1.5 text-[11px]" style={{ color: g.color }}>
                  {g.text}
                </span>
              </motion.div>
            ))}
          </div>

          {/* lane labels */}
          <div className="border-r border-rule">
            {LANES.map((l) => (
              <p key={l.id} className="flex items-center pr-3 text-[11px] text-faint" style={{ height: LANE_H }}>
                {l.label}
              </p>
            ))}
          </div>

          {/* the lanes */}
          <div
            ref={box}
            className="relative cursor-crosshair"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            style={{ height: LANE_H * LANES.length }}
          >
            {/* lane rules and the day grid */}
            {LANES.map((l, i) => (
              <div key={l.id} className="absolute inset-x-0 border-b border-rule-soft" style={{ top: i * LANE_H, height: LANE_H }} />
            ))}
            {m.days.map((t) => (
              <span
                key={t}
                className="absolute top-0 h-full w-px"
                style={{ left: pct(t), background: new Date(t).getDay() === 1 ? "var(--color-rule)" : "transparent" }}
                aria-hidden
              />
            ))}
            {/* event guides */}
            {[m.decided, m.broke, m.written, m.opened].filter((t): t is number => t !== null).map((t) => (
              <motion.span
                key={t}
                className="absolute top-0 h-full w-0 border-l border-dashed border-rule-strong"
                style={{ left: pct(t) }}
                initial={false}
                animate={{ opacity: seen(t) ? 0.9 : 0 }}
                aria-hidden
              />
            ))}

            {/* lane 1: the decision, and the day the switch was thrown */}
            <div className="absolute inset-x-0" style={{ top: 0, height: LANE_H }}>
              {m.thrown && (
                <motion.div
                  className="absolute top-1/2 h-px -translate-y-1/2 border-t border-dashed border-ink/50"
                  style={{ left: pct(m.decided), width: `calc(${pct(m.thrown)} - ${pct(m.decided)})`, transformOrigin: "left" }}
                  initial={false}
                  animate={{ scaleX: Math.min(1, Math.max(0, (p - m.x(m.decided)) / Math.max(0.001, m.x(m.thrown) - m.x(m.decided)))) }}
                  transition={{ duration: 0 }}
                />
              )}
              <motion.div
                className="absolute top-1/2 z-[2] -translate-y-1/2"
                style={{ left: pct(m.decided) }}
                initial={false}
                animate={{ opacity: seen(m.decided) ? 1 : 0, rotate: seen(m.decided) ? 45 : 0 }}
                transition={{ duration: 0.4, ease: EASE }}
              >
                <span className="-ml-[6px] block size-3 border-[1.5px] border-ink bg-night" />
              </motion.div>
              <motion.p
                className="absolute top-[7px] whitespace-nowrap pl-3 text-[12px] text-ink"
                style={{ left: pct(m.decided) }}
                initial={false}
                animate={{ opacity: seen(m.decided) ? 1 : 0 }}
              >
                {r.decision.key} approved
              </motion.p>
              <motion.p
                className="mono absolute bottom-[6px] whitespace-nowrap pl-3 text-[11px] text-ember"
                style={{ left: pct(m.decided) }}
                initial={false}
                animate={{ opacity: seen(m.decided) ? 1 : 0 }}
                transition={{ delay: reduce ? 0 : 0.3 }}
              >
                Orion that day: risk {r.true.risk}, not {r.known.risk}
              </motion.p>
              {m.thrown && (
                <motion.div
                  className="absolute top-1/2 z-[2] -translate-y-1/2"
                  style={{ left: pct(m.thrown) }}
                  initial={false}
                  animate={{ opacity: seen(m.thrown) ? 1 : 0 }}
                >
                  <span className="-ml-[5px] block h-[14px] w-[10px] rounded-[2px] border-[1.5px] border-ink bg-night" title="switched off" />
                  <span className="absolute -top-[17px] left-0 -translate-x-1/2 whitespace-nowrap text-[11px] text-muted">
                    switched off
                  </span>
                </motion.div>
              )}
            </div>

            {/* lane 2: the fact nobody had written down, from long before the chart until the day it was */}
            {m.spot && m.written && (
              <div className="absolute inset-x-0" style={{ top: LANE_H, height: LANE_H }}>
                <div className="absolute top-[20px] h-[12px] overflow-hidden rounded-r-[3px]" style={{ left: 0, width: pct(m.written) }}>
                  <motion.div
                    className="absolute inset-0 border-y border-warn/45"
                    style={{
                      background:
                        "repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-warn) 42%, transparent) 0 2px, transparent 2px 7px)",
                      transformOrigin: "left",
                    }}
                    initial={false}
                    animate={{ scaleX: Math.min(1, p / Math.max(0.001, m.x(m.written))) }}
                    transition={{ duration: 0 }}
                  />
                </div>
                {/* it started long before: an axis break */}
                <span className="absolute left-0 top-[26px] z-[1] -translate-x-1/2 -translate-y-1/2 bg-night px-[1px] text-[13px] leading-none text-warn" aria-hidden>
                  ≈
                </span>
                <p className="absolute left-3 top-[1px] z-[1] whitespace-nowrap bg-night pr-1.5 text-[11px] leading-[15px] text-warn">
                  {m.spot.source} → {m.spot.target}, unwritten since {long(when(m.spot.true_since))} · {m.spot.unwritten_days} days
                </p>
                {/* on record from then on */}
                <motion.div
                  className="absolute top-1/2 h-[2px] -translate-y-1/2 bg-warn/60"
                  style={{ left: pct(m.written), right: 0, transformOrigin: "left" }}
                  initial={false}
                  animate={{ scaleX: Math.min(1, Math.max(0, (p - m.x(m.written)) / Math.max(0.001, 1 - m.x(m.written)))) }}
                  transition={{ duration: 0 }}
                />
                <Mark left={pct(m.written)} on={seen(m.written)} color="var(--color-warn)" side="left">
                  <span className="relative top-[13px] block pr-0.5 text-[11px] text-muted">
                    written down{m.spot.recorded_by ? ` by ${m.spot.recorded_by}` : ""}
                    {m.spot.recorded_in ? ` in ${m.spot.recorded_in}` : ""}
                  </span>
                </Mark>
              </div>
            )}

            {/* lane 3: what customers saw */}
            <div className="absolute inset-x-0" style={{ top: LANE_H * 2, height: LANE_H }}>
              <motion.div
                className="absolute top-1/2 h-[14px] -translate-y-1/2 rounded-[3px]"
                style={{
                  left: pct(m.broke),
                  width: `calc(${pct(m.broke + 1.2 * DAY)} - ${pct(m.broke)})`,
                  background: "linear-gradient(90deg, var(--color-bad), color-mix(in srgb, var(--color-bad) 0%, transparent))",
                  transformOrigin: "left",
                }}
                initial={false}
                animate={{ scaleX: seen(m.broke) ? 1 : 0, opacity: seen(m.broke) ? 0.55 : 0 }}
                transition={{ duration: 0.6, ease: EASE }}
              />
              <Mark left={pct(m.broke)} on={seen(m.broke)} color="var(--color-bad)" ring side="left">
                <span className="mono text-bad">{r.incident.key}</span> <span className="text-faint">{r.incident.priority}</span>
                <span className="block text-[11px] text-muted">{r.true.customers.length ? `${r.true.customers.length} customers hit` : "outage"}</span>
              </Mark>
            </div>

            {/* lane 4: the fix, landed or still open */}
            <div className="absolute inset-x-0" style={{ top: LANE_H * 3, height: LANE_H }}>
              {m.opened && (
                <>
                  <motion.div
                    className="absolute top-1/2 h-[6px] -translate-y-1/2 rounded-l-full"
                    style={{
                      left: pct(m.opened),
                      right: 0,
                      background: m.landed
                        ? "var(--color-ok)"
                        : "linear-gradient(90deg, var(--color-ember), color-mix(in srgb, var(--color-ember) 10%, transparent))",
                      transformOrigin: "left",
                    }}
                    initial={false}
                    animate={{ scaleX: Math.min(1, Math.max(0, (p - m.x(m.opened)) / Math.max(0.001, 1 - m.x(m.opened)))) }}
                    transition={{ duration: 0 }}
                  />
                  <Mark left={pct(m.opened)} on={seen(m.opened)} color="var(--color-ember)" side="left">
                    <span className="mono text-ember">{r.fix_waiting?.key}</span> <span className="text-muted">opened</span>
                  </Mark>
                  {openFor !== null && (
                    <motion.p
                      className="mono absolute right-1 top-[5px] whitespace-nowrap text-[11px] text-ember"
                      initial={false}
                      animate={{ opacity: p >= 1 ? 1 : 0 }}
                      transition={{ duration: 0.5 }}
                    >
                      still open · {openFor} days →
                    </motion.p>
                  )}
                </>
              )}
              {m.landed && (
                <Mark left={pct(m.landed)} on={seen(m.landed)} color="var(--color-ok)">
                  <span className="text-ok">fixed</span>
                </Mark>
              )}
              {!m.opened && !m.landed && <p className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] text-faint">no fix on record</p>}
            </div>

            {/* the playhead while it walks, the pointer's day afterwards */}
            {readout !== null && (
              <div className="pointer-events-none absolute -top-[46px] bottom-0 z-[3] w-0" style={{ left: pct(readout) }} aria-hidden>
                <span className="absolute bottom-0 top-[40px] w-px -translate-x-1/2" style={{ background: hover !== null ? "var(--color-faint)" : "var(--color-ember)", boxShadow: hover !== null ? "none" : "0 0 10px var(--color-ember)" }} />
                <span
                  className={`mono absolute top-0 -translate-x-1/2 whitespace-nowrap rounded border px-1.5 py-[1px] text-[11px] ${hover !== null ? "border-rule-strong bg-raised text-ink" : "border-ember/50 bg-night text-ember"}`}
                >
                  {short(readout)}
                </span>
              </div>
            )}
          </div>

          {/* the ruler: a tick a day, Mondays named */}
          <div />
          <div className="relative h-[30px]">
            {m.days.map((t) => {
              const monday = new Date(t).getDay() === 1;
              return (
                <span key={t} className="absolute top-0" style={{ left: pct(t) }}>
                  <span className={`block w-px ${monday ? "h-[7px] bg-faint" : "h-[4px] bg-rule-strong"}`} />
                  {monday && <span className="mono absolute left-0 top-[9px] -translate-x-1/2 whitespace-nowrap text-[10px] text-faint">{short(t)}</span>}
                </span>
              );
            })}
          </div>
        </div>
      </div>
      <figcaption className="sr-only">
        {r.decision.key} approved {long(m.decided)}; {r.incident.key} on {long(m.broke)}
        {m.written ? `; the missing dependency written down ${long(m.written)}` : ""}
        {m.opened ? `; ${r.fix_waiting?.key} opened ${long(m.opened)}${openFor !== null ? `, still open after ${openFor} days` : ""}` : ""}.
      </figcaption>
    </figure>
  );
}
