"""orion: the company graph from a terminal, without the web app (and, except for `ask`, without a model)."""

from __future__ import annotations

import json

import typer
from rich.console import Console

from orion import db as dbm
from orion import epoch as ep

app = typer.Typer(no_args_is_help=True, add_completion=False, pretty_exceptions_enable=False)
out = Console()


def _op(text: str) -> dict:
    """'deprecate_service service=sso-legacy' or 'move_person person=Ines Okafor team=Platform' -> an op."""
    name, *rest = text.split(" ", 1)
    op = {"op": name}
    for part in (rest[0].split(" ") if rest else []):
        if "=" in part:
            k, v = part.split("=", 1)
            op[k] = v
        elif len(op) > 1:  # a value with spaces: glue it back onto the last key
            k = list(op)[-1]
            op[k] += " " + part
    return op


@app.command()
def reset(tenant: str = "corvane"):
    """Load Corvane from its generator, dropping every epoch, universe, memory and the deck."""
    from orion import load

    s = load.reset(dbm.get_db(), tenant)
    out.print(f"[bold]org:{tenant}[/] {s['nodes']} nodes, {s['edges']} relationships; today's snapshot in {s['epoch_ms']} ms")


@app.command()
def epoch(on: str, mode: str = "true", tenant: str = "corvane"):
    """Build the company as it stood on a date (mode true: what was so; known: what had been written down)."""
    out.print(ep.checkout(dbm.get_db(), tenant, on, mode))


@app.command()
def cypher(query: str, graph: str = "epoch:corvane:now"):
    """Run a read-only query."""
    db = dbm.get_db()
    if graph.endswith(":now"):
        graph = ep.now(db, graph.split(":")[1])
    out.print_json(json.dumps(db.ro(graph, query), default=str))


@app.command()
def fork(changes: list[str], title: str = "", kind: str = "whatif", by: str = "person:priya-raman", tenant: str = "corvane"):
    """Fork the company and apply changes, e.g. orion fork "deprecate_service service=sso-legacy" """
    from orion import universe as uv

    res = uv.fork(dbm.get_db(), tenant, [_op(c) for c in changes], kind=kind, title=title or None, created_by=by)
    d = res["diff"]
    out.print(f"[bold]{res['uid']}[/] {res['title']}  (copied in {res['copy_ms']} ms, diff {d['diff_ms']} ms)")
    for b in d["broken"]:
        out.print(f"  {b['effect']:8} {b['service']:18} tier {b['tier']}  via {b['because_of']} ({b['hops']} step(s))")
    for c in d["customers"]:
        out.print(f"  customer {c['customer']} ({c['tier']}): {', '.join(c['services'][:3])}")
    for o in d["new_orphans"]:
        out.print(f"  nobody would know {o['service']}")
    out.print("  must approve: " + ", ".join(r["team"] for r in d["required_approvers"]))
    out.print(f"  risk [bold]{d['risk']['level']} {d['risk']['score']}[/]")
    for r in d["risk"]["reasons"]:
        out.print(f"    {r}")


@app.command()
def approve(universe: str, by: str, force: bool = False, tenant: str = "corvane"):
    """Approve a universe as a person; it merges when every team it names has approved."""
    from orion import universe as uv

    res = uv.approve(dbm.get_db(), tenant, universe, by, force=force)
    out.print(res["status"], [m["team"] for m in res.get("missing", [])])


@app.command()
def departures(tenant: str = "corvane"):
    """Everyone ranked by what their leaving would cost."""
    from orion.departures import departures as rank

    for p in rank(dbm.get_db(), tenant)["people"]:
        out.print(f"{p['risk']:4} {p['level']:6} {p['name']:20} {p['team'] or '-':10} "
                  f"nobody would know: {', '.join(p['nobody_would_know']) or '-'}")


@app.command()
def ask(question: str, user: str = "person:priya-raman", tenant: str = "corvane"):
    """Ask the Navigator (needs a model key). Each claim is printed with its mark."""
    from orion.agents.navigator import answer

    def show(e: dict):
        if e["type"] == "tool_call":
            out.print(f"[dim]  {e['tool']} {json.dumps(e['args'])}[/]")

    r = answer(dbm.get_db(), tenant, question, user=user, on_event=show)
    out.print(f"\n[bold]{r.get('summary')}[/]")
    for c in r.get("claims", []):
        out.print(f"  [{c['verdict']}] {c['text']}  [dim]{c['reason']}[/]")


@app.command()
def message(text: str, author: str = "person:tomasz-nowak", channel: str = "#billing", tenant: str = "corvane"):
    """Post a chat message as someone: the Cartographer reads it and the Sentinel applies what it states."""
    from orion.agents.cartographer import ingest_message

    def show(e: dict):
        if e["type"] in ("fact_opened", "fact_closed", "review_queued", "contradiction", "answer_expired"):
            out.print(f"  {e['type']}: " + str(e.get("fact") or e.get("summary") or e.get("question") or e.get("uid", "")))

    db = dbm.get_db()
    name = db.one(dbm.org(tenant), "MATCH (p:Person {uid: $u}) RETURN p.name AS n", {"u": author})["n"]
    r = ingest_message(db, tenant, channel, name, text, show, posted_by=author)
    out.print(f"closed {len(r['closed'])}, opened {len(r['opened'])}, {len(r['notifications'])} answer(s) told")


@app.command()
def repo(name: str, max_prs: int = 200):
    """Load a public GitHub repository (owner/repo) as a company of its own."""
    from orion import repo as rm

    owner, _, rname = name.partition("/")
    r = rm.ingest(dbm.get_db(), owner, rname, max_prs=max_prs)
    out.print(r["summary"], r["timings_ms"])


if __name__ == "__main__":
    app()
