"""The graph tools: one set shared by the Navigator, the MCP server and the web app.

Every tool returns rows and an evidence record: the graph it read, the Cypher, the parameters and the uids it
touched. Answers cite evidence by id, claims are checked against it, and when any of those uids changes later the
claims that relied on it are re-checked (watch.py). Reads go through GRAPH.RO_QUERY.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

from orion import algos, impact
from orion import db as dbm
from orion import epoch as ep
from orion import ops as opsm
from orion.aliases import Resolver

MAX_ROWS = 60


@dataclass
class Ctx:
    db: dbm.DB
    tenant: str
    user: str | None = None
    _resolver: Resolver | None = field(default=None, repr=False)

    @property
    def now(self) -> str:
        return ep.now(self.db, self.tenant)

    @property
    def org(self) -> str:
        return dbm.org(self.tenant)

    def resolver(self) -> Resolver:
        if self._resolver is None:
            self._resolver = opsm.resolver(self.db, self.org)
        return self._resolver

    def one(self, name: str, label: str | None = None) -> dict:
        """A name, nickname or uid -> exactly one node of the company. Raises with the candidates otherwise."""
        g = self.now
        if ":" in name and not name.startswith("#"):
            row = self.db.one(self.org, "MATCH (n {uid: $u}) RETURN n.uid AS uid, labels(n) AS labels, "
                                        "coalesce(n.name, n.key, n.title) AS name", {"u": name})
            if row:
                return row
        hits = self.resolver().resolve(name)
        if label:
            hits = [h for h in hits if self.resolver().kind.get(h) == label]
        if len(hits) != 1:
            # fall back to the full-text index over aliases (typos, partial names)
            rows = self.db.ro(self.org, """CALL db.idx.fulltext.queryNodes('Alias', $q) YIELD node, score
                                           MATCH (node)-[:NAMES]->(n) RETURN DISTINCT n.uid AS uid,
                                           labels(n)[0] AS label, score ORDER BY score DESC LIMIT 5""",
                              {"q": _ft(name)})
            if label:
                rows = [r for r in rows if r["label"] == label]
            if len(hits) > 1 or not rows:
                raise LookupError(f"'{name}' names {'several things' if len(hits) > 1 else 'nothing I know'}"
                                  + (f": {', '.join(hits[:5])}" if hits else ""))
            hits = [rows[0]["uid"]]
        row = self.db.one(self.org, "MATCH (n {uid: $u}) RETURN n.uid AS uid, labels(n) AS labels, "
                                    "coalesce(n.name, n.key, n.title) AS name", {"u": hits[0]})
        assert g
        return row


FT_STOP = {"what", "who", "whom", "which", "when", "where", "why", "how", "does", "did", "the", "and", "for", "are",
           "was", "were", "has", "have", "had", "will", "would", "could", "should", "can", "our", "their", "this",
           "that", "with", "from", "into", "about", "if", "is", "it", "we", "a", "an", "to", "of", "on", "in", "do",
           "be", "or", "anyone", "still", "any", "all", "last", "next", "knows", "know", "break", "breaks"}


def _ft(text: str) -> str:
    """Full-text query: the meaningful words, any of them, prefix-matched."""
    words = [w for w in re.findall(r"[A-Za-z0-9]+", text.lower()) if w not in FT_STOP and len(w) > 2]
    return "|".join(w + "*" for w in words[:8]) or text


class Evidence:
    """Collects rows and the uids they touch while a tool runs."""

    def __init__(self, ctx: Ctx, tool: str, args: dict):
        self.ctx, self.tool, self.args = ctx, tool, args
        self.queries: list[dict] = []
        self.uids: list[str] = []

    def read(self, graph: str, cypher: str, params: dict | None = None) -> list[dict]:
        rows = self.ctx.db.ro(graph, cypher, params or {})
        self.queries.append({"graph": graph, "cypher": _tidy(cypher), "params": params or {}, "rows": len(rows)})
        for r in rows:
            self.touch(r)
        return rows

    def touch(self, v: Any) -> None:
        if isinstance(v, dict):
            for k, x in v.items():
                if (k == "uid" or k.endswith("_uid")) and isinstance(x, str):
                    self.add(x)
                elif k.endswith("_uids") and isinstance(x, list):
                    for u in x:
                        self.add(u)
                else:
                    self.touch(x)
        elif isinstance(v, list):
            for x in v:
                self.touch(x)

    def add(self, uid: str) -> None:
        if uid and uid not in self.uids:
            self.uids.append(uid)

    def done(self, rows: Any, summary: str) -> dict:
        return {"tool": self.tool, "args": self.args, "summary": summary, "rows": rows, "uids": self.uids,
                "queries": self.queries}


def _tidy(cypher: str) -> str:
    return re.sub(r"\s+", " ", cypher).strip()


# ---------------------------------------------------------------- tools

def find_entities(ctx: Ctx, text: str) -> dict:
    """Resolve names in a question to company entities, and search messages, docs and tickets for the words."""
    ev = Evidence(ctx, "find_entities", {"text": text})
    res = ctx.resolver()
    found = res.mentions(text)
    ents = ev.read(ctx.org, """MATCH (n) WHERE n.uid IN $u
                               RETURN n.uid AS uid, labels(n)[0] AS label, coalesce(n.name, n.key) AS name""",
                   {"u": found}) if found else []
    sources = ev.read(ctx.org, """CALL db.idx.fulltext.queryNodes('Source', $q) YIELD node, score
                                  WHERE NOT node:Change
                                  RETURN node.uid AS uid, labels(node)[1] AS kind, coalesce(node.title, node.channel) AS title,
                                         node.at AS at, left(node.text, 220) AS text, score
                                  ORDER BY score DESC LIMIT 6""", {"q": _ft(text)})
    return ev.done({"entities": ents, "sources": sources},
                   f"{len(ents)} entities, {len(sources)} matching sources")


def impact_of(ctx: Ctx, service: str, on: str | None = None, known: bool = False) -> dict:
    """Everything that depends on a service at any depth, with how it is affected and one path that proves it.
    `on` asks about a past date; `known` restricts to what was written down by then."""
    s = ctx.one(service, "Service")
    ev = Evidence(ctx, "impact", {"service": s["name"], "on": on, "known": known})
    g = ctx.org if on else ctx.now
    walk = impact.walk(ctx.db, g, [s["uid"]], on=on, known=known)
    ev.queries.append({"graph": g, "cypher": _tidy(impact.HOP_ON if on else impact.HOP),
                       "params": {"frontier": [s["uid"]], "...": "one query per hop"}, "rows": len(walk)})
    facts = sorted({f for w in walk.values() for f in w["facts"]})
    meta = {r["uid"]: r for r in ev.read(ctx.org, """MATCH (a)-[r:DEPENDS_ON]->(b) WHERE r.uid IN $f
                                                    OPTIONAL MATCH (src:Source {uid: r.src})
                                                    RETURN r.uid AS uid, r.src AS src, src.title AS src_title,
                                                           r.recorded_at AS recorded_at, r.valid_from AS valid_from""",
                                         {"f": facts})}
    names = impact.names(ctx.db, ctx.org, {u for w in walk.values() for u in w["path"]})
    rows = []
    for w in sorted(walk.values(), key=lambda w: (-impact.SEVERITY[w["effect"]], w["depth"], w["name"])):
        undeclared = [meta[f] for f in w["facts"] if f in meta and not meta[f]["src"].startswith("doc:")]
        rows.append({"uid": w["uid"], "name": w["name"], "tier": w["tier"], "effect": w["effect"], "depth": w["depth"],
                     "path": [names.get(u, u) for u in w["path"]], "fact_uids": w["facts"],
                     "not_in_catalog": [{"fact": m["uid"], "from": m["src"], "recorded_at": m["recorded_at"]}
                                        for m in undeclared]})
    ev.add(s["uid"])
    hard = [r["name"] for r in rows if r["effect"] == "break"]
    return ev.done({"service": s["name"], "dependents": rows},
                   f"{len(rows)} services depend on {s['name']}" + (f"; would break: {', '.join(hard)}" if hard else ""))


def who_knows(ctx: Ctx, service: str) -> dict:
    """Who knows a service now (3+ changes or reviews in 180 days), who owns it, and who knew it but left."""
    s = ctx.one(service, "Service")
    ev = Evidence(ctx, "who_knows", {"service": s["name"]})
    knows = ev.read(ctx.now, """MATCH (p:Person)-[k:KNOWS]->(s:Service {uid: $s}) OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
                                RETURN p.uid AS uid, p.name AS name, t.name AS team, k.n AS changes
                                ORDER BY changes DESC""", {"s": s["uid"]})
    owner = ev.read(ctx.now, "MATCH (t:Team)-[:OWNS]->(:Service {uid: $s}) RETURN t.uid AS uid, t.name AS team",
                    {"s": s["uid"]})
    former = ev.read(ctx.now, """MATCH (p:Former)-[:AUTHORED|REVIEWED]->(c:Change)-[:MODIFIES]->(:Service {uid: $s})
                                 RETURN p.uid AS uid, p.name AS name, p.left AS left, count(c) AS changes, max(c.at) AS last
                                 ORDER BY changes DESC""", {"s": s["uid"]})
    ev.add(s["uid"])
    who = ", ".join(k["name"] for k in knows) or "nobody"
    return ev.done({"service": s["name"], "knows": knows, "owner": owner[0] if owner else None, "left": former},
                   f"{who} know{'s' if len(knows) == 1 else ''} {s['name']}")


def bus_factor(ctx: Ctx) -> dict:
    """Services that one person or nobody knows, most critical first."""
    ev = Evidence(ctx, "bus_factor", {})
    rows = ev.read(ctx.now, """MATCH (s:Service) OPTIONAL MATCH (p:Person)-[:KNOWS]->(s)
                               OPTIONAL MATCH (t:Team)-[:OWNS]->(s)
                               WITH s, t, collect(p.name) AS knowers, collect(p.uid) AS knower_uids
                               WHERE size(knowers) <= 1
                               RETURN s.uid AS uid, s.name AS name, s.tier AS tier, t.name AS owner, knowers, knower_uids
                               ORDER BY size(knowers), s.tier, s.name""")
    return ev.done(rows, "; ".join(f"{r['name']} (tier {r['tier']}): {', '.join(r['knowers']) or 'nobody'}" for r in rows))


def decision_history(ctx: Ctx, about: str) -> dict:
    """Decisions about a service (or one decision), what superseded or reversed what, and the sources behind each."""
    e = ctx.one(about)
    ev = Evidence(ctx, "decision_history", {"about": e["name"]})
    if "Decision" in e["labels"]:
        match, params = "MATCH (d:Decision {uid: $u})", {"u": e["uid"]}
    else:
        match, params = "MATCH (d:Decision)-[:AFFECTS]->({uid: $u})", {"u": e["uid"]}
    rows = ev.read(ctx.org, f"""{match}
                                OPTIONAL MATCH (d)-[:MADE_BY]->(t:Team)
                                OPTIONAL MATCH (d)-[:DECIDED_BY]->(p)
                                OPTIONAL MATCH (d)-[s:SUPERSEDES]->(old:Decision)
                                OPTIONAL MATCH (newer:Decision)-[s2:SUPERSEDES]->(d)
                                OPTIONAL MATCH (d)-[:EVIDENCED_BY]->(src:Source)
                                RETURN d.uid AS uid, d.key AS key, d.title AS title, d.status AS status, d.at AS at,
                                       d.summary AS summary, t.name AS team, collect(DISTINCT p.name) AS decided_by,
                                       old.key AS supersedes, s.how AS how, newer.key AS superseded_by, s2.how AS by_how,
                                       collect(DISTINCT {{uid: src.uid, title: coalesce(src.title, src.channel),
                                                         at: src.at, text: left(src.text, 200)}}) AS sources
                                ORDER BY at""", params)
    for r in rows:
        r["sources"] = [s for s in r["sources"] if s.get("uid")]
    ev.add(e["uid"])
    return ev.done(rows, "; ".join(f"{r['key']} {r['status']}: {r['title']}" for r in rows) or "no decisions recorded")


def blame(ctx: Ctx, subject: str, object: str | None = None) -> dict:
    """Where a fact came from. With two entities: the relationships between them (open and closed), each with its
    validity, when it was recorded, the source and who wrote it. With one: every fact about it."""
    a = ctx.one(subject)
    ev = Evidence(ctx, "blame", {"subject": a["name"], "object": object})
    params = {"a": a["uid"]}
    if object:
        b = ctx.one(object)
        params["b"] = b["uid"]
        where = "(x.uid = $a AND y.uid = $b) OR (x.uid = $b AND y.uid = $a)"
    else:
        where = "x.uid = $a OR y.uid = $a"
    rows = ev.read(ctx.org, f"""MATCH (x)-[r]->(y) WHERE ({where}) AND r.src IS NOT NULL
                                OPTIONAL MATCH (src:Source {{uid: r.src}})
                                OPTIONAL MATCH (src)-[:POSTED_BY|WRITTEN_BY]->(author:Person)
                                OPTIONAL MATCH (dec:Decision {{uid: r.src}})
                                OPTIONAL MATCH (closer:Decision {{uid: r.closed_by}})
                                RETURN r.uid AS uid, type(r) AS rel, x.name AS from, y.name AS to, r.kind AS kind,
                                       r.valid_from AS valid_from, r.valid_to AS valid_to, r.recorded_at AS recorded_at,
                                       r.src AS source_uid, coalesce(src.title, src.channel, dec.title) AS source,
                                       src.at AS source_at, left(src.text, 300) AS source_text, author.name AS author,
                                       closer.key AS closed_by
                                ORDER BY valid_from DESC LIMIT {MAX_ROWS}""", params)
    for r in rows:
        r["open"] = r["valid_to"] == "9999-12-31"
        r["known_late"] = (r["recorded_at"] or "")[:10] > (r["valid_from"] or "")[:10]
    return ev.done(rows, f"{len(rows)} facts" + (f" between {a['name']} and {object}" if object else f" about {a['name']}"))


def customer_story(ctx: Ctx, customer: str) -> dict:
    """A customer's tickets, what is blocking the open ones (any depth), and the services they use."""
    c = ctx.one(customer, "Customer")
    ev = Evidence(ctx, "customer_story", {"customer": c["name"]})
    tickets = ev.read(ctx.org, """MATCH (cu:Customer {uid: $c})<-[:RAISED_BY]-(t:Ticket)
                                  OPTIONAL MATCH (t)-[:ABOUT]->(s:Service)
                                  OPTIONAL MATCH chain = (b:Ticket)-[:BLOCKS*1..4]->(t) WHERE b.status = 'open'
                                  RETURN t.uid AS uid, t.key AS key, t.title AS title, t.kind AS kind, t.status AS status,
                                         t.opened AS opened, collect(DISTINCT s.name) AS services,
                                         collect(DISTINCT [n IN nodes(chain) | n.key]) AS blocked_by
                                  ORDER BY opened DESC LIMIT 20""", {"c": c["uid"]})
    for t in tickets:
        t["blocked_by"] = [list(reversed(ch)) for ch in t["blocked_by"] if ch]
        t["blocked_by"] = [ch for ch in t["blocked_by"] if not any(set(ch) < set(o) for o in t["blocked_by"])]
    uses = ev.read(ctx.now, "MATCH (:Customer {uid: $c})-[:USES]->(s:Service) RETURN s.uid AS uid, s.name AS name",
                   {"c": c["uid"]})
    row = ctx.db.one(ctx.org, "MATCH (c:Customer {uid: $c}) RETURN c.tier AS tier, c.industry AS industry, c.since AS since",
                     {"c": c["uid"]})
    ev.add(c["uid"])
    open_ = [t for t in tickets if t["status"] == "open"]
    return ev.done({"customer": c["name"], **row, "tickets": tickets, "uses": uses},
                   f"{c['name']}: {len(tickets)} tickets, {len(open_)} open" +
                   "".join(f"; {t['key']} blocked by {' <- '.join(ch[1:])}" for t in open_ for ch in t["blocked_by"]))


def org_vs_reality(ctx: Ctx) -> dict:
    """Declared owner of each service against the team whose people actually changed it in the last 180 days."""
    ev = Evidence(ctx, "org_vs_reality", {})
    since = _days_before(dbm.clock(ctx.db, ctx.tenant), 180)
    rows = ev.read(ctx.now, """MATCH (t:Team)-[:OWNS]->(s:Service)
                               MATCH (p:Person)-[:AUTHORED]->(c:Change)-[:MODIFIES]->(s) WHERE c.at >= $since
                               MATCH (p)-[:MEMBER_OF]->(pt:Team)
                               WITH s, t, pt, count(c) AS n
                               ORDER BY n DESC
                               WITH s, t, collect({team: pt.name, team_uid: pt.uid, n: n}) AS by_team
                               WITH s, t, by_team, by_team[0] AS top
                               WHERE top.team_uid <> t.uid
                               RETURN s.uid AS uid, s.name AS service, t.name AS declared_owner, top.team AS actually,
                                      top.n AS changes, by_team""", {"since": since})
    docs = ev.read(ctx.org, """MATCH (d:Doc)-[:MENTIONS]->(s:Service) WHERE s.uid IN $u
                               RETURN d.uid AS uid, d.title AS doc, d.at AS at, s.name AS service""",
                   {"u": [r["uid"] for r in rows]})
    return ev.done({"mismatches": rows, "docs": docs},
                   "; ".join(f"{r['service']}: declared {r['declared_owner']}, changed by {r['actually']} ({r['changes']})"
                             for r in rows) or "every service is changed mostly by its owner")


def hidden_teams(ctx: Ctx) -> dict:
    """Groups who work together across team lines (WCC over cross-team collaboration), and the project they share."""
    ev = Evidence(ctx, "hidden_teams", {})
    groups = algos.hidden_teams(ctx.db, ctx.now)
    ev.queries.append({"graph": ctx.now, "cypher": _tidy(algos.HIDDEN), "params": {}, "rows": len(groups)})
    ev.touch(groups)
    return ev.done(groups, "; ".join(", ".join(p["name"] for p in g["people"]) + " across " +
                                     ", ".join(sorted({p["team_name"] for p in g["people"]})) for g in groups) or "none")


def contradictions(ctx: Ctx) -> dict:
    """Open contradictions: two sources that disagree, and what they are about."""
    ev = Evidence(ctx, "contradictions", {})
    rows = ev.read(ctx.org, """MATCH (c:Contradiction {status: 'open'})-[:BETWEEN]->(s:Source)
                               OPTIONAL MATCH (s)-[:POSTED_BY]->(p:Person)
                               OPTIONAL MATCH (c)-[:ABOUT]->(e)
                               RETURN c.uid AS uid, c.topic AS topic, c.at AS at,
                                      collect(DISTINCT {uid: s.uid, at: s.at, text: s.text, author: p.name}) AS sides,
                                      collect(DISTINCT e.uid) AS about_uids""")
    return ev.done(rows, "; ".join(r["topic"] for r in rows) or "none open")


def connection(ctx: Ctx, a: str, b: str) -> dict:
    """The shortest ways two things in the company are connected."""
    x, y = ctx.one(a), ctx.one(b)
    ev = Evidence(ctx, "connection", {"a": x["name"], "b": y["name"]})
    rows = ev.read(ctx.now, """MATCH (x {uid: $a}), (y {uid: $b})
                               WITH x, y MATCH p = allShortestPaths((x)-[:DEPENDS_ON|OWNS|MEMBER_OF|KNOWS|COLLABORATES|WORKED_ON|TOUCHES|USES*..6]-(y))
                               RETURN [n IN nodes(p) | n.uid] AS path_uids,
                                      [n IN nodes(p) | coalesce(n.name, n.key)] AS path,
                                      [r IN relationships(p) | type(r)] AS rels LIMIT 3""", {"a": x["uid"], "b": y["uid"]})
    return ev.done(rows, "; ".join(" - ".join(r["path"]) for r in rows) or "not connected within 6 hops")


def checkout(ctx: Ctx, on: str, known: bool = False) -> dict:
    """The company as it stood on a date (or as it was known that day): who was here, what ran, what has changed
    since."""
    mode = "known" if known else "true"
    g = ep.ensure(ctx.db, ctx.tenant, on[:10], mode)
    ev = Evidence(ctx, "checkout", {"on": on[:10], "known": known})
    then = ev.read(g, """MATCH (s:Service) WITH collect(s.name) AS services
                         MATCH (p:Person) WITH services, count(p) AS people
                         OPTIONAL MATCH (d:Decision) WHERE d.status = 'accepted'
                         RETURN services, people, collect(d.key) AS decisions""")[0]
    now = ctx.db.one(ctx.now, "MATCH (s:Service) RETURN collect(s.name) AS services")
    return ev.done({"on": on[:10], "graph": g, "people": then["people"], "services": sorted(then["services"]),
                    "decisions_in_force": then["decisions"],
                    "services_since_added": sorted(set(now["services"]) - set(then["services"])),
                    "services_since_retired": sorted(set(then["services"]) - set(now["services"]))},
                   f"{on[:10]}: {len(then['services'])} services, {then['people']} people")


def findings(ctx: Ctx, about: str) -> dict:
    """What was simulated before about an entity, by any person or agent."""
    e = ctx.one(about)
    ev = Evidence(ctx, "findings", {"about": e["name"]})
    rows = ev.read(ctx.org, """MATCH (f:Finding)-[:ABOUT]->({uid: $u})
                               RETURN f.uid AS uid, f.universe AS universe, f.title AS title, f.risk AS risk,
                                      f.level AS level, f.at AS at, f.summary AS summary
                               ORDER BY at DESC LIMIT 5""", {"u": e["uid"]})
    return ev.done(rows, f"{len(rows)} earlier simulations about {e['name']}")


def what_if(ctx: Ctx, changes: list[dict]) -> dict:
    """Fork the company, apply changes, and diff: what breaks, who is exposed, who must approve, risk."""
    from orion import universe as uv

    rec = uv.fork(ctx.db, ctx.tenant, changes, by=ctx.user or "agent:navigator")
    ev = Evidence(ctx, "what_if", {"changes": changes})
    d = rec["diff"]
    ev.queries.append({"graph": rec["graph"], "cypher": "GRAPH.COPY epoch:now -> universe, apply ops, diff",
                       "params": {"universe": rec["uid"]}, "rows": len(d["breaks"])})
    ev.touch({"retired": d["retired"], "breaks": d["breaks"], "customers": d["customers"], "orphans": d["orphans"]})
    return ev.done({"universe": rec["uid"], "title": rec["title"], "risk": d["risk"]["score"], "level": d["risk"]["level"],
                    "breaks": [{k: b[k] for k in ("uid", "name", "effect", "depth", "path_names", "tier")} for b in d["breaks"]],
                    "customers": [{k: c[k] for k in ("uid", "name", "tier", "effect", "via", "tickets")} for c in d["customers"]],
                    "orphans": d["orphans"], "approvals": d["approvals"], "dangling": d["dangling"],
                    "risk_terms": d["risk"]["terms"][:8]}, d["summary"])


def cypher_readonly(ctx: Ctx, query: str, graph: str = "now") -> dict:
    """Any read-only Cypher on this company's current graph ('now') or its full history ('org'). Writes are refused
    by FalkorDB (GRAPH.RO_QUERY). Claims that cite it can be judged, never verified."""
    g = ctx.now if graph == "now" else ctx.org
    ev = Evidence(ctx, "cypher_readonly", {"query": query, "graph": graph})
    rows = ev.read(g, query)[:MAX_ROWS]
    return ev.done(rows, f"{len(rows)} rows")


def _days_before(iso: str, days: int) -> str:
    from datetime import date, timedelta

    return (date.fromisoformat(iso[:10]) - timedelta(days=days)).isoformat()


# ---------------------------------------------------------------- registry: name -> (function, description, schema)

def _s(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


STR = {"type": "string"}
CHANGE = {"type": "object", "additionalProperties": False, "required": ["op"],
          "properties": {"op": {"type": "string", "enum": list(opsm.OPS)}, "service": STR, "replacement": STR,
                         "person": STR, "team": STR, "into": STR, "on": STR,
                         "kind": {"type": "string", "enum": ["sync", "async", "data"]}}}

TOOLS: dict[str, tuple[Callable, dict]] = {
    "find_entities": (find_entities, _s({"text": STR}, ["text"])),
    "impact": (impact_of, _s({"service": STR, "on": {"type": "string", "description": "ISO date, optional"},
                              "known": {"type": "boolean"}}, ["service"])),
    "who_knows": (who_knows, _s({"service": STR}, ["service"])),
    "bus_factor": (bus_factor, _s({}, [])),
    "decision_history": (decision_history, _s({"about": STR}, ["about"])),
    "blame": (blame, _s({"subject": STR, "object": STR}, ["subject"])),
    "customer_story": (customer_story, _s({"customer": STR}, ["customer"])),
    "org_vs_reality": (org_vs_reality, _s({}, [])),
    "hidden_teams": (hidden_teams, _s({}, [])),
    "contradictions": (contradictions, _s({}, [])),
    "connection": (connection, _s({"a": STR, "b": STR}, ["a", "b"])),
    "checkout": (checkout, _s({"on": STR, "known": {"type": "boolean"}}, ["on"])),
    "findings": (findings, _s({"about": STR}, ["about"])),
    "what_if": (what_if, _s({"changes": {"type": "array", "items": CHANGE, "minItems": 1}}, ["changes"])),
    "cypher_readonly": (cypher_readonly, _s({"query": STR, "graph": {"type": "string", "enum": ["now", "org"]}}, ["query"])),
}


def specs() -> list[dict]:
    return [{"name": n, "description": (f.__doc__ or "").strip(), "schema": schema} for n, (f, schema) in TOOLS.items()]


def run(ctx: Ctx, name: str, args: dict) -> dict:
    if name not in TOOLS:
        raise LookupError(f"no tool named {name}")
    fn, _ = TOOLS[name]
    clean = {k: v for k, v in args.items() if v not in (None, "")}
    return fn(ctx, **clean)
