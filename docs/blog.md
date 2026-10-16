---
title: "The dependency nobody wrote down: copying a whole company in 60 ms with FalkorDB"
subtitle: "Every question gets its own copy of the company. Here's how GRAPH.COPY made that cheap enough to do, what it can and can't tell you, and what broke along the way."
tags: falkordb, graph-database, ai-agents, hackathon
cover: https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/hindsight-cover.jpg
---

# The dependency nobody wrote down

On 18 March, invoices stopped rendering for every one of Corvane's 16 customers.

The cause had been approved fifteen days earlier. ADR-011 switched off `sso-legacy`, the old single sign-on service,
and the announcement said every system in the service catalog had already moved off it. The catalog was wrong.
`invoice-render` had been fetching its signing token from sso-legacy for 652 days, and the only people who knew were
on Billing. Nobody asked them, because the catalog said there was nothing to ask about. Six days after the outage,
Tomasz from Billing finally wrote it down in #billing while explaining what went wrong.

Corvane is made up. But every engineer I've told this story to has their own version of it. The fact that would have
stopped the mistake existed. It was in someone's head, or in a chat message, or in a ticket from last year. It just
wasn't anywhere you'd look before approving the change.

Could anyone have seen it coming on 3 March, with only what had been written down by then?

I built **Orion** for the Graph Hacks hackathon to answer questions like that one, and to make asking them cheap.
Think of it as a flight simulator for company decisions. Before anyone switches off a system, loses a teammate or
merges two teams, Orion copies the entire company into a parallel universe, makes the change there, and shows you
what breaks, then rehearses other ways to get there.

## The same decision, two versions of 3 March

Here's the short answer, before the how. Orion can rebuild Corvane as it stood on 3 March twice: once with only the
facts that had been written down by then, and once with everything that was actually true. Then it runs ADR-011 on
both.

![The same decision on two versions of 3 March: risk 26 on what was written down, 100 on what was true](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/two-days.png)

On what was written down, switching off sso-legacy scores a simulated risk of 26: one old reporting system stops. On
what was true, it scores 100: five systems and all 16 customers. The whole gap is one edge, true since June 2024 and
recorded after the outage.

So no, the records couldn't have caught it. That's the honest framing for everything that follows. Orion doesn't
predict the future. It makes a company's dependencies, decisions and missing knowledge visible before a change, and
afterwards it can tell you exactly how big the blind spot was.

## Two minutes with the demo

The live demo is at **https://orion-gamma-six.vercel.app**. A first visit opens on a guided rehearsal of one
decision, retiring sso-legacy, played live in a copy of the company of your own (nothing you change spoils it for the
next person). If it says it's waking the API, give it a minute: the API runs on a free host that sleeps. The opening
states the proposal, one press copies the company, and four scenes follow. Each leads with what it found, and a
track above the map says which company you're looking at: a copy of today's, a simulated future, or the company
after a real update.

1. **What breaks.** Orion copies the company and switches sso-legacy off in the copy. The failure walks out one
   dependency at a time: two systems stop, three slow down, all 16 customers are affected. The dashed line is the
   dependency nobody wrote down, and it is what puts billing in the blast radius; click it to see Tomasz's message.
2. **A safer plan.** The safe-path search, each future its own copy, drawn on the same map. The one that works moves
   both systems onto identity first, and it waits on two open tickets. None of it has happened yet.
3. **New evidence.** Tomasz says BILL-207 is merged: step one of that plan is done. The dependency closes, Priya's
   earlier answer is flagged out of date, and the shutdown is rehearsed again on the updated company: now one
   system stops and three customers notice.
4. **The decision.** Don't retire it yet: one move remains. Then try another system on the What-ifs screen.

![The rehearsal: sso-legacy switched off in a copy of the company, the failure walked out to all 16 customers](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/rehearse-consequences.jpg)

Hindsight and INC-311, below, are the encore. Everything else (asking questions, approvals, the company on any past
date) is in the workspace behind it.

## A graph that can go backwards in time

All of Corvane lives in one FalkorDB graph: 40 people, six teams, 26 services, 16 customers, plus the decisions,
tickets, pull requests, chat messages and documents that connect them. Two years of history, generated from a fixed
seed. Today's company is about 1,700 nodes and 5,000 relationships.

![The graph model: the main labels, the validity on every fact, and the READ edges from claims](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/graph-model.png)

The first thing to get right was time. Every relationship that can stop being true carries four extra properties:

| Property | Meaning |
|---|---|
| `valid_from`, `valid_to` | When it was true. `valid_to = '9999-12-31'` while it still is |
| `recorded_at` | When the company found out |
| `src` | The message, document, ticket or decision it came from |

This graph, `org:corvane`, is the permanent record, and nothing in it is ever deleted. A fact that stops being true
gets closed, with a pointer to whatever closed it.

The ghost dependency looks like this: `(invoice-render)-[:DEPENDS_ON]->(sso-legacy)`, `valid_from: 2024-06-10`,
`recorded_at: 2026-03-24`, and `src` pointing at Tomasz's message. That gap between `valid_from` and `recorded_at` is
the whole incident, stored in one edge.

With validity on every edge, "who owned billing-api last June" is just a `WHERE` clause. "Who's to blame for this
fact" is following `src`. So far, so ordinary.

## Why I started copying entire companies

Then I tried running graph algorithms on a past date and hit the problem that shaped the rest of the project.

I lean on four of FalkorDB's algorithms: `algo.WCC` (weakly connected components, meaning which nodes can reach each
other at all), `algo.betweenness`, `algo.pageRank` and `algo.labelPropagation`. You choose what they run over by node
label and relationship type. You can't filter by property. The path-finding procedures do read properties, as weights
and costs, so this isn't absolute. But none of the algorithms I needed can skip an edge because its `valid_to` has
passed. Ask for the connected components of the dependency graph "as of last June", and a `DEPENDS_ON` edge that was
closed in January still gets walked.

So I stopped trying to filter and started copying. An **epoch** is the company on a date, as its own graph, and it is
disposable:

1. `GRAPH.COPY org:corvane epoch:corvane:2026-03-03:true`
2. In the copy, delete every relationship that wasn't valid on that date.
3. Delete every message, ticket and decision from after it, and rewind statuses (a decision superseded in April is
   `accepted` again).
4. Relabel people who'd already left as `:Former` and retired services as `:Retired`, so label filters skip them.
5. Recompute the derived edges for that date: who `KNOWS` a service (three or more changes or reviews in the last 180
   days), who `COLLABORATES` with whom.

```cypher
MATCH ()-[r]->() WHERE r.valid_from IS NOT NULL AND (r.valid_from > $d OR r.valid_to <= $d) DELETE r
MATCH (s:Source) WHERE s.at > $d DETACH DELETE s
```

Those deletes only ever happen in copies. The record keeps everything, so any copy can be thrown away and rebuilt.

The second flavour is the `known` epoch, which also deletes facts with `recorded_at` after the date. The `true` epoch
is what the company was on 3 March. The `known` epoch is what it *could have known*. That pair is where the 26 and the
100 come from.

![One permanent record, many disposable companies](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/copies.png)

How cheap is a copy? Here's what I measured, with the copy kept separate from the work done on it:

| Operation | Where | Time |
|---|---|---|
| `GRAPH.COPY` of today's Corvane (1,716 nodes, 4,999 relationships) | local FalkorDB, my desktop | 62 ms, median of 20 runs (51 to 79) |
| Rebuilding today's epoch: copy, prune, recompute derived edges | FalkorDB Cloud | about 2.9 s |
| Safe path: 4 candidate companies copied and scored | local FalkorDB | about 0.4 s |
| The same safe path search | FalkorDB Cloud, free tier | about 7 s |
| A visitor's own copy of Corvane (five graphs) | FalkorDB Cloud, free tier | about 2.5 s |

The cheap copy is what made the design possible. If a copy took ten seconds, I'd have built some clever overlay
system. At 60 ms, every question can just have its own company.

## What happens when you fork a decision

A **universe** is a copy of today's epoch with a change applied for real. "Switch off sso-legacy" means the service
gets `:Retired` and its edges go. "Ines leaves" means she becomes `:Former` and loses her `KNOWS` edges.

Then Orion runs the same queries and algorithms on both graphs and diffs them. **What breaks** is a breadth-first walk
up `DEPENDS_ON`, one indexed query per hop, keeping the worst effect at each service (a sync dependency stops, an async
one slows down) and a witness path so you can see why. The **risk score** is a sum of named points: each system that
stops or slows (weighted by how important it is and how far away), each customer who uses one, each system nobody left
would know, each group of systems no team would own any more, and each working group that would come apart. It's
capped at 100, and every point is listed with where it came from.

Switching off sso-legacy today: risk 100. invoice-render and reports-legacy stop working; billing-api, onboarding and
web-console slow down through invoice-render; Billing, Console, Data and Platform all have to sign off.

![A what-if: what stops working, step by step, and who has to agree](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/whatif.jpg)

Nothing changes in the record until every affected team approves. Then the universe's changes are replayed into the
org graph as closed and opened facts, with the approved decision as their source. I wrote a property test for this,
because it's easy to get subtly wrong: 30 random lists of changes, each one forked into a universe and also merged into
the record and rebuilt, and the two compared all the way down to WCC components, betweenness, PageRank and impact. If
they ever differ, the what-if was lying.

## Finding a safer path

Telling someone "this will break five things" is half an answer. They want to know how to do it safely.

So Orion searches for a plan. For every service that would break, it tries the fixes it has evidence for. Being
related isn't being interchangeable, so a move is only offered onto a successor a decision names outright
(`(identity)-[:REPLACES]->(sso-legacy)`, from ADR-005) or onto a system at least three others really moved to.
Switching a service off too is offered when no other system relies on it, and its own customers still count against
it. Every candidate plan is its own `GRAPH.COPY` with the plan applied, scored exactly like a what-if. A beam search
keeps the four safest plans at each depth.

```python
g = f"scratch:{t}:{secrets.token_hex(4)}"
db.copy(base, g)
try:
    opsm.apply_physical(db, g, resolved, "plan")
    reach = uv.broken_in(db, g)
    ...
finally:
    db.delete(g)
```

On Corvane it comes back with three steps: move invoice-render onto identity, move reports-legacy onto identity, then
switch off sso-legacy. The first step waits on two open tickets, BILL-207 and IDN-58, the identity endpoint BILL-207 is
blocked by, and the plan says so. Six candidates are turned down: secrets-vault, flag-eval and edge-gateway are run by
the same team as sso-legacy, but nothing establishes that any of them can do what sso-legacy does. Switching
reports-legacy off instead would leave its three customers without it, so that branch scores 20, not 0.

![The safe path: every company explored, the winning branch lit up](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/safepath.jpg)

The panel's heading is "No modeled problems after these steps", not "safe", and that 0 needs reading carefully. The
opening of this post is the reason. It means no risk that Orion's model can see in what the graph records. It doesn't mean the migration is guaranteed to be safe. If there's another
invoice-render out there, depending on something nobody wrote down, the plan won't know about it either. What the plan
does give you is an order of operations and a list of teams to ask, which is exactly the conversation that didn't
happen before ADR-011.

Brute-forcing copies of an entire company sounds wasteful, and on paper it is. But the alternative was a second,
incremental version of every query and algorithm that understands "pretend these edges are gone", and with it, bugs
where the planner and the what-if quietly disagree. With copies there's one scoring path.

## Could Orion have prevented the outage?

Back to 3 March. For every incident, Orion finds the decision that led to it and tests that decision on the day it was
made, on both epochs:

- On the `known` epoch, what had been written down: **risk 26**. One old reporting system stops, and ADR-011 looks
  fine. That's what the people approving it saw.
- On the `true` epoch, what was actually the case: **risk 100**. Five systems, all 16 customers.

The difference is exactly the facts on the breakage paths whose `recorded_at` is after the decision. Here that's one
edge, and Orion shows you the message that finally recorded it.

![Hindsight: ADR-011 approved on 3 March for a switch-off on 17 March, the outage, the fact nobody had written down, and the fix still open, to scale](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/hindsight.jpg)

So the answer is no. Everything written down on 3 March said the change was safe, and Orion, reading those records,
would have said so too. The blind spot was 74 points wide, and it lived in one fact that only Billing had.

Then Orion runs the safe path on that same day. Its first step is moving invoice-render onto identity, which is the fix
Billing filed after the outage as BILL-207. In Corvane's records that ticket is still open months later, waiting on an
endpoint from Platform, and sso-legacy is still running because of it.

I like this screen more than anything else in the project, because it's honest about what Orion can't do. If a fact
was never written down anywhere, Orion can't see it either. What it can do is show you how big that blind spot was,
and where the knowledge eventually came from.

## An answer that knows when it becomes wrong

Orion's assistant, the **Navigator**, answers by calling graph tools: the same traversals and algorithms as above,
plus forking universes. Every read tool goes through `GRAPH.RO_QUERY`, so a confused model can't write to the company.

Every sentence that states a fact has to come with a typed claim: `breaks`, `knows`, `depends_on`, `count` and a few
more. A separate **Verifier** runs each claim as a query and compares the exact set or number. "invoice-render and
reports-legacy stop working" is a `breaks` claim with two services, checked against the universe, and the sentence's
wording is held to it too: if it says a system stops when the graph says it only slows down, the point is only partly
checked. A name that matches nothing in the graph is **unsupported**, never "not true": Orion doesn't know it's false,
it just can't find it.

The summary at the top of an answer isn't a claim of its own, so it's held to the claims: every person, system,
customer and decision it names, every number it gives (with the word it counts, so seven customers don't back "seven
systems") and every effect it states has to be in a point the graph verified. Under the headline the answer says
either that it is, or exactly what isn't. "Verified" means this sentence matches this computation on this graph, which
is narrower than "true", and that's the promise I can defend.

The answer and its claims are then stored in the record. Each claim keeps the uids of the facts its evidence rested
on, and gets a `READ` edge to every node it looked at:

```
(:Person)-[:ASKED]->(:Answer)-[:MAKES]->(:Claim {facts: [...]})-[:READ]->(:Service)
```

Now Tomasz posts in #billing: *"BILL-207 is merged: invoice-render now gets its signing token from identity. It no
longer calls sso-legacy at all."* One agent reads the message and proposes two changes of fact. Another decides
whether to believe them. Tomasz is on Billing, which owns invoice-render, so his word counts for more than an
outsider's would, and hedging ("I think...") counts for less. It closes the old dependency and opens the new one, with
the message as their source. Then one query finds every answer that relied on the closed fact:

```cypher
MATCH (a:Answer {status: 'fresh'})-[:MAKES]->(c:Claim)
WHERE $fact_uid IN coalesce(c.facts, [])
RETURN DISTINCT a.uid AS uid
```

Each one is re-checked by the graph, with no model call. Priya gets an inbox note saying which of her points stopped
being true and which message changed them. Switching off sso-legacy now only stops reports-legacy: risk 26.

![Inbox: an answer that stopped being true, and the message that changed it](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/inbox.jpg)

Most assistants give you an answer and forget about it. Orion keeps its answers, and so it knows when it has to take
one back.

## I tested whether any of this helped

One good story isn't evidence, so I ran a head-to-head. Here's exactly what it is, because the details decide what the
result means.

**The questions.** Orion generates 29 questions from the graph, of five kinds: who actually knows a system, what it
depends on at any depth, what breaks if it's switched off, how many, and whether a decision still holds. The true
answer to each is computed by a graph query.

**The contestants.** The same model, Claude Haiku 5.5, answers every question twice: once as Orion, with the graph
tools, and once given the 15 records that full-text search ranks highest for the question, the way a simple retrieval
assistant would see the company.

**The grading.** No model grades anything. The names in each answer are resolved against the graph and compared with
the true set exactly; a name that isn't in the truth counts against the answer. Number questions take the first number
given, and decision questions take the status word. Two weaknesses of that, said plainly: a made-up name that matches
nothing in the graph is never counted, so the made-up-name figures understate both sides; and the true answers to the
dependency questions come from the same impact walk Orion uses, so a bug there would be shared. That walk is now
checked separately against brute force (more on that below).

**The results**, over three runs:

| Run | Orion | Same model, keyword retrieval |
|---|---|---|
| 15 Oct (the one on the Proof screen) | 28 of 29 (97%) | 8 of 29 (28%) |
| 16 Oct | 24 of 29 (83%) | 5 of 29 (17%) |
| 16 Oct | 26 of 29 (90%) | 7 of 29 (24%) |
| **All three** | **78 of 87 (90%)** | **20 of 87 (23%)** |

So the 97% is Orion's best run, not its typical one. I read all nine of Orion's misses by hand. Eight were the grader
being strict: "no longer in force" read as "in force", "14 break and 7 more degrade, 21 in total" read as 14, and a
system named in a side remark ("web-console relies on build-scheduler") counted as part of the answer. One was a real
mistake: Orion said onboarding relies on 10 systems and named only two of them. I haven't hand-checked the baseline's
67 misses, and the same strictness surely costs it some too, so the raw numbers are the fair comparison.

The gap is widest on "who actually knows this system" (24 of 24 across the three runs, against 0) and "what does it
depend on" (12 of 15, against 0). The baseline's misses there follow a pattern. On "who knows", it usually named the
right people plus others the retrieved records mentioned, and where nobody knows a system any more, it named someone
anyway. On "what does it depend on", it found one or two systems, or none, out of as many as 16. On "what did we
decide" it did as well as Orion (16 of 18 each), which makes sense, since a decision is usually written down in one
place.

**What this shows, and what it doesn't.** It shows a large advantage for graph tools on these graph-derived questions,
against this baseline. It isn't a general accuracy claim. The questions come from the graph, which is home ground for
Orion. The baseline is keyword search, with no embeddings or hybrid retrieval. Twenty-nine questions is a small set:
one answer moves accuracy by 3.4 points. And there are no hand-written questions, and none where the right answer is
"I don't know". A stronger retrieval baseline and a hand-written set are the next things I'd add.

The code is [evals.py](https://github.com/Sumit99589/orion/blob/main/backend/src/orion/evals.py), and every question
with both answers is in [eval_results.json](https://github.com/Sumit99589/orion/blob/main/backend/src/orion/eval_results.json)
and on the Proof screen. `uv run python -m orion.evals` reruns it in a few minutes.

## What broke while building it

**My impact walk had a real bug, and a reviewer found it.** The walk keeps the worst effect at each service. But if a
service was reached through an async dependency first, and a fully synchronous path to it turned up one hop later, the
second path was skipped because the service was already in the frontier. So it showed as "slows down" when it should
break, along with everything depending on it. My equivalence test couldn't catch it, because both sides of that test
call the same walk. The fix walks a service again whenever a more severe path turns up (severity only rises, so it
still ends on cycles), and a new test checks the walk against brute force over every simple path on 300 random graphs.
None of Corvane's 25 services has that shape, so no number in this post moved, but the engine was wrong until then.

**Giving every visitor their own company, on 100 MB.** The demo's best moment changes the company: a message closes a
fact and an answer goes stale. On one shared company the second visitor found the story already told. So each browser
now gets its own copy, made the way Orion makes everything, by `GRAPH.COPY` of each graph. The free cloud instance
holds 100 MB and a copy in use takes up to about 40, which I found out by running it out of memory. Copies are now made
only when they fit, idle ones are evicted first, and the company they're copied from is read-only over the API, so it
can never be dirtied.

**FalkorDB Cloud only lets you run graph commands.** Locally I'd been keeping small bits of state in plain Redis keys:
tenant clocks, version counters, a cache, locks around universes. On the cloud instance those commands are refused. I
moved all of it into an `orion:meta` graph: `KV` nodes with an optional expiry, and `Lock` nodes taken with a single
`MERGE`. Writes to a graph run one at a time, so counters and locks stayed atomic, and it ended up cleaner than the
Redis version. The same property lets the agents share a task board in a graph: claiming a task is one write query, so
two workers can never both win it.

**`GRAPH.COPY` on the cloud forks the server process, and refuses a second fork while one runs.** The safe path was
making its copies in parallel, which worked fine on my desktop and failed on the deployed instance. Copies now take
turns (the scoring on each copy still runs side by side), and a copy refused mid-fork is retried. Taking turns, plus
network round trips, is why the same search takes seven seconds there and under half a second on my desktop.

## Try changing a company without breaking one

- **Live:** https://orion-gamma-six.vercel.app. Break the company, find a safer sequence, watch a new fact change
  the decision: the guided rehearsal takes about two minutes.
- **Code, setup and the full graph model:** https://github.com/Sumit99589/orion. It runs locally with Docker, uv and
  Node, and it can also load any public GitHub repository as a company.

The thing I keep coming back to is how much of this came from one cheap operation. Once copying a whole company costs
60 milliseconds, "what if" stops being a meeting and becomes a query.

*I built Orion with Claude Code as my coding assistant; the README has the full AI-use disclosure.*
