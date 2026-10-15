---
title: "The dependency nobody wrote down: forking a whole company in 60 ms with FalkorDB"
subtitle: "Every question gets its own copy of the company. Here's how GRAPH.COPY made that cheap enough to do, and what broke along the way."
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

Could anyone have seen it coming on 3 March, with only what had been written down by then? I'll come back to that.

I built **Orion** for the Graph Hacks hackathon. The pitch is one line: *see the company before you change it.*
Before anyone switches off a system, loses a teammate or merges two teams, Orion copies the entire company into a
parallel universe, makes the change there, and shows you what breaks.

- Live: https://orion-gamma-six.vercel.app
- Code: https://github.com/Sumit99589/orion

![The Ask screen: every point in the answer checked against the records, and the one it couldn't confirm marked that way](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/ask.jpg)

## One graph for the company

All of Corvane lives in one FalkorDB graph: 40 people, six teams, 26 services, 16 customers, plus the decisions,
tickets, pull requests, chat messages and documents that connect them. Two years of history, generated from a fixed
seed. Today's company is about 1,700 nodes and 5,000 relationships.

![The graph model: the main labels, the validity on every fact, and the READ edges from claims](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/graph-model.png)

The first thing I had to get right was time. A company graph that only knows the present is useless for this,
because the interesting questions are all "what did we know, and when". So every relationship that can stop being true
carries four extra properties:

| Property | Meaning |
|---|---|
| `valid_from`, `valid_to` | When it was true. `valid_to = '9999-12-31'` while it still is |
| `recorded_at` | When the company found out |
| `src` | The message, document, ticket or decision it came from |

Nothing is ever deleted. A fact that stops being true gets closed, with a pointer to whatever closed it.

The ghost dependency from the story looks like this in the graph: `(invoice-render)-[:DEPENDS_ON]->(sso-legacy)`,
`valid_from: 2024-06-10`, `recorded_at: 2026-03-24`, and `src` pointing at Tomasz's message. That gap between
`valid_from` and `recorded_at` is the whole incident, stored in one edge.

With validity on every edge, "who owned billing-api last June" is just a `WHERE` clause. "Who's to blame for this
fact" is following `src`. So far, so ordinary.

## Why the copies are real copies

Then I tried running graph algorithms on a past date and hit the problem that shaped the rest of the project.

I lean on four of FalkorDB's algorithms: `algo.WCC` (weakly connected components, meaning which nodes can reach each
other at all), `algo.betweenness`, `algo.pageRank` and `algo.labelPropagation`. You choose what they run over by node
label and relationship type. You can't filter by property. The path-finding procedures do read properties, as weights
and costs, so this isn't absolute. But none of the algorithms I needed can skip an edge because its `valid_to` has
passed. Ask for the connected components of the dependency graph "as of last June", and a `DEPENDS_ON` edge that was
closed in January still gets walked. You can't `WHERE` your way out of it.

So I stopped trying to filter and started copying. An **epoch** is the company on a date, as its own graph:

1. `GRAPH.COPY org:corvane epoch:corvane:2026-03-03:true`
2. Delete every relationship that wasn't valid on that date.
3. Delete every message, ticket and decision from after it, and rewind statuses (a decision superseded in April is
   `accepted` again).
4. Relabel people who'd already left as `:Former` and retired services as `:Retired`, so label filters skip them.
5. Recompute the derived edges for that date: who `KNOWS` a service (three or more changes or reviews in the last 180
   days), who `COLLABORATES` with whom (shared changes, decaying with a 90-day half-life).

```cypher
MATCH ()-[r]->() WHERE r.valid_from IS NOT NULL AND (r.valid_from > $d OR r.valid_to <= $d) DELETE r
MATCH (s:Source) WHERE s.at > $d DETACH DELETE s
```

There's a second flavour, the `known` epoch. It also deletes facts with `recorded_at` after the date. The `true` epoch
is what the company actually was on 3 March. The `known` epoch is what the company *could have known* on 3 March. Hold
on to that one.

Copying today's Corvane took a median of 62 ms over 20 runs on my desktop (51 to 79 ms). That number made everything
else possible. If a copy took ten seconds, I'd have built some clever overlay system. At 60 ms, every question can
just have its own company.

## Universes: fork, change, compare

A **universe** is a copy of today's epoch with a change applied physically. "Switch off sso-legacy" means the service
gets `:Retired` and its edges go. "Ines leaves" means she becomes `:Former` and loses her `KNOWS` edges.

Then Orion runs the same queries and algorithms on both graphs and diffs them. **What breaks** is a breadth-first walk
up `DEPENDS_ON`, one indexed query per hop, keeping the worst effect at each service and a witness path so you can see
why. Then come the customers who use something broken, the services nobody left `KNOWS`, the systems WCC says have lost
every path back to a team, and the teams that have to agree. All of that rolls into a risk score from 0 to 100.

Switching off sso-legacy today: risk 100. invoice-render and reports-legacy stop working; billing-api, onboarding and
web-console slow down through invoice-render; Billing, Console, Data and Platform all have to sign off.

![A what-if: what stops working, step by step, and who has to agree](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/whatif.jpg)

A universe can also be merged back. Nothing changes in the real records until every affected team approves. Then the
universe's changes are replayed into the org graph as closed and opened facts, with the approved decision as their
source. I wrote a property test for this, because it's easy to get subtly wrong: 30 random lists of changes, each one
forked into a universe and also merged into the records and rebuilt, and the two compared all the way down to WCC
components, betweenness, PageRank and impact. If they ever differ, the what-if was lying.

## The safe path

Telling someone "this will break five things" is half an answer. They want to know how to do it safely.

So Orion searches for a plan. For every service that would break, it tries a fix: move it onto a replacement (a
service a decision names alongside the retired one, or one its neighbours already moved to), or switch it off too if
nothing depends on it. Every candidate plan is its own `GRAPH.COPY` with the plan applied, scored exactly like a
what-if. A beam search keeps the four safest plans at each depth.

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

On Corvane it explores 16 parallel companies and comes back with three steps: move invoice-render onto identity,
switch reports-legacy off as well, then switch off sso-legacy. Risk goes from 100 to 0. That takes about a second on my
desktop and about ten on the free cloud instance, where the copies have to take turns (more on that below). One click
sends the plan to the teams it touches.

![The safe path: every company explored, the winning branch lit up](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/safepath.jpg)

Brute-forcing copies of an entire company sounds wasteful, and on paper it is. But the alternative was writing a
second, incremental version of every query and algorithm that understands "pretend these edges are gone". That would
have been a source of bugs where the planner and the what-if quietly disagree. With copies there's one scoring path.

## Back to 3 March

Here's where `true` against `known` pays off. For every incident, Orion finds the decision that led to it and tests
that decision twice, on the day it was made:

- On the `known` epoch for 3 March, what had been written down by then: **risk 26**. One old reporting system breaks.
  ADR-011 looks fine. That's what the people approving it saw.
- On the `true` epoch for 3 March, what was actually the case: **risk 100**. Five systems, all 16 customers.

The difference between the two is exactly the facts on the breakage paths whose `recorded_at` is after the decision.
Here that's one edge: invoice-render → sso-legacy, true since June 2024, written down six days after the outage. Orion
shows you the message that finally recorded it.

So, could anyone have seen it coming? Not from the records. Everything written down on 3 March said the change was
safe. The blind spot was 74 points of risk wide, and it lived in one fact that only Billing had.

Then Orion runs the safe path on that same day. Its first step is moving invoice-render onto identity, which is exactly
the fix Billing filed after the outage as BILL-207. In Corvane's records that ticket is still open months later,
waiting on an endpoint from Platform, and sso-legacy is still running because of it.

![Hindsight: the decision, the incident, and the fact nobody had written down, to scale](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/hindsight.jpg)

I like this screen more than anything else in the project, because it's honest about what Orion can't do. If a fact
was never written down anywhere, Orion can't see it either. What it can do is show you exactly how big that blind spot
was, and where the knowledge eventually came from.

## Does it actually help?

One good story isn't evidence, so I wanted a number. Orion generates 29 questions from the graph itself, so each one has
an answer the records settle: who actually knows a system, what it depends on at any depth, what breaks and how many,
whether a decision still holds.

The same model (Claude Haiku 5.5) answers each question twice. Once as Orion, with the graph tools. Once as a typical
retrieval assistant, reading the 15 records that full-text search ranks highest for the question. Both are graded the
same way.

- **Orion: 28 of 29 correct (97%)**, with one made-up name across all its answers.
- **Same model, reading records: 8 of 29 (28%)**, with 15 made-up names.

Two caveats, and both favour Orion: the baseline is plain keyword search, not a tuned embedding pipeline, and the
questions come from the graph, which is home ground for a graph tool. So read 97 against 28 as "these questions need
a graph", not "retrieval is useless".

The gap is widest on "who actually knows this system" (8 of 8 against 0 of 8) and "what does it depend on" (5 of 5
against 0 of 5). Both are multi-hop questions, and no pile of retrieved documents answers them. On "what did we decide"
questions the baseline got all six right too, which makes sense: a decision is usually written down in one place.
Every question and both answers are on the Proof screen if you want to check my grading.

![Proof: Orion against the same model reading the same records](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/proof.jpg)

## Answers that can be taken back

Orion's assistant, the **Navigator**, answers by calling graph tools, the same traversals and algorithms as above,
plus forking universes. Every read tool goes through `GRAPH.RO_QUERY`, so a confused model can't write to the company.

Every sentence that states a fact has to come with a typed claim: `breaks`, `orphans`, `approvers`, `knows`, `owns`,
`depends_on`, `decided`, `count` or `metric`. A separate **Verifier** runs each claim as a query and compares the exact
set or number. "invoice-render and reports-legacy stop working" is a `breaks` claim with two services, checked against
the universe. Two rules took a while to get right:

- A name that matches nothing in the graph is **unsupported**, never "not true". Orion doesn't know it's false. It just
  can't find it.
- Anything said without a typed claim is only ever *judged* by a model, on the rows it cites, and it's labelled that
  way.

Then there's what happens after an answer is given. The Answer and its Claims go into the org graph. Each claim keeps
the uids of the facts its evidence rested on, and gets a `READ` edge to every node it looked at:

```
(:Person)-[:ASKED]->(:Answer)-[:MAKES]->(:Claim {facts: [...]})-[:READ]->(:Service)
```

Now Tomasz posts in #billing: *"BILL-207 is merged: invoice-render now gets its signing token from identity. It no
longer calls sso-legacy at all."*

The **Cartographer** reads that message and proposes two changes of fact. The **Sentinel** decides whether to believe
them. Tomasz is on Billing, and Billing owns invoice-render, so his word counts for 0.95. Someone from another team
would get 0.65, and hedging ("I think...") multiplies by 0.7. High enough, and the Sentinel closes the old dependency
and opens the new one, with the message as their source.

Then one query finds every answer that relied on the closed fact:

```cypher
MATCH (a:Answer {status: 'fresh'})-[:MAKES]->(c:Claim)
WHERE $fact_uid IN coalesce(c.facts, [])
RETURN DISTINCT a.uid AS uid
```

Each one is re-checked by the graph, with no model call. Only claims whose check now fails change. Priya, who asked
about sso-legacy earlier, gets an inbox note saying which of her points stopped being true and which message changed
them. Switching off sso-legacy now only breaks reports-legacy: risk 26.

![Inbox: an answer that stopped being true, and the message that changed it](https://raw.githubusercontent.com/Sumit99589/orion/main/docs/media/inbox.jpg)

Most assistants give you an answer and forget about it. Orion keeps its answers, and so it knows when it has to take
one back.

The agents never call each other. They share a board that is its own graph: a what-if is a `:Task` node, and
claiming one is a single write query, which FalkorDB serializes, so two workers can't both win it. Memory is a graph
per person. Each turn in `mem:corvane:priya-raman` points at the nodes it was about, so when Priya asks about
invoice-render a week later, her sso-legacy conversation comes back through a join on that node, not keyword luck.

## Things that bit me

**FalkorDB Cloud only lets you run graph commands.** Locally I'd been keeping small bits of state in plain Redis keys:
tenant clocks, version counters, a cache, locks around universes. On the cloud instance those commands are refused. I
moved all of it into an `orion:meta` graph: `KV` nodes with an optional expiry, and `Lock` nodes taken with a single
`MERGE`. Since writes to a graph are serialized, counters and locks stayed atomic, and it ended up cleaner than the
Redis version.

**`GRAPH.COPY` on the cloud forks the server process, and refuses a second fork while one runs.** The safe path was
making its copies in parallel, which worked fine on my laptop and failed on the deployed instance. Copies now take turns
(the scoring on each copy still runs side by side), and a copy refused mid-fork is retried.

**Round trips add up.** Against a local database, checking a dozen claims one after another is instant. Against a
remote one, the latency adds up to seconds. The Verifier now checks claims side by side and caches the name resolver
until the records change.

**Free hosting sleeps.** The API runs on Render's free tier, which spins down after a while. A GitHub Action pings it
every ten minutes, and if it's asleep anyway, the web app says "Waking the API, about a minute" with a counter instead
of showing a broken screen.

## Try it

The live demo opens on a real answer Priya got about switching off sso-legacy, with every claim marked. **Start here**
walks through the three moments in about two minutes: open the what-if and find the safe path, post Tomasz's message
and watch the answer go stale, then replay INC-311.

You can also point it at any public GitHub repository: contributors become people, folders become modules, CODEOWNERS
entries become teams and imports become dependencies, so every screen works on real code too.

- Live: https://orion-gamma-six.vercel.app
- Code, setup and the full graph model: https://github.com/Sumit99589/orion

The README covers running it locally (Docker, uv and Node) and the MCP server, which gives Claude Desktop or Cursor
the same graph tools. An agent there can propose a change, but it can't approve its own.

The thing I keep coming back to is how much of this came from one cheap operation. Once copying a whole company costs
60 milliseconds, "what if" stops being a meeting and becomes a query.

*I built Orion with Claude Code as my coding assistant; the README has the full AI-use disclosure.*
