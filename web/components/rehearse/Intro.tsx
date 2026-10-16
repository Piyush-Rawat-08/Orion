"use client";

// The rehearsal's front door. It shows the idea before anyone reads a word: Corvane's real map, recorded on a
// live run, forks into parallel copies on a loop. Universe 1 retires the legacy sign-on and the failure ripples
// out to the customers; universe 2 prepares first and nothing breaks; the company itself never changes. Behind it,
// a starfield drifts and Orion draws itself; pressing Rehearse jumps to warp and into scene one.
//
// Every number in the preview comes from the recorded run, and it says so underneath.

import Link from "next/link";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { EASE } from "../motion";
import { Spinner } from "../ui";
import {
  type CompanyMap,
  type MapState,
  type Recording,
  buildMap,
  CALM,
  GOAL,
  human,
  plural,
  stateOfDiff,
  stateOfFuture,
  tally,
} from "@/lib/rehearsal";
import StageMap from "./StageMap";

// ------------------------------------------------------------------ starfield

type Star = {
  x: number;
  y: number;
  z: number;
  ember: boolean;
  tw: number;
  px: number;
  py: number;
};

/** Stars drifting slowly toward the viewer, leaning away from the pointer. `warp` streaks them past. */
function Starfield({ warp }: { warp: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const warpRef = useRef(warp);
  const reduce = useReducedMotion();
  useEffect(() => {
    warpRef.current = warp;
  }, [warp]);

  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--color-ink").trim() || "#ede9e1";
    const ember = css.getPropertyValue("--color-ember").trim() || "#ff6b35";
    let w = 0;
    let h = 0;
    let stars: Star[] = [];
    const make = (z = 0.05 + Math.random() * 0.95): Star => ({
      x: Math.random() * 2 - 1,
      y: Math.random() * 2 - 1,
      z,
      ember: Math.random() < 0.05,
      tw: Math.random() * Math.PI * 2,
      px: NaN,
      py: NaN,
    });
    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = c.clientWidth;
      h = c.clientHeight;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = Array.from({ length: Math.round(Math.min(340, (w * h) / 4000)) }, () => make());
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(c);

    let px = 0;
    let py = 0;
    let ox = 0;
    let oy = 0;
    const onMove = (e: PointerEvent) => {
      px = e.clientX / window.innerWidth - 0.5;
      py = e.clientY / window.innerHeight - 0.5;
    };
    window.addEventListener("pointermove", onMove);

    let speed = 0.00005;
    let last = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      const warping = warpRef.current;
      speed += ((warping ? 0.0032 : 0.00005) - speed) * (warping ? 0.05 : 0.08);
      ox += (px * -46 - ox) * 0.04;
      oy += (py * -34 - oy) * 0.04;
      const cx = w * 0.5 + ox;
      const cy = h * 0.5 + oy;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        s.z -= speed * dt;
        let sx = cx + (s.x / s.z) * w * 0.5;
        let sy = cy + (s.y / s.z) * h * 0.5;
        if (s.z <= 0.01 || sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) {
          Object.assign(s, make(1));
          sx = cx + s.x * w * 0.5;
          sy = cy + s.y * h * 0.5;
        }
        const near = 1 - s.z;
        const twinkle = reduce ? 1 : 0.72 + 0.28 * Math.sin(now * 0.0021 + s.tw);
        const a = Math.min(1, near * 1.25) * twinkle * (s.ember ? 1 : 0.85);
        const r = 0.35 + near * near * 1.9;
        ctx.globalAlpha = a;
        if (speed > 0.0004 && !Number.isNaN(s.px)) {
          ctx.strokeStyle = s.ember ? ember : ink;
          ctx.lineWidth = r * 1.4;
          ctx.beginPath();
          ctx.moveTo(s.px, s.py);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        } else {
          ctx.fillStyle = s.ember ? ember : ink;
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fill();
        }
        s.px = sx;
        s.py = sy;
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
    };
  }, [reduce]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />;
}

// ------------------------------------------------------------------ Orion, drawing itself

const ORION: Record<string, [number, number]> = {
  meissa: [50, 8],
  betelgeuse: [27, 30],
  bellatrix: [71, 35],
  mintaka: [60, 64],
  alnilam: [52, 68],
  alnitak: [44, 72.5],
  saiph: [31, 113],
  rigel: [77, 108],
};
const BELT = new Set(["mintaka", "alnilam", "alnitak"]);
const LINES: [string, string][] = [
  ["meissa", "betelgeuse"],
  ["meissa", "bellatrix"],
  ["betelgeuse", "alnitak"],
  ["bellatrix", "mintaka"],
  ["mintaka", "alnilam"],
  ["alnilam", "alnitak"],
  ["alnitak", "saiph"],
  ["mintaka", "rigel"],
];

function Constellation() {
  const reduce = useReducedMotion();
  return (
    <svg viewBox="0 0 100 122" className="h-full w-auto overflow-visible" aria-hidden>
      {LINES.map(([a, b], i) => (
        <motion.line
          key={`${a}-${b}`}
          x1={ORION[a][0]}
          y1={ORION[a][1]}
          x2={ORION[b][0]}
          y2={ORION[b][1]}
          stroke="var(--color-ink)"
          strokeOpacity={0.13}
          strokeWidth={0.22}
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, delay: 0.5 + i * 0.16, ease: EASE }}
        />
      ))}
      {Object.entries(ORION).map(([k, [x, y]], i) => (
        <g key={k} transform={`translate(${x} ${y})`}>
          <motion.circle
            r={BELT.has(k) ? 3.2 : 2.6}
            fill={BELT.has(k) ? "var(--color-ember)" : "var(--color-ink)"}
            initial={reduce ? false : { scale: 0, opacity: 0 }}
            animate={{
              scale: 1,
              opacity: BELT.has(k) ? [0.1, 0.2, 0.1] : [0.05, 0.1, 0.05],
            }}
            transition={{
              scale: { delay: 0.3 + i * 0.12, duration: 0.7, ease: EASE },
              opacity: {
                delay: 0.3 + i * 0.12,
                duration: 4 + i * 0.4,
                repeat: Infinity,
                ease: "easeInOut",
              },
            }}
          />
          <motion.circle
            r={BELT.has(k) ? 0.85 : 0.7}
            fill={BELT.has(k) ? "var(--color-ember)" : "var(--color-ink)"}
            initial={reduce ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            opacity={BELT.has(k) ? 0.75 : 0.42}
            transition={{ delay: 0.3 + i * 0.12, duration: 0.5, ease: EASE }}
          />
        </g>
      ))}
    </svg>
  );
}

// ------------------------------------------------------------------ the multiverse preview

/** Where a plane sits in the stack, front to back. */
const SLOT = [
  { x: "0%", y: "0%", z: 0, opacity: 1 },
  { x: "-9%", y: "-10%", z: -190, opacity: 0.66 },
  { x: "-18%", y: "-20%", z: -380, opacity: 0.38 },
];

/** The loop: today alone; universe 1 forks and breaks; universe 2 forks and prepares first; back to today. */
function useLoop(lastCol: number, on: boolean, reduce: boolean | null) {
  const [s, set] = useState({ forks: 0, reveal: -1, cycle: 0 });
  useEffect(() => {
    if (!on) return;
    if (reduce) {
      set({ forks: 2, reveal: Infinity, cycle: 0 });
      return;
    }
    const timers: number[] = [];
    const at = (ms: number, f: () => void) => timers.push(window.setTimeout(f, ms));
    const run = (cycle: number) => {
      timers.length = 0;
      set({ forks: 0, reveal: -1, cycle });
      at(1500, () => set((x) => ({ ...x, forks: 1 })));
      for (let c = 0; c <= lastCol + 1; c++) at(2700 + c * 560, () => set((x) => ({ ...x, reveal: c })));
      const second = 2700 + (lastCol + 2) * 560 + 1500;
      at(second, () => set((x) => ({ ...x, forks: 2 })));
      at(second + 5600, () => run(cycle + 1));
    };
    run(0);
    return () => timers.forEach(clearTimeout);
  }, [on, lastCol, reduce]);
  return s;
}

function Plane({
  map,
  state,
  reveal = Infinity,
  slot,
  title,
  tag,
  tone,
  scan,
  shock,
}: {
  map: CompanyMap;
  state: MapState;
  reveal?: number;
  slot: (typeof SLOT)[number];
  title: string;
  tag: string | null;
  tone: "bad" | "ok" | "quiet";
  /** a copy just made: a light sweeps across it */
  scan: string | null;
  /** the retired system just went dark: the shock spreads from it */
  shock: string | null;
}) {
  const reduce = useReducedMotion();
  const root = map.nodes.find((n) => n.role === "root");
  const front = slot.z === 0;
  const color = tone === "bad" ? "var(--color-bad)" : tone === "ok" ? "var(--color-ok)" : "var(--color-faint)";
  return (
    <motion.div
      className="absolute inset-0"
      initial={false}
      animate={slot}
      transition={{ duration: reduce ? 0 : 1.15, ease: [0.65, 0, 0.35, 1] }}
      style={{ transformStyle: "preserve-3d" }}
    >
      <div
        className="relative h-full overflow-hidden rounded-2xl border bg-panel/[0.93]"
        style={{
          borderColor: tone === "quiet" ? "var(--color-rule-strong)" : `color-mix(in oklab, ${color} 45%, var(--color-rule))`,
          boxShadow: front
            ? "0 50px 120px -50px rgb(0 0 0 / 0.95), 0 0 0 1px rgb(255 255 255 / 0.03) inset, 0 0 90px -40px rgb(255 107 53 / 0.45)"
            : "0 30px 80px -40px rgb(0 0 0 / 0.9)",
          transition: "border-color 500ms ease-out",
        }}
      >
        <div className="flex h-10 items-center justify-between gap-3 border-b border-rule px-4">
          <span className="flex min-w-0 items-center gap-2 truncate text-[12.5px] text-ink">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{
                background: tone === "quiet" ? "var(--color-ember)" : color,
              }}
              aria-hidden
            />
            {title}
          </span>
          <motion.span
            key={tag ?? "none"}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mono shrink-0 text-[11.5px] tnum"
            style={{ color }}
          >
            {tag}
          </motion.span>
        </div>
        <div className="relative px-2 pt-1">
          <StageMap map={map} state={state} reveal={reveal} label={title} />
          {shock && root && !reduce && (
            <span
              key={shock}
              className="pointer-events-none absolute"
              style={{
                left: `${(root.x / map.W) * 100}%`,
                top: `${(root.y / map.H) * 100}%`,
              }}
              aria-hidden
            >
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="absolute -left-6 -top-6 size-12 rounded-full border-2"
                  style={{ borderColor: "var(--color-bad)" }}
                  initial={{ scale: 0.3, opacity: 0.9 }}
                  animate={{ scale: 16, opacity: 0 }}
                  transition={{
                    duration: 1.8,
                    delay: i * 0.22,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                />
              ))}
            </span>
          )}
        </div>
        {scan && !reduce && (
          <motion.span
            key={scan}
            className="pointer-events-none absolute inset-y-0 left-0 w-[38%]"
            style={{
              background: "linear-gradient(90deg, transparent, rgb(255 107 53 / 0.16) 70%, rgb(255 107 53 / 0.7) 99%, transparent)",
            }}
            initial={{ x: "-110%" }}
            animate={{ x: "290%" }}
            transition={{ duration: 1.05, ease: [0.65, 0, 0.35, 1] }}
            aria-hidden
          />
        )}
      </div>
    </motion.div>
  );
}

function Multiverse({ rec }: { rec: Recording }) {
  const reduce = useReducedMotion();
  const map = useMemo(() => buildMap(rec.graph), [rec]);
  const loop = useMemo(() => {
    if (!map) return null;
    const broke = stateOfDiff(rec.diff);
    const evs = rec.plan.events;
    const bestId = evs.find((e) => e.event === "best")?.data.id;
    const best = evs.find((e) => e.event === "universe" && e.data.id === bestId)?.data as
      | {
          effects?: Record<string, string>;
          broken: string[];
          moves?: {
            service: string;
            to?: string;
            from?: string | null;
            off?: boolean;
          }[];
        }
      | undefined;
    const customersOf = (names: string[]) => map.customers.filter((c) => c.uses.some((u) => names.includes(u))).map((c) => c.uid);
    const safe = best ? stateOfFuture(best, GOAL.service, customersOf) : null;
    const { stop, slow } = tally(broke.effects);
    return {
      broke,
      safe,
      stop,
      slow,
      customers: broke.customers.length,
      copyMs: Math.round(rec.fork.copy_ms),
      explored: evs.filter((e) => e.event === "universe").length,
    };
  }, [map, rec]);
  const lastCol = map ? Math.max(...map.nodes.filter((n) => n.role !== "successor").map((n) => n.col)) : 0;
  const { forks, reveal, cycle } = useLoop(lastCol, !!loop, reduce);

  // the stack leans toward the pointer
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 60, damping: 18 });
  const sy = useSpring(my, { stiffness: 60, damping: 18 });
  const rotateY = useTransform(sx, (v) => -17 + v * 9);
  const rotateX = useTransform(sy, (v) => 9 - v * 7);
  useEffect(() => {
    if (reduce) return;
    const on = (e: PointerEvent) => {
      mx.set(e.clientX / window.innerWidth - 0.5);
      my.set(e.clientY / window.innerHeight - 0.5);
    };
    window.addEventListener("pointermove", on);
    return () => window.removeEventListener("pointermove", on);
  }, [mx, my, reduce]);

  if (!map || !loop) return null;
  const done = reveal > lastCol;
  // front to back: the newest universe in front, today furthest back
  const depthOf = { today: forks, one: forks === 0 ? 0 : forks - 1 };
  const hiddenAt = (d: number) => ({ ...SLOT[Math.min(2, d)], opacity: 0 });

  const log = [
    forks >= 1 && {
      k: `a${cycle}`,
      what: "Corvane copied into universe 1",
      value: `${loop.copyMs} ms`,
      tone: "var(--color-ink)",
    },
    done && {
      k: `b${cycle}`,
      what: `${GOAL.service} retired there`,
      value: `${loop.stop} stop · ${loop.slow} slow down · ${plural(loop.customers, "customer")}`,
      tone: "var(--color-bad)",
    },
    forks >= 2 && {
      k: `c${cycle}`,
      what: "universe 2 prepares first",
      value: "nothing breaks",
      tone: "var(--color-ok)",
    },
  ].filter(Boolean) as {
    k: string;
    what: string;
    value: string;
    tone: string;
  }[];

  return (
    <div className="relative">
      <div className="relative mx-auto aspect-[1000/588] w-full max-w-[720px]" style={{ perspective: 1700 }}>
        <motion.div
          className="absolute inset-0"
          style={{ transformStyle: "preserve-3d", rotateX, rotateY }}
          initial={reduce ? false : { opacity: 0, y: 60, rotateZ: -4, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, rotateZ: 0, scale: 1 }}
          transition={{ duration: 1.4, ease: EASE, delay: 0.2 }}
        >
          <Plane
            map={map}
            state={CALM}
            slot={SLOT[depthOf.today]}
            title="Corvane · today"
            tag={forks ? "untouched" : "the real company"}
            tone="quiet"
            scan={null}
            shock={null}
          />
          <Plane
            map={map}
            state={reveal >= 0 ? loop.broke : CALM}
            reveal={reveal}
            slot={forks >= 1 ? SLOT[depthOf.one] : hiddenAt(0)}
            title="Universe 1 · retire it now"
            tag={
              done
                ? `${loop.stop} stop · ${loop.slow} slow · ${loop.customers} customers`
                : forks >= 1
                  ? `copied in ${loop.copyMs} ms`
                  : null
            }
            tone={done ? "bad" : "quiet"}
            scan={forks >= 1 ? `s1-${cycle}` : null}
            shock={reveal >= 0 ? `k-${cycle}` : null}
          />
          {loop.safe && (
            <Plane
              map={map}
              state={forks >= 2 ? loop.safe : CALM}
              slot={forks >= 2 ? SLOT[0] : hiddenAt(depthOf.today)}
              title="Universe 2 · prepare first"
              tag={forks >= 2 ? "nothing breaks" : null}
              tone={forks >= 2 ? "ok" : "quiet"}
              scan={forks >= 2 ? `s2-${cycle}` : null}
              shock={null}
            />
          )}
        </motion.div>
      </div>

      {/* what just happened, in the run's own numbers */}
      <div className="mx-auto mt-6 w-full max-w-[640px] md:mt-8">
        <ol className="mono min-h-[78px] space-y-1.5 text-[12.5px]" aria-live="polite">
          {log.map((l) => (
            <motion.li
              key={l.k}
              initial={reduce ? false : { opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.45, ease: EASE }}
              className="flex items-baseline gap-3"
            >
              <span className="text-faint">›</span>
              <span className="text-muted">{l.what}</span>
              <span className="h-px min-w-6 flex-1 translate-y-[-3px] border-b border-dotted border-rule-strong" aria-hidden />
              <span className="tnum" style={{ color: l.tone }}>
                {l.value}
              </span>
            </motion.li>
          ))}
        </ol>
        <p className="mt-3 text-[12px] text-faint">Preview from a recorded run. Yours runs live, on your own copy.</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the headline

function Rise({ words, delay, className = "" }: { words: string[]; delay: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="-mb-[0.14em] -mr-[0.1em] inline-block overflow-hidden pb-[0.14em] pr-[0.1em] align-bottom">
            <motion.span
              className={`inline-block ${className}`}
              initial={reduce ? false : { y: "108%", rotate: 4 }}
              animate={{ y: "0%", rotate: 0 }}
              transition={{
                duration: 0.95,
                ease: EASE,
                delay: delay + i * 0.075,
              }}
            >
              {w}
            </motion.span>
          </span>
          {i < words.length - 1 && " "}
        </Fragment>
      ))}
    </>
  );
}

/** "Break", cracked along a line that flashes once. */
function Cracked({ text, delay }: { text: string; delay: number }) {
  const reduce = useReducedMotion();
  const top = "polygon(0 0, 100% 0, 100% 40%, 0 63%)";
  const bottom = "polygon(0 63%, 100% 40%, 100% 100%, 0 100%)";
  return (
    <span className="relative inline-block">
      <span className="invisible">{text}</span>
      <span className="absolute inset-0" style={{ clipPath: top }}>
        {text}
      </span>
      <motion.span
        className="absolute inset-0"
        style={{ clipPath: bottom }}
        initial={reduce ? false : { x: 0, y: 0, rotate: 0 }}
        animate={{
          x: reduce ? 4 : [0, 11, 5],
          y: reduce ? 3 : [0, 7, 3.5],
          rotate: reduce ? 1 : [0, 2.4, 1.1],
        }}
        transition={{ delay, duration: 1.1, times: [0, 0.18, 1], ease: EASE }}
      >
        {text}
      </motion.span>
      {!reduce && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <motion.line
            x1={-2}
            y1={64}
            x2={102}
            y2={39}
            stroke="var(--color-ember)"
            strokeWidth={1.4}
            vectorEffect="non-scaling-stroke"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 0] }}
            transition={{
              delay: delay - 0.12,
              duration: 1.2,
              times: [0, 0.2, 1],
              ease: "easeOut",
            }}
          />
        </svg>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ the button

function Magnetic({ children, off }: { children: React.ReactNode; off: boolean }) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 220, damping: 16 });
  const sy = useSpring(y, { stiffness: 220, damping: 16 });
  return (
    <motion.div
      style={{ x: sx, y: sy }}
      onPointerMove={(e) => {
        if (off || e.pointerType !== "mouse") return;
        const r = e.currentTarget.getBoundingClientRect();
        x.set((e.clientX - (r.left + r.width / 2)) * 0.22);
        y.set((e.clientY - (r.top + r.height / 2)) * 0.32);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
      className="relative"
    >
      {children}
    </motion.div>
  );
}

// ------------------------------------------------------------------ the intro

export default function Intro({
  preview,
  ready,
  awake,
  replay,
  waited,
  spent,
  onFresh,
  onStart,
  onReplay,
  seen,
}: {
  /** the recorded run the preview plays */
  preview: Recording | null;
  /** the rehearsal can start (the live map is in, or a replay is loaded) */
  ready: boolean;
  awake: boolean;
  replay: boolean;
  waited: number;
  /** this browser's copy already took the #billing message: the story has happened in it */
  spent: boolean;
  onFresh: () => void;
  onStart: () => void;
  onReplay: () => void;
  seen: () => void;
}) {
  const reduce = useReducedMotion();
  const [warp, setWarp] = useState(false);
  const start = () => {
    if (!ready || warp) return;
    if (reduce) return onStart();
    setWarp(true);
    window.setTimeout(onStart, 760);
  };

  return (
    <motion.section
      key="intro"
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35 }}
      className="relative flex flex-1 items-center overflow-hidden"
      aria-label="Orion"
    >
      <Starfield warp={warp} />
      {/* Orion, behind the words */}
      <motion.div
        className="pointer-events-none absolute -left-[4%] top-[4%] hidden h-[92%] lg:block"
        animate={warp ? { opacity: 0, scale: 1.3 } : { opacity: 1, scale: 1 }}
        transition={{ duration: 0.7, ease: EASE }}
        aria-hidden
      >
        <Constellation />
      </motion.div>
      {/* an ember haze under the stack */}
      <div
        className="pointer-events-none absolute right-[-10%] top-1/2 hidden aspect-square w-[62%] -translate-y-1/2 rounded-full opacity-60 lg:block"
        style={{
          background: "radial-gradient(closest-side, rgb(255 107 53 / 0.13), transparent)",
        }}
        aria-hidden
      />

      <motion.div
        animate={warp ? { opacity: 0, scale: 1.08, filter: "blur(14px)" } : { opacity: 1, scale: 1, filter: "blur(0px)" }}
        transition={{ duration: 0.65, ease: [0.65, 0, 0.35, 1] }}
        className="relative mx-auto grid w-full max-w-[1480px] items-center gap-12 px-5 py-12 md:px-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:gap-6 lg:py-16"
      >
        <div className="min-w-0">
          <h1
            className="heading text-[clamp(2.75rem,5.3vw,5.6rem)] leading-[0.98] tracking-[-0.045em]"
            aria-label="Break your company. In a parallel universe."
          >
            <span className="block" aria-hidden>
              <span className="-mb-[0.14em] -mr-[0.22em] inline-block overflow-hidden pb-[0.14em] pr-[0.22em] align-bottom">
                <motion.span
                  className="inline-block"
                  initial={reduce ? false : { y: "108%", rotate: 4 }}
                  animate={{ y: "0%", rotate: 0 }}
                  transition={{ duration: 0.95, ease: EASE, delay: 0.15 }}
                >
                  <Cracked text="Break" delay={1.25} />
                </motion.span>
              </span>{" "}
              <Rise words={["your", "company."]} delay={0.225} />
            </span>
            <span className="relative block" aria-hidden>
              {/* the parallel copy of the line, splitting off */}
              <motion.span
                className="pointer-events-none absolute inset-0 text-transparent"
                style={{ WebkitTextStroke: "1px rgb(255 107 53 / 0.75)" }}
                initial={reduce ? { opacity: 0.5, x: 10, y: -8 } : { opacity: 0, x: 0, y: 0 }}
                animate={{ opacity: 0.55, x: 14, y: -11 }}
                transition={{ delay: 1.9, duration: 1.3, ease: EASE }}
              >
                In a parallel universe.
              </motion.span>
              <span className="relative text-muted">
                <Rise words={["In", "a", "parallel", "universe."]} delay={0.45} />
              </span>
            </span>
          </h1>

          <motion.p
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: EASE, delay: 0.85 }}
            className="mt-7 max-w-[44ch] text-[clamp(1.05rem,1.45vw,1.25rem)] leading-[1.5] text-muted"
          >
            Orion copies the whole company graph in milliseconds, retires a system in the copy, and shows what breaks and who notices,
            before anything changes in production.
          </motion.p>

          {/* the proposal the rehearsal is about */}
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.95 }}
            className="mt-8 max-w-[540px] rounded-xl border border-rule bg-panel/80 px-4 py-3 backdrop-blur-sm"
          >
            <p className="text-[12.5px] text-faint">The proposal</p>
            <p className="mt-0.5 text-[18px] font-medium leading-snug text-ink">
              Retire {human(GOAL.service)} <span className="mono text-[13px] font-normal text-faint">{GOAL.service}</span>
            </p>
            <p className="mt-0.5 text-[14px] leading-snug text-muted">
              Platform wants the old sign-on gone. ADR-005 named Identity its successor.
            </p>
            {spent && (
              <p className="mt-2 text-[13px] text-warn">
                Your copy has already taken the #billing message, so the story has happened in it.{" "}
                <button type="button" onClick={onFresh} className="underline underline-offset-4">
                  Start over on a fresh copy
                </button>
              </p>
            )}
          </motion.div>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 1.05 }}
            className="mt-5 flex flex-wrap items-center gap-3"
          >
            <Magnetic off={!ready}>
              {ready && !reduce && (
                <motion.span
                  className="pointer-events-none absolute -inset-3 rounded-full bg-ember/40 blur-2xl"
                  animate={{
                    opacity: [0.25, 0.6, 0.25],
                    scale: [0.96, 1.04, 0.96],
                  }}
                  transition={{
                    duration: 3.2,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                  aria-hidden
                />
              )}
              <button
                type="button"
                onClick={start}
                disabled={!ready}
                className="btn btn-primary relative h-[52px] gap-3 rounded-full pl-2 pr-6 text-[16.5px]"
              >
                <span className="grid size-9 place-items-center rounded-full bg-ember text-night" aria-hidden>
                  {ready ? (
                    <svg width="12" height="12" viewBox="0 0 12 12">
                      <path d="M3.5 2.2v7.6L10 6 3.5 2.2Z" fill="currentColor" />
                    </svg>
                  ) : (
                    <Spinner size={12} />
                  )}
                </span>
                Rehearse this shutdown
              </button>
            </Magnetic>
            <Link href="/" onClick={seen} className="btn h-[52px] rounded-full px-5 text-[16px]">
              Explore the workspace
            </Link>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.25, duration: 0.6 }}
            className="mt-8 max-w-[60ch] space-y-1.5 text-[14px] text-muted"
          >
            <p>
              <span className="text-ink">Corvane is made up.</span> Its people, systems and customers are synthetic, so you can break it
              freely. You get a copy of your own.
            </p>
            {!awake && !replay ? (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex items-center gap-2">
                  <span className="relative flex size-[7px]" aria-hidden>
                    <span className="absolute inset-0 animate-ping rounded-full bg-warn opacity-70" />
                    <span className="absolute inset-0 rounded-full bg-warn" />
                  </span>
                  Waking the free API server, about a minute <span className="tnum text-faint">{waited}s</span>
                </span>
                {waited > 6 && (
                  <button
                    type="button"
                    onClick={onReplay}
                    className="text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
                  >
                    Watch a recorded run meanwhile
                  </button>
                )}
              </p>
            ) : (
              <p>About two minutes. Each step runs live on FalkorDB, on a real copy of the company graph.</p>
            )}
          </motion.div>
        </div>

        <div className="min-w-0">{preview && <Multiverse rec={preview} />}</div>
      </motion.div>
    </motion.section>
  );
}
