export type Person = { uid: string; name: string; role: string; team: string; team_name: string };

export type Meta = {
  company: string;
  tenant: string;
  clock: string;
  version: number;
  me: Person;
  llm: { provider: string | null; smart: string; fast: string; available: boolean };
  unread: number;
  waiting: number;
};

export type GTeam = { id: string; label: string; mission: string; size: number };
export type GService = {
  id: string;
  label: string;
  tier: number;
  lang: string;
  summary: string;
  created: string;
  team: string | null;
  knowers: number;
  rank: number;
};
export type GRetired = { id: string; label: string; tier: number; retired: string; team: string | null };
export type GPerson = { id: string; label: string; role: string; joined: string; team: string | null; between: number };
export type GFormer = { id: string; label: string; left: string };
export type GCustomer = { id: string; label: string; tier: string; industry: string };
export type GDep = { source: string; target: string; kind: "sync" | "async" | "data"; uid: string; dangling: boolean };
export type GKnow = { source: string; target: string; n: number };
export type GLink = { source: string; target: string; w?: number };
export type Hidden = {
  people: { uid: string; name: string; team: string; team_name: string }[];
  teams: string[];
  projects: { uid: string; name: string; n: number }[];
};

export type Galaxy = {
  graph: string;
  teams: GTeam[];
  services: GService[];
  retired: GRetired[];
  people: GPerson[];
  former: GFormer[];
  customers: GCustomer[];
  deps: GDep[];
  knows: GKnow[];
  uses: GLink[];
  collab: GLink[];
  constellations: { a: string; b: string; w: number }[];
  hidden: Hidden[];
  stats: Record<string, number>;
  on?: string;
  mode?: string;
};

export type Effect = "break" | "degrade" | "stale";

export type Break = {
  uid: string;
  name: string;
  tier: number;
  effect: Effect;
  depth: number;
  path: string[];
  path_names: string[];
  facts: string[];
  owner: string | null;
  owner_name: string | null;
};

export type RiskTerm = { term: string; entity: string | null; points: number; label: string };

export type Diff = {
  retired: { uid: string; name: string; tier: number }[];
  breaks: Break[];
  customers: { uid: string; name: string; tier: string; effect: Effect; via: string[]; tickets: string[] }[];
  orphans: { uid: string; name: string; tier: number; owner_name: string; knew: string[] }[];
  stranded: { services: { uid: string; name: string }[] }[];
  splits: { before: number; parts: number; people: string[] }[];
  bottlenecks: { before: { uid: string; name: string; score: number }[]; after: { uid: string; name: string; score: number }[]; shifted: boolean };
  dangling: { dependent: string; dependent_name: string; on: string; on_name: string; kind: string }[];
  changed: { removed: string[][]; added: string[][] };
  approvals: { team: string; team_name: string; why: string[] }[];
  risk: { score: number; level: "clear" | "watch" | "danger"; terms: RiskTerm[] };
  summary: string;
  ms: number;
};

export type Universe = {
  uid: string;
  graph: string;
  kind: "whatif" | "outage" | "plan" | "backtest";
  title: string;
  ops: Record<string, string>[];
  by: string;
  created_at: string;
  status: "open" | "merging" | "merged" | "discarded" | "obsolete";
  risk: number;
  level: "clear" | "watch" | "danger";
  diff: Diff;
  approvals: { team: string; by: string; by_name: string; at: string }[];
  required: string[];
  on?: string | null;
  mode?: string | null;
  stale?: boolean;
  ms?: { copy: number; total: number };
  decision?: string;
  reason?: string;
  rebased_from?: number;
};

export type ClaimStatus = "verified" | "partial" | "contradicted" | "outdated" | "unconfirmed" | "judged" | "unsupported";

export type Claim = {
  uid: string;
  sentence: string;
  type: string;
  status: ClaimStatus;
  claim: Record<string, unknown>;
  result: { status: ClaimStatus; why?: string; expected?: unknown; missing?: string[]; extra?: string[]; checked_at?: string };
  checked_at: string;
  history: { at: string; cause: string; before: { status: string; expected?: unknown }; after: { status: string; expected?: unknown; why?: string } }[];
  about: string[];
};

export type Evidence = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  uids: string[];
  queries: { graph: string; cypher: string; params: Record<string, unknown>; rows: number }[];
  rows: unknown;
};

export type Answer = {
  uid: string;
  question: string;
  text: string;
  at: string;
  status: "fresh" | "changed";
  asked_by: string | null;
  session: string | null;
  evidence: Evidence[];
  meta: { steps: number; ms: number; usage: { input: number; output: number }; follow_ups: string[]; model: { smart: string } };
  claims: Claim[];
};

export type TimelineEvent = {
  at: string;
  kind: "born" | "retired" | "joined" | "left" | "decision" | "incident" | "discovered";
  uid: string;
  label: string;
  tier?: number;
  status?: string;
};
