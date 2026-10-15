"""FalkorDB graph algorithms, each wrapped so the agents and the diff call them the same way.

Algorithms only run on epochs and universes (physically pruned graphs), never on the org graph, because they
filter by label and relationship type and would otherwise walk closed facts."""

from __future__ import annotations

from collections import defaultdict

from orion import db as dbm

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
CALL algo.betweenness({nodeLabels: ['Person'], relationshipTypes: ['COLLABORATES']})
YIELD node, score
RETURN node.uid AS uid, node.name AS name, score
ORDER BY score DESC, uid
LIMIT $k
"""

PAGERANK_SERVICES = """
CALL algo.pageRank('Service', 'DEPENDS_ON')
YIELD node, score
RETURN node.uid AS uid, node.name AS name, score
ORDER BY score DESC
"""

COMMUNITIES = """
CALL algo.labelPropagation({nodeLabels: ['Person'], relationshipTypes: ['COLLABORATES'], maxIterations: 20})
YIELD node, communityId
MATCH (node)-[:MEMBER_OF]->(t:Team)
RETURN communityId AS c, node.uid AS uid, node.name AS name, t.uid AS team
"""

HIDDEN = """
CALL algo.WCC({nodeLabels: ['Person'], relationshipTypes: ['BRIDGES']})
YIELD node, componentId
MATCH (node)-[:MEMBER_OF]->(t:Team)
RETURN componentId AS c, node.uid AS uid, node.name AS name, t.uid AS team, t.name AS team_name
"""

# minimum spanning forest of collaboration, strongest ties first (weight = 1 / strength): the lines the web app
# draws as each team's constellation
CONSTELLATIONS = """
CALL algo.MSF({nodeLabels: ['Person'], relationshipTypes: ['COLLABORATES'], weightAttribute: 'inv'})
YIELD edges
UNWIND edges AS e
RETURN startNode(e).uid AS a, endNode(e).uid AS b, e.w AS w
"""

PATHS = """
MATCH (a {uid: $a}), (b {uid: $b})
CALL algo.SPpaths({sourceNode: a, targetNode: b, relTypes: $rels, weightProp: 'cost', pathCount: $k, maxLen: 6})
YIELD path, pathWeight
RETURN [n IN nodes(path) | n.uid] AS uids, [n IN nodes(path) | coalesce(n.name, n.key, n.title)] AS names,
       [r IN relationships(path) | type(r)] AS rels, pathWeight AS cost
ORDER BY cost
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
    return [r | {"score": round(r["score"], 4)} for r in db.ro(graph, PAGERANK_SERVICES)]


def communities(db: dbm.DB, graph: str) -> list[dict]:
    """Groups of people who actually work together (label propagation over COLLABORATES), and how they map onto
    the org chart. A group that spans several teams is a team the org chart doesn't show."""
    groups: dict[int, dict] = defaultdict(lambda: {"people": [], "teams": defaultdict(int)})
    for r in db.ro(graph, COMMUNITIES):
        g = groups[r["c"]]
        g["people"].append({"uid": r["uid"], "name": r["name"], "team": r["team"]})
        g["teams"][r["team"]] += 1
    out = []
    for g in groups.values():
        if len(g["people"]) < 3:
            continue
        out.append({"people": sorted(g["people"], key=lambda p: p["uid"]), "teams": dict(g["teams"]),
                    "cross_team": len(g["teams"]) > 1})
    return sorted(out, key=lambda g: (-len(g["teams"]), -len(g["people"])))


def hidden_teams(db: dbm.DB, graph: str) -> list[dict]:
    """People who work together across team lines (WCC over BRIDGES): three or more people from two or more teams
    are a team the org chart doesn't show. Projects they share are returned as the likely reason."""
    groups: dict[int, list[dict]] = defaultdict(list)
    for r in db.ro(graph, HIDDEN):
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


def constellations(db: dbm.DB, graph: str) -> list[dict]:
    seen, out = set(), []
    for r in db.ro(graph, CONSTELLATIONS):
        key = tuple(sorted((r["a"], r["b"])))
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


def paths(db: dbm.DB, graph: str, a: str, b: str, k: int = 3) -> list[dict]:
    """The cheapest few ways two things are connected. Strong, structural links are cheap; a passing mention is
    expensive. Costs live on the relationships of epochs (see epoch.py)."""
    rels = ["DEPENDS_ON", "OWNS", "MEMBER_OF", "KNOWS", "COLLABORATES", "WORKED_ON", "TOUCHES", "USES"]
    return db.ro(graph, PATHS, {"a": a, "b": b, "rels": rels, "k": k})
