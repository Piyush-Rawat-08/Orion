"""HTTP API for the web app. Every tenant route takes the caller from a signed token (security.py).
Long-running work (an answer, a live message) streams its steps as server-sent events."""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from orion import db as dbm
from orion import deck, epoch, llm, memory, tools, viz, watch
from orion import ops as opsm
from orion import universe as uv
from orion.config import env
from orion.security import Session, limit, mint, require_admin, session

app = FastAPI(title="Orion", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in (env("ORION_CORS") or "*").split(",")],
                   allow_methods=["GET", "POST"], allow_headers=["authorization", "content-type", "x-admin-token"])


def db() -> dbm.DB:
    return dbm.get_db()


def _err(e: Exception) -> HTTPException:
    if isinstance(e, HTTPException):
        return e
    if isinstance(e, PermissionError):
        return HTTPException(403, str(e))
    if isinstance(e, KeyError):
        return HTTPException(404, f"not found: {e}")
    if isinstance(e, (opsm.OpError, ValueError, LookupError)):
        return HTTPException(400, str(e))
    if isinstance(e, llm.LLMUnavailable):
        return HTTPException(503, str(e))
    return HTTPException(500, f"{type(e).__name__}: {e}")


def stream(work) -> EventSourceResponse:
    """Run blocking work in a thread; every emit() becomes one SSE event, then a final 'done' or 'error'."""
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()

    def emit(e: dict) -> None:
        loop.call_soon_threadsafe(q.put_nowait, e)

    def run():
        try:
            result = work(emit)
            emit({"type": "done", "result": result})
        except Exception as e:  # surfaced to the client as an event, not a broken stream
            emit({"type": "error", "error": _err(e).detail})
        finally:
            emit({"type": "_end"})

    threading.Thread(target=run, daemon=True).start()

    async def events():
        while True:
            e = await q.get()
            if e["type"] == "_end":
                break
            yield {"event": e["type"], "data": json.dumps(e, default=str)}

    return EventSourceResponse(events(), ping=10)


# ---------------------------------------------------------------- open

@app.get("/api/health")
def health():
    d = db()
    return {"ok": True, "falkordb": bool(d.redis.ping()), "llm": llm.info()}


@app.get("/api/{tenant}/personas")
def personas(tenant: str):
    """People you can sign in as: everyone currently at the company, leads first."""
    g = epoch.now(db(), tenant)
    rows = db().ro(g, """MATCH (p:Person)-[:MEMBER_OF]->(t:Team)
                         RETURN p.uid AS uid, p.name AS name, p.role AS role, t.uid AS team, t.name AS team_name
                         ORDER BY CASE WHEN p.role CONTAINS 'lead' THEN 0 ELSE 1 END, t.name, p.name""")
    return rows


@app.get("/api/{tenant}/census")
def census(tenant: str):
    """How much is in the company graph (open: the landing page counts up to it)."""
    row = db().one(dbm.org(tenant), "MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS edges")
    return row or {"nodes": 0, "edges": 0}


class Login(BaseModel):
    person: str


@app.post("/api/{tenant}/login")
def login(tenant: str, body: Login):
    try:
        me = uv.who(db(), tenant, body.person)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"token": mint(tenant, me["uid"]), "me": me}


@app.post("/api/admin/reset")
def reset(request: Request, tenant: str = "corvane"):
    require_admin(request)
    from orion import load

    return load.reset(db(), tenant)


# ---------------------------------------------------------------- company

@app.get("/api/{tenant}/meta")
def meta(tenant: str, s: Session = Depends(session)):
    d = db()
    row = d.one(dbm.org(tenant), "MATCH (c:Company) RETURN c.name AS name")
    me = uv.who(d, tenant, s.user)
    unread = d.one(uv._deck(d, tenant), "MATCH (n:Notification {user: $u, read: false}) RETURN count(n) AS n",
                   {"u": s.user})["n"]
    waiting = d.one(uv._deck(d, tenant), """MATCH (u:Universe {status: 'open'}) WHERE $team IN u.required
                                            RETURN count(u) AS n""", {"team": me["team"]})["n"]
    return {"company": row["name"], "tenant": tenant, "clock": dbm.clock(d, tenant), "version": dbm.version(d, tenant),
            "me": me, "llm": llm.info(), "unread": unread, "waiting": waiting}


@app.get("/api/{tenant}/galaxy")
def galaxy(tenant: str, on: str | None = None, mode: str = "true", s: Session = Depends(session)):
    d = db()
    g = epoch.ensure(d, tenant, on[:10], mode) if on else epoch.now(d, tenant)
    return viz.galaxy(d, g) | {"on": on or dbm.clock(d, tenant), "mode": mode}


@app.get("/api/{tenant}/timeline")
def timeline(tenant: str, s: Session = Depends(session)):
    return viz.timeline(db(), tenant)


@app.get("/api/{tenant}/entity/{uid:path}")
def entity(tenant: str, uid: str, s: Session = Depends(session)):
    d = db()
    g, org = epoch.now(d, tenant), dbm.org(tenant)
    node = d.one(org, "MATCH (n {uid: $u}) RETURN n, labels(n) AS labels", {"u": uid})
    if not node:
        raise HTTPException(404, uid)
    props = {k: v for k, v in node["n"].items() if k not in ("_labels", "payload", "text") or k == "text"}
    neighbors = d.ro(g, """MATCH (n {uid: $u})-[r]-(m) WHERE NOT m:Change AND NOT m:Alias
                           RETURN type(r) AS rel, startNode(r).uid = $u AS out, m.uid AS uid,
                                  coalesce(m.name, m.key, m.title) AS name, labels(m)[0] AS label LIMIT 80""", {"u": uid})
    ctx = tools.Ctx(d, tenant, s.user)
    extra: dict[str, Any] = {}
    labels = node["labels"]
    try:
        if "Service" in labels:
            extra["knows"] = tools.who_knows(ctx, uid)["rows"]
            extra["impact"] = tools.impact_of(ctx, uid)["rows"]
            extra["decisions"] = tools.decision_history(ctx, uid)["rows"]
        if "Customer" in labels:
            extra["story"] = tools.customer_story(ctx, uid)["rows"]
        if "Decision" in labels:
            extra["decisions"] = tools.decision_history(ctx, uid)["rows"]
        extra["facts"] = tools.blame(ctx, uid)["rows"]
        extra["findings"] = tools.findings(ctx, uid)["rows"]
    except LookupError:
        pass
    changes = d.ro(org, """MATCH (n {uid: $u})
                           OPTIONAL MATCH (n)<-[:MODIFIES]-(c:Change)<-[:AUTHORED]-(a1:Person)
                           OPTIONAL MATCH (n)-[:AUTHORED]->(c2:Change)
                           WITH collect(DISTINCT {key: c.key, title: c.title, at: c.at, by: a1.name}) +
                                collect(DISTINCT {key: c2.key, title: c2.title, at: c2.at, by: n.name}) AS cs
                           UNWIND cs AS c WITH c WHERE c.key IS NOT NULL RETURN c ORDER BY c.at DESC LIMIT 12""",
                   {"u": uid})
    sources = d.ro(org, """MATCH (s:Source)-[:MENTIONS]->({uid: $u}) OPTIONAL MATCH (s)-[:POSTED_BY|WRITTEN_BY]->(p:Person)
                           RETURN s.uid AS uid, labels(s)[1] AS kind, coalesce(s.title, s.channel) AS title, s.at AS at,
                                  s.text AS text, p.name AS author ORDER BY at DESC LIMIT 12""", {"u": uid})
    return {"uid": uid, "labels": labels, "props": props, "neighbors": neighbors, "changes": [c["c"] for c in changes],
            "sources": sources, **extra}


@app.post("/api/{tenant}/tools/{name}")
def run_tool(tenant: str, name: str, args: dict, s: Session = Depends(session)):
    if name == "what_if":
        raise HTTPException(400, "use POST /universes to fork")
    try:
        return tools.run(tools.Ctx(db(), tenant, s.user), name, args)
    except Exception as e:
        raise _err(e)


@app.get("/api/{tenant}/insights")
def insights(tenant: str, s: Session = Depends(session)):
    ctx = tools.Ctx(db(), tenant, s.user)
    out = {}
    for name in ("bus_factor", "org_vs_reality", "hidden_teams", "contradictions"):
        r = tools.run(ctx, name, {})
        out[name] = {"rows": r["rows"], "summary": r["summary"]}
    blocked = db().ro(dbm.org(tenant), """MATCH (b:Ticket)-[:BLOCKS*1..4]->(t:Ticket)-[:RAISED_BY]->(c:Customer)
                                          WHERE t.status = 'open' AND b.status = 'open'
                                          RETURN c.uid AS customer_uid, c.name AS customer, c.tier AS tier, t.key AS ticket,
                                                 t.title AS title, collect(DISTINCT b.key) AS blocked_by""")
    out["blocked_customers"] = blocked
    return out


# ---------------------------------------------------------------- universes

class ForkBody(BaseModel):
    changes: list[dict] = Field(min_length=1, max_length=8)
    on: str | None = None
    mode: str = "true"
    title: str | None = None
    kind: str = "whatif"


@app.get("/api/{tenant}/universes")
def universes(tenant: str, s: Session = Depends(session)):
    return uv.listing(db(), tenant)


@app.post("/api/{tenant}/universes")
def fork(tenant: str, body: ForkBody, s: Session = Depends(session)):
    try:
        changes = [opsm.parse(c) if isinstance(c, str) else c for c in body.changes]
        rec = uv.fork(db(), tenant, changes, by=s.user, on=body.on, mode=body.mode, title=body.title,
                      kind="plan" if body.kind == "plan" else "whatif")
        deck.record(db(), tenant, "Simulator", "fork", {"changes": rec["ops"], "title": rec["title"]},
                    {"universe": rec["uid"], "risk": rec["risk"]}, by=s.user)
        return uv.get(db(), tenant, rec["uid"])
    except Exception as e:
        raise _err(e)


@app.get("/api/{tenant}/universes/{uid}")
def universe(tenant: str, uid: str, s: Session = Depends(session)):
    rec = uv.get(db(), tenant, uid)
    if not rec:
        raise HTTPException(404, uid)
    return rec | {"stale": uv.stale(db(), tenant, rec) and rec["status"] == "open" and not rec.get("on")}


@app.get("/api/{tenant}/universes/{uid}/galaxy")
def universe_galaxy(tenant: str, uid: str, s: Session = Depends(session)):
    rec = uv.get(db(), tenant, uid)
    if not rec:
        raise HTTPException(404, uid)
    if not db().exists(rec["graph"]):
        raise HTTPException(410, f"universe {uid} is {rec['status']}; its graph is gone")
    return viz.galaxy(db(), rec["graph"])


class ApproveBody(BaseModel):
    force: bool = False


@app.post("/api/{tenant}/universes/{uid}/approve")
def approve(tenant: str, uid: str, body: ApproveBody, s: Session = Depends(session)):
    try:
        return uv.approve(db(), tenant, uid, s.user, force=body.force)
    except Exception as e:
        raise _err(e)


@app.post("/api/{tenant}/universes/{uid}/discard")
def discard(tenant: str, uid: str, s: Session = Depends(session)):
    try:
        return uv.discard(db(), tenant, uid, s.user)
    except Exception as e:
        raise _err(e)


# ---------------------------------------------------------------- agents

class AskBody(BaseModel):
    question: str = Field(min_length=2, max_length=600)
    session: str | None = None


@app.post("/api/{tenant}/ask")
async def ask(tenant: str, body: AskBody, request: Request, s: Session = Depends(session)):
    from orion.agents import navigator

    if not llm.available():
        raise HTTPException(503, "no model API key is configured; the graph tools still work")
    limit(request)

    def work(emit):
        d = db()
        task = deck.post(d, tenant, "ask", {"question": body.question}, by=s.user)
        deck.claim(d, tenant, "Navigator", uid=task)
        try:
            out = navigator.ask(d, tenant, body.question, user=s.user, session=body.session, emit=emit)
        except Exception as e:
            deck.failed(d, tenant, task, str(e))
            raise
        deck.done(d, tenant, task, {"answer": out["uid"], "claims": len(out["claims"])})
        return {"answer": out["uid"]}

    return stream(work)


@app.get("/api/{tenant}/answers")
def answers(tenant: str, mine: bool = True, s: Session = Depends(session)):
    where = "WHERE a.asked_by = $u" if mine else ""
    return db().ro(dbm.org(tenant), f"""MATCH (a:Answer) {where}
                                        OPTIONAL MATCH (a)-[:MAKES]->(c:Claim)
                                        RETURN a.uid AS uid, a.question AS question, a.at AS at, a.status AS status,
                                               a.session AS session, collect(c.status) AS statuses
                                        ORDER BY at DESC LIMIT 40""", {"u": s.user})


@app.get("/api/{tenant}/answers/{uid}")
def answer(tenant: str, uid: str, s: Session = Depends(session)):
    a = watch.answer(db(), tenant, uid)
    if not a:
        raise HTTPException(404, uid)
    return a


class MessageBody(BaseModel):
    channel: str = Field(pattern=r"^#[a-z0-9-]{2,30}$")
    text: str = Field(min_length=3, max_length=1000)


@app.post("/api/{tenant}/messages")
async def post_message(tenant: str, body: MessageBody, request: Request, s: Session = Depends(session)):
    """A new chat message. The author is the signed-in person: the Sentinel weighs authority by team, so the
    author can't come from the request."""
    from orion import live

    limit(request)
    return stream(lambda emit: live.ingest(db(), tenant, s.user, body.channel, body.text, emit))


@app.get("/api/{tenant}/messages")
def messages(tenant: str, limit_: int = 40, s: Session = Depends(session)):
    return db().ro(dbm.org(tenant), """MATCH (m:Message) OPTIONAL MATCH (m)-[:POSTED_BY]->(p:Person)
                                       RETURN m.uid AS uid, m.channel AS channel, m.at AS at, m.text AS text,
                                              p.name AS author, p.uid AS author_uid, m.live AS live
                                       ORDER BY at DESC LIMIT $n""", {"n": min(limit_, 200)})


@app.get("/api/{tenant}/reviews")
def reviews(tenant: str, s: Session = Depends(session)):
    rows = db().ro(uv._deck(db(), tenant), """MATCH (r:Review) RETURN r ORDER BY r.at DESC LIMIT 30""")
    return [r["r"] | {"change": json.loads(r["r"]["change"])} for r in rows]


class ReviewBody(BaseModel):
    accept: bool


@app.post("/api/{tenant}/reviews/{uid}")
def decide(tenant: str, uid: str, body: ReviewBody, s: Session = Depends(session)):
    from orion.agents import sentinel

    try:
        return sentinel.review(db(), tenant, uid, s.user, body.accept)
    except Exception as e:
        raise _err(e)


@app.get("/api/{tenant}/inbox")
def inbox(tenant: str, s: Session = Depends(session)):
    d = db()
    notes = d.ro(uv._deck(d, tenant), """MATCH (n:Notification {user: $u}) RETURN n ORDER BY n.at DESC LIMIT 40""",
                 {"u": s.user})
    me = uv.who(d, tenant, s.user)
    waiting = d.ro(uv._deck(d, tenant), """MATCH (u:Universe {status: 'open'}) WHERE $team IN u.required
                                           RETURN u.uid AS uid, u.title AS title, u.risk AS risk, u.level AS level,
                                                  u.by AS by, u.created_at AS at""", {"team": me["team"]})
    return {"notifications": [n["n"] for n in notes], "approvals": waiting}


@app.post("/api/{tenant}/inbox/read")
def read_all(tenant: str, s: Session = Depends(session)):
    db().q(uv._deck(db(), tenant), "MATCH (n:Notification {user: $u}) SET n.read = true", {"u": s.user})
    return {"ok": True}


@app.get("/api/{tenant}/deck")
def activity(tenant: str, s: Session = Depends(session)):
    return deck.activity(db(), tenant)


@app.get("/api/{tenant}/memory")
def my_memory(tenant: str, s: Session = Depends(session)):
    return memory.timeline(db(), tenant, s.user)
