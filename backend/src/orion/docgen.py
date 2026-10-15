"""Write docs/queries.md: every Cypher query Orion runs, recorded while it runs, not copied by hand.

A scripted tour loads a scratch tenant, builds epochs, forks universes, diffs them, merges one, applies a live change
and calls every graph tool. Each query is recorded with the function that ran it, so the document can't drift from
the code.

    uv run python -m orion.docgen
"""

from __future__ import annotations

import inspect
import re
from collections import OrderedDict
from pathlib import Path

from orion import db as dbm

OUT = Path(__file__).resolve().parents[3] / "docs" / "queries.md"
SECTIONS = OrderedDict([
    ("orion.load", "Loading the company"),
    ("orion.epoch", "Epochs: the company on any date"),
    ("orion.impact", "Dependency traversal at any depth"),
    ("orion.algos", "Graph algorithms"),
    ("orion.ops", "Changes: physical (universe) and temporal (merge) interpreters"),
    ("orion.universe", "Universes: fork, diff, approve, merge"),
    ("orion.tools", "Graph tools used by the agents, the API and MCP"),
    ("orion.claims", "Checking typed claims"),
    ("orion.watch", "Answers and re-checking them"),
    ("orion.memory", "Per-person memory graphs"),
    ("orion.deck", "The agents' shared board"),
    ("orion.agents.sentinel", "The Sentinel"),
    ("orion.live", "Live messages"),
    ("orion.viz", "What the web app draws"),
])

_seen: "OrderedDict[tuple[str, str], dict]" = OrderedDict()


def _record(kind: str, cypher: str) -> None:
    for frame in inspect.stack()[2:12]:
        mod = frame.frame.f_globals.get("__name__", "")
        if mod.startswith("orion.") and mod not in ("orion.db", "orion.docgen"):
            fn = frame.function
            doc = (frame.frame.f_globals.get(fn).__doc__ if callable(frame.frame.f_globals.get(fn)) else None) or ""
            text = re.sub(r"[ \t]+\n", "\n", inspect.cleandoc("\n" + cypher)).strip()
            key = (mod, text)
            if key not in _seen:
                _seen[key] = {"mod": mod, "fn": fn, "kind": kind, "cypher": text, "doc": doc.strip().split("\n\n")[0]}
            return


def tour() -> None:
    from orion import algos, claims, deck, epoch, load, memory, tools, universe as uv, viz, watch
    from orion import ops as opsm
    from orion.agents import sentinel
    from orion.world import corvane

    db = dbm.get_db()
    orig_q, orig_ro = dbm.DB.q, dbm.DB.ro

    def q(self, name, cypher, params=None, timeout=None):
        _record("write", cypher)
        return orig_q(self, name, cypher, params, timeout)

    def ro(self, name, cypher, params=None, timeout=10000):
        _record("read", cypher)
        return orig_ro(self, name, cypher, params, timeout)

    dbm.DB.q, dbm.DB.ro = q, ro
    t = "docgen"
    try:
        w = corvane.build()
        w.tenant = t
        load.load(db, w)
        now = epoch.now(db, t)
        epoch.ensure(db, t, "2026-03-02", "known")
        ctx = tools.Ctx(db, t, "person:priya-raman")
        for name, args in [("find_entities", {"text": "who knows the ledger"}), ("impact", {"service": "sso-legacy"}),
                           ("impact", {"service": "sso-legacy", "on": "2026-03-02", "known": True}),
                           ("who_knows", {"service": "ledger"}), ("bus_factor", {}), ("decision_history", {"about": "sso-legacy"}),
                           ("blame", {"subject": "invoice-render", "object": "sso-legacy"}), ("customer_story", {"customer": "Helio"}),
                           ("org_vs_reality", {}), ("hidden_teams", {}), ("contradictions", {}),
                           ("connection", {"a": "Ines", "b": "Helio Robotics"}), ("checkout", {"on": "2026-03-02"}),
                           ("findings", {"about": "sso-legacy"})]:
            tools.run(ctx, name, args)
        viz.galaxy(db, now)
        viz.timeline(db, t)
        algos.communities(db, now)
        rec = uv.fork(db, t, [opsm.parse("retire_service:service=sso-legacy")], by="person:priya-raman")
        uv.fork(db, t, [opsm.parse("remove_person:person=Ines Okafor"), opsm.parse("merge_teams:team=Signals,into=Platform"),
                        opsm.parse("move_ownership:service=tax-engine,team=Data"),
                        opsm.parse("add_dependency:service=docs-site,on=identity")], by="person:priya-raman")
        c = {"sentence": "Retiring sso-legacy breaks invoice-render.", "type": "breaks", "subject": "", "objects": ["invoice-render"],
             "exhaustive": False, "value": None, "metric": None, "scenario": rec["uid"], "evidence": []}
        k = {"sentence": "Ines knows the ledger.", "type": "knows", "subject": "ledger", "objects": ["Ines Okafor"],
             "exhaustive": False, "value": None, "metric": None, "scenario": None, "evidence": []}
        checked = [{"claim": x, "result": claims.check(ctx, x), "about": []} for x in (c, k)]
        for x in checked:
            x["about"] = claims.about(ctx, x["claim"], x["result"])
        watch.store(db, t, user="person:priya-raman", question="q", text="a", checked=checked, evidence=[], session="s", meta={})
        memory.remember(db, t, "person:priya-raman", "s", "remember that I own sso-legacy", "ok", "ans:x", ["svc:sso-legacy"])
        memory.learn_procedure(db, t, "person:priya-raman", "what breaks if", ["what_if"], True)
        memory.recall(db, t, "person:priya-raman", "what breaks if we retire sso-legacy", "s2")
        task = deck.post(db, t, "extract", {"text": "x"})
        deck.claim(db, t, "Cartographer", uid=task)
        deck.done(db, t, task, {})
        mig = uv.fork(db, t, [opsm.parse("retire_service:service=sso-legacy,replacement=identity")], by="person:priya-raman")
        uv.approve(db, t, mig["uid"], "person:priya-raman")
        db.q(dbm.org(t), """MATCH (p:Person {uid: 'person:tomasz-nowak'}) CREATE (:Source:Message {uid: 'msg:doc', at: '2026-10-01T10:00',
                            text: 'x', kind: 'message'})-[:POSTED_BY]->(p)""")
        sentinel.handle(db, t, "msg:doc", "person:tomasz-nowak", {"op": "add_dependency", "service": "svc:invoice-render",
                                                                   "on": "svc:tax-engine", "kind": "sync"})
        sentinel.handle(db, t, "msg:doc", "person:sam-okoro", {"op": "add_dependency", "service": "svc:ledger",
                                                                "on": "svc:warehouse", "kind": "data"})
    finally:
        dbm.DB.q, dbm.DB.ro = orig_q, orig_ro
        for prefix in (f"org:{t}", f"epoch:{t}:", f"universe:{t}:", f"deck:{t}", f"mem:{t}:"):
            for g in db.graphs(prefix):
                db.delete(g)
        for key in db.redis.keys(f"orion:{t}:*") + db.redis.keys(f"orion:epoch:epoch:{t}:*"):
            db.redis.delete(key)


def write() -> int:
    tour()
    lines = ["# Cypher queries", "",
             "Every query Orion runs, recorded by `uv run python -m orion.docgen` while a scripted tour exercises the",
             "whole product (load, epochs, every graph tool, forks, diffs, a merge, live changes, memory, the deck). Grouped",
             "by the module and function that runs it. `$name` is a query parameter.", ""]
    by_mod: dict[str, list[dict]] = {}
    for q in _seen.values():
        by_mod.setdefault(q["mod"], []).append(q)
    lines.append("| Section | Queries |")
    lines.append("|---|---|")
    for mod, title in SECTIONS.items():
        if mod in by_mod:
            lines.append(f"| [{title}](#{_anchor(title)}) | {len(by_mod[mod])} |")
    lines.append("")
    for mod, title in SECTIONS.items():
        qs = by_mod.get(mod)
        if not qs:
            continue
        lines += [f"## {title}", "", f"`{mod}`", ""]
        fn = None
        for q in qs:
            if q["fn"] != fn:
                fn = q["fn"]
                lines.append(f"### `{fn}`" + (f": {q['doc'].splitlines()[0]}" if q["doc"] else ""))
                lines.append("")
            lines += ["```cypher", q["cypher"], "```", ""]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines))
    return len(_seen)


def _anchor(title: str) -> str:
    return re.sub(r"[^a-z0-9 -]", "", title.lower()).replace(" ", "-")


if __name__ == "__main__":
    n = write()
    print(f"wrote {OUT} ({n} queries)")
