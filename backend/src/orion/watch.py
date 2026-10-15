"""Answers that stay true, or say when they stop being true.

Answers and their claims live in the org graph:

    (:Person)-[:ASKED]->(:Answer)-[:MAKES]->(:Claim)-[:ABOUT]->(entity)

When the company changes (a merge, a live message the Sentinel applies, a repo sync), one traversal from the
touched entities back along ABOUT reaches every claim that relied on them, and each typed claim is checked again
by the graph, with no model call. Only claims whose check now fails change; the rest are stamped as still true
at the new time. A claim about a what-if is replayed on today's company ("no longer breaks invoice-render").
"""

from __future__ import annotations

import json
import secrets

from orion import claims as cl
from orion import db as dbm
from orion.tools import Ctx


def store(db: dbm.DB, t: str, *, user: str | None, question: str, text: str, checked: list[dict], evidence: list[dict],
          session: str | None, meta: dict) -> str:
    uid = "ans:" + secrets.token_hex(5)
    g = dbm.org(t)
    payload = {"evidence": evidence, "meta": meta}
    db.q(g, """CREATE (a:Answer {uid: $uid, question: $q, qnorm: $qn, text: $text, at: $at, session: $session,
                                 status: 'fresh', payload: $payload, asked_by: $user})""",
         {"uid": uid, "q": question, "qn": normalize(question), "text": text, "at": dbm.clock(db, t),
          "session": session, "payload": json.dumps(payload, default=str), "user": user})
    if user:
        db.q(g, "MATCH (a:Answer {uid: $a}), (p:Person {uid: $u}) CREATE (p)-[:ASKED]->(a)", {"a": uid, "u": user})
    for i, c in enumerate(checked):
        cuid = f"{uid}:c{i}"
        db.q(g, """MATCH (a:Answer {uid: $a})
                   CREATE (a)-[:MAKES]->(c:Claim {uid: $uid, i: $i, sentence: $sentence, type: $type, status: $status,
                                                  claim: $claim, result: $result, checked_at: $at, history: '[]'})""",
             {"a": uid, "uid": cuid, "i": i, "sentence": c["claim"]["sentence"], "type": c["claim"]["type"],
              "status": c["result"]["status"], "claim": json.dumps(c["claim"]),
              "result": json.dumps(c["result"], default=str), "at": dbm.clock(db, t)})
        if c["about"]:
            db.q(g, "MATCH (c:Claim {uid: $c}) UNWIND $about AS u MATCH (n {uid: u}) CREATE (c)-[:ABOUT]->(n)",
                 {"c": cuid, "about": c["about"]})
    return uid


def normalize(q: str) -> str:
    return " ".join("".join(ch for ch in q.lower() if ch.isalnum() or ch == " ").split())


def after_change(db: dbm.DB, t: str, touched: list[str], cause: str) -> list[dict]:
    """Re-check every claim about the touched entities. Returns the claims whose verdict or content moved."""
    if not touched:
        return []
    g = dbm.org(t)
    rows = db.q(g, """MATCH (c:Claim)-[:ABOUT]->(n) WHERE n.uid IN $u
                      MATCH (a:Answer)-[:MAKES]->(c)
                      RETURN DISTINCT c.uid AS uid, c.claim AS claim, c.result AS result, c.status AS status,
                             c.history AS history, a.uid AS answer, a.asked_by AS asked_by, a.question AS question""",
                {"u": touched})
    ctx = Ctx(db, t)
    cache: dict = {}
    changed = []
    at = dbm.clock(db, t)
    for r in rows:
        claim, before = json.loads(r["claim"]), json.loads(r["result"])
        if claim["type"] == "text":
            after = {"status": "unconfirmed", "checked_at": at,
                     "why": "something it relied on changed; free text can't be re-checked by the graph"}
        else:
            after = cl.check(ctx, claim, cache=cache)
            if after["status"] == "contradicted" and before["status"] in ("verified", "partial", "outdated"):
                after["status"] = "outdated"  # it was true when it was said; the company changed
        moved = after["status"] != before["status"] or after.get("expected") != before.get("expected")
        history = json.loads(r["history"] or "[]")
        if moved:
            history.append({"at": at, "cause": cause, "before": before, "after": after})
            db.q(g, """MATCH (c:Claim {uid: $c}) SET c.status = $s, c.result = $r, c.checked_at = $at, c.history = $h
                       WITH c MATCH (a:Answer)-[:MAKES]->(c) SET a.status = 'changed', a.changed_at = $at""",
                 {"c": r["uid"], "s": after["status"], "r": json.dumps(after, default=str), "at": at,
                  "h": json.dumps(history, default=str)})
            item = {"answer": r["answer"], "claim": r["uid"], "question": r["question"], "sentence": claim["sentence"],
                    "before": before["status"], "after": after["status"], "why": after.get("why"),
                    "was": before.get("expected"), "now": after.get("expected"), "asked_by": r["asked_by"]}
            changed.append(item)
            _notify(db, t, item, cause)
        else:
            db.q(g, "MATCH (c:Claim {uid: $c}) SET c.checked_at = $at", {"c": r["uid"], "at": at})
    return changed


def _notify(db: dbm.DB, t: str, item: dict, cause: str) -> None:
    if not item["asked_by"]:
        return
    from orion.universe import _deck

    db.q(_deck(db, t), """CREATE (:Notification {uid: $uid, user: $user, answer: $answer, claim: $claim, question: $q,
                                                 sentence: $s, before: $b, after: $a, why: $why, cause: $cause, at: $at,
                                                 read: false})""",
         {"uid": "note:" + secrets.token_hex(5), "user": item["asked_by"], "answer": item["answer"], "claim": item["claim"],
          "q": item["question"], "s": item["sentence"], "b": item["before"], "a": item["after"], "why": item["why"] or "",
          "cause": cause, "at": dbm.clock(db, t)})


def answer(db: dbm.DB, t: str, uid: str) -> dict | None:
    g = dbm.org(t)
    row = db.one(g, "MATCH (a:Answer {uid: $u}) RETURN a", {"u": uid})
    if not row:
        return None
    a = row["a"]
    cs = db.ro(g, """MATCH (:Answer {uid: $u})-[:MAKES]->(c:Claim) OPTIONAL MATCH (c)-[:ABOUT]->(n)
                     RETURN c.uid AS uid, c.i AS i, c.sentence AS sentence, c.type AS type, c.status AS status,
                            c.claim AS claim, c.result AS result, c.checked_at AS checked_at, c.history AS history,
                            collect(n.uid) AS about ORDER BY i""", {"u": uid})
    payload = json.loads(a.get("payload") or "{}")
    return {"uid": a["uid"], "question": a["question"], "text": a["text"], "at": a["at"], "status": a["status"],
            "asked_by": a.get("asked_by"), "session": a.get("session"), "evidence": payload.get("evidence", []),
            "meta": payload.get("meta", {}),
            "claims": [{"uid": c["uid"], "sentence": c["sentence"], "type": c["type"], "status": c["status"],
                        "claim": json.loads(c["claim"]), "result": json.loads(c["result"]), "checked_at": c["checked_at"],
                        "history": json.loads(c["history"] or "[]"), "about": c["about"]} for c in cs]}
