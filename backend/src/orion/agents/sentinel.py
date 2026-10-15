"""The Sentinel (rules, no model): decides which proposed changes of fact to apply, keeps the company current, and
tells people when their answers stop holding.

Authority. A change counts in proportion to who states it:
  - the author is on the team that owns what the change is about (the declared owner of the service, or for a team
    move the team joined or the person's own team): AUTHORITATIVE
  - anyone else: OTHER; hedged statements ("I think...") count less.
At or above APPLY_AT a change is applied; below it, it waits for the owning team in a review queue. A change that
would replace an exclusive fact (a service's owner, a person's team) from someone without authority over it
overwrites nothing: it becomes a Contradiction between the two sources.

Applying closes the old relationship (valid_to = now, never deleted) and opens the new one with the message as its
source. Then every answer with a claim that relied on a closed fact, or that read something the change touched, is
re-checked by the graph with no model call; only claims whose check now fails change, and whoever asked is told.
Anyone watching a question hears whenever any of its marks moves.
"""

from __future__ import annotations

import json
import secrets

from orion import db as dbm
from orion import ops as opsm
from orion.queries import cypher

AUTHORITATIVE, OTHER = 0.95, 0.65
HEDGED_FACTOR = 0.7
APPLY_AT = 0.8
EXCLUSIVE = {"OWNS", "MEMBER_OF"}
PREFIX = {"DEPENDS_ON": "dep", "OWNS": "own", "MEMBER_OF": "mem"}
FAILED = ("contradicted", "expired", "unsupported")
OPEN = "9999-12-31"


def _deck(db: dbm.DB, t: str) -> str:
    from orion.universe import deck

    return deck(db, t)


def responsible_teams(db: dbm.DB, t: str, c: dict) -> list[str]:
    g = dbm.org(t)
    if c["relation"] == "MEMBER_OF":
        return [c["object_uid"]] + [r["t"] for r in db.ro(g, f"""MATCH (:Person {{uid: $p}})-[m:MEMBER_OF]->(x:Team)
                                                               WHERE m.valid_to = '{OPEN}' RETURN x.uid AS t""",
                                                          {"p": c["subject_uid"]})]
    svc = c["object_uid"] if c["relation"] == "OWNS" else c["subject_uid"]
    return [r["t"] for r in db.ro(g, f"""MATCH (x:Team)-[o:OWNS]->(:Service {{uid: $s}})
                                        WHERE o.valid_to = '{OPEN}' AND o.declared = true RETURN x.uid AS t""", {"s": svc})]


def authority(db: dbm.DB, t: str, c: dict, author: str | None) -> tuple[float, str]:
    if not author:
        return OTHER, "author unknown"
    if c["relation"] == "MEMBER_OF" and c["subject_uid"] == author:
        return AUTHORITATIVE, "about themselves"
    teams = responsible_teams(db, t, c)
    mine = db.ro(dbm.org(t), f"""MATCH (:Person {{uid: $p}})-[m:MEMBER_OF]->(x:Team)
                                WHERE m.valid_to = '{OPEN}' AND x.uid IN $t RETURN x.name AS n""", {"p": author, "t": teams})
    if mine:
        return AUTHORITATIVE, f"the author is on {mine[0]['n']}, which owns it"
    return OTHER, "the author is not on the owning team"


def apply_changes(db: dbm.DB, t: str, source_uid: str, changes: list[dict], ticket_updates: list[dict], now: str,
                  emit=None, author_uid: str | None = None, reviewed_by: str | None = None) -> dict:
    """Apply what clears the bar, queue the rest, record conflicts. `reviewed_by` (someone accepting a queued
    change) applies regardless of confidence."""
    emit = emit or (lambda e: None)
    g = dbm.org(t)
    closed, opened, review, contradictions, applied = [], [], [], [], []
    for c in changes:
        conf, why = (1.0, f"accepted by {reviewed_by}") if reviewed_by else authority(db, t, c, author_uid)
        if c.get("stated") == "hedged" and not reviewed_by:
            conf, why = conf * HEDGED_FACTOR, why + "; hedged"
        rel, a, b = c["relation"], c["subject_uid"], c["object_uid"]
        la, lb = c["subject_label"], c["object_label"]
        conflict = []
        if c["change"] == "starts" and rel in EXCLUSIVE:
            anchor = f"(:{la} {{uid: $a}})-[r:{rel}]->(y)" if rel == "MEMBER_OF" else f"(y)-[r:{rel}]->(:{lb} {{uid: $b}})"
            conflict = db.ro(g, f"""MATCH {anchor} WHERE r.valid_to = '{OPEN}' AND y.uid <> $other
                                      AND (type(r) <> 'OWNS' OR r.declared = true)
                                    OPTIONAL MATCH (src:Source {{uid: r.src}})
                                    RETURN r.uid AS fact, y.name AS current, src.uid AS source,
                                           coalesce(src.title, src.channel) AS source_title""",
                             {"a": a, "b": b, "other": b if rel == "MEMBER_OF" else a})
        if conflict and conf < AUTHORITATIVE and not reviewed_by:
            cu = f"contra:{secrets.token_hex(4)}"
            summary = (f"{c.get('quote') or 'A message'} says {c['subject']} {rel.lower().replace('_', ' ')} {c['object']}, "
                       f"but {conflict[0]['source_title'] or 'an existing source'} says {conflict[0]['current']}.")
            db.q(g, """MATCH (new:Source {uid: $src})
                       CREATE (k:Contradiction {uid: $u, summary: $s, topic: $s, at: $now, status: 'open', proposed: $p})-[:BETWEEN]->(new)
                       WITH k OPTIONAL MATCH (old:Source {uid: $old})
                       FOREACH (_ IN CASE WHEN old IS NULL THEN [] ELSE [1] END | CREATE (k)-[:BETWEEN]->(old))
                       WITH k MATCH (x {uid: $about}) CREATE (k)-[:ABOUT]->(x)""",
                 {"src": source_uid, "u": cu, "s": summary, "now": now, "p": json.dumps(c), "old": conflict[0]["source"],
                  "about": b if rel != "MEMBER_OF" else a})
            contradictions.append({"uid": cu, "summary": summary})
            emit({"type": "contradiction", "agent": "sentinel", "uid": cu, "summary": summary})
            continue
        if conf < APPLY_AT:
            ru = _queue_review(db, t, c, source_uid, author_uid, conf, why, now)
            review.append({"uid": ru, "change": {k: c[k] for k in ("relation", "subject", "object", "change")},
                           "confidence": round(conf, 2), "why": why})
            emit({"type": "review_queued", "agent": "sentinel", "uid": ru, "confidence": round(conf, 2), "why": why,
                  "relation": rel, "subject": c["subject"], "object": c["object"]})
            continue
        if c["change"] == "stops" or conflict:
            if c["change"] == "stops":
                q, params = f"MATCH (:{la} {{uid: $a}})-[r:{rel}]->(:{lb} {{uid: $b}})", {"a": a, "b": b}
            elif rel == "MEMBER_OF":
                q, params = f"MATCH (:{la} {{uid: $a}})-[r:{rel}]->()", {"a": a}
            else:
                q, params = f"MATCH ()-[r:{rel}]->(:{lb} {{uid: $b}})", {"b": b}
            rows = db.q(g, f"""{q} WHERE r.valid_to = '{OPEN}' AND (type(r) <> 'OWNS' OR r.declared = true)
                              SET r.valid_to = $now, r.closed_by = $src RETURN r.uid AS uid""",
                        params | {"now": now, "src": source_uid})
            for r in rows:
                closed.append(r["uid"])
                emit({"type": "fact_closed", "agent": "sentinel", "fact": r["uid"], "relation": rel, "subject": c["subject"],
                      "object": c["object"], "confidence": round(conf, 2), "why": why})
            applied.append(c)
            if c["change"] == "stops":
                continue
        exists = db.ro(g, f"""MATCH (:{la} {{uid: $a}})-[r:{rel}]->(:{lb} {{uid: $b}}) WHERE r.valid_to = '{OPEN}'
                              RETURN r.uid AS uid""", {"a": a, "b": b})
        if exists:
            continue
        uid = f"{PREFIX[rel]}:{a.split(':', 1)[1]}->{b.split(':', 1)[1]}@{now}"
        props = {"declared": bool(c.get("declared")), "kind": c.get("kind") or "sync"} if rel == "DEPENDS_ON" else \
                {"declared": True} if rel == "OWNS" else {}
        db.q(g, f"""MATCH (x:{la} {{uid: $a}}), (y:{lb} {{uid: $b}})
                    CREATE (x)-[r:{rel}]->(y)
                    SET r += $props, r.uid = $uid, r.valid_from = $now, r.valid_to = '{OPEN}', r.recorded_at = $now,
                        r.src = $src, r.quote = $q, r.confidence = $conf, r.authority = $why""",
             {"a": a, "b": b, "src": source_uid, "uid": uid, "now": now, "props": props, "q": c.get("quote", ""),
              "conf": round(conf, 2), "why": why})
        opened.append(uid)
        if c not in applied:
            applied.append(c)
        emit({"type": "fact_opened", "agent": "sentinel", "fact": uid, "relation": rel, "subject": c["subject"],
              "object": c["object"], "confidence": round(conf, 2), "why": why})
    for tk in ticket_updates:
        db.q(g, "MATCH (k:Ticket {uid: $u}) SET k.status = $s, k.updated_at = $now", {"u": tk["uid"], "s": tk["status"], "now": now})
    wrote = closed or opened or ticket_updates or contradictions
    version = dbm.bump(db, t) if wrote else dbm.version(db, t)
    touched = sorted({u for c in applied for u in (c["subject_uid"], c["object_uid"])} | {x["uid"] for x in ticket_updates})
    notifications = after_change(db, t, closed, touched, source_uid, now, emit) if wrote else []
    return {"closed": closed, "opened": opened, "review": review, "contradictions": contradictions,
            "notifications": notifications, "version": version}


def after_change(db: dbm.DB, t: str, closed: list[str], touched: list[str], source_uid: str, now: str,
                 emit=None) -> list[dict]:
    """The company changed: re-check the answers that relied on what changed, and the watched ones."""
    done: set = set()
    out = expire_answers(db, t, closed, source_uid, now, emit, done)
    out += expire_for_nodes(db, t, touched, source_uid, now, emit, done=done)
    out += recheck_watched(db, t, source_uid, now, emit, done)
    return out


def _queue_review(db: dbm.DB, t: str, c: dict, source_uid: str, author_uid: str | None, conf: float, why: str, now: str) -> str:
    uid = f"review:{secrets.token_hex(4)}"
    db.q(_deck(db, t), """CREATE (:Review {uid: $u, change: $c, source_uid: $src, author_uid: $a, confidence: $conf,
                                           why: $why, at: $now, status: 'pending'})""",
         {"u": uid, "c": json.dumps(c), "src": source_uid, "a": author_uid, "conf": round(conf, 2), "why": why, "now": now})
    return uid


def reviews(db: dbm.DB, t: str, status: str = "pending") -> list[dict]:
    rows = db.ro(_deck(db, t), "MATCH (r:Review {status: $s}) RETURN properties(r) AS r ORDER BY r.at DESC", {"s": status})
    out = []
    for r in rows:
        c = json.loads(r["r"]["change"])
        teams = responsible_teams(db, t, c)
        names = [x["n"] for x in db.ro(dbm.org(t), "MATCH (x:Team) WHERE x.uid IN $t RETURN x.name AS n", {"t": teams})]
        out.append({**r["r"], "change": c, "deciders": names})
    return out


def decide_review(db: dbm.DB, t: str, uid: str, by: str, accept: bool) -> dict:
    row = db.one(_deck(db, t), "MATCH (r:Review {uid: $u, status: 'pending'}) RETURN properties(r) AS r", {"u": uid})
    if not row:
        raise KeyError(f"no pending review {uid}")
    r = row["r"]
    change = json.loads(r["change"])
    may, _ = authority(db, t, change, by)
    if may < AUTHORITATIVE and not (not accept and by == r.get("author_uid")):
        raise PermissionError("only the team responsible for this can decide it")
    db.q(_deck(db, t), "MATCH (r:Review {uid: $u, status: 'pending'}) SET r.status = $s, r.decided_by = $by",
         {"u": uid, "s": "accepted" if accept else "rejected", "by": by})
    if not accept:
        return {"review": uid, "status": "rejected"}
    out = apply_changes(db, t, r["source_uid"], [change], [], dbm.tick(db, t), author_uid=r.get("author_uid"), reviewed_by=by)
    return {"review": uid, "status": "accepted", **out}


# ---------------------------------------------------------------- re-checking answers

def recheck(db: dbm.DB, t: str, answer_uid: str, now: str) -> dict:
    """Re-run one stored answer's checks on today's company, with no model calls. Only a claim whose check now
    fails changes; the rest keep their mark, "checked as of" now."""
    from orion.agents.verifier import verify

    row = db.one(dbm.org(t), "MATCH (a:Answer {uid: $a}) RETURN a.payload AS p", {"a": answer_uid})
    if not row or not row["p"]:
        return {"broken": [], "reasons": [], "changes": []}
    payload = json.loads(row["p"])
    claims = [{"text": c["text"], "evidence": c.get("evidence", []), **(c.get("typed") or {"kind": "free"})}
              for c in payload["claims"]]
    verdicts = verify(db, claims, payload["evidence"], tenant=t, use_llm=False, today=True)
    broken, reasons, updates, changes = [], [], [], []
    for c, v in zip(payload["claims"], verdicts):
        new, why, before = v["verdict"], v["reason"], c["verdict"]
        if new not in FAILED and (new == "unverified" or before in FAILED):
            new, why = before, c["reason"]  # nothing it rests on failed; a judged claim keeps its mark
        elif (new in FAILED and before not in FAILED) or (new == "partial" and before == "verified"):
            broken.append(c["text"])
            reasons.append(why)
        if new != before:
            changes.append({"text": c["text"], "before": before, "after": new, "reason": why})
        updates.append({"uid": c["uid"], "verdict": new, "reason": why, "checked_at": now})
        c["verdict"], c["reason"] = new, why
        if v.get("check"):
            c["check"] = v["check"]
    db.q(dbm.org(t), """UNWIND $v AS v MATCH (c:Claim {uid: v.uid})
                       SET c.verdict = v.verdict, c.reason = v.reason, c.checked_at = v.checked_at,
                           c.stale = v.verdict IN $failed,
                           c.stale_reason = CASE WHEN v.verdict IN $failed THEN v.reason ELSE null END""",
         {"v": updates, "failed": list(FAILED)})
    db.q(dbm.org(t), """MATCH (a:Answer {uid: $a})
                       SET a.payload = $p, a.checked_at = $now,
                           a.status = CASE WHEN $broken THEN 'stale' ELSE a.status END,
                           a.stale_at = CASE WHEN $broken THEN $now ELSE a.stale_at END""",
         {"a": answer_uid, "p": json.dumps(payload, default=str), "now": now, "broken": bool(broken)})
    return {"broken": broken, "reasons": reasons, "changes": changes}


def recheck_answers(db: dbm.DB, t: str, answer_uids: list[str], source_uid: str, now: str, emit=None, fact: str = "",
                    why: str = "a fact it relied on changed", done: set | None = None) -> list[dict]:
    out = []
    for a in answer_uids:
        if done is not None:
            if a in done:
                continue
            done.add(a)
        res = recheck(db, t, a, now)
        out += _tell_watchers(db, t, a, res, source_uid, now, emit, fact)
        if not res["broken"]:
            if emit:
                emit({"type": "answer_rechecked", "agent": "sentinel", "answer_uid": a, "still_true": True})
            continue
        db.q(dbm.org(t), "MATCH (a:Answer {uid: $a}) SET a.stale_because = $src", {"a": a, "src": source_uid})
        for r in db.ro(dbm.org(t), "MATCH (p:Person)-[:ASKED]->(a:Answer {uid: $a}) RETURN p.uid AS p, a.question AS q, a.at AS at",
                       {"a": a}):
            out.append(_notify(db, t, r["p"], a, r["q"], r["at"], res["broken"], fact, source_uid, now, emit, why,
                               reasons=res["reasons"]))
    return out


def _tell_watchers(db: dbm.DB, t: str, answer_uid: str, res: dict, source_uid: str, now: str, emit, fact: str) -> list[dict]:
    if not res.get("changes"):
        return []
    row = db.one(dbm.org(t), "MATCH (a:Answer {uid: $a}) RETURN a.watchers AS w, a.question AS q, a.at AS at", {"a": answer_uid})
    if not row or not row["w"]:
        return []
    return [_notify(db, t, w, answer_uid, row["q"], row["at"], [c["text"] for c in res["changes"]], fact, source_uid, now,
                    emit, "watch: a question you watch was re-checked", reasons=[c["reason"] for c in res["changes"]],
                    kind="watch", changes=res["changes"]) for w in row["w"]]


def recheck_watched(db: dbm.DB, t: str, source_uid: str, now: str, emit=None, done: set | None = None, fact: str = "") -> list[dict]:
    out = []
    for r in db.ro(dbm.org(t), "MATCH (a:Answer) WHERE size(coalesce(a.watchers, [])) > 0 RETURN a.uid AS uid"):
        a = r["uid"]
        if done is not None:
            if a in done:
                continue
            done.add(a)
        out += _tell_watchers(db, t, a, recheck(db, t, a, now), source_uid, now, emit, fact)
    return out


def expire_answers(db: dbm.DB, t: str, fact_uids: list[str], source_uid: str, now: str, emit=None,
                   done: set | None = None) -> list[dict]:
    out = []
    for f in fact_uids or []:
        answers = [r["uid"] for r in db.ro(dbm.org(t), cypher("stale_answers"), {"fact_uid": f})]
        out += recheck_answers(db, t, answers, source_uid, now, emit, f, "a fact it relied on was closed", done)
    return out


def expire_for_nodes(db: dbm.DB, t: str, node_uids: list[str], source_uid: str, now: str, emit=None,
                     fact: str | None = None, done: set | None = None) -> list[dict]:
    if not node_uids:
        return []
    rows = db.ro(dbm.org(t), """MATCH (a:Answer {status: 'fresh'})-[:MAKES]->(:Claim)-[:READ]->(x) WHERE x.uid IN $n
                               RETURN a.uid AS a, collect(DISTINCT coalesce(x.name, x.key, x.uid)) AS where""",
                 {"n": node_uids})
    out = []
    for r in rows:
        out += recheck_answers(db, t, [r["a"]], source_uid, now, emit, fact or "",
                               "something it read changed: " + ", ".join(r["where"][:3]), done)
    return out


def _notify(db: dbm.DB, t: str, asker: str, answer_uid: str, question: str, at: str, broken: list[str], fact: str,
            source_uid: str, now: str, emit, why: str, reasons: list[str] | None = None, kind: str = "expired",
            changes: list[dict] | None = None) -> dict:
    emit = emit or (lambda e: None)
    total = db.one(dbm.org(t), "MATCH (:Answer {uid: $a})-[:MAKES]->(c:Claim) RETURN count(c) AS n", {"a": answer_uid})["n"]
    note = {"uid": f"note:{secrets.token_hex(4)}", "user": asker, "answer_uid": answer_uid, "question": question,
            "asked_at": at, "broken_claims": broken, "total_claims": total, "fact": fact, "source_uid": source_uid,
            "at": now, "read": False, "why": why, "reasons": reasons or [], "kind": kind, "changes": changes or []}
    db.q(_deck(db, t), "CREATE (n:Notification) SET n = $n",
         {"n": {k: v for k, v in note.items() if k not in ("broken_claims", "reasons", "changes")}
               | {"broken_claims": "␞".join(broken), "reasons": "␞".join(reasons or []), "changes": json.dumps(changes or [])}})
    emit({"type": "answer_expired", "agent": "sentinel", **note})
    return note


VERB = {"DEPENDS_ON": "relies on", "OWNS": "owns", "MEMBER_OF": "is on", "KNOWS": "knows", "USES": "uses"}


def _what_changed(db: dbm.DB, t: str, fact: str | None, source_uid: str | None) -> str | None:
    g = dbm.org(t)
    if fact:
        row = db.one(g, "MATCH (a)-[r]->(b) WHERE r.uid = $f RETURN type(r) AS type, a.name AS a, b.name AS b, r.valid_to AS vt",
                     {"f": fact})
        if row and row["a"] and row["b"]:
            verb = VERB.get(row["type"], row["type"].lower().replace("_", " "))
            return f"{row['a']} no longer {verb} {row['b']}" if row["vt"] != OPEN else f"{row['a']} {verb} {row['b']}"
    if source_uid:
        row = db.one(g, """MATCH (s:Source {uid: $s}) OPTIONAL MATCH (s)-[:POSTED_BY|WRITTEN_BY]->(p:Person)
                           RETURN s.text AS text, p.name AS author, s.channel AS channel""", {"s": source_uid})
        if row and row["text"]:
            who = " ".join(x for x in (row["author"], f"in {row['channel']}" if row["channel"] else None) if x)
            return f"{who}: “{row['text'][:140]}”" if who else row["text"][:160]
    return None


def inbox(db: dbm.DB, t: str, user: str) -> list[dict]:
    out = []
    for r in db.ro(_deck(db, t), "MATCH (n:Notification {user: $u}) RETURN properties(n) AS n ORDER BY n.at DESC", {"u": user}):
        n = r["n"]
        n["broken_claims"] = [c for c in (n.get("broken_claims") or "").split("␞") if c]
        n["reasons"] = [c for c in (n.get("reasons") or "").split("␞") if c]
        n["changes"] = json.loads(n.get("changes") or "[]")
        n["kind"] = n.get("kind") or "expired"
        n["now"] = _what_changed(db, t, n.get("fact"), n.get("source_uid"))
        out.append(n)
    return out


def mark_read(db: dbm.DB, t: str, uid: str, user: str) -> bool:
    return bool(db.q(_deck(db, t), "MATCH (n:Notification {uid: $u, user: $who}) SET n.read = true RETURN n.uid AS uid",
                     {"u": uid, "who": user}))


def change_from_op(db: dbm.DB, t: str, op: dict) -> dict:
    """A Cartographer-style change from a resolved op (used by tests and repo sync)."""
    g = dbm.org(t)
    names = opsm.names_of(db, g, [op])
    rel = {"add_dependency": "DEPENDS_ON", "remove_dependency": "DEPENDS_ON", "reassign_owner": "OWNS",
           "move_person": "MEMBER_OF"}[op["op"]]
    if rel == "OWNS":
        a, b, la, lb = op["team"], op["service"], "Team", "Service"
    elif rel == "MEMBER_OF":
        a, b, la, lb = op["person"], op["team"], "Person", "Team"
    else:
        a, b, la, lb = op["source"], op["target"], "Service", "Service"
    return {"relation": rel, "subject": names.get(a, a), "subject_uid": a, "subject_label": la, "object": names.get(b, b),
            "object_uid": b, "object_label": lb, "change": "stops" if op["op"] == "remove_dependency" else "starts",
            "stated": "firm", "quote": op.get("quote", ""), "kind": op.get("kind")}
