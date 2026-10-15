"""What simulations learned, shared by every person and agent.

Every diff leaves (:Finding)-[:ABOUT]->(entity) in the org graph. When a later question is about the same entities,
the Navigator is told what was simulated before and what changed since; if something it looked at changed, the
same changes are run again on today's company.
"""

from __future__ import annotations

import json

from orion import db as dbm


def record(db: dbm.DB, t: str, u: dict, diff: dict) -> None:
    ops = json.loads(u["ops_json"])
    about = {v for o in ops for k, v in o.items() if k not in ("op", "title", "priority", "body", "kind")
             and isinstance(v, str)}
    about |= {b["uid"] for b in diff["broken"]}
    facts = sorted({f for b in diff["broken"] for f in b["fact_uids"]})
    g = dbm.org(t)
    db.q(g, "MATCH (f:Finding {uid: $u}) DETACH DELETE f", {"u": "finding:" + u["uid"]})
    db.q(g, """CREATE (f:Finding {uid: $uid, universe: $u, title: $title, risk: $risk, level: $level, at: $at,
                                  version: $v, ops: $ops, broken: $broken, facts: $facts, by: $by})
               WITH f UNWIND $about AS a MATCH (n {uid: a}) WHERE NOT n:Answer CREATE (f)-[:ABOUT]->(n)""",
         {"uid": "finding:" + u["uid"], "u": u["uid"], "title": u["title"], "risk": diff["risk"]["score"],
          "level": diff["risk"]["level"], "at": u["created_at"], "v": u.get("base_version", 0), "ops": u["ops_json"],
          "broken": [b["service"] for b in diff["broken"]], "facts": facts, "by": u.get("created_by"),
          "about": sorted(about)})


def about(db: dbm.DB, t: str, uids: list[str], limit: int = 3) -> list[dict]:
    """Earlier simulations about these entities, newest first, with what changed since in what they relied on."""
    if not uids:
        return []
    g = dbm.org(t)
    rows = db.ro(g, """MATCH (f:Finding)-[:ABOUT]->(n) WHERE n.uid IN $u
                       RETURN DISTINCT f.uid AS uid, f.universe AS universe, f.title AS title, f.risk AS risk,
                              f.level AS level, f.at AS at, f.ops AS ops, f.broken AS broken, f.facts AS facts,
                              f.version AS version
                       ORDER BY at DESC LIMIT $n""", {"u": uids, "n": limit})
    for r in rows:
        r["since"] = db.ro(g, """MATCH (a)-[x]->(b) WHERE x.uid IN $f AND x.valid_to <> '9999-12-31'
                                 RETURN a.name + ' no longer ' + toLower(replace(type(x), '_', ' ')) + ' ' + b.name AS what""",
                           {"f": r["facts"] or []}) if r["facts"] else []
    return rows


def describe(f: dict, rerun: dict | None) -> str:
    out = (f"We simulated '{f['title']}' on {f['at'][:10]} (what-if {f['universe']}): risk {f['risk']}"
           + (f", breaking {', '.join(f['broken'][:6])}" if f["broken"] else ", nothing broke") + ".")
    if f.get("since"):
        out += " Since then: " + "; ".join(s["what"] for s in f["since"][:3]) + "."
    if rerun:
        out += (f" Re-run on today's company (what-if {rerun['uid']}): risk {rerun['risk']}"
                + (f", breaking {', '.join(rerun['broken'][:6])}" if rerun["broken"] else ", nothing breaks") + ".")
    return out
