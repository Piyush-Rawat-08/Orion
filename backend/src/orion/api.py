"""HTTP API for the web app. The caller always comes from a signed token (security.py), never from the body.
Work that takes a while (an answer, a live message, a batch of what-ifs) streams each step as a server-sent event."""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from orion import blackboard, llm, memory
from orion import db as dbm
from orion import epoch as ep
from orion import universe as uv
from orion.agents import sentinel
from orion.config import env
from orion.security import VIEWER, Auth, Session, issue_token, limit, require_admin, same_user
from orion.queries import cypher
from orion.tools import ToolContext, call_tool, own_graph

DEMO = "corvane"
TENANTS = {DEMO: {"id": DEMO, "name": "Corvane", "kind": "synthetic",
                  "description": "A fictional developer-platform company with storylines planted in its history."}}
MAX_OPEN_DRYRUNS = int(env("ORION_MAX_DRYRUNS") or 40)


def get_db() -> dbm.DB:
    return dbm.get_db()


def tenant_ids(db: dbm.DB) -> list[str]:
    return [g.split(":", 1)[1] for g in db.graphs("org:")]


@asynccontextmanager
async def lifespan(app: FastAPI):
    db = get_db()
    if not db.exists(dbm.org(DEMO)):
        from orion.load import reset

        reset(db, DEMO)
    ep.checkout(db, DEMO)  # build today's snapshot now, so the first question doesn't wait for it
    stop = threading.Event()
    agents = [(f"simulator-{i + 1}", "simulator", ["fork", "simulate"], None)
              for i in range(int(env("ORION_WORKERS") or 2))]
    agents += [("cartographer-1", "cartographer", ["extract"], []), ("sentinel-1", "sentinel", ["apply"], [])]
    for name, role, kinds, takes in agents:
        threading.Thread(target=blackboard.agent_loop, args=(name, role, kinds, stop, lambda: tenant_ids(db), takes),
                         daemon=True).start()

    def janitor():
        poll = float(env("ORION_GITHUB_POLL_MIN") or 0) * 60
        last = time.time()
        with dbm.tagged("board"):
            while not stop.wait(15):
                try:
                    ts = tenant_ids(db)
                except Exception:
                    continue
                if poll and time.time() - last > poll:
                    last = time.time()
                    from orion.repo import sync

                    for t in ts:
                        if t.startswith("gh-"):
                            try:
                                sync(db, t)
                            except Exception as e:
                                print(f"janitor: sync {t}: {e}", flush=True)
                for t in ts:
                    for step in (blackboard.release_dead, blackboard.retention, uv.gc):
                        try:
                            step(db, t)
                        except Exception as e:
                            print(f"janitor: {step.__name__}({t}): {type(e).__name__}: {e}", flush=True)
                try:
                    blackboard.prune_agents(db)
                except Exception:
                    pass

    threading.Thread(target=janitor, daemon=True).start()
    yield
    stop.set()


app = FastAPI(title="Orion", version="0.2.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware,
                   allow_origins=[o.strip() for o in (env("ORION_CORS") or "http://localhost:3001").split(",")],
                   allow_methods=["GET", "POST"], allow_headers=["authorization", "content-type", "accept", "x-admin-token"])


class ScreenReads:
    """GET requests are screens drawing themselves: their queries are tagged "ui" so the Activity log shows only
    the agents' work. Plain ASGI, so the tag reaches the endpoint's worker thread."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "GET":
            return await self.inner(scope, receive, send)
        token = dbm.ORIGIN.set("ui")
        try:
            await self.inner(scope, receive, send)
        finally:
            dbm.ORIGIN.reset(token)


app.add_middleware(ScreenReads)


def needs_llm(request: Request, calls: int = 1) -> None:
    if not llm.available():
        raise HTTPException(503, "No model key is set on this server (ANTHROPIC_API_KEY or GEMINI_API_KEY).")
    limit(request, cost=calls)


def known(tenant: str) -> str:
    if tenant not in TENANTS and not get_db().exists(dbm.org(tenant)):
        raise HTTPException(404, f"unknown tenant {tenant}")
    return tenant


def person(user: str) -> str | None:
    return None if user == VIEWER else user


def stream(work) -> EventSourceResponse:
    """Run `work(emit)` in a thread and send every event it emits; its return value is the final 'done'."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def emit(event: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)

    def run() -> None:
        try:
            emit({"type": "done", "result": work(emit)})
        except Exception as e:
            emit({"type": "error", "text": f"{type(e).__name__}: {e}"})
            emit({"type": "done", "result": None})

    threading.Thread(target=run, daemon=True).start()

    async def events():
        while True:
            event = await queue.get()
            yield {"event": event["type"], "data": json.dumps(event, default=str, ensure_ascii=False)}
            if event["type"] == "done":
                break

    return EventSourceResponse(events(), ping=15)


# ---------------------------------------------------------------- tenants, people, graph

@app.get("/api/health")
def health() -> dict:
    db = get_db()
    return {"ok": True, "falkordb": bool(db.redis.ping()), "graphs": len(db.graphs()), "llm": llm.available(),
            "models": llm.info()}


@app.get("/api/tenants")
def tenants() -> list[dict]:
    db = get_db()
    out = [t | {"clock": dbm.clock(db, t["id"]), "loaded": db.exists(dbm.org(t["id"]))} for t in TENANTS.values()]
    for t in tenant_ids(db):
        if t not in TENANTS and t.startswith("gh-"):
            row = db.one(dbm.org(t), "MATCH (c:Company) RETURN c.name AS name")
            out.append({"id": t, "name": row["name"] if row else t[3:].replace("--", "/"), "kind": "repo",
                        "clock": dbm.clock(db, t), "loaded": True})
    return out


class Login(BaseModel):
    user: str


@app.post("/api/{tenant}/login")
def login(tenant: str, body: Login) -> dict:
    """No passwords in the demo: pick a person of the company (repo tenants: 'viewer'). The token works for this
    tenant only, and every endpoint takes the user from it."""
    known(tenant)
    if body.user != VIEWER and not get_db().ro(dbm.org(tenant), "MATCH (p:Person {uid: $u}) RETURN p.uid AS u", {"u": body.user}):
        raise HTTPException(404, f"no person {body.user} in {tenant}")
    return {"token": issue_token(tenant, body.user), "tenant": tenant, "user": body.user}


@app.get("/api/{tenant}/me")
def me(tenant: str, s: Session = Auth) -> dict:
    return {"tenant": s.tenant, "user": s.user}


@app.get("/api/{tenant}/people")
def people(tenant: str, s: Session = Auth) -> list[dict]:
    known(tenant)
    db = get_db()
    return db.ro(ep.now(db, tenant), """MATCH (p:Person) OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
                                       RETURN p.uid AS uid, p.name AS name, p.role AS role, t.name AS team ORDER BY p.name""")


NODES = """MATCH (n) WHERE n:Person OR n:Former OR n:Team OR n:Service OR n:Retired OR n:Customer OR n:Project OR n:Decision
RETURN n.uid AS id, labels(n) AS labels, coalesce(n.name, n.title) AS name, n.role AS role, n.tier AS tier,
       n.status AS status, n.group AS grp, n.key AS key, n.kind AS kind"""
EDGES = """MATCH (a)-[r]->(b)
WHERE type(r) IN ['MEMBER_OF', 'OWNS', 'DEPENDS_ON', 'DEPENDS_ON_CLOSED', 'KNOWS', 'COLLABORATES', 'USES', 'WORKED_ON',
                  'AFFECTS', 'CO_CHANGES']
  AND (type(r) <> 'COLLABORATES' OR a.uid < b.uid)
RETURN a.uid AS source, b.uid AS target, type(r) AS type, r.uid AS uid, r.declared AS declared, r.touches AS touches,
       r.weight AS weight, r.kind AS kind, coalesce(r.valid_from, r.last_at) AS since, r.last_at AS last_at,
       r.share AS share, r.changes AS changes"""
RAISED = """MATCH (c:Customer)<-[:RAISED_BY]-(t:Ticket)-[:ABOUT]->(s) WHERE s:Service OR s:Retired
WITH c, s, count(t) AS tickets WHERE tickets >= 2
RETURN c.uid AS source, s.uid AS target, 'RAISED_ABOUT' AS type, tickets"""
AS_TYPE = {"Retired": "Service", "Former": "Person"}


def graph_payload(db: dbm.DB, g: str, asof: str) -> dict:
    nodes = db.ro(g, NODES)
    for n in nodes:
        labels = n.pop("labels")
        n["type"] = AS_TYPE.get(labels[0], labels[0])
        n["retired"], n["former"] = "Retired" in labels, "Former" in labels
    team_of = {r["p"]: r["t"] for r in db.ro(g, "MATCH (p)-[:MEMBER_OF]->(t:Team) RETURN p.uid AS p, t.name AS t")}
    for n in nodes:
        if n["type"] == "Person":
            n["team"] = team_of.get(n["id"])
    return {"graph": g, "asof": asof, "nodes": nodes, "edges": db.ro(g, EDGES) + db.ro(g, RAISED)}


@app.get("/api/{tenant}/graph")
def graph(tenant: str, asof: str | None = None, universe: str | None = None, s: Session = Auth) -> dict:
    """The canvas: the company now, as it was on a date, or inside a what-if."""
    known(tenant)
    db = get_db()
    if universe:
        try:
            u = uv.get_universe(db, tenant, universe)
        except KeyError:
            raise HTTPException(404, "no such universe")
        if not db.exists(u["graph"]):
            raise HTTPException(410, f"universe {universe} is {u['status']}; its graph was deleted")
        return graph_payload(db, u["graph"], u["created_at"]) | {"universe": universe}
    snap = ep.checkout(db, tenant, asof[:10] if asof else None)
    return graph_payload(db, snap["graph"], snap["asof"]) | {"snapshot": snap}


@app.get("/api/{tenant}/timeline")
def timeline(tenant: str, s: Session = Auth) -> dict:
    known(tenant)
    db = get_db()
    g = dbm.org(tenant)
    decisions = db.ro(g, """MATCH (d:Decision) RETURN d.uid AS uid, d.key AS key, d.title AS title, d.status AS status,
                            d.decided_at AS at ORDER BY d.decided_at""")
    events = db.ro(g, """MATCH (a:Service)-[r:DEPENDS_ON]->(b:Service) WHERE r.valid_from >= '2026-02-01'
                         RETURN r.uid AS uid, r.valid_from AS at, a.name + ' → ' + b.name AS label, 'dependency starts' AS kind
                         UNION
                         MATCH (a:Service)-[r:DEPENDS_ON]->(b:Service) WHERE r.valid_to >= '2026-02-01' AND r.valid_to < '9999'
                         RETURN r.uid AS uid, r.valid_to AS at, a.name + ' → ' + b.name AS label, 'dependency ends' AS kind""")
    return {"start": "2026-02-01", "now": dbm.clock(db, tenant), "months": [f"2026-{m:02d}-01" for m in range(2, 11)],
            "decisions": decisions, "events": sorted(events, key=lambda e: e["at"])}


# ---------------------------------------------------------------- ask and answers

class Ask(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    user: str | None = None
    session: str | None = None


@app.post("/api/{tenant}/ask")
async def ask(tenant: str, body: Ask, request: Request, s: Session = Auth):
    """SSE: status / thinking / narration / tool_call / tool_result / verdict / answer / done."""
    known(tenant)
    user = person(same_user(s, body.user))
    needs_llm(request)
    from orion.agents.navigator import answer

    return stream(lambda emit: answer(get_db(), tenant, body.question, user=user, session=body.session, on_event=emit))


@app.get("/api/{tenant}/answers")
def answers(tenant: str, user: str | None = None, s: Session = Auth) -> list[dict]:
    known(tenant)
    return get_db().ro(dbm.org(tenant), """MATCH (a:Answer) WHERE $u IS NULL OR a.asked_by = $u
        OPTIONAL MATCH (a)-[:MAKES]->(c:Claim)
        RETURN a.uid AS uid, a.question AS question, a.summary AS summary, a.at AS at, a.status AS status,
               a.asked_by AS asked_by, count(c) AS claims, $me IN coalesce(a.watchers, []) AS watching
        ORDER BY a.at DESC LIMIT 50""", {"u": user, "me": s.user})


@app.get("/api/{tenant}/answers/{uid:path}")
def answer_detail(tenant: str, uid: str, s: Session = Auth) -> dict:
    known(tenant)
    db = get_db()
    row = db.one(dbm.org(tenant), "MATCH (a:Answer {uid: $u}) RETURN properties(a) AS a", {"u": uid})
    if not row:
        raise HTTPException(404, "no such answer")
    claims = db.ro(dbm.org(tenant), """MATCH (:Answer {uid: $u})-[:MAKES]->(c:Claim)
        RETURN c.uid AS uid, c.text AS text, c.verdict AS verdict, c.reason AS reason, c.evidence AS evidence,
               c.nodes AS nodes, c.kind AS kind, c.check AS check, c.stale AS stale, c.stale_reason AS stale_reason,
               coalesce(c.facts, []) AS facts ORDER BY c.uid""", {"u": uid})
    for c in claims:
        c["evidence"] = json.loads(c["evidence"] or "[]")
        c["nodes"] = json.loads(c["nodes"] or "[]")
        c["check"] = json.loads(c["check"]) if c.get("check") else None
    return {k: v for k, v in row["a"].items() if k != "payload"} | {"claims": claims}


@app.post("/api/{tenant}/answers/{uid:path}/verify")
def answer_verify(tenant: str, uid: str, request: Request, s: Session = Auth) -> dict:
    """Check a stored answer again on today's company. Free text is re-judged only when a model is available."""
    known(tenant)
    from orion.agents.navigator import reverify

    if llm.available():
        limit(request)
    try:
        return reverify(get_db(), tenant, uid, use_llm=llm.available())
    except KeyError as e:
        raise HTTPException(404, str(e))


class Watch(BaseModel):
    on: bool = True


@app.post("/api/{tenant}/answers/{uid:path}/watch")
def watch(tenant: str, uid: str, body: Watch, s: Session = Auth) -> dict:
    """A watched question is re-checked (no model) whenever the records change; the Inbox says when a mark moves."""
    known(tenant)
    rows = get_db().q(dbm.org(tenant), """MATCH (a:Answer {uid: $a})
        SET a.watchers = [w IN coalesce(a.watchers, []) WHERE w <> $u] + CASE WHEN $on THEN [$u] ELSE [] END
        RETURN a.watchers AS w""", {"a": uid, "u": s.user, "on": body.on})
    if not rows:
        raise HTTPException(404, "no such answer")
    return {"answer": uid, "watching": s.user in (rows[0]["w"] or [])}


@app.get("/api/{tenant}/watching")
def watching(tenant: str, s: Session = Auth) -> list[dict]:
    known(tenant)
    return get_db().ro(dbm.org(tenant), """MATCH (a:Answer) WHERE $u IN coalesce(a.watchers, [])
        OPTIONAL MATCH (a)-[:MAKES]->(c:Claim)
        RETURN a.uid AS uid, a.question AS question, a.at AS at, a.status AS status, a.checked_at AS checked_at,
               collect(c.verdict) AS marks ORDER BY a.at DESC""", {"u": s.user})


class AsOf(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


@app.post("/api/{tenant}/answers/{uid:path}/asof")
def answer_asof(tenant: str, uid: str, body: AsOf, s: Session = Auth) -> dict:
    """"Was this true on...?": each typed point checked against the company as it was on a date. No model call."""
    known(tenant)
    from orion.agents.navigator import asof

    try:
        return asof(get_db(), tenant, uid, body.date)
    except KeyError as e:
        raise HTTPException(404, str(e))


# ---------------------------------------------------------------- read tools

@app.post("/api/{tenant}/tools/{name}")
def tool(tenant: str, name: str, args: dict[str, Any], s: Session = Auth) -> dict:
    known(tenant)
    if name in ("fork", "dry_run", "remember"):
        raise HTTPException(400, "use /fork or /ask for anything that writes")
    ctx = ToolContext(get_db(), tenant, user=person(s.user))
    res = call_tool(ctx, name, args)
    return {"result": res, "evidence": ctx.evidence, "ms": ctx.calls[-1]["ms"] if ctx.calls else None}


@app.get("/api/{tenant}/departures")
def departures(tenant: str, s: Session = Auth) -> dict:
    """If they left tomorrow: people ranked by what their leaving would cost (scratch copies, no model)."""
    known(tenant)
    from orion.departures import departures as rank

    return rank(get_db(), tenant)


@app.get("/api/{tenant}/undeclared")
def undeclared(tenant: str, s: Session = Auth) -> list[dict]:
    """Dependencies nobody wrote down, each with where Orion found it and the words it came from."""
    known(tenant)
    return get_db().ro(dbm.org(tenant), cypher("undeclared"))


@app.get("/api/{tenant}/blame")
def blame(tenant: str, fact: str, s: Session = Auth) -> dict:
    return tool(tenant, "blame", {"fact_uid": fact}, s)


@app.get("/api/{tenant}/communities")
def communities(tenant: str, asof: str | None = None, s: Session = Auth) -> dict:
    return tool(tenant, "communities", {"asof": asof} if asof else {}, s)


@app.get("/api/{tenant}/contradictions")
def contradictions(tenant: str, s: Session = Auth) -> dict:
    return tool(tenant, "contradictions", {}, s)


# ---------------------------------------------------------------- what-ifs and proposals

class ForkBody(BaseModel):
    ops: list[dict] = Field(min_length=1, max_length=12)
    title: str | None = None
    kind: Literal["whatif", "dryrun"] = "whatif"
    user: str | None = None


@app.post("/api/{tenant}/fork")
def fork(tenant: str, body: ForkBody, request: Request, s: Session = Auth) -> dict:
    known(tenant)
    limit(request, bucket="fork")
    user = same_user(s, body.user)
    db = get_db()
    if body.kind == "dryrun" and sum(1 for u in uv.list_universes(db, tenant)
                                     if u["kind"] == "dryrun" and u["status"] == "open") >= MAX_OPEN_DRYRUNS:
        raise HTTPException(429, "Too many proposals are waiting for approval; decide some first.")
    try:
        return blackboard.run(db, tenant, "fork", {"ops": body.ops, "title": body.title, "kind": body.kind,
                                                   "created_by": user}, posted_by=user)
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")


class SimulateBody(BaseModel):
    scenarios: list[str] = Field(min_length=1, max_length=6)
    user: str | None = None


@app.post("/api/{tenant}/simulate")
async def simulate(tenant: str, body: SimulateBody, request: Request, s: Session = Auth):
    """What-ifs in plain words. Each is a task on the board; the Simulators take them in parallel.
    SSE: task_posted / universe / error / done."""
    known(tenant)
    user = same_user(s, body.user)
    needs_llm(request, calls=len(body.scenarios))
    db = get_db()

    def work(emit):
        def one(scenario: str) -> dict:
            emit({"type": "task_posted", "scenario": scenario})
            try:
                r = blackboard.run(db, tenant, "simulate", {"scenario": scenario, "created_by": user}, posted_by=user)
            except Exception as e:
                emit({"type": "error", "scenario": scenario, "text": str(e)})
                return {"error": str(e), "scenario": scenario}
            emit({"type": "universe", "scenario": scenario, "universe": r["uid"], "title": r["title"],
                  "risk": r["diff"]["risk"], "worker": r.get("_worker"), "fork_ms": r["fork_ms"],
                  "assumptions": r.get("assumptions", [])})
            return r

        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=min(6, len(body.scenarios))) as ex:
            results = list(ex.map(one, body.scenarios))
        return {"universes": [r.get("uid") for r in results], "wall_ms": round((time.perf_counter() - t0) * 1000)}

    return stream(work)


@app.get("/api/{tenant}/universes")
def universes(tenant: str, s: Session = Auth) -> list[dict]:
    known(tenant)
    return [uv.summary(u) for u in uv.list_universes(get_db(), tenant)]


@app.get("/api/{tenant}/universes/{uid}")
def universe_detail(tenant: str, uid: str, s: Session = Auth) -> dict:
    known(tenant)
    try:
        return uv.detail(get_db(), tenant, uid)
    except KeyError:
        raise HTTPException(404, "no such universe")


@app.get("/api/{tenant}/universes/{uid}/who-to-tell")
def who_to_tell(tenant: str, uid: str, s: Session = Auth) -> dict:
    """After a what-if: each customer who would notice, their open tickets and the person who has handled them
    most, plus the teams to bring in."""
    known(tenant)
    db = get_db()
    try:
        u = uv.get_universe(db, tenant, uid)
    except KeyError:
        raise HTTPException(404, "no such universe")
    d = json.loads(u["diff_json"]) if u.get("diff_json") else None
    if not d:
        return {"universe": uid, "customers": [], "teams": []}
    g = ep.now(db, tenant)
    out = []
    for c in d.get("customers") or []:
        tickets = db.ro(g, """MATCH (c:Customer {uid: $c})<-[:RAISED_BY]-(t:Ticket) WHERE t.status <> 'done'
                              OPTIONAL MATCH (t)-[:ABOUT]->(x) WHERE x.name IN $svc
                              WITH t, count(x) > 0 AS related
                              RETURN t.key AS key, t.title AS title, t.status AS status, t.priority AS priority, related
                              ORDER BY related DESC, t.priority, t.at DESC LIMIT 4""", {"c": c["uid"], "svc": c["services"]})
        contact = db.one(g, """MATCH (c:Customer {uid: $c})<-[:RAISED_BY]-(:Ticket)-[:ASSIGNED_TO]->(p:Person)
                               OPTIONAL MATCH (p)-[:MEMBER_OF]->(tm:Team)
                               RETURN p.name AS name, tm.name AS team, count(*) AS n ORDER BY n DESC LIMIT 1""",
                         {"c": c["uid"]})
        out.append({"uid": c["uid"], "customer": c["customer"], "tier": c["tier"], "services": c["services"],
                    "open_tickets": tickets, "contact": contact})
    return {"universe": uid, "title": u["title"], "customers": out,
            "teams": [{"team": r["team"], "because": r["because"]} for r in d.get("required_approvers") or []]}


class Decide(BaseModel):
    note: str = ""
    force: bool = False
    by: str | None = None


@app.post("/api/{tenant}/universes/{uid}/approve")
def approve(tenant: str, uid: str, body: Decide, s: Session = Auth) -> dict:
    """Approve as yourself: 200 {status: waiting | merged}; 409 {status: rebase_needed | blocked}."""
    known(tenant)
    try:
        out = uv.approve(get_db(), tenant, uid, same_user(s, body.by), body.note, force=body.force)
    except uv.Busy as e:
        raise HTTPException(409, str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    if out["status"] in ("rebase_needed", "blocked"):
        raise HTTPException(409, out)
    return out


@app.post("/api/{tenant}/universes/{uid}/reject")
def reject(tenant: str, uid: str, body: Decide, s: Session = Auth) -> dict:
    known(tenant)
    try:
        return uv.discard(get_db(), tenant, uid, same_user(s, body.by), body.note)
    except KeyError:
        raise HTTPException(404, "no such universe")
    except ValueError as e:
        raise HTTPException(409, str(e))


# ---------------------------------------------------------------- the safe path, hindsight

class PlanBody(BaseModel):
    ops: list[dict] = Field(min_length=1, max_length=4)
    asof: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    mode: Literal["true", "known"] = "true"


@app.post("/api/{tenant}/plan")
async def plan(tenant: str, body: PlanBody, request: Request, s: Session = Auth):
    """The safe path: search parallel companies for the preparation that makes a change break nothing.
    SSE: status / universe (one per company explored) / best / done."""
    known(tenant)
    limit(request, bucket="fork")
    from orion import planner

    return stream(lambda emit: planner.plan(get_db(), tenant, body.ops, emit=emit, asof=body.asof, mode=body.mode))


@app.get("/api/{tenant}/incidents")
def incidents(tenant: str, s: Session = Auth) -> list[dict]:
    known(tenant)
    from orion import hindsight

    return hindsight.incidents(get_db(), tenant)


@app.post("/api/{tenant}/incidents/{key}/replay")
async def replay_incident(tenant: str, key: str, request: Request, s: Session = Auth):
    """Would Orion have caught it? The decision before the incident, replayed on what was known and what was true
    that day, the facts nobody had written down, and the safe path Orion would have recommended.
    SSE: status / known / true / blind_spot / universe / done."""
    known(tenant)
    limit(request, bucket="fork")
    from orion import hindsight

    return stream(lambda emit: hindsight.replay(get_db(), tenant, key, emit=emit))


@app.get("/api/{tenant}/eval")
def eval_results(tenant: str, s: Session = Auth) -> dict:
    """The last head-to-head run (orion.evals): the same questions to Orion and to the model reading the records."""
    from orion import evals

    if not evals.OUT.exists():
        raise HTTPException(404, "no evaluation has been run yet: uv run python -m orion.evals")
    return json.loads(evals.OUT.read_text())


# ---------------------------------------------------------------- live messages, inbox, reviews

class MessageBody(BaseModel):
    channel: str = "#billing"
    text: str = Field(min_length=1, max_length=2000)


@app.post("/api/{tenant}/messages")
async def post_message(tenant: str, body: MessageBody, request: Request, s: Session = Auth):
    """A new chat message, read live by the Cartographer and decided by the Sentinel. SSE. The author is the
    token's person: the Sentinel weighs a change by who said it, so the author can't be a request field."""
    known(tenant)
    row = get_db().one(dbm.org(tenant), "MATCH (p:Person {uid: $u}) RETURN p.name AS name", {"u": s.user})
    if not row:
        raise HTTPException(403, "only a person of this company can post a message")
    if llm.available():
        limit(request)
    from orion.agents.cartographer import ingest_message

    return stream(lambda emit: ingest_message(get_db(), tenant, body.channel, row["name"], body.text, emit, posted_by=s.user))


@app.get("/api/{tenant}/messages")
def messages(tenant: str, channel: str | None = None, s: Session = Auth) -> list[dict]:
    known(tenant)
    return get_db().ro(dbm.org(tenant), """MATCH (m:Message) WHERE $c IS NULL OR m.channel = $c
        OPTIONAL MATCH (m)-[:POSTED_BY]->(p:Person)
        RETURN m.uid AS uid, m.channel AS channel, m.at AS at, m.text AS text, p.name AS author, m.live AS live
        ORDER BY m.at DESC LIMIT 100""", {"c": channel})


@app.get("/api/{tenant}/inbox")
def inbox(tenant: str, user: str | None = None, s: Session = Auth) -> list[dict]:
    known(tenant)
    return sentinel.inbox(get_db(), tenant, same_user(s, user))


@app.post("/api/{tenant}/inbox/{uid}/read")
def read(tenant: str, uid: str, s: Session = Auth) -> dict:
    if not sentinel.mark_read(get_db(), tenant, uid, s.user):
        raise HTTPException(404, "no such notification in your inbox")
    return {"ok": True}


@app.get("/api/{tenant}/reviews")
def reviews(tenant: str, status: str = "pending", s: Session = Auth) -> list[dict]:
    known(tenant)
    return sentinel.reviews(get_db(), tenant, status)


@app.post("/api/{tenant}/reviews/{uid}/{verdict}")
def decide_review(tenant: str, uid: str, verdict: str, s: Session = Auth) -> dict:
    known(tenant)
    if verdict not in ("accept", "reject"):
        raise HTTPException(400, "accept or reject")
    try:
        return sentinel.decide_review(get_db(), tenant, uid, s.user, accept=verdict == "accept")
    except KeyError as e:
        raise HTTPException(404, str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))


@app.get("/api/{tenant}/chain/{task}")
def chain(tenant: str, task: str, s: Session = Auth) -> dict:
    known(tenant)
    return {"tasks": blackboard.chain(get_db(), tenant, task),
            "cypher": "MATCH (t:Task {uid: $u}) WITH coalesce(t.root, t.uid) AS root MATCH (x:Task) "
                      "WHERE x.root = root OR x.uid = root RETURN x ORDER BY x.created_at"}


# ---------------------------------------------------------------- memory

@app.get("/api/{tenant}/memory")
def memory_view(tenant: str, user: str | None = None, s: Session = Auth) -> dict:
    db = get_db()
    who = same_user(s, user)
    return memory.recall(db, tenant, who, limit=20, now=dbm.clock(db, tenant)) | {
        "history": memory.history(db, tenant, who), "belief_history": memory.belief_history(db, tenant, who)}


@app.get("/api/{tenant}/sessions/last")
def last_session(tenant: str, user: str | None = None, s: Session = Auth) -> dict:
    """The caller's latest conversation with each stored answer, so a reload picks up where they left off."""
    db = get_db()
    turns = list(reversed(memory.history(db, tenant, same_user(s, user), limit=40)))
    if not turns:
        return {"session": None, "turns": []}
    session = turns[-1]["session"]
    out, question = [], None
    for x in (x for x in turns if x["session"] == session):
        if x["role"] == "user":
            question = x
        elif question and x.get("answer_uid"):
            row = db.one(dbm.org(tenant), "MATCH (a:Answer {uid: $a}) RETURN a.payload AS p, a.status AS status",
                         {"a": x["answer_uid"]})
            if row and row["p"]:
                out.append({"question": question["text"], "at": question["at"], "answer": x["answer_uid"],
                            "status": row["status"], "result": json.loads(row["p"])})
            question = None
    return {"session": session, "turns": out[-6:]}


# ---------------------------------------------------------------- repo mode

class RepoBody(BaseModel):
    url: str
    max_prs: int = 200


@app.post("/api/repos")
def ingest_repo(body: RepoBody, request: Request) -> dict:
    """Paste a public GitHub repo: its pull requests, reviews, CODEOWNERS and imports become a new tenant (no model)."""
    limit(request, bucket="repo")
    m = re.search(r"(?:github\.com/)?([A-Za-z0-9-]+)/([A-Za-z0-9._-]+?)(?:\.git)?/?$", body.url.strip())
    if not m:
        raise HTTPException(400, "expected owner/repo or a github.com URL")
    from orion import repo

    try:
        return repo.ingest(get_db(), m.group(1), m.group(2), max_prs=min(body.max_prs, 300))
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")


@app.get("/api/{tenant}/insights")
def insights(tenant: str, all_kinds: bool = False, s: Session = Auth) -> dict:
    known(tenant)
    from orion import repo

    return repo.insights(get_db(), tenant, all_kinds=all_kinds)


@app.post("/api/{tenant}/sync")
def sync(tenant: str, request: Request, s: Session = Auth) -> dict:
    """Fold in what merged on GitHub since the last sync; import changes go through the Sentinel."""
    known(tenant)
    limit(request, bucket="repo")
    from orion import repo

    try:
        return repo.sync(get_db(), tenant)
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")


class ModuleWhatIf(BaseModel):
    module: str


@app.post("/api/{tenant}/module-whatif")
def module_whatif(tenant: str, body: ModuleWhatIf, s: Session = Auth) -> dict:
    known(tenant)
    from orion import repo

    try:
        return repo.module_whatif(get_db(), tenant, body.module)
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")


# ---------------------------------------------------------------- activity, stats, reset

@app.get("/api/{tenant}/activity")
def activity(tenant: str, s: Session = Auth) -> dict:
    known(tenant)
    db = get_db()
    out = blackboard.activity(db, tenant)
    work = [r for r in list(db.log) if r.origin not in ("ui", "board")][-60:]
    out["queries"] = [{"graph": r.graph, "cypher": r.cypher[:400], "ms": round(r.ms, 2), "rows": r.rows,
                       "read_only": r.read_only, "at": r.at,
                       "task": r.origin[5:] if r.origin and r.origin.startswith("task:") else None} for r in work][::-1]
    return out


@app.get("/api/{tenant}/stats")
def stats(tenant: str, s: Session = Auth) -> dict:
    known(tenant)
    db = get_db()
    g = dbm.org(tenant)
    us = uv.list_universes(db, tenant)
    copies = sorted(u["copy_ms"] for u in us if u.get("copy_ms") is not None)
    return {"nodes": db.ro(g, "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n ORDER BY n DESC"),
            "relationships": db.one(g, "MATCH ()-[r]->() RETURN count(r) AS n")["n"],
            "graphs": [x for x in db.graphs() if own_graph(tenant, x)], "universes": len(us),
            "copy_ms_median": copies[len(copies) // 2] if copies else None, "clock": dbm.clock(db, tenant),
            "version": dbm.version(db, tenant), "workers": blackboard.live_workers(db, tenant)}


@app.post("/api/{tenant}/reset")
def reset(tenant: str, request: Request) -> dict:
    """Admin only (ORION_ADMIN_TOKEN, sent as X-Admin-Token)."""
    require_admin(request)
    if tenant != DEMO:
        raise HTTPException(400, "only the demo company can be reset")
    from orion.load import reset as reload

    return reload(get_db(), DEMO)
