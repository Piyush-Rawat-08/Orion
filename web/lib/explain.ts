// Plain-language descriptions of nodes and edges, written for someone who has never seen the graph:
// what the connection says, why anyone should care, and how Orion knows it.

import { fmtDate, plural } from "./format";
import type { EdgeType, GEdge, GNode } from "./types";

export type Tone = "warn" | "bad" | "ok";

export interface EdgeStory {
  /** headline split so the verb can be styled: "{subject} {verb} {object}" */
  subject: string;
  verb: string;
  object: string;
  /** one line for hover tooltips */
  short: string;
  /** what the connection means, in everyday words */
  meaning: string;
  /** why it matters, or what you'd do with it */
  matters: string;
  /** how Orion knows: written down somewhere, or worked out from activity */
  how: string;
  /** true when Orion computed it rather than reading it from a record */
  derived: boolean;
  stats: { label: string; value: string }[];
  flag?: { text: string; tone: Tone };
}

const REPO_KINDS = new Set(["code", "test", "docs", "build", "config", "ci"]);

/** "service", "folder", "team"... the everyday noun for a node. */
export function nounOf(n?: GNode | null): string {
  if (!n) return "item";
  switch (n.type) {
    case "Service":
      if (REPO_KINDS.has(n.kind ?? "")) return "folder";
      return n.retired ? "switched-off system" : "system";
    case "Person":
      return n.former ? "former employee" : "person";
    case "Team":
      return "team";
    case "Customer":
      return "customer";
    case "Project":
      return "project";
    case "Decision":
      return "decision";
  }
}

export function nameOf(n?: GNode | null, fallback?: string | null): string {
  if (!n) return fallback ?? "?";
  if (n.type === "Decision") return n.key ? `${n.key}` : n.name ?? n.id;
  return n.name ?? fallback ?? n.id.replace(/^[a-z]+:/, "");
}

/** A one-line description of a node for tooltips and the inspector. */
export function describeNode(n: GNode): string {
  switch (n.type) {
    case "Person": {
      const bits = [n.role, n.team ? `${n.team} team` : null].filter(Boolean);
      return n.former ? "Has left the company" : bits.length ? bits.join(" · ") : "Person";
    }
    case "Team":
      return n.kind === "official" ? "Team on the org chart" : "Team";
    case "Service":
      if (REPO_KINDS.has(n.kind ?? "")) return `Part of the project · ${n.kind}`;
      if (n.retired) return "System, switched off";
      return n.tier === 1
        ? "System · business-critical: the business stops if it fails"
        : n.tier === 2
          ? "System · important"
          : "System · supporting";
    case "Customer":
      return "Customer";
    case "Project":
      return n.status ? `Project · ${n.status}` : "Project";
    case "Decision":
      return `${n.name ?? "Decision"}${n.status ? ` · ${n.status}` : ""}`;
  }
}

/** Relationship names as seen from one end, for the node inspector ("Relied on by: edge-gateway, ..."). */
export const RELATION: Record<EdgeType, { out: string; in: string }> = {
  DEPENDS_ON: { out: "Relies on", in: "Relied on by" },
  DEPENDS_ON_CLOSED: { out: "Used to rely on", in: "Used to be relied on by" },
  OWNS: { out: "Owns", in: "Owned by" },
  MEMBER_OF: { out: "Member of", in: "Members" },
  KNOWS: { out: "Knows", in: "Known by" },
  COLLABORATES: { out: "Works closely with", in: "Works closely with" },
  USES: { out: "Uses", in: "Used by" },
  WORKED_ON: { out: "Worked on", in: "Worked on by" },
  AFFECTS: { out: "Affects", in: "Shaped by decisions" },
  ON_CALL_FOR: { out: "On call for", in: "Who gets paged" },
  RAISED_ABOUT: { out: "Complained about", in: "Complaints from" },
  CO_CHANGES: { out: "Changes together with", in: "Changes together with" },
};

/** Which end of an edge reads naturally first in the inspector, and its label. */
export function relationFrom(e: GEdge, self: string): string {
  if (e.type === "OWNS" && e.declared === false) return e.source === self ? "Actually maintains" : "Actually maintained by";
  const r = RELATION[e.type];
  return e.source === self ? r.out : r.in;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function sinceStat(e: GEdge, label = "Since"): { label: string; value: string }[] {
  return e.since ? [{ label, value: fmtDate(e.since.slice(0, 10), true) }] : [];
}

interface Context {
  nodes?: GNode[];
  edges?: GEdge[];
}

/** Explain one edge. `s`/`t` are the endpoints when the canvas knows them; names alone also work. */
export function explainEdge(
  e: Pick<GEdge, "type"> & Partial<GEdge>,
  s?: GNode | null,
  t?: GNode | null,
  names?: { source?: string | null; target?: string | null },
  ctx?: Context,
): EdgeStory {
  const S = nameOf(s, names?.source ?? e.source);
  const T = nameOf(t, names?.target ?? e.target);
  const tNoun = nounOf(t);
  const others = (pred: (x: GEdge) => boolean) => (ctx?.edges ?? []).filter(pred);
  const nameById = new Map((ctx?.nodes ?? []).map((n) => [n.id, nameOf(n)]));
  const list = (ids: string[], max = 4) => {
    const names = ids.map((id) => nameById.get(id) ?? id.replace(/^[a-z]+:/, ""));
    return names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
  };
  const edge = e as GEdge;

  switch (e.type) {
    case "DEPENDS_ON": {
      const how =
        e.kind === "async"
          ? `It sends ${T} work to do and carries on without waiting, so if ${T} is down, things get delayed rather than failing on the spot.`
          : e.kind === "data"
            ? `It reads data that ${T} produces, so if ${T} stops, ${S} works from stale or missing data.`
            : `It waits for ${T} to answer every time, so if ${T} is down, ${S} fails too.`;
      const dependents = others((x) => x.type === "DEPENDS_ON" && x.target === e.target).map((x) => x.source);
      // three answers: in the catalog, found in a conversation, or not known here (the sources below say)
      const undeclared = e.declared === false;
      const known = e.declared === true || e.declared === false;
      return {
        subject: S,
        verb: "relies on",
        object: T,
        short: `${S} needs ${T} to work`,
        meaning: `${S} calls ${T} while it runs. ${how}`,
        matters:
          `If ${T} breaks, changes how it works, or is switched off, ${S} is likely to break with it. Whoever plans a change to ${T} should check with the people behind ${S} first.` +
          (dependents.length > 1 ? ` ${T} is relied on by ${plural(dependents.length, "system")} in total: ${list(dependents)}.` : ""),
        how: undeclared
          ? `Nobody wrote this down in the official list of systems. Orion found it in a conversation between engineers, so a plan that only reads the official list will miss it.`
          : known
            ? `Written down in the official list of systems.`
            : `Read from the sources listed below.`,
        derived: false,
        stats: [
          ...sinceStat(edge),
          {
            label: "Kind",
            value: e.kind === "async" ? "Doesn't wait for a reply" : e.kind === "data" ? "Reads its data" : "Waits for a reply",
          },
        ],
        flag: undeclared ? { text: "Not in the official list", tone: "warn" } : undefined,
      };
    }
    case "DEPENDS_ON_CLOSED":
      return {
        subject: S,
        verb: "used to rely on",
        object: T,
        short: `${S} no longer needs ${T}`,
        meaning: `${S} called ${T} in the past, but that has ended. It is kept so you can see how things changed over time.`,
        matters: `Switching ${T} off won't affect ${S} any more.`,
        how: `Written down in the official list of systems, with the date it ended.`,
        derived: false,
        stats: sinceStat(edge, "Started"),
      };
    case "OWNS": {
      if (e.declared === false) {
        return {
          subject: S,
          verb: "actually maintains",
          object: T,
          short: `${S} does most of the work on ${T}`,
          meaning:
            `On paper, a different team owns ${T}. In practice, people in ${S} made ` +
            (e.share ? `${pct(e.share)} of its code changes` : "most of its code changes") +
            ` over the last 90 days${e.changes ? ` (${plural(e.changes, "change")})` : ""}.`,
          matters: `The official owner may not be the right people to ask. When something about ${T} needs deciding, bring ${S} in too.`,
          how: `Worked out by Orion from who changed the code. Nobody wrote it down, which is the point: it disagrees with the official record.`,
          derived: true,
          stats: [
            ...(e.share ? [{ label: "Share of changes", value: pct(e.share) }] : []),
            ...(e.changes ? [{ label: "Changes, last 90 days", value: String(e.changes) }] : []),
          ],
          flag: { text: "Differs from the official owner", tone: "warn" },
        };
      }
      return {
        subject: S,
        verb: "owns",
        object: T,
        short: `${S} is responsible for ${T}`,
        meaning: `${S} is the team on the hook for ${T}: they look after it, review changes to it and decide what happens to it.`,
        matters: `Questions, bugs and change requests about ${T} go to ${S}.`,
        how: `Written down in an official record: the list of systems, the team wiki, or the project's list of owners.`,
        derived: false,
        stats: sinceStat(edge),
      };
    }
    case "MEMBER_OF": {
      const size = others((x) => x.type === "MEMBER_OF" && x.target === e.target).length;
      return {
        subject: S,
        verb: "is on",
        object: `the ${T} team`,
        short: `${S} is on the ${T} team`,
        meaning: `${S} works in ${T}${s?.role ? ` as ${/^[aeiou]/i.test(s.role) ? "an" : "a"} ${s.role}` : ""}.`,
        matters: size > 1 ? `${T} has ${plural(size, "person", "people")} on this graph. Reach ${S} through ${T}, and vice versa.` : `Reach ${S} through ${T}, and vice versa.`,
        how: `From the org chart.`,
        derived: false,
        stats: sinceStat(edge, "Joined"),
      };
    }
    case "KNOWS": {
      const experts = others((x) => x.type === "KNOWS" && x.target === e.target).map((x) => x.source);
      return {
        subject: S,
        verb: "knows",
        object: T,
        short: `${S} has hands-on experience with ${T}`,
        meaning:
          `${S} changed or reviewed ${T} ${e.touches ? plural(e.touches, "time") : "several times"} in the last 6 months` +
          (e.last_at ? `, most recently on ${fmtDate(e.last_at.slice(0, 10), true)}.` : "."),
        matters:
          experts.length === 1
            ? `${S} is the only person who knows ${T}. If they're away or leave, nobody else can help with it.`
            : experts.length > 1
              ? `${S} is one of ${experts.length} people who can actually answer questions about ${T}: ${list(experts)}.`
              : `If you need help with ${T}, ${S} is someone who can actually answer.`,
        how: `Worked out by Orion from code changes and reviews (at least 3 in 180 days). Nobody wrote it down.`,
        derived: true,
        stats: [
          ...(e.touches ? [{ label: "Changes and reviews", value: String(e.touches) }] : []),
          ...(e.last_at ? [{ label: "Last time", value: fmtDate(e.last_at.slice(0, 10), true) }] : []),
        ],
        flag: experts.length === 1 ? { text: "Only person who knows it", tone: "bad" } : undefined,
      };
    }
    case "COLLABORATES": {
      const w = e.weight ?? 0;
      const level = w >= 10 ? "almost constantly" : w >= 5 ? "often" : "regularly";
      const sameTeam = s?.team && t?.team && s.team === t.team;
      const crossTeam = s?.team && t?.team && s.team !== t.team;
      return {
        subject: S,
        verb: "works closely with",
        object: T,
        short: `${S} and ${T} work together ${level}`,
        meaning: `${S} and ${T} review each other's code and work on the same tickets, ${level} over the last 6 months.`,
        matters: crossTeam
          ? `They're on different teams (${s!.team} and ${t!.team}), so this is work the org chart doesn't show. Links like this are how the Org screen finds the groups people really work in.`
          : sameTeam
            ? `They're both on ${s!.team}, as the org chart says.`
            : `Links like this show how work really flows between people, which the org chart can miss.`,
        how: `Worked out by Orion over the last 6 months: 2 points for each code review, 1 for each shared ticket, with older work counting for less. Pairs above 3 points get a link.`,
        derived: true,
        stats: w ? [{ label: "Score", value: `${w.toFixed(1)} (link at 3+)` }] : [],
      };
    }
    case "USES": {
      const isCustomer = s?.type === "Customer";
      return {
        subject: S,
        verb: isCustomer ? "uses" : "builds on",
        object: T,
        short: isCustomer ? `${S} is a customer of ${T}` : `The ${S} project involves ${T}`,
        meaning: isCustomer
          ? `${S} uses ${T} as part of what they buy from the company.`
          : `The ${S} project changes, replaces or depends on ${T}.`,
        matters: isCustomer
          ? `An outage or change in ${T} is something ${S} will notice.`
          : `Changing ${T} can affect this project's plans, and the project's plans can change ${T}.`,
        how: `Written down in the project or account records.`,
        derived: false,
        stats: sinceStat(edge),
      };
    }
    case "WORKED_ON":
      return {
        subject: S,
        verb: "worked on",
        object: T,
        short: `${S} worked on ${T}`,
        meaning: `${S} was part of the ${T} project.`,
        matters: `A good person to ask about why ${T} made the choices it did.`,
        how: `Written down in the project records.`,
        derived: false,
        stats: sinceStat(edge),
      };
    case "AFFECTS":
      return {
        subject: s?.name ? `${S} (${s.name})` : S,
        verb: "affects",
        object: T,
        short: `Decision ${S} changes ${T}`,
        meaning: `The decision ${S}${s?.name ? `, "${s.name}",` : ""} changes how ${T} works, or whether it should exist at all.`,
        matters: `Read this decision before changing ${T}. It explains why things are the way they are, and changing ${T} may undo it.`,
        how: `From the written decision record that names ${T}.`,
        derived: false,
        stats: [...sinceStat(edge, "Decided"), ...(s?.status ? [{ label: "Status", value: s.status }] : [])],
      };
    case "ON_CALL_FOR":
      return {
        subject: S,
        verb: "gets paged for",
        object: T,
        short: `${S} gets woken up when ${T} breaks`,
        meaning: `${S} is on call for ${T}: when it fails, even at 3 am, they're the ones who get the alert.`,
        matters: `The on-call team isn't always the owner. If they differ, an incident in ${T} needs both teams.`,
        how: `From the on-call schedule.`,
        derived: false,
        stats: sinceStat(edge),
      };
    case "RAISED_ABOUT":
      return {
        subject: S,
        verb: "complained about",
        object: T,
        short: `${S} opened ${e.tickets ? plural(e.tickets, "ticket") : "tickets"} about ${T}`,
        meaning: `${S} has opened ${e.tickets ? plural(e.tickets, "support ticket") : "support tickets"} about problems with ${T}.`,
        matters: `${T} already hurts this customer. Any change to it is something they'll notice first.`,
        how: `Counted by Orion from support tickets. Shown when a customer has 2 or more about the same ${tNoun}.`,
        derived: true,
        stats: e.tickets ? [{ label: "Tickets", value: String(e.tickets) }] : [],
      };
    case "CO_CHANGES":
      return {
        subject: S,
        verb: "changes together with",
        object: T,
        short: `${S} and ${T} usually change together`,
        meaning: `Code changes to ${S} often change ${T} as well${e.weight ? ` (${plural(e.weight, "time")})` : ""}.`,
        matters: `They're tied together even if the code doesn't say so. Changing one without the other is a common source of bugs.`,
        how: `Found by Orion in the project's history of code changes.`,
        derived: !e.uid,
        stats: sinceStat(edge),
        flag: { text: "Always change together", tone: "warn" },
      };
  }
}
