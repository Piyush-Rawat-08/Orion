"use client";

import { useRef, useState } from "react";
import { postStream } from "@/lib/sse";
import { fmtMs, plural } from "@/lib/format";
import { AgentsOff, RiskBadge, Spinner, UniverseTag } from "../ui";
import { useApp } from "../AppProvider";
import type { Risk } from "@/lib/types";

interface Row {
  scenario: string;
  state: "queued" | "posted" | "done" | "error";
  universe?: string;
  title?: string;
  risk?: Risk;
  worker?: string;
  fork_ms?: number;
  assumptions?: string[];
  error?: string;
  postedAt?: number;
  doneAt?: number;
}

const EXAMPLES = ["Ines Okafor leaves the company", "Switch off sso-legacy next quarter", "Combine Signals into Platform"];

export default function SimulateBox({
  user,
  onUniverse,
  onSelect,
}: {
  user: string;
  onUniverse: () => void;
  onSelect: (uid: string) => void;
}) {
  const [text, setText] = useState(EXAMPLES.join("\n"));
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [wall, setWall] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t0 = useRef(0);
  const { llm } = useApp();
  const off = llm === false;

  const scenarios = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);

  const run = async () => {
    if (!scenarios.length || running || off) return;
    setRunning(true);
    setWall(null);
    setError(null);
    t0.current = performance.now();
    setRows(scenarios.map((s) => ({ scenario: s, state: "queued" })));
    const patch = (s: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.scenario === s ? { ...r, ...p } : r)));
    try {
      await postStream("/simulate", { scenarios, user }, ({ event, data }) => {
        const s = String(data.scenario ?? "");
        if (event === "task_posted") patch(s, { state: "posted", postedAt: performance.now() });
        else if (event === "universe") {
          patch(s, {
            state: "done",
            universe: String(data.universe),
            title: String(data.title ?? ""),
            risk: data.risk as Risk,
            worker: String(data.worker ?? "inline"),
            fork_ms: Number(data.fork_ms),
            assumptions: (data.assumptions as string[]) ?? [],
            doneAt: performance.now(),
          });
          onUniverse();
        } else if (event === "error") {
          if (s) patch(s, { state: "error", error: String(data.text ?? "failed") });
          else setError(String(data.text ?? "failed"));
        } else if (event === "done") {
          const r = data.result as { wall_ms?: number } | null;
          setWall(r?.wall_ms ?? Math.round(performance.now() - t0.current));
        }
      });
    } catch (e) {
      setError((e as Error).message);
      setRows((rs) => rs.map((r) => (r.state === "done" ? r : { ...r, state: "error", error: r.error ?? "the connection was lost" })));
    } finally {
      setRunning(false);
    }
  };

  const workers = [...new Set(rows.map((r) => r.worker).filter(Boolean))] as string[];

  return (
    <div className="space-y-2.5">
      <label className="block">
        <span className="label">What would you like to test? One idea per line</span>
        <textarea
          rows={3}
          className="field mt-1 resize-y leading-snug"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What if Ines Okafor leaves?"
        />
      </label>
      {off && <AgentsOff />}
      <button type="button" className="btn btn-primary w-full justify-center" disabled={running || !scenarios.length || off} onClick={run}>
        {running && <Spinner />}
        {running
          ? "Testing on copies of the company"
          : scenarios.length > 1
            ? `Test all ${scenarios.length} at once`
            : "Test it"}
      </button>
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}

      {rows.length > 0 && (
        <ol className="space-y-1.5" aria-live="polite">
          {rows.map((r) => (
            <li key={r.scenario}>
              <button
                type="button"
                disabled={!r.universe}
                onClick={() => r.universe && onSelect(r.universe)}
                className={`appear w-full rounded-lg border px-3 py-2.5 text-left text-xs transition-colors ${
                  r.state === "done" ? "border-rule bg-raised/40 hover:bg-raised" : "border-dashed border-rule"
                } ${r.state === "posted" ? "scanning" : ""}`}
              >
                <span className="flex items-center gap-2">
                  {r.universe ? <UniverseTag uid={r.universe} /> : r.state === "error" ? <span className="text-bad">didn&rsquo;t work</span> : <Spinner size={11} className="text-ember" />}
                  <span className="min-w-0 flex-1 truncate text-ink">{r.title || r.scenario}</span>
                  {r.risk && <RiskBadge level={r.risk.level} score={r.risk.score} />}
                </span>
                <span className="mt-1 flex flex-wrap gap-x-3 text-muted">
                  {r.state === "queued" && <span>Queued</span>}
                  {r.state === "posted" && <span>Working out the change and testing it</span>}
                  {r.doneAt && <span>Ready in {fmtMs(r.doneAt - t0.current)}</span>}
                  {r.universe && <span className="text-ink">Open to see what it affects</span>}
                  {r.error && <span className="text-bad">{r.error}</span>}
                </span>
                {r.assumptions && r.assumptions.length > 0 && (
                  <span className="mt-1 block text-faint">Assumed: {r.assumptions.join("; ")}</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
      {wall !== null && (
        <p className="text-xs text-muted">
          {plural(rows.filter((r) => r.universe).length, "what-if")} tested in {fmtMs(wall)}
          {workers.length > 1 ? `, ${workers.length} at a time` : ""}.
        </p>
      )}
    </div>
  );
}
