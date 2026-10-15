"use client";

// Things nobody wrote down: every dependency Orion found in chat, tickets or code that isn't on the official
// list, with the words it was found in. "Add to the official list" doesn't write it down directly: it becomes a
// proposed change, so the team responsible approves it like any other change.

import { useState } from "react";
import { useApp } from "../AppProvider";
import { ErrorNote, Spinner } from "../ui";
import { post } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { useFetch } from "@/lib/hooks";
import type { ForkResult } from "@/lib/types";

interface Row {
  source_uid: string;
  source: string;
  target_uid: string;
  target: string;
  fact: string;
  kind: string | null;
  quote: string | null;
  since: string | null;
  found_in: { kind: string | null; title: string | null; at: string | null; author: string | null; url: string | null } | null;
}

const FOUND: Record<string, string> = { message: "a message", ticket: "a ticket", code: "the code", doc: "a document", change: "a code change" };

export default function Unwritten({ onProposed }: { onProposed: (uid: string) => void }) {
  const { openBlame } = useApp();
  const rows = useFetch<Row[]>("/undeclared");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const propose = async (r: Row) => {
    setBusy(r.fact);
    setErr(null);
    try {
      const out = await post<ForkResult>("/fork", {
        kind: "dryrun",
        title: `Write down: ${r.source} relies on ${r.target}`,
        ops: [{ op: "declare_dependency", source: r.source, target: r.target }],
      });
      onProposed(out.uid);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="px-2">
      <p className="px-1 pb-2 text-[12px] leading-relaxed text-muted">
        Systems that rely on each other although no official list says so. Orion found each one in what people
        wrote. Adding one to the list sends it for approval first.
      </p>
      {rows.error && <ErrorNote error={rows.error} onRetry={rows.reload} />}
      {!rows.data && !rows.error && <div className="skeleton mx-1 h-16" />}
      {rows.data?.length === 0 && (
        <p className="px-1 py-3 text-[12px] text-muted">Everything Orion knows about is on the official list.</p>
      )}
      {err && <p role="alert" className="px-1 pb-2 text-[12px] text-bad">{err}</p>}
      <ul className="space-y-2">
        {rows.data?.map((r) => (
          <li key={r.fact} className="rounded-lg border border-rule bg-panel px-3 py-2.5">
            <p className="text-[13px] text-ink">
              {r.source} <span className="text-warn">relies on</span> {r.target}
            </p>
            {r.quote && <p className="mt-1 text-[12px] leading-snug text-muted">&ldquo;{r.quote}&rdquo;</p>}
            <p className="mt-1 text-[11px] text-faint">
              Found in {FOUND[r.found_in?.kind ?? ""] ?? "the records"}
              {r.found_in?.title ? ` (${r.found_in.title})` : ""}
              {r.found_in?.author ? ` by ${r.found_in.author}` : ""}
              {r.found_in?.at ? `, ${fmtDate(r.found_in.at)}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="btn h-7 px-2.5 text-[12px]" disabled={busy !== null} onClick={() => propose(r)}>
                {busy === r.fact && <Spinner size={11} />} Add to the official list
              </button>
              <button type="button" className="btn btn-ghost h-7 px-2 text-[12px]" onClick={() => openBlame({ fact: r.fact })}>
                Where this came from
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
