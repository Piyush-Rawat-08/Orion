"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/AppProvider";
import LazyGraphCanvas from "@/components/graph/GraphCanvasLazy";
import type { EdgeGraph } from "@/components/graph/GraphCanvas";
import { EASE } from "@/components/motion";
import DiffPanel from "@/components/multiverse/DiffPanel";
import ForkForm from "@/components/multiverse/ForkForm";
import SimulateBox from "@/components/multiverse/SimulateBox";
import Compare from "@/components/multiverse/Compare";
import UniverseList from "@/components/multiverse/UniverseList";
import Unwritten from "@/components/multiverse/Unwritten";
import UniverseStage from "@/components/multiverse/UniverseStage";
import { Handle, Pane, Split, useMedia } from "@/components/Split";
import { ErrorNote, Segmented, Spinner, UniverseTag } from "@/components/ui";
import { useFetch } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import { universeAccent } from "@/lib/theme";
import { kindWord, scenarioLabel } from "@/lib/words";
import type { GEdge, GNode, GraphPayload, Universe, UniverseDetail } from "@/lib/types";

const INTRO_KEY = "orion.whatifs.intro.hidden";

function Multiverse() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, personName, llm, openBlame } = useApp();
  const selected = params.get("u");
  // arriving from the map's "Test it properly": the system to switch off, ready in the form
  const trying = params.get("try");
  // arriving from Teams' "If they left tomorrow": the person who leaves, ready in the form
  const leaving = params.get("leave");
  const [mode, setMode] = useState<"blast" | "split" | "overlay">("blast");
  const [tabChoice, setTab] = useState<"simulate" | "fork" | null>(trying || leaving ? "fork" : null);
  useEffect(() => {
    if (trying || leaving) setTab("fork");
  }, [trying, leaving]);
  const [introHidden, setIntroHidden] = useState(false);
  const [listTab, setListTab] = useState<"mine" | "unwritten" | "compare">("mine");
  // the map's tour and "what if this stopped" cards sit where the intro does: it steps aside while they show
  const [story, setStory] = useState(false);
  useEffect(() => {
    try {
      setIntroHidden(localStorage.getItem(INTRO_KEY) === "1");
    } catch {
      /* shown every visit */
    }
    const on = (e: Event) => setStory(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener("orion:graph-story", on);
    return () => window.removeEventListener("orion:graph-story", on);
  }, []);
  const showIntro = (show: boolean) => {
    setIntroHidden(!show);
    try {
      if (show) localStorage.removeItem(INTRO_KEY);
      else localStorage.setItem(INTRO_KEY, "1");
    } catch {
      /* not remembered */
    }
  };
  const wide = useMedia("(min-width: 1024px)");
  const phone = !useMedia("(min-width: 768px)");
  // without an API key, picking the changes is the way in
  const tab = tabChoice ?? (llm === false ? "fork" : "simulate");

  const list = useFetch<Universe[]>("/universes");
  const main = useFetch<GraphPayload>("/graph");
  const detail = useFetch<UniverseDetail>(selected ? `/universes/${selected}` : null);

  const select = (uid: string) => router.replace(`/multiverse?u=${uid}`, { scroll: false });
  const sent = (uid: string) => {
    list.reload();
    setListTab("mine");
    select(uid);
  };
  // phones: the result renders below the list, so a tap brings it into view
  const stageRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (phone && selected) requestAnimationFrame(() => stageRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, [phone, selected]);
  const d = detail.data && detail.data.uid === selected ? detail.data : null;
  const accent = universeAccent(selected);

  const onEdgeClick = useCallback(
    (e: GEdge, s?: GNode, t?: GNode, g?: EdgeGraph) =>
      openBlame({ fact: e.uid ?? null, edge: e, sourceName: s?.name, targetName: t?.name, source: s, target: t, graph: g }),
    [openBlame],
  );

  const aside = (
    <aside className={phone ? "flex flex-col" : "flex h-full min-h-0 flex-col"}>
      <div className="border-b border-rule p-4">
        <Segmented
          label="New what-if"
          className="mb-4 w-full"
          value={tab}
          onChange={setTab}
          options={[
            ["simulate", "Describe it"],
            ["fork", "Pick the changes"],
          ]}
        />
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: EASE }}>
          {tab === "simulate" ? (
            <SimulateBox user={user} onUniverse={list.reload} onSelect={select} />
          ) : (
            <ForkForm
              key={trying ?? leaving ?? ""}
              graph={main.data}
              user={user}
              preset={
                trying
                  ? { op: "deprecate_service", vals: { service: trying } }
                  : leaving
                    ? { op: "remove_person", vals: { person: leaving } }
                    : undefined
              }
              onForked={(r) => {
                list.reload();
                select(r.uid);
              }}
            />
          )}
        </motion.div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-3">
        <div className="mb-2 px-2">
          <Segmented
            label="What to show"
            size="sm"
            className="w-full"
            value={listTab}
            onChange={setListTab}
            options={[
              ["mine", "Your what-ifs"],
              ["unwritten", "Nobody wrote down"],
              ["compare", "Compare"],
            ]}
          />
        </div>
        {listTab === "unwritten" ? (
          <Unwritten
            onProposed={(uid) => {
              list.reload();
              setListTab("mine");
              select(uid);
            }}
          />
        ) : listTab === "compare" ? (
          phone ? (
            list.data && <Compare universes={list.data} onSent={sent} />
          ) : (
            <p className="px-3 py-2 text-[12px] leading-relaxed text-muted">
              Pick two what-ifs on the right to see them side by side, then send the safer one for approval.
            </p>
          )
        ) : (
          <>
            {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
            {list.data ? (
              <UniverseList universes={list.data} selected={selected} onSelect={select} />
            ) : (
              !list.error && (
                <div className="space-y-2 px-2 pt-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="skeleton h-11" />
                  ))}
                </div>
              )
            )}
          </>
        )}
      </div>
    </aside>
  );

  const stageHeader = selected && (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-5 py-3">
      <UniverseTag uid={selected} />
      <h2 className={`heading min-w-0 truncate text-[20px] leading-none ${d ? "text-ink" : "text-muted"}`}>{d?.title ?? "Loading"}</h2>
      {d && (
        <p className="flex flex-wrap gap-x-3 text-[12px] text-muted">
          <span>
            {kindWord(d.kind)} by {d.created_by.startsWith("person:") ? personName(d.created_by) : "the assistant"}, {fmtDate(d.created_at)}
          </span>
        </p>
      )}
      <div className="ml-auto flex items-center gap-2">
        {d?.status === "open" && (
          <Link href={`/review?u=${selected}`} className="btn" title="Read it as a plan, and approve it if you want it to happen for real">
            Review and approve
          </Link>
        )}
        <Segmented
          label="View"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            ["blast", "What breaks"],
            ["split", "Before and after"],
            ["overlay", "On the map"],
          ]}
        />
      </div>
    </div>
  );

  const stage = !selected ? (
    // nothing picked: show the real company every what-if starts from, and how this screen works
    <div className="relative h-full min-h-0">
      <LazyGraphCanvas data={main.data} onEdgeClick={onEdgeClick} ariaLabel="The real company, as it is today" />
      <AnimatePresence>
        {!introHidden && !story && (
          <motion.div
            key="intro"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_60%_at_30%_40%,transparent,color-mix(in_oklab,var(--color-night)_55%,transparent))]"
            aria-hidden
          />
        )}
        {!introHidden && !story && (
          <motion.div
            key="intro-card"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: EASE, delay: 0.1 }}
            className="hud pointer-events-auto absolute inset-x-4 bottom-4 max-w-[420px] p-5 sm:inset-x-auto sm:bottom-6 sm:left-6"
          >
            <button
              type="button"
              className="btn btn-ghost absolute right-2.5 top-2.5 h-7 px-1.5"
              onClick={() => showIntro(false)}
              aria-label="Close this guide"
              title="Close this guide"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <p className="pr-8 text-[12px] text-muted">Behind this: the real company, as it is today</p>
            <p className="heading mt-2 text-[20px] leading-[1.1]">Test a change before you make it.</p>
            <p className="mt-3 text-[13px] leading-relaxed text-muted">
              Orion makes a private copy of the company, makes your change there, and shows what would stop working,
              which customers would notice and who has to agree. The real company is never touched.
            </p>
            <p className="mt-3 text-[13px] leading-relaxed text-muted">
              Describe a change {phone ? "above" : "on the left"}, or pick it from a list, then open the result. If you
              want it for real, send it for approval.
            </p>
            <p className="mt-3 text-[12px] leading-snug text-faint">
              Or click any system on the map and press “What if this stopped working?” for a quick look.
            </p>
          </motion.div>
        )}
        {introHidden && !story && (
          <motion.button
            key="intro-pill"
            type="button"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            onClick={() => showIntro(true)}
            className="hud absolute bottom-4 left-4 flex h-8 items-center gap-2 px-3 text-[12px] text-muted transition-colors hover:text-ink sm:bottom-6 sm:left-6"
          >
            <span className="grid size-4 place-items-center rounded-full border border-rule-strong text-[11px] leading-none" aria-hidden>
              ?
            </span>
            How what-ifs work
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  ) : (
    <div className="relative h-full min-h-0" style={{ boxShadow: `inset 0 1px 0 ${accent}` }}>
      {detail.error && (
        <div className="p-6">
          <ErrorNote error={detail.error} onRetry={detail.reload} />
        </div>
      )}
      {!d && !detail.error && (
        <p className="flex items-center gap-2 p-6 text-sm text-muted">
          <Spinner /> Loading what-if {scenarioLabel(selected)}
        </p>
      )}
      {d && <UniverseStage key={`${d.uid}-${mode}`} detail={d} main={main.data} mode={mode} />}
    </div>
  );

  const right = listTab === "compare" && list.data ? (
    <section className="h-full min-h-0 overflow-y-auto px-6 py-6" aria-label="Two what-ifs side by side">
      <h2 className="heading mb-4 text-[20px] leading-none">Compare two what-ifs</h2>
      <div className="max-w-[880px]">
        <Compare universes={list.data} onSent={sent} />
      </div>
    </section>
  ) : (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label="The what-if against the real company">
      {stageHeader}
      <div className="min-h-0 flex-1">
        {d?.diff ? (
          <Split id="multiverse-stage" vertical>
            <Pane id="canvas" minSize={200}>
              {stage}
            </Pane>
            <Handle label="Resize the map and the results" />
            <Pane id="diff" defaultSize="34" minSize={120}>
              <div className="h-full overflow-y-auto bg-panel px-6 py-5">
                <DiffPanel diff={d.diff} />
              </div>
            </Pane>
          </Split>
        ) : (
          stage
        )}
      </div>
    </section>
  );

  // phones: one scrolling column (create, universes, the selected one, its diff) instead of nested panes
  if (phone)
    return (
      <div className="h-full overflow-y-auto">
        {aside}
        {selected && (
          <section ref={stageRef} aria-label="The what-if against the real company" className="scroll-mt-2 border-t border-rule">
            {stageHeader}
            <div className={mode === "blast" ? "" : "h-[62vh]"}>{stage}</div>
            {d?.diff && (
              <div className="border-t border-rule bg-panel px-4 py-5">
                <DiffPanel diff={d.diff} />
              </div>
            )}
          </section>
        )}
      </div>
    );

  return (
    <Split id="multiverse" vertical={!wide}>
      <Pane id="aside" defaultSize={wide ? 340 : "45"} minSize={wide ? 280 : 200} maxSize={wide ? 560 : undefined}>
        {aside}
      </Pane>
      <Handle label="Resize the list" />
      <Pane id="stage" minSize={wide ? 420 : 240}>
        {right}
      </Pane>
    </Split>
  );
}

export default function MultiversePage() {
  return (
    <Suspense>
      <Multiverse />
    </Suspense>
  );
}
