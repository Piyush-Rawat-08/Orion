"""Repo mode's parsing, offline: modules, CODEOWNERS, imports, and the company a repository becomes."""

from orion import github as gh
from orion import repo

FILES = {
    "pkg/core/engine.py": "from pkg.util import helpers\nimport pkg.store\n",
    "pkg/util/helpers.py": "",
    "pkg/store.py": "from .core import engine\n",
    "web/src/app.ts": "import { x } from './lib/api';\nconst y = require('../shared/z.js');\n",
    "web/src/lib/api.ts": "",
    "web/shared/z.js": "",
    "tests/test_engine.py": "from pkg.core.engine import run\n",
    "docs/index.md": "",
    ".github/CODEOWNERS": "",
}


def pr(n, files, author="ada", reviewers=("bob",), at="2026-09-01T10:00"):
    return {"number": n, "title": f"pr {n}", "at": at, "url": f"https://x/{n}", "author": {"login": author, "name": author},
            "reviewers": [{"login": r, "name": r} for r in reviewers], "files": list(files)}


def test_imports_resolve_to_files_of_the_same_repository():
    edges = {(e["src"], e["dst"]) for e in gh.import_edges(FILES)}
    assert ("pkg/core/engine.py", "pkg/util/helpers.py") in edges
    assert ("pkg/core/engine.py", "pkg/store.py") in edges
    assert ("pkg/store.py", "pkg/core/engine.py") in edges
    assert ("web/src/app.ts", "web/src/lib/api.ts") in edges
    assert ("web/src/app.ts", "web/shared/z.js") in edges
    assert ("tests/test_engine.py", "pkg/core/engine.py") in edges


def test_codeowners_last_matching_rule_wins():
    rules = gh.parse_codeowners("* @org/all\n/pkg/ @org/core @ada\ndocs/ @org/docs # writers\n")
    assert gh.owners_of("pkg/core/engine.py", rules) == ["org/core", "ada"]
    assert gh.owners_of("docs/index.md", rules) == ["org/docs"]
    assert gh.owners_of("web/src/app.ts", rules) == ["org/all"]


def test_the_busiest_code_directory_is_opened_up_and_kinds_are_named():
    prs = [pr(i, ["pkg/core/engine.py", "pkg/store.py"]) for i in range(6)] + [pr(9, ["docs/index.md"])]
    mods = gh.layout(prs, sorted(FILES))
    assert "pkg/core" in mods and "pkg/util" in mods
    assert gh.module_of("pkg/core/engine.py", mods) == "pkg/core"
    assert gh.kind_of("tests") == "test" and gh.kind_of("docs") == "docs" and gh.kind_of(".github") == "ci"


def test_a_repository_becomes_people_modules_imports_and_co_changes():
    prs = [pr(i, ["pkg/core/engine.py", "web/src/app.ts"], author="ada" if i % 2 else "cy") for i in range(5)]
    info = {"created": "2024-01-01T00:00", "sha": "abc123", "branch": "main", "name": "o/r"}
    w = repo.build("o", "r", info, prs, "/pkg/ @ada\n", FILES)
    assert {p["handle"] for p in w["people"]} == {"ada", "bob", "cy"}
    mods = {m["name"]: m for m in w["modules"]}
    assert mods["tests"]["kind"] == "test"
    uid = {m["name"]: m["uid"] for m in w["modules"]}
    pairs = {(c["a"], c["b"]) for c in w["cochanges"]}
    assert tuple(sorted((uid[gh.module_of("pkg/core/engine.py", list(mods))], uid[gh.module_of("web/src/app.ts", list(mods))]))) in pairs
    assert any(i["a"] == uid["tests"] for i in w["imports"])
    assert w["members"] and w["members"][0]["a"] == "person:ada"
