"""The Cartographer: reads a new message and proposes the changes of fact it states.

Only firm statements about the present count. Plans ("we should"), questions, hypotheticals and jokes propose
nothing. Each proposal names the services or people involved, as written, and quotes the words it came from;
the Sentinel decides what happens next.
"""

from __future__ import annotations

import re

from orion import llm

SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["changes"],
    "properties": {"changes": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["op", "service", "on", "team", "kind", "hedged", "quote"],
        "properties": {
            "op": {"type": "string", "enum": ["add_dependency", "remove_dependency", "move_ownership"]},
            "service": {"type": "string"}, "on": {"type": ["string", "null"]}, "team": {"type": ["string", "null"]},
            "kind": {"anyOf": [{"type": "string", "enum": ["sync", "async", "data"]}, {"type": "null"}]},
            "hedged": {"type": "boolean", "description": "the author sounds unsure ('I think', 'probably')"},
            "quote": {"type": "string", "description": "the words this comes from"}}}}},
}

SYSTEM = """You read one message from a company's chat and list the changes of fact it states about its software:
a service starting or stopping depending on another service, or a team taking over a service. Only firm
statements about what is true now count. A plan, a question, a hypothetical, sarcasm or a joke states nothing.
Known services: {services}. Known teams: {teams}. Use those names exactly. If nothing changes, return no changes."""


def extract(text: str, services: list[str], teams: list[str]) -> list[dict]:
    if llm.available():
        out = llm.json_call(SYSTEM.format(services=", ".join(services), teams=", ".join(teams)), text, SCHEMA)
        return out["changes"]
    return _rules(text, services)


def _rules(text: str, services: list[str]) -> list[dict]:
    """Without a model: the two sentence shapes the demo uses ("X no longer calls Y", "X now gets ... from Y")."""
    names = "|".join(sorted((re.escape(s) for s in services), key=len, reverse=True))
    out = []
    for m in re.finditer(rf"({names})[^.]*?\bno longer (?:calls|uses|depends on|talks to)\s+({names})", text, re.I):
        out.append({"op": "remove_dependency", "service": m.group(1), "on": m.group(2), "team": None, "kind": None,
                    "hedged": False, "quote": m.group(0)})
    for m in re.finditer(rf"({names})\s+now\s+(?:gets[^.]*?from|uses|calls|depends on)\s+({names})", text, re.I):
        out.append({"op": "add_dependency", "service": m.group(1), "on": m.group(2), "team": None, "kind": "sync",
                    "hedged": False, "quote": m.group(0)})
    return out
