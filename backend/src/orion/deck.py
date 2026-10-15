"""The deck: a blackboard in its own graph (deck:<tenant>) that every agent reads and writes.

    (:Agent {name, role, status, beat})
    (:Task {uid, kind, status: open|claimed|done|failed|dead, payload, result, attempts, created, agent})
    (:Task)-[:FOLLOWS]->(:Task)       message -> extract -> apply, question -> ask -> fork
    (:Review {...})                   changes of fact the Sentinel wouldn't apply on its own

A task is claimed with one write query; FalkorDB runs writes to a graph one at a time, so two workers can never
claim the same task. A task is tried at most three times, then it is dead rather than looping.
"""

from __future__ import annotations

import json
import secrets

from orion import db as dbm

MAX_ATTEMPTS = 3


def _g(db: dbm.DB, t: str) -> str:
    from orion.universe import _deck

    g = _deck(db, t)
    if not db.one(g, "MATCH (a:Agent) RETURN count(a) AS n")["n"]:
        db.q(g, "CREATE INDEX FOR (t:Task) ON (t.uid)")
        db.q(g, "CREATE INDEX FOR (t:Task) ON (t.status)")
        for name, role in (("Navigator", "answers questions, walking the graph"),
                           ("Simulator", "forks the company and diffs universes"),
                           ("Cartographer", "turns new messages into changes of fact"),
                           ("Sentinel", "decides what to apply, queue or flag; re-checks answers"),
                           ("Verifier", "checks every claim against the graph")):
            db.q(g, "MERGE (a:Agent {name: $n}) SET a.role = $r, a.status = 'idle'", {"n": name, "r": role})
    return g


def post(db: dbm.DB, t: str, kind: str, payload: dict, follows: str | None = None, by: str | None = None) -> str:
    g = _g(db, t)
    uid = "task:" + secrets.token_hex(5)
    db.q(g, """CREATE (x:Task {uid: $uid, kind: $kind, status: 'open', payload: $p, attempts: 0, created: $at, by: $by})""",
         {"uid": uid, "kind": kind, "p": json.dumps(payload, default=str), "at": dbm.clock(db, t), "by": by})
    if follows:
        db.q(g, "MATCH (a:Task {uid: $a}), (b:Task {uid: $b}) CREATE (a)-[:FOLLOWS]->(b)", {"a": uid, "b": follows})
    return uid


def claim(db: dbm.DB, t: str, agent: str, kind: str | None = None, uid: str | None = None) -> dict | None:
    """Atomically take one open task (a specific one, or the oldest of a kind)."""
    g = _g(db, t)
    where = "x.uid = $uid" if uid else "x.kind = $kind"
    rows = db.q(g, f"""MATCH (x:Task) WHERE {where} AND x.status = 'open' AND x.attempts < $max
                       WITH x ORDER BY x.created LIMIT 1
                       SET x.status = 'claimed', x.agent = $agent, x.attempts = x.attempts + 1, x.claimed_at = $at
                       WITH x MATCH (a:Agent {{name: $agent}}) SET a.status = 'working', a.beat = $at, a.task = x.uid
                       RETURN x.uid AS uid, x.kind AS kind, x.payload AS payload, x.attempts AS attempts""",
                {"uid": uid, "kind": kind, "agent": agent, "at": dbm.clock(db, t), "max": MAX_ATTEMPTS})
    if not rows:
        return None
    r = rows[0]
    return r | {"payload": json.loads(r["payload"])}


def done(db: dbm.DB, t: str, uid: str, result: dict) -> None:
    g = _g(db, t)
    db.q(g, """MATCH (x:Task {uid: $u}) SET x.status = 'done', x.result = $r, x.done_at = $at
               WITH x MATCH (a:Agent {name: x.agent}) SET a.status = 'idle', a.beat = $at""",
         {"u": uid, "r": json.dumps(result, default=str), "at": dbm.clock(db, t)})


def failed(db: dbm.DB, t: str, uid: str, error: str) -> None:
    g = _g(db, t)
    db.q(g, """MATCH (x:Task {uid: $u})
               SET x.status = CASE WHEN x.attempts >= $max THEN 'dead' ELSE 'open' END, x.error = $e
               WITH x MATCH (a:Agent {name: x.agent}) SET a.status = 'idle'""",
         {"u": uid, "e": error[:500], "max": MAX_ATTEMPTS})


def record(db: dbm.DB, t: str, agent: str, kind: str, payload: dict, result: dict, follows: str | None = None,
           by: str | None = None) -> str:
    """A task an agent did on the spot (an answer, a fork from inside an answer): on the board for everyone to see."""
    uid = post(db, t, kind, payload, follows, by)
    claim(db, t, agent, uid=uid)
    done(db, t, uid, result)
    return uid


def activity(db: dbm.DB, t: str, limit: int = 60) -> dict:
    g = _g(db, t)
    agents = db.ro(g, "MATCH (a:Agent) RETURN a.name AS name, a.role AS role, a.status AS status, a.beat AS beat")
    tasks = db.ro(g, """MATCH (x:Task) OPTIONAL MATCH (x)-[:FOLLOWS]->(p:Task)
                        RETURN x.uid AS uid, x.kind AS kind, x.status AS status, x.agent AS agent, x.created AS created,
                               x.payload AS payload, x.result AS result, x.by AS by, x.attempts AS attempts,
                               p.uid AS follows
                        ORDER BY created DESC, uid DESC LIMIT $n""", {"n": limit})
    for x in tasks:
        x["payload"] = json.loads(x["payload"] or "{}")
        x["result"] = json.loads(x["result"]) if x.get("result") else None
    return {"agents": agents, "tasks": tasks}
