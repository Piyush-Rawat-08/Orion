"""Per-person memory, one graph each (mem:<tenant>:<person>), so nobody can read anyone else's.

    episodic    (:User)-[:HAD]->(:Session)-[:TURN]->(:Turn {role, text, at, ts, answer_uid})-[:ABOUT]->(:Ref {uid})
                Recall for a new question: the session's last turns, plus earlier exchanges about the same entities.
    semantic    (:User)-[:BELIEVES]->(:Belief {key, text, valid_from, valid_to, confirmed_at})-[:LEARNED_FROM]->(:Turn)
                A new text for a key closes the old belief and supersedes it: every version stays. Confidence halves
                every 120 days until it is stated again. Sessions older than 14 days become one summary belief.
    procedural  (:Procedure {name, qtype, tools, successes, failures})-[:STEP]->(:Step {tool, i}): tool sequences that
                produced checked answers, per kind of question. The best one is pre-run before the next answer.
    preferences (:User)-[:PREFERS]->(:Preference {key, value})
"""

from __future__ import annotations

import re
import secrets
import time
from datetime import datetime, timedelta

from orion import db as dbm

BELIEF_HALF_LIFE_DAYS = 120
CONSOLIDATE_AFTER_DAYS = 14
RECENT_TURNS = 6
RELEVANT_TURNS = 4


def _g(t: str, user: str) -> str:
    return dbm.mem(t, user)


def ensure_user(db: dbm.DB, t: str, user: str) -> str:
    g = _g(t, user)
    if not db.exists(g):
        db.q(g, "CREATE INDEX FOR (r:Ref) ON (r.uid)")
        db.q(g, "CREATE INDEX FOR (s:Session) ON (s.uid)")
        db.q(g, "CREATE INDEX FOR (x:Turn) ON (x.uid)")
    db.q(g, "MERGE (:User {uid: $u})", {"u": user})
    return g


def start_session(db: dbm.DB, t: str, user: str, at: str) -> str:
    g = ensure_user(db, t, user)
    uid = f"session:{secrets.token_hex(5)}"
    db.q(g, "MATCH (u:User {uid: $u}) CREATE (u)-[:HAD]->(:Session {uid: $s, started_at: $at})", {"u": user, "s": uid, "at": at})
    consolidate(db, t, user, at)
    return uid


def add_turn(db: dbm.DB, t: str, user: str, session: str | None, role: str, text: str, at: str,
             answer_uid: str | None = None, entities: list[dict] | None = None) -> str:
    g = ensure_user(db, t, user)
    session = session or start_session(db, t, user, at)
    uid = f"turn:{secrets.token_hex(6)}"
    db.q(g, """MATCH (u:User {uid: $u}) MERGE (s:Session {uid: $s}) ON CREATE SET s.started_at = $at
               MERGE (u)-[:HAD]->(s)
               CREATE (s)-[:TURN]->(:Turn {uid: $uid, role: $role, text: $text, at: $at, ts: $ts, answer_uid: $a})""",
         {"u": user, "s": session, "at": at, "uid": uid, "role": role, "text": text[:4000], "ts": time.time(),
          "a": answer_uid})
    refs = [e for e in entities or [] if e.get("uid")]
    if refs:
        db.q(g, """MATCH (x:Turn {uid: $t}) UNWIND $refs AS r MERGE (ref:Ref {uid: r.uid}) ON CREATE SET ref.name = r.name
                   MERGE (x)-[:ABOUT]->(ref)""", {"t": uid, "refs": [{"uid": e["uid"], "name": e.get("name")} for e in refs]})
    return uid


def _days(a: str, b: str) -> float:
    try:
        return max(0.0, (datetime.fromisoformat(b[:16]) - datetime.fromisoformat(a[:16])).total_seconds() / 86400)
    except (ValueError, TypeError):
        return 0.0


def remember(db: dbm.DB, t: str, user: str, key: str, text: str, at: str, kind: str = "belief",
             learned_from: str | None = None) -> dict:
    """Store a belief (or a preference). The same text confirms it; a different one supersedes it."""
    g = ensure_user(db, t, user)
    if kind == "preference":
        db.q(g, "MATCH (u:User {uid: $u}) MERGE (u)-[:PREFERS]->(p:Preference {key: $k}) SET p.value = $v, p.at = $at",
             {"u": user, "k": key, "v": text, "at": at})
        return {"key": key, "status": "preference"}
    cur = db.ro(g, """MATCH (:User {uid: $u})-[:BELIEVES]->(b:Belief {key: $k}) WHERE b.valid_to IS NULL
                      RETURN b.uid AS uid, b.text AS text""", {"u": user, "k": key})
    if cur and cur[0]["text"].strip().lower() == text.strip().lower():
        db.q(g, "MATCH (b:Belief {uid: $b}) SET b.confirmed_at = $at", {"b": cur[0]["uid"], "at": at})
        return {"key": key, "status": "confirmed", "uid": cur[0]["uid"]}
    if learned_from is None:
        last = db.ro(g, """MATCH (:User {uid: $u})-[:HAD]->(:Session)-[:TURN]->(x:Turn {role: 'user'})
                           RETURN x.uid AS uid ORDER BY x.ts DESC LIMIT 1""", {"u": user})
        learned_from = last[0]["uid"] if last else None
    uid = f"belief:{secrets.token_hex(5)}"
    db.q(g, """MATCH (u:User {uid: $u})
               CREATE (u)-[:BELIEVES]->(b:Belief {uid: $b, key: $k, text: $v, valid_from: $at, confirmed_at: $at,
                                                  contradicts_previous: $c})
               WITH b OPTIONAL MATCH (x:Turn {uid: $t})
               FOREACH (_ IN CASE WHEN x IS NULL THEN [] ELSE [1] END | CREATE (b)-[:LEARNED_FROM]->(x))""",
         {"u": user, "b": uid, "k": key, "v": text, "at": at, "t": learned_from, "c": bool(cur)})
    if cur:
        db.q(g, """MATCH (old:Belief {uid: $o}), (new:Belief {uid: $n}) SET old.valid_to = $at CREATE (new)-[:SUPERSEDES]->(old)""",
             {"o": cur[0]["uid"], "n": uid, "at": at})
    return {"key": key, "status": "changed" if cur else "new", "uid": uid, "previous": cur[0]["text"] if cur else None}


def beliefs(db: dbm.DB, t: str, user: str, now: str | None = None) -> list[dict]:
    g = _g(t, user)
    if not db.exists(g):
        return []
    rows = db.ro(g, """MATCH (:User {uid: $u})-[:BELIEVES]->(b:Belief) WHERE b.valid_to IS NULL
                       RETURN b.key AS key, b.text AS text, b.confirmed_at AS confirmed_at, b.valid_from AS since""",
                 {"u": user})
    for r in rows:
        age = _days(r["confirmed_at"] or r["since"], now) if now else 0.0
        r["confidence"] = round(0.5 ** (age / BELIEF_HALF_LIFE_DAYS), 2)
    return sorted(rows, key=lambda r: -r["confidence"])


def belief_history(db: dbm.DB, t: str, user: str) -> list[dict]:
    g = _g(t, user)
    if not db.exists(g):
        return []
    return db.ro(g, """MATCH (:User {uid: $u})-[:BELIEVES]->(b:Belief)
                       OPTIONAL MATCH (b)-[:LEARNED_FROM]->(x:Turn)
                       OPTIONAL MATCH (b)-[:SUPERSEDES]->(prev:Belief)
                       RETURN b.key AS key, b.text AS text, b.valid_from AS valid_from, b.valid_to AS valid_to,
                              b.contradicts_previous AS changed, prev.text AS replaced, x.text AS learned_from,
                              x.at AS learned_at
                       ORDER BY key, valid_from, coalesce(valid_to, '9999')""", {"u": user})


def _shift(at: str, days: int) -> str:
    try:
        return (datetime.fromisoformat(at[:16]) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M")
    except ValueError:
        return at


def consolidate(db: dbm.DB, t: str, user: str, now: str, older_than_days: int = CONSOLIDATE_AFTER_DAYS) -> int:
    """Sessions older than two weeks become one summary belief each, so recall keeps the gist."""
    g = _g(t, user)
    if not db.exists(g):
        return 0
    old = db.ro(g, """MATCH (:User {uid: $u})-[:HAD]->(s:Session) WHERE s.consolidated IS NULL AND s.started_at < $cut
                      OPTIONAL MATCH (s)-[:TURN]->(x:Turn) OPTIONAL MATCH (x)-[:ABOUT]->(r:Ref)
                      WITH s, collect(DISTINCT r.name) AS about, collect(x) AS turns
                      RETURN s.uid AS uid, s.started_at AS at, about,
                             [x IN turns WHERE x.role = 'user' | x.text] AS asked,
                             [x IN turns WHERE x.role = 'assistant' | x.text] AS said""",
                {"u": user, "cut": _shift(now, -older_than_days)})
    for s in old:
        if s["asked"]:
            text = (f"On {s['at'][:10]} you asked {len(s['asked'])} question(s)"
                    + (f" about {', '.join(sorted(n for n in s['about'] if n)[:5])}" if s["about"] else "")
                    + (f"; the last answer: {s['said'][-1][:200]}" if s["said"] else ""))
            remember(db, t, user, f"session:{s['at'][:10]}:{s['uid']}", text, now)
        db.q(g, "MATCH (s:Session {uid: $s}) SET s.consolidated = true", {"s": s["uid"]})
    return len(old)


QTYPES = [
    ("whatif", r"\bwhat if\b|\bwhat happens\b|\bif we\b|\bwould break\b|\bdeprecat|\bleaves?\b|\bretire|\bswitch(ed)? off\b"),
    ("act", r"\b(create|open|file|reassign|move|assign|remove|add)\b.*\b(ticket|owner|dependency|team)\b"),
    ("decision", r"\bwhy\b|\bdecid|\bdecision\b|\badr-?\d+|\breversed?\b|\bsupersed"),
    ("people", r"\bwho\b|\bknows?\b|\bowns?\b|\bon[- ]call\b|\bbus factor\b|\bexpert"),
    ("customer", r"\bcustomer\b|\bclient\b|\bescalat|\bwaiting\b"),
    ("history", r"\bas of\b|\bin (january|february|march|april|may|june|july|august|september|october)\b|\blast "
                r"(week|month|quarter)\b|\bback in\b|\bused to\b"),
]


def question_type(text: str) -> str:
    low = (text or "").lower()
    for name, rx in QTYPES:
        if re.search(rx, low):
            return name
    return "general"


def learn_procedure(db: dbm.DB, t: str, user: str, tools: list[str], success: bool, qtype: str = "general") -> None:
    steps = [x for i, x in enumerate(tools) if i == 0 or tools[i - 1] != x][:8]
    if len(steps) < 2:
        return
    g = ensure_user(db, t, user)
    name = f"{qtype}: " + " → ".join(steps)
    field = "successes" if success else "failures"
    stamp = secrets.token_hex(8)
    db.q(g, f"""MERGE (p:Procedure {{name: $n}})
                ON CREATE SET p.successes = 0, p.failures = 0, p.tools = $tools, p.qtype = $qt, p.created = $c
                SET p.{field} = p.{field} + 1
                WITH p WHERE p.created = $c
                UNWIND range(0, size($tools) - 1) AS i
                CREATE (p)-[:STEP {{i: i}}]->(:Step {{tool: $tools[i], i: i}})""",
         {"n": name, "tools": steps, "qt": qtype, "c": stamp})


def playbook(db: dbm.DB, t: str, user: str, qtype: str) -> dict | None:
    g = _g(t, user)
    if not db.exists(g):
        return None
    rows = db.ro(g, """MATCH (p:Procedure {qtype: $q}) WHERE p.successes >= 2 AND p.successes > p.failures
                       RETURN p.name AS name, p.tools AS tools, p.successes AS successes ORDER BY p.successes DESC LIMIT 1""",
                 {"q": qtype})
    return rows[0] if rows else None


def recall(db: dbm.DB, t: str, user: str, limit: int = RELEVANT_TURNS, question: str | None = None,
           session: str | None = None, now: str | None = None) -> dict:
    g = _g(t, user)
    empty = {"recent_turns": [], "relevant_turns": [], "beliefs": [], "preferences": {}, "playbooks": []}
    if not db.exists(g):
        return empty
    if session:
        recent = db.ro(g, """MATCH (:Session {uid: $s})-[:TURN]->(x:Turn) RETURN x.uid AS uid, x.role AS role, x.text AS text,
                             x.at AS at ORDER BY x.ts DESC LIMIT $n""", {"s": session, "n": RECENT_TURNS})
    elif not question:
        recent = db.ro(g, """MATCH (:User {uid: $u})-[:HAD]->(:Session)-[:TURN]->(x:Turn) RETURN x.uid AS uid,
                             x.role AS role, x.text AS text, x.at AS at ORDER BY x.ts DESC LIMIT $n""", {"u": user, "n": limit})
    else:
        recent = []
    relevant: list[dict] = []
    if question:
        from orion.claims import mentioned

        ents = [e["uid"] for e in mentioned(db, t, question)]
        if ents:
            relevant = db.ro(g, """MATCH (q:Turn {role: 'user'})-[:ABOUT]->(r:Ref) WHERE r.uid IN $e
                                   MATCH (s:Session)-[:TURN]->(q) WHERE $sess IS NULL OR s.uid <> $sess
                                   OPTIONAL MATCH (s)-[:TURN]->(a:Turn {role: 'assistant'}) WHERE a.ts > q.ts
                                   WITH q, count(DISTINCT r) AS shared, collect(a)[0] AS a, collect(DISTINCT r.name) AS names
                                   RETURN q.uid AS uid, q.text AS text, q.at AS at, a.text AS answer,
                                          'about ' + reduce(x = '', n IN names | x + CASE WHEN x = '' THEN '' ELSE ', ' END + n) AS why
                                   ORDER BY shared DESC, at DESC LIMIT $n""",
                               {"e": ents, "sess": session, "n": limit})
    prefs = {r["k"]: r["v"] for r in db.ro(g, "MATCH (:User {uid: $u})-[:PREFERS]->(p) RETURN p.key AS k, p.value AS v",
                                           {"u": user})}
    qtype = question_type(question) if question else None
    procs = db.ro(g, """MATCH (p:Procedure) WHERE p.successes > p.failures AND ($q IS NULL OR p.qtype = $q)
                        RETURN p.name AS playbook, p.successes AS successes, p.qtype AS qtype
                        ORDER BY p.successes DESC LIMIT 5""", {"q": qtype})
    return {"recent_turns": list(reversed(recent)), "relevant_turns": relevant, "beliefs": beliefs(db, t, user, now),
            "preferences": prefs, "playbooks": procs}


def history(db: dbm.DB, t: str, user: str, limit: int = 50) -> list[dict]:
    g = _g(t, user)
    if not db.exists(g):
        return []
    return db.ro(g, """MATCH (:User {uid: $u})-[:HAD]->(s:Session)-[:TURN]->(x:Turn)
                       RETURN s.uid AS session, x.role AS role, x.text AS text, x.at AS at, x.answer_uid AS answer_uid
                       ORDER BY x.ts DESC LIMIT $n""", {"u": user, "n": limit})
