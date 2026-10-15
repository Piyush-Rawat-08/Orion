// Colors shared by the 3D sky and the 2D instruments, so a team is the same hue everywhere.

export const TEAM_COLOR: Record<string, string> = {
  "team:platform": "#6f9bff",
  "team:billing": "#f4d35e",
  "team:runtime": "#3fd8c2",
  "team:signals": "#b48cff",
  "team:console": "#ff6f9f",
  "team:data": "#9be36d",
};

export const FALLBACK = "#c9c3b4";

export function teamColor(team: string | null | undefined): string {
  return (team && TEAM_COLOR[team]) || FALLBACK;
}

export const EFFECT_COLOR = { break: "#ff4d2e", degrade: "#ff9a3c", stale: "#7f8fb3" } as const;
export const LEVEL_COLOR = { clear: "#7ee0b5", watch: "#ffb547", danger: "#ff4d2e" } as const;

export const STATUS_COLOR: Record<string, string> = {
  verified: "#7ee0b5",
  partial: "#c9e07e",
  judged: "#9fb7ff",
  contradicted: "#ff4d2e",
  outdated: "#ff9a3c",
  unconfirmed: "#8b90a0",
  unsupported: "#8b90a0",
};

export const STATUS_LABEL: Record<string, string> = {
  verified: "verified",
  partial: "partly checked",
  judged: "judged",
  contradicted: "not true",
  outdated: "no longer true",
  unconfirmed: "couldn't confirm",
  unsupported: "unsupported",
};

/** Deterministic 0..1 from a string, so a star sits in the same place on every visit. */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function short(uid: string): string {
  return uid.includes(":") ? uid.split(":").slice(1).join(":") : uid;
}
