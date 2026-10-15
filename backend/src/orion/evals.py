"""The proof: Orion against the same model reading the same records as text.

Questions are generated from the graph, so every one has a ground truth the graph itself computes: who actually
knows a system, what it relies on at any depth, what breaks if it is switched off, how many, which decisions still
hold. Both contestants get the question with no hints:

    orion     the Navigator: graph tools, typed claims, the Verifier
    baseline  the same model, given the 15 records most relevant to the question (full-text retrieval over every
              message, document, ticket and pull request), as a retrieval-augmented assistant would be

Answers are graded the same way: the names of the right kind an answer gives are compared with the truth (exact
set, precision, recall), and a name of that kind that isn't in the truth (and isn't in the question) counts as
made up. Runs on a fresh copy of Corvane and writes data/eval/results.json, which the Proof screen shows.

    uv run python -m orion.evals            # about 30 questions, a few minutes, a few cents
"""

from __future__ import annotations

import json
import random
import re
import time
from pathlib import Path

from orion import db as dbm
from orion import epoch as ep
from orion import impact, llm, load, planner
from orion import ops as opsm
from orion.world import corvane

OUT = Path(__file__).resolve().parent / "eval_results.json"  # inside the package, so it ships with the API
TENANT = "evalset"
K_DOCS = 15


# ---------------------------------------------------------------- questions with their truth

def questions(db: dbm.DB, t: str) -> list[dict]:
    g = ep.now(db, t)
    org = dbm.org(t)
    rng = random.Random(7)
    services = [r["n"] for r in db.ro(g, "MATCH (s:Service) RETURN s.name AS n ORDER BY n")]
    knowers = {r["s"]: sorted(r["p"]) for r in db.ro(g, """MATCH (s:Service) OPTIONAL MATCH (p:Person)-[:KNOWS]->(s)
                                                          RETURN s.name AS s, collect(p.name) AS p""")}
    qs: list[dict] = []
    # who knows: the bus-factor ones and a few ordinary ones
    for s in ["ledger", "invoice-render", "reports-legacy", "cache-proxy", "stream-hub", "identity", "billing-api",
              "edge-gateway"]:
        qs.append({"kind": "knows", "q": f"Who actually knows {s}? Name the people.", "label": "Person",
                   "truth": knowers.get(s, []), "about": [s]})
    # what it relies on, at any depth
    for s in ["invoice-render", "web-console", "onboarding", "billing-api", "build-scheduler"]:
        sid = opsm.resolve(db, g, "Service", s)
        reach = impact.walk(db, g, [sid], direction="down")
        qs.append({"kind": "depends", "q": f"Which systems does {s} rely on, directly or indirectly?", "label": "Service",
                   "truth": sorted(r.name for r in reach.values()), "about": [s]})
    # what breaks
    for s in ["sso-legacy", "identity", "secrets-vault", "stream-hub", "ledger"]:
        a = planner.assess(db, t, [{"op": "deprecate_service", "service": s}])
        qs.append({"kind": "breaks", "q": f"If we switched off {s} today, which systems would stop working or degrade?",
                   "label": "Service", "truth": sorted(b["service"] for b in a["broken"]), "about": [s]})
        qs.append({"kind": "count", "q": f"How many systems would break or degrade if {s} were switched off?",
                   "label": "number", "truth": len(a["broken"]), "about": [s]})
    # decisions: still in force or not
    for r in db.ro(org, "MATCH (d:Decision) WHERE d.key STARTS WITH 'ADR' RETURN d.key AS k, d.status AS s, d.title AS t"):
        if r["k"] in ("ADR-002", "ADR-005", "ADR-007", "ADR-011", "ADR-012", "ADR-013"):
            qs.append({"kind": "decided", "q": f"Is {r['k']} ({r['t']}) still in force? Answer accepted, superseded or reversed.",
                       "label": "status", "truth": r["s"], "about": [r["k"]]})
    rng.shuffle(qs)
    return qs


# ---------------------------------------------------------------- grading

STATUS = re.compile(r"\b(accepted|superseded|reversed|in force|still holds|replaced|overturned)\b", re.I)
NEGATED = re.compile(r"\b(not|never|no longer|except|excluding|neither|nor|nobody|none|no one)\b|n't\b", re.I)
NOBODY = re.compile(r"\b(no one|nobody|none|no person|no-one)\b|isn't anyone|aren't any|not anyone", re.I)
WORDNUM = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve".split())}


def _names(db: dbm.DB, t: str, text: str, label: str) -> set[str]:
    res = opsm.resolver(db, dbm.org(t))
    uids = res.mentions(text)
    if not uids:
        return set()
    rows = db.ro(dbm.org(t), "MATCH (n) WHERE n.uid IN $u RETURN coalesce(n.name, n.key) AS name, labels(n) AS labels", {"u": uids})
    want = {"Service": {"Service", "Retired"}, "Person": {"Person", "Former"}}[label]
    return {r["name"] for r in rows if want & set(r["labels"])}


def grade(db: dbm.DB, t: str, q: dict, text: str) -> dict:
    text = text or ""
    if q["label"] == "number":
        # the first number the answer gives, written in digits or in words
        tokens = re.findall(r"\b(\d{1,3}|" + "|".join(WORDNUM) + r")\b", text, re.I)
        nums = [int(x) if x.isdigit() else WORDNUM[x.lower()] for x in tokens]
        ok = bool(nums) and nums[0] == q["truth"]
        return {"correct": ok, "precision": 1.0 if ok else 0.0, "recall": 1.0 if ok else 0.0, "made_up": [], "said": nums[:1]}
    if q["label"] == "status":
        text = re.sub(r"accepted,? superseded,? or reversed", "", text, flags=re.I)  # the choices, repeated back
        if re.search(r"can(no|')t (be )?determine|not (be )?determined|no information|don't know", text, re.I):
            return {"correct": False, "precision": 0.0, "recall": 0.0, "made_up": [], "said": "unknown"}
        m = STATUS.search(text)
        word = (m.group(1).lower() if m else "").replace("in force", "accepted").replace("still holds", "accepted") \
            .replace("replaced", "superseded").replace("overturned", "reversed")
        ok = word == q["truth"]
        return {"correct": ok, "precision": 1.0 if ok else 0.0, "recall": 1.0 if ok else 0.0, "made_up": [], "said": word}
    sentences = [x for x in re.split(r"(?<=[.!?])\s+|\n", text) if x.strip()]
    if not q["truth"]:  # "nobody knows it": right when the answer opens by saying so
        ok = bool(sentences) and bool(NOBODY.search(sentences[0]))
        return {"correct": ok, "precision": 1.0 if ok else 0.0, "recall": 1.0, "made_up": [], "said": sentences[0][:120] if sentences else ""}
    # a name in a sentence that rules it out ("X has touched it but doesn't know it") isn't an answer
    kept = " ".join(x for x in sentences if not NEGATED.search(x))
    said = _names(db, t, kept, q["label"]) - set(q["about"])
    truth = set(q["truth"])
    hit = said & truth
    made = sorted(said - truth)
    return {"correct": said == truth, "precision": len(hit) / len(said) if said else 0.0, "recall": len(hit) / len(truth),
            "made_up": made, "said": sorted(said)}


# ---------------------------------------------------------------- the contestants

BASELINE_SYSTEM = ("You are a company assistant. Answer the question using only the records below (team chat, "
                   "documents, tickets and pull requests of the company). Be specific and name names.")


STOP = set("the and for with what which who whom does would were was are still into from that this them they have has its "
           "our your all any directly indirectly systems system today answer name people actually rely depend break stop "
           "working degrade many switched switch off force accepted superseded reversed".split())


def retrieve(db: dbm.DB, t: str, q: str, k: int = K_DOCS) -> list[dict]:
    """Full-text retrieval over every record (messages, documents, tickets, pull requests) plus decision records, the
    way a retrieval-augmented assistant would see the company. Names are searched as words (sso-legacy -> sso legacy)."""
    words = [w for w in re.findall(r"[a-z0-9]+", q.lower()) if len(w) > 2 and w not in STOP]
    if not words:
        return []
    org = dbm.org(t)
    rows = db.ro(org, """CALL db.idx.fulltext.queryNodes('Source', $q) YIELD node, score
                         OPTIONAL MATCH (node)-[:POSTED_BY|WRITTEN_BY|AUTHORED]-(p:Person)
                         RETURN coalesce(node.title, node.channel, node.key) AS title, node.at AS at, node.text AS text,
                                collect(DISTINCT p.name)[0] AS author, score
                         ORDER BY score DESC LIMIT $k""", {"q": " | ".join(dict.fromkeys(words)), "k": k})
    decisions = db.ro(org, """MATCH (d:Decision) WHERE any(w IN $w WHERE toLower(d.key + ' ' + d.title + ' ' + coalesce(d.summary, ''))
                                                         CONTAINS w)
                              OPTIONAL MATCH (n:Decision)-[s:SUPERSEDES]->(d)
                              RETURN d.key + ': ' + d.title AS title, d.decided_at AS at,
                                     coalesce(d.summary, '') + CASE WHEN n IS NULL THEN '' ELSE ' (later ' + s.how + ' by ' + n.key + ')' END AS text,
                                     null AS author LIMIT 5""", {"w": words})
    return decisions + rows


def baseline(db: dbm.DB, t: str, q: str) -> tuple[str, int]:
    docs = "\n".join(f"[{(r['at'] or '')[:10]}] {r['title']}{' by ' + r['author'] if r.get('author') else ''}: {r['text']}"
                     for r in retrieve(db, t, q))
    t0 = time.perf_counter()
    out = llm.json_call(BASELINE_SYSTEM, f"Records:\n{docs}\n\nQuestion: {q}",
                        {"type": "object", "additionalProperties": False, "required": ["answer"],
                         "properties": {"answer": {"type": "string"}}})
    return out["answer"], round((time.perf_counter() - t0) * 1000)


def orion(db: dbm.DB, t: str, q: str) -> tuple[str, int, list[dict]]:
    from orion.agents.navigator import answer

    r = answer(db, t, q, user=None)
    text = (r.get("summary") or "") + "\n" + "\n".join(c["text"] for c in r.get("claims", []))
    return text, r.get("ms", 0), [{"text": c["text"], "verdict": c["verdict"]} for c in r.get("claims", [])]


def run(limit: int | None = None) -> dict:
    db = dbm.get_db()
    w = corvane.build()
    w.tenant = TENANT
    load.load(db, w)
    ep.now(db, TENANT)
    try:
        qs = questions(db, TENANT)[:limit]
        rows = []
        for i, q in enumerate(qs, 1):
            o_text, o_ms, claims = orion(db, TENANT, q["q"])
            b_text, b_ms = baseline(db, TENANT, q["q"])
            o, b = grade(db, TENANT, q, o_text), grade(db, TENANT, q, b_text)
            rows.append({**{k: q[k] for k in ("kind", "q", "truth")}, "orion": {**o, "ms": o_ms, "answer": o_text[:5000], "claims": claims},
                         "baseline": {**b, "ms": b_ms, "answer": b_text[:5000]}})
            print(f"{i:2}/{len(qs)} {q['kind']:8} orion {'✓' if o['correct'] else '✗'}  baseline {'✓' if b['correct'] else '✗'}  {q['q'][:60]}", flush=True)
    finally:
        for g in db.graphs(f"org:{TENANT}") + db.graphs(f"epoch:{TENANT}:") + db.graphs(f"universe:{TENANT}:") + \
                db.graphs(f"deck:{TENANT}") + db.graphs(f"mem:{TENANT}:"):
            db.delete(g)
        db.drop(f"orion:{TENANT}:")
    out = {"ran_at": time.strftime("%Y-%m-%dT%H:%M"), "model": llm.info(), "k_docs": K_DOCS, "questions": rows,
           "summary": summarize(rows)}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    return out


def summarize(rows: list[dict]) -> dict:
    def side(key: str, rs: list[dict]) -> dict:
        n = len(rs) or 1
        sets = [r for r in rs if r["kind"] in ("knows", "depends", "breaks")]
        return {"correct": sum(r[key]["correct"] for r in rs), "total": len(rs),
                "accuracy": round(100 * sum(r[key]["correct"] for r in rs) / n),
                "precision": round(100 * sum(r[key]["precision"] for r in sets) / (len(sets) or 1)),
                "recall": round(100 * sum(r[key]["recall"] for r in sets) / (len(sets) or 1)),
                "made_up_answers": sum(1 for r in rs if r[key]["made_up"]),
                "made_up_names": sum(len(r[key]["made_up"]) for r in rs),
                "median_ms": sorted(r[key]["ms"] for r in rs)[len(rs) // 2] if rs else 0}
    kinds = sorted({r["kind"] for r in rows})
    return {"orion": side("orion", rows), "baseline": side("baseline", rows),
            "by_kind": {k: {"orion": side("orion", [r for r in rows if r["kind"] == k]),
                            "baseline": side("baseline", [r for r in rows if r["kind"] == k])} for k in kinds}}


if __name__ == "__main__":
    import sys

    s = run(int(sys.argv[1]) if len(sys.argv) > 1 else None)["summary"]
    print(json.dumps({k: s[k] for k in ("orion", "baseline")}, indent=1))
