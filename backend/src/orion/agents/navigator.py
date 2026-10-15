"""The Navigator: answers questions and proposes actions, with a receipt for every claim.

Loop: recall memory (this conversation, earlier ones about the same things, beliefs, playbooks) and what was
simulated before about the question's entities (re-run if something they looked at changed) -> pre-run the read
tools of the playbook that worked for this kind of question -> plan and call graph tools, independent calls in
parallel -> submit_answer with typed claims citing evidence ids -> the Verifier checks every claim -> the Answer,
its Claims, the facts they rely on and the nodes they read go into the org graph (so the answer is re-checked
when any of them changes) -> the turn and the tool sequence go to the asker's memory.
"""

from __future__ import annotations

import json
import re
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from orion import blackboard, findings, llm, memory
from orion import claims as typed
from orion import db as dbm
from orion.agents.verifier import verify
from orion.tools import ToolContext, call_tool, to_json, tool_specs

MAX_STEPS = 14
PARALLEL = 4

SYSTEM = """You are Orion, the company brain of {company}. Everything the company knows lives in a FalkorDB graph:
people, teams, services and how they depend on each other, projects, decisions, tickets, customers, and the messages,
documents and changes every fact came from. You answer by calling graph tools, never from memory or general knowledge.

How to work:
- If names are unclear, find the entities first (find_entities), then follow connections: impact for what depends on
  what, who_knows and ownership for people, decision_history for why things are as they are, customer_timeline for
  customers, communities, bottlenecks and influence for how people actually work.
- For any "what happens if..." question, call fork with typed changes. It copies the whole company into a parallel
  universe, makes the change and compares. Report what breaks, which customers would notice, who has to agree and the risk.
- For anything you are asked to DO (open a ticket, hand a service to another team, change a dependency, switch
  something off), call dry_run. You never change the company yourself; the teams it names approve it.
- Every tool result lists evidence ids (e1, e2...). Each claim cites the evidence ids that show it.
- Type every claim you can, so the graph checks it (a typed claim that matches the graph is "verified"; free text is
  only "judged" by a model):
  breaks: subject = what-if id (e.g. u12), objects = services that break, or (on their own) the customers who would notice
  orphans: subject = what-if id, objects = services nobody would know any more after the change
  approvers: subject = what-if id, objects = teams that must agree to the change
  knows: subject = service, objects = people who know it
  owns: subject = service, objects = owning teams (declared or de facto)
  depends_on: subject = service, objects = what it relies on (measure "dependents" = what relies on it)
  decided: subject = decision key (ADR-011), value = its status, objects = what it affects
  count: subject = entity or what-if, measure = knowers|owners|dependents|dependencies|broken|orphans|approvers,
         value = the number
  metric: subject = service or what-if, measure = risk|bus_factor|tier, value = the number
  free: anything else (why, history, judgement)
  exhaustive = true when the claim says these are ALL of them ("only Ines knows", "breaks exactly...").
- Keep claims short: one fact, one sentence each. Headline first. Name people.
- Calls that don't depend on each other go in the same turn: they run in parallel.
- Use remember when the person tells you something about themselves worth keeping.
- The people reading run the business; most are not engineers. Write the summary, claims and follow-ups in plain
  words: "system" where it reads better than "service", "relies on" rather than "depends on", "a what-if" rather than
  a universe id, "the records" rather than "the graph", "decision record" rather than "ADR" (keys like ADR-011 stay as
  names). Never mention tools, queries, Cypher, nodes, edges, hops or evidence ids. Names of systems, people and teams
  stay exactly as they are."""

CLAIM_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "evidence": {"type": "array", "items": {"type": "string"}},
        "kind": {"type": "string", "enum": typed.KINDS},
        "subject": {"type": ["string", "null"]},
        "objects": {"type": "array", "items": {"type": "string"}},
        "measure": {"type": ["string", "null"], "description": "count/metric: " + " | ".join(typed.MEASURES)},
        "value": {"type": ["string", "null"], "description": "status or number, as text"},
        "exhaustive": {"type": "boolean"},
    },
    "required": ["text", "evidence", "kind", "subject", "objects", "measure", "value", "exhaustive"],
    "additionalProperties": False,
}

SUBMIT = {
    "name": "submit_answer",
    "description": "Submit the final answer: a short summary plus atomic, typed claims, each citing evidence ids.",
    "schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "one or two sentences, the headline"},
            "claims": {"type": "array", "items": CLAIM_SCHEMA},
            "follow_ups": {"type": "array", "items": {"type": "string"}, "description": "up to 3 natural next questions"},
        },
        "required": ["summary", "claims", "follow_ups"],
        "additionalProperties": False,
    },
}

TOOLS = ["find_entities", "impact", "broken_dependencies", "who_knows", "ownership", "decision_history", "blame",
         "customer_timeline", "trace_path", "neighborhood", "bottlenecks", "influence", "communities", "bus_factor",
         "contradictions", "checkout", "cypher_readonly", "next_page", "fork", "dry_run", "remember"]

PREFETCH = {"impact": ("Service", "service"), "who_knows": ("Service", "service"), "ownership": ("Service", "service"),
            "bus_factor": ("Service", "service"), "decision_history": (None, "entity"),
            "customer_timeline": ("Customer", "customer"), "neighborhood": (None, "entity")}


def company_name(db: dbm.DB, t: str) -> str:
    if t.startswith("gh-"):
        owner, _, repo = t[3:].partition("--")
        return (f"the open-source repository {owner}/{repo}, modelled as a company: contributors are people, modules "
                "are services, merged pull requests are changes, CODEOWNERS entries are teams, imports between modules are "
                "dependencies, and modules that change together have CO_CHANGES links. Never present an individual "
                "contributor as a risk")
    row = db.one(dbm.org(t), "MATCH (c:Company) RETURN c.name AS name")
    return f"{row['name']}, a developer-platform company" if row else t


def _person(db: dbm.DB, t: str, uid: str | None) -> dict | None:
    if not uid:
        return None
    from orion import epoch as ep

    return db.one(ep.now(db, t), """MATCH (p:Person {uid: $u}) OPTIONAL MATCH (p)-[:MEMBER_OF]->(x:Team)
                                    RETURN p.uid AS uid, p.name AS name, p.role AS role, x.name AS team""", {"u": uid})


def _context(recall: dict, person: dict | None, org: list[str]) -> str:
    parts = []
    if person:
        parts.append(f"The person asking is {person['name']} ({person.get('role') or 'unknown role'}, team "
                     f"{person.get('team') or 'unknown'}), uid {person['uid']}.")
    if recall["beliefs"]:
        parts.append("You remember about them (confidence fades with age): " +
                     "; ".join(f"{b['key']}: {b['text']} ({b['confidence']:.0%})" for b in recall["beliefs"][:8]))
    if recall["preferences"]:
        parts.append("Their preferences: " + json.dumps(recall["preferences"]))
    if recall["recent_turns"]:
        parts.append("This conversation so far:\n" + "\n".join(f"- {x['role']}: {x['text'][:300]}" for x in recall["recent_turns"]))
    if recall.get("relevant_turns"):
        parts.append("Earlier conversations about the same things:\n" + "\n".join(
            f"- {x['at'][:10]} ({x['why']}): asked \"{x['text'][:200]}\""
            + (f"; you answered \"{(x.get('answer') or '')[:240]}\"" if x.get("answer") else "")
            for x in recall["relevant_turns"]))
    if org:
        parts.append("What the organisation has simulated before about this:\n" + "\n".join(f"- {s}" for s in org))
    if recall["playbooks"]:
        parts.append("Tool sequences that produced verified answers for this kind of question before: " +
                     "; ".join(f"{p['playbook']} ({p['successes']}x)" for p in recall["playbooks"]))
    return "\n".join(parts)


def org_findings(db: dbm.DB, t: str, entities: list[dict], emit) -> list[str]:
    """What was simulated before about these entities; when something it relied on changed, run it again."""
    from orion import universe as uv

    out = []
    for f in findings.about(db, t, [e["uid"] for e in entities]):
        rerun = None
        if f["since"]:
            emit({"type": "status", "agent": "navigator",
                  "text": f"re-running '{f['title']}': {len(f['since'])} fact(s) changed since {f['at'][:10]}"})
            try:
                r = uv.fork(db, t, json.loads(f["ops"]), title=f["title"], created_by="navigator:recall")
                rerun = {"uid": r["uid"], "risk": r["diff"]["risk"]["score"], "broken": [b["service"] for b in r["diff"]["broken"]]}
            except Exception:
                rerun = None
        out.append(findings.describe(f, rerun))
    return out


def prefetch(ctx: ToolContext, playbook: dict | None, entities: list[dict], emit) -> list[tuple[str, dict, dict]]:
    if not playbook or not entities:
        return []
    calls = []
    for tool in playbook["tools"]:
        if tool not in PREFETCH:
            continue
        label, arg = PREFETCH[tool]
        for e in entities:
            if label is None or e["label"] == label:
                calls.append((tool, json.dumps({arg: e["name"]})))
                break
    calls = list(dict.fromkeys(calls))
    if not calls:
        return []
    emit({"type": "status", "agent": "navigator", "text": f"playbook '{playbook['name']}': pre-running {len(calls)} tool(s)"})
    with ThreadPoolExecutor(PARALLEL) as ex:
        return list(ex.map(lambda c: (c[0], json.loads(c[1]), call_tool(ctx, c[0], json.loads(c[1]))), calls))


def answer(db: dbm.DB, t: str, question: str, user: str | None = None, session: str | None = None,
           on_event: Callable[[dict], None] | None = None) -> dict:
    emit = on_event or (lambda e: None)
    t0 = time.perf_counter()
    ctx = ToolContext(db, t, user=user, on_event=emit)
    now = ctx.now()
    session = session or (memory.start_session(db, t, user, now) if user else None)
    empty = {"recent_turns": [], "relevant_turns": [], "beliefs": [], "preferences": {}, "playbooks": []}
    recall = memory.recall(db, t, user, question=question, session=session, now=now) if user else empty
    person = _person(db, t, user)
    qtype = memory.question_type(question)

    reused = _reuse(db, t, question, user, session, now, emit, t0)
    if reused:
        return reused

    ctx.task = blackboard.post(db, t, "ask", {"question": question, "user": user}, posted_by=user or "api")
    blackboard.claim(db, t, "navigator", ["ask"], uid=ctx.task)
    entities = typed.mentioned(db, t, question)
    org = org_findings(db, t, entities, emit)
    pre = prefetch(ctx, memory.playbook(db, t, user, qtype) if user else None, entities, emit)

    context = f"Company clock: {now}\n" + _context(recall, person, org)
    if pre:
        context += "\nAlready run for you by a playbook (cite their evidence ids like any other):\n" + "\n".join(
            f"<result tool=\"{x}\" args='{json.dumps(a)}'>{to_json(r)}</result>" for x, a, r in pre)
    chat = llm.Chat(SYSTEM.format(company=company_name(db, t)), tool_specs(TOOLS) + [SUBMIT],
                    f"<context>\n{context}\n</context>\n\n{question}")
    emit({"type": "status", "agent": "navigator", "text": "planning"})

    submitted, last_text, steps = None, "", 0
    usage = {"input": 0, "output": 0, "cache_read": 0}
    for step in range(MAX_STEPS):
        try:
            turn = chat.step()
        except llm.Refused as e:
            emit({"type": "error", "text": f"the model declined ({e})"})
            blackboard.complete(db, t, ctx.task, {"error": str(e)}, f"declined: {e}", ok=False)
            return {"error": f"declined: {e}"}
        steps += 1
        for k in ("input", "output"):
            usage[k] += turn.usage.get(k, 0)
        if turn.thinking:
            emit({"type": "thinking", "agent": "navigator", "text": turn.thinking})
        if turn.text.strip():
            last_text = turn.text
            emit({"type": "narration", "agent": "navigator", "text": turn.text})
        if not turn.calls:
            if submitted is None and step < MAX_STEPS - 1:
                chat.say("Please call submit_answer with your claims and their evidence ids.")
                continue
            break
        work = [c for c in turn.calls if c.name != "submit_answer"]
        for c in work:
            if c.name in TOOLS:  # a model sometimes calls a tool it wasn't given: it gets an error, not a step on screen
                emit({"type": "tool_call", "agent": "navigator", "tool": c.name, "args": c.args})
        with ThreadPoolExecutor(PARALLEL) as ex:
            outs = dict(zip([c.id for c in work], ex.map(lambda c: call_tool(ctx, c.name, dict(c.args))
                                                         if c.name in TOOLS else {"error": f"no tool {c.name}"}, work)))
        results = []
        for c in turn.calls:
            if c.name == "submit_answer":
                submitted = c.args
                results.append((c, "received", False))
            else:
                res = outs[c.id]
                results.append((c, to_json(res), "error" in res))
        chat.respond(results)
        if submitted is not None:
            break

    if submitted is None:
        submitted = {"summary": last_text or "I couldn't finish this answer.", "claims": [], "follow_ups": []}
    claims = _claims(submitted.get("claims"))
    follow_ups = [f for f in (submitted.get("follow_ups") or []) if isinstance(f, str)][:3]

    if claims:
        emit({"type": "status", "agent": "verifier", "text": f"checking {len(claims)} claims against the records"})
    verdicts = verify(db, claims, ctx.evidence, tenant=t)
    for v in verdicts:
        emit({"type": "verdict", "agent": "verifier", "index": v["index"], "verdict": v["verdict"], "reason": v["reason"],
              "kind": v.get("kind"), "check": v.get("check")})

    answer_uid = f"answer:{secrets.token_hex(5)}"
    by_eid = {e["eid"]: e for e in ctx.evidence}
    rows = []
    for v, c in zip(verdicts, claims):
        facts = sorted({f for e in v["evidence"] if e in by_eid for f in by_eid[e]["fact_uids"]})
        nodes = sorted({n for e in v["evidence"] if e in by_eid for n in by_eid[e]["node_uids"]})
        reads = sorted(set(nodes) | _typed_reads(db, t, c))
        rows.append({"uid": f"{answer_uid}:c{v['index']}", "text": v["text"], "verdict": v["verdict"], "reason": v["reason"],
                     "evidence": json.dumps(v["evidence"]), "facts": facts, "nodes": json.dumps(nodes[:80]), "reads": reads,
                     "kind": v.get("kind", "free"),
                     "typed": json.dumps({k: c.get(k) for k in ("kind", "subject", "objects", "measure", "value", "exhaustive")}),
                     "check": json.dumps(v.get("check"), default=str) if v.get("check") else None})
    persist(db, t, answer_uid, question, user, now, submitted.get("summary", ""), rows)
    if user:
        touched = [{"uid": n, "name": None} for r in rows for n in r["reads"][:20]]
        memory.add_turn(db, t, user, session, "user", question, now, entities=entities)
        memory.add_turn(db, t, user, session, "assistant", submitted.get("summary", ""), now, answer_uid,
                        entities=[x for x in touched if x["uid"]])
        good = sum(1 for v in verdicts if v["verdict"] in ("verified", "judged"))
        memory.learn_procedure(db, t, user, [c["tool"] for c in ctx.calls if c["ok"]],
                               success=bool(claims) and good >= len(claims) / 2, qtype=qtype)
    result = {
        "answer": answer_uid, "session": session, "question": question, "summary": submitted.get("summary", ""),
        "claims": [{**v, "uid": r["uid"], "facts": r["facts"], "nodes": json.loads(r["nodes"]), "typed": json.loads(r["typed"])}
                   for v, r in zip(verdicts, rows)],
        "follow_ups": follow_ups, "evidence": ctx.evidence, "tool_calls": ctx.calls,
        "universes": [c for c in ctx.calls if c["tool"] in ("fork", "dry_run")], "asof": now,
        "ms": round((time.perf_counter() - t0) * 1000), "usage": usage, "steps": steps, "qtype": qtype,
        "prefetched": [x for x, _, _ in pre], "org_findings": org,
    }
    acted = any(c["tool"] == "dry_run" for c in ctx.calls)
    db.q(dbm.org(t), """MATCH (a:Answer {uid: $a}) SET a.qnorm = $q, a.version = $v, a.payload = $p, a.shared = $shared""",
         {"a": answer_uid, "q": None if acted else _normalize(question), "v": dbm.version(db, t),
          "shared": user is None or not _personal(question),
          "p": json.dumps({k: result[k] for k in ("summary", "claims", "follow_ups", "evidence", "universes")}, default=str)})
    good = sum(1 for v in verdicts if v["verdict"] == "verified")
    blackboard.complete(db, t, ctx.task, {"answer": answer_uid}, f"{answer_uid}: {len(claims)} claim(s), {good} verified by the graph")
    result["task"] = ctx.task
    emit({"type": "answer", **{k: result[k] for k in ("answer", "summary", "claims", "follow_ups", "ms")}})
    return result


def _claims(raw) -> list[dict]:
    """Models sometimes send the claims (or one claim) as a JSON string; accept both, and fill missing fields."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return [{"text": raw, "kind": "free", "evidence": [], "objects": []}]
    out = []
    for c in raw or []:
        if isinstance(c, str):
            try:
                c = json.loads(c)
            except ValueError:
                c = {"text": c, "kind": "free"}
        if isinstance(c, dict) and c.get("text"):
            out.append({"text": c["text"], "evidence": c.get("evidence") or [], "kind": c.get("kind") or "free",
                        "subject": c.get("subject"), "objects": c.get("objects") or [], "measure": c.get("measure"),
                        "value": None if c.get("value") is None else str(c.get("value")),
                        "exhaustive": bool(c.get("exhaustive"))})
    return out


def _typed_reads(db: dbm.DB, t: str, claim: dict) -> set[str]:
    out = set()
    for ref in [claim.get("subject")] + list(claim.get("objects") or []):
        if ref and (u := typed._any_uid(db, dbm.org(t), ref)):
            out.add(u)
    return out


def persist(db: dbm.DB, t: str, answer_uid: str, question: str, user: str | None, at: str, summary: str,
            claims: list[dict]) -> None:
    """(Person)-[:ASKED]->(Answer)-[:MAKES]->(Claim)-[:READ]->(node), and each claim keeps the uids of the facts it
    relied on: a change to any of them reaches every answer that depended on it in one traversal."""
    g = dbm.org(t)
    db.q(g, """CREATE (:Answer {uid: $a, question: $q, asked_by: $u, at: $at, asof: $at, status: 'fresh', summary: $s})""",
         {"a": answer_uid, "q": question, "u": user, "at": at, "s": summary})
    if user:
        db.q(g, "MATCH (p:Person {uid: $u}), (a:Answer {uid: $a}) CREATE (p)-[:ASKED]->(a)", {"u": user, "a": answer_uid})
    if claims:
        db.q(g, """UNWIND $rows AS row MATCH (a:Answer {uid: $a})
                   CREATE (a)-[:MAKES]->(:Claim {uid: row.uid, text: row.text, verdict: row.verdict, reason: row.reason,
                                                 evidence: row.evidence, nodes: row.nodes, kind: row.kind, typed: row.typed,
                                                 check: row.check, facts: row.facts})""",
             {"a": answer_uid, "rows": [{k: v for k, v in r.items() if k != "reads"} for r in claims]})
        db.q(g, """UNWIND $rows AS row MATCH (c:Claim {uid: row.uid})
                   MATCH (x) WHERE x.uid IN row.reads AND NOT x:Answer AND NOT x:Claim AND NOT x:Alias
                   MERGE (c)-[:READ]->(x)""", {"rows": [{"uid": r["uid"], "reads": r["reads"]} for r in claims]})


def _normalize(q: str) -> str:
    return re.sub(r"[^a-z0-9 -]+", "", re.sub(r"\s+", " ", q.lower())).strip()


_PERSONAL = re.compile(r"\b(i|i'm|im|i've|me|my|mine|myself|we|we're|us|our|ours)\b")


def _personal(q: str) -> bool:
    return bool(_PERSONAL.search(q.lower().replace("’", "'")))


def _reuse(db: dbm.DB, t: str, question: str, user: str | None, session: str | None, now: str, emit, t0: float) -> dict | None:
    """Serve a stored answer to the same question while nothing it relied on has changed. No model cost."""
    rows = db.ro(dbm.org(t), """MATCH (a:Answer {qnorm: $q, status: 'fresh'}) WHERE a.asked_by = $u OR a.shared = true
                               RETURN a.uid AS uid, a.at AS at, a.payload AS payload ORDER BY a.at DESC LIMIT 1""",
                 {"q": _normalize(question), "u": user})
    if not rows or not rows[0]["payload"]:
        return None
    payload = json.loads(rows[0]["payload"])
    if any(e["graph"].startswith("universe:") and not db.exists(e["graph"]) for e in payload["evidence"]):
        return None
    uid = rows[0]["uid"]
    emit({"type": "status", "agent": "navigator",
          "text": f"reusing the checked answer from {rows[0]['at']}: nothing it relied on has changed since"})
    if user:
        db.q(dbm.org(t), "MATCH (p:Person {uid: $u}), (a:Answer {uid: $a}) MERGE (p)-[:ASKED]->(a)", {"u": user, "a": uid})
        memory.add_turn(db, t, user, session, "user", question, now)
        memory.add_turn(db, t, user, session, "assistant", payload["summary"], now, uid)
    for c in payload["claims"]:
        emit({"type": "verdict", "agent": "verifier", "index": c["index"], "verdict": c["verdict"], "reason": c["reason"],
              "kind": c.get("kind"), "check": c.get("check")})
    result = {"answer": uid, "session": session, "question": question, **payload, "tool_calls": [], "asof": now,
              "ms": round((time.perf_counter() - t0) * 1000), "reused": True, "usage": {"input": 0, "output": 0, "cache_read": 0}}
    emit({"type": "answer", **{k: result[k] for k in ("answer", "summary", "claims", "follow_ups", "ms")}, "reused": True})
    return result


def reverify(db: dbm.DB, t: str, answer_uid: str, use_llm: bool = True) -> dict:
    """Check a stored answer again, now: typed claims against today's company; a gone receipt makes a claim 'expired'."""
    row = db.one(dbm.org(t), "MATCH (a:Answer {uid: $a}) RETURN a.payload AS p, a.status AS s", {"a": answer_uid})
    if not row or not row["p"]:
        raise KeyError(f"no answer {answer_uid}")
    payload = json.loads(row["p"])
    claims = [{"text": c["text"], "evidence": c.get("evidence", []), **(c.get("typed") or {"kind": "free"})} for c in payload["claims"]]
    verdicts = verify(db, claims, payload["evidence"], tenant=t, use_llm=use_llm, today=True)
    db.q(dbm.org(t), """UNWIND $v AS v MATCH (c:Claim {uid: v.uid}) SET c.verdict = v.verdict, c.reason = v.reason, c.rechecked = true""",
         {"v": [{"uid": c["uid"], "verdict": v["verdict"], "reason": v["reason"]} for c, v in zip(payload["claims"], verdicts)]})
    return {"answer": answer_uid, "status": row["s"],
            "claims": [{"index": v["index"], "text": v["text"], "verdict": v["verdict"], "reason": v["reason"],
                        "before": c["verdict"], "check": v.get("check")} for c, v in zip(payload["claims"], verdicts)]}


def asof(db: dbm.DB, t: str, answer_uid: str, date: str) -> dict:
    """"Was this true on...?": each typed point checked against the company as it was on a date. No model call."""
    row = db.one(dbm.org(t), "MATCH (a:Answer {uid: $a}) RETURN a.payload AS p", {"a": answer_uid})
    if not row or not row["p"]:
        raise KeyError("no such answer")
    out = []
    for c in json.loads(row["p"])["claims"]:
        x = c.get("typed") or {"kind": "free"}
        try:
            r = typed.check(db, t, {"text": c["text"], **x}, asof=date)
            out.append({"index": c["index"], "verdict": r["verdict"], "reason": r["reason"]})
        except typed.CheckError as e:
            out.append({"index": c["index"], "verdict": "unverified" if e.verdict == "free" else e.verdict,
                        "reason": "only points the records can check have a date" if e.verdict == "free" else str(e)})
    return {"answer": answer_uid, "date": date, "claims": out}
