// The product's vocabulary, in one place, written for the people who run the company rather than the people who
// built it. The code keeps its own names (universe, fork, merge, dry run, fact); everything a reader sees goes
// through here, so a screen never says "fork", "main", "graph node" or "Cypher".
//
//   universe            -> what-if (a private copy of the company with a change applied)
//   dry run             -> proposed change (a what-if that waits for approval)
//   main                -> the real company
//   merge / discard     -> apply / reject
//   rebase              -> re-check against today's company
//   graph / node        -> the company map / item
//   service             -> system
//   fact / blame        -> record / where it came from
//   verdict             -> check

import type { Op, Verdict } from "./types";

/** "u12" -> "#12": how a what-if is referred to on screen. */
export function scenarioLabel(uid: string | null | undefined): string {
  if (!uid) return "";
  const n = uid.replace(/\D/g, "");
  return n ? `#${n}` : uid;
}

export const KIND_WORD = { whatif: "What-if", dryrun: "Proposed change" } as const;
export const kindWord = (kind: string) => (kind === "dryrun" ? KIND_WORD.dryrun : KIND_WORD.whatif);

export const STATUS_WORD: Record<string, string> = {
  open: "open",
  merged: "applied",
  discarded: "rejected",
  rebased: "re-checked",
};

/** Tier 1-3 as a business reads it. */
export function tierWord(tier?: number | null): string {
  return tier === 1 ? "business-critical" : tier === 2 ? "important" : "supporting";
}

/** How far a breakage is from the change: 1 -> "directly", 3 -> "3 steps away". */
export function hopsWord(hops: number): string {
  return hops <= 1 ? "directly" : `${hops} steps away`;
}

export const EFFECT_WORD = { break: "stops working", degrade: "slows down or partly fails", stale: "runs on out-of-date data" } as const;

// --------------------------------------------------------------------------- checks on an answer

/** One or two words, next to a point in an answer. */
export const CHECK_SHORT: Record<Verdict, string> = {
  verified: "checked",
  partial: "partly checked",
  judged: "AI judgement",
  unsupported: "couldn't confirm",
  contradicted: "no longer true",
  unverified: "not checked",
  not_checked: "too big to check",
  expired: "out of date",
};

/** A full sentence, when a point is opened. */
export const CHECK_LONG: Record<Verdict, string> = {
  verified: "Checked against the company's records",
  partial: "Partly backed by the records",
  judged: "An AI judgement, not checked against the records directly",
  unsupported: "The records don't back this up",
  contradicted: "No longer true: the records changed",
  unverified: "Not checked",
  not_checked: "Too big to check automatically",
  expired: "Out of date",
};

// --------------------------------------------------------------------------- what the assistant is doing

/** Who is speaking in a step, by the agent's internal name. */
export const AGENT_WORD: Record<string, string> = {
  navigator: "Assistant",
  verifier: "Fact checker",
  cartographer: "Message reader",
  sentinel: "Watcher",
  simulator: "Simulator",
};

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

/** A step of the assistant's work, as a sentence: "Looked up what relies on sso-legacy". */
export function toolWords(tool: string, args: Record<string, unknown>): string {
  const a = (k: string) => str(args[k]);
  switch (tool) {
    case "find_entities":
      return `Looked for “${a("text")}”`;
    case "impact":
      return `Checked what relies on ${a("service")}`;
    case "broken_dependencies":
      return "Looked for systems relying on something switched off";
    case "who_knows":
      return `Checked who knows ${a("service")}`;
    case "ownership":
      return `Checked who owns ${a("service")}`;
    case "decision_history":
      return `Read the decisions about ${a("entity")}`;
    case "blame":
      return "Found where a record came from";
    case "customer_timeline":
      return `Read ${a("customer")}'s history`;
    case "trace_path":
      return `Traced how ${a("a")} connects to ${a("b")}`;
    case "neighborhood":
      return `Looked around ${a("entity")}`;
    case "bottlenecks":
      return "Found the people most work flows through";
    case "influence":
      return "Measured who has the most influence";
    case "communities":
      return "Found the groups people really work in";
    case "bus_factor":
      return `Checked how many people could cover ${a("service")}`;
    case "contradictions":
      return "Looked for records that disagree";
    case "checkout":
      return `Opened the records as of ${a("date")}`;
    case "cypher_readonly":
      return "Ran a custom lookup";
    case "fork": {
      const ops = Array.isArray(args.ops) ? (args.ops as Op[]) : [];
      return ops.length ? `Tested on a copy: ${ops.map(opWords).join("; ")}` : "Tested a change on a copy of the company";
    }
    case "dry_run": {
      const ops = Array.isArray(args.ops) ? (args.ops as Op[]) : [];
      return ops.length ? `Drafted a change for approval: ${ops.map(opWords).join("; ")}` : "Drafted a change for approval";
    }
    case "remember":
      return "Made a note to remember";
    case "next_page":
      return "Read more results";
    default:
      return tool.replace(/_/g, " ");
  }
}

/** Status lines streamed by the agents, reworded. */
export function statusWords(agent: string, text: string): string {
  let m: RegExpExecArray | null;
  if (text === "planning") return "Working out what to look up";
  if ((m = /^checking (\d+) claims against the graph/.exec(text))) return `Checking ${m[1]} points against the records`;
  if ((m = /^reusing the verified answer from ([^:]+)/.exec(text)))
    return `Nothing has changed since this was last answered on ${m[1].slice(0, 10)}, so here is that answer again`;
  if ((m = /^re-running '(.+)': (\d+) fact\(s\) changed since (\S+)/.exec(text)))
    return `Re-testing “${m[1]}”: ${m[2]} ${m[2] === "1" ? "thing has" : "things have"} changed since ${m[3]}`;
  if ((m = /^playbook '(.+)': pre-running (\d+) tool/.exec(text))) return `Starting with the usual lookups for this kind of question`;
  if ((m = /^extracting facts from the new (\S+) message/.exec(text))) return `Reading the new message in ${m[1]}`;
  if (/rate limit|429|waiting/i.test(text)) return "The AI service is busy; waiting a moment";
  return agent === "navigator" ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// --------------------------------------------------------------------------- changes

/** One planned change, as a sentence. */
export function opWords(o: Op): string {
  const a = (k: string) => String(o[k] ?? "?");
  switch (o.op) {
    case "deprecate_service":
      return `Switch off ${a("service")}`;
    case "remove_person":
      return `${a("person")} leaves the company`;
    case "move_person":
      return `Move ${a("person")} to ${a("team")}`;
    case "reassign_owner":
      return `Make ${a("team")} responsible for ${a("service")}`;
    case "add_dependency":
      return `${a("source")} starts relying on ${a("target")}`;
    case "remove_dependency":
      return `${a("source")} stops relying on ${a("target")}`;
    case "declare_dependency":
      return `Write down that ${a("source")} relies on ${a("target")}`;
    case "reverse_decision":
      return `Reverse decision ${a("decision")}`;
    case "merge_teams":
      return `Fold ${a("team")} into ${a("into")}`;
    case "create_ticket":
      return `Open a task: “${a("title")}” on ${a("service")}`;
    default:
      return o.op.replace(/_/g, " ");
  }
}

// --------------------------------------------------------------------------- records

const RELATION_WORD: Record<string, string> = {
  dep: "relies on",
  depends_on: "relies on",
  own: "owns",
  owns: "owns",
  mem: "is on",
  wo: "worked on",
  member_of: "is on",
  knows: "knows",
  collaborates: "works with",
  uses: "uses",
  worked_on: "worked on",
  affects: "affects",
  on_call_for: "is on call for",
  raised_about: "raised problems about",
  co_changes: "changes together with",
};

const bare = (s: string) => s.replace(/^[a-z]+:/, "").replace(/#\d+$/, "");

/** A record's id as a sentence: "dep:invoice-render->sso-legacy@2024-06-10" -> "invoice-render relies on sso-legacy". */
export function factWords(uid: string | null | undefined): string {
  if (!uid) return "";
  const m = /^([a-z_]+):(.+?)->(.+?)(?:[#@][^>]*)?$/.exec(uid);
  if (!m) return uid.replace(/^[a-z_]+:/, "").replace(/[-_]/g, " ");
  const [, rel, a, b] = m;
  if (rel === "owns" || rel === "own") return `${bare(a)} owns ${bare(b)}`;
  return `${bare(a)} ${RELATION_WORD[rel] ?? rel.replace(/_/g, " ")} ${bare(b)}`;
}

/** What kind of thing a node is, for legends: the code's types, renamed. */
export const NODE_WORD: Record<string, string> = {
  Person: "Person",
  Team: "Team",
  Service: "System",
  Customer: "Customer",
  Project: "Project",
  Decision: "Decision",
};

const OLD_EFFECT: Record<string, string> = { break: "stop working", degrade: "slow down or partly fail", stale: "run on out-of-date data" };

/** A risk term's reason without the arithmetic, in plain words (what-ifs scored before the wording changed say
 *  "tier 1 service would break (2 hops away from sso-legacy): 30 × 1 (effect)"). */
export function plainWhy(why: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^tier (\d) service would (\w+) \((.+?)\)/.exec(why)))
    return `${tierWord(Number(m[1]))} system would ${OLD_EFFECT[m[2]] ?? m[2]} (${m[3].replace("hops away", "steps away")})`;
  if ((m = /^nobody would know this tier (\d) service any more/.exec(why))) return `nobody left would know how this ${tierWord(Number(m[1]))} system works`;
  if (why.startsWith("these services would lose every path to a team")) return "no team would be responsible for these systems any more";
  if (why.startsWith("a collaboration group falls apart")) return "a group that works together would fall apart";
  if (why.startsWith("the people everything routes through change")) return "the people most work flows through would change";
  if (why.startsWith("further services that would break")) return "more systems that would stop working";
  const cut = why.indexOf("): ");
  return cut > 0 ? why.slice(0, cut + 1) : why;
}

/** Which copy of the company a lookup ran on: "universe:corvane:u7" -> "on what-if #7". */
export function graphWords(graph: string | null | undefined): string {
  if (!graph) return "";
  let m: RegExpExecArray | null;
  if ((m = /^universe:[^:]+:u?(\d+)$/.exec(graph))) return `on what-if #${m[1]}`;
  if ((m = /^snap:[^:]+:(\d{4}-\d\d-\d\d)/.exec(graph))) return `on the records as of ${m[1]}`;
  if (graph.startsWith("snap:") || graph.startsWith("company:")) return "on today's records";
  return "";
}

/** A check's reason in plain words. Older answers were stored with the checker's own wording. */
export function checkReason(reason: string | null | undefined): string {
  if (!reason) return "";
  return reason
    .replace("every one is in the graph's result", "the records show each of these")
    .replace("exactly the set the graph returns", "the records show exactly this")
    .replace(/\bthe graph\b/g, "the records")
    .replace(/\bthe query returns\b/g, "the records say")
    .replace(/universe:[a-z0-9-]+:u(\d+)/g, "what-if #$1")
    .replace(/\buniverse u(\d+)\b/g, "what-if #$1")
    .replace(/\bu(\d+)\b/g, "#$1");
}

/** A relationship type in words: DEPENDS_ON -> "relies on". */
export function relWord(relation: string): string {
  const k = relation.toLowerCase();
  return RELATION_WORD[k] ?? k.replace(/_/g, " ");
}

/** A change of record read from a message: "invoice-render no longer relies on sso-legacy". */
export function changeWords(subject: string, relation: string, object: string, change?: string): string {
  const rel = relWord(relation);
  if (change === "stops") return `${subject} no longer ${rel} ${object}`;
  if (change === "starts") return `${subject} now ${rel} ${object}`;
  return `${subject} ${rel} ${object}${change ? ` (${change})` : ""}`;
}

/** Why the Watcher wanted a person to confirm a change, in words. */
export function reviewWhy(why: string): string {
  return why
    .replace("author unknown", "Orion doesn't know who wrote it")
    .replace("the author is not on the owning team", "whoever said it isn't on the team responsible")
    .replace(/^the author is on (.+), which owns it/, "whoever said it is on $1, the team responsible")
    .replace("about themselves", "they said it about themselves")
    .replace("; hedged", ", and they sounded unsure");
}

/** Jobs on the shared task board, by kind and status. */
export const TASK_WORD: Record<string, string> = {
  ask: "Answer a question",
  fork: "Test a what-if",
  simulate: "Work out and test a what-if",
  extract: "Read a team message",
  apply: "Update the records",
};
export const TASK_STATUS_WORD: Record<string, string> = { open: "waiting", claimed: "in progress", done: "done", failed: "failed" };

/** "cartographer-1" with role "cartographer" -> "Message reader 1". */
export function agentName(name: string, role: string): string {
  const n = /(\d+)$/.exec(name)?.[1];
  return `${AGENT_WORD[role] ?? role}${n ? ` ${n}` : ""}`;
}

/** Any "u12" in a sentence the backend wrote becomes "#12". */
export function scenarioText(text: string): string {
  return text.replace(/\bu(\d+)\b/g, "#$1");
}
