# Demo video: three minutes, one decision

One story, not a tour: retire a system, watch it break, find another way, then let a new fact change the answer.
Everything below is the live product at https://orion-gamma-six.vercel.app (open it in a fresh browser window so it
starts on the rehearsal). Record at 1440×900 or larger. The right-arrow key presses each scene's main button.

If the connection is bad, `/rehearse?replay` plays a recorded run. It says **Replay** in the top bar the whole time;
keep that visible and say so.

Timings are what the live run takes on the free servers: the copy about 6 s, the safe-path search about 8 s, the
message about 25 s. Talk over the waits; the screen shows each step as it lands.

| Time | On screen | Say |
|---|---|---|
| 0:00 | The opening: "Break your company. In a parallel universe." | "We test code before we ship it. Decisions around that code, like switching a system off, go straight to production. Orion lets you rehearse them first." |
| 0:10 | The proposal card: retire Legacy sign-on. Press **Rehearse this shutdown**; the stars warp | "The proposal: retire the old sign-on service. Corvane is a made-up company. Orion copies the whole company graph in FalkorDB, about 150 ms, and switches the service off in the copy." |
| 0:25 | The failure walks out on the map; today's company sits untouched in the corner. The track says *Today's company* | "Nothing real has changed. Orion follows every dependency in the copy, one step at a time." |
| 0:40 | Headline: "An undocumented dependency puts Billing in the blast radius." 2 stop · 3 slow down · 16 customers | "Two systems stop, three slow down, every customer is affected. Modelled impact from walking the graph, not a measured outage." |
| 0:50 | Press **Inspect the evidence** | "The link that starts most of it was never in the service catalog. It came from a message in #billing." |
| 1:00 | Press **Find a safer sequence**. Futures appear as cards; the track moves to *Simulated plan* | "Instead of stopping at a warning, Orion rehearses ways out. Each card is its own copy of the company, on the same map, and leads with what happens." |
| 1:15 | The search ends: "There is a safer sequence: 2 moves, then retire." Retire now against Prepare first | "Moving only invoice PDFs still leaves nightly reports broken. Moving both onto identity: nothing in the model is hit. None of this has happened yet." |
| 1:35 | Press **Next: new evidence**. "One step of the plan has been reported complete." Press **Let Orion read it** | "Two days later Tomasz says BILL-207 is merged. That's step one of the plan." |
| 1:45 | The four beats tick; the track moves to *Updated company* | "The dependency closes, the answer Priya got earlier is flagged because three of its points no longer hold, and the shutdown is rehearsed again on the updated company." |
| 2:10 | "A new fact changed the answer: 1 system and 3 customers still at risk." The old numbers struck through | "Before: two stop, sixteen customers. Now: one stops, three customers. Orion doesn't just remember the answer. It remembers what the answer depended on." |
| 2:25 | Press **See the decision**. "Don't retire it yet." What remains, next to retiring today | "So the decision: not yet. One move remains, nightly reports onto identity, then it can go. Retire it today and three customers lose their reports." |
| 2:45 | Point at **Try another change** and the numbers row | "Every consequence here came from copies of the graph. The model reads messages; it doesn't decide what breaks." |
| 2:55 | End | "Make consequential engineering decisions rehearsable before they become production changes." |

Keep out of the main video: agent names, every screen in the workspace, integrations, the eval table. They're for
questions. Hindsight (INC-311, "what the company knew then, and what it learned too late") makes a good 20-second
encore if there's time; don't present it as having predicted the outage, because the records of the day couldn't.
