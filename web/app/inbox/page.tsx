"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { AgentsOff, Empty, ErrorNote, Spinner, VerdictMark } from "@/components/ui";
import { get, post } from "@/lib/api";
import { useFetch } from "@/lib/hooks";
import { postStream } from "@/lib/sse";
import { fmtDate } from "@/lib/format";
import type { AnswerDetail, AnswerRow, BeliefVersion, Message, Notification, Verdict } from "@/lib/types";
import { changeWords, CHECK_SHORT, checkReason, factWords, relWord, statusWords } from "@/lib/words";
import ReviewQueue from "@/components/ReviewQueue";

const S8 = "BILL-207 is merged: invoice-render now gets its signing token from identity. It no longer calls sso-legacy at all.";

type LogLine = { id: number; kind: string; text: string; tone: "ok" | "bad" | "warn" | "muted"; fact?: string };

function AnswerItem({ a }: { a: AnswerRow }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<AnswerDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open && !detail)
      get<AnswerDetail>(`/answers/${encodeURIComponent(a.uid)}`)
        .then(setDetail)
        .catch((e: Error) => setErr(e.message));
  }, [open, detail, a.uid]);
  const stale = a.status !== "fresh";
  return (
    <li className="border-b border-rule-soft last:border-b-0">
      <button type="button" className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/50" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${stale ? "bg-warn" : "bg-ok"}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] leading-snug text-ink">{a.question}</span>
          <span className="mt-1 flex gap-3 text-[12px] text-muted">
            <span>{fmtDate(a.at)}</span>
            <span>{a.claims} points</span>
            <span className={stale ? "text-warn" : "text-ok"}>{stale ? "out of date" : "still true"}</span>
          </span>
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3.5 pl-9 text-xs">
          {err && <p className="text-bad">{err}</p>}
          {!detail && !err && <Spinner />}
          {detail && (
            <>
              <p className="mb-2 text-[13px] leading-relaxed text-ink">{detail.summary}</p>
              <ol className="space-y-1">
                {detail.claims.map((c) => (
                  <li key={c.uid} className="flex gap-2">
                    <span className="mt-0.5">
                      <VerdictMark verdict={c.verdict} size={12} />
                    </span>
                    <span className={c.verdict === "contradicted" ? "text-bad line-through" : "text-muted"}>{c.text}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Questions this person watches: standing checks, re-run on every new record. */
function Watching() {
  const { ask, asking, llm } = useApp();
  const router = useRouter();
  const rows = useFetch<{ uid: string; question: string; at: string; status: string; checked_at: string | null; marks: Verdict[] }[]>(
    "/watching",
    10000,
  );
  const stop = async (uid: string) => {
    await post(`/answers/${encodeURIComponent(uid)}/watch`, { on: false }).catch(() => {});
    rows.reload();
  };
  if (!rows.data?.length) return null;
  return (
    <section aria-labelledby="watch-h">
      <h2 id="watch-h" className="pane-title mb-3">
        <span className="text-ink">Questions you watch</span>
      </h2>
      <ul className="overflow-hidden rounded-xl border border-rule bg-panel">
        {rows.data.map((w) => {
          const bad = w.marks.filter((m) => m === "contradicted" || m === "unsupported" || m === "expired").length;
          return (
            <li key={w.uid} className="flex items-start gap-3 border-b border-rule-soft px-4 py-3 last:border-b-0">
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${bad ? "bg-warn" : "bg-ok"}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-snug text-ink">{w.question}</span>
                <span className="mt-1 flex flex-wrap gap-3 text-[12px] text-muted">
                  <span>{w.marks.length} points</span>
                  <span className={bad ? "text-warn" : "text-ok"}>{bad ? `${bad} no longer hold` : "all still hold"}</span>
                  {w.checked_at && <span>checked {fmtDate(w.checked_at)}</span>}
                </span>
              </span>
              <span className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  className="btn btn-ghost h-7 px-2 text-[12px]"
                  disabled={asking || llm === false}
                  onClick={() => {
                    ask(w.question);
                    router.push("/");
                  }}
                >
                  Ask again
                </button>
                <button type="button" className="btn btn-ghost h-7 px-2 text-[12px]" onClick={() => stop(w.uid)}>
                  Stop watching
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A memory's key as a label: "team" -> "Team", "preferred_format" -> "Preferred format", "pref:units" -> "Units". */
function memoryLabel(key: string): string {
  const k = key.replace(/^[a-z]+:/, "").replace(/[_-]+/g, " ").trim();
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : key;
}

/** What Orion remembers about the user: current beliefs (confidence fades until confirmed again) and every
 *  earlier version, with the message it was learned from. */
function MemoryPanel({ user }: { user: string }) {
  const { personName } = useApp();
  const mem = useFetch<{ beliefs: { key: string; text: string; confidence: number }[]; belief_history: BeliefVersion[] }>(
    `/memory?user=${encodeURIComponent(user)}`,
  );
  const hist = mem.data?.belief_history ?? [];
  const current = (mem.data?.beliefs ?? []).filter((b) => !b.key.startsWith("session:"));
  const sessions = (mem.data?.beliefs ?? []).filter((b) => b.key.startsWith("session:"));
  return (
    <section aria-labelledby="mem-h">
      <h2 id="mem-h" className="pane-title mb-3">
        <span className="text-ink">What Orion remembers</span> <span className="text-faint">about {personName(user)}</span>
      </h2>
      {current.length === 0 && sessions.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet. Tell the assistant something about yourself (&ldquo;I&rsquo;m on Billing now&rdquo;) and it will remember.</p>
      ) : (
        <ul className="space-y-3 text-[13px]">
          {current.map((b) => {
            const versions = hist.filter((h) => h.key === b.key);
            return (
              <li key={b.key} className="rounded-xl border border-rule bg-panel px-4 py-3">
                <p>
                  <span className="text-[12px] text-muted">{memoryLabel(b.key)}:</span>{" "}
                  <span className="text-ink">{b.text}</span>{" "}
                  <span className="text-[12px] text-muted">{Math.round(b.confidence * 100)}% sure</span>
                </p>
                {versions.length > 1 && (
                  <ol className="mt-2 space-y-1 border-l border-rule pl-3 text-xs text-muted">
                    {versions.map((v) => (
                      <li key={v.valid_from} className={v.valid_to ? "text-faint" : ""}>
                        {fmtDate(v.valid_from)}{v.valid_to ? `–${fmtDate(v.valid_to)}` : " – now"}:{" "}
                        <span className={v.valid_to ? "line-through" : "text-ink"}>{v.text}</span>
                        {v.learned_from && <span> · from &ldquo;{v.learned_from.slice(0, 80)}&rdquo;</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
          {sessions.length > 0 && (
            <li className="text-xs text-muted">
              <p className="label mb-1">Earlier conversations, summarised</p>
              <ul className="space-y-1">
                {sessions.slice(0, 5).map((s) => (
                  <li key={s.key}>{s.text}</li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

export default function InboxPage() {
  const router = useRouter();
  const { user, personName, people, ask, asking, openBlame, refreshInbox, refreshTenant, llm } = useApp();
  const off = llm === false;
  const inbox = useFetch<Notification[]>(`/inbox?user=${encodeURIComponent(user)}`, 5000);
  const answers = useFetch<AnswerRow[]>(`/answers?user=${encodeURIComponent(user)}`);
  const messages = useFetch<Message[]>("/messages");

  const [channel, setChannel] = useState("#billing");
  // the message is sent with this person's own login: the server takes the author from the token, never the body
  const [author, setAuthor] = useState("person:tomasz-nowak");
  const [text, setText] = useState(S8);
  const [posting, setPosting] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [postErr, setPostErr] = useState<string | null>(null);

  const channels = [...new Set(["#billing", ...(messages.data ?? []).map((m) => m.channel)])];

  const send = async () => {
    if (!text.trim() || posting || off) return;
    setPosting(true);
    setPostErr(null);
    setLog([]);
    let n = 0;
    const push = (l: Omit<LogLine, "id">) => setLog((ls) => [...ls, { ...l, id: ++n }]);
    try {
      await postStream("/messages", { channel, text }, ({ event, data }) => {
        if (event === "status") push({ kind: "Reading", text: statusWords("cartographer", String(data.text)), tone: "muted" });
        else if (event === "extracted") {
          const ch = (data.changes as { relation: string; subject: string; object: string; change: string; quote: string }[]) ?? [];
          const tk = (data.ticket_updates as { key: string; status: string }[]) ?? [];
          const mentions = (data.mentions as string[]) ?? [];
          push({ kind: "Mentions", text: mentions.length ? mentions.join(", ") : "nothing Orion keeps track of", tone: "muted" });
          for (const c of ch) push({ kind: "Says", text: `${changeWords(c.subject, c.relation, c.object, c.change)} (“${c.quote}”)`, tone: "warn" });
          for (const t of tk) push({ kind: "Task", text: `${t.key} is now ${t.status}`, tone: "ok" });
        } else if (event === "fact_closed")
          push({ kind: "No longer true", text: `${data.subject} ${relWord(String(data.relation))} ${data.object}`, tone: "bad", fact: String(data.fact) });
        else if (event === "fact_opened")
          push({ kind: "Now true", text: `${data.subject} ${relWord(String(data.relation))} ${data.object}`, tone: "ok", fact: String(data.fact) });
        else if (event === "answer_expired")
          push({
            kind: "Out of date",
            text: `${personName(String(data.user))}'s answer to “${data.question}”: ${(data.broken_claims as string[])?.length ?? 0} of ${data.total_claims} points no longer true`,
            tone: "warn",
          });
        else if (event === "review_queued")
          push({ kind: "To confirm", text: `${data.subject} ${relWord(String(data.relation))} ${data.object}: needs someone to confirm it`, tone: "warn" });
        else if (event === "contradiction") push({ kind: "Disagrees", text: String(data.summary), tone: "warn" });
        else if (event === "error") push({ kind: "Problem", text: String(data.text), tone: "bad" });
        else if (event === "done") {
          const r = data.result as { closed?: string[]; opened?: string[]; notifications?: unknown[]; review?: unknown[]; contradictions?: unknown[] } | null;
          if (r)
            push({
              kind: "Done",
              text: `${r.closed?.length ?? 0} no longer true, ${r.opened?.length ?? 0} newly true, ${r.review?.length ?? 0} to confirm, ${r.contradictions?.length ?? 0} disagreements, ${r.notifications?.length ?? 0} people told`,
              tone: "muted",
            });
        }
      }, undefined, author);
    } catch (e) {
      setPostErr((e as Error).message);
    } finally {
      setPosting(false);
      inbox.reload();
      answers.reload();
      messages.reload();
      refreshInbox();
      refreshTenant();
    }
  };

  const reask = async (n: Notification) => {
    if (!n.read) await post(`/inbox/${encodeURIComponent(n.uid)}/read`, {}).catch(() => {});
    refreshInbox();
    ask(n.question);
    router.push("/");
  };

  const markRead = async (n: Notification) => {
    await post(`/inbox/${encodeURIComponent(n.uid)}/read`, {}).catch(() => {});
    inbox.reload();
    refreshInbox();
  };

  const notes = inbox.data ?? [];
  const TONE = { ok: "text-ok", bad: "text-bad", warn: "text-warn", muted: "text-muted" };

  return (
    <div className="h-full overflow-y-auto">
    <div className="mx-auto grid max-w-[1360px] gap-10 px-6 py-7 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <div className="min-w-0 space-y-10">
        <section aria-labelledby="notes-h">
          <h2 id="notes-h" className="pane-title mb-4">
            <span className="text-ink">Updates</span> <span className="text-faint">for {personName(user)}</span>
          </h2>
          {inbox.error && <ErrorNote error={inbox.error} onRetry={inbox.reload} />}
          {inbox.data && notes.length === 0 && (
            <Empty title="Everything you were told still holds.">
              When something one of your answers relied on changes, you&rsquo;ll see it here. To watch it happen, ask a
              question on the Ask page, then post the example message on the right.
            </Empty>
          )}
          <ul className="space-y-2.5">
            {notes.map((n) => (
              <li key={n.uid} className={`appear relative overflow-hidden rounded-xl border bg-panel p-5 ${n.read ? "border-rule-soft" : "border-rule-strong"}`}>
                {!n.read && <span className="absolute inset-y-0 left-0 w-[2px] bg-ember" aria-label="Unread" />}
                {n.kind === "watch" ? (
                  <p className="heading text-[20px] leading-[1.15]">
                    A question you watch was re-checked:{" "}
                    <span className="text-warn">
                      {n.changes?.length ?? 0} {n.changes?.length === 1 ? "point" : "points"} changed
                    </span>
                    .
                  </p>
                ) : !n.why || n.why.startsWith("a fact") ? (
                  <p className="heading text-[20px] leading-[1.15]">
                    An answer you got on {fmtDate(n.asked_at)} is out of date.{" "}
                    <span className="italic text-warn">
                      {n.broken_claims.length} of its {n.total_claims} points
                    </span>{" "}
                    {n.broken_claims.length === 1 ? "is" : "are"} no longer true.
                  </p>
                ) : (
                  <p className="heading text-[20px] leading-[1.15]">
                    Your answer from {fmtDate(n.asked_at)} may be out of date:{" "}
                    <span className="italic text-warn">{n.why.replace(/^something it read changed: /, "")}</span> changed.
                  </p>
                )}
                <p className="mt-2 text-[13px] text-muted">&ldquo;{n.question}&rdquo;</p>
                {/* each changed claim on one line, then what is true now and the fact that changed */}
                <ul className="mt-3 space-y-1 text-[13px]">
                  {/* re-checked, not guessed: each point listed failed its check on the company as it is now; a watched
                      question lists every mark that moved, either way */}
                  {n.kind === "watch" &&
                    (n.changes ?? []).map((ch) => (
                      <li key={ch.text} className="min-w-0" title={ch.text}>
                        <span className="flex min-w-0 items-start gap-2">
                          <span className="mt-[3px] shrink-0">
                            <VerdictMark verdict={ch.after} size={12} />
                          </span>
                          <span className="min-w-0 text-ink">
                            <span className="block truncate">{ch.text}</span>
                            <span className="block text-[12px] text-muted">
                              {CHECK_SHORT[ch.before]} → <span className="text-ink">{CHECK_SHORT[ch.after]}</span>
                              {ch.reason ? `: ${checkReason(ch.reason)}` : ""}
                            </span>
                          </span>
                        </span>
                      </li>
                    ))}
                  {n.kind !== "watch" && n.broken_claims.map((c, i) => (
                    <li key={c} className="min-w-0" title={c}>
                      <span className="flex min-w-0 gap-2 text-bad">
                        <span className="mt-[3px] shrink-0">
                          <VerdictMark verdict="contradicted" size={12} />
                        </span>
                        <span className="min-w-0 truncate line-through decoration-bad/70">{c.length > 90 ? `${c.slice(0, 89)}…` : c}</span>
                      </span>
                      {n.reasons?.[i] && <span className="ml-5 block text-[12px] text-muted">{checkReason(n.reasons[i])}</span>}
                    </li>
                  ))}
                </ul>
                {n.now && (
                  <p className="mt-2 flex min-w-0 gap-2 text-[13px] text-ink">
                    <span className="shrink-0 font-medium text-ok">Now:</span>
                    <span className="min-w-0">{n.now}</span>
                  </p>
                )}
                <p className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                  Changed {fmtDate(n.at)}
                  {n.fact && (
                    <button
                      type="button"
                      onClick={() => openBlame({ fact: n.fact })}
                      className="rounded border border-rule px-1.5 py-px text-[11px] text-ink transition-colors hover:border-ember/60 hover:text-ember"
                      title={`Where Orion learned this: ${factWords(n.fact)}`}
                    >
                      Where this came from
                    </button>
                  )}
                </p>
                <div className="mt-4 flex gap-2">
                  <button type="button" className="btn btn-primary" disabled={asking || off} onClick={() => reask(n)} title={off ? "The AI assistant isn't set up yet" : undefined}>
                    Ask again
                  </button>
                  {!n.read && (
                    <button type="button" className="btn btn-ghost" onClick={() => markRead(n)}>
                      Mark as read
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <Watching />

        <section aria-labelledby="answers-h">
          <h2 id="answers-h" className="pane-title mb-3">
            <span className="text-ink">Past answers</span> <span className="text-faint">for {personName(user)}</span>
          </h2>
          {answers.error && <ErrorNote error={answers.error} onRetry={answers.reload} />}
          {answers.data && answers.data.length === 0 && <p className="text-sm text-muted">No answers yet. Ask something on the Ask page.</p>}
          <ul className={answers.data?.length ? "overflow-hidden rounded-xl border border-rule bg-panel" : ""}>
            {answers.data?.map((a) => (
              <AnswerItem key={a.uid} a={a} />
            ))}
          </ul>
        </section>

        <ReviewQueue />

        <MemoryPanel user={user} />
      </div>

      <div className="min-w-0 space-y-10">
        <section aria-labelledby="post-h" className="rounded-xl border border-rule bg-panel p-5 shadow-deep">
          <h2 id="post-h" className="heading text-[20px] leading-none">Post a team message</h2>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            Orion reads team chat to keep its records up to date. Post a message as someone on the team and watch
            what it learns, and which answers it flags as out of date.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="label">Channel</span>
              <input className="field mt-1" list="channels" value={channel} onChange={(e) => setChannel(e.target.value)} />
              <datalist id="channels">
                {channels.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <div>
              <label htmlFor="msg-author" className="label">Posted by</label>
              <select id="msg-author" className="field mt-1" value={author} onChange={(e) => setAuthor(e.target.value)}>
                {!people.length && <option value={author}>{personName(author)}</option>}
                {people.map((p) => (
                  <option key={p.uid} value={p.uid}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="mt-2 block">
            <span className="label">Message</span>
            <textarea rows={3} className="field mt-1 resize-y" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" className="btn btn-ghost px-2 text-xs" onClick={() => { setChannel("#billing"); setAuthor("person:tomasz-nowak"); setText(S8); }}>
              Use the example message
            </button>
            <button type="button" className="btn btn-primary ml-auto" disabled={posting || !text.trim() || off} onClick={send}>
              {posting && <Spinner />} Post to {channel}
            </button>
          </div>
          {off && <AgentsOff className="mt-2" />}
          {postErr && <p role="alert" className="mt-2 text-xs text-bad">{postErr}</p>}
          {log.length > 0 && (
            <ol className="mt-4 space-y-1.5 rounded-xl border border-rule bg-well px-3.5 py-3 text-[12px] leading-snug" aria-live="polite">
              {log.map((l) => (
                <li key={l.id} className="appear flex gap-3">
                  <span className={`w-[6.5rem] shrink-0 ${TONE[l.tone]}`}>{l.kind}</span>
                  <span className="min-w-0 flex-1 text-ink">
                    {l.text}
                    {l.fact && (
                      <button type="button" onClick={() => openBlame({ fact: l.fact })} className="ml-1.5 text-[11px] text-ember hover:underline">
                        source
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-labelledby="msg-h">
          <h2 id="msg-h" className="pane-title mb-3"><span className="text-ink">Recent messages</span></h2>
          {messages.error && <ErrorNote error={messages.error} onRetry={messages.reload} />}
          <ol className="space-y-4">
            {messages.data?.slice(0, 12).map((m) => (
              <li key={m.uid} className="flex gap-3 text-[13px]">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-raised text-[11px] font-semibold text-muted ring-1 ring-rule" aria-hidden>
                  {(m.author ?? "?").split(" ").map((w) => w[0]).slice(0, 2).join("")}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2 text-xs">
                    <span className="font-medium text-ink">{m.author ?? "unknown"}</span>
                    <span className="mono text-[11px] text-faint">{m.channel}</span>
                    {m.live && <span className="text-[11px] text-ember">just posted</span>}
                    <span className="mono ml-auto text-[11px] text-faint">{fmtDate(m.at)}</span>
                  </p>
                  <p className="mt-0.5 leading-snug text-muted">{m.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
    </div>
  );
}
