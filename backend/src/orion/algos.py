"""FalkorDB graph algorithms, each wrapped so the agents and the diff call them the same way.

Algorithms only run on epochs and universes (physically pruned graphs), never on the org graph, because they
filter by label and relationship type and would otherwise walk closed facts."""

from __future__ import annotations

from collections import defaultdict

from orion import db as dbm
from orion.queries import cypher

WCC_TEAMS = """
CALL algo.WCC({nodeLabels: ['Service', 'Person', 'Team'], relationshipTypes: ['DEPENDS_ON', 'KNOWS', 'MEMBER_OF', 'OWNS']})
YIELD node, componentId
RETURN componentId AS c, labels(node)[0] AS label, node.uid AS uid, node.name AS name
"""

WCC_COLLAB = """
CALL algo.WCC({nodeLabels: ['Person'], relationshipTypes: ['COLLABORATES']})
YIELD node, componentId
RETURN componentId AS c, node.uid AS uid, node.name AS name
"""

BETWEENNESS = """
CALL algo.betweenness({nodeLabels: ['Person'], relationshipTypes: ['COLLABORATES'], samplingSize: 10000, samplingSeed: 7})
YIELD node, score
RETURN node.uid AS uid, node.name AS name, score
ORDER BY score DESC, uid
LIMIT $k
"""

def stranded(db: dbm.DB, graph: str) -> list[dict]:
    """Groups of services that lose every path to a team: no owner, nobody who knows them, nothing owned depends
    on them. WCC over DEPENDS_ON + KNOWS + MEMBER_OF + OWNS; a component with services and no team is stranded."""
    comps: dict[int, dict] = defaultdict(lambda: {"services": [], "teams": 0, "people": 0})
    for r in db.ro(graph, WCC_TEAMS):
        c = comps[r["c"]]
        if r["label"] == "Service":
            c["services"].append({"uid": r["uid"], "name": r["name"]})
        elif r["label"] == "Team":
            c["teams"] += 1
        else:
            c["people"] += 1
    return [{"services": sorted(c["services"], key=lambda s: s["uid"])} for c in comps.values()
            if c["services"] and not c["teams"]]


def collab_groups(db: dbm.DB, graph: str) -> list[list[str]]:
    comps: dict[int, list[str]] = defaultdict(list)
    for r in db.ro(graph, WCC_COLLAB):
        comps[r["c"]].append(r["uid"])
    return sorted((sorted(v) for v in comps.values() if len(v) > 1), key=lambda g: (-len(g), g))


def bottlenecks(db: dbm.DB, graph: str, k: int = 5) -> list[dict]:
    return [r | {"score": round(r["score"], 2)} for r in db.ro(graph, BETWEENNESS, {"k": k}) if r["score"] > 0]


def influence(db: dbm.DB, graph: str) -> list[dict]:
    return [r | {"score": round(r["score"], 4)} for r in db.ro(graph, cypher("service_pagerank"))]


def hidden_teams(db: dbm.DB, graph: str) -> list[dict]:
    """People who work together across team lines (WCC over BRIDGES): three or more people from two or more teams
    are a team the org chart doesn't show. Projects they share are returned as the likely reason."""
    groups: dict[int, list[dict]] = defaultdict(list)
    for r in db.ro(graph, cypher("hidden_teams")):
        groups[r["c"]].append({"uid": r["uid"], "name": r["name"], "team": r["team"], "team_name": r["team_name"]})
    out = []
    for people in groups.values():
        teams = sorted({p["team"] for p in people})
        if len(people) < 3 or len(teams) < 2:
            continue
        uids = [p["uid"] for p in people]
        shared = db.ro(graph, """MATCH (p:Person)-[:WORKED_ON]->(j:Project) WHERE p.uid IN $u
                                 WITH j, count(p) AS n WHERE n >= 2 RETURN j.uid AS uid, j.name AS name, n
                                 ORDER BY n DESC""", {"u": uids})
        out.append({"people": sorted(people, key=lambda p: p["uid"]), "teams": teams, "projects": shared})
    return out
