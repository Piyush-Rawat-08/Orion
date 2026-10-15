"use client";

import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./AppProvider";
import { NAV } from "./nav";
import { Kbd } from "./ui";
import { EASE } from "./motion";
import { setTheme, useTheme } from "./theme";

const STARTERS = [
  "If we switch off sso-legacy next quarter, what breaks, who needs to be involved, and have we tried this before?",
  "Who actually knows the ledger?",
  "Which teams on paper don't match how people actually work?",
  "What did Helio Robotics ask for, and was it resolved?",
];

type Item = { id: string; group: string; label: string; hint?: string; run: () => void; disabled?: boolean };

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { ask, llm } = useApp();
  const theme = useTheme();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // focus moves into the palette when it opens and back to where it was when it closes
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      setQ("");
      setI(0);
      setTimeout(() => input.current?.focus(), 10);
    } else if (returnTo.current) {
      returnTo.current.focus?.();
      returnTo.current = null;
    }
  }, [open]);

  const items = useMemo(() => {
    const go = (href: string) => () => {
      router.push(href);
      onClose();
    };
    const askIt = (text: string) => () => {
      router.push("/");
      ask(text);
      onClose();
    };
    const needle = q.trim().toLowerCase();
    const out: Item[] = [];
    if (needle.length > 2)
      out.push({ id: "ask", group: "Ask", label: q.trim(), hint: llm === false ? "needs the AI service" : "Ask", run: askIt(q.trim()), disabled: llm === false });
    for (const n of NAV)
      if (!needle || n.label.toLowerCase().includes(needle) || n.sub.toLowerCase().includes(needle))
        out.push({ id: n.href, group: "Pages", label: n.label, hint: `Alt ${n.key}`, run: go(n.href) });
    const other = theme === "dark" ? "light" : "dark";
    if (!needle || `theme ${other} mode appearance`.includes(needle))
      out.push({
        id: "theme",
        group: "Appearance",
        label: other === "light" ? "Switch to the light theme" : "Switch to the dark theme",
        run: () => {
          onClose();
          setTheme(other);
        },
      });
    for (const s of STARTERS)
      if (!needle || s.toLowerCase().includes(needle))
        out.push({ id: s, group: "Questions", label: s, run: askIt(s), disabled: llm === false });
    return out;
  }, [q, router, ask, onClose, llm, theme]);

  useEffect(() => setI(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }, [i]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      // a focus trap: the list is walked with the arrow keys, so Tab stays in the search field
      e.preventDefault();
      input.current?.focus();
    } else if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setI((v) => Math.min(items.length - 1, v + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setI((v) => Math.max(0, v - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[i];
      if (it && !it.disabled) it.run();
    }
  };

  let lastGroup = "";
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-start justify-center bg-scrim px-4 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Go to a page or ask"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.985 }}
            transition={{ duration: 0.16, ease: EASE }}
            className="w-full max-w-[620px] overflow-hidden rounded-xl border border-rule-strong bg-panel shadow-modal"
            onKeyDown={onKey}
          >
            <div className="flex items-center gap-3 border-b border-rule px-4">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-faint" aria-hidden>
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" strokeLinecap="round" />
              </svg>
              <input
                ref={input}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Go to a page, or ask anything about the company…"
                className="h-[54px] w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-faint focus-visible:outline-none"
                aria-label="Search or ask"
                aria-activedescendant={items[i] ? `cmd-${i}` : undefined}
              />
              <Kbd>esc</Kbd>
            </div>
            <ul ref={list} role="listbox" className="max-h-[52vh] overflow-y-auto p-2">
              {items.map((it, n) => {
                const header = it.group !== lastGroup;
                lastGroup = it.group;
                return (
                  <li key={it.id} role="presentation">
                    {header && <p className="px-3 pb-1 pt-2.5 text-[11px] font-medium text-faint">{it.group}</p>}
                    <button
                      id={`cmd-${n}`}
                      data-i={n}
                      role="option"
                      aria-selected={n === i}
                      type="button"
                      disabled={it.disabled}
                      onMouseMove={() => setI(n)}
                      onClick={() => !it.disabled && it.run()}
                      className={`relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors duration-150 disabled:opacity-40 ${
                        n === i ? "bg-raised text-ink" : "text-muted"
                      }`}
                    >
                      {n === i && <span className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-ember" aria-hidden />}
                      <span className="min-w-0 flex-1 truncate">{it.label}</span>
                      {it.hint && <span className="mono shrink-0 text-[11px] text-faint">{it.hint}</span>}
                    </button>
                  </li>
                );
              })}
              {!items.length && <li className="px-3 py-6 text-center text-sm text-muted">Nothing matches.</li>}
            </ul>
            <div className="flex items-center gap-4 border-t border-rule px-4 py-2 text-[11px] text-faint">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> move
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> open
              </span>
              <span className="ml-auto">Alt + 1–8 jumps between pages</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
