"use client";

import { motion, useMotionValue, useSpring } from "motion/react";
import { useRef } from "react";
import { STATUS_COLOR, STATUS_LABEL, teamColor } from "@/lib/palette";

export const EASE = [0.22, 1, 0.36, 1] as const;

/** Words rise out of a mask, one after another. */
export function RiseText({ text, className, delay = 0, step = 0.06, as = "span" }: {
  text: string; className?: string; delay?: number; step?: number; as?: "span" | "h1" | "h2" | "p";
}) {
  const Tag = motion[as];
  const words = text.split(" ");
  return (
    <Tag className={className} aria-label={text}>
      {words.map((w, i) => (
        <span key={i} aria-hidden className="inline-block overflow-hidden pb-[0.12em] align-bottom">
          <motion.span
            className="inline-block"
            initial={{ y: "105%" }}
            animate={{ y: "0%" }}
            transition={{ duration: 0.9, ease: EASE, delay: delay + i * step }}
          >
            {w}
            {i < words.length - 1 ? " " : ""}
          </motion.span>
        </span>
      ))}
    </Tag>
  );
}

/** A button that leans toward the pointer. */
export function Magnetic({ children, className, onClick, disabled, type = "button" }: {
  children: React.ReactNode; className?: string; onClick?: () => void; disabled?: boolean; type?: "button" | "submit";
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 220, damping: 16, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 220, damping: 16, mass: 0.4 });
  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{ x: sx, y: sy }}
      onPointerMove={(e) => {
        const r = ref.current!.getBoundingClientRect();
        x.set((e.clientX - r.left - r.width / 2) * 0.22);
        y.set((e.clientY - r.top - r.height / 2) * 0.3);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
      className={className}
    >
      {children}
    </motion.button>
  );
}

export function TeamDot({ team, size = 6 }: { team: string | null | undefined; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: teamColor(team), boxShadow: `0 0 ${size * 1.6}px ${teamColor(team)}` }}
    />
  );
}

export function StatusMark({ status, compact = false }: { status: string; compact?: boolean }) {
  const c = STATUS_COLOR[status] ?? "#8b90a0";
  return (
    <span className="mono inline-flex items-center gap-1.5 whitespace-nowrap text-[10px] uppercase tracking-[0.1em]" style={{ color: c }}>
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
        {status === "verified" ? (
          <path d="M5 0 L6.2 3.8 L10 5 L6.2 6.2 L5 10 L3.8 6.2 L0 5 L3.8 3.8 Z" fill={c} />
        ) : status === "outdated" || status === "contradicted" ? (
          <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke={c} strokeWidth="1.6" />
        ) : (
          <circle cx="5" cy="5" r="3.2" fill="none" stroke={c} strokeWidth="1.4" />
        )}
      </svg>
      {!compact && (STATUS_LABEL[status] ?? status)}
    </span>
  );
}

export function Initials({ name, team, size = 28 }: { name: string; team?: string | null; size?: number }) {
  const ini = name.split(" ").map((p) => p[0]).slice(0, 2).join("");
  const c = teamColor(team);
  return (
    <span
      className="mono inline-flex shrink-0 items-center justify-center rounded-full text-[10px] text-ink"
      style={{ width: size, height: size, border: `1px solid ${c}`, boxShadow: `inset 0 0 12px ${c}33, 0 0 14px ${c}22` }}
    >
      {ini}
    </span>
  );
}

export function Section({ title, aside, children, className = "" }: {
  title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="display text-[17px] italic text-ink/90">{title}</h3>
        {aside && <div className="mono text-[10px] text-faint">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="mono inline-flex items-center gap-2 text-[11px] text-muted">
      <span className="relative inline-block h-3 w-3">
        <span className="absolute inset-0 animate-ping rounded-full bg-amber/40" />
        <span className="absolute inset-[3px] rounded-full bg-amber" />
      </span>
      {label}
    </span>
  );
}
