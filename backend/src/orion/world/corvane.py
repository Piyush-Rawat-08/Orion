"""Corvane: a fictional developer-platform company (hosted CI, feature flags, observability, usage billing).

The org chart, service catalog, customers and decisions below are hand-written; pull requests, reviews and most
tickets are generated from a fixed seed so the company has a believable history. A handful of storylines are
planted on purpose, because they are the questions a company graph should be able to answer:

  ghost dependency   invoice-render calls sso-legacy for its PDF signing token. The catalog never listed it; it
                     was found in #billing on 2026-03-24, after retiring sso-legacy caused INC-311.
  reversed decision  ADR-011 retired sso-legacy; ADR-014 brought it back nine days later.
  bus factor of one  only Ines Okafor has touched the ledger in the last six months.
  knowledge orphan   Marcus Bell left in July; nobody else knows reports-legacy.
  wiki vs reality    the alerting wiki says Signals owns alert-router; Platform has made every change since March.
  hidden team        five people from Runtime, Data and Signals have been working as one group on Build Insights.
  contradiction      two Runtime engineers disagree on whether runner-fleet still goes through cache-proxy.
  blocked customer   Helio Robotics waits on SUP-1042, blocked by BILL-207, blocked by IDN-58.
  a star replaced    event-bus (Kafka) was retired on 2026-05-12; stream-hub took its traffic.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import date, timedelta

from orion.world import story

TENANT = "corvane"
COMPANY = "Corvane"
CLOCK = "2026-10-01T09:00"  # the demo is pinned to this moment so every number is reproducible
START = "2024-01-01"
OPEN = "9999-12-31"  # valid_to of a fact that still holds
SEED = 1015

TEAMS = [
    # uid, name, mission
    ("platform", "Platform", "Identity, the edge, secrets and flags: the ground every other team stands on."),
    ("billing", "Billing", "Metering, invoicing and the ledger. Money in, correctly, every time."),
    ("runtime", "Runtime", "Schedules and runs customers' builds, and keeps their artifacts."),
    ("signals", "Signals", "Logs, metrics, traces and alerts for Corvane and its customers."),
    ("console", "Console", "The web console, onboarding, docs and the mail customers receive."),
    ("data", "Data", "The event stream, the warehouse and reporting."),
]

# name, team, role, joined, left
PEOPLE = [
    ("Priya Raman", "platform", "Engineering lead", "2023-03-06", None),
    ("Yusuf Demir", "platform", "Staff engineer", "2022-08-15", None),
    ("Kofi Mensah", "platform", "Senior engineer", "2024-02-12", None),
    ("Lena Fischer", "signals", "Senior engineer", "2023-06-01", None),  # moves to Platform 2025-11-03
    ("Rafael Costa", "platform", "Site reliability engineer", "2023-11-20", None),
    ("Mei Lin", "platform", "Engineer", "2025-04-07", None),
    ("Jonas Berg", "platform", "Engineer", "2025-10-13", None),
    ("Daniel Osei", "billing", "Engineering lead", "2022-11-01", None),
    ("Ines Okafor", "billing", "Staff engineer", "2022-04-19", None),
    ("Tomasz Nowak", "billing", "Senior engineer", "2023-09-04", None),
    ("Amara Nwosu", "billing", "Engineer", "2024-05-13", None),
    ("Felipe Ortega", "billing", "Engineer", "2024-10-21", None),
    ("Julia Kowalczyk", "billing", "Senior engineer", "2023-02-27", None),
    ("Ethan Brooks", "billing", "Engineer", "2025-06-02", None),
    ("Hana Kobayashi", "runtime", "Engineering lead", "2022-06-13", None),
    ("Sven Lindqvist", "runtime", "Staff engineer", "2022-09-05", None),
    ("Aiko Tanaka", "runtime", "Senior engineer", "2023-04-17", None),
    ("Leo Marchetti", "runtime", "Senior engineer", "2023-08-28", None),
    ("Dmitri Volkov", "runtime", "Engineer", "2024-03-18", None),
    ("Zara Ahmed", "runtime", "Engineer", "2024-11-04", None),
    ("Ben Carter", "runtime", "Engineer", "2025-08-11", None),
    ("Mateo Ruiz", "signals", "Engineering lead", "2022-10-03", None),
    ("Grace Liu", "signals", "Senior engineer", "2023-01-16", None),
    ("Oliver Grant", "signals", "Engineer", "2024-01-22", None),
    ("Fatima Zahra", "signals", "Senior engineer", "2023-07-10", None),
    ("Kenji Mori", "signals", "Engineer", "2024-07-29", None),
    ("Elif Yilmaz", "signals", "Engineer", "2025-03-03", None),
    ("Chloe Dubois", "console", "Engineering lead", "2022-12-05", None),
    ("Sam Okoro", "console", "Senior engineer", "2023-03-20", None),
    ("Isabel Vega", "console", "Senior engineer", "2023-10-09", None),
    ("Liam O'Connor", "console", "Engineer", "2024-04-15", None),
    ("Anika Patel", "console", "Designer-engineer", "2024-08-26", None),
    ("Theo Laurent", "console", "Engineer", "2025-01-13", None),
    ("Maya Cohen", "console", "Engineer", "2025-09-08", None),
    ("Arjun Mehta", "data", "Engineering lead", "2022-07-11", None),
    ("Nadia Haddad", "data", "Senior engineer", "2023-05-22", None),
    ("Omar Farouk", "data", "Engineer", "2024-02-26", None),
    ("Marcus Bell", "data", "Senior engineer", "2021-09-13", "2026-07-15"),
    ("Sofia Rossi", "data", "Engineer", "2024-09-16", None),
    ("Wei Zhang", "data", "Senior engineer", "2023-12-04", None),
]
TEAM_MOVES = [("Lena Fischer", "signals", "platform", "2025-11-03")]

# name, team, tier, language, created, retired, what it does
SERVICES = [
    ("identity", "platform", 1, "Go", "2025-02-03", None, "OIDC sign-in, sessions and service tokens; replaces sso-legacy."),
    ("sso-legacy", "platform", 2, "Java", START, None, "The original SAML sign-on. Being retired since 2025."),
    ("edge-gateway", "platform", 1, "Go", START, None, "Every customer request enters here: TLS, routing, rate limits."),
    ("secrets-vault", "platform", 1, "Go", START, None, "Encrypted secrets and signing keys for every service."),
    ("flag-eval", "platform", 1, "Rust", "2024-08-05", None, "Evaluates customers' feature flags at the edge in under a millisecond."),
    ("billing-api", "billing", 1, "Kotlin", START, None, "Plans, subscriptions and the billing pages of the console."),
    ("usage-meter", "billing", 1, "Go", "2025-07-07", None, "Counts build minutes, flag evaluations and ingest volume for billing."),
    ("invoice-render", "billing", 2, "Python", START, None, "Renders and signs invoice PDFs."),
    ("ledger", "billing", 1, "Kotlin", START, None, "Double-entry ledger of every charge, credit and refund."),
    ("tax-engine", "billing", 3, "Python", "2025-03-10", None, "Sales tax and VAT rates by jurisdiction."),
    ("build-scheduler", "runtime", 1, "Go", START, None, "Queues customers' CI jobs and assigns them to runners."),
    ("runner-fleet", "runtime", 1, "Rust", START, None, "The fleet of build machines that run customers' jobs."),
    ("artifact-store", "runtime", 1, "Go", START, None, "Stores build outputs, caches and container layers."),
    ("cache-proxy", "runtime", 2, "Go", START, None, "Read-through cache in front of artifact-store."),
    ("log-ingest", "signals", 1, "Rust", START, None, "Accepts customers' logs at up to 2 GB/s."),
    ("metrics-tsdb", "signals", 1, "Go", START, None, "Time-series store behind every dashboard."),
    ("alert-router", "signals", 1, "Go", START, None, "Evaluates alert rules and pages the right people."),
    ("trace-collector", "signals", 2, "Go", "2025-05-12", None, "OpenTelemetry trace intake."),
    ("web-console", "console", 1, "TypeScript", START, None, "The app customers use every day."),
    ("onboarding", "console", 2, "TypeScript", START, None, "Sign-up, trials and the first-build walkthrough."),
    ("docs-site", "console", 3, "TypeScript", START, None, "Public documentation."),
    ("notify-mailer", "console", 2, "Python", START, None, "Transactional email: receipts, alerts, invitations."),
    ("event-bus", "data", 1, "Java", START, "2026-05-12", "Kafka cluster that carried every event until May 2026."),
    ("stream-hub", "data", 1, "Go", "2026-02-02", None, "NATS JetStream event backbone; took over from event-bus."),
    ("warehouse", "data", 2, "Python", START, None, "Analytics warehouse fed from the event stream."),
    ("reports-legacy", "data", 3, "Python", START, None, "Nightly CSV reports some enterprise customers still download."),
]

# what people call things in chat
NICKNAMES = {
    "sso-legacy": ["old sso", "legacy sso", "saml"], "identity": ["oidc", "new sso", "idp"],
    "event-bus": ["kafka"], "stream-hub": ["nats", "jetstream"], "invoice-render": ["invoices", "invoice pdfs"],
    "metrics-tsdb": ["tsdb"], "alert-router": ["alerting", "pager"], "web-console": ["the console", "dashboard"],
    "runner-fleet": ["runners"], "artifact-store": ["artifacts"], "edge-gateway": ["gateway", "the edge"],
    "secrets-vault": ["vault", "secrets"], "flag-eval": ["feature flags"], "reports-legacy": ["nightly reports",
                                                                                            "csv reports"],
}

BUS_SWITCH = "2026-05-12"  # event-bus -> stream-hub cut-over
GHOST_RECORDED = "2026-03-24T16:41"

# src, dst, kind, valid_from (None: when both exist), valid_to, recorded_at (None: same as valid_from)
DEPS: list[tuple] = [
    ("web-console", "edge-gateway", "sync"), ("web-console", "identity", "sync"),
    ("web-console", "billing-api", "sync"), ("web-console", "build-scheduler", "sync"),
    ("web-console", "metrics-tsdb", "sync"), ("web-console", "flag-eval", "sync"),
    ("edge-gateway", "identity", "sync"), ("edge-gateway", "flag-eval", "sync"),
    ("onboarding", "identity", "sync"), ("onboarding", "billing-api", "sync"),
    ("onboarding", "notify-mailer", "async"), ("docs-site", "edge-gateway", "sync"),
    ("billing-api", "usage-meter", "sync"), ("billing-api", "ledger", "sync"),
    ("billing-api", "invoice-render", "async"), ("billing-api", "tax-engine", "sync"),
    ("billing-api", "identity", "sync"), ("invoice-render", "ledger", "data"),
    ("ledger", "secrets-vault", "sync"), ("reports-legacy", "sso-legacy", "sync"),
    ("reports-legacy", "warehouse", "data"), ("sso-legacy", "secrets-vault", "sync"),
    ("identity", "secrets-vault", "sync"), ("build-scheduler", "runner-fleet", "sync"),
    ("build-scheduler", "artifact-store", "sync"), ("build-scheduler", "identity", "sync"),
    ("runner-fleet", "artifact-store", "sync"), ("runner-fleet", "cache-proxy", "sync"),
    ("runner-fleet", "secrets-vault", "sync"), ("cache-proxy", "artifact-store", "sync"),
    ("alert-router", "metrics-tsdb", "sync"), ("alert-router", "notify-mailer", "async"),
    ("alert-router", "identity", "sync"), ("stream-hub", "secrets-vault", "sync"),
    ("event-bus", "secrets-vault", "sync"),
    # before identity existed, everything signed in through sso-legacy
    ("web-console", "sso-legacy", "sync", START, "2025-06-30"), ("edge-gateway", "sso-legacy", "sync", START, "2025-06-30"),
    ("onboarding", "sso-legacy", "sync", START, "2025-09-15"), ("billing-api", "sso-legacy", "sync", START, "2025-08-04"),
    ("build-scheduler", "sso-legacy", "sync", START, "2025-07-21"), ("alert-router", "sso-legacy", "sync", START, "2025-10-06"),
    # the ghost: true since mid-2024, written down only after INC-311
    ("invoice-render", "sso-legacy", "sync", "2024-06-10", None, GHOST_RECORDED),
]
# everything that publishes or consumes events moved from event-bus to stream-hub on BUS_SWITCH
BUS_USERS = [("notify-mailer", "async"), ("usage-meter", "async"), ("flag-eval", "async"), ("build-scheduler", "async"),
             ("log-ingest", "async"), ("metrics-tsdb", "async"), ("trace-collector", "async"), ("warehouse", "data")]

# name, tier, industry, since, plans
CUSTOMERS = [
    ("Helio Robotics", "enterprise", "Robotics", "2024-03-11", ["ci", "observability", "invoices"]),
    ("Pinecrest Bank", "enterprise", "Banking", "2024-06-03", ["ci", "flags", "invoices", "reports"]),
    ("Mosaic Health", "enterprise", "Healthcare software", "2025-01-20", ["ci", "observability", "reports"]),
    ("Northgate Retail", "enterprise", "Retail", "2024-09-09", ["ci", "flags", "invoices"]),
    ("Vireo Mobility", "enterprise", "Mobility", "2025-04-14", ["ci", "observability", "flags", "invoices"]),
    ("Quillsoft", "growth", "Developer tools", "2024-02-05", ["ci", "flags"]),
    ("Brightline Games", "growth", "Games", "2024-07-22", ["ci", "observability"]),
    ("Fernway", "growth", "Travel", "2024-11-18", ["ci", "invoices"]),
    ("Sable Analytics", "growth", "Analytics", "2025-02-24", ["ci", "observability", "reports"]),
    ("Tandem Logistics", "growth", "Logistics", "2025-05-05", ["ci", "flags"]),
    ("Copperleaf Energy", "growth", "Energy", "2025-08-18", ["ci", "observability"]),
    ("Glasswing Security", "growth", "Security", "2025-10-27", ["ci", "flags", "observability"]),
    ("Kiln Studio", "starter", "Design", "2025-03-31", ["ci"]),
    ("Juniper Learning", "starter", "Education", "2025-06-16", ["ci", "flags"]),
    ("Larkspur Media", "starter", "Media", "2025-12-01", ["ci"]),
    ("Otterly", "starter", "Consumer apps", "2026-02-09", ["ci", "observability"]),
]
PLAN_SERVICES = {
    "ci": ["web-console", "build-scheduler", "runner-fleet", "artifact-store"],
    "observability": ["log-ingest", "metrics-tsdb", "alert-router"],
    "flags": ["flag-eval"],
    "invoices": ["invoice-render"],
    "reports": ["reports-legacy"],
}

# name, status, started, ended, members, services
PROJECTS = [
    ("Identity Migration", "active", "2025-01-13", None,
     ["Priya Raman", "Yusuf Demir", "Kofi Mensah", "Mei Lin", "Tomasz Nowak"], ["identity", "sso-legacy", "invoice-render"]),
    ("Usage Billing", "done", "2025-05-05", "2025-12-19",
     ["Daniel Osei", "Julia Kowalczyk", "Amara Nwosu", "Ethan Brooks"], ["usage-meter", "billing-api", "ledger"]),
    ("Stream Hub Migration", "done", "2025-11-17", "2026-06-12",
     ["Arjun Mehta", "Wei Zhang", "Sofia Rossi", "Rafael Costa"], ["stream-hub", "event-bus", "warehouse"]),
    ("Build Insights", "active", "2026-06-01", None,
     ["Sven Lindqvist", "Aiko Tanaka", "Nadia Haddad", "Omar Farouk", "Grace Liu"], ["artifact-store", "warehouse", "trace-collector"]),
    ("Console Redesign", "active", "2026-02-09", None,
     ["Chloe Dubois", "Anika Patel", "Isabel Vega", "Theo Laurent"], ["web-console", "onboarding"]),
    ("Invoice Tax Fields", "blocked", "2026-08-03", None,
     ["Tomasz Nowak", "Felipe Ortega"], ["invoice-render", "tax-engine"]),
    ("Alerting v2", "active", "2026-03-02", None,
     ["Lena Fischer", "Kofi Mensah", "Rafael Costa"], ["alert-router", "notify-mailer"]),
    ("Runner NVMe Cache", "done", "2026-03-16", "2026-08-21",
     ["Leo Marchetti", "Dmitri Volkov"], ["runner-fleet", "cache-proxy"]),
]

# What a change to each service is usually about; titles are "<service>: <verb> <object>".
WORK = {
    "identity": ["session refresh", "OIDC discovery", "service token scopes", "MFA enrolment", "SCIM sync", "token signing keys"],
    "sso-legacy": ["SAML assertion parsing", "session cookie domain", "IdP metadata refresh", "login audit log"],
    "edge-gateway": ["rate limiter", "TLS cipher list", "route table reload", "request id propagation", "HTTP/3 listener"],
    "secrets-vault": ["key rotation", "audit trail", "lease renewal", "seal/unseal runbook hooks"],
    "flag-eval": ["rule compiler", "segment matching", "SDK snapshot format", "percentage rollouts"],
    "billing-api": ["plan change flow", "proration", "subscription webhooks", "seat counting", "trial expiry"],
    "usage-meter": ["build-minute aggregation", "late event handling", "per-org counters", "usage export"],
    "invoice-render": ["PDF layout", "currency formatting", "signing step", "credit note template", "batch rendering"],
    "ledger": ["journal idempotency", "reconciliation job", "refund postings", "balance snapshots", "FX rounding"],
    "tax-engine": ["VAT rates", "US nexus rules", "tax-exempt customers", "rate cache"],
    "build-scheduler": ["queue fairness", "job priorities", "retry policy", "concurrency limits", "matrix builds"],
    "runner-fleet": ["autoscaler", "VM image", "job isolation", "spot instance handling", "warm pool"],
    "artifact-store": ["layer dedup", "retention policy", "upload resumption", "signed URLs", "storage tiering"],
    "cache-proxy": ["eviction policy", "cache key hashing", "hit-rate metrics", "stale-while-revalidate"],
    "log-ingest": ["backpressure", "parser pipeline", "tenant quotas", "compression"],
    "metrics-tsdb": ["downsampling", "query planner", "label cardinality limits", "compaction"],
    "alert-router": ["rule evaluation", "dedup window", "escalation policies", "silences", "on-call schedule sync"],
    "trace-collector": ["span sampling", "OTLP receiver", "trace retention"],
    "web-console": ["build log viewer", "settings pages", "dashboard grid", "navigation", "flag editor", "billing page"],
    "onboarding": ["trial sign-up", "first-build walkthrough", "repo connect step", "team invites"],
    "docs-site": ["search", "API reference", "versioned docs", "code samples"],
    "notify-mailer": ["receipt template", "bounce handling", "alert digests", "invitation mail"],
    "event-bus": ["partition rebalancing", "consumer lag alerts", "topic retention", "broker upgrade"],
    "stream-hub": ["JetStream consumers", "subject mapping", "replay tooling", "cluster sizing"],
    "warehouse": ["dbt models", "ingest jobs", "partitioning", "cost dashboards"],
    "reports-legacy": ["nightly CSV export", "report scheduler", "column mapping", "SFTP delivery"],
}
VERBS = ["fix", "rework", "speed up", "add tests for", "harden", "clean up", "add metrics to", "document",
         "refactor", "handle edge cases in", "simplify", "migrate"]


@dataclass
class World:
    tenant: str = TENANT
    company: str = COMPANY
    clock: str = CLOCK
    teams: list[dict] = field(default_factory=list)
    people: list[dict] = field(default_factory=list)
    services: list[dict] = field(default_factory=list)
    customers: list[dict] = field(default_factory=list)
    projects: list[dict] = field(default_factory=list)
    members: list[dict] = field(default_factory=list)
    owns: list[dict] = field(default_factory=list)
    deps: list[dict] = field(default_factory=list)
    uses: list[dict] = field(default_factory=list)
    worked_on: list[dict] = field(default_factory=list)
    project_uses: list[dict] = field(default_factory=list)
    changes: list[dict] = field(default_factory=list)
    tickets: list[dict] = field(default_factory=list)
    decisions: list[dict] = field(default_factory=list)
    messages: list[dict] = field(default_factory=list)
    docs: list[dict] = field(default_factory=list)
    contradictions: list[dict] = field(default_factory=list)


def slug(name: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-").replace("--", "-")


def pid(name: str) -> str:
    return "person:" + slug(name)


def sid(name: str) -> str:
    return "svc:" + name


def day_index(iso: str) -> int:
    """Days since START: what decay and windows are computed on."""
    return (date.fromisoformat(iso[:10]) - date.fromisoformat(START)).days


def _d(iso: str) -> date:
    return date.fromisoformat(iso[:10])


_LEDGER_REVIEWS: dict[str, int] = {}
_HIDDEN = {pid(n) for n in ("Sven Lindqvist", "Aiko Tanaka", "Nadia Haddad", "Omar Farouk", "Grace Liu")}
_MAINTAINERS: dict[str, list[str]] = {}


def build() -> World:
    rng = random.Random(SEED)
    _LEDGER_REVIEWS.clear()
    _MAINTAINERS.clear()
    for name, team, *_ in SERVICES:
        crew = [pid(p[0]) for p in PEOPLE if p[1] == team and "lead" not in p[2]]
        _MAINTAINERS[sid(name)] = rng.sample(crew, k=3)
    w = World()

    # ---------------------------------------------------------------- org
    for uid, name, mission in TEAMS:
        w.teams.append({"uid": "team:" + uid, "name": name, "mission": mission, "created": START})
    for name, team, role, joined, left in PEOPLE:
        first = name.split()[0]
        w.people.append({"uid": pid(name), "name": name, "first": first, "handle": "@" + slug(first),
                         "role": role, "joined": joined, "left": left or OPEN, "home": "team:" + team})
    moved = {n: (a, b, at) for n, a, b, at in TEAM_MOVES}
    for p in w.people:
        start = max(p["joined"], START)
        if p["name"] in moved:
            a, b, at = moved[p["name"]]
            w.members.append(_fact("mem", p["uid"], "team:" + a, start, at, "doc:hris"))
            w.members.append(_fact("mem", p["uid"], "team:" + b, at, p["left"], "doc:hris"))
            p["home"] = "team:" + b
        else:
            w.members.append(_fact("mem", p["uid"], p["home"], start, p["left"], "doc:hris"))

    for name, team, tier, lang, created, retired, what in SERVICES:
        w.services.append({"uid": sid(name), "name": name, "tier": tier, "lang": lang, "created": created,
                           "retired": retired or OPEN, "summary": what, "team": "team:" + team})
        w.owns.append(_fact("own", "team:" + team, sid(name), created, retired or OPEN, "doc:service-catalog")
                      | {"declared": True})

    svc = {s["name"]: s for s in w.services}
    for row in DEPS:
        src, dst, kind = row[:3]
        vf = row[3] if len(row) > 3 and row[3] else max(svc[src]["created"], svc[dst]["created"])
        vt = row[4] if len(row) > 4 and row[4] else min(svc[src]["retired"], svc[dst]["retired"])
        rec = row[5] if len(row) > 5 and row[5] else vf
        source = "msg:billing-ghost" if rec == GHOST_RECORDED else "doc:service-catalog"
        w.deps.append(_fact("dep", sid(src), sid(dst), vf, vt, source, recorded=rec) | {"kind": kind})
    for user, kind in BUS_USERS:
        created = svc[user]["created"]
        if created < BUS_SWITCH:
            w.deps.append(_fact("dep", sid(user), sid("event-bus"), created, BUS_SWITCH, "doc:service-catalog")
                          | {"kind": kind})
        w.deps.append(_fact("dep", sid(user), sid("stream-hub"), max(BUS_SWITCH, created), OPEN, "doc:stream-hub-plan")
                      | {"kind": kind})

    for name, tier, industry, since, plans in CUSTOMERS:
        cu = {"uid": "cust:" + slug(name), "name": name, "tier": tier, "industry": industry, "since": since,
              "plans": plans}
        w.customers.append(cu)
        for plan in plans:
            for s in PLAN_SERVICES[plan]:
                w.uses.append({"uid": f"use:{slug(name)}:{s}", "customer": cu["uid"], "service": sid(s),
                               "valid_from": max(since, svc[s]["created"]), "valid_to": OPEN})

    for name, status, started, ended, members, services in PROJECTS:
        pr = {"uid": "proj:" + slug(name), "name": name, "status": status, "started": started, "ended": ended or OPEN}
        w.projects.append(pr)
        for m in members:
            w.worked_on.append(_fact("wo", pid(m), pr["uid"], started, ended or OPEN, "doc:project-tracker"))
        for s in services:
            w.project_uses.append({"uid": f"pu:{slug(name)}:{s}", "project": pr["uid"], "service": sid(s)})

    # ---------------------------------------------------------------- history
    w.changes = _changes(rng, w)
    w.tickets = _tickets(rng, w)
    w.decisions = story.decisions()
    w.messages = story.messages(w) + _chatter(rng, w)
    w.messages.sort(key=lambda m: m["at"])
    w.docs = story.docs(w)
    w.contradictions = story.contradictions()
    return w


def _fact(kind: str, a: str, b: str, vf: str, vt: str, source: str, recorded: str | None = None) -> dict:
    return {"uid": f"{kind}:{a.split(':', 1)[1]}->{b.split(':', 1)[1]}@{vf[:10]}", "a": a, "b": b,
            "valid_from": vf, "valid_to": vt, "recorded_at": recorded or vf, "source": source}


def _active(w: World, team: str, on: str) -> list[str]:
    """People who were members of a team on a date."""
    return [m["a"] for m in w.members if m["b"] == team and m["valid_from"] <= on < m["valid_to"]]


def _changes(rng: random.Random, w: World) -> list[dict]:
    by_name = {p["uid"]: p for p in w.people}
    out: list[dict] = []
    n = 0
    weight = {1: 2.0, 2: 1.5, 3: 1.0}
    month = _d(START)
    end = _d(CLOCK)
    while month < end:
        nxt = (month.replace(day=28) + timedelta(days=4)).replace(day=1)
        for s in w.services:
            if not (s["created"] <= month.isoformat() < s["retired"]):
                continue
            count = max(0, int(rng.gauss(weight[s["tier"]], 1.0)))
            for _ in range(count):
                at = month + timedelta(days=rng.randrange((nxt - month).days))
                if at >= end:
                    continue
                on = at.isoformat()
                author, reviewers = _who(rng, w, s, on)
                if not author:
                    continue
                n += 1
                title = f"{s['name']}: {rng.choice(VERBS)} {rng.choice(WORK[s['name']])}"
                out.append({"uid": f"chg:{n}", "key": f"#{2100 + n}", "title": title, "author": author,
                            "reviewers": reviewers, "services": [s["uid"]], "at": on + "T" + _hm(rng)})
        month = nxt
    out += _hidden_team_changes(rng, w, len(out))
    out.sort(key=lambda c: c["at"])
    for c in out:
        assert c["author"] in by_name
    return out


def _who(rng: random.Random, w: World, s: dict, on: str) -> tuple[str | None, list[str]]:
    """Author and reviewers for a change to service s on a date, with the planted storylines applied."""
    owners = _active(w, s["team"], on)
    name = s["name"]
    if name == "ledger" and on >= "2026-03-15":
        # only Ines has touched the ledger since spring; each reviewer appears at most twice (below the KNOWS bar)
        others = [p for p in _active(w, "team:billing", on)
                  if p != pid("Ines Okafor") and _LEDGER_REVIEWS.get(p, 0) < 2]
        if not others or rng.random() < 0.5:
            return pid("Ines Okafor"), []
        r = rng.choice(others)
        _LEDGER_REVIEWS[r] = _LEDGER_REVIEWS.get(r, 0) + 1
        return pid("Ines Okafor"), [r]
    if name == "alert-router" and on >= "2026-03-01":
        crew = [pid("Lena Fischer"), pid("Kofi Mensah"), pid("Rafael Costa")]
        a = rng.choice(crew)
        return a, [rng.choice([c for c in crew if c != a])]
    if name == "reports-legacy":
        if on < "2026-07-15":
            return pid("Marcus Bell"), [rng.choice([p for p in owners if p != pid("Marcus Bell")])] if rng.random() < 0.3 else []
        return None, []
    if name == "sso-legacy" and on >= "2025-06-01":
        crew = [pid("Yusuf Demir"), pid("Kofi Mensah")]
        a = rng.choice(crew)
        return a, [c for c in crew if c != a]
    # since June the Build Insights five spend most of their time on it, and little on their home teams' services
    if on >= "2026-06-01":
        side = random.Random(f"{on}|{s['uid']}")  # its own stream: the rest of the history doesn't shift
        busy = [p for p in owners if p in _HIDDEN and side.random() < 0.85]
        owners = [p for p in owners if p not in busy]
    if not owners:
        return None, []
    # most of a service's changes come from the two or three people who look after it
    regulars = [p for p in _MAINTAINERS[s["uid"]] if p in owners]
    a = rng.choice(regulars) if regulars and rng.random() < 0.7 else rng.choice(owners)
    pool = [p for p in regulars if p != a] if rng.random() < 0.6 else [p for p in owners if p != a]
    pool = pool or [p for p in owners if p != a]
    reviewers = rng.sample(pool, k=min(len(pool), 1 + (rng.random() < 0.35)))
    return a, reviewers


def _hidden_team_changes(rng: random.Random, w: World, offset: int) -> list[dict]:
    """Build Insights: five people from three teams reviewing each other's work across team lines."""
    crew = [pid(n) for n in ("Sven Lindqvist", "Aiko Tanaka", "Nadia Haddad", "Omar Farouk", "Grace Liu")]
    targets = [sid("artifact-store"), sid("warehouse"), sid("trace-collector")]
    topics = ["build timing export", "artifact lineage table", "trace-to-build linking", "flaky test detector",
              "queue wait histogram", "cache hit attribution", "cost per pipeline model"]
    out = []
    day = _d("2026-06-01")
    i = 0
    while day < _d(CLOCK):
        i += 1
        a = rng.choice(crew)
        reviewers = rng.sample([c for c in crew if c != a], k=2)
        out.append({"uid": f"chg:{offset + 1000 + i}", "key": f"#{4100 + i}",
                    "title": f"build-insights: {rng.choice(VERBS)} {rng.choice(topics)}", "author": a,
                    "reviewers": reviewers, "services": [rng.choice(targets)], "at": day.isoformat() + "T" + _hm(rng)})
        day += timedelta(days=rng.choice([3, 4, 5]))
    return out


def _hm(rng: random.Random) -> str:
    return f"{rng.randrange(8, 19):02d}:{rng.randrange(60):02d}"


TICKET_TITLES = {
    "support": ["{svc} is slow for our org since this morning", "Question about {svc} limits", "{svc} returns 502 intermittently",
                "Can't find {svc} settings after the update", "Unexpected behaviour in {svc}"],
    "bug": ["{svc}: crash on malformed input", "{svc}: wrong totals after retry", "{svc}: memory grows without bound",
            "{svc}: timezone off by one", "{svc}: race between two writers"],
    "task": ["{svc}: upgrade dependencies", "{svc}: add dashboards", "{svc}: write the runbook", "{svc}: load test before peak"],
}


def _tickets(rng: random.Random, w: World) -> list[dict]:
    out = list(story.tickets())
    prefix = {"platform": "PLT", "billing": "BILL", "runtime": "RUN", "signals": "SIG", "console": "CON", "data": "DAT"}
    counters: dict[str, int] = {}
    alive = [s for s in w.services]
    for i in range(96):
        s = rng.choice(alive)
        opened = _d(START) + timedelta(days=rng.randrange(day_index(CLOCK)))
        o = opened.isoformat()
        if not (s["created"] <= o < s["retired"]):
            continue
        kind = rng.choices(["support", "bug", "task"], weights=[4, 3, 2])[0]
        team = s["team"].split(":")[1]
        if kind == "support":
            customers = [c for c in w.customers if c["since"] <= o and
                         any(s["name"] in PLAN_SERVICES[p] for p in c["plans"])]
            if not customers:
                continue
            cust = rng.choice(customers)["uid"]
            key = f"SUP-{900 + i}"
        else:
            cust = None
            counters[team] = counters.get(team, 0) + 1
            key = f"{prefix[team]}-{counters[team] + 10}"
        closed = opened + timedelta(days=rng.randrange(1, 40))
        status = "done" if closed < _d(CLOCK) and rng.random() < 0.85 else "open"
        assignee = rng.choice(_active(w, s["team"], o) or [None])
        out.append({"uid": "tkt:" + key.lower(), "key": key, "kind": kind,
                    "title": rng.choice(TICKET_TITLES[kind]).format(svc=s["name"]),
                    "priority": rng.choice(["P2", "P3", "P3", "P4"]), "status": status, "opened": o,
                    "closed": closed.isoformat() if status == "done" else OPEN, "services": [s["uid"]],
                    "customers": [cust] if cust else [], "assignee": assignee, "blocks": []})
    return out


CHATTER = [
    "shipped {chg} ({title}). watch {svc} dashboards for the next hour pls",
    "anyone else seeing p99 creep on {svc}? started around lunch",
    "review please: {chg}, small one, {svc}",
    "{svc} deploy is green, thanks {rev} for the quick review",
    "heads up: {svc} gets a config change at 15:00, no downtime expected",
    "post-merge: {chg} touched {svc}, rolled out to 10% first",
    "who's the best person to ask about {svc} internals?",
    "{rev} and I paired on {svc} today, notes in the ticket",
]


def _chatter(rng: random.Random, w: World) -> list[dict]:
    """Day-to-day messages that reference real changes, so the corpus has the texture of a real workspace."""
    names = {p["uid"]: p["name"] for p in w.people}
    first = {p["uid"]: p["first"] for p in w.people}
    out = []
    sample = rng.sample(w.changes, k=min(110, len(w.changes)))
    for i, c in enumerate(sorted(sample, key=lambda c: c["at"])):
        s = next(x for x in w.services if x["uid"] == c["services"][0])
        rev = first[c["reviewers"][0]] if c["reviewers"] else "the team"
        text = rng.choice(CHATTER).format(chg=c["key"], title=c["title"].split(": ", 1)[1], svc=s["name"], rev=rev)
        out.append({"uid": f"msg:c{i}", "channel": "#" + s["team"].split(":")[1], "author": c["author"],
                    "at": c["at"], "text": text, "refs": [c["uid"]]})
    assert names
    return out
