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
| 0:10 | Press **Rehearse a shutdown**. The decision and the map | "The decision: retire the legacy authentication service. This is everything that relies on it, and the 16 customers who use those systems. Corvane is a made-up company." |
| 0:25 | Press **Rehearse it on a copy**. The copy takes the stage, today's company shrinks into the corner, the failure walks out | "Orion copies the whole company graph in FalkorDB, about 150 ms, switches the service off in the copy, and follows every dependency." |
| 0:45 | The result strip: 2 stop · 3 slow down · 16 customers | "Two systems stop, three slow down, every customer is affected. That's modeled impact from walking the graph, not a measured outage." |
| 0:55 | Press **Show where it came from** | "The link that starts most of it was never in the service catalog. It came from a message in #billing." |
| 1:05 | Press **Find a safer sequence**. Futures appear as cards on the search tree | "Instead of stopping at a warning, Orion rehearses ways out. Each card is its own copy of the company, on the same map." |
| 1:20 | The search ends; the chosen line stays lit | "Moving only invoice PDFs still leaves nightly reports broken. Switching reports off too takes them from three customers. Moving both onto identity: nothing in the model is hit, once two open tickets land." |
| 1:40 | Press **Meanwhile, in #billing…**, then **Let Orion read it** | "Two days later Tomasz says BILL-207 is merged." |
| 1:50 | The four beats tick: source received, dependency updated, answer out of date, rehearsed again | "The dependency closes, the answer Priya got earlier is flagged because three of its points no longer hold, and the decision is rehearsed again on the changed company." |
| 2:15 | "A new fact just changed this decision." Before and after side by side | "Before: two stop, sixteen customers. Now: one stops, three customers. Orion doesn't just remember the answer. It remembers what the answer depended on." |
| 2:30 | Press **See the decision**. The two still frames | "Retire it today and nightly reports stop for three customers. Or move it onto identity first, and nothing in the model breaks." |
| 2:45 | Hold on the finale; point at the numbers row | "Every consequence here came from copies of the graph. The model reads messages; it doesn't decide what breaks." |
| 2:55 | End | "Make consequential engineering decisions rehearsable before they become production changes." |

Keep out of the main video: agent names, every screen in the workspace, integrations, the eval table. They're for
questions. Hindsight (INC-311, "what the company knew then, and what it learned too late") makes a good 20-second
encore if there's time; don't present it as having predicted the outage, because the records of the day couldn't.
