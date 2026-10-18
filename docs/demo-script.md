# Demo video: "The dependency nobody wrote down"

About four minutes. One decision, told like a short film: a cold open on a disaster, a rehearsal in a parallel
universe, a twist when a new fact arrives, and an honest ending about what Orion could and couldn't have seen.
Everything is the live product at https://orion-gamma-six.vercel.app.

**Rule for the whole video:** every number you say is on screen when you say it. Where the script says *[read it]*,
read the live value; the number in brackets is what it usually shows.

## Before you press record

- **Wake the API ten minutes before.** Open the site once in a normal window and let the opening load, then close it.
  The free host sleeps; a warm one makes every step fast.
- **Record in a fresh private window** so the site opens on the rehearsal and gets its own copy of the company.
  1440×900 or larger, browser zoom 110%, bookmarks bar hidden, notifications off.
- **The right-arrow key presses each scene's main button.** Use it, so the cursor isn't hunting on screen.
- **Bad connection?** `/rehearse?replay` plays a recorded run. It says **Replay** in the top bar the whole time; keep
  it visible and say "this is a recorded run" once.
- **Waits:** the copy takes a few seconds, the safe-path search about 8 s, reading the message about 25 s. Talk over
  them. In the edit you can cut dead air; if you speed a wait up, put a small "2×" in the corner. Judges trust a
  demo that doesn't hide its seams.
- **Sound:** a low ambient track under everything. Let it swell at three moments: the warp (0:30), the failure
  reaching the customers (1:00), and "A new fact changed the answer" (2:25). Silence for the last line.
- **Voice:** slow down. Short sentences, a beat after each headline. The pauses are what make it cinematic.

---

## Cold open (0:00–0:25)

**Screen:** the opening, starfield, "Break your company. In a parallel universe." Don't touch anything yet; let Orion
draw itself and the map fork.

**Say:**

> "On the third of March, a team approved switching off an old login service.
> The service catalog said nothing depended on it anymore.
>
> Fifteen days later, invoices stopped. For every customer.
>
> The fact that would have stopped it existed. It was in a few people's heads, on one team, and nobody asked them.
>
> We test code before we ship it. We don't test decisions.
> So I built a place to test them: a parallel universe."

*(Beat. Music up.)*

## The proposal (0:25–0:35)

**Screen:** scroll to **The proposal** card: retire sso-legacy. Point at "Corvane is made up."

**Say:**

> "Meet Corvane. A made-up company, but a real graph: forty people, twenty-six systems, sixteen customers, two years of
> decisions, tickets and chat, all in FalkorDB.
>
> The proposal: retire the old sign-on service. Let's not do it to the real company."

**Do:** press **Rehearse this shutdown**. The stars warp.

## Act 1: What breaks (0:35–1:10)

**Screen:** "Copying today's company". Then the failure walks out on the map. Today's company sits in the corner,
marked *untouched*.

**Say** (while it copies):

> "Orion just copied the entire company graph. One `GRAPH.COPY`, *[read it: the copy time on screen]*. That copy is a
> parallel universe. In it, and only in it, the service is switched off."

**Say** (as the failure walks):

> "Now watch the failure travel. Orion walks every dependency, one hop at a time. Some systems stop. Some just slow
> down. And then it reaches the customers."

*(Let the headline land. Music swell. Beat.)*

**Screen:** "An undocumented dependency puts Billing in the blast radius." 2 stop · 3 slow down · 16 customers.

> "Two systems stop. Three slow down. All sixteen customers are hit.
> And look at the headline: *undocumented*."

**Do:** press **Inspect the evidence**. The dashed line opens Tomasz's #billing message.

> "This line was never in the service catalog. Orion learned it from a chat message on the Billing team.
> That's the dependency nobody wrote down."

## Act 2: A safer plan (1:10–1:50)

**Do:** press **Find a safer sequence**. Cards appear on the map, one per future.

**Say:**

> "A warning isn't an answer. So Orion goes looking for a way out.
> Every card is another parallel universe: another full copy of the company, with a different preparation applied,
> scored on what breaks."

**Screen:** "There is a safer sequence: 2 moves, then retire." Retire now against Prepare first.

> "*[read it: the number of copies and the time]*. Retire now: everything breaks. Prepare first: move invoices and
> nightly reports onto the new identity service, then switch off, and nothing in the model is hit.
>
> And it's careful about what it suggests. Systems that merely sit on the same team were turned down, because nothing
> in the records says they can do the job. A move is only offered onto a successor a decision names, or one other
> systems have really moved to.
>
> None of this has happened. It's a rehearsal."

## Act 3: The twist, new evidence (1:50–2:30)

**Do:** press **Next: new evidence**. "One step of the plan has been reported complete."

**Screen:** "New in #billing": Tomasz says BILL-207 is merged.

**Say:**

> "Then Tomasz posts in the Billing channel. BILL-207 is merged. That's step one of the plan."

**Do:** press **Let Orion read it**. The four beats tick: *New source received → Company graph updated → Earlier answer
marked out of date → Shutdown rehearsed again.* (About 25 seconds. Talk through it.)

> "Orion reads the message and turns it into changes of fact. Tomasz is on the team that owns this system, so his word
> carries weight. The old dependency is closed, the new one is opened, and the message is kept as the source.
>
> Now the part I'm proudest of. Earlier, Priya asked Orion what would break. Orion remembered exactly which facts that
> answer rested on. One of them just stopped being true. So Orion re-checked her answer, against the graph, without
> asking the model, and flagged the points that no longer hold *[read it: 3 of 9]*.
>
> Most assistants give you an answer and forget it. Orion knows when it has to take one back."

**Screen:** "A new fact changed the answer: 1 system and 3 customers still at risk." The old numbers struck through.

*(Music swell. Beat.)*

> "Before: two systems down, sixteen customers. After one message: one system, three customers."

## Act 4: The decision (2:30–2:50)

**Do:** press **See the decision**.

**Screen:** "Don't retire it yet." What remains, next to retiring today. The numbers row underneath.

**Say:**

> "So the decision: not yet. One move remains: nightly reports onto identity. Then it can go.
> Retire it today, and three customers lose their reports.
>
> Every consequence on this screen came from copies of the graph. The model reads messages. It never decides what
> breaks."

## Encore: Could Orion have prevented it? (2:50–3:25)

**Do:** click **Encore: INC-311**. The Hindsight screen: the decision, the outage, the day the fact was written down,
to scale.

**Say:**

> "Remember the outage from the start? Here it is: INC-311. The real question is the one everyone asks afterwards:
> could we have seen it coming?
>
> Orion rebuilds the company as it stood on the third of March, twice. Once with only what had been written down by
> then. Once with what was actually true."

**Screen:** "What the records said on 3 Mar" next to "What was actually true". Risk 26 against risk 100.

> "On the records of the day: risk twenty-six. Looks safe. On the truth: risk one hundred.
>
> So, honestly? No. Orion, reading those records, would have approved it too.
> But it can show you the blind spot: exactly one fact, held by one team, and written down six days after the outage.
> And the fix it recommends, on that same day, is the fix Billing filed after the outage."

## Proof (3:25–3:45)

**Do:** open **Proof**. "Grounded, not guessed."

**Say:**

> "One story isn't evidence. So: twenty-nine questions generated from the graph, the same model answering twice, once
> with Orion's graph tools, once reading the most relevant records. Graded against the graph, not by a model.
>
> This run: *[read it: 28 of 29]* against *[read it: 8]*. Across three runs: ninety percent against twenty-three."

## Under the hood (3:45–4:05)

**Screen:** the README's "How the graph does the work" table, or `docs/media/graph-model.png` full screen.

**Say:**

> "Under the hood, it's all FalkorDB. Every fact has a validity window and a source, so the company can be rebuilt on
> any date. Every what-if is a `GRAPH.COPY`. Connected components, betweenness, PageRank and label propagation find
> what falls apart and who actually works together. The agents share a task board in a graph, and every tool the
> model calls is read-only.
>
> One graph. Agents that act on it, agents that remember, and a company brain. All three tracks."

## Close (4:05–4:15)

**Screen:** back to the opening, "Break your company. In a parallel universe." The URL on screen:
**orion-gamma-six.vercel.app**.

**Say** (music drops to silence before the last line):

> "We test code before we ship it.
> Now we can test decisions.
>
> Orion."

*(Hold two seconds on the URL. Cut.)*

---

## If it runs long

Cut in this order: **Under the hood** (the README covers it), then **Proof**, then trim the Encore to the 26 against
100 and "would have approved it too". Never cut Act 3: the answer changing is the moment judges remember.

## Don't say

- That Orion *predicted* or *would have prevented* the outage. The records of the day couldn't have. Saying so
  plainly is the strongest moment in the video.
- "Measured" impact. It's modelled from walking the graph: the screen says "not a measured outage".
- A number that isn't on screen. If a live value differs from the brackets above, say what the screen says.
