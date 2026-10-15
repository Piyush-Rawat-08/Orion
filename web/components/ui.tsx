"use client";

import { LayoutGroup, motion } from "motion/react";
import { useId } from "react";
import { C, NODE_COLORS, riskColor, universeAccent, VERDICT_COLORS } from "@/lib/theme";
import type { Verdict } from "@/lib/types";
import { CHECK_LONG, NODE_WORD, scenarioLabel } from "@/lib/words";
import { SPRING } from "./motion";

const VERDICT_TEXT = CHECK_LONG;

/** Four shapes a colour-blind reader can tell apart: solid check (verified), half-filled (partial), hollow
 *  (not verified, not checked), red cross (contradicted: the fact changed). Colour only repeats the shape. */
export function VerdictMark({ verdict, size = 14 }: { verdict: Verdict; size?: number }) {
  const c = VERDICT_COLORS[verdict];
  const common = { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true as const };
  if (verdict === "verified")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="7.2" fill={c} />
        <path d="M4.9 8.3l2 2 4.2-4.5" fill="none" stroke="var(--color-night)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (verdict === "partial")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.6" fill="none" stroke={c} strokeWidth="1.4" />
        <path d="M8 1.4a6.6 6.6 0 0 1 0 13.2z" fill={c} />
      </svg>
    );
  if (verdict === "judged")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.6" fill="none" stroke={c} strokeWidth="1.3" />
        <path d="M4.9 8.3l2 2 4.2-4.5" fill="none" stroke={c} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (verdict === "unsupported" || verdict === "unverified" || verdict === "not_checked")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.4" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray={verdict === "unsupported" ? undefined : "2 2.2"} />
      </svg>
    );
  if (verdict === "expired")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.6" fill="none" stroke={c} strokeWidth="1.3" />
        <path d="M8 4.8V8l2.2 1.4" fill="none" stroke={c} strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="7.2" fill={c} />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="var(--color-night)" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: VERDICT_COLORS[verdict] }}>
      <VerdictMark verdict={verdict} size={13} />
      {VERDICT_TEXT[verdict]}
    </span>
  );
}

/** Score, a three-step meter and the level. No pill: the colour is the signal. */
export function RiskBadge({ level, score }: { level?: string; score?: number | null }) {
  const c = riskColor(level);
  const steps = level === "high" ? 3 : level === "medium" ? 2 : level === "low" ? 1 : 0;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px]" title={`Risk ${score ?? "not scored"} out of 100: ${level ?? "not scored"}`}>
      <span className="flex items-end gap-[2px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-[3px] rounded"
            style={{ height: 5 + i * 3, background: i < steps ? c : "var(--color-rule)" }}
          />
        ))}
      </span>
      <span className="mono font-semibold tnum" style={{ color: c }}>
        {score ?? "–"}
      </span>
      <span className="text-muted">{level ? `${level} risk` : "not scored"}</span>
    </span>
  );
}

export function BranchGlyph({ size = 11, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={(size * 9) / 11} height={size} viewBox="0 0 9 11" aria-hidden className={className}>
      <path d="M2 0v11M2 6.2c0-2.6 5-2 5-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function UniverseTag({ uid, className = "" }: { uid: string; className?: string }) {
  const c = universeAccent(uid);
  return (
    <span
      className={`mono inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-semibold ${className}`}
      style={{ color: c, background: `${c}17` }}
      title={`What-if ${scenarioLabel(uid)}`}
    >
      <BranchGlyph size={10} />
      {scenarioLabel(uid)}
    </span>
  );
}

export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={`animate-spin ${className}`}
      aria-hidden
      style={{ animationDuration: "0.8s" }}
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.8" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  const offline = /fetch|network|Failed/i.test(error);
  return (
    <div role="alert" className="rounded-xl border border-bad/30 bg-bad/[0.06] px-4 py-3 text-sm text-ink">
      <p className="font-medium text-bad">{offline ? "Can't connect to Orion" : "Something went wrong"}</p>
      <p className="mt-0.5 text-muted">
        {offline
          ? `The Orion server isn't answering (${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8100"}). Check that it is running, then try again.`
          : error}
      </p>
      {onRetry && (
        <button type="button" className="btn mt-2.5" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Shown on agent screens when the backend runs without a model API key. */
export function AgentsOff({ className = "" }: { className?: string }) {
  return (
    <p role="status" className={`flex items-start gap-2 text-xs leading-snug text-muted ${className}`}>
      <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
      <span>
        The AI assistant isn&rsquo;t set up yet (no API key), so asking questions and describing what-ifs in words are off.
        Picking changes for a what-if, History, Teams and seeing where facts came from all still work.
      </span>
    </p>
  );
}

/** An empty state that teaches: a heading line, one sentence, an optional drawing. */
export function Empty({ title, children, art }: { title: string; children?: React.ReactNode; art?: React.ReactNode }) {
  return (
    <div className="max-w-md">
      {art && <div className="mb-6 text-faint">{art}</div>}
      <p className="heading text-[28px] leading-[1.1] text-ink">{title}</p>
      {children && <div className="mt-2.5 text-[13px] leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mono inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-rule bg-raised px-1 text-[11px] text-muted shadow-[inset_0_-1px_0_var(--color-rule-strong)]">
      {children}
    </kbd>
  );
}

/** Segmented control whose selection slides between options. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
  size = "md",
}: {
  value: T;
  options: readonly (readonly [T, React.ReactNode])[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const id = useId();
  // a tab list moves with the arrow keys (Home/End too), and only the selected tab is in the Tab order
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex(([k]) => k === value);
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % options.length
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + options.length) % options.length
      : e.key === "Home" ? 0
      : e.key === "End" ? options.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(options[next][0]);
    const tabs = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[next]?.focus();
  };
  return (
    <LayoutGroup id={id}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKey}
        className={`relative inline-flex rounded-lg border border-rule bg-well p-[3px] ${size === "sm" ? "text-[11px]" : "text-[12px]"} ${className}`}
      >
        {options.map(([k, text]) => {
          const on = k === value;
          return (
            <button
              key={k}
              role="tab"
              type="button"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(k)}
              className={`relative flex-1 whitespace-nowrap rounded font-medium transition-colors duration-200 ${
                size === "sm" ? "px-2.5 py-1" : "px-3 py-1.5"
              } ${on ? "text-ink" : "text-muted hover:text-ink"}`}
            >
              {on && (
                <motion.span
                  layoutId="seg"
                  transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
                  className="absolute inset-0 rounded border border-rule-strong bg-raised shadow-chip"
                  aria-hidden
                />
              )}
              <span className="relative">{text}</span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

/** Small horizontal bar for metric comparisons (before vs after). */
export function DeltaBar({ before, after, max, color }: { before: number; after: number; max: number; color: string }) {
  const w = (v: number) => `${Math.max(2, (v / (max || 1)) * 100)}%`;
  return (
    <div className="relative h-[6px] w-full rounded-full bg-rule-soft" aria-hidden>
      <div className="absolute inset-y-0 left-0 rounded-full bg-faint/40" style={{ width: w(before) }} />
      <motion.div
        className="absolute inset-y-[1px] left-0 rounded-full"
        style={{ background: color }}
        initial={{ width: 0 }}
        animate={{ width: w(after) }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      />
    </div>
  );
}

export function LegendDot({ color, line, label, faded }: { color: string; line?: boolean; label: string; faded?: boolean }) {
  return (
    <li className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className={line ? "inline-block h-[2px] w-3 rounded-full" : "inline-block size-[7px] rounded-full"}
        style={{ background: color, opacity: faded ? 0.55 : 1 }}
      />
      {label}
    </li>
  );
}

export function NodeTypeLegend() {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
      {(Object.entries(NODE_COLORS) as [string, string][]).map(([k, c]) => (
        <LegendDot key={k} color={c} label={NODE_WORD[k] ?? k} />
      ))}
      <LegendDot color={C.undeclared} line label="connection nobody wrote down" />
    </ul>
  );
}
