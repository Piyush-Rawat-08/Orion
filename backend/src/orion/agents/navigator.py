"""The Navigator: answers a question about the company by walking the graph, and shows its work.

It plans, calls graph tools (several at once when it can), and finishes by calling final_answer with sentences,
each carrying a typed claim and the evidence ids it rests on. Every claim is checked by the graph before the answer
is shown (claims.py); the answer, its claims and the entities they rely on are written to the org graph, so a later
change to any of those entities re-checks the answer (watch.py). What the asker said before, and what was simulated
before about the same entities, come in from memory.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from orion import claims as cl
from orion import db as dbm
from orion import llm, memory, tools, watch
from orion import universe as uv

MAX_STEPS = 8

SYSTEM = """You are the Navigator in Orion, the company graph of {company}. You answer questions about how the
company works: who knows what, what depends on what, what would break, what was decided and why, what customers
are waiting on. The graph is the only source of truth; you never answer from general knowledge.

How to work:
- Call tools to look things up; call several at once when they don't depend on each other. Names can be loose
  ("the old sso", "Ines"): the tools resolve them.
- For any "what if" or "what breaks if" question, call what_if. It forks the company into a universe and returns a
  universe id, what breaks, who is exposed, who must approve and a risk score. Never guess impact.
- Finish by calling final_answer. Keep the answer short and plain: a few sentences, no headings, no filler.
- Every factual sentence in the answer gets a claim. Prefer typed claims, because the graph checks those exactly:
  knows (subject: service, objects: people), owns, depends_on, dependents (any depth), breaks (scenario: the
  universe id, objects: services that break), approvers (scenario, objects: teams), exposed (scenario, objects:
  customers), decision (subject: ADR key, value: status), count (metric: knowers,
  dependents, members or risk, value: the number). Set exhaustive=true when the sentence says these are all of them
  ("only", "all", "nobody else"). Use type text only for what no typed claim can express, and cite evidence ids.
- Each claim's sentence must name only the entities in its subject and objects.
- Cite the evidence ids (e1, e2, ...) each claim rests on. If the graph doesn't say, say you don't know.

It is {now} at {company}. The person asking is {who}."""

FINAL = {
    "name": "final_answer",
    "description": "Give the answer. Call this exactly once, at the end.",
    "schema": {"type": "object", "additionalProperties": False, "required": ["answer", "claims", "follow_ups"],
               "properties": {"answer": {"type": "string", "description": "the full answer, plain text"},
                              "claims": {"type": "array", "items": cl.SCHEMA},
                              "follow_ups": {"type": "array", "items": {"type": "string"}, "maxItems": 3}}},
}


def ask(db: dbm.DB, t: str, question: str, *, user: str | None, session: str | None = None,
        emit: Callable[[dict], None] = lambda e: None) -> dict:
    t0 = time.perf_counter()
    ctx = tools.Ctx(db, t, user)
    me = uv.who(db, t, user) if user else None
    company = db.one(dbm.org(t), "MATCH (c:Company) RETURN c.name AS name")["name"]
    system = SYSTEM.format(company=company, now=dbm.clock(db, t),
                           who=f"{me['name']}, {me['role']} on {me['team_name']}" if me else "an agent")
    recall = memory.recall(db, t, user, question, session) if user else {}
    if recall.get("text"):
        emit({"type": "recall", "items": recall["items"]})
    prompt = question + ("\n\n" + recall["text"] if recall.get("text") else "")

    chat = llm.Chat(system, tools.specs() + [FINAL], prompt)
    evidence: list[dict] = []
    final = None
    usage = {"input": 0, "output": 0}
    steps = 0
    while steps < MAX_STEPS and final is None:
        steps += 1
        step = chat.step()
        for k in usage:
            usage[k] += step.usage.get(k, 0)
        if step.thinking:
            emit({"type": "thinking", "text": step.thinking})
        if not step.calls:
            if step.text.strip():
                final = {"answer": step.text.strip(), "claims": [], "follow_ups": []}
                break
            chat.say("Finish by calling final_answer.")
            continue
        fin = [c for c in step.calls if c.name == "final_answer"]
        work = [c for c in step.calls if c.name != "final_answer"]
        results = _run_tools(ctx, work, evidence, emit)
        if fin:
            final = fin[0].args
            results += [(c, "ok", False) for c in fin]
        chat.respond(results)
    if final is None:
        final = {"answer": "I couldn't finish within my step budget.", "claims": [], "follow_ups": []}

    # check every claim against the graph before anyone sees it
    rows_by_ev = {e["id"]: e["rows"] for e in evidence}
    checked = []
    for c in _claims(final.get("claims")):
        c = {k: c.get(k) for k in cl.SCHEMA["properties"]} | {
            "objects": c.get("objects") or [], "evidence": c.get("evidence") or [], "type": c.get("type") or "text",
            "exhaustive": bool(c.get("exhaustive")), "subject": c.get("subject") or ""}
        res = cl.check(ctx, c, rows_by_ev)
        item = {"claim": c, "result": res, "about": cl.about(ctx, c, res)}
        checked.append(item)
        emit({"type": "claim", "sentence": c["sentence"], "status": res["status"], "why": res.get("why")})
    meta = {"model": llm.info(), "steps": steps, "usage": usage, "ms": round((time.perf_counter() - t0) * 1000),
            "follow_ups": final.get("follow_ups") or []}
    slim = [{k: e[k] for k in ("id", "tool", "args", "summary", "uids", "queries")} | {"rows": _trim(e["rows"])}
            for e in evidence]
    uid = watch.store(db, t, user=user, question=question, text=final.get("answer", ""), checked=checked,
                      evidence=slim, session=session, meta=meta)
    if user:
        memory.remember(db, t, user, session, question, final.get("answer", ""), uid,
                        [u for e in evidence for u in e["uids"]])
        memory.learn_procedure(db, t, user, question, [e["tool"] for e in evidence],
                               ok=all(c["result"]["status"] in ("verified", "partial", "judged") for c in checked))
    out = watch.answer(db, t, uid)
    emit({"type": "answer", "answer": out})
    return out


def _claims(raw) -> list[dict]:
    """Models occasionally send the claims (or one claim) as a JSON string; accept both."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return [{"sentence": raw, "type": "text"}]
    out = []
    for c in raw or []:
        if isinstance(c, str):
            try:
                c = json.loads(c)
            except ValueError:
                c = {"sentence": c, "type": "text"}
        if isinstance(c, dict) and c.get("sentence"):
            out.append(c)
    return out


def _run_tools(ctx: tools.Ctx, calls, evidence: list[dict], emit) -> list:
    def one(c):
        eid = f"e{len(evidence) + calls.index(c) + 1}"
        emit({"type": "tool", "id": eid, "name": c.name, "args": c.args})
        t0 = time.perf_counter()
        try:
            r = tools.run(ctx, c.name, c.args)
            r["id"] = eid
            ms = round((time.perf_counter() - t0) * 1000)
            emit({"type": "tool_result", "id": eid, "name": c.name, "summary": r["summary"], "uids": r["uids"], "ms": ms})
            return c, r, None
        except Exception as e:
            emit({"type": "tool_error", "id": eid, "name": c.name, "error": str(e)})
            return c, None, str(e)

    with ThreadPoolExecutor(max_workers=4) as pool:
        done = list(pool.map(one, calls))
    out = []
    for c, r, err in done:
        if err:
            out.append((c, json.dumps({"error": err}), True))
            continue
        evidence.append(r)
        out.append((c, json.dumps({"evidence_id": r["id"], "summary": r["summary"], "rows": _trim(r["rows"], 7000)},
                                  default=str), False))
    return out


def _trim(rows, limit: int = 4000):
    """Keep tool output small enough for the model and for storage."""
    s = json.dumps(rows, default=str)
    if len(s) <= limit:
        return rows
    if isinstance(rows, list):
        out = []
        for r in rows:
            out.append(r)
            if len(json.dumps(out, default=str)) > limit:
                out.pop()
                break
        return out
    if isinstance(rows, dict):
        return {k: _trim(v, limit // max(1, len(rows))) for k, v in rows.items()}
    return s[:limit]
