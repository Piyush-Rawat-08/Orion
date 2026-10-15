"""orion: command line for loading and poking at the company graph without the web app or a model."""

from __future__ import annotations

import json

import typer
from rich.console import Console

from orion import db as dbm
from orion import epoch as ep

app = typer.Typer(no_args_is_help=True, add_completion=False, pretty_exceptions_enable=False)
out = Console()


@app.command()
def reset(tenant: str = "corvane"):
    """Load Corvane from its generator, drop every epoch, universe and the board, and build epoch:now."""
    from orion import load
    from orion.world import corvane

    db = dbm.get_db()
    for prefix in (f"epoch:{tenant}:", f"universe:{tenant}:", f"deck:{tenant}", f"mem:{tenant}:"):
        for g in db.graphs(prefix):
            db.delete(g)
    stats = load.load(db, corvane.build())
    built = ep.build(db, tenant, dbm.clock(db, tenant), "true", dbm.epoch(tenant))
    db.set(f"orion:epoch:{dbm.epoch(tenant)}", f"{dbm.version(db, tenant)}|{dbm.clock(db, tenant)}|true")
    out.print(f"[bold]org:{tenant}[/] {stats['nodes']} nodes, {stats['edges']} relationships; epoch:now in {built['ms']} ms")


@app.command()
def epoch(on: str, mode: str = "true", tenant: str = "corvane"):
    """Build the company as it stood on a date (mode true or known)."""
    db = dbm.get_db()
    out.print(ep.build(db, tenant, on, mode))


@app.command()
def cypher(query: str, graph: str = "epoch:corvane:now"):
    """Run a read-only query."""
    db = dbm.get_db()
    if graph.endswith(":now"):
        graph = ep.ensure(db, graph.split(":")[1])
    out.print_json(json.dumps(db.ro(graph, query), default=str))


if __name__ == "__main__":
    app()


@app.command()
def fork(changes: list[str], by: str = "person:priya-raman", on: str = "", mode: str = "true",
         tenant: str = "corvane"):
    """Fork the company and apply changes, e.g. retire_service:service=sso-legacy"""
    from orion import ops as opsm
    from orion import universe as uv

    db = dbm.get_db()
    rec = uv.fork(db, tenant, [opsm.parse(c) for c in changes], by=by, on=on or None, mode=mode)
    d = rec["diff"]
    out.print(f"[bold]{rec['uid']}[/] {rec['title']}  ({rec['ms']['total']} ms, diff {d['ms']} ms)")
    out.print(d["summary"])
    for b in d["breaks"]:
        out.print(f"  {b['effect']:8} {b['name']:16} tier {b['tier']}  via {' -> '.join(b['path_names'])}")
    for c in d["customers"]:
        out.print(f"  customer {c['name']} ({c['tier']}, {c['effect']}) via {', '.join(c['via'])} {' '.join(c['tickets'])}")
    for o in d["orphans"]:
        out.print(f"  orphan   {o['name']} (knew: {', '.join(o['knew'])})")
    out.print("  approvals: " + ", ".join(f"{a['team_name']} ({'; '.join(a['why'])})" for a in d["approvals"]))
    for term in d["risk"]["terms"]:
        out.print(f"    +{term['points']:5}  {term['label']}")


@app.command()
def approve(universe: str, by: str, force: bool = False, tenant: str = "corvane"):
    """Approve a universe as a person (their team's approval); merges when every team has approved."""
    from orion import universe as uv

    db = dbm.get_db()
    res = uv.approve(db, tenant, universe, by, force=force)
    out.print(res.get("result"), res.get("message", ""), [a["team_name"] for a in res.get("waiting_for", [])])
