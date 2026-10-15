"""Repo mode: a public GitHub repository loaded as a company of its own (tenant gh-<owner>--<repo>).

Contributors are people, top-level parts of the code are services ("modules"), merged pull requests are changes
(who wrote them, who reviewed them, which modules they touched), CODEOWNERS entries are teams that own modules,
imports between modules are dependencies (declared: they are written in the code, each with the line it came
from), and modules that keep changing in the same pull requests get CO_CHANGES links. The epoch builder then
derives who knows what and who works with whom exactly as it does for Corvane.

Insights speak about modules, never about a person as a risk: knowledge is reported as counts per module.
"""

from __future__ import annotations

import json
import time
from collections import Counter
from datetime import date, timedelta
from itertools import combinations

from orion import db as dbm
from orion import epoch as ep
from orion import github as gh
from orion import universe as uv
from orion.load import INDEXES
from orion.queries import cypher
from orion.world.corvane import day_index, slug

CODE = ["code"]
EVERY_KIND = ["code", "test", "docs", "ci", "build", "config"]
SWEEP = 12  # a pull request touching more modules than this is a sweep (renames, formatting): no co-change
OPEN = "9999-12-31"


def tenant_of(owner: str, repo: str) -> str:
    return f"gh-{owner}--{repo}".lower().replace(".", "-")


def _mine(t: str) -> None:
    if not t.startswith("gh-"):
        raise ValueError(f"repo mode only manages gh-* tenants, not {t!r}")


def _meta(db: dbm.DB, t: str) -> dict:
    raw = db.get(f"orion:{t}:repo")
    if not raw:
        raise KeyError(f"{t} is not a loaded repository")
    return json.loads(raw)


def _min_together(n_prs: int) -> int:
    return 3 if n_prs < 150 else 4 if n_prs < 400 else 5


def _wipe(db: dbm.DB, t: str) -> None:
    _mine(t)
    for g in db.graphs(f"epoch:{t}:") + db.graphs(f"universe:{t}:") + db.graphs(f"mem:{t}:") + [dbm.org(t), dbm.deck(t)]:
        db.delete(g)
    db.drop(f"orion:{t}:")
    db.drop(f"orion:epoch:epoch:{t}:")
    db.drop(f"orion:snap:epoch:{t}:")


# ---------------------------------------------------------------- ingest

def _people(prs: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for p in sorted(prs, key=lambda p: p["at"]):
        for who in [p["author"]] + p["reviewers"]:
            if who and who["login"] not in out:
                out[who["login"]] = {"uid": "person:" + slug(who["login"]), "name": who["name"], "handle": who["login"],
                                     "joined": p["at"]}
    return out


def _cochanges(prs: list[dict], mods_of: dict[int, set[str]], uid: dict[str, str]) -> list[dict]:
    per = Counter()
    pair = Counter()
    first: dict[tuple, str] = {}
    for p in sorted(prs, key=lambda p: p["at"]):
        ms = mods_of[p["number"]]
        for m in ms:
            per[m] += 1
        if len(ms) > SWEEP:
            continue
        for a, b in combinations(sorted(ms), 2):
            pair[(a, b)] += 1
            first.setdefault((a, b), p["at"])
    need = _min_together(len(prs))
    return [{"a": uid[a], "b": uid[b], "together": n, "jaccard": round(n / (per[a] + per[b] - n), 3), "since": first[(a, b)]}
            for (a, b), n in pair.items() if n >= need]


def _imports(files: dict[str, str], modules: list[str], uid: dict[str, str]) -> list[dict]:
    """Module-to-module imports, each with the first line that shows it."""
    seen: dict[tuple, dict] = {}
    for e in gh.import_edges(files):
        a, b = gh.module_of(e["src"], modules), gh.module_of(e["dst"], modules)
        if a != b and (a, b) not in seen:
            seen[(a, b)] = {"a": uid[a], "b": uid[b], "path": e["src"], "line": e["line"], "text": e["text"]}
    return list(seen.values())


def build(owner: str, repo: str, info: dict, prs: list[dict], owners_text: str, files: dict[str, str]) -> dict:
    tree = sorted(files)
    modules = gh.layout(prs, tree)
    uid = {m: "svc:" + (slug(m.replace("/", "-")) or "root") for m in modules}
    mods_of = {p["number"]: {gh.module_of(f, modules) for f in p["files"]} for p in prs}
    changes = Counter(m for ms in mods_of.values() for m in ms)
    code_rank = sorted((m for m in modules if gh.kind_of(m) == "code"), key=lambda m: -changes[m])
    tier = {m: 3 for m in modules}
    for i, m in enumerate(code_rank):
        tier[m] = 1 if i < max(1, len(code_rank) // 4) else 2 if i < max(2, len(code_rank) * 3 // 4) else 3

    rules = gh.parse_codeowners(owners_text)
    by_module: dict[str, Counter] = {m: Counter() for m in modules}
    files_in: Counter = Counter()
    for f in tree:
        m = gh.module_of(f, modules)
        files_in[m] += 1
        for o in gh.owners_of(f, rules):
            by_module[m][o] += 1
    owns = [(o, m) for m, c in by_module.items() for o, n in c.items() if files_in[m] and n / files_in[m] >= 0.5]
    teams = sorted({o for o, _ in owns})

    people = _people(prs)
    now = max((p["at"] for p in prs), default=info["created"])
    created = info["created"] or now
    return {
        "tenant": tenant_of(owner, repo), "company": f"{owner}/{repo}", "clock": now, "created": created,
        "modules": [{"uid": uid[m], "name": m, "kind": gh.kind_of(m), "tier": tier[m], "changes": changes[m],
                     "prefix": m, "created": created} for m in modules],
        "people": list(people.values()),
        "teams": [{"uid": "team:" + slug(o.replace("/", "-")), "name": o, "created": created} for o in teams],
        "owns": [{"a": "team:" + slug(o.replace("/", "-")), "b": uid[m], "uid": f"own:{slug(o.replace('/', '-'))}->{uid[m][4:]}@{created}",
                  "from": created} for o, m in owns],
        "members": [{"a": people[o]["uid"], "b": "team:" + slug(o.replace("/", "-")),
                     "uid": f"mem:{people[o]['uid'][7:]}->{slug(o.replace('/', '-'))}@{created}", "from": created}
                    for o in teams if "/" not in o and o in people],
        "changes": [{"uid": f"chg:pr-{p['number']}", "key": f"#{p['number']}", "title": p["title"], "at": p["at"],
                     "day": day_index(p["at"]), "url": p["url"], "author": people[p["author"]["login"]]["uid"] if p["author"] else None,
                     "reviewers": sorted({people[r["login"]]["uid"] for r in p["reviewers"]} -
                                         ({people[p["author"]["login"]]["uid"]} if p["author"] else set())),
                     "modules": sorted(uid[m] for m in mods_of[p["number"]])} for p in prs],
        "imports": _imports(files, modules, uid),
        "cochanges": _cochanges(prs, mods_of, uid),
        "sha": info["sha"], "branch": info["branch"], "repo_url": f"https://github.com/{owner}/{repo}",
        "last_pr": max((p["number"] for p in prs), default=0),
    }


def load(db: dbm.DB, w: dict) -> dict:
    t0 = time.perf_counter()
    t = w["tenant"]
    g = dbm.org(t)
    for label, prop in INDEXES:
        db.q(g, f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")
    db.q(g, "CREATE INDEX FOR ()-[r:DEPENDS_ON]-() ON (r.uid)")
    db.q(g, "CREATE FULLTEXT INDEX FOR (n:Source) ON (n.text, n.title)")
    db.q(g, "CREATE (:Company {tenant: $t, name: $n, clock: $c, repo: true})", {"t": t, "n": w["company"], "c": w["clock"]})

    def run(q: str, rows: list[dict]):
        for i in range(0, len(rows), 400):
            db.q(g, q, {"rows": rows[i:i + 400]})

    run("""UNWIND $rows AS r CREATE (:Service {uid: r.uid, name: r.name, kind: r.kind, tier: r.tier, changes: r.changes,
           prefix: r.prefix, created: r.created})""", w["modules"])
    run("""UNWIND $rows AS r CREATE (:Person {uid: r.uid, name: r.name, handle: r.handle, role: 'contributor',
           joined: r.joined})""", w["people"])
    run("UNWIND $rows AS r CREATE (:Team {uid: r.uid, name: r.name, created: r.created, mission: 'CODEOWNERS'})", w["teams"])
    owners_src = "doc:codeowners"
    db.q(g, """CREATE (:Source:Doc {uid: $u, kind: 'doc', title: 'CODEOWNERS', at: $at, text: 'CODEOWNERS at HEAD',
                                    day: $day, url: $url})""",
         {"u": owners_src, "at": w["created"], "day": day_index(w["created"]), "url": w["repo_url"] + "/blob/HEAD/.github/CODEOWNERS"})
    run(f"""UNWIND $rows AS r MATCH (t:Team {{uid: r.a}}), (s:Service {{uid: r.b}})
            CREATE (t)-[:OWNS {{uid: r.uid, valid_from: r.from, valid_to: '{OPEN}', recorded_at: r.from,
                                src: '{owners_src}', declared: true}}]->(s)""", w["owns"])
    run(f"""UNWIND $rows AS r MATCH (p:Person {{uid: r.a}}), (t:Team {{uid: r.b}})
            CREATE (p)-[:MEMBER_OF {{uid: r.uid, valid_from: r.from, valid_to: '{OPEN}', recorded_at: r.from,
                                     src: '{owners_src}'}}]->(t)""", w["members"])
    _add_changes(db, g, w["changes"])
    _add_imports(db, g, w["imports"], w["created"], w["clock"], w["repo_url"], w["sha"])
    run("""UNWIND $rows AS r MATCH (a:Service {uid: r.a}), (b:Service {uid: r.b})
           CREATE (a)-[:CO_CHANGES {together: r.together, jaccard: r.jaccard, since: r.since}]->(b)""", w["cochanges"])
    db.set(f"orion:{t}:clock", w["clock"])
    db.set(f"orion:{t}:repo", json.dumps({"owner": w["company"].split("/")[0], "repo": w["company"].split("/")[1],
                                          "sha": w["sha"], "branch": w["branch"], "last_pr": w["last_pr"],
                                          "modules": [m["name"] for m in w["modules"]], "url": w["repo_url"]}))
    dbm.bump(db, t)
    return {"load_ms": round((time.perf_counter() - t0) * 1000)}


def _add_changes(db: dbm.DB, g: str, rows: list[dict]) -> None:
    for i in range(0, len(rows), 300):
        b = rows[i:i + 300]
        db.q(g, """UNWIND $rows AS r CREATE (:Source:Change {uid: r.uid, kind: 'change', key: r.key, title: r.title,
                   text: r.title, at: r.at, day: r.day, url: r.url})""", {"rows": b})
        db.q(g, """UNWIND $rows AS r MATCH (c:Change {uid: r.uid}), (p:Person {uid: r.author})
                   CREATE (p)-[:AUTHORED {at: r.at}]->(c)""", {"rows": [r for r in b if r["author"]]})
        db.q(g, """UNWIND $rows AS r MATCH (c:Change {uid: r.c}), (p:Person {uid: r.p}) CREATE (p)-[:REVIEWED {at: r.at}]->(c)""",
             {"rows": [{"c": r["uid"], "p": p, "at": r["at"]} for r in b for p in r["reviewers"]]})
        db.q(g, """UNWIND $rows AS r MATCH (c:Change {uid: r.c}), (s:Service {uid: r.s}) CREATE (c)-[:MODIFIES]->(s)""",
             {"rows": [{"c": r["uid"], "s": s} for r in b for s in r["modules"]]})


def _code_source(e: dict, at: str, url: str, sha: str) -> dict:
    return {"uid": f"code:{e['path']}:{e['line']}", "title": f"{e['path']}:{e['line']}", "text": e["text"], "at": at,
            "day": day_index(at), "url": f"{url}/blob/{sha}/{e['path']}#L{e['line']}"}


def _add_imports(db: dbm.DB, g: str, rows: list[dict], since: str, at: str, url: str, sha: str) -> None:
    srcs = [_code_source(e, at, url, sha) for e in rows]
    db.q(g, """UNWIND $rows AS r MERGE (s:Source:Doc {uid: r.uid})
               ON CREATE SET s.kind = 'code', s.title = r.title, s.text = r.text, s.at = r.at, s.day = r.day, s.url = r.url""",
         {"rows": srcs})
    db.q(g, f"""UNWIND $rows AS r MATCH (a:Service {{uid: r.a}}), (b:Service {{uid: r.b}})
                CREATE (a)-[:DEPENDS_ON {{uid: 'dep:' + substring(r.a, 4) + '->' + substring(r.b, 4) + '@' + $since,
                                         kind: 'sync', valid_from: $since, valid_to: '{OPEN}', recorded_at: $at,
                                         src: r.src, declared: true, quote: r.text}}]->(b)""",
         {"rows": [e | {"src": s["uid"]} for e, s in zip(rows, srcs)], "since": since, "at": at})


def ingest(db: dbm.DB, owner: str, repo: str, max_prs: int = 200, days: int = 365) -> dict:
    t = tenant_of(owner, repo)
    t0 = time.perf_counter()
    info, prs = gh.pulls(owner, repo, gh.since_days(days), max_prs)
    if not info.get("sha"):
        raise ValueError(f"{owner}/{repo} has no default branch")
    owners_text = gh.codeowners(owner, repo)
    files = gh.source(owner, repo, info["sha"], gh.cache_dir(owner, repo))
    fetch_ms = (time.perf_counter() - t0) * 1000
    gh.save(owner, repo, "pulls.json", prs)
    t1 = time.perf_counter()
    w = build(owner, repo, info, prs, owners_text, files)
    build_ms = (time.perf_counter() - t1) * 1000
    _wipe(db, t)
    loaded = load(db, w)
    snap = ep.checkout(db, t)
    summary = {"repo": f"{owner}/{repo}", "merged_prs": len(prs), "people": len(w["people"]), "modules": len(w["modules"]),
               "code_modules": sum(1 for m in w["modules"] if m["kind"] == "code"), "teams": len(w["teams"]),
               "imports": len(w["imports"]), "co_changes": len(w["cochanges"]), "sha": w["sha"][:12],
               "since": min((p["at"] for p in prs), default=None), "until": w["clock"]}
    return {"tenant": t, "graph": dbm.org(t), "summary": summary,
            "timings_ms": {"fetch": round(fetch_ms), "map": round(build_ms), "load": loaded["load_ms"],
                           "snapshot": snap["total_ms"], "total": round((time.perf_counter() - t0) * 1000)}}


# ---------------------------------------------------------------- insights

def _receipt(graph: str, name: str, params: dict, asof: str) -> dict:
    return {"graph": graph, "query": name, "cypher": cypher(name), "params": params, "asof": asof}


def insights(db: dbm.DB, t: str, all_kinds: bool = False, limit: int = 10) -> dict:
    """Which modules change together with no import between them, and how thinly each module is known."""
    _mine(t)
    t0 = time.perf_counter()
    kinds = EVERY_KIND if all_kinds else CODE
    snap = ep.checkout(db, t)
    g, asof = snap["graph"], snap["asof"]
    p1 = {"kinds": kinds, "limit": limit}
    pairs = db.ro(g, cypher("repo_hidden_coupling"), p1)
    p2 = {"kinds": kinds, "since": (date.fromisoformat(asof[:10]) - timedelta(days=ep.KNOWS_WINDOW)).isoformat(),
          "min_changes": 3}
    mods = db.ro(g, cypher("repo_knowledge_concentration"), p2)
    summary = {"active_modules": len(mods),
               "known_by_nobody": sum(1 for r in mods if r["knowers"] == 0),
               "known_by_one": sum(1 for r in mods if r["knowers"] == 1),
               "known_by_two": sum(1 for r in mods if r["knowers"] == 2),
               "known_by_three_or_more": sum(1 for r in mods if r["knowers"] >= 3),
               "dominated_by_one_author": sum(1 for r in mods if r["top_author_share"] >= 75)}
    return {"tenant": t, "asof": asof, "kinds": kinds,
            "hidden_coupling": {"pairs": pairs, "receipt": _receipt(g, "repo_hidden_coupling", p1, asof),
                                "note": "Pairs changed in the same merged pull requests again and again, with no import "
                                        "between them and no CODEOWNERS owner in common."},
            "knowledge_concentration": {"modules": mods, "summary": summary,
                                        "receipt": _receipt(g, "repo_knowledge_concentration", p2, asof),
                                        "note": f"Someone knows a module after writing or reviewing at least "
                                                f"{ep.KNOWS_MIN} merged pull requests that touch it within "
                                                f"{ep.KNOWS_WINDOW} days."},
            "ms": round((time.perf_counter() - t0) * 1000, 1)}


def module_whatif(db: dbm.DB, t: str, module: str) -> dict:
    """Switch a module off in a universe: what imports it breaks, and which modules have changed alongside it."""
    _mine(t)
    res = uv.fork(db, t, [{"op": "deprecate_service", "service": module}], title=f"What if {module} were retired",
                  created_by="repo")
    retired = json.loads(res["ops_json"])[0]["service"]
    impact = db.ro(res["base"], cypher("repo_cochange_impact"), {"r": retired})
    d = res["diff"]
    return {"universe": res["uid"], "graph": res["graph"], "base": res["base"], "title": res["title"],
            "copy_ms": res["copy_ms"], "apply_ms": res["apply_ms"], "fork_ms": res["fork_ms"], "applied": res["applied"],
            "cochange_impact": impact, "cochange_receipt": _receipt(res["base"], "repo_cochange_impact", {"r": retired}, d["asof"]),
            "diff": {k: d[k] for k in ("risk", "broken", "new_orphans", "collaboration_splits", "bottlenecks", "structural",
                                        "diff_ms")}}


# ---------------------------------------------------------------- sync

def sync(db: dbm.DB, t: str) -> dict:
    """Fold in what merged since the last sync. New pull requests become changes; the imports at the new HEAD are
    compared with the open dependencies, and every difference goes through the Sentinel like a message would, with
    the code at that commit as its source, so answers that relied on a removed import are told."""
    from orion.agents import sentinel

    _mine(t)
    meta = _meta(db, t)
    owner, repo = meta["owner"], meta["repo"]
    g = dbm.org(t)
    clock = dbm.clock(db, t)
    info, prs = gh.pulls(owner, repo, clock[:16], 300, stop_at=meta["last_pr"])
    modules = meta["modules"]
    uid = {r["name"]: r["uid"] for r in db.ro(g, "MATCH (s:Service) RETURN s.name AS name, s.uid AS uid")}
    if prs:
        known = {r["h"] for r in db.ro(g, "MATCH (p:Person) RETURN p.handle AS h")}
        fresh = [p for p in _people(prs).values() if p["handle"] not in known]
        db.q(g, """UNWIND $rows AS r CREATE (:Person {uid: r.uid, name: r.name, handle: r.handle, role: 'contributor',
                   joined: r.joined})""", {"rows": fresh})
        handles = {r["h"]: r["u"] for r in db.ro(g, "MATCH (p:Person) RETURN p.handle AS h, p.uid AS u")}
        rows = []
        for p in prs:
            author = handles.get(p["author"]["login"]) if p["author"] else None
            rows.append({"uid": f"chg:pr-{p['number']}", "key": f"#{p['number']}", "title": p["title"], "at": p["at"],
                         "day": day_index(p["at"]), "url": p["url"], "author": author,
                         "reviewers": sorted({handles[r["login"]] for r in p["reviewers"] if r["login"] in handles} - {author}),
                         "modules": sorted({uid[m] for m in (gh.module_of(f, modules) for f in p["files"]) if m in uid})})
        db.q(g, "MATCH (c:Change) WHERE c.uid IN $u DETACH DELETE c", {"u": [r["uid"] for r in rows]})
        _add_changes(db, g, rows)
    now = max([clock] + [p["at"] for p in prs])
    db.set(f"orion:{t}:clock", now)

    opened, closed, notes = [], [], []
    if info.get("sha") and info["sha"] != meta["sha"]:
        files = gh.source(owner, repo, info["sha"], gh.cache_dir(owner, repo))
        want = {(e["a"], e["b"]): e for e in _imports(files, modules, uid)}
        have = {(r["a"], r["b"]) for r in db.ro(g, f"""MATCH (a:Service)-[r:DEPENDS_ON]->(b:Service)
                                                      WHERE r.valid_to = '{OPEN}' AND r.declared = true
                                                      RETURN a.uid AS a, b.uid AS b""")}
        name = {v: k for k, v in uid.items()}
        src = f"code:sync-{info['sha'][:12]}"
        db.q(g, """MERGE (s:Source:Doc {uid: $u}) SET s.kind = 'code', s.title = $title, s.text = $text, s.at = $at,
                   s.day = $day, s.url = $url""",
             {"u": src, "title": f"imports at {info['sha'][:7]}", "text": f"the import graph at commit {info['sha'][:12]}",
              "at": now, "day": day_index(now), "url": f"{meta['url']}/tree/{info['sha']}"})
        changes = []
        for a, b in sorted(have - set(want)):
            changes.append({"relation": "DEPENDS_ON", "subject": name.get(a, a), "subject_uid": a, "subject_label": "Service",
                            "object": name.get(b, b), "object_uid": b, "object_label": "Service", "change": "stops",
                            "stated": "firm", "quote": f"no import from {name.get(a, a)} to {name.get(b, b)} at {info['sha'][:7]}"})
        for a, b in sorted(set(want) - have):
            e = want[(a, b)]
            changes.append({"relation": "DEPENDS_ON", "subject": name.get(a, a), "subject_uid": a, "subject_label": "Service",
                            "object": name.get(b, b), "object_uid": b, "object_label": "Service", "change": "starts",
                            "stated": "firm", "kind": "sync", "declared": True, "quote": f"{e['path']}:{e['line']} {e['text']}"})
        if changes:
            out = sentinel.apply_changes(db, t, src, changes, [], now, reviewed_by=f"the code at {info['sha'][:7]}")
            opened = [f"{c['subject']} → {c['object']}" for c in changes if c["change"] == "starts"]
            closed = [f"{c['subject']} → {c['object']}" for c in changes if c["change"] == "stops"]
            notes = out["notifications"]
        meta["sha"] = info["sha"]
    if prs:
        meta["last_pr"] = max(meta["last_pr"], max(p["number"] for p in prs))
        dbm.bump(db, t)
    db.set(f"orion:{t}:repo", json.dumps(meta))
    return {"tenant": t, "new_prs": len(prs), "sha": meta["sha"][:12], "dependencies_opened": opened,
            "dependencies_closed": closed, "notifications": len(notes), "clock": now}
