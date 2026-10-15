"""Reading a public GitHub repository: merged pull requests with their files and reviews, CODEOWNERS, and the
imports between files at HEAD.

Pull requests come from the GraphQL API, a page of them at a time with their files and reviews in the same
request, so a year of a busy repo costs a handful of calls. The source is the tarball at HEAD from codeload
(no API quota). Everything fetched is cached under data/cache/github/<owner>__<repo>/; merged pull requests
don't change, so a later sync only asks for the new ones.
"""

from __future__ import annotations

import io
import json
import os
import posixpath
import re
import subprocess
import tarfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

CACHE = Path(__file__).resolve().parents[2] / "data" / "cache" / "github"
GRAPHQL = "https://api.github.com/graphql"
PAGE = 25
MAX_TARBALL = 80 * 1024 * 1024
MAX_SOURCE_FILE = 400 * 1024

PULLS = """
query($owner: String!, $name: String!, $cursor: String, $page: Int!) {
  repository(owner: $owner, name: $name) {
    isPrivate createdAt nameWithOwner
    defaultBranchRef { name target { oid } }
    pullRequests(states: MERGED, first: $page, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title mergedAt updatedAt url
        author { __typename login ... on User { name } }
        reviews(first: 30) { nodes { state submittedAt author { __typename login ... on User { name } } } }
        files(first: 100) { nodes { path } }
      }
    }
  }
}"""

OWNERS = """
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    a: object(expression: "HEAD:.github/CODEOWNERS") { ... on Blob { text } }
    b: object(expression: "HEAD:CODEOWNERS") { ... on Blob { text } }
    c: object(expression: "HEAD:docs/CODEOWNERS") { ... on Blob { text } }
  }
}"""


def token() -> str:
    t = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if t:
        return t
    try:
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10)
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


class GitHubError(RuntimeError):
    pass


def graphql(query: str, variables: dict) -> dict:
    tok = token()
    if not tok:
        raise GitHubError("repo mode reads GitHub's GraphQL API, which needs a token: set GITHUB_TOKEN")
    for attempt in range(3):
        r = httpx.post(GRAPHQL, json={"query": query, "variables": variables}, timeout=60,
                       headers={"authorization": f"bearer {tok}", "user-agent": "orion-repo-mode"})
        if r.status_code in (502, 503, 504) and attempt < 2:
            time.sleep(2 * (attempt + 1))
            continue
        if r.status_code == 401:
            raise GitHubError("GitHub refused the token")
        r.raise_for_status()
        body = r.json()
        if body.get("errors"):
            msg = body["errors"][0].get("message", "GitHub error")
            if "Could not resolve to a Repository" in msg:
                raise GitHubError(f"{variables.get('owner')}/{variables.get('name')} not found (or not public)")
            raise GitHubError(msg)
        return body["data"]
    raise GitHubError("GitHub kept timing out")


def _person(a: dict | None) -> dict | None:
    if not a or not a.get("login"):
        return None
    if a.get("__typename") == "Bot" or a["login"].endswith("[bot]") or a["login"].endswith("-bot"):
        return None
    return {"login": a["login"], "name": a.get("name") or a["login"]}


def minute(ts: str | None) -> str | None:
    return ts[:16] if ts else None


def pulls(owner: str, repo: str, since: str, max_prs: int, stop_at: int | None = None) -> tuple[dict, list[dict]]:
    """Merged pull requests merged after `since` (newest first), or only those numbered above `stop_at`."""
    info: dict = {}
    out: dict[int, dict] = {}
    cursor = None
    while True:
        data = graphql(PULLS, {"owner": owner, "name": repo, "cursor": cursor, "page": PAGE})["repository"]
        if data["isPrivate"]:
            raise GitHubError(f"{owner}/{repo} is private; repo mode reads public repositories only")
        info = {"created": minute(data["createdAt"]), "name": data["nameWithOwner"],
                "branch": (data["defaultBranchRef"] or {}).get("name"),
                "sha": ((data["defaultBranchRef"] or {}).get("target") or {}).get("oid")}
        page = data["pullRequests"]
        oldest = None
        for p in page["nodes"]:
            oldest = p["updatedAt"]
            if not p["mergedAt"] or minute(p["mergedAt"]) < since or (stop_at is not None and p["number"] <= stop_at):
                continue
            out[p["number"]] = {
                "number": p["number"], "title": p["title"], "at": minute(p["mergedAt"]), "url": p["url"],
                "author": _person(p["author"]),
                "reviewers": [x for x in {(_person(r["author"]) or {}).get("login"): _person(r["author"])
                                          for r in p["reviews"]["nodes"]}.values() if x],
                "files": [f["path"] for f in (p["files"] or {}).get("nodes", [])],
            }
        if len(out) >= max_prs or not page["pageInfo"]["hasNextPage"] or (oldest and minute(oldest) < since):
            break
        cursor = page["pageInfo"]["endCursor"]
    prs = sorted(out.values(), key=lambda p: (p["at"], p["number"]), reverse=True)[:max_prs]
    return info, prs


def codeowners(owner: str, repo: str) -> str:
    data = graphql(OWNERS, {"owner": owner, "name": repo})["repository"]
    for k in ("a", "b", "c"):
        if data.get(k) and data[k].get("text"):
            return data[k]["text"]
    return ""


def source(owner: str, repo: str, sha: str, cache: Path) -> dict[str, str]:
    """The text of every source file at `sha` (small files only), from the cached tarball when there is one."""
    tar_path = cache / f"{sha}.tar.gz"
    if not tar_path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        buf = io.BytesIO()
        with httpx.stream("GET", f"https://codeload.github.com/{owner}/{repo}/tar.gz/{sha}", timeout=120,
                          follow_redirects=True) as r:
            r.raise_for_status()
            for chunk in r.iter_bytes():
                buf.write(chunk)
                if buf.tell() > MAX_TARBALL:
                    raise GitHubError("the repository is too big to read its imports (over 80 MB)")
        for old in cache.glob("*.tar.gz"):
            old.unlink()
        tar_path.write_bytes(buf.getvalue())
    files: dict[str, str] = {}
    with tarfile.open(tar_path, "r:gz") as tar:
        for m in tar:
            if not m.isfile() or m.size > MAX_SOURCE_FILE:
                continue
            path = m.name.split("/", 1)[1] if "/" in m.name else m.name
            if posixpath.splitext(path)[1].lower() not in SOURCE_EXT:
                files.setdefault(path, "")  # still part of the tree, for CODEOWNERS and modules
                continue
            f = tar.extractfile(m)
            if f:
                files[path] = f.read().decode("utf-8", "replace")
    return files


def since_days(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M")


def cache_dir(owner: str, repo: str) -> Path:
    return CACHE / f"{owner}__{repo}".lower()


def save(owner: str, repo: str, name: str, data) -> None:
    d = cache_dir(owner, repo)
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(json.dumps(data, ensure_ascii=False))


# ---------------------------------------------------------------- modules

ROOT = "(root)"
CONTAINERS = {"src", "lib", "libs", "pkg", "packages", "internal", "crates", "apps", "modules", "services",
              "components", "plugins", "extensions", "contrib"}
MAX_MODULES = 40
MIN_CODE = 6
SPLIT_SHARE = 0.35


def kind_of(module: str) -> str:
    parts = module.lower().split("/")
    words = set(parts) | {p.strip("_.") for p in parts}
    if words & {"test", "tests", "testing", "spec", "specs", "__tests__", "e2e", "benchmarks", "bench", "fuzz"}:
        return "test"
    if words & {"docs", "doc", "documentation", "website", "site", "examples", "example", "tutorials"}:
        return "docs"
    if words & {".github", ".circleci", "ci", ".gitlab", ".buildkite", ".azure-pipelines"}:
        return "ci"
    if words & {"scripts", "tools", "build", "cmake", "dev", "hack", "deploy", "docker", "packaging"}:
        return "build"
    if module == ROOT or words & {"config", "configs", ".vscode", ".devcontainer"}:
        return "config"
    return "code"


def layout(prs: list[dict], tree: list[str]) -> list[str]:
    """Pick the modules: top-level directories, opened up where one directory holds most of the work (or is just
    a container such as src/ or packages/), then the busiest code directory opened further (into its folders, or
    its busiest files) until there are MIN_CODE code modules. At most MAX_MODULES in all."""
    touched = [set(p["files"]) for p in prs]
    every = set(tree) | {f for fs in touched for f in fs}

    def share(m: str) -> float:
        if not touched:
            return 0.0
        return sum(1 for fs in touched if any(f == m or f.startswith(m + "/") for f in fs)) / len(touched)

    alldirs = set()
    for f in every:
        d = posixpath.dirname(f)
        while d:
            alldirs.add(d)
            d = posixpath.dirname(d)

    def children(d: str) -> list[str]:
        return sorted(x for x in alldirs if posixpath.dirname(x) == d)

    def busy_files(d: str) -> list[str]:
        return sorted(f for f in every if posixpath.dirname(f) == d and posixpath.splitext(f)[1] in SOURCE_EXT
                      and share(f) > 0)

    mods = set(children("")) | {ROOT}
    for _ in range(3):
        changed = False
        for m in sorted(mods):
            if m == ROOT or len(mods) >= MAX_MODULES:
                continue
            kids = children(m)
            if kids and (posixpath.basename(m) in CONTAINERS or (kind_of(m) == "code" and share(m) > SPLIT_SHARE)):
                mods.update(kids)  # the directory stays for the files directly in it
                changed = True
        if not changed:
            break
    opened: set[str] = set()
    while len(mods) < MAX_MODULES:
        code = [m for m in mods if m != ROOT and kind_of(m) == "code"]
        if len(code) >= MIN_CODE:
            break
        cands = [m for m in code if m not in opened and m in alldirs and (children(m) or len(busy_files(m)) > 1)]
        if not cands:
            break
        m = max(cands, key=share)
        opened.add(m)
        mods.update(children(m))
        mods.update(busy_files(m)[:MAX_MODULES - len(mods)])
    mods = {m for m in mods if m == ROOT or share(m) > 0 or any(f.startswith(m + "/") for f in tree)}
    if len(mods) > MAX_MODULES:
        ranked = sorted(mods - {ROOT}, key=lambda m: -share(m))
        mods = set(ranked[:MAX_MODULES - 1]) | {ROOT}
    return sorted(mods)


def module_of(path: str, modules: list[str]) -> str:
    if path in modules:
        return path  # a file that is a module of its own
    best = ROOT
    for m in modules:
        if m != ROOT and path.startswith(m + "/") and len(m) > len(best if best != ROOT else ""):
            best = m
    if best == ROOT and "/" in path:
        top = path.split("/", 1)[0]
        return top if top in modules else ROOT
    return best


# ---------------------------------------------------------------- CODEOWNERS

def _rule(pattern: str) -> re.Pattern:
    anchored = pattern.startswith("/")
    p = pattern.strip("/")
    rx = ""
    i = 0
    while i < len(p):
        if p[i:i + 2] == "**":
            rx += ".*"
            i += 2
        elif p[i] == "*":
            rx += "[^/]*"
            i += 1
        elif p[i] == "?":
            rx += "[^/]"
            i += 1
        else:
            rx += re.escape(p[i])
            i += 1
    head = "^" if anchored or "/" in p else r"^(?:.*/)?"
    return re.compile(head + rx + r"(?:/.*)?$")


def parse_codeowners(text: str) -> list[tuple[re.Pattern, list[str]]]:
    rules = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        pattern, *owners = line.split()
        rules.append((_rule(pattern), [o.lstrip("@") for o in owners if o.startswith("@")]))
    return rules


def owners_of(path: str, rules) -> list[str]:
    found: list[str] = []
    for rx, owners in rules:  # the last matching rule wins
        if rx.match(path):
            found = owners
    return found


# ---------------------------------------------------------------- imports

SOURCE_EXT = {".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp",
              ".hh", ".cxx", ".java", ".kt", ".rb"}
JS_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")

RX_PY = re.compile(r"^[ \t]*(?:from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+([^\n#]+)|import[ \t]+([\w., \t]+))", re.M)
RX_JS = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"\n]+)['"]""", re.M)
RX_GO_BLOCK = re.compile(r"^import\s*\(([^)]*)\)", re.M)
RX_GO_ONE = re.compile(r'^import\s+(?:\w+\s+)?"([^"]+)"', re.M)
RX_RS = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:use\s+crate::(\w+)|mod\s+(\w+)\s*;)", re.M)
RX_C = re.compile(r'^\s*#\s*include\s+"([^"]+)"', re.M)
RX_JAVA = re.compile(r"^\s*import\s+(?:static\s+)?([\w.]+)\s*;", re.M)


def _line(text: str, pos: int) -> tuple[int, str]:
    start = text.rfind("\n", 0, pos) + 1
    end = text.find("\n", pos)
    return text.count("\n", 0, pos) + 1, text[start:end if end != -1 else None].strip()[:200]


def import_edges(files: dict[str, str]) -> list[dict]:
    """File-to-file imports found in the source: {src, dst, line, text}. Only imports that resolve to a file of the
    same repository count; third-party packages are not part of the company."""
    paths = set(files)
    py = {}
    for p in paths:
        if p.endswith(".py"):
            dotted = p[:-3].replace("/", ".")
            if dotted.endswith(".__init__"):
                dotted = dotted[:-9]
            parts = dotted.split(".")
            for i in range(len(parts)):  # a.b.c is importable as b.c when a/ is a source root (src/, lib/...)
                py.setdefault(".".join(parts[i:]), p)
    go_mod = next((m.group(1) for p, t in files.items() if p.endswith("go.mod")
                   for m in [re.search(r"^module\s+(\S+)", t, re.M)] if m), None)
    by_suffix: dict[str, list[str]] = {}
    for p in paths:
        by_suffix.setdefault(posixpath.basename(p), []).append(p)
    java = {p[:-5].replace("/", ".").split("java.", 1)[-1]: p for p in paths if p.endswith(".java")}

    out = []

    def add(src: str, dst: str | None, text: str, pos: int):
        if dst and dst != src and dst in paths:
            n, line = _line(text, pos)
            out.append({"src": src, "dst": dst, "line": n, "text": line})

    for path, text in files.items():
        if not text:
            continue
        ext = posixpath.splitext(path)[1].lower()
        here = posixpath.dirname(path)
        if ext == ".py":
            for m in RX_PY.finditer(text):
                dots, mod, names, plain = m.groups()
                if plain:
                    for name in (x.split()[0] for x in plain.split(",") if x.strip()):
                        add(path, _py(name, py), text, m.start())
                    continue
                if dots:
                    base = here
                    for _ in range(len(dots) - 1):
                        base = posixpath.dirname(base)
                    rel = (base.replace("/", ".") + ("." + mod if mod else "")).strip(".")
                    target = _py(rel, py) if rel else None
                    for name in (x.strip(" ()").split(" ")[0] for x in names.split(",")):
                        sub = _py(f"{rel}.{name}".strip("."), py)
                        add(path, sub or target, text, m.start())
                else:  # `from a.b import c`: c may be a module of its own (a/b/c.py) or a name inside a/b
                    for name in (x.strip(" ()").split(" ")[0] for x in names.split(",")):
                        add(path, _py(f"{mod}.{name}", py) if name and name != "*" else _py(mod, py), text, m.start())
        elif ext in JS_EXT:
            for m in RX_JS.finditer(text):
                spec = m.group(1)
                if spec.startswith("."):
                    add(path, _js(posixpath.normpath(posixpath.join(here, spec)), paths), text, m.start())
        elif ext == ".go" and go_mod:
            specs = [(m.start(), s) for m in RX_GO_BLOCK.finditer(text) for s in re.findall(r'"([^"]+)"', m.group(1))]
            specs += [(m.start(), m.group(1)) for m in RX_GO_ONE.finditer(text)]
            for pos, spec in specs:
                if spec.startswith(go_mod + "/"):
                    d = spec[len(go_mod) + 1:]
                    target = next((p for p in sorted(paths) if posixpath.dirname(p) == d and p.endswith(".go")), None)
                    add(path, target, text, pos)
        elif ext == ".rs":
            root = path.split("/src/", 1)[0] + "/src" if "/src/" in path else ("src" if path.startswith("src/") else here)
            for m in RX_RS.finditer(text):
                crate_mod, local_mod = m.groups()
                base = root if crate_mod else here
                name = crate_mod or local_mod
                add(path, next((c for c in (f"{base}/{name}.rs", f"{base}/{name}/mod.rs") if c in paths), None),
                    text, m.start())
        elif ext in (".c", ".h", ".cc", ".cpp", ".hpp", ".hh", ".cxx"):
            for m in RX_C.finditer(text):
                inc = m.group(1)
                local = posixpath.normpath(posixpath.join(here, inc))
                if local in paths:
                    add(path, local, text, m.start())
                else:
                    cands = [p for p in by_suffix.get(posixpath.basename(inc), []) if p.endswith(inc)]
                    if len(cands) == 1:
                        add(path, cands[0], text, m.start())
        elif ext in (".java", ".kt"):
            for m in RX_JAVA.finditer(text):
                name = m.group(1)
                add(path, java.get(name) or java.get(name.rsplit(".", 1)[0]), text, m.start())
    return out


def _py(name: str, idx: dict[str, str]) -> str | None:
    parts = name.split(".")
    for i in range(len(parts), 0, -1):
        hit = idx.get(".".join(parts[:i]))
        if hit:
            return hit
    return None


def _js(base: str, paths: set[str]) -> str | None:
    if base in paths:
        return base
    for ext in JS_EXT:
        if base + ext in paths:
            return base + ext
        if f"{base}/index{ext}" in paths:
            return f"{base}/index{ext}"
    if base.endswith(".js"):  # TypeScript sources imported with their compiled name
        for ext in (".ts", ".tsx"):
            if base[:-3] + ext in paths:
                return base[:-3] + ext
    return None
