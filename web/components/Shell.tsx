"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useApp } from "./AppProvider";
import BlameDrawer from "./BlameDrawer";
import CommandPalette from "./CommandPalette";
import PersonSwitcher from "./PersonSwitcher";
import { Kbd } from "./ui";
import { NAV } from "./nav";
import { SPRING } from "./motion";
import { setTheme, useTheme, useThemeSwitches } from "./theme";
import { useFetch } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import type { Stats } from "@/lib/types";

const RAIL_KEY = "orion.rail";
const noop = () => () => {};

function Icon({ d, className = "" }: { d: React.ReactNode; className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`shrink-0 ${className}`}>
      {d}
    </svg>
  );
}

export function Mark({ size = 22 }: { size?: number }) {
  // Orion: the three stars of the belt in ember, Betelgeuse above and Rigel below in ink
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden>
      <circle cx="5" cy="3.6" r="2.3" fill="var(--color-ink)" />
      <circle cx="7.4" cy="13.4" r="2.1" fill="var(--color-ember)" />
      <circle cx="11" cy="11" r="2.1" fill="var(--color-ember)" />
      <circle cx="14.6" cy="8.6" r="2.1" fill="var(--color-ember)" />
      <circle cx="17" cy="18.4" r="2.3" fill="var(--color-ink)" />
    </svg>
  );
}

const SUN = (
  <>
    <circle cx="8" cy="8" r="2.9" />
    <path d="M8 1.6v1.3M8 13.1v1.3M1.6 8h1.3M13.1 8h1.3M3.5 3.5l.9.9M11.6 11.6l.9.9M3.5 12.5l.9-.9M11.6 4.4l.9-.9" />
  </>
);
const MOON = <path d="M13.2 9.9A5.6 5.6 0 0 1 6.1 2.8a5.6 5.6 0 1 0 7.1 7.1z" />;

/** Paper or carbon. Wide: a two-way switch with a sliding thumb. Narrow: one button that flips it. */
function ThemeSwitch({ wide }: { wide: boolean }) {
  const theme = useTheme();
  const flip = (to: "light" | "dark", e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTheme(to, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  };
  if (!wide)
    return (
      <button
        type="button"
        onClick={(e) => flip(theme === "dark" ? "light" : "dark", e)}
        className="grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink"
        aria-label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
        title={theme === "dark" ? "Light theme" : "Dark theme"}
      >
        <Icon d={theme === "dark" ? SUN : MOON} />
      </button>
    );
  return (
    <div role="radiogroup" aria-label="Theme" className="relative grid flex-1 grid-cols-2 rounded-lg border border-rule bg-well p-[3px] text-[12px]">
      {(["light", "dark"] as const).map((t) => {
        const on = theme === t;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={(e) => flip(t, e)}
            className={`relative flex h-7 items-center justify-center gap-1.5 rounded transition-colors duration-200 ${on ? "text-ink" : "text-faint hover:text-muted"}`}
          >
            {on && <motion.span layoutId="theme-thumb" transition={SPRING} className="absolute inset-0 rounded border border-rule-strong bg-raised shadow-chip" aria-hidden />}
            <span className="relative flex items-center gap-1.5">
              <Icon d={t === "light" ? SUN : MOON} className="size-[13px]" />
              {t === "light" ? "Light" : "Dark"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The screens a phone gets a tab for; the rest sit behind More. */
const TABS = ["/rehearse", "/", "/multiverse", "/hindsight"];

/** Phones: five tabs at the bottom, 56px tall plus the home-indicator inset. */
function TabBar({ current, unread, onMore, moreOpen }: { current: string; unread: number; onMore: () => void; moreOpen: boolean }) {
  const tabs = NAV.filter((n) => TABS.includes(n.href));
  const inMore = !TABS.includes(current);
  return (
    <nav
      aria-label="Screens"
      className="relative z-[95] grid shrink-0 grid-cols-5 border-t border-rule bg-panel sm:hidden"
      style={{ height: "calc(var(--tab-h) + env(safe-area-inset-bottom))", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {tabs.map((n) => {
        const on = n.href === current;
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={on ? "page" : undefined}
            className={`relative flex flex-col items-center justify-center gap-1 text-[11px] ${on ? "text-ink" : "text-muted"}`}
          >
            <span className={on ? "text-ember" : "text-faint"}>
              <Icon d={n.icon} className="size-[18px]" />
            </span>
            {n.label}
            {n.href === "/inbox" && unread > 0 && (
              <span className="absolute left-1/2 top-1.5 ml-1.5 min-w-[16px] rounded-full bg-ember px-1 text-center text-[11px] font-semibold leading-[15px] text-night">
                {unread}
              </span>
            )}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMore}
        aria-expanded={moreOpen}
        className={`flex flex-col items-center justify-center gap-1 text-[11px] ${inMore || moreOpen ? "text-ink" : "text-muted"}`}
      >
        <span className={`relative ${inMore ? "text-ember" : "text-faint"}`}>
          <Icon d={<><circle cx="3.5" cy="8" r="1.1" /><circle cx="8" cy="8" r="1.1" /><circle cx="12.5" cy="8" r="1.1" /></>} className="size-[18px]" />
          {unread > 0 && <span className="absolute -right-1 -top-0.5 size-[7px] rounded-full bg-ember ring-2 ring-panel" aria-label={`${unread} in the inbox`} />}
        </span>
        More
      </button>
    </nav>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { tenant, unread, awake, startOver } = useApp();
  const stats = useFetch<Stats>("/stats", 10000);
  // the certificate belongs to Approvals
  const here = path.startsWith("/certificate") ? "/review" : path;
  const current = NAV.find((n) => (n.href === "/" ? here === "/" : here.startsWith(n.href))) ?? NAV[0];
  const [palette, setPalette] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const switches = useThemeSwitches();
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  // the palette shortcut as this machine spells it: ⌘K on a Mac, Ctrl K elsewhere
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)), []);
  // the rail is icons-only below 1280px; above it, a viewer can still fold it away
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    try {
      setFolded(localStorage.getItem(RAIL_KEY) === "folded");
    } catch {
      /* default: open */
    }
  }, []);
  const fold = (v: boolean) => {
    setFolded(v);
    try {
      localStorage.setItem(RAIL_KEY, v ? "folded" : "open");
    } catch {
      /* not remembered */
    }
  };


  // ⌘K / Ctrl+K opens the palette; Alt+1..8 jumps between screens
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return; // the blame drawer is modal
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (e.altKey && !e.metaKey && !e.ctrlKey) {
        const n = NAV.find((x) => e.code === `Digit${x.key}` || e.code === `Key${x.key}`);
        if (n) {
          e.preventDefault();
          router.push(n.href);
        }
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [router]);

  const online = !stats.error;
  // a sleeping free-tier API takes about a minute to answer the first request: say so instead of a blank date
  const waking = !stats.data && (!awake || !stats.error);
  const [since] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (!waking) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [waking]);
  const waited = Math.round((Date.now() - since) / 1000);
  const reloadStats = stats.reload;
  useEffect(() => {
    if (awake) reloadStats();
  }, [awake, reloadStats]);
  /** shown only when the rail is wide */
  const W = folded ? "hidden" : "hidden xl:flex";
  const L = folded ? "hidden" : "hidden xl:inline";
  /** row padding: icons centred in the narrow rail, left-aligned with their labels in the wide one */
  const PX = folded ? "px-[14px]" : "px-[14px] xl:px-2.5";
  /** badges sit on the icon's corner when the rail is narrow, and inline at the end of the row when wide */
  const badge = folded ? "absolute" : "absolute xl:relative xl:right-auto xl:top-auto";
  // phones: a bottom tab bar instead of the rail
  const [moreSheet, setMoreSheet] = useState(false);
  useEffect(() => setMoreSheet(false), [path]);
  useEffect(() => {
    if (!moreSheet) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMoreSheet(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [moreSheet]);

  // the guided rehearsal is a stage: the whole screen, no rail or top bar (it has its own way back)
  if (path.startsWith("/rehearse"))
    return (
      <MotionConfig reducedMotion="user">
        <main key={switches} className="h-dvh">
          {hydrated ? children : null}
        </main>
        <BlameDrawer />
      </MotionConfig>
    );

  return (
    <MotionConfig reducedMotion="user">
    <div
      className={`grid h-dvh grid-cols-[minmax(0,1fr)] sm:grid-cols-[64px_minmax(0,1fr)] sm:transition-[grid-template-columns] sm:duration-300 sm:ease-[var(--ease-out-quint)] ${
        folded ? "" : "xl:grid-cols-[var(--rail-w)_minmax(0,1fr)]"
      }`}
    >
      <nav aria-label="Screens" className="relative hidden h-dvh min-h-0 flex-col overflow-hidden border-r border-rule bg-panel sm:flex">
        {/* brand */}
        <div className="flex h-[var(--top-h)] shrink-0 items-center gap-2 pl-[21px] pr-2.5">
          <Link href="/" className="flex items-center gap-2.5 rounded" aria-label="Orion home">
            <Mark />
            <span className={`heading ${L} text-[20px] leading-none tracking-[-0.02em]`}>Orion</span>
          </Link>
          <button
            type="button"
            onClick={() => fold(true)}
            className={`${W} ml-auto size-7 items-center justify-center rounded text-faint transition-colors hover:bg-raised hover:text-ink`}
            aria-label="Fold the sidebar"
            title="Fold the sidebar"
          >
            <Icon d={<path d="M10 4.5 6.5 8l3.5 3.5M3 2.5v11" />} />
          </button>
        </div>

        {/* the company this is the memory of, and whether its records are reachable */}
        <div className="px-2.5 pb-2">
          <div
            className="flex items-center gap-2.5 rounded-lg border border-rule bg-well p-[7px] xl:p-2"
            title={`${tenant?.name ?? "Corvane"}${stats.data ? `: records updated ${stats.data.version} times` : ""}`}
          >
            <span className="heading grid size-[28px] shrink-0 place-items-center rounded-lg bg-ink text-[15px] leading-none text-night">
              {(tenant?.name ?? "Corvane").charAt(0)}
            </span>
            <span className={`${W} min-w-0 flex-1 flex-col`}>
              <span className="truncate text-[12px] font-medium leading-tight text-ink">{tenant?.name ?? "Corvane"}</span>
              <span className="mt-[2px] flex items-center gap-1.5 truncate text-[11px] leading-tight text-faint">
                <span
                  className="size-[5px] shrink-0 rounded-full"
                  style={{ background: waking ? "var(--color-warn)" : online ? "var(--color-ok)" : "var(--color-bad)" }}
                  aria-hidden
                />
                {waking ? "Waking up" : online ? (tenant?.personal ? "Your own copy" : "Live records") : "Can't connect"}
              </span>
            </span>
            {tenant?.personal && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Start over on a fresh copy of Corvane? What you changed in this one is thrown away.")) startOver();
                }}
                className={`${W} shrink-0 rounded px-1.5 py-1 text-[11px] text-faint transition-colors hover:bg-raised hover:text-ink`}
                title="Throw this copy away and start again on a fresh one"
              >
                Start over
              </button>
            )}
          </div>
        </div>

        {/* jump or ask: looks like the field it opens */}
        <div className="px-2.5 pb-3">
          <button
            type="button"
            onClick={() => setPalette(true)}
            className={`flex h-8 w-full items-center gap-2 rounded-lg border border-rule bg-well ${PX} text-[12px] text-faint transition-colors hover:border-rule-strong hover:text-muted`}
            aria-label={`Go to a page or ask a question (${mac ? "⌘K" : "Ctrl+K"})`}
            title={`Go to a page or ask a question (${mac ? "⌘K" : "Ctrl+K"})`}
          >
            <Icon d={<><circle cx="7" cy="7" r="4.3" /><path d="M10.3 10.3 13.5 13.5" /></>} className="size-[14px]" />
            <span className={`${W} flex-1 text-left`}>Search or ask…</span>
            <span className={`${W} gap-0.5`}>
              <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
        </div>

        <LayoutGroup id="rail">
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-4">
            <ul>
              {NAV.map((n, i) => {
                const active = n === current;
                const newGroup = i > 0 && NAV[i - 1].group !== n.group && !n.more;
                // the inbox comes out from under More by itself when an answer has gone out of date
                const surfaced = n.href === "/inbox" && unread > 0;
                if (n.more && !showMore && !active && !surfaced) return null;
                return (
                  <li key={n.href}>
                    {newGroup && <div className="mx-1.5 my-2 h-px bg-rule-soft" aria-hidden />}
                    <Link
                      href={n.href}
                      aria-current={active ? "page" : undefined}
                      title={`${n.label} (Alt+${n.key})`}
                      className={`group relative flex h-8 items-center gap-2.5 rounded-lg ${PX} text-[13px] transition-colors duration-200 ${
                        active ? "text-ink" : "text-muted hover:bg-raised/60 hover:text-ink"
                      }`}
                    >
                      {active && (
                        <motion.span
                          layoutId="rail-active"
                          transition={SPRING}
                          className="absolute inset-0 rounded-lg border border-rule bg-raised shadow-chip"
                          aria-hidden
                        />
                      )}
                      <span className={`relative transition-colors duration-200 ${active ? "text-ember" : "text-faint group-hover:text-muted"}`}>
                        <Icon d={n.icon} />
                      </span>
                      <span className={`relative ${L} flex-1 truncate`}>{n.label}</span>
                      {n.href === "/inbox" && unread > 0 && (
                        <span
                          className={`mono ${badge} right-0.5 top-0.5 min-w-[18px] rounded-full bg-ember px-1.5 text-center text-[11px] font-semibold leading-[17px] text-night`}
                        >
                          {unread}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
              <li>
                <div className="mx-1.5 my-2 h-px bg-rule-soft" aria-hidden />
                <button
                  type="button"
                  onClick={() => setShowMore((v) => !v)}
                  aria-expanded={showMore || current.more}
                  className={`flex h-8 w-full items-center gap-2.5 rounded-lg ${PX} text-[13px] text-faint transition-colors hover:bg-raised/60 hover:text-muted`}
                  title={showMore ? "Fewer screens" : "Inbox, Codebases, Activity"}
                >
                  <Icon d={showMore ? <path d="M4.5 9.5 8 6l3.5 3.5" /> : <path d="M4.5 6.5 8 10l3.5-3.5" />} />
                  <span className={`${L} flex-1 truncate text-left`}>{showMore ? "Less" : "More"}</span>
                </button>
              </li>
            </ul>
          </div>
        </LayoutGroup>

        <div className={`flex shrink-0 flex-col items-center gap-1 border-t border-rule px-2.5 py-2.5 ${folded ? "" : "xl:flex-row"}`}>
          <div className={`${W} w-full`}>
            <ThemeSwitch wide />
          </div>
          <div className={`flex flex-col items-center gap-1 ${folded ? "" : "xl:hidden"}`}>
            <ThemeSwitch wide={false} />
          </div>
          {folded && (
            <button
              type="button"
              onClick={() => fold(false)}
              className="hidden size-9 place-items-center rounded-lg text-faint transition-colors hover:bg-raised hover:text-ink xl:grid"
              aria-label="Open the sidebar"
              title="Open the sidebar"
            >
              <Icon d={<path d="M6 4.5 9.5 8 6 11.5M13 2.5v11" />} />
            </button>
          )}
        </div>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-col">
        <header className="relative z-[85] flex h-[var(--top-h)] shrink-0 items-center gap-3 border-b border-rule bg-night px-4 md:gap-4 md:px-6">
          <Link href="/" className="shrink-0 sm:hidden" aria-label="Orion home">
            <Mark size={20} />
          </Link>
          <div className="min-w-0 flex-1">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={current.href}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="flex min-w-0 items-baseline gap-3"
              >
                <h1 className="shrink-0 text-[15px] font-semibold leading-none tracking-[-0.01em]">{current.title}</h1>
                <p className="hidden truncate text-[12px] text-muted md:block">{current.sub}</p>
              </motion.div>
            </AnimatePresence>
          </div>

          <div
            className="hidden items-center gap-2 whitespace-nowrap rounded-lg border border-rule bg-panel px-2.5 py-[5px] text-[12px] md:flex"
            title={
              waking
                ? "The API runs on a free server that sleeps when nobody uses it. The first request wakes it."
                : "The date the company's records are at. Every answer is true as of this moment."
            }
            role="status"
          >
            <span className="relative flex size-[7px]" aria-hidden>
              {waking && <span className="absolute inset-0 animate-ping rounded-full bg-warn opacity-70" />}
              <span
                className="absolute inset-0 rounded-full"
                style={{ background: waking ? "var(--color-warn)" : online ? "var(--color-ok)" : "var(--color-bad)" }}
              />
            </span>
            {waking ? (
              <>
                <span className="text-muted">Waking the API, about a minute</span>
                {waited >= 3 && <span className="tnum text-faint">{waited}s</span>}
              </>
            ) : (
              <>
                <span className="text-muted">Records as of</span>
                <span className="tnum text-ink">{fmtDate(stats.data?.clock ?? tenant?.clock)}</span>
                {!online && <span className="text-bad">offline</span>}
              </>
            )}
          </div>

          <PersonSwitcher />
        </header>
        {/* Screens mount once, on the client, after the theme is known: the server can't know it, and inline
            colours rendered there for the wrong theme would survive hydration (light-theme visitors used to get
            every screen mounted twice to fix that). They remount on a theme switch, so canvases redraw. */}
        <main key={switches} className="relative min-h-0 flex-1 overflow-hidden">
          {hydrated ? children : null}
        </main>
        <TabBar current={current.href} unread={unread} onMore={() => setMoreSheet((v) => !v)} moreOpen={moreSheet} />
      </div>
      <AnimatePresence>
        {moreSheet && (
          <motion.div
            className="fixed inset-0 z-[90] bg-scrim sm:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setMoreSheet(false)}
          >
            <motion.nav
              aria-label="More screens"
              className="absolute inset-x-0 bottom-0 rounded-t-xl border-t border-rule bg-panel px-3 pt-2 shadow-modal"
              style={{ paddingBottom: "calc(var(--tab-h) + env(safe-area-inset-bottom) + 8px)" }}
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 16, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="mx-auto mb-2 block h-1 w-9 rounded-full bg-rule-strong" aria-hidden />
              <ul>
                {NAV.filter((n) => !TABS.includes(n.href)).map((n) => (
                  <li key={n.href}>
                    <Link
                      href={n.href}
                      aria-current={n === current ? "page" : undefined}
                      className={`flex min-h-12 items-center gap-3 rounded-lg px-3 text-[14px] ${n === current ? "bg-raised text-ink" : "text-muted"}`}
                    >
                      <span className={n === current ? "text-ember" : "text-faint"}>
                        <Icon d={n.icon} />
                      </span>
                      <span className="flex-1">{n.label}</span>
                      <span className="truncate text-[12px] text-faint">{n.sub.split(":")[0].split(".")[0]}</span>
                    </Link>
                  </li>
                ))}
                <li className="mt-1 flex items-center gap-3 border-t border-rule-soft px-3 pt-2">
                  <span className="flex-1 text-[13px] text-muted">Theme</span>
                  <ThemeSwitch wide={false} />
                </li>
              </ul>
            </motion.nav>
          </motion.div>
        )}
      </AnimatePresence>
      <BlameDrawer />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
    </MotionConfig>
  );
}
