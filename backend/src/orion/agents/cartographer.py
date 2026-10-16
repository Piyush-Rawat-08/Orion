"""The Cartographer: reads a new message and proposes the changes of fact it states.

Only firm statements about the present count. Plans ("we should"), questions, hypotheticals and jokes propose
nothing; "I think" makes a change hedged, which the Sentinel weighs less. The message becomes a source in the
company graph, every change is a task on the board (extract, then apply, chained with FOLLOWS), and the Sentinel
decides what each does.
"""

from __future__ import annotations

import contextvars
import os
import re
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout

from orion import blackboard
from orion import db as dbm
from orion import llm
from orion import ops as opsm
from orion.world.corvane import day_index

SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["changes", "ticket_updates"],
    "properties": {
        "changes": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["relation", "subject", "object", "change", "stated", "kind", "quote"],
            "properties": {
                "relation": {"type": "string", "enum": ["DEPENDS_ON", "OWNS", "MEMBER_OF"]},
                "subject": {"type": "string", "description": "DEPENDS_ON: the service that relies on the other; OWNS: the team; MEMBER_OF: the person"},
                "object": {"type": "string", "description": "DEPENDS_ON: the service relied on; OWNS: the service; MEMBER_OF: the team"},
                "change": {"type": "string", "enum": ["starts", "stops"]},
                "stated": {"type": "string", "enum": ["firm", "hedged"]},
                "kind": {"anyOf": [{"type": "string", "enum": ["sync", "async", "data"]}, {"type": "null"}]},
                "quote": {"type": "string", "description": "the words this comes from"}}}},
        "ticket_updates": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["key", "status"],
            "properties": {"key": {"type": "string"}, "status": {"type": "string", "enum": ["open", "done"]}}}},
    },
}

SYSTEM = """You read one message from a company's team chat and list the changes of fact it states:
a service starting or stopping relying on another (DEPENDS_ON), a team taking over or giving up a service (OWNS),
a person joining or leaving a team (MEMBER_OF), and tickets it says are done or reopened.
Only firm statements about what is true now count. A plan, a question, a hypothetical, sarcasm or a joke states
nothing. "I think" or "probably" makes a change hedged. Known services: {services}. Known teams: {teams}.
Use those names exactly. Return nothing when nothing changes."""

LABELS = {"DEPENDS_ON": ("Service", "Service"), "OWNS": ("Team", "Service"), "MEMBER_OF": ("Person", "Team")}


EXTRACT_DEADLINE_S = float(os.environ.get("ORION_EXTRACT_DEADLINE", "6"))
_late = ThreadPoolExecutor(max_workers=4, thread_name_prefix="extract")


def extract(text: str, services: list[str], teams: list[str]) -> dict:
    """The changes a message states, read by the model. A model call usually takes a few seconds but sometimes
    twenty; past the deadline, a message in one of the plain shapes the rules know ("X no longer calls Y") is read
    by the rules instead, and the result says which reader it came from."""
    if not llm.available():
        return {**_rules(text, services), "reader": "rules"}
    call = _late.submit(llm.json_call, SYSTEM.format(services=", ".join(services), teams=", ".join(teams)), text, SCHEMA)
    try:
        return {**call.result(timeout=EXTRACT_DEADLINE_S), "reader": "model"}
    except FutureTimeout:
        quick = _rules(text, services)
        if quick["changes"]:
            print(f"model slower than {EXTRACT_DEADLINE_S:.0f}s: read by the rules", flush=True)
            return {**quick, "reader": "rules"}
        return {**call.result(), "reader": "model"}


def _rules(text: str, services: list[str]) -> dict:
    """Without a model: the sentence shapes the demo uses ("X no longer calls Y", "X now gets ... from Y")."""
    names = "|".join(sorted((re.escape(s) for s in services), key=len, reverse=True))
    out = []
    for m in re.finditer(rf"\b({names}|it)\b[^.]*?\bno longer (?:calls|uses|relies on|depends on|talks to)\s+({names})", text, re.I):
        subject = m.group(1)
        if subject.lower() == "it":  # "It no longer calls Y": the system the sentence before was about
            before = [x for x in text[: m.start()].split(".") if x.strip()]
            first = re.search(rf"\b({names})\b", before[-1], re.I) if before else None
            if not first:
                continue
            subject = first.group(1)
        out.append({"relation": "DEPENDS_ON", "subject": subject, "object": m.group(2), "change": "stops",
                    "stated": "firm", "kind": None, "quote": m.group(0)})
    for m in re.finditer(rf"({names})\s+now\s+(?:gets[^.]*?from|uses|calls|relies on|depends on)\s+({names})", text, re.I):
        out.append({"relation": "DEPENDS_ON", "subject": m.group(1), "object": m.group(2), "change": "starts",
                    "stated": "firm", "kind": "sync", "quote": m.group(0)})
    tickets = [{"key": k.upper(), "status": "done"} for k in re.findall(r"\b([A-Z]{2,5}-\d+)\b is (?:done|merged)", text, re.I)]
    return {"changes": out, "ticket_updates": tickets}


def ingest_message(db: dbm.DB, t: str, channel: str, author: str, text: str, emit, posted_by: str | None = None) -> dict:
    """A new message, end to end: stored as a source, read by the Cartographer, decided by the Sentinel."""
    from orion.agents import sentinel

    g = dbm.org(t)
    author_uid = posted_by
    t0 = time.perf_counter()
    lap = lambda what: print(f"message {t}: {what} at {time.perf_counter() - t0:.1f}s", flush=True)  # noqa: E731
    now = dbm.tick(db, t)
    mid = f"msg:live-{secrets.token_hex(4)}"
    db.q(g, """MATCH (p:Person {uid: $a})
               CREATE (m:Source:Message {uid: $m, kind: 'message', channel: $ch, at: $at, text: $text, title: $ch,
                                         live: true, day: $day})-[:POSTED_BY]->(p)""",
         {"a": author_uid, "m": mid, "ch": channel, "at": now, "text": text, "day": day_index(now)})
    res = opsm.resolver(db, g)
    mention_uids = res.mentions(text)
    if mention_uids:
        db.q(g, "MATCH (m:Message {uid: $m}) UNWIND $e AS e MATCH (n {uid: e}) CREATE (m)-[:MENTIONS]->(n)",
             {"m": mid, "e": mention_uids})
    mentions = [r["name"] for r in db.ro(g, "MATCH (n) WHERE n.uid IN $u RETURN coalesce(n.name, n.key) AS name",
                                         {"u": mention_uids})] if mention_uids else []

    lap("stored")
    task = blackboard.post(db, t, "extract", {"message": mid, "text": text}, posted_by=posted_by or "api")
    blackboard.claim(db, t, "cartographer-1", ["extract"], uid=task)
    emit({"type": "status", "agent": "cartographer", "text": f"reading the message in {channel}"})
    from orion import epoch as ep

    lap("task claimed")
    # the message ticked the clock, so today's company is rebuilt; that runs while the model reads (the names it is
    # given come from the records, where a few retired systems are harmless)
    today = _late.submit(contextvars.copy_context().run, ep.now, db, t)
    services = [r["n"] for r in db.ro(g, "MATCH (s:Service) RETURN DISTINCT s.name AS n")]
    teams = [r["n"] for r in db.ro(g, "MATCH (x:Team) RETURN DISTINCT x.name AS n")]
    with dbm.tagged(f"task:{task}"):
        try:
            raw = extract(text, services, teams)
            lap(f"read by the {raw.get('reader')}")
        except Exception as e:
            blackboard.fail(db, t, task, str(e))
            raise
    now_g = today.result()
    lap("today's company checked out")
    changes, skipped = [], []
    for c in raw.get("changes", []):
        la, lb = LABELS[c["relation"]]
        try:
            a = opsm.resolve(db, now_g, la, c["subject"], res)
            b = opsm.resolve(db, now_g, lb, c["object"], res)
        except opsm.ResolveError as e:
            skipped.append({**c, "why": str(e)})
            continue
        names = opsm.names_of(db, g, [{"op": "x", "a": a, "b": b}])
        changes.append({**c, "subject": names.get(a, c["subject"]), "object": names.get(b, c["object"]),
                        "subject_uid": a, "object_uid": b, "subject_label": la, "object_label": lb})
    tickets = []
    for u in raw.get("ticket_updates", []):
        row = db.one(g, "MATCH (k:Ticket) WHERE toUpper(k.key) = toUpper($k) RETURN k.uid AS uid, k.key AS key", {"k": u["key"]})
        if row:
            tickets.append({"uid": row["uid"], "key": row["key"], "status": u["status"]})
    blackboard.complete(db, t, task, {"changes": len(changes), "skipped": len(skipped)},
                        f"{mid}: {len(changes)} change(s) of fact, {len(tickets)} ticket update(s)")
    emit({"type": "extracted", "agent": "cartographer", "message": mid, "mentions": mentions,
          "changes": [{k: c[k] for k in ("relation", "subject", "object", "change", "quote")} for c in changes],
          "ticket_updates": [{"key": x["key"], "status": x["status"]} for x in tickets], "skipped": skipped,
          "reader": raw.get("reader", "model")})
    step = blackboard.post(db, t, "apply", {"message": mid, "changes": len(changes)}, posted_by="cartographer-1", follows=task)
    blackboard.claim(db, t, "sentinel-1", ["apply"], uid=step)
    # removals first, so "moved from X to Y" closes the old fact before opening the new one
    changes.sort(key=lambda c: c["change"] != "stops")
    with dbm.tagged(f"task:{step}"):
        out = sentinel.apply_changes(db, t, mid, changes, tickets, now, emit, author_uid=author_uid)
    blackboard.complete(db, t, step, {k: len(v) if isinstance(v, list) else v for k, v in out.items()},
                        f"closed {len(out['closed'])}, opened {len(out['opened'])}, {len(out['notifications'])} answer(s) told")
    return {"message": mid, **out}
