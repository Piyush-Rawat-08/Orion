"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import { Suspense, useEffect, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { AffectedGraph, ApproversBlock, BrokenBlock, CustomersBlock, PeopleBlock, RiskBlock, StructureBlock } from "@/components/multiverse/DiffPanel";
import UniverseList from "@/components/multiverse/UniverseList";
import { EASE } from "@/components/motion";
import { Handle, Pane, Split, useMedia } from "@/components/Split";
import { Empty, ErrorNote, Spinner, UniverseTag } from "@/components/ui";
import { ApiError, post } from "@/lib/api";
import { useFetch } from "@/lib/hooks";
import { fmtDate, plural } from "@/lib/format";
import { C, universeAccent } from "@/lib/theme";
import { hopsWord, kindWord, opWords, scenarioLabel, tierWord } from "@/lib/words";
import type { ApproveResult, Diff, MergeBlockedDetail, MergeResult, Op, RebaseNeeded, Universe, UniverseDetail } from "@/lib/types";

type Line = { sign: "+" | "~" | "-" | "!"; text: string; note?: string };

/** What a change does, as a sign (adds, changes, removes) and a sentence. */
function opLine(o: Op): Line {
  const a = (k: string) => String(o[k] ?? "?");
  switch (o.op) {
    case "create_ticket":
      return { sign: "+", text: opWords(o), note: `priority ${o.priority ?? "P3"}` };
    case "add_dependency":
      return { sign: "+", text: opWords(o) };
    case "reassign_owner":
    case "move_person":
    case "merge_teams":
      return { sign: "~", text: opWords(o) };
    case "reverse_decision":
      return { sign: "~", text: opWords(o), note: `${a("decision")} was accepted` };
    case "deprecate_service":
    case "remove_person":
    case "remove_dependency":
      return { sign: "-", text: opWords(o) };
    default:
      return { sign: "~", text: opWords(o) };
  }
}

const signColor = (s: string) => (s === "+" ? C.added : s === "~" ? C.partial : C.bad);
const SIGN_WORD = { "+": "adds", "~": "changes", "-": "removes", "!": "affects" } as const;

function effects(diff: Diff | null): Line[] {
  if (!diff) return [];
  return [
    ...diff.broken.map((b) => ({
      sign: "!" as const,
      text: `${b.service} stops working`,
      note: `${tierWord(b.tier)}, ${hopsWord(b.hops)} from ${b.because_of}${b.via_undeclared.length ? ", through a connection nobody wrote down" : ""}`,
    })),
    ...diff.new_orphans.map((o) => ({ sign: "!" as const, text: `nobody left would know ${o.service}`, note: tierWord(o.tier) })),
    ...diff.collaboration_splits.map((s) => ({ sign: "!" as const, text: "a group that works together splits up", note: s.groups.map((g) => g.slice(0, 3).join(", ")).join(" | ") })),
    ...(diff.customers ?? []).map((c) => ({ sign: "!" as const, text: `${c.customer} would notice`, note: `uses ${c.services.slice(0, 3).join(", ")}` })),
  ];
}

/** The sign of a line, drawn: a plus, a tilde, a minus or a warning mark, in its colour. */
function Sign({ sign }: { sign: Line["sign"] }) {
  const c = sign === "!" ? C.bad : signColor(sign);
  return (
    <span className="mt-[3px] grid size-[16px] shrink-0 place-items-center rounded-full" style={{ background: `${c}1f`, color: c }} aria-label={SIGN_WORD[sign]}>
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
        {sign === "+" && <path d="M4 1v6M1 4h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
        {sign === "-" && <path d="M1 4h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
        {sign === "~" && <path d="M1 4.6c1-1.6 2-1.6 3 0s2 1.6 3 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
        {sign === "!" && <path d="M4 1.2v3.4M4 6.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      </svg>
    </span>
  );
}

function Plan({ d, children }: { d: UniverseDetail; children?: React.ReactNode }) {
  const { personName } = useApp();
  const lines = d.ops.map(opLine);
  const req = d.required ?? [];
  const eff = effects(d.diff);
  let k = 0;
  const typed = (node: React.ReactNode, key: string) => (
    <li key={key} className="type-in flex gap-2.5" style={{ animationDelay: `${60 + k++ * 30}ms` }}>
      {node}
    </li>
  );
  const row = (l: Line, i: number, pre: string) =>
    typed(
      <>
        <Sign sign={l.sign} />
        <span className="min-w-0">
          <span className="text-ink">{l.text}</span>
          {l.note && <span className="block text-[12px] text-muted">{l.note}</span>}
        </span>
      </>,
      `${pre}${i}`,
    );
  const level = d.diff?.risk.level;
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-rule bg-panel shadow-deep">
      <div className="flex min-w-0 items-center gap-2 border-b border-rule px-4 py-2.5 text-[12px] text-muted sm:px-5">
        <span className="font-medium text-ink">The plan</span>
        <span className="truncate">tested on a copy of the company · nothing real has changed yet</span>
        <span className="ml-auto hidden shrink-0 sm:inline">{fmtDate(d.created_at)}</span>
      </div>
      <div className="space-y-5 px-4 py-4 text-[13px] leading-snug sm:px-5">
        <section>
          <h3 className="label mb-2">What would change</h3>
          <ul className="space-y-2">{lines.map((l, i) => row(l, i, "op"))}</ul>
        </section>
        {eff.length > 0 && (
          <section>
            <h3 className="label mb-2">What it would affect</h3>
            <ul className="space-y-2">{eff.map((l, i) => row(l, i, "ef"))}</ul>
          </section>
        )}
        {d.diff && (
          <p className="type-in border-t border-rule-soft pt-3 text-[13px]" style={{ animationDelay: `${60 + k++ * 30}ms` }}>
            <span className="font-semibold" style={{ color: level === "high" ? C.bad : level === "medium" ? C.partial : C.verified }}>
              Risk {d.diff.risk.score} out of 100 ({level})
            </span>
            <span className="text-muted">
              {eff.length ? `: ${plural(d.diff.broken.length, "system stops", "systems stop")} working, ${plural(d.diff.customers?.length ?? 0, "customer")} affected.` : ": nothing breaks."}
            </span>
          </p>
        )}
        {req.length > 0 && (
          <section>
            <h3 className="label mb-2">Who has to agree</h3>
            <ul className="space-y-1.5">
              {req.map((r, i) => {
                const by = r.approved_by ?? [];
                return typed(
                  <>
                    <span
                      className={`mt-[2px] grid size-[16px] shrink-0 place-items-center rounded-full border ${by.length ? "border-ok bg-ok/15 text-ok" : "border-rule-strong text-transparent"}`}
                      aria-label={by.length ? "approved" : "waiting"}
                    >
                      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden><path d="M1.5 4.2l1.6 1.6 3.4-3.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </span>
                    <span>
                      <span className="text-ink">{r.team}</span>
                      <span className="text-muted"> · {by.length ? `approved by ${by.map(personName).join(", ")}` : "waiting"}</span>
                    </span>
                  </>,
                  `ap${i}`,
                );
              })}
            </ul>
          </section>
        )}
      </div>
      {children && <div className="border-t border-rule bg-well/50">{children}</div>}
    </div>
  );
}

/** A branch curving back into the trunk, drawn on approval. */
function MergeArt({ color }: { color: string }) {
  return (
    <svg width="120" height="64" viewBox="0 0 120 64" fill="none" aria-hidden>
      <path d="M10 56 H110" stroke="var(--color-ink)" strokeOpacity="0.35" strokeWidth="1.5" />
      <motion.path
        d="M18 56 C 30 56, 30 16, 50 16 H 70 C 90 16, 90 56, 102 56"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.3, ease: EASE }}
      />
      <circle cx="18" cy="56" r="3.5" fill="var(--color-ink)" />
      <motion.circle
        cx="102"
        cy="56"
        r="4.5"
        fill={color}
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.28, duration: 0.16, ease: "easeOut" }}
      />
    </svg>
  );
}

function Rebase({ r }: { r: RebaseNeeded }) {
  const router = useRouter();
  const col = (title: string, risk: number, level: string, broken: string[], gone: string[], added: string[]) => (
    <div className="min-w-0 rounded-lg border border-rule bg-well p-3">
      <p className="label">{title}</p>
      <p className="heading mt-1 text-[28px] leading-none" style={{ color: level === "high" ? C.bad : level === "medium" ? C.partial : C.verified }}>
        {risk}
      </p>
      <ul className="mt-2 space-y-0.5 text-xs">
        {broken.map((b) => (
          <li key={b} className={gone.includes(b) ? "text-faint line-through" : added.includes(b) ? "text-bad" : "text-ink"}>
            {b}
          </li>
        ))}
        {broken.length === 0 && <li className="text-muted">nothing breaks</li>}
      </ul>
    </div>
  );
  return (
    <div className="appear space-y-3 bg-warn/[0.05] p-5 text-sm">
      <p className="text-[15px] font-semibold leading-snug">The company has changed since this was tested.</p>
      <p className="text-muted">
        Before applying it, Orion tested the same plan again on today&rsquo;s company. The result is different, so
        it needs another look: the risk went from {r.risk.before} to {r.risk.after}.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {col("When it was first tested", r.risk.before, r.risk.level_before, r.broken.before, r.broken.no_longer, [])}
        {col("Today", r.risk.after, r.risk.level_after, r.broken.after, [], r.broken.newly)}
      </div>
      {r.broken.no_longer.length > 0 && (
        <p className="text-xs text-muted">No longer breaks: {r.broken.no_longer.join(", ")}.</p>
      )}
      <button type="button" className="btn btn-primary" onClick={() => router.replace(`/review?u=${r.to}`, { scroll: false })}>
        Review the updated plan ({scenarioLabel(r.to)})
      </button>
    </div>
  );
}

function Decide({ d, onDone }: { d: UniverseDetail; onDone: () => void }) {
  const { user, personName, refreshTenant } = useApp();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | "force" | null>(null);
  const [merged, setMerged] = useState<MergeResult | null>(null);
  const [waiting, setWaiting] = useState<Extract<ApproveResult, { status: "waiting" }> | null>(null);
  const [rebase, setRebase] = useState<RebaseNeeded | null>(null);
  const [blocked, setBlocked] = useState<MergeBlockedDetail | null>(null);
  const [rejected, setRejected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (kind: "approve" | "reject" | "force") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "reject") {
        await post(`/universes/${d.uid}/reject`, { note });
        setRejected(true);
      } else {
        const r = await post<ApproveResult>(`/universes/${d.uid}/approve`, { note, force: kind === "force" });
        if (r.status === "merged") setMerged(r);
        else setWaiting(r);
      }
      refreshTenant();
      onDone();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { status?: string } | undefined) : undefined;
      if (body?.status === "rebase_needed") setRebase(body as RebaseNeeded);
      else if (body?.status === "blocked") setBlocked(body as MergeBlockedDetail);
      else setError((e as Error).message);
      onDone();
    } finally {
      setBusy(null);
    }
  };

  if (rebase) return <Rebase r={rebase} />;

  if (merged)
    return (
      <div className="appear bg-ok/[0.05] p-5 text-sm">
        <MergeArt color={universeAccent(d.uid)} />
        <p className="mt-3 text-[15px] font-semibold leading-none text-ok">Approved and applied.</p>
        <p className="mt-1 text-muted">
          Every team that had to agree did. The change is now part of the company&rsquo;s records, with this approval
          recorded as the reason{merged.forced ? ", knowing that some systems relying on what it switches off will break" : ""}.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt className="text-muted">Applied on</dt>
            <dd className="mt-0.5 text-ink">{fmtDate(merged.merged_at)}</dd>
          </div>
          <div>
            <dt className="text-muted">Answers now out of date</dt>
            <dd className="mt-0.5 text-ink">
              {merged.expired_answers ?? 0}
              {(merged.expired_answers ?? 0) > 0 && <span className="text-muted"> (their askers were told in their Inbox)</span>}
            </dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={`/certificate?u=${d.uid}`} className="btn btn-primary">
            Get the approval certificate
          </Link>
          <Link href="/" className="btn">
            Ask about the company now
          </Link>
        </div>
      </div>
    );

  if (rejected || d.status === "discarded")
    return (
      <div className="p-5 text-sm">
        <p className="text-[15px] font-semibold leading-none">Rejected.</p>
        <p className="mt-1 text-muted">Nothing changed in the company, and the copy it was tested on was cleared away.</p>
      </div>
    );

  if (d.status === "rebased")
    return (
      <div className="p-5 text-sm">
        <p className="text-[15px] font-semibold leading-none">Tested again.</p>
        <p className="mt-1 text-muted">The company changed after this plan was made, so it was tested again as {scenarioLabel(d.rebased_to)}.</p>
        {d.rebased_to && (
          <Link href={`/review?u=${d.rebased_to}`} className="btn mt-3">
            Open {scenarioLabel(d.rebased_to)}
          </Link>
        )}
      </div>
    );

  if (d.status === "merged")
    return (
      <div className="bg-ok/[0.05] p-5 text-sm">
        <p className="text-[15px] font-semibold leading-none text-ok">Already approved and applied.</p>
        <p className="mt-1 text-muted">
          {d.merged_by ? `${personName(d.merged_by)} approved it` : "Approved"} {d.merged_at ? `on ${fmtDate(d.merged_at)}` : ""}.
        </p>
        <Link href={`/certificate?u=${d.uid}`} className="btn mt-3">
          Approval certificate
        </Link>
      </div>
    );

  const missing = waiting?.missing ?? d.missing ?? [];
  return (
    <div className="space-y-3 p-4 sm:p-5">
      <p className="text-[15px] font-semibold leading-none">Your decision</p>
      <p className="text-xs text-muted">
        Your approval counts for every team on the list that you&rsquo;re on. The change only happens once every team
        has approved. Rejecting drops it, and nothing changes.
      </p>
      {waiting && (
        <p role="status" className="rounded-lg border border-rule bg-well p-2.5 text-xs">
          {waiting.counted_for.length ? <>Counted for {waiting.counted_for.join(", ")}. </> : <>You&rsquo;re not on a team that has to agree, so this is noted but doesn&rsquo;t count. </>}
          Still waiting for {missing.map((m) => m.team).join(", ")}.
        </p>
      )}
      {blocked && (
        <div role="alert" className="space-y-2 rounded-lg border border-bad/40 bg-bad/[0.05] p-3 text-xs">
          <p className="text-ink">{blocked.message}</p>
          <p className="text-muted">Needs moving to a replacement first: {blocked.needs_migration.join(", ")}</p>
          <button type="button" className="btn" disabled={!!busy} onClick={() => act("force")}>
            {busy === "force" && <Spinner />} Apply anyway and accept the breakage
          </button>
        </div>
      )}
      <label className="block">
        <span className="label">Note (saved with your decision)</span>
        <textarea rows={2} className="field mt-1 resize-none" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this is fine, or why not" />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary flex-1 justify-center" disabled={!!busy} onClick={() => act("approve")}>
          {busy === "approve" && <Spinner />} Approve as {personName(user)}
        </button>
        <button type="button" className="btn flex-1 justify-center" disabled={!!busy} onClick={() => act("reject")}>
          {busy === "reject" && <Spinner />} Reject
        </button>
      </div>
      <p className="text-[12px] text-muted">To approve for another team, change who you&rsquo;re viewing as in the top bar.</p>
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}
    </div>
  );
}

function Review() {
  const params = useSearchParams();
  const router = useRouter();
  const { personName } = useApp();
  const selected = params.get("u");
  const list = useFetch<Universe[]>("/universes");
  const detail = useFetch<UniverseDetail>(selected ? `/universes/${selected}` : null);
  const d = detail.data && detail.data.uid === selected ? detail.data : null;

  const universes = list.data ?? [];
  const dry = universes.filter((u) => u.kind === "dryrun");
  const whatif = universes.filter((u) => u.kind !== "dryrun");
  const select = (uid: string) => router.replace(`/review?u=${uid}`, { scroll: false });
  const wide = useMedia("(min-width: 1024px)");
  // open on the plan that is waiting for someone, rather than an empty pane
  const waitingUid = [...dry]
    .filter((u) => u.status === "open")
    .sort((a, b) => Number(b.uid.slice(1)) - Number(a.uid.slice(1)))[0]?.uid;
  useEffect(() => {
    if (!selected && waitingUid) router.replace(`/review?u=${waitingUid}`, { scroll: false });
  }, [selected, waitingUid, router]);

  return (
    <Split id="review" vertical={!wide}>
      <Pane id="list" defaultSize={wide ? 320 : "35"} minSize={wide ? 260 : 160} maxSize={wide ? 520 : undefined}>
      <aside className="h-full min-h-0 overflow-y-auto px-2 py-3">
        <p className="pane-title mb-1 px-2">Waiting for approval</p>
        {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
        {list.data && (
          <>
            {dry.length ? (
              <UniverseList universes={dry} selected={selected} onSelect={select} />
            ) : (
              <p className="px-2 pb-2 text-[12px] leading-relaxed text-muted">
                Nothing is waiting. Ask the assistant to do something (&ldquo;open a task to move invoice-render off
                sso-legacy&rdquo;) and its plan lands here, or create a what-if and choose &ldquo;Ask for approval&rdquo;.
              </p>
            )}
            <p className="pane-title mb-1 mt-6 px-2">What-ifs you could also approve</p>
            <UniverseList universes={whatif} selected={selected} onSelect={select} />
          </>
        )}
      </aside>
      </Pane>
      <Handle label="Resize the list" />
      <Pane id="plan" minSize={wide ? 480 : 240}>
      <section className="h-full min-h-0 overflow-y-auto">
        {!selected ? (
          <div className="grid h-full place-items-center p-8">
            <Empty
              title="Every change starts as a plan you approve."
              art={
                <ul className="space-y-2 text-[13px] text-ink">
                  <li className="flex gap-2.5"><Sign sign="+" /> Open a task: &ldquo;move invoice-render to identity&rdquo;</li>
                  <li className="flex gap-2.5"><Sign sign="~" /> Make Platform responsible for alert-router</li>
                  <li className="flex gap-2.5"><Sign sign="-" /> Switch off sso-legacy</li>
                </ul>
              }
            >
              The assistant never changes the company&rsquo;s records on its own. It tests each change on a copy of the
              company first; you read what it would affect, and the teams responsible approve or reject it.
            </Empty>
          </div>
        ) : !d ? (
          <div className="p-6">
            {detail.error ? <ErrorNote error={detail.error} onRetry={detail.reload} /> : <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading the plan</p>}
          </div>
        ) : (
          <div className="mx-auto grid max-w-[1240px] grid-cols-[minmax(0,1fr)] gap-8 px-4 py-5 sm:px-6 sm:py-6 2xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-5">
              <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <UniverseTag uid={d.uid} />
                <h2 className="heading min-w-0 text-[28px] leading-[1.05] sm:text-[28px]">{d.title}</h2>
                <span className="text-xs text-muted">
                  {kindWord(d.kind)} from{" "}
                  {d.created_by.startsWith("person:") ? personName(d.created_by) : "the assistant"}
                </span>
                <span className="flex flex-wrap gap-2 sm:ml-auto">
                  <Link href={`/multiverse?u=${d.uid}`} className="btn">
                    See it on the map
                  </Link>
                </span>
              </header>
              <Plan d={d}>
                <Decide key={d.uid} d={d} onDone={() => { list.reload(); detail.reload(); }} />
              </Plan>
              {d.diff && (
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 rounded-xl border border-rule bg-panel p-4 sm:p-5 md:grid-cols-2">
                  {d.diff.broken.length > 0 && (
                    <div className="md:col-span-2">
                      <AffectedGraph diff={d.diff} />
                    </div>
                  )}
                  <BrokenBlock diff={d.diff} />
                  <CustomersBlock diff={d.diff} />
                  <StructureBlock diff={d.diff} />
                  <div className="md:col-span-2">
                    <PeopleBlock diff={d.diff} />
                  </div>
                </div>
              )}
              {d.diff && d.diff.evidence.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs text-faint hover:text-muted">Technical details: the lookups behind these results</summary>
                  <ul className="mt-2 space-y-1.5">
                    {d.diff.evidence.map((e) => (
                      <li key={e.eid}>
                        <details className="overflow-hidden rounded-lg border border-rule bg-panel">
                          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs">
                            <span className="mono shrink-0 text-ember">{e.eid}</span>
                            <span className="truncate text-muted">{e.summary}</span>
                            <span className="mono ml-auto shrink-0 text-faint">{e.graph}</span>
                          </summary>
                          <pre tabIndex={0} className="overflow-x-auto border-t border-rule-soft p-3 text-[11px] leading-relaxed text-muted">
                            <code>{e.cypher}</code>
                          </pre>
                        </details>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <aside className="space-y-5">
              {d.diff && (
                <div className="rounded-xl border border-rule bg-panel p-5">
                  <RiskBlock diff={d.diff} />
                </div>
              )}
              {d.diff && (
                <div className="rounded-xl border border-rule bg-panel p-5">
                  <ApproversBlock diff={{ ...d.diff, required_approvers: d.required }} />
                </div>
              )}
              {d.approvals.length > 0 && (
                <div className="text-xs">
                  <p className="pane-title mb-2">Decisions so far</p>
                  <ul className="space-y-1">
                    {d.approvals.map((a, i) => (
                      <li key={i} className={a.verdict === "approved" ? "text-ok" : "text-bad"}>
                        {personName(a.by)} {a.verdict}
                        {a.team ? ` for ${a.team}` : ""} on {fmtDate(a.at)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
          </div>
        )}
      </section>
      </Pane>
    </Split>
  );
}

export default function ReviewPage() {
  return (
    <Suspense>
      <Review />
    </Suspense>
  );
}
