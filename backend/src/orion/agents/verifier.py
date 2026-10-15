"""The Verifier: checks every claim of an answer before anyone sees it.

Typed claims are checked by the graph (claims.py): verified means the graph returned exactly that set or number.
Free-text claims are judged by the fast model on the rows their evidence returned, and are labelled 'judged', never
'verified'. It fails closed: a claim that cites nothing, or evidence that doesn't exist, is 'unsupported'; a claim
whose receipt is gone (its universe was merged or discarded) is 'expired'.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

from orion import claims as typed
from orion import db as dbm
from orion import llm

JUDGE = {"type": "object", "additionalProperties": False, "required": ["supported", "reason"],
         "properties": {"supported": {"type": "boolean"}, "reason": {"type": "string"}}}

SYSTEM = ("You check one sentence against the database rows it cites. 'supported' means every part of the sentence "
          "follows from the rows; anything the rows don't show makes it unsupported. Be strict. Give a short reason "
          "in plain words, without mentioning rows, queries or databases.")


def verify(db: dbm.DB, claims: list[dict], evidence: list[dict], tenant: str, use_llm: bool = True,
           today: bool = False, asof: str | None = None) -> list[dict]:
    by_eid = {e["eid"]: e for e in evidence}
    # each claim is checked on its own, so they run side by side: on a remote database most of the time is round trips
    with ThreadPoolExecutor(max_workers=min(6, len(claims) or 1)) as ex:
        return list(ex.map(lambda ic: _one(db, ic[0], ic[1], by_eid, tenant, use_llm, today, asof), enumerate(claims)))


def _one(db: dbm.DB, i: int, c: dict, by_eid: dict, tenant: str, use_llm: bool, today: bool, asof: str | None) -> dict:
    cited = [e for e in c.get("evidence") or [] if e in by_eid]
    base = {"index": i, "text": c.get("text", ""), "evidence": c.get("evidence") or [], "kind": c.get("kind") or "free",
            "rerun": []}
    try:
        r = typed.check(db, tenant, c, today=today, asof=asof)
        return base | r
    except typed.CheckError as e:
        if e.verdict != "free":
            return base | {"verdict": e.verdict, "reason": str(e), "check": None}
    # free text: fail closed, then judge on the rows it cites
    if not cited:
        return base | {"verdict": "unsupported", "reason": "it cites nothing in the records", "check": None}
    gone = [by_eid[e]["graph"] for e in cited if by_eid[e]["graph"].startswith("universe:") and not db.exists(by_eid[e]["graph"])]
    if gone and len(gone) == len(cited):
        return base | {"verdict": "expired", "reason": "the what-if it was based on is gone", "check": None}
    if not use_llm or not llm.available():
        return base | {"verdict": "unverified", "reason": "free text is judged by a model, and none was used", "check": None}
    rows = {e: {"summary": by_eid[e]["summary"], "rows": by_eid[e].get("rows")} for e in cited}
    try:
        j = llm.json_call(SYSTEM, f"Sentence: {c.get('text')}\n\nRows:\n{json.dumps(rows, default=str)[:14000]}", JUDGE)
        return base | {"verdict": "judged" if j["supported"] else "unsupported", "reason": j["reason"], "check": None}
    except Exception as e:
        return base | {"verdict": "unverified", "reason": f"couldn't judge it ({type(e).__name__})", "check": None}
