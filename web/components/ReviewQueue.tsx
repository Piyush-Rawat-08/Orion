"use client";

// Things people said in team chat that Orion won't put in the records without a person checking: whoever said
// it isn't on the team responsible, or they sounded unsure. A yes records it; ignoring it leaves the records as
// they are.

import { useState } from "react";
import { post } from "@/lib/api";
import { useFetch } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import type { Review } from "@/lib/types";
import { changeWords, reviewWhy } from "@/lib/words";

export default function ReviewQueue() {
  const list = useFetch<Review[]>("/reviews", 5000);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ uid: string; text: string } | null>(null);
  const decide = async (uid: string, verdict: "accept" | "reject") => {
    setBusy(uid);
    setErr(null);
    try {
      await post(`/reviews/${uid}/${verdict}`, {});
    } catch (e) {
      setErr({ uid, text: (e as Error).message });
    } finally {
      setBusy(null);
      list.reload();
    }
  };
  const rows = list.data ?? [];
  return (
    <section aria-labelledby="review-h">
      <h2 id="review-h" className="pane-title mb-1">
        <span className="text-ink">To confirm</span>
        {rows.length > 0 && <span className="mono text-[11px] text-faint">{rows.length}</span>}
      </h2>
      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        Things people said in team chat that Orion won&rsquo;t record until someone confirms them.
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">
          Nothing to confirm. When someone on the team responsible says something clearly, it is recorded straight away;
          anything else waits here.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.uid} className="rounded-xl border border-rule bg-panel px-4 py-3 text-xs">
              <p className="text-[13px] text-ink">{changeWords(r.change.subject, r.change.relation, r.change.object, r.change.change)}</p>
              {r.change.quote && <p className="mt-1 text-muted">&ldquo;{r.change.quote}&rdquo;</p>}
              <p className="mt-1 text-faint">
                Waiting because {reviewWhy(r.why)} · {Math.round(r.confidence * 100)}% sure · {fmtDate(r.at)}
              </p>
              {r.deciders && r.deciders.length > 0 && (
                <p className="mt-1 text-muted">Someone on {r.deciders.join(" or ")} can confirm it.</p>
              )}
              {err?.uid === r.uid && (
                <p role="alert" className="mt-1 text-bad">
                  {err.text}. To decide it, switch who you&rsquo;re viewing as in the top bar.
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <button type="button" className="btn" disabled={busy === r.uid} onClick={() => decide(r.uid, "accept")}>
                  Yes, record it
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy === r.uid} onClick={() => decide(r.uid, "reject")}>
                  Ignore
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
