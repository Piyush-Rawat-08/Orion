// The Orion API. The token is the signed persona from /login; streams are server-sent events over a POST,
// read with fetch because EventSource can only GET.

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8100";
export const TENANT = process.env.NEXT_PUBLIC_TENANT ?? "corvane";

let token: string | null = null;

export function setToken(t: string | null) {
  token = t;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}/api/${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const get = <T,>(path: string) => request<T>(`${TENANT}/${path}`);
export const post = <T,>(path: string, body: unknown = {}) =>
  request<T>(`${TENANT}/${path}`, { method: "POST", body: JSON.stringify(body) });
export const open = <T,>(path: string, init?: RequestInit) => request<T>(path, init);

export type StreamEvent = { type: string; [k: string]: unknown };

/** POST and read the reply as server-sent events, calling `on` for each. Resolves with the final result. */
export async function stream(path: string, body: unknown, on: (e: StreamEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`${API}/api/${TENANT}/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail;
    } catch {}
    throw new ApiError(res.status, detail);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let result: unknown = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = chunk
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const e = JSON.parse(data) as StreamEvent;
      if (e.type === "error") throw new ApiError(500, String(e.error));
      if (e.type === "done") result = e.result;
      on(e);
    }
  }
  return result;
}
