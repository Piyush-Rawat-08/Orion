"use client";

// Light or dark, remembered per browser. The first paint already has the right theme: a tiny script in
// app/layout.tsx sets <html data-theme> before anything renders (saved choice, else the system setting).
// This store mirrors that attribute, keeps the JS palettes in lib/theme.ts in step, and switches with a
// circular reveal that grows from wherever the switch was pressed.

import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { applyPalette, type Theme } from "@/lib/theme";

export const THEME_KEY = "orion.theme";
const listeners = new Set<() => void>();
/** How many times the person switched themes this page load. Screens that paint colours from JS remount on a
 *  switch (keyed on this), and only then: hydration catching up with the pre-paint theme is not a switch. */
let switches = 0;

function read(): Theme {
  const t = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  applyPalette(t);
  return t;
}

// the JS palettes match the pre-paint theme before any canvas mounts (screens no longer remount after hydration)
if (typeof document !== "undefined") read();

function set(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", theme === "light" ? "#f4f2ed" : "#0a0a09"));
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* not remembered, still switches */
  }
  applyPalette(theme);
  listeners.forEach((l) => l());
}

/** Switch themes. `from` is the point the reveal grows out of (usually the button that was pressed). */
export function setTheme(theme: Theme, from?: { x: number; y: number }) {
  if (theme === read()) return;
  switches++;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || still) {
    set(theme);
    return;
  }
  const x = from?.x ?? window.innerWidth / 2;
  const y = from?.y ?? window.innerHeight / 2;
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  document.documentElement.dataset.switching = "";
  const t = doc.startViewTransition(() => flushSync(() => set(theme)));
  t.ready
    .then(() =>
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 500, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" },
      ).finished,
    )
    .catch(() => {})
    .finally(() => delete document.documentElement.dataset.switching);
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => "dark",
  );
}

export function useThemeSwitches(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => switches,
    () => 0,
  );
}

/** Runs before first paint: the saved theme, else the system's. Keep it tiny and dependency-free. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";var d=document.documentElement;d.dataset.theme=t;d.style.colorScheme=t}catch(e){}`;
