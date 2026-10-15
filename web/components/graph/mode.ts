"use client";

// 3D or 2D, shared by every canvas on every screen and remembered per browser.

import { useSyncExternalStore } from "react";

export type GraphMode = "3d" | "2d";

const KEY = "orion.graph.mode";
const listeners = new Set<() => void>();
let current: GraphMode | null = null;

function read(): GraphMode {
  if (current) return current;
  try {
    current = localStorage.getItem(KEY) === "2d" ? "2d" : "3d";
  } catch {
    current = "3d";
  }
  return current;
}

export function setGraphMode(mode: GraphMode) {
  current = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* not remembered, still switches */
  }
  listeners.forEach((l) => l());
}

export function useGraphMode(): GraphMode {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => "3d",
  );
}
