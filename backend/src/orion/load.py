"""Write a World into its org graph.

Everything that can stop being true is a relationship with a validity interval: MEMBER_OF, OWNS, DEPENDS_ON,
USES, WORKED_ON carry valid_from / valid_to (9999-12-31 while it holds), recorded_at (when Corvane learned it)
and src (the uid of the :Source it came from). Nothing is deleted from the org graph; it is closed instead.
That is what lets an epoch rebuild the company on any date, either as it was or as it was known to be."""

from __future__ import annotations

from orion import db as dbm
from orion.aliases import aliases_for, Resolver
from orion.world.corvane import World, day_index

INDEXES = [
    ("Team", "uid"), ("Person", "uid"), ("Service", "uid"), ("Customer", "uid"), ("Project", "uid"),
    ("Source", "uid"), ("Change", "uid"), ("Ticket", "uid"), ("Message", "uid"), ("Doc", "uid"),
    ("Decision", "uid"), ("Contradiction", "uid"), ("Alias", "text"), ("Answer", "uid"), ("Claim", "uid"),
    ("Finding", "uid"), ("Service", "name"), ("Person", "name"),
]


def _batches(rows: list[dict], n: int = 400):
    for i in range(0, len(rows), n):
        yield rows[i:i + n]


def load(db: dbm.DB, w: World) -> dict:
    g = dbm.org(w.tenant)
    db.delete(g)
    for label, prop in INDEXES:
        db.q(g, f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")
    db.q(g, "CREATE INDEX FOR ()-[r:DEPENDS_ON]-() ON (r.uid)")
    db.q(g, "CREATE INDEX FOR ()-[r:OWNS]-() ON (r.uid)")
    db.q(g, "CREATE INDEX FOR ()-[r:MEMBER_OF]-() ON (r.uid)")
    db.q(g, "CREATE FULLTEXT INDEX FOR (n:Source) ON (n.text, n.title)")
    db.q(g, "CREATE FULLTEXT INDEX FOR (n:Alias) ON (n.text)")

    def run(cypher: str, rows: list[dict]):
        for b in _batches(rows):
            db.q(g, cypher, {"rows": b})

    db.q(g, "CREATE (:Company {tenant: $t, name: $n, clock: $c})", {"t": w.tenant, "n": w.company, "c": w.clock})
    run("UNWIND $rows AS r CREATE (:Team {uid: r.uid, name: r.name, mission: r.mission, created: r.created})", w.teams)
    run("""UNWIND $rows AS r CREATE (:Person {uid: r.uid, name: r.name, first: r.first, handle: r.handle,
           role: r.role, joined: r.joined, left: r.left})""", w.people)
    run("""UNWIND $rows AS r CREATE (:Service {uid: r.uid, name: r.name, tier: r.tier, lang: r.lang,
           created: r.created, retired: r.retired, summary: r.summary})""", w.services)
    run("""UNWIND $rows AS r CREATE (:Customer {uid: r.uid, name: r.name, tier: r.tier, industry: r.industry,
           since: r.since})""", w.customers)
    run("""UNWIND $rows AS r CREATE (:Project {uid: r.uid, name: r.name, status: r.status, started: r.started,
           ended: r.ended})""", w.projects)

    # ---------------------------------------------------------------- sources
    run("""UNWIND $rows AS r CREATE (:Source:Doc {uid: r.uid, kind: r.kind, title: r.title, at: r.at, text: r.text,
           day: r.day}) WITH r MATCH (s:Doc {uid: r.uid}), (p:Person {uid: r.author}) CREATE (s)-[:WRITTEN_BY]->(p)""",
        [d | {"day": day_index(d["at"])} for d in w.docs])
    run("""UNWIND $rows AS r CREATE (:Source:Message {uid: r.uid, kind: 'message', channel: r.channel, at: r.at,
           text: r.text, title: r.channel, day: r.day})
           WITH r MATCH (m:Message {uid: r.uid}), (p:Person {uid: r.author}) CREATE (m)-[:POSTED_BY]->(p)""",
        [m | {"day": day_index(m["at"])} for m in w.messages])
    run("""UNWIND $rows AS r CREATE (:Source:Change {uid: r.uid, kind: 'change', key: r.key, title: r.title,
           at: r.at, day: r.day, text: r.title})""", [c | {"day": day_index(c["at"])} for c in w.changes])
    run("""UNWIND $rows AS r MATCH (c:Change {uid: r.uid}), (p:Person {uid: r.author})
           CREATE (p)-[:AUTHORED {at: r.at}]->(c)""", w.changes)
    run("""UNWIND $rows AS r MATCH (c:Change {uid: r.c}), (p:Person {uid: r.p}) CREATE (p)-[:REVIEWED {at: r.at}]->(c)""",
        [{"c": c["uid"], "p": p, "at": c["at"]} for c in w.changes for p in c["reviewers"]])
    run("""UNWIND $rows AS r MATCH (c:Change {uid: r.c}), (s:Service {uid: r.s}) CREATE (c)-[:MODIFIES]->(s)""",
        [{"c": c["uid"], "s": s} for c in w.changes for s in c["services"]])
    run("""UNWIND $rows AS r CREATE (:Source:Ticket {uid: r.uid, kind: r.kind, key: r.key, title: r.title,
           text: r.title, priority: r.priority, status: r.status, at: r.opened, opened: r.opened, closed: r.closed,
           day: r.day})""", [t | {"day": day_index(t["opened"])} for t in w.tickets])
    run("UNWIND $rows AS r MATCH (t:Ticket {uid: r.t}), (s:Service {uid: r.s}) CREATE (t)-[:ABOUT]->(s)",
        [{"t": t["uid"], "s": s} for t in w.tickets for s in t["services"]])
    run("UNWIND $rows AS r MATCH (t:Ticket {uid: r.t}), (c:Customer {uid: r.c}) CREATE (t)-[:RAISED_BY]->(c)",
        [{"t": t["uid"], "c": c} for t in w.tickets for c in t["customers"]])
    run("UNWIND $rows AS r MATCH (t:Ticket {uid: r.t}), (p:Person {uid: r.p}) CREATE (t)-[:ASSIGNED_TO]->(p)",
        [{"t": t["uid"], "p": t["assignee"]} for t in w.tickets if t["assignee"]])
    run("UNWIND $rows AS r MATCH (a:Ticket {uid: r.a}), (b:Ticket {uid: r.b}) CREATE (a)-[:BLOCKS]->(b)",
        [{"a": t["uid"], "b": b} for t in w.tickets for b in t["blocks"]])

    # ---------------------------------------------------------------- facts with validity
    run("""UNWIND $rows AS r MATCH (p:Person {uid: r.a}), (t:Team {uid: r.b})
           CREATE (p)-[:MEMBER_OF {uid: r.uid, valid_from: r.valid_from, valid_to: r.valid_to,
                  recorded_at: r.recorded_at, src: r.source}]->(t)""", w.members)
    run("""UNWIND $rows AS r MATCH (t:Team {uid: r.a}), (s:Service {uid: r.b})
           CREATE (t)-[:OWNS {uid: r.uid, valid_from: r.valid_from, valid_to: r.valid_to, recorded_at: r.recorded_at,
                  src: r.source, declared: r.declared}]->(s)""", w.owns)
    # declared: on the official list (the service catalog, a migration plan) or only found in conversation
    texts = {m["uid"]: m["text"] for m in w.messages}
    run("""UNWIND $rows AS r MATCH (a:Service {uid: r.a}), (b:Service {uid: r.b})
           CREATE (a)-[:DEPENDS_ON {uid: r.uid, kind: r.kind, valid_from: r.valid_from, valid_to: r.valid_to,
                  recorded_at: r.recorded_at, src: r.source, declared: r.declared, quote: r.quote}]->(b)""",
        [d | {"declared": d["source"].startswith("doc:"), "quote": texts.get(d["source"])} for d in w.deps])
    run("""UNWIND $rows AS r MATCH (c:Customer {uid: r.customer}), (s:Service {uid: r.service})
           CREATE (c)-[:USES {uid: r.uid, valid_from: r.valid_from, valid_to: r.valid_to, recorded_at: r.valid_from,
                  src: 'doc:contracts'}]->(s)""", w.uses)
    run("""UNWIND $rows AS r MATCH (p:Person {uid: r.a}), (j:Project {uid: r.b})
           CREATE (p)-[:WORKED_ON {uid: r.uid, valid_from: r.valid_from, valid_to: r.valid_to,
                  recorded_at: r.recorded_at, src: r.source}]->(j)""", w.worked_on)
    run("UNWIND $rows AS r MATCH (j:Project {uid: r.project}), (s:Service {uid: r.service}) CREATE (j)-[:TOUCHES]->(s)",
        w.project_uses)

    # ---------------------------------------------------------------- decisions
    run("""UNWIND $rows AS r CREATE (:Decision {uid: r.uid, key: r.key, title: r.title, status: r.status, at: r.at,
           decided_at: r.at, summary: r.summary, day: r.day})""", [d | {"day": day_index(d["at"])} for d in w.decisions])
    run("UNWIND $rows AS r MATCH (d:Decision {uid: r.d}), (p:Person {uid: r.p}) CREATE (d)-[:DECIDED_BY]->(p)",
        [{"d": d["uid"], "p": p} for d in w.decisions for p in d["decided_by"]])
    run("UNWIND $rows AS r MATCH (d:Decision {uid: r.d}), (t:Team {uid: r.t}) CREATE (d)-[:MADE_BY]->(t)",
        [{"d": d["uid"], "t": d["team"]} for d in w.decisions])
    run("UNWIND $rows AS r MATCH (d:Decision {uid: r.d}), (s:Service {uid: r.s}) CREATE (d)-[:AFFECTS]->(s)",
        [{"d": d["uid"], "s": s} for d in w.decisions for s in d["affects"]])
    run("UNWIND $rows AS r MATCH (d:Decision {uid: r.d}), (s:Source {uid: r.s}) CREATE (d)-[:EVIDENCED_BY]->(s)",
        [{"d": d["uid"], "s": s} for d in w.decisions for s in d["evidence"]])
    run("""UNWIND $rows AS r MATCH (a:Decision {uid: r.a}), (b:Decision {uid: r.b})
           CREATE (a)-[:SUPERSEDES {how: r.how, at: r.at}]->(b)""",
        [{"a": d["uid"], "b": d["supersedes"][0], "how": d["supersedes"][1], "at": d["at"]}
         for d in w.decisions if d["supersedes"]])
    run("""UNWIND $rows AS r CREATE (c:Contradiction {uid: r.uid, topic: r.topic, at: r.at, status: 'open'})
           WITH c, r MATCH (a:Source {uid: r.a}), (b:Source {uid: r.b}) CREATE (c)-[:BETWEEN]->(a), (c)-[:BETWEEN]->(b)""",
        w.contradictions)
    run("UNWIND $rows AS r MATCH (c:Contradiction {uid: r.c}), (s:Service {uid: r.s}) CREATE (c)-[:ABOUT]->(s)",
        [{"c": c["uid"], "s": s} for c in w.contradictions for s in c["about"]])
    # the change messages point at the pull request they talk about
    run("UNWIND $rows AS r MATCH (m:Message {uid: r.m}), (c:Change {uid: r.c}) CREATE (m)-[:REFERS_TO]->(c)",
        [{"m": m["uid"], "c": c} for m in w.messages for c in m.get("refs", [])])

    # ---------------------------------------------------------------- aliases and mentions
    pairs = alias_pairs(w)
    run("""UNWIND $rows AS r MATCH (n {uid: r.uid}) MERGE (a:Alias {text: r.text}) CREATE (a)-[:NAMES]->(n)""",
        [{"text": t, "uid": u} for t, u, _ in pairs])
    res = Resolver(pairs)
    mentions = []
    for src in w.messages + w.docs:
        for uid in res.mentions(src["text"] + " " + src.get("title", "")):
            mentions.append({"s": src["uid"], "e": uid})
    run("UNWIND $rows AS r MATCH (s:Source {uid: r.s}), (e {uid: r.e}) CREATE (s)-[:MENTIONS]->(e)", mentions)

    db.set(f"orion:{w.tenant}:clock", w.clock)
    dbm.bump(db, w.tenant)
    return db.one(g, "MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS edges") or {}


def alias_pairs(w: World) -> list[tuple[str, str, str]]:
    pairs = []
    for kind, rows in (("Service", w.services), ("Person", w.people), ("Team", w.teams), ("Customer", w.customers),
                       ("Decision", w.decisions), ("Ticket", [t for t in w.tickets if not t["key"].startswith("SUP-9")]),
                       ("Project", w.projects)):
        for n in rows:
            for a in aliases_for(kind, n):
                pairs.append((a, n["uid"], kind))
    from orion.world.corvane import NICKNAMES, sid

    for svc, names in NICKNAMES.items():
        for a in names:
            pairs.append((a, sid(svc), "Service"))
    # first names shared by two people would be ambiguous: drop them from the person aliases
    by_text: dict[str, set[str]] = {}
    for t, u, _ in pairs:
        by_text.setdefault(t, set()).add(u)
    return [(t, u, k) for t, u, k in pairs if len(by_text[t]) == 1 or k != "Person"]



def reset(db: dbm.DB, tenant: str = "corvane") -> dict:
    """Drop everything a tenant has (epochs, universes, the deck, memories, counters) and load it fresh."""
    from orion import epoch as ep
    from orion.world import corvane

    for prefix in (f"epoch:{tenant}:", f"universe:{tenant}:", f"deck:{tenant}", f"mem:{tenant}:"):
        for g in db.graphs(prefix):
            db.delete(g)
    db.drop(f"orion:{tenant}:")
    db.drop(f"orion:epoch:epoch:{tenant}:")
    db.drop(f"orion:snap:epoch:{tenant}:")
    stats = load(db, corvane.build())
    built = ep.build(db, tenant, dbm.clock(db, tenant), "true", dbm.epoch(tenant))
    db.set(f"orion:epoch:{dbm.epoch(tenant)}", f"{dbm.version(db, tenant)}|{dbm.clock(db, tenant)}|true")
    from orion import showcase

    # a visitor's first screen: the recorded sso-legacy answer, filed as Priya's last conversation
    shown = showcase.seed(db, tenant) if tenant == "corvane" else None
    return stats | {"epoch_ms": built["total_ms"], "showcase": shown}
