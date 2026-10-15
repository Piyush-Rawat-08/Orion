"""The answer a visitor finds waiting on the Ask screen.

A real Navigator run (Priya asking what breaks if sso-legacy is switched off), recorded once to world/showcase.json
and filed again on every reset: the what-if it forked is forked again, the Answer and its Claims go back into the org
graph with the facts they relied on, and the question and answer go into Priya's memory as her last conversation.
Nothing about it is special after that: it is re-checked, reused and made stale exactly like an answer asked live, so
posting BILL-207 in #billing still flags it in her inbox.
"""

from __future__ import annotations

import json
import re
import secrets
from pathlib import Path

from orion import claims as typed
from orion import db as dbm
from orion import memory
from orion import universe as uv

FILE = Path(__file__).parent / "world" / "showcase.json"
ASKER = "person:priya-raman"


def seed(db: dbm.DB, t: str, user: str = ASKER) -> str | None:
    """File the recorded answer as `user`'s last conversation; returns the new answer's uid."""
    if not FILE.exists():
        return None
    from orion.agents.navigator import _normalize, _typed_reads, persist

    # recorded on corvane; graph names follow the tenant it is filed into
    raw = re.sub(r"\b(org|epoch|universe|deck|mem):corvane\b", rf"\1:{t}", FILE.read_text())
    rec = json.loads(raw)
    # the what-ifs the answer made, made again on today's company; their ids may differ from the recording's
    old = list(dict.fromkeys(re.findall(rf"universe:{t}:(u\d+)", raw)))
    for prev, call in zip(old, rec["universes"]):
        u = uv.fork(db, t, call["args"]["ops"], title=call["args"].get("title"), created_by=user)
        if u["uid"] != prev:
            raw = raw.replace(f"universe:{t}:{prev}", f"universe:{t}:{u['uid']}").replace(f'"{prev}"', f'"{u["uid"]}"')
    rec = json.loads(raw)

    now = dbm.clock(db, t)
    answer_uid = f"answer:{secrets.token_hex(5)}"
    claims = [{**c, "uid": f"{answer_uid}:c{c['index']}"} for c in rec["claims"]]
    # the recording predates breaks checks saying how each system is hit; read it off the what-if just made
    for c in claims:
        g = (c.get("check") or {}).get("graph") or ""
        if (c.get("typed") or {}).get("kind") == "breaks" and g.startswith("universe:") and db.exists(g):
            c["check"] = {**c["check"], "result": {**(c["check"].get("result") or {}),
                                                   "effects": {r.name: r.effect for r in uv.broken_in(db, g).values()}}}
    rows = [{"uid": c["uid"], "text": c["text"], "verdict": c["verdict"], "reason": c["reason"],
             "evidence": json.dumps(c["evidence"]), "facts": c["facts"], "nodes": json.dumps(c["nodes"][:80]),
             "reads": sorted(set(c["nodes"]) | _typed_reads(db, t, c["typed"])), "kind": c.get("kind", "free"),
             "typed": json.dumps(c["typed"]), "check": json.dumps(c["check"], default=str) if c.get("check") else None}
            for c in claims]
    persist(db, t, answer_uid, rec["question"], user, now, rec["summary"], rows)
    payload = {"summary": rec["summary"], "summary_check": typed.summary_check(db, t, rec["summary"], claims),
               "claims": claims, "follow_ups": rec["follow_ups"], "evidence": rec["evidence"],
               "universes": rec["universes"], "graph": rec.get("graph")}
    db.q(dbm.org(t), "MATCH (a:Answer {uid: $a}) SET a.qnorm = $q, a.version = $v, a.payload = $p, a.shared = true",
         {"a": answer_uid, "q": _normalize(rec["question"]), "v": dbm.version(db, t), "p": json.dumps(payload, default=str)})

    session = memory.start_session(db, t, user, now)
    memory.add_turn(db, t, user, session, "user", rec["question"], now, entities=typed.mentioned(db, t, rec["question"]))
    memory.add_turn(db, t, user, session, "assistant", rec["summary"], now, answer_uid,
                    entities=[{"uid": n, "name": None} for r in rows for n in r["reads"][:20]])
    return answer_uid
