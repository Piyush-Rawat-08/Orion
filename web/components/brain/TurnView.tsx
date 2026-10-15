"use client";

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, type Step, type Turn } from "../AppProvider";
import { EASE } from "../motion";
import BlastRadius from "../multiverse/BlastRadius";
import { Spinner, UniverseTag, VerdictMark } from "../ui";
import { useFetch } from "@/lib/hooks";
import { fmtDate, fmtMs, plural } from "@/lib/format";
import { C, riskColor, universeAccent, VERDICT_COLORS } from "@/lib/theme";
import type { Claim, ClaimCheck, Evidence, GraphUse, SummaryCheck, UniverseDetail, Verdict } from "@/lib/types";
import { TimeScrubber, WatchButton, type Dated } from "./AnswerTools";
import { AGENT_WORD, CHECK_LONG, CHECK_SHORT, checkReason, factWords, scenarioLabel, statusWords, toolWords } from "@/lib/words";

function StepRow({ s }: { s: Step }) {
  if (s.kind === "tool") {
    const failed = s.ok === false;
    return (
      <li className={`relative flex items-center gap-2.5 rounded py-[3px] pl-1 pr-2 text-[12px] ${s.pending ? "scanning" : ""}`}>
        <span
          className="absolute -left-[15.5px] top-1/2 size-[7px] -translate-y-1/2 rounded-full border"
          style={{
            borderColor: failed ? C.bad : s.pending ? C.ember : C.retired,
            background: s.pending ? C.ember : failed ? C.bad : C.panel,
          }}
          aria-hidden
        />
        <span className={`min-w-0 flex-1 truncate ${failed ? "text-bad" : "text-ink"}`} title={toolWords(s.tool, s.args)}>
          {toolWords(s.tool, s.args)}
        </span>
        <span className="shrink-0 text-[11px] text-faint">
          {s.pending ? <Spinner size={11} className="text-ember" /> : failed ? "didn't work" : null}
        </span>
      </li>
    );
  }
  if (s.kind === "thinking")
    return (
      <li className="py-[3px] pl-1 pr-2 text-[11px]">
        <details>
          <summary className="cursor-pointer text-muted hover:text-ink">How it reasoned</summary>
          <p className="mt-1 whitespace-pre-wrap leading-relaxed text-muted">{s.text}</p>
        </details>
      </li>
    );
  if (s.kind === "narration") return <li className="py-1 pl-1 pr-2 text-[12px] leading-relaxed text-muted">{s.text}</li>;
  if (s.kind === "status")
    return (
      <li className="py-[3px] pl-1 pr-2 text-[11px] text-faint">
        <span className="font-medium text-muted">{AGENT_WORD[s.agent] ?? s.agent}:</span> {statusWords(s.agent, s.text)}
      </li>
    );
  return <li className="py-[3px] pl-1 pr-2 text-[11px] text-bad">{s.text}</li>;
}

function Trace({ turn }: { turn: Turn }) {
  const streaming = turn.status === "streaming";
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? streaming;
  const tools = turn.steps.filter((s) => s.kind === "tool") as Extract<Step, { kind: "tool" }>[];
  if (!turn.steps.length && streaming)
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <Spinner size={12} className="text-ember" /> Starting
      </p>
    );
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="flex items-center gap-2 text-[12px] text-muted transition-colors hover:text-ink"
      >
        <svg width="9" height="9" viewBox="0 0 10 10" className={`transition-transform duration-300 ${expanded ? "rotate-90" : ""}`} aria-hidden>
          <path d="M3 1.5L7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        {streaming ? `Working: ${plural(tools.length, "step")} so far` : `How it found this: ${plural(tools.length, "step")}`}
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.ol
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="ml-[4px] mt-2 overflow-hidden border-l border-rule pl-3"
          >
            {turn.steps.map((s) => (
              <StepRow key={s.id} s={s} />
            ))}
          </motion.ol>
        )}
      </AnimatePresence>
    </div>
  );
}

/** One glance at how much of the answer survived verification. */
function VerdictBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  const order = ["verified", "partial", "unsupported", "contradicted", "unverified"] as const;
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-[5px] flex-1 gap-[2px] overflow-hidden rounded-full" aria-hidden>
        {order
          .filter((v) => counts[v])
          .map((v, i) => (
            <motion.span
              key={v}
              className="h-full rounded-full"
              style={{ background: VERDICT_COLORS[v] }}
              initial={{ flexGrow: 0 }}
              animate={{ flexGrow: counts[v] }}
              transition={{ duration: 0.3, ease: "easeOut", delay: i * 0.03 }}
            />
          ))}
      </div>
      <p className="flex shrink-0 gap-2.5 text-[12px]">
        {order
          .filter((v) => counts[v])
          .map((v) => (
            <span key={v} style={{ color: VERDICT_COLORS[v] }}>
              {counts[v]} {CHECK_SHORT[v]}
            </span>
          ))}
        <span className="text-faint">of {total}</span>
      </p>
    </div>
  );
}

/** For engineers: the lookup that checked a point, and what it returned. */
function Receipt({ check }: { check: ClaimCheck }) {
  const result = JSON.stringify(check.result, null, 1);
  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-well">
      <p className="flex items-center gap-2 px-2.5 py-1.5">
        <span className="mono text-ember">{check.query}</span>
        <span className="text-muted">returned</span>
        <span className="mono ml-auto shrink-0 text-[11px] text-faint">{check.graph}</span>
      </p>
      <pre tabIndex={0} className="max-h-40 overflow-auto border-t border-rule px-3 py-2 text-[11px] leading-relaxed text-ink">
        <code>{result.length > 1600 ? result.slice(0, 1600) + "\n…" : result}</code>
      </pre>
      <pre tabIndex={0} className="overflow-x-auto border-t border-rule px-3 py-2.5 text-[11px] leading-relaxed text-muted">
        <code>{check.cypher}</code>
      </pre>
    </div>
  );
}

/** How a claim's text reads for its verdict: red and struck through only when it is now false. */
function claimText(v: Verdict): string {
  if (v === "contradicted") return "text-bad line-through decoration-bad/70";
  if (v === "unsupported" || v === "unverified" || v === "not_checked")
    return "text-muted underline decoration-dashed decoration-[color:var(--color-warn)] decoration-1 underline-offset-[5px]";
  if (v === "expired") return "text-muted";
  return "text-ink";
}

function ClaimRow({
  claim,
  i,
  turn,
  evidence,
  dated,
}: {
  claim: Claim;
  i: number;
  turn: Turn;
  evidence: Map<string, Evidence>;
  /** set while "Was this true on…?" shows another day: the point's mark on that day */
  dated?: { date: string; verdict: Verdict; reason: string; flipped: boolean };
}) {
  const { hoverHighlight, hoverEnd, pinHighlight, highlight, openBlame } = useApp();
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const live = turn.verdicts[i];
  const verdict: Verdict = dated?.verdict ?? live?.verdict ?? claim.verdict;
  const pending = turn.status === "streaming" && !live;
  const reason = dated?.reason ?? live?.reason ?? claim.reason;
  const key = `${turn.id}:${i}`;
  const color = VERDICT_COLORS[verdict] === C.muted ? C.trunk : VERDICT_COLORS[verdict];
  const pinned = highlight?.pinned && highlight.key === key;
  const nodes = claim.nodes ?? [];
  const weak = verdict === "unsupported" || verdict === "unverified" || verdict === "not_checked";

  return (
    <motion.li
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE, delay: i < 6 ? i * 0.03 : 0.18 }}
      className={`group relative border-b border-rule-soft transition-colors duration-200 last:border-b-0 ${pinned ? "bg-raised" : "hover:bg-raised/60"}`}
      onMouseEnter={() => nodes.length && hoverHighlight(key, nodes, color)}
      onMouseLeave={hoverEnd}
    >
      {pinned && <span className="absolute inset-y-0 left-0 w-[2px] bg-ember" aria-hidden />}
      <button
        type="button"
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (nodes.length) pinHighlight(key, nodes, color);
        }}
        onFocus={() => nodes.length && hoverHighlight(key, nodes, color)}
        onBlur={hoverEnd}
      >
        <span className="mt-[2px] grid size-[14px] shrink-0 place-items-center">
          {pending ? (
            <Spinner size={12} className="text-faint" />
          ) : (
            // the receipt arriving: each mark settles in, in claim order
            <motion.span
              key={verdict}
              className={`grid place-items-center ${dated?.flipped ? "beat rounded-full" : ""}`}
              initial={reduce ? false : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.16, ease: EASE, delay: Math.min(i, 8) * 0.04 }}
            >
              <VerdictMark verdict={verdict} />
            </motion.span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-[13px] leading-[1.5] ${claimText(verdict)}`}>{claim.text}</span>
          {reason && !pending && (
            <span className="mt-0.5 block text-[12px] leading-snug text-muted">
              <span style={{ color: weak ? C.partial : VERDICT_COLORS[verdict] }}>
                {CHECK_SHORT[verdict]}
                {dated ? ` on ${fmtDate(dated.date)}` : ""}
              </span>
              {": "}
              {checkReason(reason)}
            </span>
          )}
          {verdict === "contradicted" && claim.facts[0] && (
            <span className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-muted">
              what changed:
              <span className="rounded border border-bad/40 px-1.5 py-px text-[11px] text-bad">{factWords(claim.facts[0])}</span>
            </span>
          )}
        </span>
        {weak ? (
          <span className="mt-[3px] shrink-0 text-[11px]" style={{ color: C.partial }}>
            {CHECK_SHORT[verdict]}
          </span>
        ) : (
          nodes.length > 0 && (
            <span className="mt-[3px] shrink-0 text-[11px] text-faint opacity-70 transition-opacity group-hover:opacity-100" title="Hover to see it on the map">
              on the map
            </span>
          )
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="space-y-2.5 px-3 pb-3 pl-[39px] text-xs">
              <p style={{ color: VERDICT_COLORS[verdict] }}>
                <span className="font-semibold">{CHECK_LONG[verdict]}</span>
              </p>
              {claim.evidence.some((eid) => evidence.get(eid)?.summary) && (
                <div>
                  <p className="text-muted">Based on</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink marker:text-faint">
                    {[...new Set(claim.evidence.map((eid) => evidence.get(eid)?.summary).filter(Boolean))].map((sm) => (
                      <li key={sm}>{sm}</li>
                    ))}
                  </ul>
                </div>
              )}
              {claim.facts.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted">Records it relies on</span>
                  {claim.facts.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => openBlame({ fact: f })}
                      className="rounded border border-rule px-1.5 py-0.5 text-[11px] text-ink transition-colors hover:border-ember/60 hover:text-ember"
                      title="See where this was written down"
                    >
                      {factWords(f)}
                    </button>
                  ))}
                </div>
              )}
              {((live?.check ?? claim.check) || claim.evidence.length > 0) && (
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-faint hover:text-muted">Technical details</summary>
                  <div className="mt-2 space-y-2">
                    {(live?.check ?? claim.check) && <Receipt check={(live?.check ?? claim.check)!} />}
                    {claim.evidence.map((eid) => {
                      const ev = evidence.get(eid);
                      return ev ? (
                        <div key={eid} className="overflow-hidden rounded-lg border border-rule bg-well">
                          <p className="flex items-center gap-2 px-2.5 py-1.5">
                            <span className="mono text-ember">{eid}</span>
                            <span className="mono ml-auto shrink-0 text-[11px] text-faint">{ev.graph}</span>
                          </p>
                          <pre tabIndex={0} className="overflow-x-auto border-t border-rule px-3 py-2.5 text-[11px] leading-relaxed text-muted">
                            <code>{ev.cypher}</code>
                          </pre>
                        </div>
                      ) : null;
                    })}
                  </div>
                </details>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

/** The what-if, as the headline of the answer: its risk, what breaks, who is exposed, and how it spreads. */
function ForkCard({ uid, dry }: { uid: string; dry: boolean }) {
  const d = useFetch<UniverseDetail>(`/universes/${uid}`);
  const diff = d.data?.diff;
  const c = universeAccent(uid);
  const href = dry ? `/review?u=${uid}` : `/multiverse?u=${uid}`;
  const facts = diff
    ? [
        ...(() => {
          const stop = diff.broken.filter((b) => (b.effect ?? "break") === "break").length;
          const slow = diff.broken.length - stop;
          return [plural(stop, "system stops working", "systems stop working")].concat(
            slow ? [plural(slow, "slows down or goes stale", "slow down or go stale")] : [],
          );
        })(),
        plural(diff.customers?.length ?? 0, "customer would notice", "customers would notice"),
        plural(diff.required_approvers?.length ?? 0, "team has to agree", "teams have to agree"),
      ]
    : [];
  return (
    <Link
      href={href}
      className="@container group relative flex min-h-[72px] items-center gap-4 overflow-hidden rounded-xl border border-rule bg-panel px-4 py-3 transition-colors hover:border-rule-strong hover:bg-raised"
      aria-label={`${dry ? "Proposed change" : "What-if"} ${scenarioLabel(uid)}${diff ? `: risk ${diff.risk.score} out of 100, ${facts.join(", ")}` : ""}. Open it.`}
    >
      <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: c }} aria-hidden />
      {diff ? (
        <span className="heading w-[2.6ch] shrink-0 text-right text-[28px] leading-none tnum" style={{ color: riskColor(diff.risk.level) }}>
          {diff.risk.score}
        </span>
      ) : (
        <Spinner className="text-faint" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <UniverseTag uid={uid} />
          <span className="truncate text-[12px] text-muted">
            {dry ? "Proposed change, waiting for approval" : "Tested on a copy of the company"}
            {diff ? ` · ${diff.risk.level} risk` : ""}
          </span>
        </span>
        {diff && <span className="mt-1 block text-[13px] leading-snug text-ink">{facts.join(" · ")}</span>}
        {d.error && <span className="mt-1 block text-[12px] text-muted">This what-if has been closed: it was applied or rejected.</span>}
      </span>
      {diff && diff.broken.length > 0 && (
        <span className="hidden w-[120px] shrink-0 overflow-hidden @[480px]:block" aria-hidden>
          <BlastRadius diff={diff} size="mini" />
        </span>
      )}
      <span className="shrink-0 text-[12px] text-ink transition-transform duration-200 group-hover:translate-x-0.5">{dry ? "Review" : "See details"}</span>
    </Link>
  );
}

/** What each kind of graph is, for the line under an answer. */
const GRAPH_ROLE: [string, string][] = [
  ["org:", "the company: people, systems, decisions, customers, and every answer and claim"],
  ["epoch:", "the company as of one date, pruned to what was true then"],
  ["universe:", "a what-if: a full copy of the company with the change applied"],
  ["deck:", "the what-ifs and the agents' shared task board"],
  ["mem:", "the asker's memory"],
];
const graphRole = (g: string) => GRAPH_ROLE.find(([p]) => g.startsWith(p))?.[1] ?? "";
const graphOrder = (g: string) => {
  const i = GRAPH_ROLE.findIndex(([p]) => g.startsWith(p));
  return i < 0 ? 9 : i;
};

/** The work FalkorDB did for an answer: the graphs it read, how many queries, how long they took in the database. */
function GraphWork({ work, total }: { work: GraphUse; total?: number }) {
  const graphs = [...work.graphs].sort((a, b) => graphOrder(a) - graphOrder(b) || a.localeCompare(b));
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-rule-soft pt-3 text-[11px] text-faint">
      <span className="flex items-center gap-1.5 text-muted">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
          <circle cx="3.9" cy="11.6" r="1.7" />
          <circle cx="12" cy="4.2" r="1.7" />
          <circle cx="12.4" cy="12.4" r="1.4" />
          <path d="M5.3 10.4l5.4-5M5.6 11.9h5.4M12.1 5.9l.2 5.1" />
        </svg>
        FalkorDB
      </span>
      {graphs.map((g) => (
        <span key={g} className="mono rounded border border-rule bg-well px-1.5 py-[1px] text-[11px] text-muted" title={graphRole(g)}>
          {g}
        </span>
      ))}
      <span className="tnum">
        {plural(work.queries, "query", "queries")}
        {work.copies > 0 && ` · ${plural(work.copies, "graph copy", "graph copies")}`} · {fmtMs(work.ms)} in the database
        {total ? ` · answered in ${fmtMs(total)}` : ""}
      </span>
    </div>
  );
}

/** Under the headline: whether everything it says is backed by a point the graph verified, and if not, what isn't. */
function SummaryLine({ check }: { check: SummaryCheck }) {
  return (
    <p className={`-mt-1 flex items-start gap-1.5 text-[12px] leading-relaxed ${check.covered ? "text-muted" : "text-warn"}`}>
      <svg width="12" height="12" viewBox="0 0 12 12" className={`mt-[3px] shrink-0 ${check.covered ? "text-ok" : "text-warn"}`} aria-hidden>
        {check.covered ? (
          <path d="M2.5 6.2 5 8.6l4.6-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M6 2.2v4.6M6 9.2v.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        )}
      </svg>
      <span>
        {check.covered
          ? "Every name, number and effect in this summary is in a point the graph verified below."
          : `Not checked: this summary ${check.issues.join("; ")}.`}
      </span>
    </p>
  );
}

export default function TurnView({ turn, latest = false }: { turn: Turn; latest?: boolean }) {
  const { ask, asking, personName, llm, highlight, pinHighlight, staleAnswers } = useApp();
  const evidence = useMemo(() => new Map((turn.result?.evidence ?? []).map((e) => [e.eid, e])), [turn.result]);
  const claims = turn.result?.claims ?? turn.answer?.claims ?? [];
  const summary = turn.result?.summary ?? turn.answer?.summary;
  const summaryCheck = turn.result?.summary_check ?? turn.answer?.summary_check;
  const followUps = turn.result?.follow_ups ?? turn.answer?.follow_ups ?? [];

  const universes = useMemo(() => {
    const out: { uid: string; dry: boolean }[] = [];
    for (const call of turn.result?.universes ?? []) {
      for (const eid of call.evidence) {
        const m = /^universe:[^:]+:(u\d+)$/.exec(evidence.get(eid)?.graph ?? "");
        if (m && !out.some((u) => u.uid === m[1])) out.push({ uid: m[1], dry: call.tool === "dry_run" });
      }
    }
    return out;
  }, [turn.result, evidence]);

  // the map becomes the answer: when it lands, everything the answer cites is pinned (the rest of the map fades
  // back and the camera flies to it); hovering a point then lights just that point's things
  const pinnedOnce = useRef(false);
  useEffect(() => {
    if (!latest || pinnedOnce.current || turn.status !== "done" || turn.restored) return;
    const cited = [...new Set(claims.flatMap((c) => c.nodes ?? []))];
    if (!cited.length) return;
    pinnedOnce.current = true;
    if (highlight?.pinned) return;
    pinHighlight(`${turn.id}:all`, cited, C.trunk);
  }, [latest, turn.status, turn.restored, turn.id, claims, highlight, pinHighlight]);

  const [dated, setDated] = useState<Dated | null>(null);
  const answerUid = turn.result?.answer ?? turn.answer?.answer;
  // out of date: said so when it was brought back, or flagged since by the inbox (someone posted a change just now)
  const stale = (answerUid ? staleAnswers.has(answerUid) : false) || (!!turn.restored && turn.restored.status !== "fresh");
  const work = turn.result?.graph ?? turn.answer?.graph ?? null;

  const counts = claims.reduce<Record<string, number>>((a, c, i) => {
    const v = turn.verdicts[i]?.verdict ?? c.verdict;
    a[v] = (a[v] ?? 0) + 1;
    return a;
  }, {});

  return (
    <motion.article
      initial={turn.restored ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="space-y-4"
    >
      <header>
        <p className="text-[12px] text-muted">
          {personName(turn.user)} asked
          {turn.restored && (
            <>
              {" "}
              on {fmtDate(turn.restored.at)}
              <span className="text-faint"> · brought back from {personName(turn.user).split(" ")[0]}&apos;s memory</span>
            </>
          )}
        </p>
        <p className="heading mt-1 text-[20px] leading-[1.15] text-ink">{turn.question}</p>
      </header>

      <AnimatePresence initial={false}>
        {stale && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="overflow-hidden"
          >
            <Link
              href="/inbox"
              className="group flex items-start gap-2.5 rounded-xl border border-warn/35 bg-warn/[0.07] px-3.5 py-2.5 text-[13px] leading-snug"
            >
              <span className="relative mt-[5px] flex size-[7px] shrink-0" aria-hidden>
                <span className="absolute inset-0 animate-ping rounded-full bg-warn opacity-60" />
                <span className="absolute inset-0 rounded-full bg-warn" />
              </span>
              <span className="flex-1 text-ink">
                Out of date. Something this answer relied on has changed since it was given.{" "}
                <span className="text-warn underline-offset-2 group-hover:underline">See what changed</span>
              </span>
            </Link>
          </motion.div>
        )}
      </AnimatePresence>

      {!turn.restored && <Trace turn={turn} />}

      {summary && (
        <motion.p
          initial={turn.restored ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
          className="text-[14px] leading-[1.65] text-ink"
        >
          {summary}
        </motion.p>
      )}
      {summary && summaryCheck && turn.status === "done" && <SummaryLine check={summaryCheck} />}

      {universes.length > 0 && (
        <section aria-label="What-ifs" className="space-y-2">
          {universes.map((u) => (
            <ForkCard key={u.uid} uid={u.uid} dry={u.dry} />
          ))}
        </section>
      )}

      {claims.length > 0 && (
        <section aria-label="Points in the answer" className="space-y-2.5">
          <VerdictBar counts={counts} total={claims.length} />
          <ol className="overflow-hidden rounded-xl border border-rule bg-panel/60">
            {claims.map((c, i) => {
              const d = dated?.claims.get(i);
              return (
                <ClaimRow key={i} claim={c} i={i} turn={turn} evidence={evidence} dated={d && dated ? { ...d, date: dated.date } : undefined} />
              );
            })}
          </ol>
          {answerUid && turn.status === "done" && (
            <div className="flex flex-wrap items-start gap-2">
              <div className={dated ? "w-full" : ""}>
                <TimeScrubber answer={answerUid} onDated={setDated} />
              </div>
              <WatchButton answer={answerUid} />
            </div>
          )}
          <p className="text-[12px] text-muted">
            <span className="hidden sm:inline">Hover a point to see it on the map. Click it to see what it is based on.</span>
            <span className="sm:hidden">Tap a point to see what it is based on.</span>
          </p>
        </section>
      )}

      {turn.status === "error" && (
        <p role="alert" className="rounded-xl border border-bad/30 bg-bad/[0.06] px-3.5 py-2.5 text-sm text-bad">
          {turn.error ?? "Something went wrong."}
        </p>
      )}

      {followUps.length > 0 && (
        <div>
          <p className="mb-1 text-[12px] text-muted">Ask next</p>
          <ul>
            {followUps.map((f) => (
              <li key={f}>
                <button
                  type="button"
                  disabled={asking || llm === false}
                  onClick={() => ask(f)}
                  className="group flex w-full items-baseline gap-2.5 border-b border-rule-soft py-2 text-left text-[13px] text-muted transition-colors last:border-0 hover:text-ink disabled:opacity-40"
                >
                  <span className="mono text-[11px] text-faint transition-colors group-hover:text-ember">?</span>
                  {f}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {work ? (
        <GraphWork work={work} total={turn.result && !turn.restored ? turn.result.ms : undefined} />
      ) : (
        turn.result &&
        !turn.result.error &&
        !turn.restored && <p className="text-[12px] text-muted">Answered in {fmtMs(turn.result.ms)}</p>
      )}
    </motion.article>
  );
}
