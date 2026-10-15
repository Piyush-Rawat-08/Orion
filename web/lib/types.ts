// Shapes returned by the Orion FastAPI backend (see backend/src/orion/api.py).

export type NodeType = "Person" | "Team" | "Service" | "Customer" | "Project" | "Decision";

export interface GNode {
  id: string;
  type: NodeType;
  name: string | null;
  role?: string | null;
  tier?: number | null;
  status?: string | null;
  grp?: string | null;
  key?: string | null;
  kind?: string | null;
  team?: string | null;
  retired: boolean;
  former: boolean;
}

export type EdgeType =
  | "MEMBER_OF"
  | "OWNS"
  | "DEPENDS_ON"
  | "DEPENDS_ON_CLOSED"
  | "KNOWS"
  | "COLLABORATES"
  | "USES"
  | "WORKED_ON"
  | "AFFECTS"
  | "ON_CALL_FOR"
  | "RAISED_ABOUT"
  | "CO_CHANGES";

export interface GEdge {
  source: string;
  target: string;
  type: EdgeType;
  uid?: string | null;
  declared?: boolean | null;
  touches?: number | null;
  weight?: number | null;
  tickets?: number;
  /** DEPENDS_ON: sync, async or data */
  kind?: string | null;
  /** when the relationship started (valid_from, or the decision date for AFFECTS) */
  since?: string | null;
  /** KNOWS: the person's most recent change or review */
  last_at?: string | null;
  /** de-facto OWNS: share of the service's recent changes made by the team, and how many */
  share?: number | null;
  changes?: number | null;
}

export interface Snapshot {
  asof: string;
  version: number;
  copy_ms: number;
  prune_ms: number;
  total_ms: number;
  graph: string;
  cached: boolean;
  derived?: Record<string, number>;
}

export interface GraphPayload {
  graph: string;
  asof: string;
  nodes: GNode[];
  edges: GEdge[];
  snapshot?: Snapshot;
  universe?: string;
}

export interface Person {
  uid: string;
  name: string;
  role: string | null;
  team: string | null;
}

export interface Tenant {
  id: string;
  name: string;
  kind: string;
  description?: string;
  clock: string;
  loaded: boolean;
}

export interface Timeline {
  start: string;
  now: string;
  months: string[];
  decisions: { uid: string; key: string; title: string; status: string; at: string }[];
  events: { uid: string; at: string; label: string; kind: string }[];
}

/** verified = the graph returned exactly that set or number; judged = a model accepted it on the cited rows;
 *  expired = its receipt is gone (a universe merged or discarded); not_checked = too big to check in full. */
export type Verdict =
  | "verified"
  | "partial"
  | "judged"
  | "unsupported"
  | "contradicted"
  | "unverified"
  | "not_checked"
  | "expired";

export type ClaimKind = "breaks" | "knows" | "owns" | "depends_on" | "decided" | "count" | "metric" | "free";

/** The receipt of a typed claim: the query that ran and what it returned. */
export interface ClaimCheck {
  graph: string;
  query: string;
  cypher: string;
  params: Record<string, unknown>;
  result: unknown;
}

export interface Claim {
  uid?: string;
  index?: number;
  text: string;
  verdict: Verdict;
  reason: string;
  evidence: string[];
  facts: string[];
  nodes: string[];
  kind?: ClaimKind;
  check?: ClaimCheck | null;
  stale?: boolean | null;
  stale_reason?: string | null;
}

export interface Evidence {
  eid: string;
  graph: string;
  query: string;
  cypher: string;
  params: Record<string, unknown>;
  node_uids: string[];
  fact_uids: string[];
  asof: string | null;
  summary: string;
  universe_eid?: string;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  ok: boolean;
  evidence: string[];
}

/** The summary held to the verified points: anything it names, counts or says happens that none of them backs. */
export interface SummaryCheck {
  covered: boolean;
  issues: string[];
}

export interface AskResult {
  answer: string;
  session: string | null;
  question: string;
  summary: string;
  summary_check?: SummaryCheck;
  claims: Claim[];
  follow_ups: string[];
  evidence: Evidence[];
  tool_calls: ToolCall[];
  universes: ToolCall[];
  asof: string;
  ms: number;
  usage?: { input: number; output: number; cache_read: number };
  /** what FalkorDB did for this answer */
  graph?: GraphUse | null;
  error?: string;
}

export interface GraphUse {
  queries: number;
  copies: number;
  ms: number;
  graphs: string[];
}

export interface Op {
  op: string;
  [k: string]: unknown;
}

export interface RiskTerm {
  kind: "break" | "customer" | "orphan" | "stranded" | "split" | "bottleneck";
  subject: string;
  points: number;
  why: string;
  evidence?: string | null;
}

export interface Risk {
  score: number;
  level: "low" | "medium" | "high";
  auto_approve: boolean;
  reasons: string[];
  terms?: RiskTerm[];
  uncapped?: number;
}

export interface Broken {
  uid: string;
  service: string;
  because_of: string;
  hops: number;
  tier: number;
  owners: string[];
  people_who_know_it: string[];
  fact_uids: string[];
  via_undeclared: string[];
  evidence: string;
  /** what losing the dependency does: break (sync), degrade (async), stale (data) */
  effect?: "break" | "degrade" | "stale";
  /** witness path, retired service first */
  path?: string[];
  kinds?: string[];
}

export interface AffectedCustomer {
  uid: string;
  customer: string;
  tier: string;
  services: string[];
  tickets: string[];
  uses: string[];
}

export interface RequiredApprover {
  team_uid: string;
  team: string;
  because: string[];
  approved_by?: string[];
}

export interface Shift {
  uid: string;
  name: string;
  before: number;
  after: number;
  delta: number;
}

export interface Diff {
  universe: string;
  base: string;
  title: string;
  asof: string;
  broken: Broken[];
  customers?: AffectedCustomer[];
  stranded?: { services: string[]; uids: string[]; evidence: string }[];
  required_approvers?: RequiredApprover[];
  new_orphans: { uid: string; service: string; tier: number; evidence: string }[];
  collaboration_splits: { groups: string[][]; evidence: string }[];
  bottlenecks: {
    before: { uid: string; name: string; score: number }[];
    after: { uid: string; name: string; score: number }[];
    shift: Shift[];
  };
  influence: { shift: Shift[] };
  structural: {
    retired: string[];
    former: string[];
    closed_dependencies: { uid: string; source: string; target: string }[];
    proposed_tickets: { key: string; title: string; service: string }[];
  };
  risk: Risk;
  evidence: Evidence[];
  diff_ms: number;
}

export interface Universe {
  uid: string;
  status: "open" | "merged" | "discarded" | "rebased";
  kind: "whatif" | "dryrun" | string;
  created_at: string;
  graph: string;
  base: string;
  title: string;
  created_by: string;
  base_version: number;
  copy_ms: number;
  apply_ms: number;
  risk?: number;
  risk_level?: string;
  ops: Op[];
  merged_at?: string;
  merged_by?: string;
  discarded_at?: string;
}

export interface Approval {
  by: string;
  team_uid?: string | null;
  team?: string | null;
  verdict: string;
  at: string;
  reason?: string | null;
}

export interface UniverseDetail extends Universe {
  diff: Diff | null;
  /** what a merge wrote into the records: the facts it opened, and the ones it closed */
  opened_facts?: string[];
  closed_facts?: string[];
  approvals: Approval[];
  required: RequiredApprover[];
  missing: RequiredApprover[];
  /** FalkorDB Browser link to this universe's graph */
  browser?: string;
  rebased_to?: string;
  rebased_from?: string;
}

/** POST /universes/{uid}/approve: 200 waiting | merged; 409 rebase_needed | blocked (in ApiError.body). */
export type ApproveResult =
  | ({ status: "waiting"; universe: string; required: RequiredApprover[]; missing: RequiredApprover[];
       counted_for: string[] })
  | ({ status: "merged" } & MergeResult & { required: RequiredApprover[] });

export interface RebaseNeeded {
  status: "rebase_needed";
  from: string;
  to: string;
  changed: boolean;
  risk: { before: number; after: number; level_before: string; level_after: string };
  broken: { before: string[]; after: string[]; no_longer: string[]; newly: string[] };
}

export interface MergeBlockedDetail {
  status: "blocked";
  universe: string;
  retired: string[];
  broken: string[];
  needs_migration: string[];
  message: string;
}

export interface ForkResult extends Universe {
  applied: unknown;
  fork_ms: number;
  diff: Diff;
  _worker?: string;
  _task?: string;
}

export interface MergeResult {
  universe: string;
  decision: string;
  merged_at: string;
  version: number;
  log: unknown[];
  merge_ms: number;
  forced?: boolean;
  expired_answers?: number;
}

export interface BlameSource {
  fact: string;
  type: string;
  subject: string | null;
  object: string | null;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string | null;
  source_uid: string;
  kind: string | null;
  title: string | null;
  url: string | null;
  at: string | null;
  text: string | null;
  author: string | null;
  quote?: string | null;
  /** false when the fact is not in the official record (it came from a conversation) */
  declared?: boolean | null;
}

export interface ToolResponse<T> {
  result: T;
  evidence: Evidence[];
  ms: number | null;
}

export interface Communities {
  asof: string;
  discovered: { members: string[]; size: number; official_teams: Record<string, number>; matches_team: boolean }[];
  official_team_count: number;
  discovered_count: number;
  teams_that_work_as_several_groups: string[];
  bridges: { name: string; score: number }[];
  error?: string;
}

export interface Activity {
  agents: { name: string; role: string; pid: number; status: string; heartbeat_at: number; kinds?: string[] }[];
  tasks: {
    uid: string;
    kind: string;
    status: string;
    worker: string | null;
    created_at: number;
    claimed_at: number | null;
    done_at: number | null;
    posted_by: string;
    summary: string | null;
    attempts?: number;
    /** the first task of the chain this one belongs to */
    root?: string;
    follows?: string | null;
  }[];
  now: number;
  /** the agents' queries only (the screens' own polling is left out), each with the board task it ran for */
  queries: { graph: string; cypher: string; ms: number; rows: number; read_only: boolean; at: number; task: string | null }[];
}

export interface Stats {
  nodes: { label: string; n: number }[];
  relationships: number;
  graphs: string[];
  universes: number;
  copy_ms_median: number | null;
  clock: string;
  version: number;
  workers: number;
}

export interface Notification {
  uid: string;
  user: string;
  answer_uid: string;
  question: string;
  asked_at: string;
  broken_claims: string[];
  total_claims: number;
  fact: string;
  source_uid: string;
  at: string;
  read: boolean;
  why?: string;
  /** what is true now, in one line: "invoice-render no longer depends on sso-legacy" */
  now?: string | null;
  /** for each broken point, why its check failed now ("on today's company: no longer breaks invoice-render") */
  reasons?: string[];
  /** "watch": a watched question was re-checked (every mark that moved); "expired": points stopped holding */
  kind?: "watch" | "expired";
  changes?: { text: string; before: Verdict; after: Verdict; reason: string }[];
}

export interface Review {
  uid: string;
  change: { relation: string; subject: string; object: string; change: string; quote?: string };
  source_uid: string;
  author_uid: string | null;
  confidence: number;
  why: string;
  at: string;
  status: string;
  /** the teams whose people may confirm or ignore it */
  deciders?: string[];
}

export interface BeliefVersion {
  key: string;
  text: string;
  valid_from: string;
  valid_to: string | null;
  changed: boolean | null;
  replaced: string | null;
  learned_from: string | null;
  learned_at: string | null;
}

export interface AnswerRow {
  uid: string;
  question: string;
  summary: string;
  at: string;
  status: string;
  asked_by: string;
  claims: number;
}

export interface AnswerDetail {
  uid: string;
  question: string;
  summary: string;
  at: string;
  status: string;
  asked_by: string;
  claims: Claim[];
  [k: string]: unknown;
}

/** GET /sessions/last: the user's most recent conversation, question by question. */
export interface LastSession {
  session: string | null;
  turns: {
    question: string;
    at: string;
    answer: string;
    status: string;
    result: Pick<AskResult, "summary" | "summary_check" | "claims" | "follow_ups" | "evidence" | "universes" | "graph">;
  }[];
}

export interface Message {
  uid: string;
  channel: string;
  at: string;
  text: string;
  author: string | null;
  live: boolean | null;
}
