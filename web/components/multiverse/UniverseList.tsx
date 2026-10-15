"use client";

// The what-ifs as a branching line: the real company runs down the gutter, every what-if branches off it in its
// own colour. A scenario tested more than once (the same changes, whether as a what-if or as a proposed change) is
// one row with a version stack: how many runs, the latest risk, and on expand every run with why its result
// differs from the run before and the record that made the difference. Merged universes curve back into main;
// discarded ones end in a hollow node.

import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { EASE } from "../motion";
import { useApp } from "../AppProvider";
import { RiskBadge } from "../ui";
import { useFetch } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import { C, riskColor, universeAccent } from "@/lib/theme";
import type { Universe, UniverseDetail } from "@/lib/types";
import { factWords, kindWord, scenarioLabel, STATUS_WORD } from "@/lib/words";

const STATUS = STATUS_WORD;

const num = (uid: string) => Number(uid.replace(/\D/g, "")) || 0;

/** The same changes, however they were worded or asked for: ops with their keys sorted and names lower-cased. */
function opsKey(u: Universe): string {
  if (!u.ops?.length) return `title|${u.title.trim().toLowerCase()}`;
  const norm = u.ops.map((o) =>
    Object.keys(o)
      .sort()
      .map((k) => `${k}=${String(o[k]).trim().toLowerCase()}`)
      .join("&"),
  );
  return `ops|${norm.sort().join(";")}`;
}

function Gutter({ color, status, first, last }: { color: string; status: string; first: boolean; last: boolean }) {
  const merged = status === "merged";
  return (
    <svg width="34" height="100%" viewBox="0 0 34 56" preserveAspectRatio="none" className="absolute inset-y-0 left-0 h-full" aria-hidden>
      {/* main */}
      <line x1="9" y1={first ? 18 : 0} x2="9" y2={last ? 38 : 56} stroke={C.trunk} strokeOpacity="0.28" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      {/* the branch */}
      <path d="M9 38 C 9 28, 24 30, 24 20" fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      {merged && <path d="M24 20 C 24 12, 9 14, 9 4" fill="none" stroke={color} strokeOpacity="0.55" strokeWidth="1.5" strokeDasharray="2 2.5" vectorEffect="non-scaling-stroke" />}
      <circle cx="9" cy="38" r="2.2" fill={C.trunk} fillOpacity="0.5" />
    </svg>
  );
}

function Node({ color, status, runs }: { color: string; status: string; runs: number }) {
  const open = status === "open";
  return (
    <span className="absolute left-[20px] top-[16px]" aria-hidden>
      {/* earlier runs sit behind the latest, like a stack of cards */}
      {runs > 1 && <span className="absolute left-[3px] top-[-3px] size-[9px] rounded-full border-[1.5px] opacity-40" style={{ borderColor: color }} />}
      <span
        className="relative block size-[9px] rounded-full border-[1.5px]"
        style={{
          borderColor: color,
          background: open ? color : C.panel,
          boxShadow: open ? `0 0 0 3px ${color}22` : undefined,
        }}
      />
    </span>
  );
}

/** Why the risk changed between two runs of the same change: the two blast radii laid over each other (what
 *  stopped breaking, what started, what still does) and the record that made the difference, one click from
 *  where it came from. */
function WhyChanged({ prev, cur }: { prev: Universe; cur: Universe }) {
  const { openBlame } = useApp();
  const a = useFetch<UniverseDetail>(`/universes/${prev.uid}`);
  const b = useFetch<UniverseDetail>(`/universes/${cur.uid}`);
  if (!a.data?.diff || !b.data?.diff) return null;
  const before = new Map(a.data.diff.broken.map((x) => [x.service, x]));
  const after = new Map(b.data.diff.broken.map((x) => [x.service, x]));
  const gone = [...before.keys()].filter((x) => !after.has(x));
  const added = [...after.keys()].filter((x) => !before.has(x));
  const still = [...after.keys()].filter((x) => before.has(x));
  const moved = cur.base_version !== prev.base_version;
  // the record that closed the gap: a link on the old witness path of something that no longer breaks, which no
  // remaining breakage still runs through
  const keep = new Set(b.data.diff.broken.flatMap((x) => x.fact_uids));
  const closer = gone.flatMap((g) => before.get(g)?.fact_uids ?? []).find((f) => !keep.has(f));
  const chip = (name: string, tone: "bad" | "ok" | "muted") => (
    <span
      key={`${tone}:${name}`}
      className={`rounded border px-1.5 py-px text-[11px] ${
        tone === "bad" ? "border-bad/40 text-bad" : tone === "ok" ? "border-ok/40 text-ok line-through decoration-ok/60" : "border-rule text-muted"
      }`}
      title={tone === "ok" ? "no longer breaks" : tone === "bad" ? "breaks now, didn't before" : "breaks in both"}
    >
      {name}
    </span>
  );
  return (
    <span className="mt-1 block space-y-1.5 text-[12px] leading-snug text-muted">
      <span className="block">
        {gone.length || added.length ? (
          <>
            Risk {prev.risk ?? "?"} → {cur.risk ?? "?"}
            {moved ? ": the company's records changed in between." : ", though the company hadn't changed."}
          </>
        ) : (
          <>The same systems break{moved ? ", although the company's records changed in between" : ""}.</>
        )}
      </span>
      {(gone.length > 0 || added.length > 0) && (
        <span className="flex flex-wrap gap-1" aria-label="What breaks, then and now">
          {gone.map((g) => chip(g, "ok"))}
          {added.map((g) => chip(g, "bad"))}
          {still.slice(0, 4).map((g) => chip(g, "muted"))}
          {still.length > 4 && <span className="text-[11px] text-faint">+{still.length - 4} still</span>}
        </span>
      )}
      {closer && (
        <span className="flex flex-wrap items-center gap-1.5">
          What made the difference:
          <span
            role="button"
            tabIndex={0}
            onClick={() => openBlame({ fact: closer })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openBlame({ fact: closer });
              }
            }}
            className="cursor-pointer rounded border border-rule px-1.5 py-px text-[11px] text-ink hover:border-ember/60 hover:text-ember"
          >
            {factWords(closer)}
          </span>
        </span>
      )}
    </span>
  );
}

export default function UniverseList({
  universes,
  selected,
  onSelect,
  filter,
}: {
  universes: Universe[];
  selected: string | null;
  onSelect: (uid: string) => void;
  filter?: (u: Universe) => boolean;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // one row per change: runs with the same changes share a row, whether they were what-ifs or proposed changes
  // (asking the hero question tests the change the open proposal already holds); newest run first, newest first
  const groups = useMemo(() => {
    const by = new Map<string, Universe[]>();
    for (const u of filter ? universes.filter(filter) : universes) {
      const k = opsKey(u);
      by.set(k, [...(by.get(k) ?? []), u]);
    }
    return [...by.entries()]
      .map(([key, runs]) => {
        runs.sort((a, b) => num(b.uid) - num(a.uid));
        // the proposal waiting for approval leads; otherwise the newest open run
        const latest =
          runs.find((r) => r.status === "open" && r.kind === "dryrun") ?? runs.find((r) => r.status === "open") ?? runs[0];
        return { key, runs, latest, open: runs.some((r) => r.status === "open"), mixed: new Set(runs.map((r) => r.kind)).size > 1 };
      })
      .sort((a, b) => num(b.runs[0].uid) - num(a.runs[0].uid));
  }, [universes, filter]);
  const open = groups.filter((g) => g.open);
  const closed = groups.filter((g) => !g.open);
  const shown = showClosed ? [...open, ...closed] : open;

  return (
    <div>
      <ul>
        {shown.map((g, i) => {
          const u = g.latest;
          const c = universeAccent(u.uid);
          const active = g.runs.some((r) => r.uid === selected);
          const isOpen = expanded === g.key || (g.runs.length > 1 && active && expanded === null && g.runs[0].uid !== selected);
          const prevRun = g.runs.find((r) => num(r.uid) < num(u.uid) && r.risk !== undefined);
          return (
            <motion.li
              key={g.key}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: EASE, delay: Math.min(i, 6) * 0.03 }}
            >
              <div
                className={`group relative min-h-[56px] w-full rounded-lg transition-colors duration-200 ${active ? "bg-raised" : "hover:bg-raised/50"} ${
                  g.open ? "" : "text-muted"
                }`}
              >
                <Gutter color={c} status={u.status} first={i === 0} last={i === shown.length - 1 && !isOpen} />
                <Node color={c} status={u.status} runs={g.runs.length} />
                <button
                  type="button"
                  onClick={() => onSelect(u.uid)}
                  aria-current={u.uid === selected ? "true" : undefined}
                  className="block w-full py-2.5 pl-[40px] pr-3 text-left"
                >
                  <span className="flex items-center gap-2">
                    <span className="mono text-[11px] font-semibold" style={{ color: c }}>
                      {scenarioLabel(u.uid)}
                    </span>
                    <span className="text-[11px] text-muted">{kindWord(u.kind)}</span>
                    <span className="ml-auto">
                      {u.status === "open" ? (
                        <RiskBadge level={u.risk_level} score={u.risk} />
                      ) : (
                        <span className="text-[11px] text-muted">{STATUS[u.status] ?? u.status}</span>
                      )}
                    </span>
                  </span>
                  <span className={`mt-0.5 block truncate text-[13px] ${active ? "text-ink" : "text-muted group-hover:text-ink"}`}>{u.title}</span>
                </button>
                {g.runs.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? "" : g.key)}
                    aria-expanded={isOpen}
                    className="-mt-1.5 block w-full pb-2 pl-[40px] pr-3 text-left text-[12px] text-muted hover:text-ink"
                  >
                    Tested {g.runs.length}×{g.mixed ? ", as a what-if and as a proposal" : ""}
                    {u.risk !== undefined && prevRun?.risk !== undefined && prevRun.risk !== u.risk && (
                      <>
                        {" · "}risk now <span style={{ color: riskColor(u.risk_level) }}>{u.risk}</span>, was{" "}
                        <span style={{ color: riskColor(prevRun.risk_level) }}>{prevRun.risk}</span> in {scenarioLabel(prevRun.uid)}
                      </>
                    )}
                    <svg width="9" height="9" viewBox="0 0 10 10" className={`ml-1.5 inline transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`} aria-hidden>
                      <path d="M3 1.5L7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </button>
                )}
              </div>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.ol
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: EASE }}
                    className="ml-[24px] overflow-hidden border-l border-rule pl-3"
                    aria-label={`Every test of ${u.title}`}
                  >
                    {g.runs.map((r, k) => {
                      const older = g.runs[k + 1];
                      return (
                        <li key={r.uid}>
                          <button
                            type="button"
                            onClick={() => onSelect(r.uid)}
                            aria-current={r.uid === selected ? "true" : undefined}
                            className={`block w-full rounded px-2.5 py-2 text-left transition-colors ${r.uid === selected ? "bg-raised" : "hover:bg-raised/50"}`}
                          >
                            <span className="flex items-center gap-2 text-[12px]">
                              <span className="mono font-semibold" style={{ color: universeAccent(r.uid) }}>
                                {scenarioLabel(r.uid)}
                              </span>
                              <span className="text-muted">
                                {kindWord(r.kind).toLowerCase()}, {fmtDate(r.created_at)}
                              </span>
                              <span className="ml-auto">
                                {r.status === "open" ? <RiskBadge level={r.risk_level} score={r.risk} /> : <span className="text-muted">{STATUS[r.status] ?? r.status}</span>}
                              </span>
                            </span>
                          </button>
                          {older && (
                            <div className="px-2.5 pb-2">
                              <WhyChanged prev={older} cur={r} />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </motion.ol>
                )}
              </AnimatePresence>
            </motion.li>
          );
        })}
      </ul>
      {!shown.length && (
        <p className="px-3 py-4 text-[12px] leading-relaxed text-muted">
          No what-ifs yet. Describe one above, or pick the changes, and Orion tests it on a copy of the company.
        </p>
      )}
      {closed.length > 0 && (
        <button type="button" className="btn btn-ghost mt-2 w-full justify-center text-xs" onClick={() => setShowClosed(!showClosed)}>
          {showClosed ? "Hide applied and rejected" : `Show ${closed.length} applied or rejected`}
        </button>
      )}
    </div>
  );
}
