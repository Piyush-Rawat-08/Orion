"""The Sentinel: decides what a proposed change of fact does to the company. No model, only rules.

    authority  0.95 when the author is on the team that owns the service the change is about, 0.6 otherwise,
               halved when the author hedged.
    apply      authority >= 0.8: the change is written into the org graph as facts whose source is the message.
    review     below that, it waits for someone on the owning team to accept or reject it.
    conflict   a removal that contradicts a fact another source stated recently is recorded as a Contradiction
               between the two sources instead of being applied.

After anything is applied, every answer that relied on the touched entities is re-checked (watch.py).
"""

from __future__ import annotations

import json
import secrets

from orion import db as dbm
from orion import ops as opsm
from orion import watch
from orion.tools import Ctx

APPLY_AT = 0.8


def weigh(ctx: Ctx, change: dict, author: str) -> dict:
    db = ctx.db
    svc = change["service"]
    owner = db.one(ctx.now, "MATCH (t:Team)-[:OWNS]->(:Service {uid: $s}) RETURN t.uid AS uid, t.name AS name", {"s": svc})
    mine = db.one(ctx.now, "MATCH (:Person {uid: $p})-[:MEMBER_OF]->(t:Team) RETURN t.uid AS uid, t.name AS name",
                  {"p": author})
    owns = bool(owner and mine and owner["uid"] == mine["uid"])
    authority = (0.95 if owns else 0.6) * (0.5 if change.get("hedged") else 1.0)
    why = (f"{'on' if owns else 'not on'} {owner['name'] if owner else 'the owning team'}, which owns the service"
           + ("; hedged" if change.get("hedged") else ""))
    return {"authority": authority, "owner": owner, "author_team": mine, "why": why}


def handle(db: dbm.DB, t: str, message_uid: str, author: str, change: dict, emit=lambda e: None) -> dict:
    ctx = Ctx(db, t)
    w = weigh(ctx, change, author)
    conflict = _conflict(ctx, change, message_uid)
    if conflict:
        cuid = "contra:" + secrets.token_hex(4)
        db.q(dbm.org(t), """CREATE (c:Contradiction {uid: $u, topic: $topic, at: $at, status: 'open'})
                            WITH c MATCH (a:Source {uid: $a}), (b:Source {uid: $b}) CREATE (c)-[:BETWEEN]->(a), (c)-[:BETWEEN]->(b)
                            WITH c UNWIND $about AS x MATCH (n {uid: x}) CREATE (c)-[:ABOUT]->(n)""",
             {"u": cuid, "topic": conflict["topic"], "at": dbm.clock(db, t), "a": message_uid, "b": conflict["source"],
              "about": [change["service"], change.get("on")]})
        out = {"result": "contradiction", "contradiction": cuid, **w, "topic": conflict["topic"]}
        emit({"type": "sentinel", **_public(out, change)})
        return out
    if w["authority"] >= APPLY_AT:
        out = apply(db, t, change, message_uid) | w
        emit({"type": "sentinel", **_public(out, change)})
        return out
    ruid = "review:" + secrets.token_hex(4)
    from orion.universe import _deck

    db.q(_deck(db, t), """CREATE (:Review {uid: $u, change: $c, source: $s, author: $a, authority: $w, why: $why,
                                           team: $team, status: 'waiting', at: $at})""",
         {"u": ruid, "c": json.dumps(change), "s": message_uid, "a": author, "w": w["authority"], "why": w["why"],
          "team": w["owner"]["uid"] if w["owner"] else None, "at": dbm.clock(db, t)})
    out = {"result": "review", "review": ruid, **w}
    emit({"type": "sentinel", **_public(out, change)})
    return out


def apply(db: dbm.DB, t: str, change: dict, source: str) -> dict:
    at = dbm.tick(db, t)
    opsm.apply_temporal(db, dbm.org(t), change, at, source)
    dbm.bump(db, t)
    touched = sorted({v for k, v in change.items() if k in ("service", "on", "team") and v})
    rechecked = watch.after_change(db, t, touched, cause=source)
    return {"result": "applied", "at": at, "rechecked": rechecked}


def review(db: dbm.DB, t: str, uid: str, user: str, accept: bool) -> dict:
    """Only someone on the team the change is about may accept or reject it."""
    from orion.universe import _deck, who

    g = _deck(db, t)
    r = db.one(g, "MATCH (r:Review {uid: $u}) RETURN r", {"u": uid})
    if not r:
        raise KeyError(uid)
    r = r["r"]
    if r["status"] != "waiting":
        raise ValueError(f"already {r['status']}")
    me = who(db, t, user)
    if r.get("team") and me["team"] != r["team"]:
        raise PermissionError("only the team that owns the service can decide this")
    out = {"result": "rejected"}
    if accept:
        out = apply(db, t, json.loads(r["change"]), r["source"])
    db.q(g, "MATCH (r:Review {uid: $u}) SET r.status = $s, r.by = $by, r.decided_at = $at",
         {"u": uid, "s": "accepted" if accept else "rejected", "by": user, "at": dbm.clock(db, t)})
    return out


def _conflict(ctx: Ctx, change: dict, message_uid: str) -> dict | None:
    """A removal of a dependency someone else asserted in a message in the last 30 days is a disagreement."""
    if change["op"] != "remove_dependency":
        return None
    row = ctx.db.one(ctx.org, """MATCH (:Service {uid: $a})-[r:DEPENDS_ON]->(:Service {uid: $b})
                                 WHERE r.valid_to = '9999-12-31'
                                 MATCH (m:Message {uid: r.src}) WHERE m.uid <> $m AND m.at >= $since
                                 RETURN m.uid AS uid""",
                     {"a": change["service"], "b": change["on"], "m": message_uid,
                      "since": _days_before(dbm.clock(ctx.db, ctx.tenant), 30)})
    if not row:
        return None
    return {"source": row["uid"], "topic": f"Does {change['service'].split(':')[1]} still depend on {change['on'].split(':')[1]}?"}


def _days_before(iso: str, days: int) -> str:
    from datetime import date, timedelta

    return (date.fromisoformat(iso[:10]) - timedelta(days=days)).isoformat()


def _public(out: dict, change: dict) -> dict:
    return {"result": out["result"], "change": change, "authority": out.get("authority"), "why": out.get("why"),
            "rechecked": out.get("rechecked", []), "review": out.get("review"), "contradiction": out.get("contradiction")}
