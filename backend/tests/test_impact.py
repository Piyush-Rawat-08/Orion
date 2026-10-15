"""The impact walk against an independent oracle, offline.

walk() is checked here against brute force over every simple path, on a stand-in database that answers its one
query, so a mistake in walk() can't hide behind another part of Orion that uses it too (the equivalence test runs
walk() on both sides).
"""

from __future__ import annotations

import itertools
import random

from orion import impact

SEV = impact.SEVERITY


class Edges:
    """A stand-in for the database: `edges` are (dependent, dependency, kind), answered the way HOP asks."""

    def __init__(self, edges, order=None):
        self.edges = list(edges)
        self.order = order  # a permutation of the rows, to show the answer doesn't depend on row order

    def ro(self, graph, query, params):
        rows = [{"next": d, "name": d, "tier": 3, "via": s, "kind": k, "fact": f"{d}>{s}", "declared": True}
                for d, s, k in self.edges if s in params["frontier"]]
        if self.order:
            rows = [rows[i] for i in self.order(len(rows))]
        return rows


def oracle(edges, root):
    """For every service: across all simple paths to the root, the most severe; along a path, the softest hop."""
    out_of = {}
    for d, s, k in edges:
        out_of.setdefault(d, []).append((s, k))
    nodes = {d for d, _, _ in edges} | {s for _, s, _ in edges}
    best = {}

    def paths(n, seen):
        if n == root:
            yield []
            return
        for s, k in out_of.get(n, []):
            if s not in seen:
                for rest in paths(s, seen | {s}):
                    yield [k] + rest

    for n in nodes - {root}:
        sevs = [min(SEV[impact.EFFECT[k]] for k in p) for p in paths(n, {n}) if p]
        if sevs:
            best[n] = max(sevs)
    return best


def effects(edges, root, order=None):
    return {u: SEV[r.effect] for u, r in impact.walk(Edges(edges, order), "g", [root]).items()}


def test_a_more_severe_path_found_a_hop_later_wins():
    # B relies on root asynchronously, but also synchronously through C; D relies on B
    edges = [("B", "root", "async"), ("C", "root", "sync"), ("B", "C", "sync"), ("D", "B", "sync")]
    got = impact.walk(Edges(edges), "g", ["root"])
    assert {u: r.effect for u, r in got.items()} == {"B": "break", "C": "break", "D": "break"}
    # the witness is a real path that proves the effect
    assert got["B"].nodes == ["B", "C", "root"] and got["D"].nodes == ["D", "B", "C", "root"]
    assert got["D"].hops == 3


def test_row_order_does_not_matter():
    edges = [("B", "root", "async"), ("C", "root", "sync"), ("B", "C", "sync"), ("D", "B", "sync"),
             ("E", "D", "data"), ("F", "C", "async"), ("F", "E", "sync")]
    want = oracle(edges, "root")
    for seed in range(20):
        rng = random.Random(seed)
        assert effects(edges, "root", lambda n: rng.sample(range(n), n)) == want


def test_random_graphs_match_brute_force():
    kinds = ["sync", "async", "data"]
    for seed in range(300):
        rng = random.Random(seed)
        names = ["root"] + [f"s{i}" for i in range(rng.randint(2, 7))]
        edges = [(a, b, rng.choice(kinds)) for a, b in itertools.permutations(names, 2)
                 if a != "root" and rng.random() < 0.3]
        assert effects(edges, "root") == oracle(edges, "root"), (seed, edges)


def test_witness_paths_are_simple_and_end_at_the_root():
    rng = random.Random(7)
    names = ["root"] + [f"s{i}" for i in range(7)]
    edges = [(a, b, rng.choice(["sync", "async", "data"])) for a, b in itertools.permutations(names, 2)
             if a != "root" and rng.random() < 0.35]
    for uid, r in impact.walk(Edges(edges), "g", ["root"]).items():
        assert r.nodes[0] == uid and r.nodes[-1] == "root" and len(set(r.nodes)) == len(r.nodes)
        assert r.hops == len(r.nodes) - 1 == len(r.edges)
        assert SEV[r.effect] == min(SEV[impact.EFFECT[k]] for k in r.kinds)
