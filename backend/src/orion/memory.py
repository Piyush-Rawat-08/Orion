"""Per-person memory, one graph each (mem:<tenant>:<person>), so nobody can read anyone else's.

    episodic    (:User)-[:HAD]->(:Session)-[:TURN]->(:Turn {role, text, at})-[:ABOUT]->(:Ref {uid})
                Recall for a new question: the current session's last turns, plus earlier exchanges that touched
                the same company entities, ranked by how many they share and then by how recent they are.
    semantic    (:User)-[:BELIEVES]->(:Belief {text, valid_from, valid_to})   "remember that ..." statements;
                stating something new about the same subject closes the old belief, which stays as history.
    procedural  (:Procedure {qtype, tools, successes, failures}): tool sequences that produced checked answers,
                per kind of question; the Navigator is told which one worked best before.

Shared memory between people and agents is the org graph itself: findings from every simulation hang off the
entities they are about (universe.py), and every agent reads them.
"""

from __future__ import annotations

import json
import re

from orion import db as dbm
from orion.aliases import Resolver

QTYPES = [
    ("what_if", r"\b(what if|what breaks|what happens|retire|deprecate|decommission|goes down|outage|leaves?|merge|move)\b"),
    ("who_knows", r"\b(who knows|who owns|expert|bus factor|knowledge|who can|who should)\b"),
    ("why", r"\b(why|decid|decision|adr|reverse|supersede)\b"),
    ("customer", r"\b(customer|waiting|blocked|ticket|escalat)\b"),
    ("history", r"\b(when|used to|back in|as of|history|before|was)\b"),
]


def qtype(question: str) -> str:
    q = question.lower()
    for name, pat in QTYPES:
        if re.search(pat, q):
            return name
    return "general"


def _g(db: dbm.DB, t: str, user: str) -> str:
    g = dbm.mem(t, user)
    if not db.exists(g):
        db.q(g, "CREATE INDEX FOR (r:Ref) ON (r.uid)")
        db.q(g, "CREATE INDEX FOR (s:Session) ON (s.uid)")
        db.q(g, "MERGE (:User {uid: $u})", {"u": user})
    return g


def remember(db: dbm.DB, t: str, user: str, session: str | None, question: str, answer: str, answer_uid: str,
             touched: list[str]) -> None:
    g = _g(db, t, user)
    at = dbm.clock(db, t)
    session = session or "default"
    refs = sorted({u for u in touched if u.split(":")[0] in ("svc", "person", "team", "cust", "dec", "proj", "tkt")})
    db.q(g, """MATCH (u:User {uid: $user}) MERGE (s:Session {uid: $s}) ON CREATE SET s.started = $at
               MERGE (u)-[:HAD]->(s) SET s.last = $at
               CREATE (s)-[:TURN]->(q:Turn {role: 'user', text: $q, at: $at}),
                      (s)-[:TURN]->(a:Turn {role: 'assistant', text: $a, at: $at, answer: $ans}), (q)-[:ANSWERED_BY]->(a)
               WITH q UNWIND $refs AS r MERGE (x:Ref {uid: r}) CREATE (q)-[:ABOUT]->(x)""",
         {"user": user, "s": session, "at": at, "q": question, "a": answer[:2000], "ans": answer_uid, "refs": refs})
    m = re.match(r"\s*(?:please\s+)?remember(?: that)?\s+(.+)", question, re.I)
    if m:
        believe(db, t, user, m.group(1).strip(), refs)


def believe(db: dbm.DB, t: str, user: str, text: str, about: list[str]) -> None:
    """A new belief about the same subjects closes the previous one (bi-temporal: both stay)."""
    g = _g(db, t, user)
    at = dbm.clock(db, t)
    if about:
        db.q(g, """MATCH (:User {uid: $u})-[:BELIEVES]->(b:Belief)-[:ABOUT]->(r:Ref) WHERE r.uid IN $about
                   AND b.valid_to = '9999-12-31' SET b.valid_to = $at""", {"u": user, "about": about, "at": at})
    db.q(g, """MATCH (u:User {uid: $u}) CREATE (u)-[:BELIEVES]->(b:Belief {text: $text, valid_from: $at,
                                                                        valid_to: '9999-12-31'})
               WITH b UNWIND $about AS r MERGE (x:Ref {uid: r}) CREATE (b)-[:ABOUT]->(x)""",
         {"u": user, "text": text, "at": at, "about": about})


def learn_procedure(db: dbm.DB, t: str, user: str, question: str, tools_used: list[str], ok: bool) -> None:
    if not tools_used:
        return
    g = _g(db, t, user)
    seq = json.dumps(list(dict.fromkeys(tools_used)))
    db.q(g, """MERGE (p:Procedure {qtype: $qt, tools: $seq})
               ON CREATE SET p.successes = 0, p.failures = 0
               SET p.successes = p.successes + $s, p.failures = p.failures + $f""",
         {"qt": qtype(question), "seq": seq, "s": 1 if ok else 0, "f": 0 if ok else 1})


def recall(db: dbm.DB, t: str, user: str, question: str, session: str | None) -> dict:
    g = _g(db, t, user)
    from orion import ops as opsm

    res: Resolver = opsm.resolver(db, dbm.org(t))
    refs = res.mentions(question)
    items: list[dict] = []
    recent = db.ro(g, """MATCH (:Session {uid: $s})-[:TURN]->(x:Turn) RETURN x.role AS role, x.text AS text, x.at AS at
                         ORDER BY x.at DESC LIMIT 4""", {"s": session or "default"})
    for r in reversed(recent):
        items.append({"kind": "recent", "role": r["role"], "text": r["text"][:400], "at": r["at"]})
    if refs:
        past = db.ro(g, """MATCH (q:Turn {role: 'user'})-[:ABOUT]->(r:Ref) WHERE r.uid IN $refs
                           MATCH (q)-[:ANSWERED_BY]->(a:Turn) MATCH (s:Session)-[:TURN]->(q)
                           WHERE s.uid <> $s
                           RETURN q.text AS q, a.text AS a, q.at AS at, count(r) AS shared
                           ORDER BY shared DESC, at DESC LIMIT 3""", {"refs": refs, "s": session or "default"})
        for p in past:
            items.append({"kind": "earlier", "text": f"Q: {p['q']}\nA: {p['a'][:400]}", "at": p["at"]})
        found = db.ro(dbm.org(t), """MATCH (f:Finding)-[:ABOUT]->(n) WHERE n.uid IN $refs
                                     RETURN DISTINCT f.universe AS universe, f.title AS title, f.summary AS summary,
                                            f.at AS at ORDER BY at DESC LIMIT 3""", {"refs": refs})
        for f in found:
            items.append({"kind": "finding", "text": f"Simulated before (universe {f['universe']}, {f['at']}): "
                                                     f"{f['title']}: {f['summary']}", "at": f["at"],
                          "universe": f["universe"]})
    beliefs = db.ro(g, """MATCH (:User {uid: $u})-[:BELIEVES]->(b:Belief) WHERE b.valid_to = '9999-12-31'
                          RETURN b.text AS text, b.valid_from AS at ORDER BY at DESC LIMIT 5""", {"u": user})
    for b in beliefs:
        items.append({"kind": "belief", "text": b["text"], "at": b["at"]})
    proc = db.ro(g, """MATCH (p:Procedure {qtype: $qt}) WHERE p.successes > 0
                       RETURN p.tools AS tools, p.successes AS ok, p.failures AS bad
                       ORDER BY toFloat(p.successes) / (p.successes + p.failures) DESC, p.successes DESC LIMIT 1""",
                 {"qt": qtype(question)})
    if proc:
        items.append({"kind": "procedure", "text": "Questions like this were answered with checked claims using: "
                                                   + " -> ".join(json.loads(proc[0]["tools"]))})
    if not items:
        return {"items": [], "text": ""}
    lines = ["What you remember (use it, but check anything that may have changed):"]
    for it in items:
        lines.append(f"- [{it['kind']}] {it['text']}")
    return {"items": items, "text": "\n".join(lines)}


def timeline(db: dbm.DB, t: str, user: str) -> dict:
    g = _g(db, t, user)
    sessions = db.ro(g, """MATCH (:User {uid: $u})-[:HAD]->(s:Session) OPTIONAL MATCH (s)-[:TURN]->(x:Turn {role: 'user'})
                           RETURN s.uid AS uid, s.started AS started, s.last AS last, count(x) AS questions,
                                  collect(x.text)[0..3] AS sample ORDER BY last DESC LIMIT 20""", {"u": user})
    beliefs = db.ro(g, """MATCH (:User {uid: $u})-[:BELIEVES]->(b:Belief) RETURN b.text AS text, b.valid_from AS valid_from,
                          b.valid_to AS valid_to ORDER BY valid_from DESC""", {"u": user})
    procs = db.ro(g, """MATCH (p:Procedure) RETURN p.qtype AS qtype, p.tools AS tools, p.successes AS ok,
                        p.failures AS bad ORDER BY ok DESC""")
    refs = db.ro(g, """MATCH (q:Turn)-[:ABOUT]->(r:Ref) RETURN r.uid AS uid, count(q) AS n ORDER BY n DESC LIMIT 12""")
    return {"sessions": sessions, "beliefs": beliefs, "procedures": [p | {"tools": json.loads(p["tools"])} for p in procs],
            "topics": refs}
