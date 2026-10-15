"""A new message arrives: it becomes a source in the graph, the Cartographer reads it, the Sentinel decides, and
answers that relied on what changed are re-checked. Each step is a task on the deck, chained with FOLLOWS."""

from __future__ import annotations

import secrets

from orion import db as dbm
from orion import deck
from orion import ops as opsm
from orion.agents import cartographer, sentinel
from orion.tools import Ctx


def ingest(db: dbm.DB, t: str, author: str, channel: str, text: str, emit=lambda e: None) -> dict:
    ctx = Ctx(db, t, author)
    at = dbm.tick(db, t)
    uid = "msg:live-" + secrets.token_hex(4)
    db.q(dbm.org(t), """MATCH (p:Person {uid: $a})
                        CREATE (m:Source:Message {uid: $uid, kind: 'message', channel: $ch, at: $at, text: $text,
                                                  title: $ch, live: true})-[:POSTED_BY]->(p)""",
         {"a": author, "uid": uid, "ch": channel, "at": at, "text": text})
    mentions = ctx.resolver().mentions(text)
    if mentions:
        db.q(dbm.org(t), "MATCH (m:Message {uid: $m}) UNWIND $e AS e MATCH (n {uid: e}) CREATE (m)-[:MENTIONS]->(n)",
             {"m": uid, "e": mentions})
    emit({"type": "message", "uid": uid, "at": at, "mentions": mentions})

    task = deck.post(db, t, "extract", {"message": uid, "text": text}, by=author)
    deck.claim(db, t, "Cartographer", uid=task)
    emit({"type": "agent", "agent": "Cartographer", "task": task, "status": "reading"})
    try:
        names = db.ro(ctx.now, "MATCH (s:Service) RETURN s.name AS n")
        teams = db.ro(ctx.now, "MATCH (t:Team) RETURN t.name AS n")
        raw = cartographer.extract(text, [r["n"] for r in names], [r["n"] for r in teams])
    except Exception as e:
        deck.failed(db, t, task, str(e))
        emit({"type": "error", "error": f"Cartographer: {e}"})
        raise
    changes, skipped = [], []
    res = opsm.resolver(db, ctx.now)
    for c in raw:
        op = {"op": c["op"], "service": c["service"]}
        if c["op"] in ("add_dependency", "remove_dependency"):
            op["on"] = c.get("on")
            if c["op"] == "add_dependency":
                op["kind"] = c.get("kind") or "sync"
        else:
            op["team"] = c.get("team")
        try:
            changes.append(opsm.resolve(db, ctx.now, op, res) | {"hedged": c["hedged"], "quote": c["quote"]})
        except opsm.OpError as e:
            skipped.append({"change": c, "why": str(e)})
    deck.done(db, t, task, {"changes": changes, "skipped": skipped})
    emit({"type": "extracted", "changes": changes, "skipped": skipped})

    outcomes = []
    # removals first, so "moved from X to Y" closes the old fact before opening the new one
    for c in sorted(changes, key=lambda c: c["op"] != "remove_dependency"):
        step = deck.post(db, t, "apply", c, follows=task, by=author)
        deck.claim(db, t, "Sentinel", uid=step)
        change = {k: v for k, v in c.items() if k not in ("hedged", "quote")}
        out = sentinel.handle(db, t, uid, author, change | {"hedged": c["hedged"]}, emit)
        deck.done(db, t, step, {k: v for k, v in out.items() if k not in ("owner", "author_team")})
        outcomes.append(out)
    return {"message": uid, "changes": changes, "skipped": skipped, "outcomes": outcomes}
