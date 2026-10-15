"use client";

// Resizable panes. Sizes are remembered per layout (and per orientation, since narrow screens stack the
// panes vertically). Double-click a handle to reset; arrow keys resize it when focused.
// The group only renders in the browser: the saved layout lives in localStorage, and server-rendering the
// panes without it makes hydration drop the sizes.

import { useEffect, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout, type LayoutStorage } from "react-resizable-panels";

const storage: LayoutStorage = {
  getItem(key) {
    try {
      return typeof window === "undefined" ? null : window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* private mode or blocked storage: sizes just aren't remembered */
    }
  },
};

/** true at or above the query; false during server render, then the real value. */
export function useMedia(query: string, initial = true): boolean {
  const [match, setMatch] = useState(initial);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export function Split({
  id,
  vertical = false,
  className = "",
  children,
}: {
  id: string;
  vertical?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const orientation = vertical ? "vertical" : "horizontal";
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `orion.split.${id}.${orientation}`, storage });
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className={`h-full min-h-0 w-full ${className}`} />;
  return (
    <Group
      key={orientation}
      id={`${id}-${orientation}`}
      orientation={orientation}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className={`h-full min-h-0 w-full ${className}`}
    >
      {children}
    </Group>
  );
}

export const Pane = Panel;

export function Handle({ label = "Resize" }: { label?: string }) {
  return <Separator className="split-handle" aria-label={label} />;
}
