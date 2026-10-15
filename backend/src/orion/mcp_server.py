"""Orion over MCP, for Claude Desktop, Cursor or any MCP client.

Every graph tool the Navigator uses is exposed read-only. Two tools act: `what_if` forks a universe (nothing in the
company changes) and `propose` forks a plan that the teams the diff names must approve. `approve` approves as the
person the server was started for (ORION_USER) and never approves a plan proposed through MCP itself: an agent
can propose, but can't wave through its own change.

    uv run python -m orion.mcp_server                # stdio
    uv run python -m orion.mcp_server --http 8765    # streamable HTTP on 127.0.0.1, needs ORION_MCP_TOKEN
"""

from __future__ import annotations

import argparse
import json

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

from orion import db as dbm
from orion import tools
from orion import universe as uv
from orion.config import env

TENANT = env("ORION_TENANT", "corvane")
USER = env("ORION_USER")  # the person this server acts for, e.g. person:priya-raman
AGENT = "agent:mcp"

mcp = MCPServer("orion", instructions=(
    f"Orion is the company graph of {TENANT}: people, teams, services, dependencies, decisions, customers and the "
    "messages and documents they came from, in FalkorDB. Use the read tools to answer questions and cite what they "
    "return; use what_if to see what a change would break before suggesting it."))

READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
FORK = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)


def _ctx() -> tools.ToolContext:
    return tools.ToolContext(dbm.get_db(), TENANT, user=USER)


def _run(name: str, **args) -> str:
    ctx = _ctx()
    res = tools.call_tool(ctx, name, {k: v for k, v in args.items() if v is not None})
    return json.dumps({"result": res, "evidence": [{k: e[k] for k in ("eid", "graph", "cypher", "params", "summary")}
                                                   for e in ctx.evidence]}, default=str)


@mcp.tool(annotations=READ)
def find_entities(text: str) -> str:
    """Find people, services, teams, customers, decisions and the messages about them. Start here when names are unclear."""
    return _run("find_entities", text=text)


@mcp.tool(annotations=READ)
def impact(service: str, direction: str = "upstream", asof: str | None = None) -> str:
    """What relies on a service at any depth (upstream: what breaks if it goes), optionally as of a date."""
    return _run("impact", service=service, direction=direction, asof=asof)


@mcp.tool(annotations=READ)
def who_knows(service: str, asof: str | None = None) -> str:
    """Who actually knows a service (changes and reviews in 180 days), against its declared and de-facto owners."""
    return _run("who_knows", service=service, asof=asof)


@mcp.tool(annotations=READ)
def ownership(service: str) -> str:
    """The declared owner with its source, and the de-facto owner from who makes the changes."""
    return _run("ownership", service=service)


@mcp.tool(annotations=READ)
def bus_factor(service: str) -> str:
    """How many people can leave before nobody knows a service or anything it relies on."""
    return _run("bus_factor", service=service)


@mcp.tool(annotations=READ)
def decision_history(entity: str) -> str:
    """Decisions about something, what superseded or reversed what, and the records behind them."""
    return _run("decision_history", entity=entity)


@mcp.tool(annotations=READ)
def blame(fact_uid: str) -> str:
    """Where a fact came from: who wrote it down, when, and the exact words."""
    return _run("blame", fact_uid=fact_uid)


@mcp.tool(annotations=READ)
def customer_timeline(customer: str) -> str:
    """Everything a customer raised, its status, and what blocks it."""
    return _run("customer_timeline", customer=customer)


@mcp.tool(annotations=READ)
def trace_path(a: str, b: str) -> str:
    """How two things in the company are connected."""
    return _run("trace_path", a=a, b=b)


@mcp.tool(annotations=READ)
def communities() -> str:
    """The groups people actually work in, compared with the official teams."""
    return _run("communities")


@mcp.tool(annotations=READ)
def bottlenecks() -> str:
    """The people most work flows through."""
    return _run("bottlenecks")


@mcp.tool(annotations=READ)
def contradictions() -> str:
    """Records that disagree with each other."""
    return _run("contradictions")


@mcp.tool(annotations=READ)
def checkout(date: str) -> str:
    """The company as it was on a date: dependencies and decisions in force."""
    return _run("checkout", date=date)


@mcp.tool(annotations=READ)
def cypher_readonly(query: str) -> str:
    """Any read-only Cypher on the company now."""
    return _run("cypher_readonly", query=query)


def _fork(ops: list[dict], title: str | None, kind: str) -> dict:
    return uv.fork(dbm.get_db(), TENANT, ops, kind=kind, title=title, created_by=AGENT)


@mcp.tool(annotations=FORK)
def what_if(ops: list[dict], title: str | None = None) -> str:
    """Copy the company into a parallel universe, apply typed changes (e.g. {"op": "deprecate_service", "service":
    "sso-legacy"}) and compare: what breaks, which customers would notice, who must approve, the risk."""
    try:
        r = _fork(ops, title, "whatif")
    except Exception as e:
        return json.dumps({"error": str(e)})
    d = r["diff"]
    return json.dumps({"universe": r["uid"], "title": r["title"], "risk": d["risk"], "broken": d["broken"],
                       "customers": d["customers"], "new_orphans": d["new_orphans"],
                       "required_approvers": d["required_approvers"]}, default=str)


@mcp.tool(annotations=FORK)
def propose(ops: list[dict], title: str) -> str:
    """Propose a change. It is rehearsed in a universe; it happens only when the teams it names approve it in Orion."""
    try:
        r = _fork(ops, title, "dryrun")
    except Exception as e:
        return json.dumps({"error": str(e)})
    return json.dumps({"universe": r["uid"], "title": r["title"], "risk": r["diff"]["risk"],
                       "must_approve": [x["team"] for x in r["diff"]["required_approvers"]]}, default=str)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False))
def approve(universe: str) -> str:
    """Approve a proposal as the person this server acts for (ORION_USER). A proposal made through MCP can't be
    approved through MCP. When every required team has approved, it merges into the company."""
    if not USER:
        return json.dumps({"error": "start the server with ORION_USER set to the person it acts for"})
    db = dbm.get_db()
    try:
        rec = uv.get_universe(db, TENANT, universe)
    except KeyError:
        return json.dumps({"error": f"no universe {universe}"})
    if rec.get("created_by") == AGENT:
        return json.dumps({"error": "a proposal made through MCP needs a person to approve it in Orion"})
    try:
        out = uv.approve(db, TENANT, universe, USER)
    except Exception as e:
        return json.dumps({"error": str(e)})
    return json.dumps({"status": out["status"], "missing": [m["team"] for m in out.get("missing", [])]}, default=str)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--http", type=int, help="serve streamable HTTP on 127.0.0.1:PORT (requires ORION_MCP_TOKEN)")
    a = ap.parse_args()
    if a.http:
        if not env("ORION_MCP_TOKEN"):
            raise SystemExit("set ORION_MCP_TOKEN: the HTTP transport needs a bearer token")
        import uvicorn
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.responses import JSONResponse

        app = mcp.streamable_http_app()

        class Bearer(BaseHTTPMiddleware):
            async def dispatch(self, request, call_next):
                if request.headers.get("authorization") != f"Bearer {env('ORION_MCP_TOKEN')}":
                    return JSONResponse({"error": "unauthorized"}, status_code=401)
                return await call_next(request)

        app.add_middleware(Bearer)
        uvicorn.run(app, host="127.0.0.1", port=a.http)
    else:
        mcp.run()


if __name__ == "__main__":
    main()
