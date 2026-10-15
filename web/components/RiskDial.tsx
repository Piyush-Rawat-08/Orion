"use client";

import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, useState } from "react";
import { LEVEL_COLOR } from "@/lib/palette";

const START = 135; // degrees: the dial sweeps 270° from bottom-left to bottom-right
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

/** Risk as an instrument: a 270° dial that sweeps to the score, with the danger band marked. */
export function RiskDial({ score, level, size = 190, label = "risk" }: { score: number; level: "clear" | "watch" | "danger"; size?: number; label?: string }) {
  const v = useMotionValue(0);
  const [shown, setShown] = useState(0);
  const angle = (x: number) => START + 180 + (Math.min(100, x) / 100) * SWEEP;
  useEffect(() => {
    const c = animate(v, score, { duration: 1.6, ease: [0.22, 1, 0.36, 1], onUpdate: (x) => setShown(Math.round(x)) });
    return () => c.stop();
  }, [score, v]);
  const c = size / 2;
  const r = size / 2 - 14;
  const col = LEVEL_COLOR[level];
  // the pointer rides the rim instead of crossing the readout
  const nx0 = useTransform(v, (x) => polar(c, c, r - 20, angle(x))[0]);
  const ny0 = useTransform(v, (x) => polar(c, c, r - 20, angle(x))[1]);
  const nx = useTransform(v, (x) => polar(c, c, r + 7, angle(x))[0]);
  const ny = useTransform(v, (x) => polar(c, c, r + 7, angle(x))[1]);
  const fill = useTransform(v, (x) => arc(c, c, r, START + 180, START + 180 + Math.max(0.5, (Math.min(100, x) / 100) * SWEEP)));
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="overflow-visible">
        <defs>
          <filter id="dial-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <path d={arc(c, c, r, START + 180, START + 180 + SWEEP)} stroke="rgba(236,232,220,.08)" strokeWidth="7" fill="none" strokeLinecap="round" />
        {/* danger band from 35 */}
        <path d={arc(c, c, r + 9, START + 180 + 0.35 * SWEEP, START + 180 + SWEEP)} stroke="rgba(255,77,46,.35)" strokeWidth="1.5" fill="none" />
        {Array.from({ length: 21 }).map((_, i) => {
          const d = START + 180 + (i / 20) * SWEEP;
          const [x0, y0] = polar(c, c, r - 9, d);
          const [x1, y1] = polar(c, c, r - (i % 5 === 0 ? 16 : 12), d);
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="rgba(236,232,220,.25)" strokeWidth={i % 5 === 0 ? 1.2 : 0.7} />;
        })}
        <motion.path d={fill} stroke={col} strokeWidth="7" fill="none" strokeLinecap="round" filter="url(#dial-glow)" />
        <motion.line x1={nx0} y1={ny0} x2={nx} y2={ny} stroke="#fff6e8" strokeWidth="2" strokeLinecap="round" />
        <motion.circle cx={nx} cy={ny} r="2.5" fill="#fff6e8" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pt-6">
        <div className="mono text-[44px] leading-none tabular-nums" style={{ color: col, textShadow: `0 0 30px ${col}66` }}>{shown}</div>
        <div className="mono mt-1 text-[10px] uppercase tracking-[0.18em] text-faint">{label} · {level}</div>
      </div>
    </div>
  );
}
