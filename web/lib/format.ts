const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-30T18:00" -> "Sep 30, 18:00"; "2026-03-04" -> "Mar 4, 2026" (company dates are naive ISO strings). */
export function fmtDate(iso?: string | null, withYear = false): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, hh, mm] = m;
  const base = `${MONTHS[Number(mo) - 1]} ${Number(d)}`;
  const time = hh ? `, ${hh}:${mm}` : "";
  return withYear || !hh ? `${base}, ${y}${time}` : `${base}${time}`;
}

export const fmtMonth = (iso: string) => {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  return m ? MONTHS[Number(m[2]) - 1] : iso;
};

export function fmtMs(ms?: number | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "—";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms * 10) / 10} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function ago(msEpoch: number, now = Date.now()): string {
  const s = Math.max(0, (now - msEpoch) / 1000);
  if (s < 1.5) return "just now";
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Strip a uid prefix for display: "svc:sso-legacy" -> "sso-legacy". */
export const bare = (uid: string) => uid.replace(/^[a-z]+:/, "");

/** Days between two ISO dates (date part only). */
export function dayIndex(iso: string, start: string): number {
  return Math.round((Date.parse(iso.slice(0, 10) + "T00:00:00Z") - Date.parse(start.slice(0, 10) + "T00:00:00Z")) / 86400000);
}

export function dateFromIndex(i: number, start: string): string {
  const d = new Date(Date.parse(start.slice(0, 10) + "T00:00:00Z") + i * 86400000);
  return d.toISOString().slice(0, 10);
}
