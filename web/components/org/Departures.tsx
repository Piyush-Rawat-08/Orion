"use client";

// If they left tomorrow: people ranked by how much their departure would break, worked out the way a what-if
// works it out (the person leaves on a scratch copy of the company and the same checks run), with a small picture
// of each one's reach: the systems they know around them, red where nobody else would know them.

import Link from "next/link";
import { ErrorNote, RiskBadge, Spinner } from "../ui";
import { useFetch } from "@/lib/hooks";
import { C } from "@/lib/theme";

interface Person {
  uid: string;
  name: string;
  team: string | null;
  risk: number;
  level: string;
  nobody_would_know: string[];
  no_team: string[];
  groups_split: number;
  knows: string[];
  knows_count: number;
}

/** The person in the middle, what they know around them; red: nobody else would know it. */
function Reach({ p }: { p: Person }) {
  const all = [...new Set([...p.nobody_would_know, ...p.knows])].slice(0, 14);
  const lost = new Set(p.nobody_would_know);
  const R = 24;
  return (
    <svg width="64" height="64" viewBox="-32 -32 64 64" className="shrink-0" aria-hidden>
      <circle r={R} fill="none" stroke={C.rule} strokeWidth="1" />
      {all.map((s, i) => {
        const a = (i / Math.max(1, all.length)) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(a) * R,
          y = Math.sin(a) * R;
        const red = lost.has(s);
        return (
          <g key={s}>
            <line x1={0} y1={0} x2={x} y2={y} stroke={red ? C.bad : C.rule} strokeWidth={red ? 1.2 : 0.8} strokeOpacity={red ? 0.9 : 0.7} />
            <circle cx={x} cy={y} r={red ? 3.4 : 2.4} fill={red ? C.bad : C.muted} />
          </g>
        );
      })}
      <circle r="5" fill={C.text} />
    </svg>
  );
}

export default function Departures({ onFocus }: { onFocus?: (uid: string | null) => void }) {
  const d = useFetch<{ people: Person[]; total: number; ms: number; cached?: boolean }>("/departures");
  return (
    <section aria-labelledby="leave-h" className="mt-9">
      <h2 id="leave-h" className="pane-title mb-1">
        <span className="text-ink">If they left tomorrow</span>
      </h2>
      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        Everyone, ranked by what their leaving would break: systems nobody else knows how to run, systems no team
        would be responsible for, groups that would fall apart. Each is tested like a what-if, on a copy of the company.
      </p>
      {d.error && <ErrorNote error={d.error} onRetry={d.reload} />}
      {!d.data && !d.error && (
        <p className="flex items-center gap-2 text-[12px] text-muted">
          <Spinner size={12} /> Testing every person leaving (a few seconds the first time)
        </p>
      )}
      <ol className="space-y-1.5">
        {d.data?.people.map((p, i) => (
          <li
            key={p.uid}
            className="flex items-center gap-3 rounded-lg border border-rule bg-panel px-3 py-2"
            onMouseEnter={() => onFocus?.(p.uid)}
            onMouseLeave={() => onFocus?.(null)}
          >
            <span className="mono w-5 shrink-0 text-right text-[11px] text-faint">{i + 1}</span>
            <Reach p={p} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-ink">{p.name}</span>
                <span className="text-[11px] text-muted">{p.team}</span>
                <span className="ml-auto">
                  <RiskBadge level={p.level} score={p.risk} />
                </span>
              </p>
              <p className="mt-0.5 text-[12px] leading-snug text-muted">
                {p.nobody_would_know.length > 0 ? (
                  <>
                    Nobody else would know <span className="text-bad">{p.nobody_would_know.join(", ")}</span>
                  </>
                ) : (
                  `Knows ${p.knows_count} ${p.knows_count === 1 ? "system" : "systems"}, all known by someone else too`
                )}
                {p.groups_split > 0 && <>; a group they bridge would split</>}
                {p.no_team.length > 0 && <>; no team would be left for {p.no_team.join(", ")}</>}
              </p>
              <Link
                href={`/multiverse?leave=${encodeURIComponent(p.name)}`}
                className="mt-0.5 inline-block text-[12px] text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
              >
                Test it properly
              </Link>
            </div>
          </li>
        ))}
      </ol>
      {d.data && (
        <p className="mt-2 text-[11px] text-faint">
          {d.data.total} people tested{d.data.cached ? "" : ` in ${(d.data.ms / 1000).toFixed(1)} s`}; shown: the {d.data.people.length} whose leaving matters most.
        </p>
      )}
    </section>
  );
}
