"use client";

// Where a record came from: click any line on a map (or a record under a point in an answer) to see who said it,
// where, and when.

import { useEffect, useRef, useState } from "react";
import { useApp } from "./AppProvider";
import { ErrorNote, Spinner } from "./ui";
import { useFetch } from "@/lib/hooks";
import { fmtDate, fmtMs } from "@/lib/format";
import { explainEdge, nameOf, nounOf } from "@/lib/explain";
import { C, EDGE_DOT, EDGE_LABELS, NODE_COLORS } from "@/lib/theme";
import type { BlameSource, EdgeType, Evidence, GNode, ToolResponse } from "@/lib/types";
import { factWords, graphWords } from "@/lib/words";

type BlameResult = ToolResponse<{ fact: string; sources: BlameSource[]; error?: string }>;

function sentenceToHighlight(text: string, subject?: string | null, object?: string | null, quote?: string | null) {
  if (quote && text.includes(quote)) {
    const i = text.indexOf(quote);
    return [i, i + quote.length] as const;
  }
  const parts = text.match(/[^.!?\n]+[.!?]?/g) ?? [text];
  let best = -1,
    bestScore = 0,
    offset = 0,
    bestStart = 0;
  const terms = [subject, object].filter(Boolean).map((t) => t!.toLowerCase());
  parts.forEach((p, idx) => {
    const lower = p.toLowerCase();
    const score = terms.reduce((s, t) => s + (lower.includes(t) ? 2 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = idx;
      bestStart = offset;
    }
    offset += p.length;
  });
  if (best < 0) return null;
  const s = parts[best];
  const lead = s.length - s.trimStart().length;
  return [bestStart + lead, bestStart + s.trimEnd().length] as const;
}

function Quote({ src }: { src: BlameSource }) {
  const text = src.text ?? "";
  const range = sentenceToHighlight(text, src.subject, src.object, src.quote);
  if (!range) return <>{text}</>;
  return (
    <>
      {text.slice(0, range[0])}
      <mark className="rounded bg-warn/20 px-0.5 text-ink [box-decoration-break:clone] shadow-[inset_0_-2px_0_var(--color-warn)]">
        {text.slice(range[0], range[1])}
      </mark>
      {text.slice(range[1])}
    </>
  );
}

const KIND_LABEL: Record<string, string> = {
  message: "Chat message",
  doc: "Document",
  adr: "Decision record",
  change: "Code change",
  ticket: "Ticket",
  merge: "Approved what-if",
  runbook: "Runbook",
  export: "Data export",
};

export default function BlameDrawer() {
  const { blame, closeBlame } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  const fact = blame?.fact ?? null;
  const res = useFetch<BlameResult>(
    fact ? `${blame?.tenant ? `/api/${blame.tenant}` : ""}/blame?fact=${encodeURIComponent(fact)}` : null,
  );

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (blame && !d.open) {
      d.showModal();
      // focus the drawer itself, not its first button (which would draw a focus ring around the close button)
      d.focus();
    }
    if (!blame && d.open) d.close();
  }, [blame]);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [blame]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onClose = () => closeBlame();
    d.addEventListener("close", onClose);
    // light-dismiss fallback for browsers without <dialog closedby>
    const supported = typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype;
    const onClick = (e: MouseEvent) => {
      if (supported || e.target !== d) return;
      const r = d.getBoundingClientRect();
      const inside = r.top <= e.clientY && e.clientY <= r.bottom && r.left <= e.clientX && e.clientX <= r.right;
      if (!inside) d.close();
    };
    d.addEventListener("click", onClick);
    return () => {
      d.removeEventListener("close", onClose);
      d.removeEventListener("click", onClick);
    };
  }, [closeBlame]);

  const edge = blame?.edge;
  const sources = res.data?.result.sources ?? [];
  const first = sources[0];
  const evidence: Evidence | undefined = res.data?.evidence[0];
  const type = (edge?.type ?? first?.type) as EdgeType | undefined;
  // Was it written down in the official record? Three answers: the edge says so; the fact says so; or, when
  // neither knows, its sources do (a fact that came from a chat message is not from the catalog).
  const declared: boolean | undefined =
    edge?.declared ??
    sources.find((x) => x.declared !== null && x.declared !== undefined)?.declared ??
    (sources.length ? (sources.some((x) => x.kind === "message") ? false : undefined) : undefined);
  const story =
    type && type in EDGE_LABELS
      ? explainEdge(
          { ...(edge ?? { type }), declared },
          blame?.source,
          blame?.target,
          { source: blame?.sourceName ?? first?.subject, target: blame?.targetName ?? first?.object },
          blame?.graph ?? undefined,
        )
      : null;
  const relLabel = type ? EDGE_LABELS[type] ?? type : "";
  const subj = blame?.sourceName ?? first?.subject ?? edge?.source;
  const obj = blame?.targetName ?? first?.object ?? edge?.target;
  const lineColor = type ? (type === "DEPENDS_ON" && declared === false ? C.undeclared : EDGE_DOT[type] ?? C.muted) : C.muted;
  // opened from a record chip, the drawer knows only the record's id until /blame answers: skeletons, not
  // "undefined → undefined"
  const known = !!(subj && obj);
  const loading = !known && !!fact && !res.data && !res.error;
  const heading = story ? `${story.subject} ${story.verb} ${story.object}` : known ? `${subj} ${relLabel} ${obj}` : factWords(fact) || "Where this came from";
  // a plain-text receipt: the claim, every source with its quote and link, and the query that found them
  const copyReceipt = async () => {
    const head = heading;
    const lines = [head];
    for (const x of sources)
      lines.push(
        "",
        `${KIND_LABEL[x.kind ?? ""] ?? x.kind ?? "Source"}${x.title ? `, ${x.title}` : ""}, ${fmtDate(x.at, true)}, by ${x.author ?? "unknown"}`,
        `"${(x.quote && x.text?.includes(x.quote) ? x.quote : x.text ?? "").trim()}"`,
        ...(x.url ? [x.url] : []),
      );
    if (evidence) lines.push("", `Technical details (${evidence.graph}${fact ? `, record ${fact}` : ""}):`, evidence.cypher, `params: ${JSON.stringify(evidence.params)}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: nothing to do */
    }
  };
  const dates = first
    ? [
        { label: "Became true", value: fmtDate(first.valid_from, true) },
        first.valid_to
          ? { label: "Stopped being true", value: fmtDate(first.valid_to, true), tone: "bad" as const }
          : { label: "Today", value: "Still true", tone: "ok" as const },
        { label: "Orion learned it", value: fmtDate(first.recorded_at, true) },
      ]
    : [];
  const stats: { label: string; value: string; tone?: "ok" | "bad" }[] = [
    ...(story?.stats.filter((s) => !(dates.length && /^(Since|Joined|Started|Decided)$/.test(s.label))) ?? []),
    ...dates,
  ];

  return (
    <dialog ref={ref} tabIndex={-1} className="drawer outline-none" aria-labelledby="blame-title" {...{ closedby: "any" }}>
      {blame && (
        <div className="flex h-full flex-col">
          <header className="border-b border-rule px-6 pb-5 pt-5">
            <div className="flex items-center gap-3">
              <p className="flex-1 text-[12px] text-muted">Where this comes from</p>
              {(sources.length > 0 || evidence) && (
                <button type="button" className="btn btn-ghost h-8 px-2.5 text-[12px]" onClick={copyReceipt} aria-live="polite">
                  {copied ? "Copied" : "Copy with sources"}
                </button>
              )}
              <button
                type="button"
                className="-mr-1.5 grid size-8 place-items-center rounded text-muted transition-colors hover:bg-raised hover:text-ink"
                onClick={() => ref.current?.close()}
                aria-label="Close"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* the connection, drawn: who → what */}
            {loading ? (
              <div className="mt-4 flex items-center gap-2" aria-hidden>
                <span className="skeleton h-9 w-32" />
                <span className="skeleton h-px flex-1" />
                <span className="skeleton h-9 w-32" />
              </div>
            ) : known ? (
            <div className="mt-4 flex items-center gap-2" aria-hidden>
              <End node={blame.source} name={subj} />
              <div className="relative flex min-w-[64px] flex-1 items-center">
                <span className="h-px flex-1" style={{ background: `linear-gradient(90deg, ${lineColor}33, ${lineColor})` }} />
                <svg width="8" height="10" viewBox="0 0 8 10" className="-ml-px shrink-0" style={{ color: lineColor }}>
                  <path d="M0 0l8 5-8 5z" fill="currentColor" />
                </svg>
                <span
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border bg-panel px-2 py-[1px] text-[11px]"
                  style={{ borderColor: `${lineColor}66`, color: lineColor }}
                >
                  {story?.verb ?? relLabel}
                </span>
              </div>
              <End node={blame.target} name={obj} />
            </div>
            ) : null}

            {loading ? (
              <span className="skeleton mt-5 block h-8 w-3/4" aria-hidden />
            ) : (
              <h2 id="blame-title" className="heading mt-5 text-[28px] leading-[1.12] tracking-[-0.01em]">
                {heading}
              </h2>
            )}
            {story?.flag && (
              <p
                className={`mt-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] ${
                  story.flag.tone === "bad" ? "border-bad/40 bg-bad/10 text-bad" : "border-warn/40 bg-warn/10 text-warn"
                }`}
              >
                <span className="size-1.5 rounded-full bg-current" aria-hidden />
                {story.flag.text}
              </p>
            )}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            {story && (
              <div className="space-y-5">
                <section>
                  <h3 className="label mb-1.5">What this means</h3>
                  <p className="text-[15px] leading-[1.65] text-ink">{story.meaning}</p>
                </section>
                <section>
                  <h3 className="label mb-1.5">Why it matters</h3>
                  <p className="text-[14px] leading-[1.65] text-muted">{story.matters}</p>
                </section>
              </div>
            )}

            {stats.length > 0 && (
              <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-rule-soft bg-well p-4 text-xs sm:grid-cols-3">
                {stats.map((s) => (
                  <div key={s.label} className="min-w-0">
                    <dt className="text-faint">{s.label}</dt>
                    <dd className={`mt-1 truncate font-medium ${s.tone === "bad" ? "text-bad" : s.tone === "ok" ? "text-ok" : "text-ink"}`}>{s.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            <section className="mt-7">
              <h3 className="pane-title mb-3">How we know</h3>
              {story && <p className="mb-4 text-[13px] leading-[1.6] text-muted">{story.how}</p>}

              {!fact && edge && !story && (
                <p className="text-sm text-muted">
                  Orion works this connection out from other facts, so there is no single place it was written down.
                </p>
              )}
              {fact && res.loading && !res.data && (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Spinner /> Finding where this was written down
                </p>
              )}
              {fact && res.error && <ErrorNote error={res.error} onRetry={res.reload} />}
              {fact && res.data && !sources.length && (
                <p className="text-sm text-muted">
                  It came from an official list (of systems, or the org chart) rather than from a message or a document,
                  so there is no sentence to point at.
                </p>
              )}

              {sources.length > 0 && (
                <p className="mb-3 text-[11px] text-faint">
                  {sources.length === 1 ? "Where it was written down" : `Written down in ${sources.length} places`}
                </p>
              )}
              <ol className="space-y-4">
                {sources.map((s) => (
                  <li key={s.source_uid} className="appear overflow-hidden rounded-xl border border-rule bg-well">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-rule-soft px-4 py-2.5 text-xs">
                      <span className="font-semibold text-ink">{KIND_LABEL[s.kind ?? ""] ?? s.kind ?? "Source"}</span>
                      {s.title && <span className="text-muted">{s.title}</span>}
                      <span className="ml-auto text-muted">{fmtDate(s.at, true)}</span>
                    </div>
                    <blockquote cite={s.url ?? undefined} className="px-4 py-4 text-[14px] leading-[1.7] text-muted">
                      <Quote src={s} />
                    </blockquote>
                    <div className="flex items-center gap-3 border-t border-rule-soft px-4 py-2 text-xs">
                      <span className="text-muted">
                        by <span className="font-medium text-ink">{s.author ?? "unknown"}</span>
                      </span>
                      {s.url && (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mono ml-auto truncate text-[11px] text-ember hover:underline"
                          title={s.url}
                        >
                          {s.url.replace(/^https?:\/\//, "")}
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            {evidence && (
              <details className="mt-6 text-xs">
                <summary className="cursor-pointer text-faint hover:text-muted">
                  Technical details (the lookup behind this, {fmtMs(res.data?.ms)}, {graphWords(evidence.graph)})
                </summary>
                <pre tabIndex={0} className="mt-2 overflow-x-auto rounded-lg border border-rule bg-well p-3 text-[11px] leading-relaxed text-muted">
                  <code>{evidence.cypher}</code>
                </pre>
                {fact && <p className="mono mt-2 truncate text-[11px] text-faint">record {fact}</p>}
              </details>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}


/** One end of the connection: a coloured dot, the name, and what kind of thing it is. */
function End({ node, name }: { node?: GNode; name?: string | null }) {
  return (
    <div className="flex min-w-0 max-w-[42%] items-center gap-2 rounded-lg border border-rule bg-raised px-2.5 py-1.5">
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ background: node ? NODE_COLORS[node.type] : C.muted }}
      />
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-medium text-ink">{node ? nameOf(node) : name ?? "?"}</span>
        {node && <span className="block truncate text-[11px] text-faint">{nounOf(node)}</span>}
      </span>
    </div>
  );
}
