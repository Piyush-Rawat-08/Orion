// Server-sent events over POST. The backend (sse-starlette) frames events as
//   event: <type>\r\n data: <json>\r\n \r\n   and sends ": ping" comments every 15 s.

import { API_URL, ApiError, authFetch } from "./api";

export interface SseEvent {
  event: string;
  data: Record<string, unknown> & { type?: string };
}

export async function postStream(
  path: string,
  body: unknown,
  onEvent: (e: SseEvent) => void,
  signal?: AbortSignal,
  as?: string,
): Promise<void> {
  let res: Response;
  try {
    res = await authFetch(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
      },
      as,
    );
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    // A network error, or a server error returned without CORS headers (the browser can't tell which).
    throw new ApiError(0, `Couldn't reach ${API_URL}, or the API failed before it started streaming. Check that the backend is running and look at its log.`);
  }
  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const flush = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const raw of block.split(/\r?\n/)) {
      if (!raw || raw.startsWith(":")) continue;
      const i = raw.indexOf(":");
      const field = i === -1 ? raw : raw.slice(0, i);
      const value = i === -1 ? "" : raw.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (!data.length) return;
    try {
      const parsed = JSON.parse(data.join("\n"));
      onEvent({ event: parsed.type ?? event, data: parsed });
    } catch {
      onEvent({ event, data: { text: data.join("\n") } });
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const p of parts) flush(p);
  }
  if (buffer.trim()) flush(buffer);
}
