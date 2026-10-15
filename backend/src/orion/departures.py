"""If they left tomorrow: everyone ranked by what their leaving would cost.

For each person, today's company is copied to a throwaway graph, remove_person is applied there the same way a
what-if applies it, and the result is measured with the diff's own queries and scored with its risk terms:
systems nobody would know any more, systems no team would answer for, working groups that would come apart, and
a change in who the work flows through. The copies are deleted at once and no universe is recorded. The ranking
is kept in Redis until the records change.
"""

from __future__ import annotations

import json
import secrets
import time

from orion import db as dbm
from orion import epoch as ep
from orion import ops as opsm
from orion import universe as uv
from orion.queries import cypher


def _cost(db: dbm.DB, g: str, before: dict, tiers: dict) -> tuple[list, list, list, list]:
    orphans = [{"uid": r["uid"], "service": r["name"], "tier": tiers.get(r["uid"], 3)}
               for r in db.ro(g, cypher("knowledge_orphans")) if r["uid"] not in before["orphans"]]
    stranded = [{"services": sorted(r["names"]), "uids": r["uids"]}
                for r in db.ro(g, cypher("stranded_clusters")) if set(r["uids"]) - before["stranded"]]
    _, of_after, names_after = uv._components(db, g)
    splits = []
    for members in before["groups"]:
        live = [m for m in members if m in of_after]
        parts = {of_after[m] for m in live}
        if len(parts) > 1:
            splits.append({"groups": sorted(([names_after[m] for m in live if of_after[m] == p] for p in parts),
                                            key=len, reverse=True)})
    top = [r["uid"] for r in db.ro(g, cypher("betweenness"))[:5]]
    return orphans, stranded, splits, top


def departures(db: dbm.DB, t: str, top: int = 12) -> dict:
    v = dbm.version(db, t)
    key = f"orion:{t}:departures"
    hit = db.get(key)
    if hit:
        data = json.loads(hit)
        if data.get("version") == v:
            return data | {"cached": True}
    t0 = time.perf_counter()
    snap = ep.checkout(db, t)
    base = snap["graph"]
    groups, _, _ = uv._components(db, base)
    before = {"orphans": {r["uid"] for r in db.ro(base, cypher("knowledge_orphans"))},
              "stranded": {u for r in db.ro(base, cypher("stranded_clusters")) for u in r["uids"]},
              "groups": groups}
    top_before = [r["uid"] for r in db.ro(base, cypher("betweenness"))[:5]]
    tiers = {r["uid"]: r["tier"] or 3 for r in db.ro(base, "MATCH (s:Service) RETURN s.uid AS uid, s.tier AS tier")}
    people = db.ro(base, """MATCH (p:Person) OPTIONAL MATCH (p)-[:MEMBER_OF]->(x:Team)
                            OPTIONAL MATCH (p)-[:KNOWS]->(s:Service)
                            RETURN p.uid AS uid, p.name AS name, collect(DISTINCT x.name)[0] AS team,
                                   collect(DISTINCT s.name) AS knows ORDER BY name""")
    ranked = []
    for p in people:
        g = f"scratch:{t}:{secrets.token_hex(4)}"
        db.copy(base, g)
        try:
            opsm.apply_physical(db, g, [opsm.resolve_op(db, g, {"op": "remove_person", "person": p["uid"]})], "departure")
            orphans, stranded, splits, top_after = _cost(db, g, before, tiers)
        finally:
            db.delete(g)
        risk = uv.score_risk([], orphans, top_before, top_after, splits, [], stranded, {})
        ranked.append({"uid": p["uid"], "name": p["name"], "team": p["team"], "risk": risk["score"], "level": risk["level"],
                       "terms": risk["terms"], "nobody_would_know": [o["service"] for o in orphans],
                       "no_team": sorted({s for x in stranded for s in x["services"]}), "groups_split": len(splits),
                       "knows": sorted(p["knows"]), "knows_count": len(p["knows"])})
    ranked.sort(key=lambda r: (-r["risk"], -len(r["nobody_would_know"]), -r["knows_count"], r["name"]))
    data = {"version": v, "asof": snap["asof"], "people": ranked[:top], "total": len(ranked),
            "ms": round((time.perf_counter() - t0) * 1000)}
    db.set(key, json.dumps(data), ex=86400)
    return data
