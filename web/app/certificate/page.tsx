"use client";

// The approval certificate: once a change is applied, one page that says what was changed, how risky it was
// judged to be, who approved it and when, and where Orion learned each link it affects. Printable, and
// "Save as PDF" from the print dialog makes it a file to attach to a ticket or a board pack.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { ErrorNote, Spinner } from "@/components/ui";
import { get } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { useFetch } from "@/lib/hooks";
import { riskColor } from "@/lib/theme";
import type { BlameSource, ToolResponse, UniverseDetail } from "@/lib/types";
import { factWords, kindWord, opWords, plainWhy, scenarioLabel, STATUS_WORD } from "@/lib/words";

const KIND: Record<string, string> = {
  message: "Chat message",
  doc: "Document",
  adr: "Decision record",
  change: "Code change",
  code: "Code",
  ticket: "Ticket",
  merge: "Approved change",
  runbook: "Runbook",
  export: "Data export",
};

function Sources({ facts }: { facts: string[] }) {
  const [rows, setRows] = useState<Record<string, BlameSource[] | null>>({});
  useEffect(() => {
    let live = true;
    for (const f of facts)
      get<ToolResponse<{ sources: BlameSource[] }>>(`/blame?fact=${encodeURIComponent(f)}`)
        .then((r) => live && setRows((x) => ({ ...x, [f]: r.result.sources ?? [] })))
        .catch(() => live && setRows((x) => ({ ...x, [f]: [] })));
    return () => {
      live = false;
    };
  }, [facts]);
  if (!facts.length) return <p className="text-[13px] text-muted">No links to show.</p>;
  return (
    <ol className="space-y-3">
      {facts.map((f) => {
        const src = rows[f];
        const first = src?.[0];
        return (
          <li key={f} className="break-inside-avoid">
            <p className="text-[13px] font-medium text-ink">{factWords(f)}</p>
            {src === undefined ? (
              <p className="text-[12px] text-faint">Loading where this came from…</p>
            ) : first ? (
              <p className="text-[12px] leading-snug text-muted">
                {KIND[first.kind ?? ""] ?? "Record"}
                {first.title ? `, ${first.title}` : ""}
                {first.author ? `, by ${first.author}` : ""}
                {first.at ? `, ${fmtDate(first.at)}` : ""}
                {(first.quote || first.text) && <>: &ldquo;{(first.quote || first.text || "").slice(0, 180)}&rdquo;</>}
                {first.url && (
                  <span className="block truncate text-faint print:whitespace-normal">{first.url}</span>
                )}
              </p>
            ) : (
              <p className="text-[12px] text-faint">No source on record.</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Certificate() {
  const uid = useSearchParams().get("u");
  const { personName, tenant } = useApp();
  const d = useFetch<UniverseDetail>(uid ? `/universes/${uid}` : null);
  if (!uid) return <p className="p-8 text-sm text-muted">Open a certificate from an applied change on the Approvals screen.</p>;
  if (d.error) return <div className="p-8"><ErrorNote error={d.error} onRetry={d.reload} /></div>;
  if (!d.data)
    return (
      <p className="flex items-center gap-2 p-8 text-sm text-muted">
        <Spinner /> Loading
      </p>
    );
  const u = d.data;
  const diff = u.diff;
  const approved = u.approvals.filter((a) => a.verdict === "approved");
  const opFacts = u.opened_facts ?? [];
  const affected = [...new Set([...(u.closed_facts ?? []), ...(diff?.broken ?? []).flatMap((b) => b.fact_uids)])].slice(0, 12);
  const merged = u.status === "merged";

  return (
    <div className="h-full overflow-y-auto print:h-auto print:overflow-visible">
      <article className="certificate mx-auto max-w-[760px] px-6 py-10 print:max-w-none print:px-0 print:py-0">
        <div className="mb-8 flex items-center gap-3 print:hidden">
          <Link href={`/review?u=${u.uid}`} className="btn btn-ghost h-8 px-2.5 text-[12px]">
            Back to the approval
          </Link>
          <button type="button" className="btn btn-primary ml-auto h-8" onClick={() => window.print()}>
            Print or save as PDF
          </button>
        </div>

        <header className="border-b border-rule pb-6">
          <p className="text-[12px] text-muted">
            {tenant?.name ?? "Corvane"} · Change certificate · {kindWord(u.kind)} {scenarioLabel(u.uid)}
          </p>
          <h1 className="heading mt-2 text-[28px] leading-[1.1]">{u.title}</h1>
          <p className={`mt-2 text-[13px] ${merged ? "text-ok" : "text-warn"}`}>
            {merged
              ? `Approved and applied on ${fmtDate(u.merged_at)}${u.merged_by ? ` by ${personName(u.merged_by)}` : ""}.`
              : `Not applied: this change is ${STATUS_WORD[u.status] ?? u.status}.`}
          </p>
        </header>

        <section className="border-b border-rule py-6">
          <h2 className="label mb-2">What was changed</h2>
          <ol className="list-inside list-decimal space-y-1 text-[14px] text-ink">
            {u.ops.map((o, i) => (
              <li key={i}>{opWords(o)}</li>
            ))}
          </ol>
        </section>

        {diff && (
          <section className="grid gap-6 border-b border-rule py-6 sm:grid-cols-[auto_1fr]">
            <div>
              <h2 className="label mb-1">Risk when it was tested</h2>
              <p className="heading text-[44px] leading-none tnum" style={{ color: riskColor(diff.risk.level) }}>
                {diff.risk.score}
              </p>
              <p className="text-[12px] text-muted">{diff.risk.level} risk, out of 100</p>
            </div>
            <ul className="space-y-1 text-[13px] text-muted">
              {(diff.risk.terms ?? []).slice(0, 8).map((t, i) => (
                <li key={i} className="flex gap-3">
                  <span className="tnum w-8 shrink-0 text-right text-ink">+{t.points}</span>
                  <span>
                    <span className="text-ink">{t.subject}</span>: {plainWhy(t.why)}
                  </span>
                </li>
              ))}
              {!diff.risk.terms?.length && <li>Nothing it touches would stop working.</li>}
            </ul>
          </section>
        )}

        <section className="border-b border-rule py-6">
          <h2 className="label mb-2">Who approved</h2>
          {approved.length === 0 ? (
            <p className="text-[13px] text-muted">No approvals recorded.</p>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="text-[12px] text-muted">
                <tr>
                  <th className="py-1 font-medium">Person</th>
                  <th className="py-1 font-medium">For the team</th>
                  <th className="py-1 font-medium">When</th>
                  <th className="py-1 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {approved.map((a, i) => (
                  <tr key={i} className="border-t border-rule-soft align-top">
                    <td className="py-1.5 text-ink">{personName(a.by)}</td>
                    <td className="py-1.5 text-muted">{a.team ?? "none required"}</td>
                    <td className="py-1.5 text-muted">{fmtDate(a.at)}</td>
                    <td className="py-1.5 text-muted">{a.reason || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {u.required.length > 0 && (
            <p className="mt-2 text-[12px] text-muted">
              Teams that had to agree, from the company map: {u.required.map((r) => `${r.team} (${r.because.join("; ")})`).join(", ")}.
            </p>
          )}
        </section>

        <section className="border-b border-rule py-6">
          <h2 className="label mb-2">The record it made</h2>
          <Sources facts={merged ? opFacts : []} />
        </section>

        <section className="py-6">
          <h2 className="label mb-2">The links it affected, and where each was learned</h2>
          <Sources facts={affected} />
        </section>

        <footer className="mt-4 text-[11px] text-faint">
          Generated by Orion from the company&rsquo;s records. Every link above can be traced to its source in the
          app. {diff ? `Tested on the records as of ${fmtDate(diff.asof)}.` : ""}
        </footer>
      </article>
    </div>
  );
}

export default function CertificatePage() {
  return (
    <Suspense>
      <Certificate />
    </Suspense>
  );
}
