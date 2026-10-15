# Cypher queries

Every query Orion runs, recorded by `uv run python -m orion.docgen` while a scripted tour exercises the
whole product (load, epochs, every graph tool, forks, diffs, a merge, live changes, memory, the deck). Grouped
by the module and function that runs it. `$name` is a query parameter.

| Section | Queries |
|---|---|
| [Loading the company](#loading-the-company) | 58 |
| [Epochs: the company on any date](#epochs-the-company-on-any-date) | 26 |
| [Dependency traversal at any depth](#dependency-traversal-at-any-depth) | 3 |
| [Graph algorithms](#graph-algorithms) | 8 |
| [Changes: physical (universe) and temporal (merge) interpreters](#changes-physical-universe-and-temporal-merge-interpreters) | 28 |
| [Universes: fork, diff, approve, merge](#universes-fork-diff-approve-merge) | 25 |
| [Graph tools used by the agents, the API and MCP](#graph-tools-used-by-the-agents-the-api-and-mcp) | 20 |
| [Checking typed claims](#checking-typed-claims) | 2 |
| [Answers and re-checking them](#answers-and-re-checking-them) | 8 |
| [Per-person memory graphs](#per-person-memory-graphs) | 12 |
| [The agents' shared board](#the-agents-shared-board) | 7 |
| [The Sentinel](#the-sentinel) | 3 |
| [What the web app draws](#what-the-web-app-draws) | 17 |

## Loading the company

`orion.load`

### `load`

```cypher
CREATE INDEX FOR (n:Team) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Person) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Service) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Customer) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Project) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Source) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Change) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Ticket) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Message) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Doc) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Decision) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Contradiction) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Alias) ON (n.text)
```

```cypher
CREATE INDEX FOR (n:Answer) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Claim) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Finding) ON (n.uid)
```

```cypher
CREATE INDEX FOR (n:Service) ON (n.name)
```

```cypher
CREATE INDEX FOR (n:Person) ON (n.name)
```

```cypher
CREATE INDEX FOR ()-[r:DEPENDS_ON]-() ON (r.uid)
```

```cypher
CREATE INDEX FOR ()-[r:OWNS]-() ON (r.uid)
```

```cypher
CREATE INDEX FOR ()-[r:MEMBER_OF]-() ON (r.uid)
```

```cypher
CREATE FULLTEXT INDEX FOR (n:Source) ON (n.text, n.title)
```

```cypher
CREATE FULLTEXT INDEX FOR (n:Alias) ON (n.text)
```

```cypher
CREATE (:Company {tenant: $t, name: $n, clock: $c})
```

### `run`

```cypher
UNWIND $rows AS r CREATE (:Team {uid: r.uid, name: r.name, mission: r.mission, created: r.created})
```

```cypher
UNWIND $rows AS r CREATE (:Person {uid: r.uid, name: r.name, first: r.first, handle: r.handle,
           role: r.role, joined: r.joined, left: r.left})
```

```cypher
UNWIND $rows AS r CREATE (:Service {uid: r.uid, name: r.name, tier: r.tier, lang: r.lang,
           created: r.created, retired: r.retired, summary: r.summary})
```

```cypher
UNWIND $rows AS r CREATE (:Customer {uid: r.uid, name: r.name, tier: r.tier, industry: r.industry,
           since: r.since})
```

```cypher
UNWIND $rows AS r CREATE (:Project {uid: r.uid, name: r.name, status: r.status, started: r.started,
           ended: r.ended})
```

```cypher
UNWIND $rows AS r CREATE (:Source:Doc {uid: r.uid, kind: r.kind, title: r.title, at: r.at, text: r.text,
           day: r.day}) WITH r MATCH (s:Doc {uid: r.uid}), (p:Person {uid: r.author}) CREATE (s)-[:WRITTEN_BY]->(p)
```

```cypher
UNWIND $rows AS r CREATE (:Source:Message {uid: r.uid, kind: 'message', channel: r.channel, at: r.at,
           text: r.text, title: r.channel, day: r.day})
           WITH r MATCH (m:Message {uid: r.uid}), (p:Person {uid: r.author}) CREATE (m)-[:POSTED_BY]->(p)
```

```cypher
UNWIND $rows AS r CREATE (:Source:Change {uid: r.uid, kind: 'change', key: r.key, title: r.title,
           at: r.at, day: r.day, text: r.title})
```

```cypher
UNWIND $rows AS r MATCH (c:Change {uid: r.uid}), (p:Person {uid: r.author})
           CREATE (p)-[:AUTHORED {at: r.at}]->(c)
```

```cypher
UNWIND $rows AS r MATCH (c:Change {uid: r.c}), (p:Person {uid: r.p}) CREATE (p)-[:REVIEWED {at: r.at}]->(c)
```

```cypher
UNWIND $rows AS r MATCH (c:Change {uid: r.c}), (s:Service {uid: r.s}) CREATE (c)-[:MODIFIES]->(s)
```

```cypher
UNWIND $rows AS r CREATE (:Source:Ticket {uid: r.uid, kind: r.kind, key: r.key, title: r.title,
           text: r.title, priority: r.priority, status: r.status, at: r.opened, opened: r.opened, closed: r.closed,
           day: r.day})
```

```cypher
UNWIND $rows AS r MATCH (t:Ticket {uid: r.t}), (s:Service {uid: r.s}) CREATE (t)-[:ABOUT]->(s)
```

```cypher
UNWIND $rows AS r MATCH (t:Ticket {uid: r.t}), (c:Customer {uid: r.c}) CREATE (t)-[:RAISED_BY]->(c)
```

```cypher
UNWIND $rows AS r MATCH (t:Ticket {uid: r.t}), (p:Person {uid: r.p}) CREATE (t)-[:ASSIGNED_TO]->(p)
```

```cypher
UNWIND $rows AS r MATCH (a:Ticket {uid: r.a}), (b:Ticket {uid: r.b}) CREATE (a)-[:BLOCKS]->(b)
```

```cypher
UNWIND $rows AS r MATCH (p:Person {uid: r.a}), (t:Team {uid: r.b})
           CREATE (p)-[:MEMBER_OF {uid: r.uid, valid_from: r.valid_from, valid_to: r.valid_to,
                  recorded_at: r.recorded_at, src: r.source}]->(t)
```

```cypher
UNWIND $rows AS r MATCH (t:Team {uid: r.a}), (s:Service {uid: r.b})
           CREATE (t)-[:OWNS {uid: r.uid, valid_from: r.valid_from, valid_to: r.valid_to, recorded_at: r.recorded_at,
                  src: r.source, declared: r.declared}]->(s)
```

```cypher
UNWIND $rows AS r MATCH (a:Service {uid: r.a}), (b:Service {uid: r.b})
           CREATE (a)-[:DEPENDS_ON {uid: r.uid, kind: r.kind, valid_from: r.valid_from, valid_to: r.valid_to,
                  recorded_at: r.recorded_at, src: r.source}]->(b)
```

```cypher
UNWIND $rows AS r MATCH (c:Customer {uid: r.customer}), (s:Service {uid: r.service})
           CREATE (c)-[:USES {uid: r.uid, valid_from: r.valid_from, valid_to: r.valid_to, recorded_at: r.valid_from,
                  src: 'doc:contracts'}]->(s)
```

```cypher
UNWIND $rows AS r MATCH (p:Person {uid: r.a}), (j:Project {uid: r.b})
           CREATE (p)-[:WORKED_ON {uid: r.uid, valid_from: r.valid_from, valid_to: r.valid_to,
                  recorded_at: r.recorded_at, src: r.source}]->(j)
```

```cypher
UNWIND $rows AS r MATCH (j:Project {uid: r.project}), (s:Service {uid: r.service}) CREATE (j)-[:TOUCHES]->(s)
```

```cypher
UNWIND $rows AS r CREATE (:Decision {uid: r.uid, key: r.key, title: r.title, status: r.status, at: r.at,
           summary: r.summary, day: r.day})
```

```cypher
UNWIND $rows AS r MATCH (d:Decision {uid: r.d}), (p:Person {uid: r.p}) CREATE (d)-[:DECIDED_BY]->(p)
```

```cypher
UNWIND $rows AS r MATCH (d:Decision {uid: r.d}), (t:Team {uid: r.t}) CREATE (d)-[:MADE_BY]->(t)
```

```cypher
UNWIND $rows AS r MATCH (d:Decision {uid: r.d}), (s:Service {uid: r.s}) CREATE (d)-[:AFFECTS]->(s)
```

```cypher
UNWIND $rows AS r MATCH (d:Decision {uid: r.d}), (s:Source {uid: r.s}) CREATE (d)-[:EVIDENCED_BY]->(s)
```

```cypher
UNWIND $rows AS r MATCH (a:Decision {uid: r.a}), (b:Decision {uid: r.b})
           CREATE (a)-[:SUPERSEDES {how: r.how, at: r.at}]->(b)
```

```cypher
UNWIND $rows AS r CREATE (c:Contradiction {uid: r.uid, topic: r.topic, at: r.at, status: 'open'})
           WITH c, r MATCH (a:Source {uid: r.a}), (b:Source {uid: r.b}) CREATE (c)-[:BETWEEN]->(a), (c)-[:BETWEEN]->(b)
```

```cypher
UNWIND $rows AS r MATCH (c:Contradiction {uid: r.c}), (s:Service {uid: r.s}) CREATE (c)-[:ABOUT]->(s)
```

```cypher
UNWIND $rows AS r MATCH (m:Message {uid: r.m}), (c:Change {uid: r.c}) CREATE (m)-[:REFERS_TO]->(c)
```

```cypher
UNWIND $rows AS r MATCH (n {uid: r.uid}) MERGE (a:Alias {text: r.text}) CREATE (a)-[:NAMES]->(n)
```

```cypher
UNWIND $rows AS r MATCH (s:Source {uid: r.s}), (e {uid: r.e}) CREATE (s)-[:MENTIONS]->(e)
```

### `load`

```cypher
MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS edges
```

## Epochs: the company on any date

`orion.epoch`

### `build`: Copy the org graph and prune it to `on`. mode 'known' also drops facts recorded after the date: the company

```cypher
MATCH (n:Answer) DETACH DELETE n
```

```cypher
MATCH (n:Claim) DETACH DELETE n
```

```cypher
MATCH (n:Finding) DETACH DELETE n
```

```cypher
MATCH ()-[r]->() WHERE r.valid_from IS NOT NULL AND (r.valid_from > $d OR r.valid_to <= $d) DELETE r
```

```cypher
MATCH (s:Source) WHERE s.at > $d DETACH DELETE s
```

```cypher
MATCH (x:Decision) WHERE x.at > $d DETACH DELETE x
```

```cypher
MATCH (x:Contradiction) WHERE x.at > $d DETACH DELETE x
```

```cypher
MATCH (p:Person) WHERE p.joined > $d DETACH DELETE p
```

```cypher
MATCH (s:Service) WHERE s.created > $d DETACH DELETE s
```

```cypher
MATCH (c:Customer) WHERE c.since > $d DETACH DELETE c
```

```cypher
MATCH (j:Project) WHERE j.started > $d DETACH DELETE j
```

```cypher
MATCH (t:Ticket) WHERE t.closed > $d SET t.status = 'open'
```

```cypher
MATCH (x:Decision) SET x.status = 'accepted'
```

```cypher
MATCH (a:Decision)-[s:SUPERSEDES]->(b:Decision)
       SET b.status = CASE s.how WHEN 'reverses' THEN 'reversed' ELSE 'superseded' END
```

```cypher
MATCH (j:Project) WHERE j.ended > $d SET j.status = CASE j.status WHEN 'done' THEN 'active' ELSE j.status END
```

```cypher
MATCH (p:Person) WHERE p.left <= $d SET p:Former REMOVE p:Person
```

```cypher
MATCH (s:Service) WHERE s.retired <= $d SET s:Retired REMOVE s:Service
```

```cypher
MATCH (t:Team) WHERE t.dissolved <= $d SET t:FormerTeam REMOVE t:Team
```

```cypher
MATCH (p:Person)-[:AUTHORED|REVIEWED]->(c:Change)-[:MODIFIES]->(s:Service)
WHERE c.day > $day - $window
WITH p, s, count(c) AS n
WHERE n >= $min
CREATE (p)-[:KNOWS {n: n}]->(s)
```

```cypher
MATCH (a:Person)-[:AUTHORED|REVIEWED]->(c:Change)<-[:AUTHORED|REVIEWED]-(b:Person)
WHERE a.uid < b.uid AND c.day > $day - 365
WITH a, b, sum(2.0 * exp(-$k * ($day - c.day))) AS w, count(c) AS shared
WHERE w >= $min
CREATE (a)-[:COLLABORATES {w: w, inv: 1.0 / w, cost: 1.0 + 3.0 / w, shared: shared}]->(b),
       (b)-[:COLLABORATES {w: w, inv: 1.0 / w, cost: 1.0 + 3.0 / w, shared: shared}]->(a)
```

```cypher
MATCH (a:Person)-[r:COLLABORATES]->(b:Person)
MATCH (a)-[:MEMBER_OF]->(ta:Team)
MATCH (b)-[:MEMBER_OF]->(tb:Team)
WHERE ta.uid <> tb.uid
CREATE (a)-[:BRIDGES {w: r.w}]->(b)
```

```cypher
MATCH ()-[r:DEPENDS_ON|OWNS|MEMBER_OF]->() SET r.cost = 1.0
```

```cypher
MATCH ()-[r:KNOWS]->() SET r.cost = 1.0 + 3.0 / r.n
```

```cypher
MATCH ()-[r:WORKED_ON|TOUCHES|USES]->() SET r.cost = 2.0
```

```cypher
MATCH (c:Company) SET c.on = $d, c.mode = $m, c.version = $v
```

```cypher
MATCH ()-[r]->() WHERE r.recorded_at IS NOT NULL AND r.recorded_at > $d DELETE r
```

## Dependency traversal at any depth

`orion.impact`

### `walk`: Every service that transitively depends on `roots`: {uid: {name, tier, effect, depth, path, facts}}.

```cypher
MATCH (d:Service)-[r:DEPENDS_ON]->(s)
WHERE s.uid IN $frontier
RETURN d.uid AS dependent, d.name AS name, d.tier AS tier, s.uid AS on, r.kind AS kind, r.uid AS fact
```

### `names`

```cypher
MATCH (n) WHERE n.uid IN $u RETURN n.uid AS uid, n.name AS name
```

### `walk`: Every service that transitively depends on `roots`: {uid: {name, tier, effect, depth, path, facts}}.

```cypher
MATCH (d:Service)-[r:DEPENDS_ON]->(s)
WHERE s.uid IN $frontier AND r.valid_from <= $on AND r.valid_to > $on AND d.created <= $on AND d.retired > $on
  AND ($known = false OR r.recorded_at <= $on)
RETURN d.uid AS dependent, d.name AS name, d.tier AS tier, s.uid AS on, r.kind AS kind, r.uid AS fact
```

## Graph algorithms

`orion.algos`

### `hidden_teams`: People who work together across team lines (WCC over BRIDGES): three or more people from two or more teams

```cypher
CALL algo.WCC({nodeLabels: ['Person'], relationshipTypes: ['BRIDGES']})
YIELD node, componentId
MATCH (node)-[:MEMBER_OF]->(t:Team)
RETURN componentId AS c, node.uid AS uid, node.name AS name, t.uid AS team, t.name AS team_name
```

```cypher
MATCH (p:Person)-[:WORKED_ON]->(j:Project) WHERE p.uid IN $u
                                 WITH j, count(p) AS n WHERE n >= 2 RETURN j.uid AS uid, j.name AS name, n
                                 ORDER BY n DESC
```

### `influence`

```cypher
CALL algo.pageRank('Service', 'DEPENDS_ON')
YIELD node, score
RETURN node.uid AS uid, node.name AS name, score
ORDER BY score DESC
```

### `bottlenecks`

```cypher
CALL algo.betweenness({nodeLabels: ['Person'], relationshipTypes: ['COLLABORATES']})
YIELD node, score
RETURN node.uid AS uid, node.name AS name, score
ORDER BY score DESC, uid
LIMIT $k
```

### `constellations`

```cypher
CALL algo.MSF({nodeLabels: ['Person'], relationshipTypes: ['COLLABORATES'], weightAttribute: 'inv'})
YIELD edges
UNWIND edges AS e
RETURN startNode(e).uid AS a, endNode(e).uid AS b, e.w AS w
```

### `communities`: Groups of people who actually work together (label propagation over COLLABORATES), and how they map onto

```cypher
CALL algo.labelPropagation({nodeLabels: ['Person'], relationshipTypes: ['COLLABORATES'], maxIterations: 20})
YIELD node, communityId
MATCH (node)-[:MEMBER_OF]->(t:Team)
RETURN communityId AS c, node.uid AS uid, node.name AS name, t.uid AS team
```

### `stranded`: Groups of services that lose every path to a team: no owner, nobody who knows them, nothing owned depends

```cypher
CALL algo.WCC({nodeLabels: ['Service', 'Person', 'Team'], relationshipTypes: ['DEPENDS_ON', 'KNOWS', 'MEMBER_OF', 'OWNS']})
YIELD node, componentId
RETURN componentId AS c, labels(node)[0] AS label, node.uid AS uid, node.name AS name
```

### `collab_groups`

```cypher
CALL algo.WCC({nodeLabels: ['Person'], relationshipTypes: ['COLLABORATES']})
YIELD node, componentId
RETURN componentId AS c, node.uid AS uid, node.name AS name
```

## Changes: physical (universe) and temporal (merge) interpreters

`orion.ops`

### `resolver`

```cypher
MATCH (a:Alias)-[:NAMES]->(n) RETURN a.text AS t, n.uid AS u, labels(n)[0] AS k
```

### `_p_retire`

```cypher
MATCH (:Service {uid: $s})-[r:DEPENDS_ON]->() DELETE r
```

```cypher
MATCH (:Team)-[r:OWNS]->(:Service {uid: $s}) DELETE r
```

```cypher
MATCH (:Person)-[r:KNOWS]->(:Service {uid: $s}) DELETE r
```

```cypher
MATCH (n:Service {uid: $s}) SET n:Retired REMOVE n:Service
```

### `_rederive_bridges`

```cypher
MATCH ()-[r:BRIDGES]->() DELETE r
```

```cypher
MATCH (a:Person)-[r:COLLABORATES]->(b:Person)
MATCH (a)-[:MEMBER_OF]->(ta:Team)
MATCH (b)-[:MEMBER_OF]->(tb:Team)
WHERE ta.uid <> tb.uid
CREATE (a)-[:BRIDGES {w: r.w}]->(b)
```

### `title`

```cypher
MATCH (n) WHERE n.uid IN $u RETURN n.uid AS uid, n.name AS name
```

### `_p_remove_person`

```cypher
MATCH (:Person {uid: $p})-[r:MEMBER_OF]->() DELETE r
```

```cypher
MATCH (:Person {uid: $p})-[r:KNOWS]->() DELETE r
```

```cypher
MATCH (:Person {uid: $p})-[r:WORKED_ON]->() DELETE r
```

```cypher
MATCH (:Person {uid: $p})-[r:COLLABORATES|BRIDGES]-() DELETE r
```

```cypher
MATCH (n:Person {uid: $p}) SET n:Former REMOVE n:Person
```

### `_p_merge_teams`

```cypher
MATCH (p:Person)-[r:MEMBER_OF]->(:Team {uid: $a}) MATCH (t:Team {uid: $b})
               CREATE (p)-[:MEMBER_OF {uid: 'mem:' + substring(p.uid, 7) + '->' + substring($b, 5) + '@' + $at, cost: 1.0}]->(t)
               DELETE r
```

```cypher
MATCH (:Team {uid: $a})-[r:OWNS]->(s:Service) MATCH (t:Team {uid: $b})
               CREATE (t)-[:OWNS {uid: 'own:' + substring($b, 5) + '->' + substring(s.uid, 4) + '@' + $at, cost: 1.0}]->(s)
               DELETE r
```

```cypher
MATCH (t:Team {uid: $a}) SET t:FormerTeam REMOVE t:Team
```

### `_p_move_ownership`

```cypher
MATCH (t:Team {uid: $t}), (s:Service {uid: $s})
               CREATE (t)-[:OWNS {uid: 'own:' + substring($t, 5) + '->' + substring($s, 4) + '@' + $at, cost: 1.0}]->(s)
```

### `_p_add_dep`

```cypher
MATCH (a:Service {uid: $a}), (b:Service {uid: $b})
               MERGE (a)-[r:DEPENDS_ON]->(b)
               ON CREATE SET r.uid = 'dep:' + substring($a, 4) + '->' + substring($b, 4) + '@' + $at, r.cost = 1.0
               SET r.kind = $k
```

### `_p_retire`

```cypher
MATCH (d:Service)-[r:DEPENDS_ON]->(:Service {uid: $s})
                   MATCH (n:Service {uid: $n}) WHERE d.uid <> $n
                   MERGE (d)-[x:DEPENDS_ON]->(n)
                   ON CREATE SET x.uid = 'dep:' + substring(d.uid, 4) + '->' + substring(n.uid, 4) + '@' + $at,
                                 x.kind = r.kind, x.cost = 1.0
                   DELETE r
```

### `_t_retire`

```cypher
MATCH (d:Service)-[r:DEPENDS_ON]->(:Service {uid: $s})
                          WHERE r.valid_to = '9999-12-31' AND d.uid <> $n AND d.retired = '9999-12-31'
                          RETURN d.uid AS d, r.kind AS kind
```

### `_close`

```cypher
MATCH (:Service {uid: $d})-[r:DEPENDS_ON]->(:Service {uid: $s}) WHERE r.valid_to = '9999-12-31' AND r.valid_from <= $at SET r.valid_to = $at, r.closed_by = $dec
```

### `_open`

```cypher
MATCH (:Service {uid: $a})-[o:DEPENDS_ON]->(:Service {uid: $b})
                       WHERE o.valid_to = '9999-12-31' RETURN count(o) AS n
```

```cypher
MATCH (x:Service {uid: $a}), (y:Service {uid: $b})
                CREATE (x)-[:DEPENDS_ON {uid: $uid, valid_from: $at, valid_to: '9999-12-31', recorded_at: $at,
                                    src: $dec, kind: $kind}]->(y)
```

### `_close`

```cypher
MATCH (:Service {uid: $s})-[r:DEPENDS_ON]->() WHERE r.valid_to = '9999-12-31' AND r.valid_from <= $at SET r.valid_to = $at, r.closed_by = $dec
```

```cypher
MATCH (:Team)-[r:OWNS]->(:Service {uid: $s}) WHERE r.valid_to = '9999-12-31' AND r.valid_from <= $at SET r.valid_to = $at, r.closed_by = $dec
```

### `_t_retire`

```cypher
MATCH (n:Service {uid: $s}) SET n.retired = $at, n.retired_by = $dec
```

### `_t_add_dep`

```cypher
MATCH (:Service {uid: $a})-[r:DEPENDS_ON]->(:Service {uid: $b})
                     WHERE r.valid_to = '9999-12-31' RETURN r.kind AS kind
```

### `_close`

```cypher
MATCH (:Service {uid: $a})-[r:DEPENDS_ON]->(:Service {uid: $b}) WHERE r.valid_to = '9999-12-31' AND r.valid_from <= $at SET r.valid_to = $at, r.closed_by = $dec
```

## Universes: fork, diff, approve, merge

`orion.universe`

### `_services`

```cypher
MATCH (s:Service) OPTIONAL MATCH (t:Team)-[:OWNS]->(s)
                                             RETURN s.uid AS uid, s.name AS name, s.tier AS tier, t.uid AS owner,
                                                    t.name AS owner_name
```

### `_dangling`: Running services that still depend on something switched off.

```cypher
MATCH (d:Service)-[r:DEPENDS_ON]->(s:Retired)
                       RETURN d.uid AS dependent, d.name AS dependent_name, s.uid AS on, s.name AS on_name,
                              r.kind AS kind, r.uid AS fact ORDER BY dependent
```

### `diff`

```cypher
MATCH (c:Customer)-[:USES]->(s:Service) WHERE s.uid IN $u
                               RETURN c.uid AS uid, c.name AS name, c.tier AS tier, s.uid AS via, null AS ticket
                               UNION
                               MATCH (c:Customer)<-[:RAISED_BY]-(k:Ticket)-[:ABOUT]->(s:Service)
                               WHERE s.uid IN $b AND k.at >= $since
                               RETURN c.uid AS uid, c.name AS name, c.tier AS tier, s.uid AS via, k.key AS ticket
```

### `_orphans`

```cypher
MATCH (s:Service) WHERE NOT ()-[:KNOWS]->(s) RETURN s.uid AS uid
```

### `diff`

```cypher
MATCH (p:Former) RETURN p.uid AS uid
```

### `_edges`

```cypher
MATCH (a)-[r:DEPENDS_ON|OWNS|MEMBER_OF]->(b) WHERE NOT b:Retired
                       RETURN type(r) AS rel, a.uid AS a, b.uid AS b, r.kind AS kind
```

### `diff`

```cypher
MATCH (t:Team) RETURN t.uid AS uid, t.name AS name
```

### `_deck`

```cypher
CREATE INDEX FOR (u:Universe) ON (u.uid)
```

```cypher
CREATE INDEX FOR (a:Approval) ON (a.universe)
```

### `_save`

```cypher
MERGE (u:Universe {uid: $uid})
               SET u.graph = $graph, u.kind = $kind, u.title = $title, u.ops = $ops, u.by = $by, u.question = $question,
                   u.created_at = $created_at, u.base_version = $base_version, u.status = $status, u.risk = $risk,
                   u.level = $level, u.diff = $diff, u.ms = $ms, u.required = $required, u.on = $on, u.mode = $mode
```

### `_finding`: Leave what was learned in the org graph, attached to the entities it is about, so the next question about

```cypher
CREATE (f:Finding {uid: $uid, universe: $u, title: $title, risk: $risk, level: $level,
                                         at: $at, summary: $summary, ops: $ops, by: $by})
                        WITH f UNWIND $about AS a MATCH (n {uid: a}) CREATE (f)-[:ABOUT]->(n)
```

### `diff`

```cypher
MATCH (p:Person)-[:KNOWS]->(:Service {uid: $s}) RETURN p.name AS name
```

```cypher
MATCH (:Person {uid: $p})-[:MEMBER_OF]->(t:Team) RETURN t.uid AS t
```

### `get`

```cypher
MATCH (u:Universe {uid: $u}) RETURN u
```

```cypher
MATCH (a:Approval {universe: $u}) RETURN a.team AS team, a.by AS by,
                                       a.by_name AS by_name, a.at AS at ORDER BY a.at
```

### `who`: A person and the team they are on now.

```cypher
MATCH (p:Person {uid: $u}) OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
                                    RETURN p.uid AS uid, p.name AS name, p.role AS role, t.uid AS team, t.name AS team_name
```

### `approve`: Record an approval for the approver's team. When every required team has approved, merge. A universe that

```cypher
CREATE (:Approval {universe: $u, team: $team, by: $by, by_name: $name, at: $at})
```

### `merge`: Replay the ops into the org graph as facts with a Decision as their source. Resumable: the index of the

```cypher
MATCH (u:Universe {uid: $u}) RETURN u.status AS s, u.applied AS applied, u.decision AS dec
```

```cypher
MATCH (u:Universe {uid: $u}) WHERE u.status = 'open' SET u.status = 'merging', u.applied = 0
```

```cypher
MERGE (d:Decision {uid: $uid})
                   ON CREATE SET d.key = $key, d.title = $title, d.status = 'accepted', d.at = $at, d.day = $day,
                                 d.summary = $summary, d.universe = $u, d.forced = $forced
                   WITH d UNWIND $approvers AS a MATCH (p:Person {uid: a}) MERGE (d)-[:DECIDED_BY]->(p)
```

```cypher
MATCH (d:Decision {uid: $d}) UNWIND $s AS s MATCH (x:Service {uid: s}) MERGE (d)-[:AFFECTS]->(x)
```

```cypher
MATCH (d:Decision {uid: $d}) UNWIND $t AS t MATCH (x:Team {uid: t}) MERGE (d)-[:MADE_BY]->(x)
```

```cypher
MATCH (u:Universe {uid: $u}) SET u.decision = $d
```

```cypher
MATCH (u:Universe {uid: $u}) SET u.applied = $i
```

```cypher
MATCH (u:Universe {uid: $u}) SET u.status = 'merged', u.merged_at = $at, u.merged_by = $by
```

## Graph tools used by the agents, the API and MCP

`orion.tools`

### `read`

```cypher
MATCH (n) WHERE n.uid IN $u
                               RETURN n.uid AS uid, labels(n)[0] AS label, coalesce(n.name, n.key) AS name
```

```cypher
CALL db.idx.fulltext.queryNodes('Source', $q) YIELD node, score
                                  WHERE NOT node:Change
                                  RETURN node.uid AS uid, labels(node)[1] AS kind, coalesce(node.title, node.channel) AS title,
                                         node.at AS at, left(node.text, 220) AS text, score
                                  ORDER BY score DESC LIMIT 6
```

### `one`

```cypher
MATCH (n {uid: $u}) RETURN n.uid AS uid, labels(n) AS labels, coalesce(n.name, n.key, n.title) AS name
```

### `read`

```cypher
MATCH (a)-[r:DEPENDS_ON]->(b) WHERE r.uid IN $f
                                                    OPTIONAL MATCH (src:Source {uid: r.src})
                                                    RETURN r.uid AS uid, r.src AS src, src.title AS src_title,
                                                           r.recorded_at AS recorded_at, r.valid_from AS valid_from
```

```cypher
MATCH (p:Person)-[k:KNOWS]->(s:Service {uid: $s}) OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
                                RETURN p.uid AS uid, p.name AS name, t.name AS team, k.n AS changes
                                ORDER BY changes DESC
```

```cypher
MATCH (t:Team)-[:OWNS]->(:Service {uid: $s}) RETURN t.uid AS uid, t.name AS team
```

```cypher
MATCH (p:Former)-[:AUTHORED|REVIEWED]->(c:Change)-[:MODIFIES]->(:Service {uid: $s})
                                 RETURN p.uid AS uid, p.name AS name, p.left AS left, count(c) AS changes, max(c.at) AS last
                                 ORDER BY changes DESC
```

```cypher
MATCH (s:Service) OPTIONAL MATCH (p:Person)-[:KNOWS]->(s)
                               OPTIONAL MATCH (t:Team)-[:OWNS]->(s)
                               WITH s, t, collect(p.name) AS knowers, collect(p.uid) AS knower_uids
                               WHERE size(knowers) <= 1
                               RETURN s.uid AS uid, s.name AS name, s.tier AS tier, t.name AS owner, knowers, knower_uids
                               ORDER BY size(knowers), s.tier, s.name
```

```cypher
MATCH (d:Decision)-[:AFFECTS]->({uid: $u})
                                OPTIONAL MATCH (d)-[:MADE_BY]->(t:Team)
                                OPTIONAL MATCH (d)-[:DECIDED_BY]->(p)
                                OPTIONAL MATCH (d)-[s:SUPERSEDES]->(old:Decision)
                                OPTIONAL MATCH (newer:Decision)-[s2:SUPERSEDES]->(d)
                                OPTIONAL MATCH (d)-[:EVIDENCED_BY]->(src:Source)
                                RETURN d.uid AS uid, d.key AS key, d.title AS title, d.status AS status, d.at AS at,
                                       d.summary AS summary, t.name AS team, collect(DISTINCT p.name) AS decided_by,
                                       old.key AS supersedes, s.how AS how, newer.key AS superseded_by, s2.how AS by_how,
                                       collect(DISTINCT {uid: src.uid, title: coalesce(src.title, src.channel),
                                                         at: src.at, text: left(src.text, 200)}) AS sources
                                ORDER BY at
```

```cypher
MATCH (x)-[r]->(y) WHERE ((x.uid = $a AND y.uid = $b) OR (x.uid = $b AND y.uid = $a)) AND r.src IS NOT NULL
                                OPTIONAL MATCH (src:Source {uid: r.src})
                                OPTIONAL MATCH (src)-[:POSTED_BY|WRITTEN_BY]->(author:Person)
                                OPTIONAL MATCH (dec:Decision {uid: r.src})
                                OPTIONAL MATCH (closer:Decision {uid: r.closed_by})
                                RETURN r.uid AS uid, type(r) AS rel, x.name AS from, y.name AS to, r.kind AS kind,
                                       r.valid_from AS valid_from, r.valid_to AS valid_to, r.recorded_at AS recorded_at,
                                       r.src AS source_uid, coalesce(src.title, src.channel, dec.title) AS source,
                                       src.at AS source_at, left(src.text, 300) AS source_text, author.name AS author,
                                       closer.key AS closed_by
                                ORDER BY valid_from DESC LIMIT 60
```

```cypher
MATCH (cu:Customer {uid: $c})<-[:RAISED_BY]-(t:Ticket)
                                  OPTIONAL MATCH (t)-[:ABOUT]->(s:Service)
                                  OPTIONAL MATCH chain = (b:Ticket)-[:BLOCKS*1..4]->(t) WHERE b.status = 'open'
                                  RETURN t.uid AS uid, t.key AS key, t.title AS title, t.kind AS kind, t.status AS status,
                                         t.opened AS opened, collect(DISTINCT s.name) AS services,
                                         collect(DISTINCT [n IN nodes(chain) | n.key]) AS blocked_by
                                  ORDER BY opened DESC LIMIT 20
```

```cypher
MATCH (:Customer {uid: $c})-[:USES]->(s:Service) RETURN s.uid AS uid, s.name AS name
```

### `customer_story`: A customer's tickets, what is blocking the open ones (any depth), and the services they use.

```cypher
MATCH (c:Customer {uid: $c}) RETURN c.tier AS tier, c.industry AS industry, c.since AS since
```

### `read`

```cypher
MATCH (t:Team)-[:OWNS]->(s:Service)
                               MATCH (p:Person)-[:AUTHORED]->(c:Change)-[:MODIFIES]->(s) WHERE c.at >= $since
                               MATCH (p)-[:MEMBER_OF]->(pt:Team)
                               WITH s, t, pt, count(c) AS n
                               ORDER BY n DESC
                               WITH s, t, collect({team: pt.name, team_uid: pt.uid, n: n}) AS by_team
                               WITH s, t, by_team, by_team[0] AS top
                               WHERE top.team_uid <> t.uid
                               RETURN s.uid AS uid, s.name AS service, t.name AS declared_owner, top.team AS actually,
                                      top.n AS changes, by_team
```

```cypher
MATCH (d:Doc)-[:MENTIONS]->(s:Service) WHERE s.uid IN $u
                               RETURN d.uid AS uid, d.title AS doc, d.at AS at, s.name AS service
```

```cypher
MATCH (c:Contradiction {status: 'open'})-[:BETWEEN]->(s:Source)
                               OPTIONAL MATCH (s)-[:POSTED_BY]->(p:Person)
                               OPTIONAL MATCH (c)-[:ABOUT]->(e)
                               RETURN c.uid AS uid, c.topic AS topic, c.at AS at,
                                      collect(DISTINCT {uid: s.uid, at: s.at, text: s.text, author: p.name}) AS sides,
                                      collect(DISTINCT e.uid) AS about_uids
```

```cypher
MATCH (x {uid: $a}), (y {uid: $b})
                               WITH x, y MATCH p = allShortestPaths((x)-[:DEPENDS_ON|OWNS|MEMBER_OF|KNOWS|COLLABORATES|WORKED_ON|TOUCHES|USES*..6]-(y))
                               RETURN [n IN nodes(p) | n.uid] AS path_uids,
                                      [n IN nodes(p) | coalesce(n.name, n.key)] AS path,
                                      [r IN relationships(p) | type(r)] AS rels LIMIT 3
```

```cypher
MATCH (s:Service) WITH collect(s.name) AS services
                         MATCH (p:Person) WITH services, count(p) AS people
                         OPTIONAL MATCH (d:Decision) WHERE d.status = 'accepted'
                         RETURN services, people, collect(d.key) AS decisions
```

### `checkout`: The company as it stood on a date (or as it was known that day): who was here, what ran, what has changed

```cypher
MATCH (s:Service) RETURN collect(s.name) AS services
```

### `read`

```cypher
MATCH (f:Finding)-[:ABOUT]->({uid: $u})
                               RETURN f.uid AS uid, f.universe AS universe, f.title AS title, f.risk AS risk,
                                      f.level AS level, f.at AS at, f.summary AS summary
                               ORDER BY at DESC LIMIT 5
```

## Checking typed claims

`orion.claims`

### `_names`

```cypher
MATCH (n) WHERE n.uid IS NOT NULL AND (n:Person OR n:Service OR n:Team OR n:Customer OR n:Decision) RETURN n.uid AS uid, coalesce(n.name, n.key) AS name
```

### `truth`: What the graph says, for the claim's subject: a set of uids, a status, or a number. Plus how it found out.

```cypher
MATCH (p:Person)-[:KNOWS]->(:Service {uid: $s}) RETURN p.uid AS uid
```

## Answers and re-checking them

`orion.watch`

### `store`

```cypher
CREATE (a:Answer {uid: $uid, question: $q, qnorm: $qn, text: $text, at: $at, session: $session,
                                 status: 'fresh', payload: $payload, asked_by: $user})
```

```cypher
MATCH (a:Answer {uid: $a}), (p:Person {uid: $u}) CREATE (p)-[:ASKED]->(a)
```

```cypher
MATCH (a:Answer {uid: $a})
                   CREATE (a)-[:MAKES]->(c:Claim {uid: $uid, i: $i, sentence: $sentence, type: $type, status: $status,
                                                  claim: $claim, result: $result, checked_at: $at, history: '[]'})
```

```cypher
MATCH (c:Claim {uid: $c}) UNWIND $about AS u MATCH (n {uid: u}) CREATE (c)-[:ABOUT]->(n)
```

### `after_change`: Re-check every claim about the touched entities. Returns the claims whose verdict or content moved.

```cypher
MATCH (c:Claim)-[:ABOUT]->(n) WHERE n.uid IN $u
                      MATCH (a:Answer)-[:MAKES]->(c)
                      RETURN DISTINCT c.uid AS uid, c.claim AS claim, c.result AS result, c.status AS status,
                             c.history AS history, a.uid AS answer, a.asked_by AS asked_by, a.question AS question
```

```cypher
MATCH (c:Claim {uid: $c}) SET c.status = $s, c.result = $r, c.checked_at = $at, c.history = $h
                       WITH c MATCH (a:Answer)-[:MAKES]->(c) SET a.status = 'changed', a.changed_at = $at
```

### `_notify`

```cypher
CREATE (:Notification {uid: $uid, user: $user, answer: $answer, claim: $claim, question: $q,
                                                 sentence: $s, before: $b, after: $a, why: $why, cause: $cause, at: $at,
                                                 read: false})
```

### `after_change`: Re-check every claim about the touched entities. Returns the claims whose verdict or content moved.

```cypher
MATCH (c:Claim {uid: $c}) SET c.checked_at = $at
```

## Per-person memory graphs

`orion.memory`

### `_g`

```cypher
CREATE INDEX FOR (r:Ref) ON (r.uid)
```

```cypher
CREATE INDEX FOR (s:Session) ON (s.uid)
```

```cypher
MERGE (:User {uid: $u})
```

### `remember`

```cypher
MATCH (u:User {uid: $user}) MERGE (s:Session {uid: $s}) ON CREATE SET s.started = $at
               MERGE (u)-[:HAD]->(s) SET s.last = $at
               CREATE (s)-[:TURN]->(q:Turn {role: 'user', text: $q, at: $at}),
                      (s)-[:TURN]->(a:Turn {role: 'assistant', text: $a, at: $at, answer: $ans}), (q)-[:ANSWERED_BY]->(a)
               WITH q UNWIND $refs AS r MERGE (x:Ref {uid: r}) CREATE (q)-[:ABOUT]->(x)
```

### `believe`: A new belief about the same subjects closes the previous one (bi-temporal: both stay).

```cypher
MATCH (:User {uid: $u})-[:BELIEVES]->(b:Belief)-[:ABOUT]->(r:Ref) WHERE r.uid IN $about
                   AND b.valid_to = '9999-12-31' SET b.valid_to = $at
```

```cypher
MATCH (u:User {uid: $u}) CREATE (u)-[:BELIEVES]->(b:Belief {text: $text, valid_from: $at,
                                                                        valid_to: '9999-12-31'})
               WITH b UNWIND $about AS r MERGE (x:Ref {uid: r}) CREATE (b)-[:ABOUT]->(x)
```

### `learn_procedure`

```cypher
MERGE (p:Procedure {qtype: $qt, tools: $seq})
               ON CREATE SET p.successes = 0, p.failures = 0
               SET p.successes = p.successes + $s, p.failures = p.failures + $f
```

### `recall`

```cypher
MATCH (:Session {uid: $s})-[:TURN]->(x:Turn) RETURN x.role AS role, x.text AS text, x.at AS at
                         ORDER BY x.at DESC LIMIT 4
```

```cypher
MATCH (q:Turn {role: 'user'})-[:ABOUT]->(r:Ref) WHERE r.uid IN $refs
                           MATCH (q)-[:ANSWERED_BY]->(a:Turn) MATCH (s:Session)-[:TURN]->(q)
                           WHERE s.uid <> $s
                           RETURN q.text AS q, a.text AS a, q.at AS at, count(r) AS shared
                           ORDER BY shared DESC, at DESC LIMIT 3
```

```cypher
MATCH (f:Finding)-[:ABOUT]->(n) WHERE n.uid IN $refs
                                     RETURN DISTINCT f.universe AS universe, f.title AS title, f.summary AS summary,
                                            f.at AS at ORDER BY at DESC LIMIT 3
```

```cypher
MATCH (:User {uid: $u})-[:BELIEVES]->(b:Belief) WHERE b.valid_to = '9999-12-31'
                          RETURN b.text AS text, b.valid_from AS at ORDER BY at DESC LIMIT 5
```

```cypher
MATCH (p:Procedure {qtype: $qt}) WHERE p.successes > 0
                       RETURN p.tools AS tools, p.successes AS ok, p.failures AS bad
                       ORDER BY toFloat(p.successes) / (p.successes + p.failures) DESC, p.successes DESC LIMIT 1
```

## The agents' shared board

`orion.deck`

### `_g`

```cypher
MATCH (a:Agent) RETURN count(a) AS n
```

```cypher
CREATE INDEX FOR (t:Task) ON (t.uid)
```

```cypher
CREATE INDEX FOR (t:Task) ON (t.status)
```

```cypher
MERGE (a:Agent {name: $n}) SET a.role = $r, a.status = 'idle'
```

### `post`

```cypher
CREATE (x:Task {uid: $uid, kind: $kind, status: 'open', payload: $p, attempts: 0, created: $at, by: $by})
```

### `claim`: Atomically take one open task (a specific one, or the oldest of a kind).

```cypher
MATCH (x:Task) WHERE x.uid = $uid AND x.status = 'open' AND x.attempts < $max
                       WITH x ORDER BY x.created LIMIT 1
                       SET x.status = 'claimed', x.agent = $agent, x.attempts = x.attempts + 1, x.claimed_at = $at
                       WITH x MATCH (a:Agent {name: $agent}) SET a.status = 'working', a.beat = $at, a.task = x.uid
                       RETURN x.uid AS uid, x.kind AS kind, x.payload AS payload, x.attempts AS attempts
```

### `done`

```cypher
MATCH (x:Task {uid: $u}) SET x.status = 'done', x.result = $r, x.done_at = $at
               WITH x MATCH (a:Agent {name: x.agent}) SET a.status = 'idle', a.beat = $at
```

## The Sentinel

`orion.agents.sentinel`

### `weigh`

```cypher
MATCH (t:Team)-[:OWNS]->(:Service {uid: $s}) RETURN t.uid AS uid, t.name AS name
```

```cypher
MATCH (:Person {uid: $p})-[:MEMBER_OF]->(t:Team) RETURN t.uid AS uid, t.name AS name
```

### `handle`

```cypher
CREATE (:Review {uid: $u, change: $c, source: $s, author: $a, authority: $w, why: $why,
                                           team: $team, status: 'waiting', at: $at})
```

## What the web app draws

`orion.viz`

### `galaxy`

```cypher
MATCH (t:Team) OPTIONAL MATCH (p:Person)-[:MEMBER_OF]->(t)
                        RETURN t.uid AS id, t.name AS label, t.mission AS mission, count(p) AS size ORDER BY t.uid
```

```cypher
MATCH (s:Service) OPTIONAL MATCH (t:Team)-[:OWNS]->(s)
                           OPTIONAL MATCH (p:Person)-[:KNOWS]->(s)
                           RETURN s.uid AS id, s.name AS label, s.tier AS tier, s.lang AS lang, s.summary AS summary,
                                  s.created AS created, t.uid AS team, count(p) AS knowers ORDER BY s.uid
```

```cypher
MATCH (s:Retired) RETURN s.uid AS id, s.name AS label, s.tier AS tier, s.retired AS retired
```

```cypher
MATCH (t:Team)-[r:OWNS]->(s:Service)
                                                                            WHERE s.uid IN $u
                                                                            RETURN s.uid AS id, t.uid AS team
                                                                            ORDER BY r.valid_from
```

```cypher
MATCH (p:Person) OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
                         RETURN p.uid AS id, p.name AS label, p.role AS role, p.joined AS joined, t.uid AS team
                         ORDER BY p.uid
```

```cypher
MATCH (p:Former) RETURN p.uid AS id, p.name AS label, p.left AS left
```

```cypher
MATCH (c:Customer) RETURN c.uid AS id, c.name AS label, c.tier AS tier, c.industry AS industry
```

```cypher
MATCH (a:Service)-[r:DEPENDS_ON]->(b) RETURN a.uid AS source, b.uid AS target, r.kind AS kind,
                       r.uid AS uid, b:Retired AS dangling
```

```cypher
MATCH (p:Person)-[k:KNOWS]->(s:Service) RETURN p.uid AS source, s.uid AS target, k.n AS n
```

```cypher
MATCH (c:Customer)-[:USES]->(s) RETURN c.uid AS source, s.uid AS target
```

```cypher
MATCH (a:Person)-[r:COLLABORATES]->(b:Person) WHERE a.uid < b.uid
                         RETURN a.uid AS source, b.uid AS target, r.w AS w
```

### `timeline`: Dated events across the company's history, for the time machine.

```cypher
MATCH (s:Service) RETURN s.uid AS uid, s.name AS name, s.created AS c, s.retired AS r, s.tier AS tier
```

```cypher
MATCH (p:Person) RETURN p.uid AS uid, p.name AS name, p.joined AS j, p.left AS l
```

```cypher
MATCH (d:Decision) RETURN d.uid AS uid, d.key AS key, d.title AS title, d.at AS at, d.status AS status
```

```cypher
MATCH (k:Ticket {kind: 'incident'}) RETURN k.uid AS uid, k.key AS key, k.title AS title, k.at AS at
```

```cypher
MATCH (a)-[r:DEPENDS_ON]->(b) WHERE r.recorded_at > r.valid_from + 'T'
                         RETURN r.uid AS uid, a.name AS a, b.name AS b, r.recorded_at AS at, r.valid_from AS vf
```

```cypher
MATCH (c:Change) RETURN substring(c.at, 0, 7) AS month, count(c) AS n ORDER BY month
```
