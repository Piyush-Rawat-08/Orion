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


def _ctx() -> tools.Ctx:
    return tools.Ctx(dbm.get_db(), TENANT, USER)


def _out(r: dict) -> str:
    return json.dumps({"summary": r["summary"], "rows": r["rows"], "cypher": [q["cypher"] for q in r["queries"]]},
                      default=str)


@mcp.tool(annotations=READ)
def find_entities(text: str) -> str:
    """Resolve the names in a question to people, services, teams, customers and decisions, and search messages,
    documents and tickets for its words."""
    return _out(tools.find_entities(_ctx(), text))


@mcp.tool(annotations=READ)
def impact(service: str, on: str | None = None, known: bool = False) -> str:
    """Everything that depends on a service, at any depth: break / degrade / stale, and the path that proves it.
    `on` is an ISO date for the past; `known` limits it to what had been written down by then."""
    return _out(tools.impact_of(_ctx(), service, on, known))


@mcp.tool(annotations=READ)
def who_knows(service: str) -> str:
    """Who knows a service now (3+ changes or reviews in 180 days), who owns it, and who knew it but left."""
    return _out(tools.who_knows(_ctx(), service))


@mcp.tool(annotations=READ)
def bus_factor() -> str:
    """Services one person or nobody knows, most critical first."""
    return _out(tools.bus_factor(_ctx()))


@mcp.tool(annotations=READ)
def decision_history(about: str) -> str:
    """Decisions about a service or one decision: what superseded or reversed what, and the sources behind each."""
    return _out(tools.decision_history(_ctx(), about))


@mcp.tool(annotations=READ)
def blame(subject: str, object: str | None = None) -> str:
    """Where a fact came from: validity, when it was recorded, the message or document, and who wrote it."""
    return _out(tools.blame(_ctx(), subject, object))


@mcp.tool(annotations=READ)
def customer_story(customer: str) -> str:
    """A customer's tickets, what blocks the open ones at any depth, and the services they use."""
    return _out(tools.customer_story(_ctx(), customer))


@mcp.tool(annotations=READ)
def org_vs_reality() -> str:
    """Services whose declared owner isn't the team that actually changes them."""
    return _out(tools.org_vs_reality(_ctx()))


@mcp.tool(annotations=READ)
def hidden_teams() -> str:
    """Groups who work together across team lines, and the project they share."""
    return _out(tools.hidden_teams(_ctx()))


@mcp.tool(annotations=READ)
def connection(a: str, b: str) -> str:
    """The shortest ways two things in the company are connected."""
    return _out(tools.connection(_ctx(), a, b))


@mcp.tool(annotations=READ)
def checkout(on: str, known: bool = False) -> str:
    """The company as it stood on a date, or as it was known that day."""
    return _out(tools.checkout(_ctx(), on, known))


@mcp.tool(annotations=READ)
def cypher_readonly(query: str, graph: str = "now") -> str:
    """Read-only Cypher on the company now ('now') or its full bi-temporal history ('org'). Writes are refused."""
    return _out(tools.cypher_readonly(_ctx(), query, graph))


@mcp.tool(annotations=FORK)
def what_if(changes: list[dict]) -> str:
    """Fork the company into a universe and apply changes; nothing real changes. Each change is one of
    {op: retire_service, service, replacement?}, {op: outage, service}, {op: remove_person, person},
    {op: merge_teams, team, into}, {op: move_ownership, service, team}, {op: add_dependency, service, on, kind?},
    {op: remove_dependency, service, on}. Returns what breaks, customers exposed, approvals and risk."""
    return _out(tools.what_if(_ctx(), changes))


@mcp.tool(annotations=FORK)
def propose(changes: list[dict], title: str | None = None) -> str:
    """Like what_if, but as a plan: the teams the diff names must approve it before it becomes part of the company."""
    rec = uv.fork(dbm.get_db(), TENANT, changes, by=AGENT, kind="plan", title=title)
    d = rec["diff"]
    return json.dumps({"universe": rec["uid"], "summary": d["summary"], "approvals": d["approvals"]}, default=str)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False))
def approve(universe: str) -> str:
    """Approve a plan as the person this server acts for (ORION_USER). Plans proposed through MCP can't be approved
    through MCP. When every required team has approved, the plan merges into the company."""
    if not USER:
        return json.dumps({"error": "start the server with ORION_USER set to the person it acts for"})
    db = dbm.get_db()
    rec = uv.get(db, TENANT, universe)
    if not rec:
        return json.dumps({"error": f"no universe {universe}"})
    if rec["by"] == AGENT:
        return json.dumps({"error": "a plan proposed through MCP needs a person to approve it in Orion"})
    try:
        out = uv.approve(db, TENANT, universe, USER)
    except Exception as e:
        return json.dumps({"error": str(e)})
    return json.dumps({"result": out.get("result"), "message": out.get("message"), "status": out.get("status")}, default=str)


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
