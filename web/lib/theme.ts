// Colour tokens shared by the WebGL canvas (which can't read CSS variables cheaply) and the UI.
// Keep in sync with app/globals.css (dark in @theme, light under [data-theme="light"]).

import type { EdgeType, NodeType, Verdict } from "./types";

export type Theme = "dark" | "light";

// Two palettes with the same roles. The objects below are the live ones: applyPalette() copies the active
// theme into them, and the app remounts its screens when the theme changes, so everything that reads a colour
// during render (canvases, inline dots, SVG strokes) picks up the new values. Data hues get deeper on paper so
// they keep their contrast.
const DARK = {
  C: {
    night: "#0a0a09",
    panel: "#111110",
    raised: "#191917",
    rule: "#252420",
    text: "#ede9e1",
    label: "#d6d1c7",
    muted: "#9c978d",
    faint: "#827d73",
    trunk: "#ede9e1",
    ember: "#ff6b35",
    verified: "#6dd3a0",
    partial: "#e9b44c",
    bad: "#f0544f",
    added: "#6dd3a0",
    orphan: "#e9b44c",
    ghost: "#3a3834",
    retired: "#4a4741",
    contributor: "#57534c",
    undeclared: "#e9b44c",
  },
  UNIVERSE: ["#7ba6ff", "#b99cff", "#4ccfc0", "#f48fb1", "#8ad4f0", "#d8b88a", "#9aa5ff"],
  GROUPS: ["#7ba6ff", "#4ccfc0", "#d8a26e", "#b99cff", "#f48fb1", "#c3d977", "#ede9e1", "#8ad4f0"],
  NODE: { Service: "#7ba6ff", Team: "#ede9e1", Person: "#85807a", Customer: "#d8a26e", Project: "#b99cff", Decision: "#4ccfc0" },
  EDGE: {
    DEPENDS_ON: "#43618f",
    DEPENDS_ON_CLOSED: "#5a3436",
    OWNS: "#57534c",
    MEMBER_OF: "#302e2a",
    KNOWS: "#2b2926",
    COLLABORATES: "#2a2825",
    USES: "#463d68",
    WORKED_ON: "#33302c",
    AFFECTS: "#2a625b",
    ON_CALL_FOR: "#625331",
    RAISED_ABOUT: "#6f543a",
    CO_CHANGES: "#82643c",
  },
  /** one bright colour per relationship, for lines and dots drawn on panels */
  EDGE_DOT: {
    DEPENDS_ON: "#7ba6ff",
    DEPENDS_ON_CLOSED: "#f0544f",
    OWNS: "#ede9e1",
    ON_CALL_FOR: "#e9b44c",
    MEMBER_OF: "#c9c3b8",
    KNOWS: "#b0a99c",
    COLLABORATES: "#b0a99c",
    USES: "#b99cff",
    WORKED_ON: "#b0a99c",
    AFFECTS: "#4ccfc0",
    RAISED_ABOUT: "#d8a26e",
    CO_CHANGES: "#d8a26e",
  },
  KIND: { code: "#7ba6ff", test: "#4ccfc0", docs: "#b99cff", build: "#d8a26e", config: "#9c978d", ci: "#c3d977" },
};

const LIGHT: typeof DARK = {
  C: {
    night: "#f4f2ed",
    panel: "#fbfaf7",
    raised: "#efece6",
    rule: "#e1ddd4",
    text: "#1b1a17",
    label: "#3b3833",
    muted: "#55514a",
    faint: "#6b675f",
    trunk: "#1b1a17",
    ember: "#b54516",
    verified: "#0f7a4b",
    partial: "#8a5d00",
    bad: "#d23c37",
    added: "#0f7a4b",
    orphan: "#c48a12",
    ghost: "#d3cec3",
    retired: "#b9b3a7",
    contributor: "#a49e93",
    undeclared: "#c48a12",
  },
  UNIVERSE: ["#3567d4", "#7c55d8", "#0f8f84", "#cf3f78", "#1f86b8", "#9d6f22", "#4f58d0"],
  GROUPS: ["#3567d4", "#0f8f84", "#b06a2c", "#7c55d8", "#cf3f78", "#6c8a12", "#3b3833", "#1f86b8"],
  NODE: { Service: "#3567d4", Team: "#1b1a17", Person: "#8d877c", Customer: "#b06a2c", Project: "#7c55d8", Decision: "#0f8f84" },
  EDGE: {
    DEPENDS_ON: "#9db4e6",
    DEPENDS_ON_CLOSED: "#e6aeab",
    OWNS: "#b8b2a6",
    MEMBER_OF: "#d9d4c9",
    KNOWS: "#e0dcd3",
    COLLABORATES: "#e1ddd4",
    USES: "#c9bcec",
    WORKED_ON: "#d6d1c6",
    AFFECTS: "#98d0c9",
    ON_CALL_FOR: "#e2cd9a",
    RAISED_ABOUT: "#e2c3a3",
    CO_CHANGES: "#d8ad70",
  },
  EDGE_DOT: {
    DEPENDS_ON: "#3567d4",
    DEPENDS_ON_CLOSED: "#d23c37",
    OWNS: "#1b1a17",
    ON_CALL_FOR: "#a9740b",
    MEMBER_OF: "#5d584f",
    KNOWS: "#7a746a",
    COLLABORATES: "#7a746a",
    USES: "#7c55d8",
    WORKED_ON: "#7a746a",
    AFFECTS: "#0f8f84",
    RAISED_ABOUT: "#b06a2c",
    CO_CHANGES: "#b06a2c",
  },
  KIND: { code: "#3567d4", test: "#0f8f84", docs: "#7c55d8", build: "#b06a2c", config: "#8d877c", ci: "#6c8a12" },
};

export const C = { ...DARK.C };

/** One accent per universe. Never red, green or amber: those mean broken, added and orphaned. */
export const UNIVERSE_ACCENTS = [...DARK.UNIVERSE];

/** Colours for detected communities on the Org screen. */
export const GROUP_COLORS = [...DARK.GROUPS];

export function universeAccent(uid?: string | null): string {
  if (!uid) return C.trunk;
  const n = parseInt(uid.replace(/\D/g, ""), 10);
  return UNIVERSE_ACCENTS[(Number.isFinite(n) ? n : uid.length) % UNIVERSE_ACCENTS.length];
}

export const NODE_COLORS: Record<NodeType, string> = { ...DARK.NODE };

export const EDGE_COLORS: Partial<Record<EdgeType, string>> = { ...DARK.EDGE };

export const EDGE_DOT: Partial<Record<EdgeType, string>> = { ...DARK.EDGE_DOT };

/** File kinds on the Repos screen. */
export const KIND_COLORS: Record<string, string> = { ...DARK.KIND };

export const EDGE_LABELS: Record<EdgeType, string> = {
  DEPENDS_ON: "relies on",
  DEPENDS_ON_CLOSED: "used to rely on",
  OWNS: "owns",
  MEMBER_OF: "is on",
  KNOWS: "knows",
  COLLABORATES: "works with",
  USES: "uses",
  WORKED_ON: "worked on",
  AFFECTS: "affects",
  ON_CALL_FOR: "on call for",
  RAISED_ABOUT: "reported problems with",
  CO_CHANGES: "changes together with",
};

export const VERDICT_COLORS = {} as Record<Verdict, string>;

let active: Theme | null = null;

/** Make `theme` the palette every importer of this module sees. */
export function applyPalette(theme: Theme) {
  if (theme === active) return;
  active = theme;
  const P = theme === "light" ? LIGHT : DARK;
  Object.assign(C, P.C);
  UNIVERSE_ACCENTS.splice(0, UNIVERSE_ACCENTS.length, ...P.UNIVERSE);
  GROUP_COLORS.splice(0, GROUP_COLORS.length, ...P.GROUPS);
  Object.assign(NODE_COLORS, P.NODE);
  Object.assign(EDGE_COLORS, P.EDGE);
  Object.assign(EDGE_DOT, P.EDGE_DOT);
  Object.assign(KIND_COLORS, P.KIND);
  Object.assign(VERDICT_COLORS, {
    verified: C.verified,
    partial: C.partial,
    judged: C.muted,
    // red is only for a claim that is now false; "the graph couldn't confirm it" is amber, never struck through
    unsupported: C.partial,
    contradicted: C.bad,
    unverified: C.muted,
    not_checked: C.faint,
    expired: C.faint,
  });
}
applyPalette("dark");

export const riskColor = (level?: string) =>
  level === "high" ? C.bad : level === "medium" ? C.partial : level === "low" ? C.verified : C.muted;
