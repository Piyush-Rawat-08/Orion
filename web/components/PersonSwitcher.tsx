"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./AppProvider";
import { EASE } from "./motion";
import type { Person } from "@/lib/types";

/** The two people the walkthrough uses, and what each one does in it. */
const CAST: Record<string, string> = {
  "person:priya-raman": "asked what breaks without sso-legacy",
  "person:tomasz-nowak": "posts BILL-207 in #billing",
};

const initials = (name: string) =>
  name
    .split(/[\s-]/)
    .map((w) => w[0]?.toUpperCase())
    .slice(0, 2)
    .join("");

function Avatar({ name, on = false, size = 22 }: { name: string; on?: boolean; size?: number }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full text-[11px] font-semibold ring-1 ${on ? "bg-ember/15 text-ember ring-ember/40" : "bg-raised text-ink ring-rule"}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/** Who the screens act as: a button with the person and their team, and a list that says why you'd switch. */
export default function PersonSwitcher() {
  const { user, setUser, people } = useApp();
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const me: Person | undefined = people.find((p) => p.uid === user);
  const name = me?.name ?? user.replace("person:", "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
      clearTimeout(t);
    };
  }, [open]);

  const groups = useMemo(() => {
    const q = find.trim().toLowerCase();
    const m = new Map<string, Person[]>();
    for (const p of people) {
      const team = p.team ?? "No team";
      if (q && !`${p.name} ${team} ${p.role ?? ""}`.toLowerCase().includes(q)) continue;
      m.set(team, [...(m.get(team) ?? []), p]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [people, find]);
  const cast = people.filter((p) => CAST[p.uid] && !find.trim());

  const pick = (uid: string) => {
    setUser(uid);
    setOpen(false);
    setFind("");
  };

  const row = (p: Person, note?: string) => {
    const on = p.uid === user;
    return (
      <li key={`${note ? "cast" : "all"}-${p.uid}`}>
        <button
          type="button"
          onClick={() => pick(p.uid)}
          aria-current={on ? "true" : undefined}
          className={`group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${on ? "bg-raised" : "hover:bg-raised/70"}`}
        >
          <Avatar name={p.name} on={on} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] leading-tight text-ink">{p.name}</span>
            <span className="block truncate text-[11px] leading-tight text-faint">{note ?? p.role ?? p.team}</span>
          </span>
          {on && (
            <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0 text-ember" aria-hidden>
              <path d="M2.5 6.2 5 8.6l4.6-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </li>
    );
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`Viewing as ${name}${me?.team ? `, ${me.team}` : ""}. Switch people to approve as another team or post as someone on it.`}
        className={`flex h-[34px] items-center gap-2 rounded-lg border bg-panel pl-1.5 pr-2 transition-colors ${open ? "border-rule-strong" : "border-rule hover:border-rule-strong"}`}
      >
        <Avatar name={name} on size={24} />
        <span className="hidden min-w-0 flex-col items-start text-left sm:flex">
          <span className="max-w-[9.5rem] truncate text-[12px] font-medium leading-tight text-ink">{name}</span>
          <span className="max-w-[9.5rem] truncate text-[11px] leading-tight text-faint">
            {me?.team ? `${me.team} · viewing as` : "viewing as"}
          </span>
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" className={`text-faint transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden>
          <path d="M2.2 3.8 5 6.6l2.8-2.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Choose who you are viewing as"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: EASE }}
            style={{ transformOrigin: "top right" }}
            className="absolute right-0 top-[calc(100%+8px)] z-[100] w-[min(340px,calc(100vw-24px))] overflow-hidden rounded-xl border border-rule bg-panel shadow-modal"
          >
            <div className="border-b border-rule-soft px-3.5 pb-3 pt-3">
              <p className="text-[13px] text-ink">
                Viewing as <span className="font-medium">{name}</span>
                {me?.team && <span className="text-muted">, {me.team}</span>}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">
                Answers, approvals and the inbox follow the person you act as. Switch people to approve as another team, or
                to post as someone on it.
              </p>
              <label className="mt-2.5 flex h-8 items-center gap-2 rounded-lg border border-rule bg-well px-2.5 focus-within:border-rule-strong">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-faint" aria-hidden>
                  <circle cx="7" cy="7" r="4.3" />
                  <path d="M10.3 10.3 13.5 13.5" />
                </svg>
                <span className="sr-only">Find a person or team</span>
                <input
                  ref={input}
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  placeholder="Find a person or team"
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-faint"
                />
              </label>
            </div>
            <div className="max-h-[min(380px,60vh)] overflow-y-auto px-1.5 py-1.5">
              {!people.length && <p className="px-2 py-3 text-[12px] text-muted">The people list arrives once the API is awake.</p>}
              {cast.length > 0 && (
                <>
                  <p className="px-2 pb-1 pt-1.5 text-[11px] text-faint">In the walkthrough</p>
                  <ul>{cast.map((p) => row(p, CAST[p.uid]))}</ul>
                </>
              )}
              {groups.map(([team, ps]) => (
                <div key={team}>
                  <p className="px-2 pb-1 pt-2.5 text-[11px] text-faint">
                    {team} <span className="tnum">· {ps.length}</span>
                  </p>
                  <ul>{ps.map((p) => row(p))}</ul>
                </div>
              ))}
              {people.length > 0 && !groups.length && <p className="px-2 py-3 text-[12px] text-muted">Nobody by that name.</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
