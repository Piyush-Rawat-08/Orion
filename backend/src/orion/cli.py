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
    out.print_json(json.dumps(db.ro(graph, query), default=str))


if __name__ == "__main__":
    app()
