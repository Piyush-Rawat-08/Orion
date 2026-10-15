"use client";

// The company graph in 3D (3d-force-graph on three.js). It takes the same props as the 2D Sigma canvas, so
// pages don't care which one they get. Positions come from the cached 3D layout (lib/layout3d.ts) and
// nothing moves at rest. Drag a node and its neighbours follow on springs, then everything settles back.
// Styling is target-based: hover, selection, highlight and diff set a target colour, size and opacity for
// every node and link, and each frame eases the scene toward it, so state changes glide instead of snapping.
// The look is quiet at rest so state can be loud: smooth bodies lit by a key light that travels with the camera,
// a room environment for reflections, and a multisampled post chain whose bloom (carbon only) only catches nodes
// that are in a state (broken, focused, lit by the agent), never team hubs at rest. Every label is the same face
// and size, with a halo, and names give way to more important ones instead of piling up. The canvas is created
// only once its container has a real size (a canvas made in a 0px pane sizes itself to the window).
// The page remounts the canvas when the theme changes.

import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import Link from "next/link";
import { describeNode, explainEdge, nameOf, nounOf, relationFrom } from "@/lib/explain";
import { edgeKey } from "@/lib/graph";
import { impactOf, tourOf, type Impact, type TourStop } from "@/lib/insights";
import { homesFor, RADIUS, type P3 } from "@/lib/layout3d";
import { C, EDGE_DOT, NODE_COLORS, type Theme } from "@/lib/theme";
import type { EdgeType, GEdge, GNode } from "@/lib/types";
import type { EdgeGraph, GraphCanvasProps, Trail } from "./GraphCanvas";
import { meteors, shockwaves, starfield, type Shockwaves } from "./fx3d";
import { setGraphMode } from "./mode";

// ---------------------------------------------------------------- data shapes

interface N3 extends P3 {
  id: string;
  g: GNode;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
}

interface L3 {
  key: string;
  e: GEdge;
  ghost: boolean;
  source: string | N3;
  target: string | N3;
  curve: number;
  arrowAt: number;
}

type FG = ForceGraph3DInstance<N3, L3>;

interface NodeTarget {
  color: THREE.Color;
  scale: number;
  glow: number;
  opacity: number;
  /** 0 hidden, 1 when close, 2 when fairly close, 3 shown unless it would cover another name, 4 always */
  label: 0 | 1 | 2 | 3 | 4;
  /** who keeps their name when two would overlap: focused 6 > evidence 5 > team 4 > service 3 > customer 2 > person 1 */
  prio: number;
  pulse: number;
}

interface Rig {
  group: THREE.Group;
  body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  halo: THREE.Sprite;
  /** a team's orbit ring */
  shell?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  /** shapes that turn slowly on their own axis */
  spin: number;
  label: CSS2DObject;
  el: HTMLDivElement;
  r: number;
  color: THREE.Color;
  scale: number;
  glow: number;
  opacity: number;
  labelAlpha: number;
  /** estimated label box in px, for keeping names from piling on top of each other */
  lw: number;
  lh: number;
  /** lw and lh measured from the label in the page, not estimated */
  measured?: boolean;
  labelTarget?: number;
  born: number;
  /** paper theme team hub: a paper body inside an ink ring, no gloss */
  paper: boolean;
  /** the body's clear coat at full visibility */
  clearcoat: number;
  t: NodeTarget;
}

/** Let go of a node's objects. The force graph drops the group from the scene, but CSS2DRenderer only removes a
 *  label's element when the label itself is removed, so without this every replaced node leaves its name behind. */
function retire(rig: Rig) {
  rig.label.removeFromParent();
  rig.el.remove();
  rig.body.material.dispose();
  rig.halo.material.dispose();
  rig.shell?.material.dispose();
}

interface LinkTarget {
  color: THREE.Color;
  opacity: number;
  particles: number;
  particleColor: string;
  particleSpeed: number;
}

interface LinkVis {
  mat: THREE.LineBasicMaterial | THREE.MeshBasicMaterial;
  opacity: number;
  t: LinkTarget;
}

// ---------------------------------------------------------------- look

type EdgeLook = Record<EdgeType, { color: string; opacity: number; width: number }>;
type Look = {
  bg: string[];
  fog: string;
  env: number;
  key: number;
  fill: number;
  bloom: boolean;
  halo: { blending: THREE.Blending; k: number };
  emissive: { base: number; glow: number };
  particle: string;
  ring: number;
  edges: EdgeLook;
};

const LOOK: Record<Theme, Look> = {
  dark: {
    bg: ["#121110", "#0b0b0a", "#060605"],
    fog: "#080807",
    env: 0.6,
    key: 1.3,
    fill: 0.35,
    bloom: true,
    halo: { blending: THREE.AdditiveBlending, k: 0.45 },
    emissive: { base: 0.03, glow: 0.7 },
    particle: "#b9cdff",
    ring: 0.85,
    edges: {
      DEPENDS_ON: { color: "#7ba6ff", opacity: 0.5, width: 0.5 },
      DEPENDS_ON_CLOSED: { color: "#f0544f", opacity: 0.3, width: 0.4 },
      OWNS: { color: "#ede9e1", opacity: 0.28, width: 0 },
      ON_CALL_FOR: { color: "#e9b44c", opacity: 0.45, width: 0 },
      MEMBER_OF: { color: "#c9c3b8", opacity: 0.18, width: 0 },
      KNOWS: { color: "#9c978d", opacity: 0.11, width: 0 },
      COLLABORATES: { color: "#b0a99c", opacity: 0.13, width: 0 },
      USES: { color: "#b99cff", opacity: 0.34, width: 0 },
      WORKED_ON: { color: "#9c978d", opacity: 0.17, width: 0 },
      AFFECTS: { color: "#4ccfc0", opacity: 0.42, width: 0 },
      RAISED_ABOUT: { color: "#d8a26e", opacity: 0.5, width: 0 },
      CO_CHANGES: { color: "#d8a26e", opacity: 0.45, width: 0.6 },
    } as EdgeLook,
  },
  light: {
    bg: ["#f7f5f1", "#f1eee8", "#e9e5dd"],
    fog: "#ece8e0",
    env: 0.85,
    key: 1.5,
    fill: 0.6,
    bloom: false,
    halo: { blending: THREE.NormalBlending, k: 0.22 },
    emissive: { base: 0, glow: 0.32 },
    particle: "#3567d4",
    ring: 0.7,
    // on paper, connections are drawn in ink (pale tints vanish on beige); dependencies keep their blue
    edges: {
      DEPENDS_ON: { color: "#3567d4", opacity: 0.6, width: 0.5 },
      DEPENDS_ON_CLOSED: { color: "#d23c37", opacity: 0.4, width: 0.4 },
      OWNS: { color: "#2a2723", opacity: 0.35, width: 0 },
      ON_CALL_FOR: { color: "#2a2723", opacity: 0.35, width: 0 },
      MEMBER_OF: { color: "#2a2723", opacity: 0.22, width: 0 },
      KNOWS: { color: "#2a2723", opacity: 0.14, width: 0 },
      COLLABORATES: { color: "#2a2723", opacity: 0.16, width: 0 },
      USES: { color: "#2a2723", opacity: 0.35, width: 0 },
      WORKED_ON: { color: "#2a2723", opacity: 0.2, width: 0 },
      AFFECTS: { color: "#2a2723", opacity: 0.35, width: 0 },
      RAISED_ABOUT: { color: "#2a2723", opacity: 0.35, width: 0 },
      CO_CHANGES: { color: "#b06a2c", opacity: 0.5, width: 0.6 },
    } as EdgeLook,
  },
};

const themeNow = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

/** The connection kinds a viewer can switch on and off; doubles as the edge legend. */
export const LAYERS: { id: string; label: string; types: EdgeType[] }[] = [
  { id: "deps", label: "Relies on", types: ["DEPENDS_ON", "DEPENDS_ON_CLOSED"] },
  { id: "own", label: "Owns, on call", types: ["OWNS", "ON_CALL_FOR"] },
  { id: "team", label: "Team members", types: ["MEMBER_OF"] },
  { id: "knows", label: "Knows a system", types: ["KNOWS"] },
  { id: "collab", label: "Works with", types: ["COLLABORATES"] },
  { id: "work", label: "Projects, customers", types: ["USES", "WORKED_ON", "RAISED_ABOUT"] },
  { id: "dec", label: "Decisions", types: ["AFFECTS"] },
  { id: "co", label: "Change together", types: ["CO_CHANGES"] },
];
const layerOf = (t: EdgeType) => LAYERS.find((l) => l.types.includes(t))?.id ?? "other";
const HIDDEN_KEY = "orion.graph.hidden";

function baseSize(n: GNode): number {
  switch (n.type) {
    case "Team":
      return 9;
    case "Service":
      return n.tier === 1 ? 7 : n.tier === 2 ? 5.6 : 4.6;
    case "Decision":
      return 5;
    case "Customer":
    case "Project":
      return 4.6;
    default:
      return 3.2;
  }
}

/** How readily a node shows its name: teams and critical services from afar, others up close, people only when
 *  something they're part of is in focus. */
function importance(n: GNode): 0 | 1 | 2 {
  if (n.type === "Person") return 0;
  return n.type === "Team" || n.type === "Customer" || (n.type === "Service" && n.tier === 1) ? 2 : 1;
}

const PRIO: Record<string, number> = { Team: 4, Service: 3, Customer: 2, Decision: 2, Project: 2, Person: 1 };

/** Hops from `seed` to every trail node, over the canvas's own connections (unreached nodes come last). */
function trailHops(t: Trail, adj: Map<string, Set<string>>): Map<string, number> {
  const inTrail = new Set(t.nodes);
  const out = new Map<string, number>();
  const start = t.seed && inTrail.has(t.seed) ? [t.seed] : t.recent.filter((id) => inTrail.has(id)).slice(0, 1);
  let frontier = start;
  let h = 0;
  for (const id of frontier) out.set(id, 0);
  while (frontier.length) {
    h++;
    const next: string[] = [];
    for (const id of frontier)
      for (const nb of adj.get(id) ?? [])
        if (inTrail.has(nb) && !out.has(nb)) {
          out.set(nb, h);
          next.push(nb);
        }
    frontier = next;
  }
  for (const id of t.nodes) if (!out.has(id)) out.set(id, h);
  return out;
}

let shared: {
  geo: Record<string, THREE.BufferGeometry>;
  halo: THREE.Texture;
  ring: THREE.Texture;
} | null = null;

function radialTexture(stops: [number, string][], size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, col] of stops) g.addColorStop(at, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The focus ring: a fine circle with a brighter arc and four ticks, drawn once and tinted per node. */
function ringTexture() {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.42, -0.5, 0.9);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.42, Math.PI - 0.5, Math.PI + 0.9);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(s / 2 + Math.cos(a) * s * 0.46, s / 2 + Math.sin(a) * s * 0.46);
    ctx.lineTo(s / 2 + Math.cos(a) * s * 0.49, s / 2 + Math.sin(a) * s * 0.49);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function assets() {
  if (shared) return shared;
  // smooth bodies only: enough segments that a silhouette never shows a facet, even up close
  const gem = new RoundedBoxGeometry(1.45, 1.45, 1.45, 6, 0.38);
  gem.rotateX(Math.PI / 4);
  gem.rotateZ(Math.PI / 4);
  const ring = new THREE.TorusGeometry(1.8, 0.035, 16, 192);
  ring.rotateX(Math.PI / 2);
  shared = {
    geo: {
      Person: new THREE.SphereGeometry(1, 48, 32),
      Service: new THREE.SphereGeometry(1, 64, 48),
      Team: new THREE.SphereGeometry(1.05, 72, 54),
      Decision: gem,
      Customer: new THREE.TorusGeometry(0.82, 0.36, 40, 120),
      Project: new THREE.CapsuleGeometry(0.62, 0.95, 16, 48),
      ring,
    },
    halo: radialTexture([
      [0, "rgba(255,255,255,0.9)"],
      [0.18, "rgba(255,255,255,0.35)"],
      [0.5, "rgba(255,255,255,0.07)"],
      [1, "rgba(255,255,255,0)"],
    ]),
    ring: ringTexture(),
  };
  return shared;
}

/** A soft radial backdrop: brighter in the middle, falling off to the corners. */
function backdrop(stops: string[]) {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(256, 230, 0, 256, 256, 400);
  g.addColorStop(0, stops[0]);
  g.addColorStop(0.45, stops[1]);
  g.addColorStop(1, stops[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** how long the tour lingers on each stop */
const TOUR_MS = 6500;

const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const endId = (x: string | N3) => (typeof x === "string" ? x : x.id);
const WHITE = new THREE.Color("#ffffff");

// ---------------------------------------------------------------- component

type Tip = { kind: "node"; n: GNode } | { kind: "link"; l: L3; s?: GNode; t?: GNode } | null;

export default function GraphCanvas3D(props: GraphCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<FG | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const rigs = useRef(new Map<string, Rig>());
  const vis = useRef(new Map<string, LinkVis>());
  const nodesById = useRef(new Map<string, N3>());
  const linksRef = useRef<L3[]>([]);
  const nbrs = useRef(new Map<string, Set<string>>());
  const homes = useRef(new Map<string, P3>());
  const ctxRef = useRef<EdgeGraph>({ nodes: [], edges: [] });
  const lookRef = useRef<Look>(LOOK.dark);
  const fogColor = useRef(new THREE.Color(LOOK.dark.fog));

  const hoverNode = useRef<string | null>(null);
  const hoverLink = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const hiddenRef = useRef<Set<string>>(new Set());
  const reduced = useRef(false);
  const entrance = useRef<number | null>(null);
  const entranceMax = useRef(1);
  const api = useRef<{
    restyle: () => void;
    frame: (ids: string[] | null, ms?: number) => void;
    zoom: (f: number) => void;
    select: (id: string | null, restore?: boolean) => void;
    layers: () => void;
    /** the tour's camera: focus a node without opening the inspector, slowly orbiting it; null lets go */
    visit: (id: string | null) => void;
    /** a shockwave from a node, reaching out to `reach` (or a little past the node itself) */
    shock: (id: string, reach: string[], color: string, delay?: number) => void;
    /** something is about to move: render at full rate for a while (the map idles otherwise) */
    wake: (ms?: number) => void;
  } | null>(null);
  const shocksRef = useRef<Shockwaves | null>(null);
  // "what if this stopped working?": a preview worked out from the map alone, revealed hop by hop
  // `quiet`: the same reveal played for an answer (the map becomes the answer), with no card of its own
  const previewRef = useRef<{ impact: Impact; reveal: number; quiet?: boolean } | null>(null);
  const [preview, setPreview] = useState<Impact | null>(null);
  const [tour, setTour] = useState<{ stops: TourStop[]; i: number } | null>(null);
  const tourOn = useRef(false);

  const [tip, setTip] = useState<Tip>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  // no auto-orbit: a graph that drifts on its own pushes clusters out of frame and reads as a screensaver
  const [spin, setSpin] = useState(false);
  const spinRef = useRef(false);
  const [ready, setReady] = useState(false);
  const trailRef = useRef<{ hops: Map<string, number>; at: number } | null>(null);
  const trailStep = useRef(-1);
  const fitted = useRef<{ ns: string; n: number } | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  hiddenRef.current = hidden;

  // ---- mount three once, when the container has a size
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cleanup: (() => void) | null = null;
    const wait = new ResizeObserver(() => {
      if (cleanup || !el.clientWidth || !el.clientHeight) return;
      wait.disconnect();
      cleanup = start(el);
      setReady(true);
    });
    wait.observe(el);
    return () => {
      wait.disconnect();
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function start(el: HTMLDivElement): () => void {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced.current) {
      spinRef.current = false;
      setSpin(false);
    }
    const css2d = new CSS2DRenderer();
    const fg = new ForceGraph3D(el, {
      controlType: "orbit",
      extraRenderers: [css2d as unknown as THREE.WebGLRenderer],
      rendererConfig: { antialias: true, alpha: false, powerPreference: "high-performance" },
    }) as unknown as FG;
    fgRef.current = fg;
    fg.width(el.clientWidth).height(el.clientHeight);
    // the library's own render loop is replaced by ours (below), which renders only while something moves, slows
    // to a few frames a second when nothing does, and stops when the map is off screen
    fg.pauseAnimation();
    let activeUntil = performance.now() + 3000;
    const wake = (ms = 2000) => {
      activeUntil = Math.max(activeUntil, performance.now() + ms);
    };
    let onScreen = true;
    const io = new IntersectionObserver((es) => {
      onScreen = es.some((e) => e.isIntersecting);
      if (onScreen) wake();
    });
    io.observe(el);
    const wakeOnInput = () => wake();
    for (const ev of ["pointermove", "pointerdown", "wheel", "keydown", "touchstart"]) el.addEventListener(ev, wakeOnInput, { passive: true });
    // particles are a moment, not a texture: they run for 1.2 s after a change, then stop
    let particlesUntil = 0;
    let particlesOn = false;
    // and a node that needs attention pulses for a couple of seconds, not for as long as it is shown
    let pulseUntil = 0;

    const { geo, halo, ring: ringTex } = assets();
    const look = LOOK[themeNow()];
    lookRef.current = look;
    const scene = fg.scene();
    const camera = fg.camera() as THREE.PerspectiveCamera;
    const renderer = fg.renderer();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    const bgTex = backdrop(look.bg);
    scene.background = bgTex;
    scene.fog = new THREE.Fog(look.fog, RADIUS, RADIUS * 5);
    fogColor.current = new THREE.Color(look.fog);

    // reflections: a neutral room, prefiltered once, so glossy bodies pick up soft highlights
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = envTex;
    scene.environmentIntensity = look.env;

    // the sky: stars far behind the map (ink specks on paper), the odd shooting star on carbon, and the shells
    // that ripple out when something stops working
    const theme = themeNow();
    const stars = starfield(theme, RADIUS, renderer.getPixelRatio());
    scene.add(stars.object);
    const streaks = theme === "dark" && !reduced.current ? meteors(RADIUS) : null;
    if (streaks) scene.add(streaks.object);
    const shocks = shockwaves(theme);
    scene.add(shocks.object);
    shocksRef.current = shocks;

    // a key light that rides with the camera (upper left, like a photographer's), plus a low fill
    const key = new THREE.DirectionalLight(0xffffff, look.key);
    key.position.set(-0.6, 0.9, 0.5);
    const fill = new THREE.HemisphereLight(0xffffff, 0x404040, look.fill);
    camera.add(key, key.target);
    key.target.position.set(0, 0, -1);
    scene.add(camera);
    fg.lights([fill]);

    // the focus ring: follows whichever node is hovered or selected, always facing the camera
    const focusRing = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, opacity: 0, depthWrite: false, fog: false }),
    );
    focusRing.renderOrder = 2;
    scene.add(focusRing);
    let ringAt: string | null = null;
    let ringAlpha = 0;
    let ringScale = 0;

    // post: multisampled buffers (the composer's targets get no antialiasing by default, which is what made
    // every edge look stepped), bloom on carbon only, then one output pass for tone mapping and sRGB
    const composer = fg.postProcessingComposer();
    composer.renderTarget1.samples = 4;
    composer.renderTarget2.samples = 4;
    // a high threshold: only self-lit nodes (broken, focused, lit by the agent) bloom; a lit hub at rest doesn't
    const bloom = new UnrealBloomPass(new THREE.Vector2(el.clientWidth, el.clientHeight), 0.55, 0.45, 0.97);
    bloom.enabled = look.bloom;
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const controls = fg.controls() as unknown as {
      enableDamping: boolean;
      dampingFactor: number;
      rotateSpeed: number;
      zoomSpeed: number;
      autoRotate: boolean;
      autoRotateSpeed: number;
      minDistance: number;
      maxDistance: number;
      target: THREE.Vector3;
      addEventListener: (ev: string, fn: () => void) => void;
    };
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.8;
    controls.autoRotateSpeed = 0.45;
    controls.autoRotate = spinRef.current;
    controls.minDistance = 12;
    controls.maxDistance = RADIUS * 7;
    let idle: ReturnType<typeof setTimeout> | undefined;
    controls.addEventListener("start", () => {
      controls.autoRotate = false;
      clearTimeout(idle);
    });
    controls.addEventListener("end", () => {
      clearTimeout(idle);
      idle = setTimeout(() => (controls.autoRotate = spinRef.current && !selectedRef.current), 7000);
    });

    // ---- styling targets
    const nodeTarget = (id: string): NodeTarget => {
      const p = propsRef.current;
      const n = nodesById.current.get(id)!.g;
      // carbon: team hubs rest a step below white, so the biggest nodes aren't the loudest
      const rest = n.type === "Team" && look.bloom ? C.muted : NODE_COLORS[n.type];
      const t: NodeTarget = {
        color: new THREE.Color(p.nodeColor?.(n) ?? (n.retired || n.former ? C.retired : rest ?? C.muted)),
        scale: 1,
        glow: 0,
        opacity: 1,
        label: importance(n),
        prio: PRIO[n.type] ?? 1,
        pulse: 0,
      };
      const hl = p.highlight?.length ? new Set(p.highlight) : null;
      // the agent's trail: lit in ink as the walk reaches it, everything else steps back
      const tr = !hl && p.trail ? trailRef.current : null;
      if (tr) {
        const h = tr.hops.get(id);
        if (h !== undefined && h <= trailStep.current) {
          Object.assign(t, { scale: 1.3, glow: 0.55, label: 4, prio: 5, pulse: p.trail!.recent.includes(id) ? 0.5 : 0 });
          t.color.set(C.text);
        } else Object.assign(t, { opacity: 0.15, glow: 0, label: 0 });
      }
      if (p.diff) {
        const hops = p.diff.broken.get(id);
        if (hops !== undefined && hops <= p.diff.revealHops) {
          Object.assign(t, { scale: 1.35, glow: 0.85, label: 4, prio: 5, pulse: 1 });
          t.color.set(C.bad);
        } else if (p.diff.orphans.has(id)) {
          Object.assign(t, { scale: 1.3, glow: 0.6, label: 4, prio: 5 });
          t.color.set(C.orphan);
        } else if (n.retired || n.former) {
          t.label = 4;
          t.color.set(C.retired);
        }
      }
      const pv = !p.diff ? previewRef.current : null;
      if (pv) {
        const hops = pv.impact.broken.get(id);
        if (id === pv.impact.origin) {
          Object.assign(t, { scale: 1.55, glow: 1, label: 4, prio: 6, pulse: 1 });
          t.color.set(C.ember);
        } else if (hops !== undefined && hops <= pv.reveal) {
          Object.assign(t, { scale: 1.3, glow: 0.85, label: 4, prio: 5, pulse: 1 });
          t.color.set(C.bad);
        } else if (pv.reveal > pv.impact.maxHops && (pv.impact.teams.includes(id) || pv.impact.customers.includes(id))) {
          Object.assign(t, { glow: 0.6, label: 4, prio: 5 });
          t.color.set(C.orphan);
        } else Object.assign(t, { opacity: hops !== undefined ? 0.5 : 0.16, glow: 0, label: 0 });
      }
      if (p.pulse?.includes(id)) {
        Object.assign(t, { scale: 1.5, glow: 0.9, label: 4, prio: 5, pulse: 1 });
        t.color.set(p.pulseColor ?? C.added);
      }
      if (hl) {
        const story = pv?.quiet && (id === pv.impact.origin || pv.impact.broken.has(id) ||
          pv.impact.teams.includes(id) || pv.impact.customers.includes(id));
        if (story) t.label = t.label === 4 ? 4 : 3;
        else if (hl.has(id)) {
          Object.assign(t, { scale: 1.45, glow: 1, label: 4, prio: 5, opacity: 1 });
          t.color.set(p.highlightColor ?? C.trunk);
        } else Object.assign(t, { opacity: 0.08, glow: 0, label: 0 });
      }
      const focus = hoverNode.current ?? selectedRef.current;
      if (focus) {
        if (id === focus) Object.assign(t, { scale: t.scale * 1.25, glow: Math.max(t.glow, 0.95), label: 4, prio: 6, opacity: 1 });
        else if (nbrs.current.get(focus)?.has(id)) Object.assign(t, { label: 3, glow: Math.max(t.glow, 0.3), opacity: 1 });
        else if (!hl) Object.assign(t, { opacity: 0.12, label: 0, glow: 0 });
      }
      const hlink = hoverLink.current ? linksRef.current.find((l) => l.key === hoverLink.current) : null;
      if (hlink && (endId(hlink.source) === id || endId(hlink.target) === id))
        Object.assign(t, { label: 4, glow: Math.max(t.glow, 0.7), opacity: 1 });
      if (p.forceLabels?.includes(id)) Object.assign(t, { label: 4, prio: Math.max(t.prio, 5) });
      return t;
    };

    const linkTarget = (l: L3): LinkTarget => {
      const p = propsRef.current;
      const e = l.e;
      const s = endId(l.source),
        tg = endId(l.target);
      const base = look.edges[e.type] ?? { color: C.muted, opacity: 0.2, width: 0 };
      const undeclared = (e.type === "DEPENDS_ON" || e.type === "OWNS") && e.declared === false;
      let opacity = undeclared ? 0.75 : base.opacity;
      if (e.type === "COLLABORATES" && p.edgeFilter) opacity = Math.min(0.55, 0.14 + (e.weight ?? 1) / 25);
      const t: LinkTarget = {
        color: new THREE.Color(undeclared ? C.undeclared : base.color),
        opacity,
        particles: 0,
        particleColor: undeclared ? C.undeclared : look.particle,
        particleSpeed: 0.0045,
      };
      if (p.diff) {
        if (p.diff.addedEdges.has(l.key)) {
          t.color.set(C.added);
          Object.assign(t, { opacity: 0.95, particles: 2, particleColor: C.added });
        } else if (l.ghost || p.diff.removedEdges.has(l.key)) {
          t.color.set(C.bad);
          Object.assign(t, { opacity: 0.4, particles: 0 });
        } else if (e.type === "DEPENDS_ON") {
          const hs = p.diff.broken.get(s),
            ht = p.diff.broken.get(tg);
          const tRetired = nodesById.current.get(tg)?.g.retired;
          if (hs !== undefined && hs <= p.diff.revealHops && (ht !== undefined || tRetired)) {
            t.color.set(C.bad);
            // breakage travels from the retired service back to whoever relies on it
            Object.assign(t, { opacity: 0.9, particles: 2, particleColor: C.bad, particleSpeed: -0.008 });
          }
        }
      }
      const pv = !p.diff ? previewRef.current : null;
      if (pv) {
        const { broken, origin, teams, customers, maxHops } = pv.impact;
        const hs = broken.get(s);
        const done = pv.reveal > maxHops;
        const hit = (id: string) => id === origin || broken.has(id);
        if (e.type === "DEPENDS_ON" && hs !== undefined && hs <= pv.reveal && (tg === origin || broken.has(tg))) {
          t.color.set(C.bad);
          Object.assign(t, { opacity: 0.95, particles: reduced.current ? 0 : 2, particleColor: C.bad, particleSpeed: -0.009 });
        } else if (done && hit(tg) && (teams.includes(s) || customers.includes(s))) {
          t.color.set(C.orphan);
          Object.assign(t, { opacity: 0.7, particles: 0 });
        } else Object.assign(t, { opacity: e.type === "KNOWS" || e.type === "COLLABORATES" ? 0 : t.opacity * 0.12, particles: 0 });
      }
      const hl = p.highlight?.length ? new Set(p.highlight) : null;
      const tr = !hl && p.trail ? trailRef.current : null;
      if (tr) {
        const hs = tr.hops.get(s),
          ht = tr.hops.get(tg);
        if (hs !== undefined && ht !== undefined && Math.max(hs, ht) <= trailStep.current) {
          t.color.set(C.text);
          Object.assign(t, { opacity: 0.9, particles: reduced.current ? 0 : 1, particleColor: C.text, particleSpeed: 0.007 });
        } else Object.assign(t, { opacity: e.type === "KNOWS" || e.type === "COLLABORATES" ? 0 : t.opacity * 0.15, particles: 0 });
      }
      if (hl) {
        const storyLink = pv?.quiet && t.color.equals(new THREE.Color(C.bad));
        if (storyLink) {
          /* the breakage keeps its red */
        } else if (hl.has(s) && hl.has(tg)) {
          t.color.set(p.highlightColor ?? C.trunk);
          Object.assign(t, { opacity: 0.95, particles: 2, particleColor: p.highlightColor ?? C.trunk, particleSpeed: 0.007 });
        } else Object.assign(t, { opacity: e.type === "KNOWS" || e.type === "COLLABORATES" ? 0 : t.opacity * 0.08, particles: 0 });
      }
      const focus = hoverNode.current ?? selectedRef.current;
      if (focus) {
        if (s === focus || tg === focus) {
          if (look.bloom) t.color.lerp(WHITE, 0.3);
          const fc = rigs.current.get(focus)?.t.color;
          Object.assign(t, {
            opacity: Math.max(0.85, t.opacity),
            particles: reduced.current ? 0 : 2,
            particleColor: fc ? `#${fc.getHexString()}` : C.trunk,
            particleSpeed: 0.006,
          });
        } else if (!hl) Object.assign(t, { opacity: t.opacity * 0.1, particles: 0 });
      }
      if (hoverLink.current === l.key) {
        t.color.set(C.text);
        Object.assign(t, { opacity: 1, particles: reduced.current ? 0 : 3, particleColor: C.text, particleSpeed: 0.009 });
      }
      return t;
    };

    const applyParticles = () => {
      const T = (l: L3) => vis.current.get(l.key)?.t;
      const live = !reduced.current && performance.now() < particlesUntil;
      particlesOn = live;
      fg.linkDirectionalParticles((l: L3) => (live ? T(l)?.particles ?? 0 : 0));
    };
    const restyle = () => {
      wake();
      for (const [id, rig] of rigs.current) if (nodesById.current.has(id)) rig.t = nodeTarget(id);
      for (const l of linksRef.current) {
        const v = vis.current.get(l.key);
        if (v) v.t = linkTarget(l);
      }
      const T = (l: L3) => vis.current.get(l.key)?.t;
      particlesUntil = performance.now() + 1200;
      pulseUntil = performance.now() + 2600;
      applyParticles();
      fg
        .linkDirectionalParticleColor((l: L3) => T(l)?.particleColor ?? C.text)
        .linkDirectionalParticleSpeed((l: L3) => T(l)?.particleSpeed ?? 0.005)
        .linkDirectionalArrowColor((l: L3) => {
          const t = T(l);
          // arrows are drawn opaque, so a dimmed link's arrow sinks into the background instead
          return t ? `#${t.color.clone().lerp(fogColor.current, 1 - Math.min(1, t.opacity * 1.5)).getHexString()}` : C.muted;
        });
    };

    // ---- node objects
    const makeRig = (node: N3): THREE.Object3D => {
      const n = node.g;
      const p = propsRef.current;
      const r = (p.nodeSize?.(n) ?? baseSize(n)) * 0.62;
      const t = nodeTarget(node.id);
      const prev = rigs.current.get(node.id);
      // people are satin, services a glossy lacquer; team hubs are matte (the biggest nodes, and the least
      // important: on paper they're a paper body inside an ink ring)
      const satin = n.type === "Person";
      const team = n.type === "Team";
      const paper = team && themeNow() === "light";
      const body = new THREE.Mesh(
        geo[n.type] ?? geo.Person,
        new THREE.MeshPhysicalMaterial({
          color: paper ? C.panel : t.color,
          emissive: t.color,
          emissiveIntensity: paper ? 0 : look.emissive.base,
          roughness: satin ? 0.55 : team ? 0.7 : 0.24,
          metalness: n.type === "Decision" ? 0.25 : 0.04,
          clearcoat: satin ? 0.25 : team ? 0 : 1,
          clearcoatRoughness: satin ? 0.5 : 0.12,
          sheen: satin ? 0.6 : 0,
          sheenColor: new THREE.Color("#ffffff"),
          transparent: true,
        }),
      );
      const haloSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: halo, color: t.color, transparent: true, opacity: 0, blending: look.halo.blending, depthWrite: false }),
      );
      haloSprite.scale.setScalar(7);
      const group = new THREE.Group();
      group.add(body, haloSprite);
      let shell: Rig["shell"];
      if (n.type === "Team") {
        // a fine orbit ring, tilted a little differently per team so the hubs don't look stamped
        shell = new THREE.Mesh(
          geo.ring,
          new THREE.MeshPhysicalMaterial({ color: t.color, metalness: paper ? 0 : 0.3, roughness: paper ? 0.9 : 0.4, transparent: true, opacity: 0.85 }),
        );
        const h = [...node.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
        shell.rotation.set(0.35 + (h % 7) * 0.08, 0, -0.25 + (h % 5) * 0.1);
        group.add(shell);
      }
      if (n.type === "Decision" || n.type === "Customer" || n.type === "Project") body.rotation.set(0.4, (node.id.length % 6) * 0.5, 0.2);
      const labelEl = document.createElement("div");
      labelEl.className = "g3-label";
      labelEl.dataset.type = n.type;
      labelEl.textContent = n.type === "Decision" ? n.key ?? n.name ?? n.id : n.name ?? n.id;
      labelEl.style.opacity = "0";
      const label = new CSS2DObject(labelEl);
      label.center.set(0.5, 1);
      label.position.set(0, 1.25, 0);
      group.add(label);
      const rig: Rig = {
        group,
        body,
        halo: haloSprite,
        shell,
        spin: n.type === "Decision" || n.type === "Customer" || n.type === "Project" ? 0.25 + (node.id.length % 5) * 0.04 : 0,
        label,
        el: labelEl,
        r,
        color: prev ? prev.color.clone() : t.color.clone(),
        scale: prev ? prev.scale : t.scale,
        glow: prev ? prev.glow : 0,
        opacity: prev ? prev.opacity : t.opacity,
        labelAlpha: 0,
        lw: (labelEl.textContent ?? "").length * 6.3 + 8,
        lh: n.type === "Team" ? 26 : 22,
        born: entrance.current !== null ? (Math.hypot(node.x, node.y, node.z) / entranceMax.current) * 0.9 : 0,
        paper,
        clearcoat: body.material.clearcoat,
        t,
      };
      group.scale.setScalar(r);
      if (prev) retire(prev);
      rigs.current.set(node.id, rig);
      return group;
    };

    fg.backgroundColor(look.fog)
      .showNavInfo(false)
      .nodeId("id")
      .nodeThreeObject((n: N3) => makeRig(n))
      .nodeLabel(() => "")
      .linkLabel(() => "")
      .linkSource("source")
      .linkTarget("target")
      .linkWidth((l: L3) => {
        if (l.e.type === "CO_CHANGES") return Math.min(2.2, 0.5 + (l.e.weight ?? 1) / 6);
        return look.edges[l.e.type]?.width ?? 0;
      })
      .linkMaterial((l: L3) => vis.current.get(l.key)?.mat ?? null)
      .linkCurvature((l: L3) => l.curve)
      .linkDirectionalArrowLength((l: L3) => (l.e.type === "DEPENDS_ON" || l.e.type === "DEPENDS_ON_CLOSED" ? 3.6 : 0))
      .linkDirectionalArrowRelPos((l: L3) => l.arrowAt)
      .linkDirectionalArrowResolution(20)
      .linkResolution(10)
      .linkDirectionalParticleWidth((l: L3) => (hoverLink.current === l.key ? 1.5 : 1.05))
      .linkDirectionalParticleResolution(12)
      .linkOpacity(0.34)
      .linkHoverPrecision(2.2)
      .linkVisibility((l: L3) => !hiddenRef.current.has(layerOf(l.e.type)))
      .enableNodeDrag(true)
      .warmupTicks(0)
      .cooldownTime(2500)
      .d3AlphaDecay(0.035)
      .d3VelocityDecay(0.32);

    // At rest every force is zero: the anchor pulls each node to its home, and the springs only resist a
    // change in the offset between two connected nodes. So a drag tugs the neighbourhood along, and letting
    // go eases everything back.
    fg.d3Force("charge", null);
    fg.d3Force("center", null);
    (fg.d3Force("link") as unknown as { strength: (v: number) => void } | undefined)?.strength(0);
    const anchor = Object.assign(
      () => {
        for (const n of nodesById.current.values()) {
          const h = homes.current.get(n.id);
          if (!h || n.fx !== undefined) continue;
          n.vx = (n.vx ?? 0) + (h.x - n.x) * 0.045;
          n.vy = (n.vy ?? 0) + (h.y - n.y) * 0.045;
          n.vz = (n.vz ?? 0) + (h.z - n.z) * 0.045;
        }
      },
      { initialize: () => {} },
    );
    const springs = Object.assign(
      () => {
        for (const l of linksRef.current) {
          if (typeof l.source === "string" || typeof l.target === "string") continue;
          const a = l.source,
            b = l.target;
          const ha = homes.current.get(a.id),
            hb = homes.current.get(b.id);
          if (!ha || !hb) continue;
          const k = l.e.type === "KNOWS" || l.e.type === "COLLABORATES" ? 0.012 : 0.05;
          const dx = a.x + (hb.x - ha.x) - b.x,
            dy = a.y + (hb.y - ha.y) - b.y,
            dz = a.z + (hb.z - ha.z) - b.z;
          if (b.fx === undefined) {
            b.vx = (b.vx ?? 0) + dx * k;
            b.vy = (b.vy ?? 0) + dy * k;
            b.vz = (b.vz ?? 0) + dz * k;
          }
          if (a.fx === undefined) {
            a.vx = (a.vx ?? 0) - dx * k;
            a.vy = (a.vy ?? 0) - dy * k;
            a.vz = (a.vz ?? 0) - dz * k;
          }
        }
      },
      { initialize: () => {} },
    );
    fg.d3Force("anchor", anchor as never);
    fg.d3Force("springs", springs as never);

    // ---- interaction
    let pointer = { x: 0, y: 0 };
    const placeTip = () => {
      const t = tipRef.current;
      if (!t) return;
      const w = el.clientWidth;
      const tw = t.offsetWidth || 260;
      const left = pointer.x + 16 + tw > w - 8 ? pointer.x - tw - 14 : pointer.x + 16;
      t.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, pointer.y + 14)}px)`;
    };
    const onMove = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      pointer = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      placeTip();
    };
    el.addEventListener("pointermove", onMove);

    fg.onNodeHover((n: N3 | null) => {
      hoverNode.current = n?.id ?? null;
      el.style.cursor = n ? "pointer" : "";
      setTip(n ? { kind: "node", n: n.g } : null);
      restyle();
    });
    fg.onLinkHover((l: L3 | null) => {
      hoverLink.current = l?.key ?? null;
      el.style.cursor = l ? "pointer" : "";
      setTip(
        l
          ? { kind: "link", l, s: nodesById.current.get(endId(l.source))?.g, t: nodesById.current.get(endId(l.target))?.g }
          : null,
      );
      restyle();
    });
    fg.onLinkClick((l: L3) => {
      const s = nodesById.current.get(endId(l.source))?.g;
      const t = nodesById.current.get(endId(l.target))?.g;
      propsRef.current.onEdgeClick?.(l.e, s, t, ctxRef.current);
    });
    // a click takes over from the tour; a click on empty space also clears a "what if this stopped" preview
    const leaveTour = () => {
      if (!tourOn.current) return;
      tourOn.current = false;
      setTour(null);
      visit(null);
    };
    fg.onNodeClick((n: N3) => {
      leaveTour();
      select(n.id);
      propsRef.current.onNodeClick?.(n.g);
    });
    fg.onBackgroundClick(() => {
      leaveTour();
      if (previewRef.current) setPreview(null);
      select(null);
    });
    fg.onNodeDrag(() => {
      controls.autoRotate = false;
      setTip(null);
    });

    const frame = (ids: string[] | null, ms = 900) => {
      wake(ms + 600);
      const pts = (ids ?? [...nodesById.current.keys()])
        .map((id) => nodesById.current.get(id))
        .filter((n): n is N3 => !!n);
      if (!pts.length) return;
      const c = pts.reduce((a, p) => a.add(new THREE.Vector3(p.x, p.y, p.z)), new THREE.Vector3()).divideScalar(pts.length);
      const rad = Math.max(ids ? 70 : 60, ...pts.map((p) => c.distanceTo(new THREE.Vector3(p.x, p.y, p.z))));
      const vfov = (camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      // 40px of clear space on every side
      const pad = Math.max(el.clientHeight / Math.max(1, el.clientHeight - 80), el.clientWidth / Math.max(1, el.clientWidth - 80));
      const dist = (rad / Math.sin(Math.min(vfov, hfov) / 2)) * Math.min(1.6, pad);
      const dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize();
      const pos = c.clone().add(dir.multiplyScalar(dist));
      fg.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: c.x, y: c.y, z: c.z }, reduced.current ? 0 : ms);
    };

    let before: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
    const select = (id: string | null, restore = true) => {
      wake(1800);
      if (id && !selectedRef.current) before = { pos: camera.position.clone(), target: controls.target.clone() };
      if (!id && selectedRef.current && restore && before) {
        const { pos, target } = before;
        fg.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: target.x, y: target.y, z: target.z }, reduced.current ? 0 : 900);
      }
      if (!id) before = null;
      selectedRef.current = id;
      setSelected(id);
      controls.autoRotate = !id && spinRef.current;
      restyle();
      if (id) {
        const n = nodesById.current.get(id);
        if (!n) return;
        const c = new THREE.Vector3(n.x, n.y, n.z);
        const dir = camera.position.clone().sub(c).normalize();
        // the inspector covers the right of the canvas, so aim a little to the right of the node and it lands
        // in the open part
        const dist = 120;
        const shiftPx = el.clientWidth > 640 ? Math.min(330, el.clientWidth * 0.4) / 2 : 0;
        const visH = 2 * dist * Math.tan((camera.fov * Math.PI) / 360);
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const aim = c.clone().add(right.multiplyScalar((shiftPx / Math.max(1, el.clientHeight)) * visH));
        const pos = aim.clone().add(dir.multiplyScalar(dist));
        fg.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: aim.x, y: aim.y, z: aim.z }, reduced.current ? 0 : 1100);
      }
    };

    const zoom = (f: number) => {
      wake(900);
      const tgt = controls.target.clone();
      const pos = camera.position.clone().sub(tgt).multiplyScalar(f).add(tgt);
      fg.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: tgt.x, y: tgt.y, z: tgt.z }, reduced.current ? 0 : 380);
    };

    let orbitLater: ReturnType<typeof setTimeout> | undefined;
    const visit = (id: string | null) => {
      wake(2400);
      clearTimeout(orbitLater);
      selectedRef.current = id;
      restyle();
      controls.autoRotateSpeed = 0.45;
      controls.autoRotate = !id && spinRef.current;
      if (!id) return;
      const n = nodesById.current.get(id);
      if (!n) return;
      const c = new THREE.Vector3(n.x, n.y, n.z);
      // look in from outside the map, along the line from its middle through the node, so no other node sits
      // between the camera and the stop; tilt toward the current view so the flight doesn't swing round too far
      const mid = new THREE.Vector3();
      for (const m of nodesById.current.values()) mid.add(new THREE.Vector3(m.x, m.y, m.z));
      mid.divideScalar(Math.max(1, nodesById.current.size));
      const out = c.clone().sub(mid);
      const toCam = camera.position.clone().sub(c).normalize();
      const dir = out.lengthSq() > 1 ? out.normalize().multiplyScalar(0.75).add(toCam.multiplyScalar(0.25)).normalize() : toCam;
      const pos = c.clone().add(dir.multiplyScalar(n.g.type === "Team" ? 230 : 190));
      fg.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: c.x, y: c.y, z: c.z }, reduced.current ? 0 : 1600);
      // once the camera has arrived, drift slowly around what it is looking at
      if (!reduced.current)
        orbitLater = setTimeout(() => {
          controls.autoRotateSpeed = 0.5;
          controls.autoRotate = true;
        }, 1700);
    };

    const shock = (id: string, reach: string[], color: string, delay = 0) => {
      if (reduced.current) return;
      wake(delay + 2200);
      const n = nodesById.current.get(id);
      if (!n) return;
      let r = 0;
      for (const o of reach) {
        const m = nodesById.current.get(o);
        if (m) r = Math.max(r, Math.hypot(m.x - n.x, m.y - n.y, m.z - n.z));
      }
      if (r > 0) {
        // a wide shell that reaches the furthest casualty, and a fainter echo behind it
        shocks.fire(n, r + 30, color, { ms: 1700, delay });
        shocks.fire(n, (r + 30) * 0.7, color, { ms: 1700, delay: delay + 260, peak: look.bloom ? 0.45 : 0.3 });
      } else shocks.fire(n, 26, color, { ms: 850, delay, peak: look.bloom ? 0.75 : 0.45 });
    };

    api.current = {
      restyle,
      frame,
      zoom,
      select,
      layers: () => fg.linkVisibility((l: L3) => !hiddenRef.current.has(layerOf(l.e.type))),
      visit,
      shock,
      wake,
    };
    fg.onEngineTick(() => wake(400));

    // ---- per-frame easing, labels, entrance
    let raf = 0;
    let last = performance.now();
    const tmp = new THREE.Vector3();
    const size = { w: el.clientWidth, h: el.clientHeight };
    const cands: { rig: Rig; a: number; prio: number; depth: number; x: number; y: number }[] = [];
    const placed: { l: number; r: number; t: number; b: number }[] = [];
    const paperColor = new THREE.Color(C.panel);
    let lastRender = 0;
    const lastCam = new THREE.Vector3();
    const lastQuat = new THREE.Quaternion();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!onScreen || document.hidden) {
        last = now;
        return;
      }
      // the first frame's timestamp can precede `last`; a negative step would push colours below zero
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      let motion = 0;
      const k = 1 - Math.exp(-dt * 9);
      const start = entrance.current;
      const since = start === null ? Infinity : (now - start) / 1000;
      if (start !== null && since > 2.4) entrance.current = null;
      const camDist = camera.position.distanceTo(controls.target);
      if (scene.fog instanceof THREE.Fog) {
        scene.fog.near = Math.max(1, camDist - RADIUS * 0.15);
        scene.fog.far = camDist + RADIUS * 2.6;
      }
      const near1 = Math.min(140, camDist * 0.9 + 30);
      const near2 = Math.max(near1 + 40, camDist * 1.35 + 60);
      const wobble = Math.sin(now / 210);

      for (const [id, rig] of rigs.current) {
        const t = rig.t;
        const f = since === Infinity ? 1 : ease((since - rig.born) / 0.7);
        motion += Math.abs(t.scale - rig.scale) + Math.abs(t.glow - rig.glow) + Math.abs(t.opacity - rig.opacity) +
          Math.abs(t.color.r - rig.color.r) + Math.abs(t.color.g - rig.color.g) + Math.abs(t.color.b - rig.color.b);
        rig.color.lerp(t.color, k);
        rig.scale += (t.scale - rig.scale) * k;
        rig.glow += (t.glow - rig.glow) * k;
        rig.opacity += (t.opacity - rig.opacity) * k;
        const pulsing = !!t.pulse && !reduced.current && now < pulseUntil;
        if (pulsing) motion += 1;
        const pulse = pulsing ? 1 + 0.14 * t.pulse * wobble : 1;
        rig.group.scale.setScalar(Math.max(0.0001, rig.r * rig.scale * pulse * f));
        const m = rig.body.material;
        if (rig.paper) {
          // paper hub: the body stays paper unless the hub is in a state, the ring carries the colour
          m.color.copy(paperColor).lerp(rig.color, Math.min(1, rig.glow));
          m.emissive.copy(rig.color);
        } else {
          m.color.copy(rig.color);
          m.emissive.copy(rig.color);
        }
        // under bloom, light colours (the near-white teams) need far less self-light to glow the same amount
        const lumK = look.bloom ? 1 - 0.85 * (0.2126 * rig.color.r + 0.7152 * rig.color.g + 0.0722 * rig.color.b) : 1;
        m.emissiveIntensity = rig.paper ? rig.glow * look.emissive.glow : (look.emissive.base + rig.glow * look.emissive.glow) * lumK;
        // The scene renders in HDR and a glossy body's light runs well above 1, so alpha alone barely dims it:
        // a node that steps back also loses its reflections and fades its colour into the background.
        const vis = rig.opacity;
        if (vis < 0.999) {
          m.color.lerp(fogColor.current, 1 - vis);
          m.emissive.multiplyScalar(vis);
        }
        m.envMapIntensity = vis;
        m.specularIntensity = vis;
        m.clearcoat = rig.clearcoat * vis;
        m.opacity = vis;
        m.depthWrite = vis > 0.9;
        // the slow turn of shapes and rings only while the map is moving anyway: at rest it is still
        const moving = now < activeUntil && !reduced.current;
        if (rig.spin && moving) rig.body.rotation.y += dt * rig.spin;
        const hm = rig.halo.material;
        hm.color.copy(rig.color);
        hm.opacity = rig.glow * (pulsing ? look.halo.k + 0.2 * wobble : look.halo.k) * rig.opacity * lumK;
        if (rig.shell) {
          if (moving) rig.shell.rotation.y += dt * 0.3;
          rig.shell.material.color.copy(rig.color).lerp(fogColor.current, 1 - rig.opacity);
          rig.shell.material.envMapIntensity = rig.opacity;
          rig.shell.material.opacity = 0.85 * rig.opacity;
        }
        // labels fade with distance, so zooming in reveals names gradually
        const n = nodesById.current.get(id);
        let a = 0;
        if (n && t.label) {
          if (t.label >= 3) a = 1;
          else {
            const d = tmp.set(n.x, n.y, n.z).distanceTo(camera.position);
            const lim = t.label === 2 ? near2 : near1;
            a = Math.min(1, Math.max(0, (lim - d) / 45));
          }
        }
        a *= f * Math.min(1, rig.opacity * 1.4);
        if (a > 0.02 && n) {
          tmp.set(n.x, n.y, n.z).project(camera);
          if (tmp.z > 1) a = 0;
          else cands.push({ rig, a, prio: t.prio, depth: tmp.z, x: ((tmp.x + 1) / 2) * size.w, y: ((1 - tmp.y) / 2) * size.h });
        }
        rig.labelTarget = a;
      }
      // greedy: names are placed most important first (focused, evidence, team, service, customer, person), then
      // nearest; a name that would land on one already placed steps aside. Only the focused node always shows.
      cands.sort((p, q) => q.prio - p.prio || p.depth - q.depth);
      placed.length = 0;
      for (const c of cands) {
        const box = { l: c.x - c.rig.lw / 2, r: c.x + c.rig.lw / 2, t: c.y - c.rig.lh, b: c.y };
        if (c.prio < 6 && placed.some((p) => box.l < p.r + 4 && box.r > p.l - 4 && box.t < p.b + 2 && box.b > p.t - 2)) {
          c.rig.labelTarget = 0;
          continue;
        }
        placed.push(box);
      }
      cands.length = 0;
      for (const rig of rigs.current.values()) {
        motion += Math.abs((rig.labelTarget ?? 0) - rig.labelAlpha);
        // label boxes for the overlap test: measured once the label is in the page (fonts differ by type)
        if (!rig.measured && rig.el.isConnected && rig.el.offsetWidth) {
          rig.lw = rig.el.offsetWidth + 6;
          rig.lh = rig.el.offsetHeight + 4;
          rig.measured = true;
        }
        rig.labelAlpha += ((rig.labelTarget ?? 0) - rig.labelAlpha) * k;
        const shown = rig.labelAlpha > 0.02;
        if (rig.label.visible !== shown) rig.label.visible = shown;
        if (shown) {
          const o = rig.labelAlpha.toFixed(2);
          if (rig.el.style.opacity !== o) rig.el.style.opacity = o;
        }
      }
      for (const l of linksRef.current) {
        const v = vis.current.get(l.key);
        if (!v) continue;
        let f = 1;
        if (since !== Infinity) {
          const a = rigs.current.get(endId(l.source)),
            b = rigs.current.get(endId(l.target));
          f = ease((since - Math.max(a?.born ?? 0, b?.born ?? 0) - 0.35) / 0.6);
        }
        motion += Math.abs(v.t.opacity - v.opacity);
        v.mat.color.lerp(v.t.color, k);
        v.opacity += (v.t.opacity - v.opacity) * k;
        v.mat.opacity = Math.max(0, v.opacity * f);
      }
      // focus ring
      const fid = hoverNode.current ?? selectedRef.current;
      if (fid && rigs.current.has(fid)) ringAt = fid;
      const ringRig = ringAt ? rigs.current.get(ringAt) : undefined;
      const ringNode = ringAt ? nodesById.current.get(ringAt) : undefined;
      ringAlpha += ((fid && ringRig ? look.ring : 0) - ringAlpha) * k;
      if (ringRig && ringNode) {
        const target = ringRig.r * ringRig.scale * (ringRig.shell ? 5.4 : 3.4);
        ringScale += (target - ringScale) * k;
        // grows in from slightly larger, like a lens settling
        const settle = 1 + (1 - Math.min(1, ringAlpha / Math.max(0.01, look.ring))) * 0.35;
        focusRing.position.set(ringNode.x, ringNode.y, ringNode.z);
        focusRing.quaternion.copy(camera.quaternion);
        if (!reduced.current) focusRing.rotateZ(now / 2600);
        focusRing.scale.setScalar(ringScale * settle);
        focusRing.material.color.copy(ringRig.color);
      }
      focusRing.material.opacity = ringAlpha;
      focusRing.visible = ringAlpha > 0.01;
      if (!reduced.current) stars.tick(now / 1000);
      streaks?.tick(now / 1000, dt, camera);
      shocks.tick(now);
      if (particlesOn && now > particlesUntil) applyParticles();
      // what counts as moving: easing still settling, the camera travelling (or auto-orbiting), an entrance,
      // a shockwave, a shooting star, particles; then render every frame. Otherwise idle: a few frames a second
      // keep the stars twinkling, at a fraction of the cost.
      if (camera.position.distanceToSquared(lastCam) > 1e-4 || camera.quaternion.angleTo(lastQuat) > 1e-4) motion += 1;
      lastCam.copy(camera.position);
      lastQuat.copy(camera.quaternion);
      if (motion > 0.004 || entrance.current !== null || controls.autoRotate || particlesOn || shocks.live() || streaks?.live())
        wake(300);
      if (now < activeUntil || now - lastRender > (reduced.current ? 1000 : 120)) {
        lastRender = now;
        fg.resumeAnimation();
        fg.pauseAnimation();
      }
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => {
      if (!el.clientWidth || !el.clientHeight) return;
      size.w = el.clientWidth;
      size.h = el.clientHeight;
      fg.width(el.clientWidth).height(el.clientHeight);
    });
    ro.observe(el);

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && selectedRef.current && !tourOn.current) {
        ev.stopPropagation();
        select(null);
      }
    };
    el.addEventListener("keydown", onKey);
    const dropFakeUp = (ev: PointerEvent) => {
      if (!ev.isTrusted && ev.pointerType === "touch") ev.stopImmediatePropagation();
    };
    document.addEventListener("pointerup", dropFakeUp, true);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      for (const ev of ["pointermove", "pointerdown", "wheel", "keydown", "touchstart"]) el.removeEventListener(ev, wakeOnInput);
      clearTimeout(idle);
      clearTimeout(orbitLater);
      stars.dispose();
      streaks?.dispose();
      shocks.dispose();
      shocksRef.current = null;
      ro.disconnect();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerup", dropFakeUp, true);
      fg.pauseAnimation();
      fg._destructor();
      focusRing.geometry.dispose();
      focusRing.material.dispose();
      bgTex.dispose();
      envTex.dispose();
      for (const rig of rigs.current.values()) retire(rig);
      for (const v of vis.current.values()) v.mat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      css2d.domElement.remove();
      el.replaceChildren();
      rigs.current.clear();
      vis.current.clear();
      fgRef.current = null;
      api.current = null;
    };
  }

  // ---- (re)build the graph when the data or filters change
  const { data, layoutNs = "main", nodeFilter, edgeFilter, nodeColor, nodeSize, ghostEdges } = props;
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const nodes = data ? (nodeFilter ? data.nodes.filter(nodeFilter) : data.nodes) : [];
    const ids = new Set(nodes.map((n) => n.id));
    const edges = data
      ? (edgeFilter ? data.edges.filter(edgeFilter) : data.edges).filter((e) => ids.has(e.source) && ids.has(e.target))
      : [];
    ctxRef.current = { nodes, edges };
    homes.current = nodes.length ? homesFor(layoutNs, nodes, edges) : new Map();

    const prev = nodesById.current;
    const next = new Map<string, N3>();
    for (const g of nodes) {
      const h = homes.current.get(g.id) ?? { x: 0, y: 0, z: 0 };
      const old = prev.get(g.id);
      // the force graph keys its objects by node identity, so handing back the same object keeps the node's mesh and
      // label (no flash of every name on each timeline step); only a node whose label or size changed is rebuilt
      const same = old && old.g.type === g.type && old.g.name === g.name && old.g.key === g.key && (nodeSize?.(old.g) ?? baseSize(old.g)) === (nodeSize?.(g) ?? baseSize(g));
      if (same) {
        old.g = g;
        next.set(g.id, old);
      } else next.set(g.id, { id: g.id, g, x: old?.x ?? h.x, y: old?.y ?? h.y, z: old?.z ?? h.z });
    }
    nodesById.current = next;

    // links: one material each so every link can fade on its own; parallel links between the same pair curve apart
    for (const v of vis.current.values()) v.mat.dispose();
    vis.current = new Map();
    const pairCount = new Map<string, number>();
    const links: L3[] = [];
    const add = (e: GEdge, ghost: boolean) => {
      const key = edgeKey(e);
      if (vis.current.has(key) || !next.has(e.source) || !next.has(e.target) || e.source === e.target) return;
      const pair = [e.source, e.target].sort().join("|");
      const nth = pairCount.get(pair) ?? 0;
      pairCount.set(pair, nth + 1);
      const a = homes.current.get(e.source),
        b = homes.current.get(e.target);
      const len = a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 40;
      const tr = ((nodeSize?.(next.get(e.target)!.g) ?? baseSize(next.get(e.target)!.g)) * 0.62) + 1.2;
      const look = lookRef.current;
      const width = e.type === "CO_CHANGES" ? 1 : look.edges[e.type]?.width ?? 0;
      const base = look.edges[e.type] ?? { color: C.muted };
      const mat = width
        ? new THREE.MeshBasicMaterial({ color: base.color, transparent: true, opacity: 0, depthWrite: false })
        : new THREE.LineBasicMaterial({ color: base.color, transparent: true, opacity: 0, depthWrite: false });
      vis.current.set(key, {
        mat,
        opacity: 0,
        t: { color: new THREE.Color(base.color), opacity: 0, particles: 0, particleColor: C.text, particleSpeed: 0.005 },
      });
      links.push({ key, e, ghost, source: e.source, target: e.target, curve: nth ? 0.18 * nth : 0, arrowAt: Math.max(0.5, 1 - tr / Math.max(1, len)) });
    };
    for (const e of edges) add(e, false);
    for (const e of ghostEdges ?? []) add(e, true);
    linksRef.current = links;

    const adj = new Map<string, Set<string>>();
    for (const l of links) {
      const s = endId(l.source),
        t = endId(l.target);
      if (!adj.has(s)) adj.set(s, new Set());
      if (!adj.has(t)) adj.set(t, new Set());
      adj.get(s)!.add(t);
      adj.get(t)!.add(s);
    }
    nbrs.current = adj;
    const c: Record<string, number> = {};
    for (const l of links) c[layerOf(l.e.type)] = (c[layerOf(l.e.type)] ?? 0) + 1;
    setCounts(c);
    if (selectedRef.current && !next.has(selectedRef.current)) api.current?.select(null, false);
    if (previewRef.current && !next.has(previewRef.current.impact.origin)) setPreview(null);

    const first = rigs.current.size === 0 && nodes.length > 0;
    if (first && !reduced.current) {
      // entrance: nodes light up from the centre outwards while the camera glides in
      let max = 1;
      for (const n of next.values()) max = Math.max(max, Math.hypot(n.x, n.y, n.z));
      entranceMax.current = max;
      entrance.current = performance.now();
    }
    for (const [id, rig] of rigs.current)
      if (!next.has(id)) {
        retire(rig);
        rigs.current.delete(id);
      }
    fg.graphData({ nodes: [...next.values()], links });
    api.current?.restyle();
    if (first) {
      const camera = fg.camera() as THREE.PerspectiveCamera;
      if (!reduced.current) {
        camera.position.set(RADIUS * 0.6, RADIUS * 1.4, RADIUS * 5.2);
        camera.lookAt(0, 0, 0);
      }
      requestAnimationFrame(() => api.current?.frame(null, 2000));
    }
    // fit to view whenever what's shown changes noticeably (not on every small timeline step)
    const was = fitted.current;
    fitted.current = { ns: layoutNs, n: next.size };
    if (!first && was && next.size && !propsRef.current.highlight?.length && (was.ns !== layoutNs || Math.abs(was.n - next.size) > Math.max(3, was.n * 0.05)))
      api.current?.frame(null, 600);
  }, [ready, data, layoutNs, nodeFilter, edgeFilter, nodeColor, nodeSize, ghostEdges]);

  // ---- restyle on highlight / diff / pulse changes, and frame the highlighted nodes
  const { highlight, diff, pulse, fitToHighlight, highlightColor, forceLabels, trail } = props;
  useEffect(() => {
    api.current?.restyle();
  }, [ready, diff, pulse, highlightColor, forceLabels]);

  // the answer owns the graph: the camera flies to its evidence and everything else steps back
  useEffect(() => {
    api.current?.restyle();
    if (!fitToHighlight || !api.current) return;
    if (highlight?.length) {
      api.current.select(null, false);
      api.current.frame(highlight, 600);
    } else if (rigs.current.size && entrance.current === null && !trail) api.current.frame(null, 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, highlight, fitToHighlight]);

  // the graph follows the agent: each finished tool call lights what it touched, walking outward from what the
  // call was about, 120 ms a hop; the camera keeps everything lit in view
  const trailKey = trail?.key ?? null;
  useEffect(() => {
    if (!ready || !api.current) return;
    if (!trail) {
      if (trailRef.current) {
        trailRef.current = null;
        trailStep.current = -1;
        api.current.restyle();
      }
      return;
    }
    const hops = trailHops(trail, nbrs.current);
    const prev = trailRef.current;
    trailRef.current = { hops, at: performance.now() };
    // nodes lit by earlier calls stay lit; the walk replays for the newest call
    const max = Math.max(0, ...hops.values());
    trailStep.current = prev ? Math.min(trailStep.current, 0) : -1;
    api.current.restyle();
    if (fitToHighlight) api.current.frame(trail.nodes, 600);
    if (reduced.current) {
      trailStep.current = max;
      api.current.restyle();
      return;
    }
    const timers = Array.from({ length: max + 1 }, (_, h) =>
      setTimeout(() => {
        trailStep.current = Math.max(trailStep.current, h);
        api.current?.restyle();
      }, 60 + h * 120),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, trailKey]);

  // a what-if opening: a shockwave rolls out from what was switched off, and each system flares as it goes down
  const lastReveal = useRef(-1);
  useEffect(() => {
    if (!ready || !api.current) return;
    if (!diff) {
      lastReveal.current = -1;
      return;
    }
    // the what-if's own map may still be loading: wait for it rather than spend the reveal on nothing
    if (!nodesById.current.size) return;
    const prev = lastReveal.current;
    lastReveal.current = diff.revealHops;
    if (diff.revealHops <= prev || !diff.broken.size) return;
    if (prev < 0) {
      const hit = new Set([...diff.broken.keys(), ...diff.orphans]);
      const origins = new Set<string>();
      for (const l of linksRef.current) {
        const s = endId(l.source),
          t = endId(l.target);
        const sg = nodesById.current.get(s)?.g,
          tg = nodesById.current.get(t)?.g;
        if (hit.has(s) && (tg?.retired || tg?.former)) origins.add(t);
        if (hit.has(t) && (sg?.retired || sg?.former)) origins.add(s);
      }
      for (const o of origins) api.current.shock(o, [...diff.broken.keys()], C.bad);
    }
    for (const [id, h] of diff.broken) if (h > prev && h <= diff.revealHops) api.current.shock(id, [], C.bad);
    // the map arriving after the reveal re-runs this, so the wave still plays once
  }, [ready, diff, data]);

  // "what if this stopped working?": the shockwave leaves the system, then what relies on it goes down a step at a time
  useEffect(() => {
    if (!preview) {
      if (previewRef.current && !previewRef.current.quiet) {
        previewRef.current = null;
        api.current?.restyle();
      }
      return;
    }
    const a = api.current;
    if (!a) return;
    previewRef.current = { impact: preview, reveal: 0 };
    window.dispatchEvent(new CustomEvent("orion:graph-story", { detail: true }));
    a.restyle();
    a.frame([preview.origin, ...preview.broken.keys(), ...preview.teams, ...preview.customers], 900);
    a.shock(preview.origin, [...preview.broken.keys()], C.ember, 250);
    const step = reduced.current ? 0 : 300;
    const timers = Array.from({ length: preview.maxHops + 1 }, (_, i) =>
      setTimeout(() => {
        const h = i + 1;
        if (!previewRef.current) return;
        previewRef.current.reveal = h;
        api.current?.restyle();
        for (const [id, hh] of preview.broken) if (hh === h) api.current?.shock(id, [], C.bad);
      }, (reduced.current ? 0 : 550) + i * step),
    );
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && setPreview(null);
    window.addEventListener("keydown", onKey);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener("keydown", onKey);
      window.dispatchEvent(new CustomEvent("orion:graph-story", { detail: false }));
    };
  }, [preview]);

  // the map becomes the answer: when an answer is about something stopping, what relies on it goes red a hop at
  // a time (120 ms a hop, the shockwave first), and the teams and customers it reaches light last
  const { story } = props;
  const storyKey = story?.key ?? null;
  useEffect(() => {
    const a = api.current;
    if (!ready || !a) return;
    if (!story) {
      if (previewRef.current?.quiet) {
        previewRef.current = null;
        a.restyle();
      }
      return;
    }
    const g = ctxRef.current;
    if (!g.nodes.some((n) => n.id === story.origin)) return;
    const impact = impactOf(story.origin, g.nodes, g.edges);
    previewRef.current = { impact, reveal: 0, quiet: true };
    a.restyle();
    a.shock(story.origin, [...impact.broken.keys()], C.bad, 200);
    const step = reduced.current ? 0 : 120;
    const timers = Array.from({ length: impact.maxHops + 2 }, (_, i) =>
      setTimeout(() => {
        const cur = previewRef.current;
        if (!cur?.quiet || cur.impact !== impact) return;
        cur.reveal = i + 1;
        api.current?.restyle();
      }, (reduced.current ? 0 : 420) + i * step),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, storyKey, data]);

  const startTour = () => {
    const g = ctxRef.current;
    if (!g.nodes.length) return;
    setPreview(null);
    api.current?.select(null, false);
    tourOn.current = true;
    setTour({ stops: tourOf(g.nodes, g.edges), i: 0 });
  };
  const endTour = () => {
    tourOn.current = false;
    setTour(null);
    api.current?.visit(null);
    api.current?.frame(null, 1000);
  };
  const stepTour = (d: number) => setTour((t) => (t ? { ...t, i: Math.max(0, Math.min(t.stops.length - 1, t.i + d)) } : t));

  // anything outside the canvas can start the tour (the Ask screen's guide does)
  useEffect(() => {
    const go = () => startTour();
    window.addEventListener("orion:tour", go);
    return () => window.removeEventListener("orion:tour", go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // the tour: fly to each stop, linger, move on; arrows step, Esc ends
  const tourIndex = tour?.i ?? -1;
  const tourLen = tour?.stops.length ?? 0;
  useEffect(() => {
    if (!tour || !api.current) return;
    const stop = tour.stops[tour.i];
    if (stop.id) api.current.visit(stop.id);
    else {
      api.current.visit(null);
      api.current.frame(null, 1400);
    }
    const last = tour.i === tour.stops.length - 1;
    const t = last ? undefined : setTimeout(() => stepTour(1), TOUR_MS);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") endTour();
      else if (ev.key === "ArrowRight") stepTour(1);
      else if (ev.key === "ArrowLeft") stepTour(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourIndex, tourLen]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("orion:graph-story", { detail: !!tour }));
  }, [tour !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.current?.layers();
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
    } catch {
      /* ignore */
    }
  }, [hidden]);

  const toggleSpin = () => {
    const next = !spinRef.current;
    spinRef.current = next;
    setSpin(next);
    const c = fgRef.current?.controls() as unknown as { autoRotate: boolean } | undefined;
    if (c) c.autoRotate = next && !selectedRef.current;
  };

  // ---- inspector for the selected node
  const inspector = useMemo(() => {
    if (!selected) return null;
    const n = nodesById.current.get(selected)?.g;
    if (!n) return null;
    const groups = new Map<string, { l: L3; other: GNode }[]>();
    for (const l of linksRef.current) {
      const s = endId(l.source),
        t = endId(l.target);
      if (s !== selected && t !== selected) continue;
      const other = nodesById.current.get(s === selected ? t : s)?.g;
      if (!other) continue;
      const label = relationFrom(l.e, selected);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push({ l, other });
    }
    return { n, groups: [...groups.entries()].sort((a, b) => b[1].length - a[1].length) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, data, nodeFilter, edgeFilter, ghostEdges]);

  const openEdge = (l: L3) => {
    const s = nodesById.current.get(endId(l.source))?.g;
    const t = nodesById.current.get(endId(l.target))?.g;
    props.onEdgeClick?.(l.e, s, t, ctxRef.current);
  };
  const hoverEdge = (key: string | null) => {
    hoverLink.current = key;
    api.current?.restyle();
  };

  const present = LAYERS.filter((l) => counts[l.id]);
  const tipStory = tip?.kind === "link" ? explainEdge(tip.l.e, tip.s, tip.t) : null;

  return (
    <div className={`relative h-full w-full overflow-hidden ${props.className ?? ""}`}>
      <div
        ref={host}
        tabIndex={0}
        role="img"
        aria-label={`${props.ariaLabel ?? "Company graph"}. 3D view: drag to rotate, scroll to zoom, click a node to focus it, click a connection to see what it means.`}
        className="graph-3d relative h-full w-full outline-none"
      />

      {/* hover card */}
      <div ref={tipRef} className="g3-tip" data-show={tip ? "" : undefined} aria-hidden>
        {tip?.kind === "node" && (
          <>
            <p className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-full" style={{ background: NODE_COLORS[tip.n.type] }} />
              <span className="font-medium text-ink">{nameOf(tip.n)}</span>
              <span className="text-faint">{nounOf(tip.n)}</span>
            </p>
            <p className="mt-1 text-muted">{describeNode(tip.n)}</p>
            <p className="mt-1.5 text-[11px] text-faint">Click to focus · drag to pull it around</p>
          </>
        )}
        {tipStory && tip?.kind === "link" && (
          <>
            <p className="flex items-center gap-2">
              <span className="h-[2px] w-3 shrink-0 rounded-full" style={{ background: EDGE_DOT[tip.l.e.type] ?? C.muted }} />
              <span className="text-ink">{tipStory.short}</span>
            </p>
            {tipStory.flag && (
              <p className={`mt-1.5 text-[11px] ${tipStory.flag.tone === "bad" ? "text-bad" : "text-warn"}`}>{tipStory.flag.text}</p>
            )}
            <p className="mt-1.5 text-[11px] text-faint">Click to see what this means and how we know</p>
          </>
        )}
      </div>

      {/* focused node */}
      <AnimatePresence>
        {inspector && (
          <motion.aside
            key={inspector.n.id}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="hud g3-inspector"
            aria-label={`${nameOf(inspector.n)} and its connections`}
          >
            <header className="flex items-start gap-3 border-b border-rule px-4 pb-3 pt-3.5">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-[11px] text-faint">
                  <span className="size-1.5 rounded-full" style={{ background: NODE_COLORS[inspector.n.type] }} />
                  {nounOf(inspector.n)}
                </p>
                <h3 className="heading mt-1 truncate text-[20px] leading-[1.05] text-ink">{nameOf(inspector.n)}</h3>
                <p className="mt-1 text-[12px] leading-snug text-muted">{describeNode(inspector.n)}</p>
                {inspector.n.type === "Service" && !inspector.n.retired && !props.diff && (
                  <button
                    type="button"
                    className="btn mt-2.5 h-7 gap-1.5 px-2.5 text-[12px]"
                    onClick={() => {
                      const g = ctxRef.current;
                      setTour(null);
                      tourOn.current = false;
                      api.current?.select(null, false);
                      setPreview(impactOf(inspector.n.id, g.nodes, g.edges));
                    }}
                  >
                    <span className="size-1.5 rounded-full bg-ember" aria-hidden />
                    What if this stopped working?
                  </button>
                )}
              </div>
              <button type="button" className="btn btn-ghost -mr-1.5 -mt-0.5 h-7 px-1.5" onClick={() => api.current?.select(null)} aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {inspector.groups.length === 0 && <p className="text-[12px] text-muted">No connections in this view.</p>}
              {inspector.groups.map(([label, items]) => (
                <section key={label} className="mb-3.5 last:mb-0">
                  <h4 className="mb-1.5 flex items-baseline gap-2 text-[11px] text-faint">
                    {label}
                    <span className="mono text-[11px]">{items.length}</span>
                  </h4>
                  <ul className="flex flex-wrap gap-1.5">
                    {items.map(({ l, other }) => (
                      <li key={l.key}>
                        <button
                          type="button"
                          onClick={() => openEdge(l)}
                          onMouseEnter={() => hoverEdge(l.key)}
                          onMouseLeave={() => hoverEdge(null)}
                          onFocus={() => hoverEdge(l.key)}
                          onBlur={() => hoverEdge(null)}
                          title={explainEdge(l.e, nodesById.current.get(endId(l.source))?.g, nodesById.current.get(endId(l.target))?.g).short}
                          className="flex max-w-[220px] items-center gap-1.5 rounded border border-rule bg-night/60 px-2 py-1 text-[11px] text-muted transition-colors hover:border-rule-strong hover:text-ink"
                        >
                          <span className="size-1.5 shrink-0 rounded-full" style={{ background: NODE_COLORS[other.type] }} />
                          <span className="truncate">{nameOf(other)}</span>
                          {l.e.declared === false && <span className="size-1.5 shrink-0 rounded-full bg-warn" title="Not in the official record" />}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <p className="border-t border-rule-soft px-4 py-2 text-[11px] text-faint">
              Click a connection to read what it means. <span className="mono">Esc</span> to close.
            </p>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* "what if this stopped working?" */}
      <div className="g3-story-slot">
      <AnimatePresence>
        {preview && (
          <motion.section
            key={preview.origin}
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="hud g3-story"
            aria-live="polite"
            aria-label="What would stop working"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-[11px] text-faint">
                  <span className="size-1.5 rounded-full bg-ember" aria-hidden />
                  A quick look, worked out from the map
                </p>
                <h3 className="heading mt-1 text-[20px] leading-[1.1] text-ink">
                  If {nameOf(nodesById.current.get(preview.origin)?.g)} stopped working
                </h3>
              </div>
              <CloseX onClick={() => setPreview(null)} label="Clear this" />
            </div>
            {preview.broken.size ? (
              <>
                <dl className="mt-3 grid grid-cols-3 gap-2">
                  <Stat n={preview.broken.size} label={preview.broken.size === 1 ? "system stops with it" : "systems stop with it"} tone="bad" delay={0.5} />
                  <Stat n={preview.teams.length} label={preview.teams.length === 1 ? "team pulled in" : "teams pulled in"} tone="warn" delay={0.5 + preview.maxHops * 0.3} />
                  <Stat n={preview.customers.length} label={preview.customers.length === 1 ? "customer notices" : "customers notice"} tone="warn" delay={0.5 + preview.maxHops * 0.3} />
                </dl>
                <ul className="mt-3 flex max-h-[76px] flex-wrap gap-1.5 overflow-y-auto">
                  {[...preview.broken.entries()]
                    .sort((a, b) => a[1] - b[1])
                    .map(([id, h], k) => (
                      <motion.li
                        key={id}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: reduced.current ? 0 : 0.55 + (h - 1) * 0.3 + k * 0.02, duration: 0.3 }}
                        className="flex items-center gap-1.5 rounded border border-rule bg-night/60 px-2 py-0.5 text-[11px] text-muted"
                        title={h === 1 ? "Relies on it directly" : `${h} steps away`}
                      >
                        <span className="size-1.5 rounded-full bg-bad" aria-hidden />
                        {nameOf(nodesById.current.get(id)?.g)}
                      </motion.li>
                    ))}
                </ul>
              </>
            ) : (
              <p className="mt-2 text-[13px] leading-relaxed text-muted">
                Nothing else on the map relies on it, so no other system would stop with it.
              </p>
            )}
            <div className="mt-3.5 flex items-center gap-2">
              <Link
                href={`/multiverse?try=${encodeURIComponent(nameOf(nodesById.current.get(preview.origin)?.g))}`}
                className="btn btn-primary h-8"
                onClick={() => setPreview(null)}
              >
                Test it properly
              </Link>
              <span className="text-[11px] leading-snug text-faint">See the risk, every customer affected and who has to agree.</span>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
      </div>

      {/* the guided tour */}
      <div className="g3-story-slot">
      <AnimatePresence>
        {tour && (
          <motion.section
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="hud g3-story"
            aria-live="polite"
            aria-label="Guided tour of the company"
          >
            <div className="flex items-center gap-3">
              <p className="text-[11px] text-faint">
                Tour · {tour.i + 1} of {tour.stops.length}
              </p>
              <div className="flex flex-1 gap-1" aria-hidden>
                {tour.stops.map((_, k) => (
                  <span key={k} className="h-[3px] flex-1 overflow-hidden rounded-full bg-rule">
                    {k < tour.i && <span className="block h-full w-full bg-ink/70" />}
                    {k === tour.i && (
                      <motion.span
                        key={tour.i}
                        className="block h-full bg-ember"
                        initial={{ width: k === tour.stops.length - 1 ? "100%" : "0%" }}
                        animate={{ width: "100%" }}
                        transition={{ duration: k === tour.stops.length - 1 ? 0 : TOUR_MS / 1000, ease: "linear" }}
                      />
                    )}
                  </span>
                ))}
              </div>
              <CloseX onClick={endTour} label="End the tour" />
            </div>
            <AnimatePresence mode="wait">
              <motion.div
                key={tour.i}
                initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                <h3 className="heading mt-2 text-[20px] leading-[1.08] text-ink">{tour.stops[tour.i].title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{tour.stops[tour.i].body}</p>
              </motion.div>
            </AnimatePresence>
            <div className="mt-3.5 flex items-center gap-2">
              <button type="button" className="btn btn-ghost h-8 px-2.5" onClick={() => stepTour(-1)} disabled={tour.i === 0}>
                Back
              </button>
              {tour.i < tour.stops.length - 1 ? (
                <button type="button" className="btn btn-primary h-8" onClick={() => stepTour(1)}>
                  Next
                </button>
              ) : (
                <button type="button" className="btn btn-primary h-8" onClick={endTour}>
                  Explore on my own
                </button>
              )}
              <span className="ml-auto hidden text-[11px] text-faint sm:inline">
                <span className="mono">← →</span> to step · <span className="mono">Esc</span> to end
              </span>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
      </div>

      {/* connection layers */}
      <AnimatePresence>
        {layersOpen && present.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="hud g3-layers"
            role="group"
            aria-label="Show or hide kinds of connection"
          >
            <p className="px-3 pb-1.5 pt-2.5 text-[11px] text-faint">Connections</p>
            <ul className="pb-1.5">
              {present.map((l) => {
                const on = !hidden.has(l.id);
                return (
                  <li key={l.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setHidden((h) => {
                          const n = new Set(h);
                          if (n.has(l.id)) n.delete(l.id);
                          else n.add(l.id);
                          return n;
                        })
                      }
                      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-raised"
                    >
                      <span
                        className="h-[3px] w-4 shrink-0 rounded-full transition-opacity"
                        style={{ background: EDGE_DOT[l.types[0]] ?? C.muted, opacity: on ? 1 : 0.25 }}
                      />
                      <span className={`flex-1 ${on ? "text-ink" : "text-faint line-through decoration-faint/60"}`}>{l.label}</span>
                      <span className="mono text-[11px] text-faint">{counts[l.id]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="zoom-controls" role="group" aria-label="View">
        {!props.diff && (
          <button type="button" onClick={() => (tour ? endTour() : startTour())} aria-pressed={!!tour} aria-label={tour ? "End the tour" : "Take a guided tour"} title={tour ? "End the tour" : "Take a guided tour"} data-on={tour ? "" : undefined}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden><path d="M6 1.2 7.3 4.6l3.5.3-2.7 2.3.9 3.5L6 8.8 3 10.7l.9-3.5L1.2 4.9l3.5-.3L6 1.2Z" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" /></svg>
          </button>
        )}
        <button type="button" onClick={() => api.current?.zoom(0.7)} aria-label="Zoom in">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <button type="button" onClick={() => api.current?.zoom(1.4)} aria-label="Zoom out">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M1.5 6h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <button type="button" onClick={() => { api.current?.select(null, false); api.current?.frame(null, 800); }} aria-label="Fit everything in view">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden><path d="M1.5 4.5v-3h3M10.5 4.5v-3h-3M1.5 7.5v3h3M10.5 7.5v3h-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button type="button" onClick={toggleSpin} aria-pressed={spin} aria-label={spin ? "Stop rotating" : "Rotate slowly"} title={spin ? "Stop rotating" : "Rotate slowly"}>
          {spin ? (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M4 2.5v7M8 2.5v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden><path d="M10 6a4 4 0 1 1-1.2-2.85M10 1.8v1.9H8.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          )}
        </button>
        {present.length > 1 && (
          <button type="button" onClick={() => setLayersOpen((o) => !o)} aria-expanded={layersOpen} aria-label="Kinds of connection" title="Kinds of connection" data-on={hidden.size ? "" : undefined}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden><path d="M7 1.8 12.5 4.6 7 7.4 1.5 4.6 7 1.8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="m1.5 7.2 5.5 2.8 5.5-2.8M1.5 9.8 7 12.6l5.5-2.8" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
          </button>
        )}
        <button type="button" onClick={() => setGraphMode("2d")} aria-label="Switch to the flat 2D view" title="Switch to 2D" className="mono !text-[11px] font-semibold">
          2D
        </button>
      </div>
    </div>
  );
}

function CloseX({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="btn btn-ghost -mr-1.5 -mt-0.5 h-7 shrink-0 px-1.5" onClick={onClick} aria-label={label} title={label}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** A number that counts up once it is due, so the totals land with the shockwave instead of before it. */
function Stat({ n, label, tone, delay }: { n: number; label: string; tone: "bad" | "warn"; delay: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(n);
      return;
    }
    let raf = 0;
    const start = performance.now() + delay * 1000;
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / 700));
      setShown(Math.round(n * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [n, delay]);
  return (
    <div className="rounded-lg border border-rule bg-night/50 px-2.5 py-2">
      <dt className="sr-only">{label}</dt>
      <dd className={`heading text-[28px] leading-none tabular-nums ${n === 0 ? "text-faint" : tone === "bad" ? "text-bad" : "text-warn"}`}>{shown}</dd>
      <dd className="mt-1 text-[11px] leading-tight text-muted">{label}</dd>
    </div>
  );
}
