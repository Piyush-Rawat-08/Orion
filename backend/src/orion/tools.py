"""The tool catalogue: Cypher and algo.* calls as tools, shared by the agents, the API and the MCP server.

Every read goes through GRAPH.RO_QUERY. Every tool returns evidence ids; each evidence record holds the graph, the
named query and its Cypher, the parameters and the node and fact uids it touched, so the Verifier can check claims
against it and the UI can light up the path behind each one.
"""

from __future__ import annotations

import json
import re
import secrets
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable

from orion import db as dbm
from orion import epoch as ep
from orion import impact
from orion import ops as opsm
from orion.aliases import fold
from orion.queries import cypher

MAX_ROWS = 200
MAX_TOOL_CHARS = 16_000


@dataclass
class ToolContext:
    db: dbm.DB
    tenant: str
    user: str | None = None
    evidence: list[dict] = field(default_factory=list)
    calls: list[dict] = field(default_factory=list)
    on_event: Callable[[dict], None] | None = None
    pages: dict = field(default_factory=dict)
    task: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def main(self) -> str:
        return dbm.org(self.tenant)

    def now(self) -> str:
        return dbm.clock(self.db, self.tenant)

    def snap(self, asof: str | None = None) -> dict:
        return ep.checkout(self.db, self.tenant, asof[:10] if asof else None, "true")

    def add_evidence(self, graph: str, query: str, params: dict, node_uids: list, fact_uids: list | None = None,
                     asof: str | None = None, summary: str = "", rows: Any = None, text: str | None = None) -> str:
        with self.lock:
            eid = f"e{len(self.evidence) + 1}"
            self.evidence.append({
                "eid": eid, "graph": graph, "query": query, "cypher": text or cypher(query), "adhoc": query == "adhoc",
                "params": params, "node_uids": sorted({u for u in node_uids if u}),
                "fact_uids": sorted({u for u in (fact_uids or []) if u}), "asof": asof, "summary": summary,
                "rows": _trim(rows),
            })
        return eid


def _trim(rows: Any, limit: int = 3000) -> Any:
    s = json.dumps(rows, default=str)
    if len(s) <= limit:
        return rows
    if isinstance(rows, list):
        out = []
        for r in rows:
            out.append(r)
            if len(json.dumps(out, default=str)) > limit:
                out.pop()
                break
        return out
    return s[:limit]


def _resolve(ctx: ToolContext, graph: str, label: str, ref: str) -> str:
    return opsm.resolve(ctx.db, graph, label, ref)


def _resolve_any(ctx: ToolContext, graph: str, ref: str) -> str:
    for label in ("Service", "Person", "Team", "Customer", "Project", "Decision"):
        try:
            return opsm.resolve(ctx.db, graph, label, ref)
        except opsm.ResolveError:
            continue
    raise ValueError(f"nothing matches '{ref}'")


def _ft(text: str) -> str:
    stop = {"what", "who", "which", "when", "where", "why", "how", "does", "the", "and", "for", "are", "was", "has",
            "have", "will", "would", "could", "should", "can", "our", "this", "that", "with", "from", "about"}
    words = [w for w in re.findall(r"[a-z0-9]+", fold(text)) if w not in stop and len(w) > 2]
    return "|".join(w + "*" for w in words[:8]) or text


# ---------------------------------------------------------------- read tools

def find_entities(ctx: ToolContext, text: str, limit: int = 10) -> dict:
    """Find people, services, teams, customers, projects or decisions by name, nickname or description, and the
    messages, documents and tickets that mention them."""
    res = opsm.resolver(ctx.db, ctx.main)
    named = res.mentions(text)
    q = _ft(text)
    ents = ctx.db.ro(ctx.main, cypher("find_entities"), {"q": q, "limit": limit * 2}) if q else []
    seen = {e["uid"] for e in ents}
    for u in named:
        if u not in seen:
            row = ctx.db.one(ctx.main, "MATCH (n {uid: $u}) RETURN n.uid AS uid, labels(n)[0] AS label, coalesce(n.name, n.key) AS name",
                             {"u": u})
            if row:
                ents.insert(0, row | {"score": 99.0})
    ents = ents[:limit]
    e1 = ctx.add_evidence(ctx.main, "find_entities", {"q": q, "limit": limit * 2}, [e["uid"] for e in ents],
                          summary=f"things named like '{text}'", rows=ents)
    srcs = ctx.db.ro(ctx.main, cypher("search_sources"), {"text": q, "limit": 5}) if q else []
    for s in srcs:
        s["text"] = (s.get("text") or "")[:240]
    e2 = ctx.add_evidence(ctx.main, "search_sources", {"text": q, "limit": 5}, [s["uid"] for s in srcs],
                          summary=f"documents and messages mentioning '{text}'", rows=srcs) if srcs else None
    return {"entities": ents, "sources": srcs, "evidence": [e for e in (e1, e2) if e]}


def impact_tool(ctx: ToolContext, service: str, direction: str = "upstream", asof: str | None = None) -> dict:
    """Dependents (upstream: what breaks if it goes) or dependencies (downstream) of a service, at any depth, as of a
    date, with one witness path each and whether a path runs through a dependency nobody wrote down."""
    asof = asof or ctx.now()
    g = ctx.main
    svc = _resolve(ctx, g, "Service", service)
    srow = ctx.db.one(g, "MATCH (s {uid: $s}) RETURN s.name AS name, s.retired AS retired", {"s": svc})
    reach = impact.walk(ctx.db, g, [svc], on=asof, direction="down" if direction == "downstream" else "up")
    rows = sorted(reach.values(), key=lambda r: (r.hops, r.name))
    facts = sorted({e for r in rows for e in r.edges})
    names = impact.names(ctx.db, g, {n for r in rows for n in r.nodes})
    owners = {}
    if rows and direction != "downstream":
        owners = {r["uid"]: r["teams"] for r in ctx.db.ro(g, """MATCH (t:Team)-[o:OWNS]->(x:Service) WHERE x.uid IN $s
            AND o.declared = true AND o.valid_from <= $asof AND o.valid_to > $asof
            RETURN x.uid AS uid, collect(t.name) AS teams""", {"s": [r.uid for r in rows], "asof": asof})}
    what = f"what {srow['name']} relies on" if direction == "downstream" else f"what relies on {srow['name']}"
    eid = ctx.add_evidence(g, "broken_detail", {"edges": facts}, [svc] + [r.uid for r in rows], facts, asof,
                           f"{what} as of {asof[:10]}: every link in the chain",
                           rows=[{"service": r.name, "hops": r.hops, "effect": r.effect} for r in rows])
    if direction == "downstream":
        return {"service": srow["name"], "asof": asof,
                "depends_on": [{"dependency": r.name, "hops": r.hops, "effect_if_lost": r.effect} for r in rows],
                "evidence": [eid]}
    out = [{"dependent": r.name, "hops": r.hops, "owners": owners.get(r.uid, []), "effect": r.effect,
            "path": [names.get(n, n) for n in r.nodes[::-1]], "only_via_undeclared_dependency": bool(r.undeclared),
            "fact_uids": r.edges} for r in rows]
    res = {"service": srow["name"], "asof": asof, "dependents": out, "evidence": [eid]}
    if srow["retired"] and srow["retired"] <= asof:
        res["retired"] = True
        res["note"] = (f"{srow['name']} is retired, but {len(out)} service(s) still depend on it: they are broken unless "
                       "they migrate.") if out else f"{srow['name']} is retired and nothing depends on it any more."
    return res


def broken_dependencies(ctx: ToolContext, asof: str | None = None) -> dict:
    """Services that still depend, at any depth, on a service that has been switched off: breakage a forced merge
    or an unmigrated retirement left behind."""
    snap = ctx.snap(asof)
    g = snap["graph"]
    retired = ctx.db.ro(g, cypher("broken_paths"))
    reach = impact.walk(ctx.db, g, [r["uid"] for r in retired]) if retired else {}
    rows = sorted(reach.values(), key=lambda r: (r.hops, r.name))
    root = {r["uid"]: r["name"] for r in retired}
    names = impact.names(ctx.db, g, {n for r in rows for n in r.nodes})
    facts = sorted({e for r in rows for e in r.edges})
    e1 = ctx.add_evidence(g, "broken_paths", {}, [r["uid"] for r in retired], [], snap["asof"],
                          "switched-off systems that something still relies on", rows=retired)
    e2 = ctx.add_evidence(g, "broken_detail", {"edges": facts}, [r.uid for r in rows], facts, snap["asof"],
                          "the chains of reliance that still lead to them") if rows else None
    return {"asof": snap["asof"], "retired_with_dependents": [{"service": r["name"], "retired_at": r["retired_at"]} for r in retired],
            "broken": [{"service": r.name, "depends_on_retired": root.get(r.root, r.root), "hops": r.hops,
                        "effect": r.effect, "path": [names.get(n, n) for n in r.nodes[::-1]]} for r in rows],
            "evidence": [e for e in (e1, e2) if e]}


def who_knows(ctx: ToolContext, service: str, since_days: int = 180, asof: str | None = None) -> dict:
    """Who actually knows a service, from changes and reviews, against who owns it on paper."""
    asof = asof or ctx.now()
    since = (date.fromisoformat(asof[:10]) - timedelta(days=since_days)).isoformat()
    s = _resolve_any(ctx, ctx.main, service)
    params = {"s": s, "since": since}
    rows = ctx.db.ro(ctx.main, cypher("who_knows"), params)
    rows = [r for r in rows if r["last_at"] and r["last_at"] <= asof]
    e1 = ctx.add_evidence(ctx.main, "who_knows", params, [s] + [r["uid"] for r in rows], [], asof,
                          f"people who changed or reviewed {service}", rows=rows)
    own = ownership(ctx, service, asof)
    return {"service": service, "people": rows, "knowledgeable_count": sum(1 for r in rows if r["knows"]),
            "ownership": own["ownership"], "evidence": [e1] + own["evidence"]}


def ownership(ctx: ToolContext, service: str, asof: str | None = None) -> dict:
    """Declared owner (with where it is written down) and de-facto owner from who makes the changes."""
    snap = ctx.snap(asof)
    g = snap["graph"]
    s = _resolve_any(ctx, g, service)
    rows = ctx.db.ro(g, cypher("ownership"), {"s": s})
    if not rows:
        return {"ownership": None, "evidence": []}
    r = rows[0]
    owners = [o for o in r["owners"] if o.get("team")]
    eid = ctx.add_evidence(g, "ownership", {"s": s}, [s] + [o["team_uid"] for o in owners],
                           [o["fact"] for o in owners if o.get("fact")], snap["asof"], f"ownership of {service}", rows=owners)
    return {"ownership": {"declared": [o for o in owners if o["declared"] is not False],
                          "de_facto": [o for o in owners if o["declared"] is False], "on_call": []},
            "evidence": [eid]}


def decision_history(ctx: ToolContext, entity: str) -> dict:
    """Decisions that affected a service (or one decision), with what superseded or reversed what, and the sources."""
    uid = _resolve_any(ctx, ctx.main, entity)
    rows = ctx.db.ro(ctx.main, cypher("decision_history"), {"uid": uid})
    for r in rows:
        r["related"] = [x for x in r["related"] if x.get("uid")]
        r["sources"] = [s | {"text": (s.get("text") or "")[:400]} for s in r["sources"] if s.get("uid")]
    nodes = [r["uid"] for r in rows] + [s["uid"] for r in rows for s in r["sources"]]
    eid = ctx.add_evidence(ctx.main, "decision_history", {"uid": uid}, nodes, [], None, f"decisions affecting {entity}",
                           rows=rows)
    return {"entity": entity, "decisions": rows, "evidence": [eid]}


def blame(ctx: ToolContext, fact_uid: str) -> dict:
    """The source behind a fact: who wrote it down, when, and the exact words."""
    rows = ctx.db.ro(ctx.main, cypher("blame"), {"fact_uid": fact_uid})
    eid = ctx.add_evidence(ctx.main, "blame", {"fact_uid": fact_uid}, [r["source_uid"] for r in rows if r["source_uid"]],
                           [fact_uid], None, "where this record came from", rows=rows)
    return {"fact": fact_uid, "sources": rows, "evidence": [eid]}


def customer_timeline(ctx: ToolContext, customer: str, since: str = "2025-01-01") -> dict:
    """Everything a customer raised, its status, and what blocks it."""
    c = _resolve(ctx, ctx.main, "Customer", customer)
    params = {"c": c, "since": since}
    rows = ctx.db.ro(ctx.main, cypher("customer_timeline"), params)
    for r in rows:
        r["blocked_by"] = [b for b in r["blocked_by"] if b.get("key")]
    nodes = [c] + [r["uid"] for r in rows] + [b["uid"] for r in rows for b in r["blocked_by"]]
    eid = ctx.add_evidence(ctx.main, "customer_timeline", params, nodes, [], None, f"tickets from {customer}", rows=rows)
    return {"customer": customer, "tickets": rows[:40], "evidence": [eid]}


def trace_path(ctx: ToolContext, a: str, b: str) -> dict:
    """How two things are connected: up to three shortest paths, each link explained."""
    snap = ctx.snap()
    g = snap["graph"]
    ua, ub = _resolve_any(ctx, g, a), _resolve_any(ctx, g, b)
    rows = ctx.db.ro(g, cypher("trace_path"), {"a": ua, "b": ub})
    eid = ctx.add_evidence(g, "trace_path", {"a": ua, "b": ub}, [u for r in rows for u in r["uids"]],
                           [u for r in rows for u in r["rel_uids"] if u], snap["asof"], f"paths between {a} and {b}", rows=rows)
    verbs = {"DEPENDS_ON": "relies on", "OWNS": "owns", "MEMBER_OF": "is on", "WORKED_ON": "worked on", "USES": "uses",
             "TOUCHES": "touches"}
    paths = []
    for r in rows:
        steps = []
        for i, (typ, lk) in enumerate(zip(r["types"], r["links"])):
            x, y = r["names"][i], r["names"][i + 1]
            if r["starts"][i] != r["uids"][i]:
                x, y = y, x
            if typ == "KNOWS":
                steps.append(f"{x} touched {y} {lk.get('touches')} times, last on {(lk.get('last_at') or '')[:10]}")
            elif typ == "COLLABORATES":
                steps.append(f"{x} and {y} work together (weight {round(lk.get('weight') or 0, 1)})")
            else:
                steps.append(f"{x} {verbs.get(typ, typ.lower())} {y}")
        paths.append({"names": r["names"], "types": r["types"], "links": steps})
    return {"paths": paths, "evidence": [eid]}


def neighborhood(ctx: ToolContext, entity: str) -> dict:
    """Everything directly connected to an entity right now."""
    uid = _resolve_any(ctx, ctx.main, entity)
    asof = ctx.now()
    rows = ctx.db.ro(ctx.main, cypher("neighborhood"), {"uid": uid, "asof": asof})
    eid = ctx.add_evidence(ctx.main, "neighborhood", {"uid": uid, "asof": asof}, [uid] + [r["uid"] for r in rows],
                           [r["rel_uid"] for r in rows if r.get("rel_uid")], asof, f"everything directly connected to {entity}",
                           rows=rows)
    return {"entity": entity, "uid": uid, "neighbours": rows, "evidence": [eid]}


def bottlenecks(ctx: ToolContext, asof: str | None = None, top: int = 8) -> dict:
    """The people everything routes through: exact betweenness over who works with whom."""
    snap = ctx.snap(asof)
    rows = ctx.db.ro(snap["graph"], cypher("betweenness"))[:top]
    eid = ctx.add_evidence(snap["graph"], "betweenness", {}, [r["uid"] for r in rows], [], snap["asof"],
                           "the people most work flows through", rows=rows)
    return {"asof": snap["asof"], "people": [{"name": r["name"], "score": round(r["score"], 2)} for r in rows],
            "evidence": [eid]}


def influence(ctx: ToolContext, asof: str | None = None, top: int = 8) -> dict:
    """Knowledge hubs: PageRank over who works with whom."""
    snap = ctx.snap(asof)
    rows = ctx.db.ro(snap["graph"], cypher("pagerank"))[:top]
    eid = ctx.add_evidence(snap["graph"], "pagerank", {}, [r["uid"] for r in rows], [], snap["asof"],
                           "the most influential people", rows=rows)
    return {"asof": snap["asof"], "people": [{"name": r["name"], "score": round(r["score"], 4)} for r in rows],
            "evidence": [eid]}


def communities(ctx: ToolContext, asof: str | None = None, runs: int = 7) -> dict:
    """The org chart against reality: the groups people actually work in (label propagation over each person's
    strongest recent ties, the pairs most runs agree on), compared with the official teams, and the bridges."""
    snap = ctx.snap(asof)
    g = snap["graph"]
    together: Counter = Counter()
    people: set[str] = set()
    for _ in range(runs):
        for r in ctx.db.ro(g, cypher("communities")):
            m = sorted(r["members"])
            people.update(m)
            for i, a in enumerate(m):
                for b in m[i + 1:]:
                    together[(a, b)] += 1
    parent = {p: p for p in people}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for (a, b), n in together.items():
        if n > runs / 2:
            parent[find(a)] = find(b)
    groups: dict[str, list[str]] = defaultdict(list)
    for p in people:
        groups[find(p)].append(p)
    info = {r["uid"]: (r["name"], r["team"]) for r in ctx.db.ro(g, """MATCH (p:Person) OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
                                                                RETURN p.uid AS uid, p.name AS name, t.name AS team""")}
    out = []
    for members in sorted(groups.values(), key=len, reverse=True):
        if len(members) < 2:
            continue
        teams = Counter(info[m][1] for m in members if m in info)
        out.append({"members": sorted(info[m][0] for m in members if m in info), "size": len(members),
                    "official_teams": dict(teams), "matches_team": len(teams) == 1})
    official = Counter(team for _, team in info.values() if team)
    split = [x for x in official if sum(1 for c in out if x in c["official_teams"]) > 1]
    eid = ctx.add_evidence(g, "communities", {}, list(people), [], snap["asof"],
                           f"the groups people actually work in ({runs} runs agree)", rows=out)
    bt = bottlenecks(ctx, asof, top=3)
    return {"asof": snap["asof"], "discovered": out, "official_team_count": len(official), "discovered_count": len(out),
            "teams_that_work_as_several_groups": split, "bridges": bt["people"], "evidence": [eid] + bt["evidence"]}


def bus_factor(ctx: ToolContext, service: str) -> dict:
    """How many people can leave before nobody knows a service or anything it depends on, at any depth. The weakest
    link is confirmed in a throwaway fork where its people leave."""
    snap = ctx.snap()
    g = snap["graph"]
    s = _resolve(ctx, g, "Service", service)
    per = ctx.db.ro(g, cypher("bus_factor"), {"s": s})[0]["per_service"]
    per = sorted(per, key=lambda x: (x["knowers"], x["uid"] != s, x["service"]))
    known = [x for x in per if x["knowers"] > 0]
    bf = min((x["knowers"] for x in known), default=0)
    weakest = [x for x in known if x["knowers"] == bf]
    unknown = [x["service"] for x in per if x["knowers"] == 0]
    eid = ctx.add_evidence(g, "bus_factor", {"s": s}, [s] + [x["uid"] for x in per], [], snap["asof"],
                           f"how many people could cover {service} and everything it relies on", rows=per[:10])
    confirmed = None
    if weakest:
        tmp = f"scratch:{ctx.tenant}:bus:{secrets.token_hex(5)}"
        ctx.db.copy(g, tmp)
        try:
            ctx.db.q(tmp, """MATCH (p:Person)-[:KNOWS]->(:Service {uid: $s}) WITH collect(DISTINCT p) AS ps UNWIND ps AS p
                             OPTIONAL MATCH (p)-[k:KNOWS]->() DELETE k WITH DISTINCT p REMOVE p:Person SET p:Former""",
                     {"s": weakest[0]["uid"]})
            confirmed = weakest[0]["uid"] in {r["uid"] for r in ctx.db.ro(tmp, cypher("knowledge_orphans"))}
        finally:
            ctx.db.delete(tmp)
    links = [f"{', '.join(x['people'])} {'is the only one' if len(x['people']) == 1 else 'are the only ones'} who "
             f"know{'s' if len(x['people']) == 1 else ''} {x['service']}"
             + ("" if x["uid"] == s else f", which {service} relies on") for x in weakest]
    return {"service": service, "bus_factor": bf,
            "weakest_links": [{"service": x["service"], "people": x["people"], "is_the_service_itself": x["uid"] == s}
                              for x in weakest],
            "already_unknown": unknown,
            "explanation": f"Bus factor {bf}: " + "; ".join(links) + "."
                           + (f" Already known by nobody: {', '.join(unknown)}." if unknown else ""),
            "per_service": [{k: x[k] for k in ("service", "knowers", "people")} for x in per[:10]],
            "confirmed_by_simulation": confirmed, "evidence": [eid]}


def contradictions(ctx: ToolContext) -> dict:
    """Open contradictions: two sources that disagree, and what they are about."""
    rows = ctx.db.ro(ctx.main, cypher("contradictions"))
    eid = ctx.add_evidence(ctx.main, "contradictions", {}, [r["uid"] for r in rows] +
                           [s["uid"] for r in rows for s in r["sources"]], [], None, "records that disagree with each other",
                           rows=rows)
    return {"contradictions": rows, "evidence": [eid]}


def checkout_info(ctx: ToolContext, date: str) -> dict:
    """The company as it was on a date: its dependencies and the decisions in force."""
    snap = ctx.snap(date)
    g = snap["graph"]
    deps = ctx.db.ro(g, "MATCH (a:Service)-[r:DEPENDS_ON]->(b:Service) RETURN a.name AS a, b.name AS b, r.uid AS uid")
    decisions = ctx.db.ro(g, "MATCH (d:Decision) RETURN d.uid AS uid, d.key AS key, d.title AS title, d.status AS status ORDER BY d.at")
    q = ("MATCH (a:Service)-[r:DEPENDS_ON]->(b:Service) RETURN a.name, b.name, r.uid "
         "UNION MATCH (d:Decision) RETURN d.key, d.status, d.uid")
    eid = ctx.add_evidence(g, "adhoc", {}, [d["uid"] for d in decisions], [r["uid"] for r in deps], date,
                           f"systems and decisions as of {date}", rows=decisions, text=q)
    return {"asof": date, "snapshot": g, "build_ms": snap["total_ms"], "cached": snap["cached"],
            "dependencies": [f"{r['a']} -> {r['b']}" for r in deps], "decisions": decisions, "evidence": [eid]}


UID_COLUMN = re.compile(r"(^|_)uids?$")


def own_graph(tenant: str, g: str) -> bool:
    """The graphs a caller may read directly: its org graph, its epochs and its universes. Never another tenant's,
    and never a memory graph or the deck."""
    return g == dbm.org(tenant) or g.startswith((f"epoch:{tenant}:", f"universe:{tenant}:"))


def cypher_readonly(ctx: ToolContext, query: str, graph: str | None = None) -> dict:
    """Any read-only Cypher on the company (GRAPH.RO_QUERY rejects writes). Only columns named uid / *_uid / *_uids,
    and nodes returned whole, count as what the query touched. Claims citing it can be judged, never verified."""
    g = graph or ep.now(ctx.db, ctx.tenant)
    if not own_graph(ctx.tenant, g):
        raise ValueError(f"{g} is not one of this company's graphs")
    res = ctx.db.graph(g).ro_query(query, {}, timeout=5000)
    cols = [c[1] if isinstance(c, (list, tuple)) else c for c in res.header]
    cols = [c.decode() if isinstance(c, bytes) else str(c) for c in cols]
    rows = res.result_set[:MAX_ROWS]
    uids: list[str] = []

    def collect(v, col: str) -> None:
        if hasattr(v, "properties"):
            if v.properties.get("uid"):
                uids.append(v.properties["uid"])
        elif isinstance(v, list):
            for x in v:
                collect(x, col)
        elif isinstance(v, str) and UID_COLUMN.search(col):
            uids.append(v)

    for row in rows:
        for col, v in zip(cols, row):
            collect(v, col)
    out = [{c: dbm.plain(v) for c, v in zip(cols, row)} for row in rows]
    eid = ctx.add_evidence(g, "adhoc", {}, uids[:200], [], None,
                           "a custom lookup" + ("" if uids else " (names nothing on the map)"), rows=out, text=query)
    return {"columns": cols, "rows": out, "uids_seen": len(set(uids)),
            "note": None if uids else "add uid columns (RETURN s.uid AS uid, ...) so claims can cite what the query touched",
            "evidence": [eid]}


# ---------------------------------------------------------------- acting tools

def fork_scenario(ctx: ToolContext, ops: list[dict], title: str | None = None, kind: str = "whatif") -> dict:
    """Fork the company into a universe, apply typed changes, and diff it against now."""
    from orion import blackboard

    payload = {"ops": ops, "title": title, "kind": kind, "created_by": ctx.user or "agent"}
    res = blackboard.run(ctx.db, ctx.tenant, "fork", payload, posted_by="navigator", follows=ctx.task)
    d = res["diff"]
    remap = {}
    with ctx.lock:
        for e in d["evidence"]:
            eid = f"e{len(ctx.evidence) + 1}"
            ctx.evidence.append({**e, "eid": eid, "universe_eid": e["eid"]})
            remap[e["eid"]] = eid
    uid = res["uid"]

    def relabel(items):
        return [{**i, "evidence": remap.get(i.get("evidence"), i.get("evidence"))} for i in items]

    return {"universe": uid, "title": res["title"], "fork_ms": res["fork_ms"], "copy_ms": res["copy_ms"],
            "risk": {**d["risk"], "evidence": remap.get(f"{uid}.risk")},
            "broken": relabel(d["broken"]), "customers": d["customers"], "new_orphans": relabel(d["new_orphans"]),
            "collaboration_splits": relabel(d["collaboration_splits"]),
            "required_approvers": d["required_approvers"],
            "bottleneck_shift": {"people": d["bottlenecks"]["shift"][:5], "evidence": remap.get(f"{uid}.bottlenecks")},
            "structural": d["structural"], "worker": res.get("_worker"), "evidence": list(remap.values())}


def safe_path(ctx: ToolContext, ops: list[dict]) -> dict:
    """How to make a change without breaking anything: parallel companies are searched for the preparation (move
    each system that relies on what is switched off onto a replacement, or switch it off too) that brings risk down."""
    from orion import planner

    r = planner.plan(ctx.db, ctx.tenant, ops)
    eid = ctx.add_evidence(ctx.snap()["graph"], "adhoc", {"ops": ops}, [], [], None,
                           f"safe path for {r['goal']}: {r['explored']} companies explored, risk {r['baseline']['risk']} -> "
                           f"{r['best']['risk']}", rows={"steps": [s["label"] for s in r["steps"]], "curve": r["curve"]},
                           text="beam search over GRAPH.COPY forks of today's company; each scored like a what-if")
    return {"goal": r["goal"], "explored": r["explored"], "ms": r["ms"], "risk_before": r["baseline"]["risk"],
            "risk_after": r["best"]["risk"], "still_breaks": r["best"]["broken"],
            "steps": [{"step": i + 1, "do": s["label"], "why": s["why"]} for i, s in enumerate(r["steps"])],
            "plan_ops": r["plan_ops"], "evidence": [eid]}


def dry_run(ctx: ToolContext, ops: list[dict], title: str) -> dict:
    """Rehearse an action: the change is made in a forked universe, never the company. Nothing happens until the
    teams it names approve it."""
    res = fork_scenario(ctx, ops, title=title, kind="dryrun")
    res["status"] = "awaiting_approval" if not res["risk"]["auto_approve"] else "auto_approvable"
    return res


def remember(ctx: ToolContext, key: str, text: str, kind: str = "belief") -> dict:
    """Remember something about the person asking (their team, what they care about) for later conversations."""
    from orion.memory import remember as keep

    if not ctx.user:
        return {"error": "no user"}
    return {**keep(ctx.db, ctx.tenant, ctx.user, key, text, ctx.now(), kind), "evidence": []}


def next_page(ctx: ToolContext, cursor: str, limit: int = 50) -> dict:
    """The next rows of a result that was too long to show at once."""
    page = ctx.pages.get(cursor)
    if not page:
        return {"error": f"no cursor {cursor}"}
    rows, rest = page["rows"][:limit], page["rows"][limit:]
    page["rows"] = rest
    return {"tool": page["tool"], page["key"]: rows, "more_rows": len(rest), "cursor": cursor if rest else None,
            "evidence": []}


# ---------------------------------------------------------------- registry

def S(**props) -> dict:
    req = [k for k, v in props.items() if not v.pop("optional", False)]
    return {"type": "object", "properties": props, "required": req}


def STR(d: str, **kw) -> dict:
    return {"type": "string", "description": d, **kw}


def OPT(d: str) -> dict:
    return {"type": "string", "description": d, "optional": True}


OP_SCHEMA = {
    "type": "object",
    "description": "One typed change. op is one of: deprecate_service{service}, remove_person{person}, "
                   "move_person{person,team}, reassign_owner{service,team}, add_dependency{source,target,kind}, "
                   "remove_dependency{source,target}, declare_dependency{source,target}, reverse_decision{decision}, "
                   "merge_teams{team,into}, create_ticket{title,service,priority,body}. Names are accepted.",
    "properties": {"op": {"type": "string"}},
    "required": ["op"],
    "additionalProperties": True,
}

TOOLS: dict[str, dict] = {
    "find_entities": {"fn": find_entities, "schema": S(text=STR("names or words to look for")),
                      "description": "Find people, services, teams, customers, projects, decisions and the messages "
                                     "and documents about them. Start here when names are unclear."},
    "impact": {"fn": impact_tool, "schema": S(service=STR("service name"),
                                              direction={"type": "string", "enum": ["upstream", "downstream"], "optional": True},
                                              asof=OPT("ISO date; default now")),
               "description": "What depends on a service at any depth (upstream: what breaks if it goes), as of a date, "
                              "and which paths run only through dependencies nobody wrote down."},
    "broken_dependencies": {"fn": broken_dependencies, "schema": S(asof=OPT("ISO date; default now")),
                            "description": "Services that still depend on a switched-off service."},
    "who_knows": {"fn": who_knows, "schema": S(service=STR("service name"), asof=OPT("ISO date")),
                  "description": "Who actually knows a service (changes and reviews in 180 days) against its declared and "
                                 "de-facto owners."},
    "ownership": {"fn": ownership, "schema": S(service=STR("service name"), asof=OPT("ISO date")),
                  "description": "Declared owner with its source, and the de-facto owner from who makes the changes."},
    "decision_history": {"fn": decision_history, "schema": S(entity=STR("service, decision or other entity")),
                         "description": "Decisions about an entity, what superseded or reversed what, and the messages "
                                        "and documents behind them."},
    "blame": {"fn": blame, "schema": S(fact_uid=STR("fact uid, e.g. dep:invoice-render->sso-legacy@2024-06-10")),
              "description": "Where a fact came from: author, time and the exact words."},
    "customer_timeline": {"fn": customer_timeline, "schema": S(customer=STR("customer name"), since=OPT("ISO date")),
                          "description": "Everything a customer raised, its status, and what blocks it."},
    "trace_path": {"fn": trace_path, "schema": S(a=STR("entity"), b=STR("entity")),
                   "description": "How two things in the company are connected (shortest paths)."},
    "neighborhood": {"fn": neighborhood, "schema": S(entity=STR("entity")),
                     "description": "Everything directly connected to an entity right now."},
    "bottlenecks": {"fn": bottlenecks, "schema": S(asof=OPT("ISO date")),
                    "description": "The people everything routes through (betweenness over collaboration)."},
    "influence": {"fn": influence, "schema": S(asof=OPT("ISO date")),
                  "description": "Knowledge hubs (PageRank over collaboration)."},
    "communities": {"fn": communities, "schema": S(asof=OPT("ISO date")),
                    "description": "The groups people actually work in, compared with the official teams, and the "
                                   "people who bridge them."},
    "bus_factor": {"fn": bus_factor, "schema": S(service=STR("service name")),
                   "description": "How many people can leave before nobody knows a service or anything it relies on; "
                                  "the weakest link, confirmed in a throwaway fork."},
    "contradictions": {"fn": contradictions, "schema": S(), "description": "Records that disagree with each other."},
    "checkout": {"fn": checkout_info, "schema": S(date=STR("ISO date")),
                 "description": "The company as it was on a date: dependencies and decisions in force."},
    "cypher_readonly": {"fn": cypher_readonly, "schema": S(query=STR("read-only Cypher")),
                        "description": "Any read-only Cypher on the company now. Schema: (:Person)-[:MEMBER_OF]->(:Team)"
                                       "-[:OWNS]->(:Service)-[:DEPENDS_ON]->(:Service); (:Person)-[:AUTHORED|REVIEWED]->"
                                       "(:Change)-[:MODIFIES]->(:Service); (:Person)-[:KNOWS]->(:Service); (:Decision)-"
                                       "[:AFFECTS]->(); (:Ticket)-[:ABOUT]->(:Service); (:Ticket)-[:RAISED_BY]->(:Customer)."},
    "fork": {"fn": fork_scenario,
             "schema": {"type": "object", "properties": {"ops": {"type": "array", "items": OP_SCHEMA},
                                                         "title": {"type": "string"}}, "required": ["ops"]},
             "description": "What-if: copy the whole company into a universe, apply the changes and diff it against now "
                            "(what breaks, customers who would notice, what nobody would know, who must approve, risk)."},
    "safe_path": {"fn": safe_path,
                  "schema": {"type": "object", "properties": {"ops": {"type": "array", "items": OP_SCHEMA}}, "required": ["ops"]},
                  "description": "How to make a change safely: searches parallel companies for the preparation (moving the "
                                 "systems that rely on what is switched off, in order) that brings risk to the lowest. "
                                 "Use when asked how to do something safely or in what order."},
    "dry_run": {"fn": dry_run,
                "schema": {"type": "object", "properties": {"ops": {"type": "array", "items": OP_SCHEMA},
                                                            "title": {"type": "string"}}, "required": ["ops", "title"]},
                "description": "Act on the company: any change you want to make goes through dry_run. It rehearses the "
                               "change in a universe; nothing happens until the teams it names approve."},
    "remember": {"fn": remember, "schema": S(key=STR("short key, e.g. 'team'"), text=STR("what to remember"),
                                             kind={"type": "string", "enum": ["belief", "preference"], "optional": True}),
                 "description": "Remember something about the person asking for future conversations."},
    "next_page": {"fn": next_page, "schema": {"type": "object", "properties": {"cursor": {"type": "string"},
                                                                               "limit": {"type": "integer"}},
                                              "required": ["cursor"]},
                  "description": "More rows of a result that said truncated: true (pass its cursor)."},
}


def tool_specs(names: list[str] | None = None) -> list[dict]:
    return [{"name": n, "description": x["description"], "schema": x["schema"]}
            for n, x in TOOLS.items() if names is None or n in names]


def paginate(ctx: ToolContext, name: str, result: dict) -> dict:
    """Keep a result small: the first rows of its longest list, the rest behind a cursor for next_page."""
    if len(json.dumps(result, default=str)) <= MAX_TOOL_CHARS:
        return result
    lists = [(k, v) for k, v in result.items() if isinstance(v, list) and k != "evidence"]
    if not lists:
        return result
    key, rows = max(lists, key=lambda kv: len(json.dumps(kv[1], default=str)))
    keep = len(rows)
    while keep > 1 and len(json.dumps({**result, key: rows[:keep]}, default=str)) > MAX_TOOL_CHARS:
        keep = max(1, keep * 2 // 3)
    with ctx.lock:
        cursor = f"p{len(ctx.pages) + 1}"
        ctx.pages[cursor] = {"tool": name, "key": key, "rows": rows[keep:]}
    return {**result, key: rows[:keep], "truncated": True, "shown_rows": keep, "more_rows": len(rows) - keep,
            "cursor": cursor}


def call_tool(ctx: ToolContext, name: str, args: dict) -> dict:
    t0 = time.perf_counter()
    try:
        with dbm.tagged(f"task:{ctx.task}" if ctx.task else dbm.ORIGIN.get()):
            result = TOOLS[name]["fn"](ctx, **args)
        ok = "error" not in result
    except Exception as e:  # reported to the model instead of crashing the loop
        result = {"error": f"{type(e).__name__}: {e}"}
        ok = False
    result = paginate(ctx, name, result)
    ms = round((time.perf_counter() - t0) * 1000, 1)
    eids = set(result.get("evidence", []))
    with ctx.lock:
        nodes = sorted({u for e in ctx.evidence if e["eid"] in eids for u in e["node_uids"]})
    call = {"tool": name, "args": args, "ms": ms, "ok": ok, "evidence": result.get("evidence", []),
            "truncated": bool(result.get("truncated")), "nodes": nodes[:200]}
    with ctx.lock:
        ctx.calls.append(call)
    if ctx.on_event:
        ctx.on_event({"type": "tool_result", **call})
    return result


def to_json(result: dict) -> str:
    return json.dumps(result, default=str, ensure_ascii=False)


# the names older modules use
Ctx = ToolContext
run = call_tool
