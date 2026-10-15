"""The hand-written part of Corvane: decisions, the messages and documents the storylines live in, and the
tickets that connect customers to them. Generated history (pull requests, chatter, routine tickets) is in
corvane.py."""

from __future__ import annotations


def _p(name: str) -> str:
    return "person:" + "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-").replace("--", "-")


def _s(name: str) -> str:
    return "svc:" + name


def _c(name: str) -> str:
    return "cust:" + "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")


def decisions() -> list[dict]:
    rows = [
        ("ADR-001", "2024-02-12", "Kafka (event-bus) is the company's event backbone", "superseded", "data",
         ["Arjun Mehta", "Marcus Bell"], ["event-bus"], [], None,
         "One durable log for every event; services publish, the warehouse and billing consume."),
        ("ADR-002", "2024-04-08", "Every service signs users in through sso-legacy", "superseded", "platform",
         ["Yusuf Demir"], ["sso-legacy"], [], None,
         "One sign-on for the console, the API and internal tools."),
        ("ADR-003", "2024-07-15", "Store each build artifact once, content-addressed", "accepted", "runtime",
         ["Sven Lindqvist"], ["artifact-store"], [], None,
         "Identical layers across customers are stored once; retention works on references."),
        ("ADR-004", "2024-10-01", "Evaluate feature flags at the edge", "accepted", "platform",
         ["Priya Raman", "Yusuf Demir"], ["flag-eval", "edge-gateway"], [], None,
         "Flag rules compile to a snapshot every edge node holds in memory."),
        ("ADR-005", "2025-01-13", "Build identity (OIDC) and retire sso-legacy", "accepted", "platform",
         ["Priya Raman", "Yusuf Demir", "Kofi Mensah"], ["identity", "sso-legacy"], ["doc:runbook-sso-legacy"],
         ("ADR-002", "supersedes"), "SAML-only sign-on blocks SCIM and service tokens. identity takes over."),
        ("ADR-006", "2025-05-05", "Bill on usage, metered by usage-meter", "accepted", "billing",
         ["Daniel Osei", "Julia Kowalczyk"], ["usage-meter", "billing-api", "ledger"], [], None,
         "Build minutes, flag evaluations and ingest volume become line items."),
        ("ADR-007", "2025-09-08", "Put a read-through cache in front of artifact-store", "superseded", "runtime",
         ["Hana Kobayashi", "Leo Marchetti"], ["cache-proxy", "artifact-store"], [], None,
         "Runners pull the same layers thousands of times an hour."),
        ("ADR-008", "2025-11-17", "Move the event backbone from Kafka to NATS JetStream (stream-hub)", "accepted", "data",
         ["Arjun Mehta", "Wei Zhang"], ["event-bus", "stream-hub"], ["doc:stream-hub-plan"], ("ADR-001", "supersedes"),
         "Partition rebalances stalled the build queue twice. JetStream is simpler to run at our size."),
        ("ADR-009", "2026-01-19", "Signals owns alerting end to end", "accepted", "signals",
         ["Mateo Ruiz"], ["alert-router"], ["doc:wiki-alerting"], None,
         "Rules, routing and paging stay with the team that owns the metrics."),
        ("ADR-010", "2026-02-23", "Ledger writes are append-only", "accepted", "billing",
         ["Ines Okafor", "Daniel Osei"], ["ledger"], ["doc:runbook-ledger"], None,
         "Corrections are new postings, never updates. Reconciliation depends on it."),
        ("ADR-011", "2026-03-03", "Retire sso-legacy on 2026-03-17", "reversed", "platform",
         ["Priya Raman", "Yusuf Demir"], ["sso-legacy"], ["msg:adr011"], None,
         "Every consumer in the service catalog has moved to identity."),
        ("ADR-012", "2026-03-10", "runner-fleet caches on local NVMe; decommission cache-proxy", "accepted", "runtime",
         ["Hana Kobayashi", "Leo Marchetti"], ["runner-fleet", "cache-proxy"], ["msg:adr012"], ("ADR-007", "supersedes"),
         "NVMe on every runner makes the shared cache a cost without a benefit."),
        ("ADR-013", "2026-03-26", "Keep sso-legacy until invoice-render migrates (BILL-207)", "accepted", "platform",
         ["Priya Raman", "Daniel Osei"], ["sso-legacy", "invoice-render"], ["msg:billing-ghost", "doc:postmortem-inc-311"],
         ("ADR-011", "reverses"),
         "Retiring sso-legacy took down invoice rendering (INC-311): invoice-render calls it for its signing token."),
    ]
    # the successors a decision names outright: what the planner may move a dependent onto without further proof
    successors = {"ADR-005": [("identity", "sso-legacy")], "ADR-008": [("stream-hub", "event-bus")]}
    out = []
    for key, at, title, status, team, by, affects, evidence, sup, summary in rows:
        out.append({"uid": "dec:" + key.lower(), "key": key, "title": title, "status": status, "at": at,
                    "team": "team:" + team, "decided_by": [_p(n) for n in by], "affects": [_s(s) for s in affects],
                    "evidence": evidence, "supersedes": ("dec:" + sup[0].lower(), sup[1]) if sup else None,
                    "summary": summary, "replaces": [(_s(a), _s(b)) for a, b in successors.get(key, [])]})
    return out


def tickets() -> list[dict]:
    T = []

    def t(key, kind, title, priority, status, opened, closed, services, customers=(), assignee=None, blocks=()):
        T.append({"uid": "tkt:" + key.lower(), "key": key, "kind": kind, "title": title, "priority": priority,
                  "status": status, "opened": opened, "closed": closed, "services": [_s(s) for s in services],
                  "customers": [_c(c) for c in customers], "assignee": _p(assignee) if assignee else None,
                  "blocks": ["tkt:" + b.lower() for b in blocks]})

    t("INC-311", "incident", "Invoice PDFs fail to render for every customer", "P1", "done", "2026-03-18T06:24",
      "2026-03-18T11:52", ["invoice-render", "sso-legacy"],
      ["Helio Robotics", "Pinecrest Bank", "Northgate Retail", "Fernway"], "Rafael Costa")
    t("INC-301", "incident", "Build queue stalls during an event-bus partition rebalance", "P2", "done",
      "2026-02-17T14:02", "2026-02-17T16:40", ["event-bus", "build-scheduler"], ["Quillsoft", "Vireo Mobility"],
      "Wei Zhang")
    t("INC-288", "incident", "Alert pages delayed by twenty minutes", "P2", "done", "2025-12-02T21:15",
      "2025-12-03T00:05", ["alert-router", "notify-mailer"], ["Brightline Games", "Mosaic Health"], "Lena Fischer")
    t("IDN-58", "task", "identity: signing-token endpoint for internal services", "P2", "open", "2026-04-02T10:20",
      "9999-12-31", ["identity"], assignee="Mei Lin", blocks=["BILL-207"])
    t("BILL-207", "task", "invoice-render: fetch the PDF signing token from identity, not sso-legacy", "P2", "open",
      "2026-03-25T09:10", "9999-12-31", ["invoice-render", "identity"], assignee="Tomasz Nowak", blocks=["SUP-1042"])
    t("SUP-1042", "support", "Invoices need the new EU tax breakdown fields", "P2", "open", "2026-08-12T15:33",
      "9999-12-31", ["invoice-render", "tax-engine"], ["Helio Robotics"], "Felipe Ortega")
    t("SUP-1077", "support", "Nightly CSV report arrived empty", "P3", "open", "2026-08-30T07:48", "9999-12-31",
      ["reports-legacy"], ["Pinecrest Bank"], "Sofia Rossi")
    t("RUN-77", "task", "Decide whether runner-fleet still needs cache-proxy", "P3", "open", "2026-09-09T11:00",
      "9999-12-31", ["runner-fleet", "cache-proxy"], assignee="Leo Marchetti")
    return T


def messages(w) -> list[dict]:
    rows = [
        ("msg:stream-up", "#data", "Arjun Mehta", "2026-02-02T10:05",
         "stream-hub cluster is up in prod. Start dual-publishing to event-bus and stream-hub this week."),
        ("msg:adr011", "#platform", "Priya Raman", "2026-03-03T11:30",
         "ADR-011 approved: sso-legacy goes dark on March 17. Every consumer in the service catalog has moved to identity."),
        ("msg:lena-alerts", "#signals", "Lena Fischer", "2026-03-04T09:12",
         "Kofi and I are taking alert-router's rule engine for Alerting v2. Mateo's fine with Platform driving it for now."),
        ("msg:adr012", "#runtime", "Hana Kobayashi", "2026-03-10T16:20",
         "ADR-012: runner-fleet moves to local NVMe caching. cache-proxy can be decommissioned once that's rolled out."),
        ("msg:sso-off", "#platform", "Yusuf Demir", "2026-03-17T18:02",
         "sso-legacy is off. Keeping the VM image around for a couple of weeks just in case."),
        ("msg:inc311-1", "#incidents", "Rafael Costa", "2026-03-18T06:31",
         "INC-311: invoice PDFs failing for all customers since about 06:10. invoice-render returns 401 at the signing step."),
        ("msg:inc311-2", "#incidents", "Daniel Osei", "2026-03-18T08:47",
         "Helio Robotics and Pinecrest Bank have both escalated. Northgate's finance team can't close their month."),
        ("msg:inc311-3", "#incidents", "Yusuf Demir", "2026-03-18T11:55",
         "Turned sso-legacy back on at 11:52 and invoices render again. We still don't know why invoice-render cared."),
        ("msg:billing-ghost", "#billing", "Tomasz Nowak", "2026-03-24T16:41",
         "Found it. invoice-render still fetches its PDF signing token from sso-legacy, a call from 2024 that never "
         "made it into the service catalog. That's why every invoice failed when sso-legacy went dark. Opening "
         "BILL-207 to move it to identity."),
        ("msg:adr013", "#platform", "Priya Raman", "2026-03-26T10:00",
         "ADR-013: sso-legacy stays up until BILL-207 lands. This reverses ADR-011."),
        ("msg:idn58", "#billing", "Tomasz Nowak", "2026-04-02T10:25",
         "BILL-207 needs a signing-token endpoint in identity first. Filed IDN-58 for Platform."),
        ("msg:bus-retired", "#data", "Wei Zhang", "2026-05-12T17:40",
         "event-bus is officially retired. Every producer and consumer is on stream-hub now. Thanks to everyone who migrated."),
        ("msg:bi-kickoff", "#general", "Sven Lindqvist", "2026-06-03T12:15",
         "Kicked off Build Insights with Aiko, Nadia, Omar and Grace. We want build timings sitting next to traces "
         "and warehouse costs."),
        ("msg:marcus-last", "#data", "Arjun Mehta", "2026-07-15T17:00",
         "Last day for Marcus today. Warehouse jobs are handed over; the reports-legacy notes are in the wiki."),
        ("msg:reports-q", "#data", "Sofia Rossi", "2026-07-16T10:42",
         "Honest question: does anyone actually understand the reports-legacy scheduler? The wiki page is from 2024."),
        ("msg:leo-cache", "#runtime", "Leo Marchetti", "2026-08-22T14:05",
         "runner-fleet stopped going through cache-proxy in August. The NVMe cache handles everything now."),
        ("msg:pinecrest-csv", "#data", "Sofia Rossi", "2026-08-30T08:10",
         "Pinecrest's nightly CSV came out empty (SUP-1077). Looking, but I've never touched reports-legacy."),
        ("msg:hana-cache", "#runtime", "Hana Kobayashi", "2026-09-09T10:48",
         "Careful: cache-proxy is still in the hot path for runner-fleet on the arm64 pools. I saw it in traces yesterday."),
        ("msg:mateo-alerts", "#general", "Mateo Ruiz", "2026-09-15T09:30",
         "Reminder: alerting questions go to Signals. We own alert-router."),
        ("msg:ines-rota", "#billing", "Ines Okafor", "2026-09-24T08:15",
         "Ledger reconciliation ran clean for the 40th night in a row. I'm still the only one on that rota though; a "
         "second pair of eyes would be great."),
        ("msg:helio-chase", "#billing", "Daniel Osei", "2026-09-28T15:20",
         "Helio Robotics asked about SUP-1042 again. Still blocked on BILL-207, which is waiting on IDN-58."),
        ("msg:idn58-review", "#platform", "Mei Lin", "2026-09-29T11:05",
         "IDN-58 is in review, should land early next week."),
    ]
    return [{"uid": uid, "channel": ch, "author": _p(a), "at": at, "text": text, "refs": []}
            for uid, ch, a, at, text in rows]


# The message the demo posts live: it changes a fact, and every answer that relied on it gets re-checked.
LIVE_MESSAGE = {"channel": "#billing", "author": "Tomasz Nowak",
                "text": "BILL-207 is merged: invoice-render now gets its signing token from identity. "
                        "It no longer calls sso-legacy at all."}


def docs(w) -> list[dict]:
    owners = {s["uid"]: s["team"] for s in w.services}
    team_name = {t["uid"]: t["name"] for t in w.teams}
    catalog_lines = []
    for s in w.services:
        if s["retired"] != "9999-12-31":
            continue
        deps = sorted(d["b"].split(":")[1] for d in w.deps
                      if d["a"] == s["uid"] and d["valid_to"] == "9999-12-31" and d["source"] == "doc:service-catalog"
                      or d["a"] == s["uid"] and d["valid_to"] == "9999-12-31" and d["source"] == "doc:stream-hub-plan")
        catalog_lines.append(f"{s['name']} (tier {s['tier']}, {team_name[owners[s['uid']]]}): depends on "
                             f"{', '.join(deps) if deps else 'nothing'}.")
    rows = [
        ("doc:service-catalog", "catalog", "Service catalog", "2026-09-01", "Priya Raman",
         "Owners and dependencies of every running service, maintained by Platform.\n" + "\n".join(catalog_lines)),
        ("doc:hris", "export", "People and teams export", "2026-09-30", "Priya Raman",
         "Team membership from the HR system, one row per person and team, with start and end dates."),
        ("doc:contracts", "export", "Customer contracts export", "2026-09-30", "Daniel Osei",
         "Which plans each customer is on (CI, observability, flags, invoices, reports) and since when."),
        ("doc:project-tracker", "export", "Project tracker export", "2026-09-30", "Chloe Dubois",
         "Projects, their members and the services they touch."),
        ("doc:stream-hub-plan", "plan", "Stream Hub migration plan", "2025-11-17", "Arjun Mehta",
         "Dual-publish from February, move consumers by team, cut event-bus on May 12. warehouse moves last because "
         "its backfill reads from the log."),
        ("doc:wiki-alerting", "wiki", "Alerting at Corvane", "2026-01-20", "Mateo Ruiz",
         "Signals owns alert-router end to end: rule evaluation, routing, escalation and the on-call sync. Ask in "
         "#signals for anything alerting."),
        ("doc:runbook-ledger", "runbook", "Ledger runbook", "2025-09-02", "Ines Okafor",
         "Nightly reconciliation compares ledger postings with billing-api subscriptions. If it fails, freeze "
         "refunds, page Billing, and never edit a posting: write a correcting one."),
        ("doc:runbook-sso-legacy", "runbook", "sso-legacy runbook", "2025-05-20", "Yusuf Demir",
         "The SAML service. Restart order: secrets-vault reachable, then sso-legacy. Its signing keys rotate yearly."),
        ("doc:wiki-reports-legacy", "wiki", "How reports-legacy works", "2024-04-11", "Marcus Bell",
         "A cron in reports-legacy reads the warehouse at 02:00 UTC, signs in through sso-legacy, and drops CSVs "
         "on each customer's SFTP. The column mapping lives in a YAML file only Marcus has edited."),
        ("doc:postmortem-inc-311", "postmortem", "Postmortem: INC-311", "2026-03-27", "Rafael Costa",
         "Retiring sso-legacy broke invoice rendering for five and a half hours. invoice-render called sso-legacy "
         "for its signing token; the dependency was in no catalog. Action items: BILL-207, ADR-013, and a check "
         "that compares the catalog with real traffic."),
        ("doc:onboarding-guide", "wiki", "Engineering onboarding", "2026-01-12", "Chloe Dubois",
         "Start with the service catalog, then read the Alerting and Ledger pages. web-console is the best place to "
         "make a first change."),
    ]
    return [{"uid": uid, "kind": kind, "title": title, "at": at, "author": _p(a), "text": text}
            for uid, kind, title, at, a, text in rows]


def contradictions() -> list[dict]:
    return [{"uid": "contra:cache-proxy", "topic": "Does runner-fleet still go through cache-proxy?",
             "a": "msg:leo-cache", "b": "msg:hana-cache", "about": [_s("runner-fleet"), _s("cache-proxy")],
             "at": "2026-09-09T10:48"}]
