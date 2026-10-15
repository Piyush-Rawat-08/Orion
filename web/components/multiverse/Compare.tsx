"use client";

// Compare two what-ifs: risk, what breaks, who notices and who has to agree, side by side, then send the safer
// one for approval. Two copies of the company at once, which is the whole idea of the product.

import { useMemo, useState } from "react";
import { ErrorNote, RiskBadge, Spinner } from "../ui";
import { post } from "@/lib/api";
import { useFetch } from "@/lib/hooks";
import { riskColor, universeAccent } from "@/lib/theme";
import type { ForkResult, Universe, UniverseDetail } from "@/lib/types";
import { kindWord, scenarioLabel } from "@/lib/words";

function Side({ d, other, safer }: { d: UniverseDetail | null; other: UniverseDetail | null; safer: boolean }) {
  if (!d?.diff) return <div className="skeleton h-40" />;
  const x = d.diff;
  const o = other?.diff;
  const broken = x.broken.map((b) => b.service);
  const onlyHere = new Set(o ? broken.filter((b) => !o.broken.some((ob) => ob.service === b)) : []);
  const row = (label: string, value: React.ReactNode) => (
    <div className="border-t border-rule-soft py-2">
      <p className="text-[11px] text-muted">{label}</p>
      <div className="mt-0.5 text-[13px] text-ink">{value}</div>
    </div>
  );
  return (
    <div className={`min-w-0 rounded-lg border px-3 py-3 ${safer ? "border-ok/50" : "border-rule"}`}>
      <p className="flex items-center gap-2 text-[12px]">
        <span className="mono font-semibold" style={{ color: universeAccent(d.uid) }}>
          {scenarioLabel(d.uid)}
        </span>
        <span className="text-muted">{kindWord(d.kind)}</span>
        {safer && <span className="ml-auto rounded-full border border-ok/40 px-2 text-[11px] text-ok">safer</span>}
      </p>
      <p className="mt-1 line-clamp-2 text-[13px] font-medium text-ink">{d.title}</p>
      <p className="heading mt-2 text-[28px] leading-none tnum" style={{ color: riskColor(x.risk.level) }}>
        {x.risk.score}
        <span className="ml-1.5 align-middle text-[12px] font-normal text-muted">{x.risk.level} risk</span>
      </p>
      {row(
        `${broken.length} ${broken.length === 1 ? "system stops" : "systems stop"} working`,
        broken.length ? (
          <span className="flex flex-wrap gap-1">
            {broken.map((b) => (
              <span key={b} className={`rounded border px-1.5 text-[11px] ${onlyHere.has(b) ? "border-bad/50 text-bad" : "border-rule text-muted"}`}>
                {b}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted">nothing</span>
        ),
      )}
      {row("Customers who would notice", (x.customers ?? []).map((c) => c.customer).join(", ") || <span className="text-muted">none</span>)}
      {row("Teams that have to agree", (x.required_approvers ?? []).map((r) => r.team).join(", ") || <span className="text-muted">nobody</span>)}
      {row("Nobody would know", x.new_orphans.map((o) => o.service).join(", ") || <span className="text-muted">nothing</span>)}
    </div>
  );
}

export default function Compare({ universes, onSent }: { universes: Universe[]; onSent: (uid: string) => void }) {
  const open = useMemo(() => universes.filter((u) => u.status === "open" && u.risk !== undefined), [universes]);
  // start with two different changes: the newest, and the newest that changes something else
  const same = (x: Universe, y: Universe) => JSON.stringify(x.ops) === JSON.stringify(y.ops);
  const [a, setA] = useState<string>(open[0]?.uid ?? "");
  const [b, setB] = useState<string>((open.find((u) => open[0] && !same(u, open[0])) ?? open[1])?.uid ?? "");
  const A = useFetch<UniverseDetail>(a ? `/universes/${a}` : null);
  const B = useFetch<UniverseDetail>(b ? `/universes/${b}` : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (open.length < 2)
    return <p className="px-3 py-3 text-[12px] text-muted">Test at least two what-ifs, then compare them here.</p>;

  const da = A.data?.uid === a ? A.data : null;
  const db = B.data?.uid === b ? B.data : null;
  // safer: the lower risk; on a tie, fewer systems broken, then fewer customers
  const score = (d: UniverseDetail | null) =>
    d?.diff ? [d.diff.risk.score, d.diff.broken.length, d.diff.customers?.length ?? 0] : [Infinity, 0, 0];
  const cmp = (() => {
    const [x, y] = [score(da), score(db)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  })();
  const safer = cmp < 0 ? da : cmp > 0 ? db : null;

  const send = async () => {
    if (!safer) return;
    if (safer.kind === "dryrun") return onSent(safer.uid);
    setBusy(true);
    setErr(null);
    try {
      const r = await post<ForkResult>("/fork", { kind: "dryrun", title: safer.title, ops: safer.ops });
      onSent(r.uid);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const picker = (value: string, set: (v: string) => void, not: string, label: string) => (
    <label className="block min-w-0 flex-1">
      <span className="label">{label}</span>
      <select className="field mt-1" value={value} onChange={(e) => set(e.target.value)}>
        {open
          .filter((u) => u.uid !== not)
          .map((u) => (
            <option key={u.uid} value={u.uid}>
              {scenarioLabel(u.uid)} {u.title}
            </option>
          ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-3 px-2">
      <div className="flex gap-2">
        {picker(a, setA, b, "This")}
        {picker(b, setB, a, "against")}
      </div>
      {(A.error || B.error) && <ErrorNote error={(A.error ?? B.error)!} onRetry={() => (A.reload(), B.reload())} />}
      <div className="grid grid-cols-2 gap-2 lg:gap-4">
        <Side d={da} other={db} safer={!!safer && safer === da} />
        <Side d={db} other={da} safer={!!safer && safer === db} />
      </div>
      {da && db && (
        <div className="flex flex-wrap items-center gap-2">
          {safer ? (
            <>
              <button type="button" className="btn btn-primary h-8" disabled={busy} onClick={send}>
                {busy && <Spinner size={12} />}
                {safer.kind === "dryrun" ? `Open ${scenarioLabel(safer.uid)}, already waiting for approval` : `Send ${scenarioLabel(safer.uid)} for approval`}
              </button>
              <RiskBadge level={safer.diff?.risk.level} score={safer.diff?.risk.score} />
            </>
          ) : (
            <p className="text-[12px] text-muted">The two are equally risky.</p>
          )}
        </div>
      )}
      {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
    </div>
  );
}
