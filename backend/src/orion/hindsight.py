"""Hindsight: would Orion have caught it? Every incident is replayed against the decision that led to it.

For an incident, the trigger is the decision taken shortly before it that switched off something the incident
was about ("Retire sso-legacy on 2026-03-17", three weeks before invoices stopped rendering). The same change is
then assessed twice on the company as it stood on the day of the decision:

    known   only what had been written down by that day (a what-if at the time would have shown this)
    true    what was actually so, including what was recorded only later

The difference is the blind spot: the facts that were true on the day but written down after it, with the source
that finally recorded them. Then the safe path is searched on the true company of that day: what Orion would have
recommended doing first.
"""

from __future__ import annotations

import re
from datetime import date

from orion import db as dbm
from orion import epoch as ep
from orion import planner

RETIRES = re.compile(r"\b(retire|decommission|switch off|shut down|sunset|turn off)\b", re.I)
LOOKBACK_DAYS = 45


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b[:10]) - date.fromisoformat(a[:10])).days


def incidents(db: dbm.DB, t: str) -> list[dict]:
    """Every incident with the decision that preceded it, if one switched off something the incident was about."""
    g = dbm.org(t)
    rows = db.ro(g, """MATCH (k:Ticket {kind: 'incident'}) OPTIONAL MATCH (k)-[:ABOUT]->(s)
                       RETURN k.uid AS uid, k.key AS key, k.title AS title, k.at AS at, k.priority AS priority,
                              collect(DISTINCT s.uid) AS services, collect(DISTINCT s.name) AS names ORDER BY at DESC""")
    out = []
    for r in rows:
        trig = db.ro(g, """MATCH (d:Decision)-[:AFFECTS]->(s) WHERE s.uid IN $s AND d.decided_at < $at
                           RETURN d.key AS key, d.title AS title, d.decided_at AS at, collect(s.uid) AS affects
                           ORDER BY at DESC""", {"s": r["services"], "at": r["at"]})
        trig = [d for d in trig if RETIRES.search(d["title"] or "") and _days(d["at"], r["at"]) <= LOOKBACK_DAYS]
        d = trig[0] if trig else None
        out.append(r | {"decision": d, "replayable": bool(d), "lead_days": _days(d["at"], r["at"]) if d else None})
    return out


def _switched_off(db: dbm.DB, t: str, decision: dict) -> list[str]:
    """What the decision switched off: the affected services its title names after the verb."""
    g = dbm.org(t)
    names = {r["uid"]: r["name"] for r in db.ro(g, "MATCH (s:Service) WHERE s.uid IN $u RETURN s.uid AS uid, s.name AS name",
                                                  {"u": decision["affects"]})}
    tail = RETIRES.split(decision["title"], maxsplit=1)[-1].lower()
    hits = [u for u, n in names.items() if n.lower() in tail]
    return hits or list(names)[:1]


def replay(db: dbm.DB, t: str, key: str, emit=None) -> dict:
    emit = emit or (lambda e: None)
    inc = next((i for i in incidents(db, t) if i["key"] == key), None)
    if not inc:
        raise KeyError(f"no incident {key}")
    if not inc["decision"]:
        raise ValueError(f"{key} has no decision before it that switched something off; there is nothing to replay")
    d = inc["decision"]
    day = d["at"][:10]
    goal = [{"op": "deprecate_service", "service": s} for s in _switched_off(db, t, d)]
    emit({"type": "status", "text": f"rebuilding the company as it stood on {day}"})
    known_snap = ep.checkout(db, t, day, "known")
    true_snap = ep.checkout(db, t, day, "true")
    emit({"type": "status", "text": "what the records said that day"})
    known = planner.assess(db, t, goal, known_snap)
    emit({"type": "known", **_brief(known)})
    emit({"type": "status", "text": "what was actually true"})
    true = planner.assess(db, t, goal, true_snap)
    emit({"type": "true", **_brief(true)})

    # the blind spot: facts on the true breakage paths that hadn't been recorded by the decision's day
    facts = sorted({f for b in true["broken"] for f in b["fact_uids"]})
    g = dbm.org(t)
    missing = db.ro(g, """MATCH (a)-[r]->(b) WHERE r.uid IN $f AND r.recorded_at > $day
                          OPTIONAL MATCH (src:Source {uid: r.src}) OPTIONAL MATCH (src)-[:POSTED_BY|WRITTEN_BY]->(p:Person)
                          RETURN r.uid AS fact, a.name AS source, b.name AS target, type(r) AS type, r.valid_from AS true_since,
                                 r.recorded_at AS recorded_at, r.declared AS declared, src.uid AS source_uid,
                                 coalesce(src.title, src.channel) AS recorded_in, src.text AS quote, p.name AS recorded_by
                          ORDER BY recorded_at""", {"f": facts, "day": day})
    for m in missing:
        m["unwritten_days"] = _days(m["true_since"], m["recorded_at"])
        m["after_incident_days"] = _days(inc["at"], m["recorded_at"])
    emit({"type": "blind_spot", "facts": missing})

    emit({"type": "status", "text": "searching for the safe path on that day"})
    safe = planner.plan(db, t, goal, asof=day, mode="true",
                        emit=lambda e: emit({**e, "type": "universe"}) if e["type"] == "universe" else None)
    fix = next((s for s in safe["steps"] if s["label"].lower().startswith("move")), None)
    landed = None
    if fix:
        moved = fix["ops"][0]
        landed = db.one(g, f"""MATCH (:Service {{name: $a}})-[r:DEPENDS_ON]->(:Service {{name: $b}})
                              RETURN r.valid_from AS at, r.src AS src ORDER BY at LIMIT 1""",
                        {"a": moved["source"], "b": moved["target"]})
    waiting = None
    if fix and not landed:  # the fix hasn't landed: the ticket that tracks it
        moved = fix["ops"][0]
        waiting = db.one(g, """MATCH (k:Ticket)-[:ABOUT]->(:Service {name: $a}) MATCH (k)-[:ABOUT]->(:Service {name: $b})
                               RETURN k.key AS key, k.title AS title, k.status AS status, k.at AS opened ORDER BY opened DESC LIMIT 1""",
                         {"a": moved["source"], "b": moved["target"]})
    timeline = [{"at": d["at"], "kind": "decision", "label": f"{d['key']}: {d['title']}"},
                {"at": inc["at"], "kind": "incident", "label": f"{inc['key']}: {inc['title']}"}]
    timeline += [{"at": m["recorded_at"], "kind": "recorded", "label": f"{m['source']} → {m['target']} written down"} for m in missing]
    if landed:
        timeline.append({"at": landed["at"], "kind": "fixed", "label": f"{fix['label']} (the fix) lands"})
    elif waiting:
        timeline.append({"at": waiting["opened"], "kind": "waiting", "label": f"{waiting['key']} opened: {waiting['title']} (still {waiting['status']})"})
    return {"incident": inc, "decision": d, "day": day, "goal": [s for s in _switched_off(db, t, d)],
            "known": _brief(known), "true": _brief(true), "blind_spot": missing, "safe_path": safe,
            "fix": fix, "fix_landed": landed, "fix_days_after": _days(d["at"], landed["at"]) if landed else None,
            "fix_waiting": waiting,
            "timeline": sorted(timeline, key=lambda e: e["at"])}


def _brief(a: dict) -> dict:
    return {"risk": a["risk"], "level": a["level"], "broken": [{"service": b["service"], "hops": b["hops"], "effect": b["effect"],
                                                               "tier": b["tier"]} for b in a["broken"]],
            "customers": a["customers"], "orphans": a["orphans"], "terms": a["terms"]}
