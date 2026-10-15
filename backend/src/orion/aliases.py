"""Entity resolution: the names people actually use for things. "Ines", "@ines", "the ledger", "sso legacy",
"Helio" and "BILL-207" each resolve to one node. Aliases live in the graph as (:Alias {text})-[:NAMES]->(entity)
with a full-text index, so the agents and the API resolve names the same way; this module also keeps an
in-memory copy for finding every mention in a message without a query per word."""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict

# words too common to stand for an entity on their own ("data" is a team, and also just data)
STOP = {"the", "a", "an", "to", "of", "on", "in", "for", "and", "is", "it", "we", "i", "our", "data", "sam", "may"}


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9@#\-' ]+", " ", s.lower()).strip()


def aliases_for(kind: str, node: dict) -> list[str]:
    name = node.get("name") or node.get("key") or ""
    out = {fold(name)}
    if kind == "Service":
        out |= {fold(name.replace("-", " ")), "the " + fold(name.replace("-", " "))}
    elif kind == "Person":
        out |= {fold(node["handle"]), fold(node["first"])}
    elif kind == "Team":
        out |= {fold(name + " team"), fold("team " + name), "#" + fold(name)}
    elif kind == "Customer":
        first = fold(name.split()[0])
        if first not in STOP and len(first) > 3:
            out.add(first)
    elif kind == "Decision":
        out |= {fold(node["key"])}
    elif kind == "Ticket":
        out |= {fold(node["key"])}
    out.discard("")
    return sorted(out)


class Resolver:
    """alias text -> set of uids, built from the graph's :Alias nodes (or directly from a world while loading)."""

    def __init__(self, pairs: list[tuple[str, str, str]]):
        # pairs: (alias, uid, kind)
        self.index: dict[str, set[str]] = defaultdict(set)
        self.kind: dict[str, str] = {}
        for text, uid, kind in pairs:
            self.index[text].add(uid)
            self.kind[uid] = kind
        self.max_words = max((len(a.split()) for a in self.index), default=1)

    def resolve(self, text: str) -> list[str]:
        return sorted(self.index.get(fold(text), set()))

    def mentions(self, text: str) -> list[str]:
        """Every entity a text names, longest phrase first, each word used once. Ambiguous phrases are skipped."""
        words = [w[:-2] if w.endswith("'s") else w.strip("-'") for w in fold(text).split()]
        found: list[str] = []
        i = 0
        while i < len(words):
            for n in range(min(self.max_words, len(words) - i), 0, -1):
                phrase = " ".join(words[i:i + n])
                hits = self.index.get(phrase)
                if hits and len(hits) == 1 and phrase not in STOP:
                    uid = next(iter(hits))
                    if uid not in found:
                        found.append(uid)
                    i += n
                    break
            else:
                i += 1
        return found
