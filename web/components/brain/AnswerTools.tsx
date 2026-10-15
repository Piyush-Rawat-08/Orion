"use client";

// Two things an answer can do after it lands, both without the AI service: "Was this true on…?" re-checks every
// point against the company as it was on another day (drag the slider and the marks flip as you pass the record
// that changed them), and "Watch this" turns the question into a standing check the Inbox reports on.

import { useEffect, useMemo, useRef, useState } from "react";
import { get, post } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { useFetch } from "@/lib/hooks";
import type { Verdict } from "@/lib/types";

export interface Dated {
  date: string;
  /** claim index -> its mark on that date, and whether it differs from the mark one step earlier */
  claims: Map<number, { verdict: Verdict; reason: string; flipped: boolean }>;
}

interface Timeline {
  start: string;
  now: string;
  decisions: { at: string; key: string; title: string }[];
  events: { at: string; label: string; kind: string }[];
}

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** "Was this true on…?": a date slider under the answer's points. */
export function TimeScrubber({ answer, onDated }: { answer: string; onDated: (d: Dated | null) => void }) {
  const tl = useFetch<Timeline>("/timeline");
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cache = useRef(new Map<string, Map<number, { verdict: Verdict; reason: string }>>());
  const prev = useRef<Map<number, { verdict: Verdict; reason: string }> | null>(null);

  const range = useMemo(() => {
    if (!tl.data) return null;
    const a = Date.parse(tl.data.start);
    const b = Date.parse((tl.data.now || "").slice(0, 10)) || Date.now();
    return { a, b, days: Math.max(1, Math.round((b - a) / DAY)) };
  }, [tl.data]);
  // the dates where something on record changed: the slider's tick marks
  const marks = useMemo(() => {
    if (!tl.data || !range) return [];
    const at = [...tl.data.decisions.map((d) => d.at), ...tl.data.events.map((e) => e.at)]
      .map((x) => Date.parse((x ?? "").slice(0, 10)))
      .filter((t) => t >= range.a && t <= range.b);
    return [...new Set(at.map((t) => Math.round((t - range.a) / DAY)))].sort((x, y) => x - y);
  }, [tl.data, range]);

  useEffect(() => {
    if (!open || day === null || !range) return;
    const date = iso(range.a + day * DAY);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        let got = cache.current.get(date);
        if (!got) {
          setBusy(true);
          const r = await post<{ claims: { index: number; verdict: Verdict; reason: string }[] }>(
            `/answers/${encodeURIComponent(answer)}/asof`,
            { date },
          );
          got = new Map(r.claims.map((c) => [c.index, { verdict: c.verdict, reason: c.reason }]));
          cache.current.set(date, got);
        }
        if (cancelled) return;
        const before = prev.current;
        prev.current = got;
        onDated({
          date,
          claims: new Map(
            [...got.entries()].map(([i, c]) => [i, { ...c, flipped: !!before && before.get(i)?.verdict !== c.verdict }]),
          ),
        });
        setErr(null);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, day, range, answer, onDated]);

  const close = () => {
    setOpen(false);
    setDay(null);
    prev.current = null;
    onDated(null);
  };

  if (!open)
    return (
      <button
        type="button"
        className="btn btn-ghost h-7 px-2 text-[12px]"
        onClick={() => {
          setOpen(true);
          if (range) setDay(range.days);
        }}
        disabled={!range}
        title="Check every point against the records as they were on another day"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" />
        </svg>
        Was this true on…?
      </button>
    );

  const d = day ?? range?.days ?? 0;
  const date = range ? iso(range.a + d * DAY) : "";
  return (
    <div className="rounded-lg border border-rule bg-well px-3 py-2.5">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="text-muted">Checked against the records on</span>
        <span className="tnum font-medium text-ink">{fmtDate(date)}</span>
        {busy && <span className="text-faint">checking…</span>}
        <button type="button" className="ml-auto text-muted underline-offset-2 hover:text-ink hover:underline" onClick={close}>
          Back to today
        </button>
      </div>
      {range && (
        <div className="relative mt-1.5">
          <input
            type="range"
            className="scrub"
            min={0}
            max={range.days}
            value={d}
            onChange={(e) => setDay(Number(e.target.value))}
            aria-label="Date to check the answer against"
            aria-valuetext={fmtDate(date)}
            list={`marks-${answer}`}
          />
          <datalist id={`marks-${answer}`}>
            {marks.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <div className="pointer-events-none absolute inset-x-0 top-[14px] h-[5px]" aria-hidden>
            {marks.map((m) => (
              <span key={m} className="absolute top-0 h-[5px] w-px bg-warn/70" style={{ left: `${(m / range.days) * 100}%` }} />
            ))}
          </div>
        </div>
      )}
      <p className="mt-1 text-[11px] text-faint">
        Ticks mark days when something on record changed. Points the records can&rsquo;t check by date say so.
      </p>
      {err && <p className="mt-1 text-[12px] text-bad">{err}</p>}
    </div>
  );
}

let watched: Promise<Set<string>> | null = null;
const watchedSet = () =>
  (watched ??= get<{ uid: string }[]>("/watching")
    .then((r) => new Set(r.map((x) => x.uid)))
    .catch(() => new Set<string>()));

/** "Watch this": the question becomes a standing check; every new record re-checks it. */
export function WatchButton({ answer }: { answer: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    watchedSet().then((s) => live && setOn(s.has(answer)));
    return () => {
      live = false;
    };
  }, [answer]);
  const toggle = async () => {
    const next = !on;
    setOn(next);
    try {
      await post(`/answers/${encodeURIComponent(answer)}/watch`, { on: next });
      const s = await watchedSet();
      if (next) s.add(answer);
      else s.delete(answer);
    } catch {
      setOn(!next);
    }
  };
  return (
    <button
      type="button"
      className={`btn h-7 px-2 text-[12px] ${on ? "" : "btn-ghost"}`}
      aria-pressed={!!on}
      onClick={toggle}
      disabled={on === null}
      title={on ? "Stop watching this question" : "Re-check this answer whenever the records change, and tell me in the Inbox"}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
        <circle cx="8" cy="8" r="2" fill={on ? "currentColor" : "none"} />
      </svg>
      {on ? "Watching" : "Watch this"}
    </button>
  );
}
