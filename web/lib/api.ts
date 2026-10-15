// Thin client for the Orion backend. JSON endpoints use fetch; streaming endpoints use
// POST + ReadableStream (see sse.ts), because EventSource cannot send a body.
//
// Identity: the backend derives the user from a signed token, never from a request field. The client logs in
// as the current persona (repo tenants: "viewer") once per tenant and persona, keeps the token, sends it on every
// request, and logs in again once if a token is refused.

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8100").replace(/\/$/, "");
export const TENANT = process.env.NEXT_PUBLIC_TENANT || "corvane";

export const tenantPath = (path: string) => `/api/${TENANT}${path.startsWith("/") ? path : `/${path}`}`;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** the response's `detail` when it is an object (409 rebase_needed / blocked carry their diffs here) */
    public body?: unknown,
  ) {
    super(message);
  }
}

let currentUser = "person:priya-raman";
const tokens = new Map<string, string>();

/** The persona the UI acts as; requests from now on carry this persona's token. */
export function setApiUser(user: string) {
  currentUser = user;
}

const PUBLIC = new Set(["health", "tenants"]);

function tenantOf(path: string): string | null {
  if (!path.startsWith("/api/")) return TENANT;
  const seg = path.slice(5).split(/[/?]/)[0];
  if (PUBLIC.has(seg)) return null;
  if (seg === "repos") return TENANT; // creating a repo tenant: any logged-in session will do
  return decodeURIComponent(seg);
}

function personaFor(tenant: string) {
  return tenant.startsWith("gh-") ? "viewer" : currentUser;
}

async function token(tenant: string, fresh = false, as?: string): Promise<string> {
  const persona = as ?? personaFor(tenant);
  const key = `orion.token.${tenant}.${persona}`;
  if (!fresh) {
    const mem = tokens.get(key);
    if (mem) return mem;
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        tokens.set(key, saved);
        return saved;
      }
    } catch {
      /* no storage: log in every page load */
    }
  }
  const res = await fetch(`${API_URL}/api/${encodeURIComponent(tenant)}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: persona }),
    cache: "no-store",
  });
  const body = await handle<{ token: string }>(res);
  tokens.set(key, body.token);
  try {
    localStorage.setItem(key, body.token);
  } catch {
    /* ignore */
  }
  return body.token;
}

/** fetch with the caller's token; a refused token is replaced once. `as` sends one request as another persona
 *  (the demo's "post a message as someone on the team"): the server still only believes the token. */
export async function authFetch(path: string, init: RequestInit = {}, as?: string): Promise<Response> {
  const url = path.startsWith("/api/") ? `${API_URL}${path}` : `${API_URL}${tenantPath(path)}`;
  const tenant = tenantOf(path);
  const go = async (fresh: boolean) => {
    const headers = new Headers(init.headers);
    if (tenant) headers.set("authorization", `Bearer ${await token(tenant, fresh, as)}`);
    return fetch(url, { cache: "no-store", ...init, headers });
  };
  const res = await go(false);
  return res.status === 401 && tenant ? go(true) : res;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    let body: unknown;
    try {
      const j = await res.json();
      body = j.detail ?? j;
      detail = typeof j.detail === "string" ? j.detail : (j.detail?.message ?? JSON.stringify(j.detail ?? j));
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`, body);
  }
  return res.json() as Promise<T>;
}

/** GET a tenant-scoped path, e.g. get("/graph?asof=2026-07-01"). Absolute "/api/..." paths pass through. */
export async function get<T>(path: string, init?: RequestInit): Promise<T> {
  return handle<T>(await authFetch(path, init));
}

export async function post<T>(path: string, body: unknown, init?: RequestInit): Promise<T> {
  return handle<T>(
    await authFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    }),
  );
}

export const q = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};
