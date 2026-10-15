"""What the web app draws: the company as a sky, read straight from a graph (epoch:now, an epoch on a date, or a
universe). Positions are computed by the client; this returns the data and the algorithm results that shape it:
PageRank sizes the services, the minimum spanning forest of collaboration draws each team's constellation,
betweenness marks the people everything flows through, and WCC over cross-team ties finds the hidden teams."""

from __future__ import annotations

from orion import algos
from orion import db as dbm


def galaxy(db: dbm.DB, g: str) -> dict:
    teams = db.ro(g, """MATCH (t:Team) OPTIONAL MATCH (p:Person)-[:MEMBER_OF]->(t)
                        RETURN t.uid AS id, t.name AS label, t.mission AS mission, count(p) AS size ORDER BY t.uid""")
    services = db.ro(g, """MATCH (s:Service) OPTIONAL MATCH (t:Team)-[:OWNS]->(s)
                           OPTIONAL MATCH (p:Person)-[:KNOWS]->(s)
                           RETURN s.uid AS id, s.name AS label, s.tier AS tier, s.lang AS lang, s.summary AS summary,
                                  s.created AS created, t.uid AS team, count(p) AS knowers ORDER BY s.uid""")
    retired = db.ro(g, """MATCH (s:Retired) OPTIONAL MATCH (t:Team)-[:OWNS]->(s)
                          RETURN s.uid AS id, s.name AS label, s.tier AS tier, s.retired AS retired, t.uid AS team""")
    people = db.ro(g, """MATCH (p:Person) OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
                         RETURN p.uid AS id, p.name AS label, p.role AS role, p.joined AS joined, t.uid AS team
                         ORDER BY p.uid""")
    former = db.ro(g, "MATCH (p:Former) RETURN p.uid AS id, p.name AS label, p.left AS left")
    customers = db.ro(g, "MATCH (c:Customer) RETURN c.uid AS id, c.name AS label, c.tier AS tier, c.industry AS industry")
    deps = db.ro(g, """MATCH (a:Service)-[r:DEPENDS_ON]->(b) RETURN a.uid AS source, b.uid AS target, r.kind AS kind,
                       r.uid AS uid, b:Retired AS dangling""")
    knows = db.ro(g, "MATCH (p:Person)-[k:KNOWS]->(s:Service) RETURN p.uid AS source, s.uid AS target, k.n AS n")
    uses = db.ro(g, "MATCH (c:Customer)-[:USES]->(s) RETURN c.uid AS source, s.uid AS target")
    collab = db.ro(g, """MATCH (a:Person)-[r:COLLABORATES]->(b:Person) WHERE a.uid < b.uid
                         RETURN a.uid AS source, b.uid AS target, r.w AS w""")
    rank = {r["uid"]: r["score"] for r in algos.influence(db, g)}
    for s in services:
        s["rank"] = rank.get(s["id"], 0.0)
    hubs = {r["uid"]: r["score"] for r in algos.bottlenecks(db, g, k=8)}
    for p in people:
        p["between"] = hubs.get(p["id"], 0.0)
    return {
        "graph": g, "teams": teams, "services": services, "retired": retired, "people": people, "former": former,
        "customers": customers, "deps": deps, "knows": knows, "uses": uses, "collab": collab,
        "constellations": algos.constellations(db, g), "hidden": algos.hidden_teams(db, g),
        "stats": {"services": len(services), "people": len(people), "teams": len(teams), "customers": len(customers),
                  "deps": len(deps)},
    }


def timeline(db: dbm.DB, t: str) -> dict:
    """Dated events across the company's history, for the time machine."""
    g = dbm.org(t)
    ev = []
    for r in db.ro(g, "MATCH (s:Service) RETURN s.uid AS uid, s.name AS name, s.created AS c, s.retired AS r, s.tier AS tier"):
        if r["c"] > "2024-01-01":
            ev.append({"at": r["c"], "kind": "born", "uid": r["uid"], "label": f"{r['name']} goes live", "tier": r["tier"]})
        if r["r"] != "9999-12-31":
            ev.append({"at": r["r"][:10], "kind": "retired", "uid": r["uid"], "label": f"{r['name']} retired", "tier": r["tier"]})
    for r in db.ro(g, "MATCH (p:Person) RETURN p.uid AS uid, p.name AS name, p.joined AS j, p.left AS l"):
        if r["j"] > "2024-01-01":
            ev.append({"at": r["j"], "kind": "joined", "uid": r["uid"], "label": f"{r['name']} joins"})
        if r["l"] != "9999-12-31":
            ev.append({"at": r["l"][:10], "kind": "left", "uid": r["uid"], "label": f"{r['name']} leaves"})
    for r in db.ro(g, "MATCH (d:Decision) RETURN d.uid AS uid, d.key AS key, d.title AS title, d.at AS at, d.status AS status"):
        ev.append({"at": r["at"][:10], "kind": "decision", "uid": r["uid"], "label": f"{r['key']}: {r['title']}",
                   "status": r["status"]})
    for r in db.ro(g, "MATCH (k:Ticket {kind: 'incident'}) RETURN k.uid AS uid, k.key AS key, k.title AS title, k.at AS at"):
        ev.append({"at": r["at"][:10], "kind": "incident", "uid": r["uid"], "label": f"{r['key']}: {r['title']}"})
    for r in db.ro(g, """MATCH (a)-[r:DEPENDS_ON]->(b) WHERE r.recorded_at > r.valid_from + 'T'
                         RETURN r.uid AS uid, a.name AS a, b.name AS b, r.recorded_at AS at, r.valid_from AS vf"""):
        ev.append({"at": r["at"][:10], "kind": "discovered", "uid": r["uid"],
                   "label": f"found: {r['a']} has depended on {r['b']} since {r['vf']}"})
    months = db.ro(g, """MATCH (c:Change) RETURN substring(c.at, 0, 7) AS month, count(c) AS n ORDER BY month""")
    ev.sort(key=lambda e: e["at"])
    return {"events": ev, "activity": months, "start": "2024-01-01", "now": dbm.clock(db, t)}
