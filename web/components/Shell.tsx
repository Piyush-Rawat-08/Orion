"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { open, TENANT } from "@/lib/api";
import { teamColor } from "@/lib/palette";
import { useSession } from "@/lib/session";
import type { Person } from "@/lib/types";
import { CommandPalette } from "./CommandPalette";
import { useCosmos } from "./cosmos/CosmosProvider";
import { EASE, Initials } from "./ui";

const NAV = [
  { href: "/sky", label: "Sky", hint: "the company now" },
  { href: "/multiverse", label: "Multiverse", hint: "fork and break things" },
  { href: "/time", label: "Time", hint: "any date, as it was" },
  { href: "/crew", label: "Crew", hint: "who knows what" },
  { href: "/signals", label: "Signals", hint: "live and the agents" },
  { href: "/inbox", label: "Inbox", hint: "for you" },
];

export function Belt({ className = "" }: { className?: string }) {
  // Orion's belt: three stars, slightly off a straight line
  return (
    <svg viewBox="0 0 40 16" className={className} aria-hidden>
      {[[6, 11], [20, 8], [34, 4.5]].map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="3.4" fill="#ffb547" opacity="0.18" />
          <circle cx={x} cy={y} r="1.5" fill="#fff6e8" />
        </g>
      ))}
    </svg>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { meta, ready, signIn, signOut } = useSession();
  const [menu, setMenu] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const { engine } = useCosmos();
  const [last, setLast] = useState(path);

  // moving between places is a short jump through hyperspace
  useEffect(() => {
    if (path !== last) {
      engine?.warp(900);
      setLast(path);
    }
  }, [path, last, engine]);

  useEffect(() => {
    if (ready && !meta) router.replace("/");
  }, [ready, meta, router]);

  useEffect(() => {
    if (menu && !people.length) open<Person[]>(`${TENANT}/personas`).then(setPeople).catch(() => {});
  }, [menu, people.length]);

  if (!meta) return null;
  const clock = meta.clock.replace("T", " ");

  return (
    <div className="relative z-10 min-h-dvh">
      <header className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-start justify-between gap-4 px-4 pt-4 md:px-6">
        <Link href="/sky" className="pointer-events-auto group flex items-center gap-3">
          <Belt className="h-4 w-10 transition-transform duration-500 group-hover:rotate-[-6deg]" />
          <div className="leading-none">
            <div className="display text-[26px] italic leading-none">Orion</div>
            <div className="mono mt-1 text-[10px] tracking-[0.08em] text-faint">
              {meta.company.toUpperCase()} · {clock}
            </div>
          </div>
        </Link>

        <nav className="pointer-events-auto hidden items-center gap-0.5 rounded-full border border-white/[0.07] bg-[#070a13]/70 p-1 backdrop-blur-xl md:flex">
          {NAV.map((n) => {
            const on = path.startsWith(n.href);
            const badge = n.href === "/inbox" ? meta.unread + meta.waiting : 0;
            return (
              <Link key={n.href} href={n.href} title={n.hint}
                    className={`relative rounded-full px-3.5 py-1.5 text-[13px] transition-colors duration-300 ${on ? "text-ink" : "text-muted hover:text-ink"}`}>
                {on && (
                  <motion.span layoutId="nav-on" className="absolute inset-0 rounded-full bg-white/[0.07]"
                               transition={{ type: "spring", stiffness: 380, damping: 32 }} />
                )}
                <span className="relative">{n.label}</span>
                {badge > 0 && (
                  <span className="mono relative ml-1.5 rounded-full bg-amber/90 px-1.5 text-[10px] text-void">{badge}</span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="pointer-events-auto relative flex items-center gap-2">
          <button onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
                  className="mono hidden rounded-full border border-white/[0.07] bg-[#070a13]/70 px-3 py-2 text-[10px] text-faint backdrop-blur-xl transition-colors hover:text-ink lg:block">
            find ⌘K
          </button>
          <button onClick={() => setMenu((m) => !m)}
                  className="flex items-center gap-2.5 rounded-full border border-white/[0.07] bg-[#070a13]/70 py-1 pl-1 pr-3 backdrop-blur-xl transition-colors hover:border-white/15">
            <Initials name={meta.me.name} team={meta.me.team} />
            <span className="hidden text-left leading-tight sm:block">
              <span className="block text-[12px]">{meta.me.name}</span>
              <span className="block text-[10px]" style={{ color: teamColor(meta.me.team) }}>{meta.me.team_name}</span>
            </span>
          </button>
          <AnimatePresence>
            {menu && (
              <motion.div initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.22, ease: EASE }}
                          className="panel scroll-quiet absolute right-0 top-12 max-h-[70vh] w-72 overflow-y-auto rounded-lg p-1.5">
                <div className="mono px-2.5 pb-1.5 pt-1 text-[10px] uppercase tracking-[0.12em] text-faint">Look through someone else&apos;s eyes</div>
                {people.map((p) => (
                  <button key={p.uid}
                          onClick={async () => {
                            setMenu(false);
                            await signIn(p.uid);
                          }}
                          className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.05] ${p.uid === meta.me.uid ? "bg-white/[0.04]" : ""}`}>
                    <Initials name={p.name} team={p.team} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px]">{p.name}</span>
                      <span className="block truncate text-[10px] text-faint">{p.role}, {p.team_name}</span>
                    </span>
                  </button>
                ))}
                <button onClick={() => { signOut(); router.replace("/"); }}
                        className="mono mt-1 w-full rounded-md px-2.5 py-2 text-left text-[11px] text-muted hover:bg-white/[0.05] hover:text-ink">
                  Leave the observatory
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </header>

      {/* phones: the same places, along the bottom */}
      <nav className="pointer-events-auto fixed inset-x-3 bottom-3 z-30 flex justify-between rounded-2xl border border-white/[0.07] bg-[#070a13]/85 p-1 backdrop-blur-xl md:hidden">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href}
                className={`flex-1 rounded-xl py-2 text-center text-[11px] ${path.startsWith(n.href) ? "bg-white/[0.07] text-ink" : "text-muted"}`}>
            {n.label}
          </Link>
        ))}
      </nav>

      <CommandPalette />
      {children}
    </div>
  );
}
