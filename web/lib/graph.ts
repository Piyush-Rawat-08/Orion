import type { GEdge, GraphPayload } from "./types";

export const edgeKey = (e: { source: string; target: string; type: string }) => `${e.source}>${e.type}>${e.target}`;

/** Edges present in `b` but not in `a` (by source, type, target). */
export function edgeSetDiff(a: GraphPayload, b: GraphPayload): GEdge[] {
  const ak = new Set(a.edges.map(edgeKey));
  return b.edges.filter((e) => !ak.has(edgeKey(e)));
}

export const nodeName = (g: GraphPayload | null, id: string) => g?.nodes.find((n) => n.id === id)?.name ?? id;
