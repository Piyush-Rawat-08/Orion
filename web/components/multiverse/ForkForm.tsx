"use client";

import { useId, useMemo, useState } from "react";
import { post } from "@/lib/api";
import { Segmented, Spinner } from "../ui";
import type { ForkResult, GraphPayload, NodeType, Op } from "@/lib/types";
import { opWords } from "@/lib/words";

type Field = { k: string; label: string; from?: NodeType; options?: string[]; text?: boolean };

/** Choice values the backend takes, shown in words. */
const OPTION_WORD: Record<string, string> = {
  sync: "Waits for its answer",
  async: "Sends it work in the background",
  data: "Reads its data",
  P1: "Urgent",
  P2: "High",
  P3: "Normal",
  P4: "Low",
};

export const OP_DEFS: Record<string, { label: string; fields: Field[] }> = {
  deprecate_service: { label: "Switch off a system", fields: [{ k: "service", label: "System", from: "Service" }] },
  remove_person: { label: "Someone leaves", fields: [{ k: "person", label: "Person", from: "Person" }] },
  move_person: {
    label: "Move a person",
    fields: [
      { k: "person", label: "Person", from: "Person" },
      { k: "team", label: "To team", from: "Team" },
    ],
  },
  reassign_owner: {
    label: "Give a system to another team",
    fields: [
      { k: "service", label: "System", from: "Service" },
      { k: "team", label: "New owning team", from: "Team" },
    ],
  },
  add_dependency: {
    label: "A system starts relying on another",
    fields: [
      { k: "source", label: "System", from: "Service" },
      { k: "target", label: "Starts relying on", from: "Service" },
      { k: "kind", label: "How", options: ["sync", "async", "data"] },
    ],
  },
  remove_dependency: {
    label: "A system stops relying on another",
    fields: [
      { k: "source", label: "System", from: "Service" },
      { k: "target", label: "Stops relying on", from: "Service" },
    ],
  },
  reverse_decision: { label: "Reverse a decision", fields: [{ k: "decision", label: "Decision", from: "Decision" }] },
  merge_teams: {
    label: "Combine two teams",
    fields: [
      { k: "team", label: "Team to fold in", from: "Team" },
      { k: "into", label: "Into", from: "Team" },
    ],
  },
  create_ticket: {
    label: "Open a task",
    fields: [
      { k: "title", label: "Task", text: true },
      { k: "service", label: "For system", from: "Service" },
      { k: "priority", label: "Priority", options: ["P1", "P2", "P3", "P4"] },
    ],
  },
};

export default function ForkForm({
  graph,
  user,
  onForked,
  preset,
}: {
  graph: GraphPayload | null;
  user: string;
  onForked: (r: ForkResult) => void;
  /** a change to start from, e.g. "switch off billing" when arriving from the map's "Test it properly" */
  preset?: { op: string; vals: Record<string, string> };
}) {
  const [opName, setOpName] = useState(preset?.op ?? "deprecate_service");
  const [vals, setVals] = useState<Record<string, string>>(() =>
    preset ? Object.fromEntries(Object.entries(preset.vals).map(([k, v]) => [`${preset.op}.${k}`, v])) : {},
  );
  const [ops, setOps] = useState<Op[]>([]);
  const [kind, setKind] = useState<"whatif" | "dryrun">("whatif");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();

  const choices = useMemo(() => {
    const by: Partial<Record<NodeType, string[]>> = {};
    for (const n of graph?.nodes ?? []) {
      if (n.retired || n.former) continue;
      const v = n.type === "Decision" ? n.key ?? n.name : n.name;
      if (v) (by[n.type] ??= []).push(v);
    }
    for (const k of Object.keys(by) as NodeType[]) by[k]!.sort((a, b) => a.localeCompare(b));
    return by;
  }, [graph]);

  const def = OP_DEFS[opName];
  const current: Op = { op: opName };
  for (const f of def.fields) {
    const v = vals[`${opName}.${f.k}`] ?? (f.options ? f.options[0] : "");
    if (v) current[f.k] = v;
  }
  const complete = def.fields.every((f) => current[f.k]);
  const plan = complete ? [...ops, current] : ops;

  const run = async () => {
    if (!plan.length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<ForkResult>("/fork", { ops: plan, kind, user });
      setOps([]);
      onForked(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <div>
        <label htmlFor={`${uid}-op`} className="label">What changes</label>
        <select id={`${uid}-op`} className="field mt-1" value={opName} onChange={(e) => setOpName(e.target.value)}>
          {Object.entries(OP_DEFS).map(([k, d]) => (
            <option key={k} value={k}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      {def.fields.map((f) => {
        const key = `${opName}.${f.k}`;
        const opts = f.options ?? (f.from ? choices[f.from] ?? [] : null);
        return (
          <div key={key}>
            <label htmlFor={`${uid}-${f.k}`} className="label">{f.label}</label>
            {opts ? (
              <select id={`${uid}-${f.k}`} className="field mt-1" value={vals[key] ?? (f.options ? f.options[0] : "")} onChange={(e) => setVals({ ...vals, [key]: e.target.value })}>
                {!f.options && <option value="">Choose…</option>}
                {opts.map((o) => (
                  <option key={o} value={o}>
                    {OPTION_WORD[o] ?? o}
                  </option>
                ))}
              </select>
            ) : (
              <input id={`${uid}-${f.k}`} className="field mt-1" value={vals[key] ?? ""} onChange={(e) => setVals({ ...vals, [key]: e.target.value })} />
            )}
          </div>
        );
      })}
      {ops.length > 0 && (
        <ol className="space-y-0.5 rounded-lg border border-rule bg-well px-2.5 py-2 text-[12px] text-muted">
          {ops.map((o, i) => (
            <li key={i} className="flex gap-2">
              <span className="truncate">{opWords(o)}</span>
              <button type="button" className="ml-auto text-faint hover:text-bad" aria-label="Remove this change" onClick={() => setOps(ops.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-ghost px-2 text-xs" disabled={!complete} onClick={() => complete && (setOps([...ops, current]), setVals({}))}>
          Add another change
        </button>
        <Segmented
          label="Just explore, or ask for approval"
          size="sm"
          className="ml-auto"
          value={kind}
          onChange={setKind}
          options={[
            ["whatif", "Just explore"],
            ["dryrun", "Ask for approval"],
          ]}
        />
      </div>
      <button type="button" className="btn btn-primary w-full justify-center" disabled={busy || !plan.length} onClick={run}>
        {busy ? <Spinner /> : null}
        {busy ? "Testing on a copy of the company" : `Test ${plan.length > 1 ? `${plan.length} changes` : "this change"}`}
      </button>
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}
    </div>
  );
}
