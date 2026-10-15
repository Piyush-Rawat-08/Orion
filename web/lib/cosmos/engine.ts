// The sky renderer. One Cosmos per canvas: the company's galaxy (data from /galaxy), with effects layered on top
// for what the graph says: blast radii travelling hop by hop, a retired service collapsing into a black hole,
// constellations drawn from collaboration, the path behind an answer, and a hyperspace jump between universes.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { EFFECT_COLOR, hash01, teamColor } from "@/lib/palette";
import type { Effect, Galaxy } from "@/lib/types";
import { formerPos, Kind, place, R_ARM, R_CORE, R_HALO, TEAM_ORDER, teamPos, TWIST } from "./layout";
import * as S from "./shaders";

const KIND_CODE: Record<Kind, number> = { service: 0, person: 1, customer: 2, retired: 3, former: 4, team: 5 };

export type NodeInfo = {
  id: string;
  kind: Kind;
  label: string;
  team: string | null;
  color: string;
  meta: Record<string, unknown>;
};

type Node = NodeInfo & {
  pos: THREE.Vector3;
  to: THREE.Vector3;
  base: THREE.Color;
  col: THREE.Color;
  colTo: THREE.Color;
  size: number;
  sizeTo: number;
  alpha: number;
  alphaTo: number;
  flare: number;
  flareTo: number;
  phase: number;
  dying: boolean;
};

type Ring = { mesh: THREE.Mesh; start: number; dur: number; scale: number };
type Trail = { lines: THREE.LineSegments; start: number; dur: number; keep: boolean };
type Scheduled = { at: number; run: () => void };

export type Options = { reducedMotion?: boolean; autoRotate?: boolean; showCustomers?: boolean; quality?: "high" | "low" };

/** Seconds since start and since the last frame (THREE.Clock is deprecated). */
class Clock {
  private t0 = performance.now();
  private last = this.t0;
  elapsedTime = 0;
  getDelta() {
    const now = performance.now();
    const d = (now - this.last) / 1000;
    this.last = now;
    this.elapsedTime = (now - this.t0) / 1000;
    return d;
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);

export class Cosmos {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private lens: ShaderPass;
  private warpPass: ShaderPass;
  private clock = new Clock();
  private raf = 0;
  private disposed = false;
  private labels: HTMLDivElement;
  private labelEls = new Map<string, HTMLDivElement>();

  private nodes = new Map<string, Node>();
  private order: string[] = [];
  private stars!: THREE.Points;
  private starMat: THREE.ShaderMaterial;
  private links: THREE.LineSegments | null = null;
  private linkMat: THREE.ShaderMaterial;
  private constellation: THREE.LineSegments | null = null;
  private constMat: THREE.ShaderMaterial;
  private extra: THREE.LineSegments | null = null;
  private extraMat: THREE.ShaderMaterial;
  private skyMat: THREE.ShaderMaterial;
  private dustMat: THREE.ShaderMaterial;
  private nebulae: THREE.Mesh[] = [];
  private rings: Ring[] = [];
  private trails: Trail[] = [];
  private schedule: Scheduled[] = [];
  private hole: THREE.Group | null = null;
  private holeId: string | null = null;
  private holeMats: THREE.ShaderMaterial[] = [];

  private data: Galaxy | null = null;
  private focus: Set<string> | null = null;
  private effects = new Map<string, Effect>();
  private hover: string | null = null;
  private selected: string | null = null;
  private constellationTeam: string | "all" | null = "all";
  private knowsFor: string | null = null;
  private evidence: string[] = [];
  private moving = false;
  private flight: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; start: number; dur: number } | null = null;
  private warpT: { start: number; dur: number } | null = null;
  private pointer = { x: 0, y: 0, down: 0, downX: 0, downY: 0, inside: false };

  onHover: (n: NodeInfo | null, x: number, y: number) => void = () => {};
  onSelect: (n: NodeInfo | null) => void = () => {};

  constructor(private host: HTMLDivElement, private opts: Options = {}) {
    const w = host.clientWidth || 800;
    const h = host.clientHeight || 600;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.quality === "low" ? 1 : 1.5));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x020308, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.style.display = "block";
    host.appendChild(this.renderer.domElement);

    this.labels = document.createElement("div");
    this.labels.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;";
    host.appendChild(this.labels);

    this.camera = new THREE.PerspectiveCamera(52, w / h, 0.5, 4000);
    this.camera.position.set(0, 125, 205);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 560;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.7;
    this.controls.autoRotate = opts.autoRotate !== false && !opts.reducedMotion;
    this.controls.autoRotateSpeed = 0.18;
    this.controls.maxPolarAngle = Math.PI * 0.86;

    const px = this.renderer.getPixelRatio();
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: S.STAR_VERT, fragmentShader: S.STAR_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, uniforms: { uTime: { value: 0 }, uPx: { value: px } },
    });
    const linkUniforms = () => ({ uTime: { value: 0 }, uReveal: { value: 1 } });
    const linkMat = () => new THREE.ShaderMaterial({
      vertexShader: S.LINK_VERT, fragmentShader: S.LINK_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, uniforms: linkUniforms(),
    });
    this.linkMat = linkMat();
    this.constMat = linkMat();
    this.extraMat = linkMat();
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: S.SKY_VERT, fragmentShader: S.SKY_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, uniforms: { uTime: { value: 0 }, uPx: { value: px }, uWarp: { value: 0 } },
    });
    this.dustMat = new THREE.ShaderMaterial({
      vertexShader: S.DUST_VERT, fragmentShader: S.DUST_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, uniforms: { uTime: { value: 0 }, uPx: { value: px }, uFade: { value: 1 } },
    });

    this.buildSky();
    this.buildGalaxy();
    this.rebuildStars();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.8, 0.5, 0.22);
    this.composer.addPass(this.bloom);
    this.lens = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uRadius: { value: 0.05 },
                  uStrength: { value: 0 }, uAspect: { value: w / h } },
      vertexShader: S.PASS_VERT, fragmentShader: S.LENS_FRAG,
    });
    this.composer.addPass(this.lens);
    this.warpPass = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uStrength: { value: 0 } }, vertexShader: S.PASS_VERT, fragmentShader: S.WARP_FRAG,
    });
    this.composer.addPass(this.warpPass);
    this.composer.addPass(new OutputPass());

    const el = this.renderer.domElement;
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointerleave", this.onLeave);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.loop();
  }

  private resizeObs: ResizeObserver;

  // ---------------------------------------------------------------- static scenery

  private buildSky() {
    const n = this.opts.quality === "low" ? 2500 : 5200;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    const tints = [new THREE.Color("#cfd9ff"), new THREE.Color("#fff4e6"), new THREE.Color("#ffd9b0"), new THREE.Color("#ffffff")];
    let seed = 20261015;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const r = 1400 + rnd() * 600;
      const s = Math.sqrt(1 - u * u);
      pos.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3);
      const c = tints[Math.floor(rnd() * tints.length)];
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = rnd() < 0.03 ? 3.2 + rnd() * 2 : 0.8 + rnd() * 1.4;
      phase[i] = rnd();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    g.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
    const pts = new THREE.Points(g, this.skyMat);
    pts.frustumCulled = false;
    this.scene.add(pts);
  }

  private buildGalaxy() {
    // dust along six arms, a bright bulge, and a nebula over each team's arm
    const n = this.opts.quality === "low" ? 9000 : 24000;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    const warm = new THREE.Color("#ffe3c2");
    const white = new THREE.Color("#e8ecff");
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    for (let i = 0; i < n; i++) {
      const bulge = rnd() < 0.22;
      let x: number, y: number, z: number;
      let c: THREE.Color;
      if (bulge) {
        const r = Math.pow(rnd(), 1.8) * (R_CORE * 2.2);
        const a = rnd() * Math.PI * 2;
        x = r * Math.cos(a);
        z = r * Math.sin(a);
        y = gauss() * (7 - r * 0.15);
        c = warm.clone().lerp(white, rnd() * 0.3);
      } else {
        const k = Math.floor(rnd() * TEAM_ORDER.length);
        const t = Math.pow(rnd(), 0.75) * 1.08;
        const base = (k / TEAM_ORDER.length) * Math.PI * 2;
        const r = R_CORE + (R_ARM - R_CORE) * t;
        const a = base + TWIST * t + gauss() * 0.16;
        const spread = 4 + t * 14;
        x = r * Math.cos(a) + gauss() * spread;
        z = r * Math.sin(a) + gauss() * spread;
        y = gauss() * (2.5 + t * 3);
        c = new THREE.Color(teamColor(TEAM_ORDER[k])).lerp(white, 0.45 + rnd() * 0.4);
      }
      pos.set([x, y, z], i * 3);
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = bulge ? 0.5 + rnd() * 0.9 : 0.35 + rnd() * 0.75;
      phase[i] = rnd();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    g.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
    const dust = new THREE.Points(g, this.dustMat);
    dust.frustumCulled = false;
    this.scene.add(dust);

    // the core: one big warm glow
    const core = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: S.NEBULA_VERT,
        fragmentShader: /* glsl */ `varying vec2 vUv; void main(){ float d = length(vUv*2.0-1.0);
          float a = exp(-d*d*16.0)*0.75 + exp(-d*d*4.0)*0.12; gl_FragColor = vec4(vec3(1.0,0.82,0.6), a); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    core.scale.setScalar(40);
    core.userData.billboard = true;
    this.scene.add(core);
    this.nebulae.push(core);

    TEAM_ORDER.forEach((team, k) => {
      for (let j = 0; j < 3; j++) {
        const t = 0.32 + j * 0.24;
        const base = (k / TEAM_ORDER.length) * Math.PI * 2;
        const r = R_CORE + (R_ARM - R_CORE) * t;
        const a = base + TWIST * t;
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.ShaderMaterial({
            vertexShader: S.NEBULA_VERT, fragmentShader: S.NEBULA_FRAG, transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: { uColor: { value: new THREE.Color(teamColor(team)) }, uTime: { value: 0 },
                        uSeed: { value: k * 3.1 + j * 1.7 }, uAlpha: { value: 0.16 } },
          }),
        );
        m.position.set(r * Math.cos(a), (j - 1) * 3, r * Math.sin(a));
        m.scale.setScalar(46 + j * 10);
        m.userData.billboard = true;
        m.userData.team = team;
        this.scene.add(m);
        this.nebulae.push(m);
      }
    });
  }

  // ---------------------------------------------------------------- data

  setData(g: Galaxy, opts: { animate?: boolean } = {}) {
    const animate = opts.animate !== false && !this.opts.reducedMotion;
    this.data = g;
    const placed = place(g);
    const seen = new Set<string>();
    const label = new Map<string, { label: string; team: string | null; meta: Record<string, unknown>; size: number }>();
    for (const t of g.teams) label.set(t.id, { label: t.label, team: t.id, meta: t, size: 7 + t.size * 0.25 });
    for (const s of g.services)
      label.set(s.id, { label: s.label, team: s.team, meta: s, size: (s.tier === 1 ? 6.5 : s.tier === 2 ? 5 : 3.8) + s.rank * 60 });
    for (const s of g.retired) label.set(s.id, { label: s.label, team: s.team, meta: s, size: 5.5 });
    for (const p of g.people) label.set(p.id, { label: p.label, team: p.team, meta: p, size: 2.3 + Math.min(2.2, p.between * 0.08) });
    for (const p of g.former) label.set(p.id, { label: p.label, team: null, meta: p, size: 2.1 });
    for (const c of g.customers)
      label.set(c.id, { label: c.label, team: null, meta: c, size: c.tier === "enterprise" ? 4.4 : c.tier === "growth" ? 3.4 : 2.6 });

    for (const p of placed) {
      if (p.kind === "customer" && this.opts.showCustomers === false) continue;
      seen.add(p.id);
      const info = label.get(p.id)!;
      const color = p.kind === "customer" ? "#d9d2c3" : p.kind === "retired" ? "#ff7a52" : p.kind === "former" ? "#8b90a0" : teamColor(info.team);
      const alpha = p.kind === "team" ? 0 : p.kind === "former" ? 0.45 : p.kind === "customer" ? 0.8 : 1;
      const prev = this.nodes.get(p.id);
      const to = new THREE.Vector3(p.x, p.y, p.z);
      if (prev) {
        prev.kind = p.kind;
        prev.label = info.label;
        prev.team = info.team;
        prev.meta = info.meta;
        prev.color = color;
        prev.base.set(color);
        prev.to.copy(to);
        prev.sizeTo = info.size;
        prev.alphaTo = alpha;
        prev.dying = false;
        if (!animate) {
          prev.pos.copy(to);
          prev.size = info.size;
        }
      } else {
        const start = animate ? to.clone().multiplyScalar(0.98) : to.clone();
        this.nodes.set(p.id, {
          id: p.id, kind: p.kind, label: info.label, team: info.team, color, meta: info.meta,
          pos: start, to, base: new THREE.Color(color), col: new THREE.Color(color), colTo: new THREE.Color(color),
          size: animate ? 0 : info.size, sizeTo: info.size, alpha: animate ? 0 : alpha, alphaTo: alpha,
          flare: animate ? 1.4 : 0, flareTo: 0, phase: hash01(p.id, 99), dying: false,
        });
        if (animate && this.order.length) this.ring(to, color, 14, 1.6);
      }
    }
    for (const [id, n] of this.nodes) {
      if (!seen.has(id) && !n.dying) {
        n.dying = true;
        n.sizeTo = 0;
        n.alphaTo = 0;
        if (animate) this.ring(n.pos.clone(), "#ff6a3d", 12, 1.3);
      }
    }
    this.rebuildStars();
    this.moving = true;
    this.rebuildLinks();
    this.applyStyle();
  }

  private rebuildStars() {
    this.order = [...this.nodes.keys()];
    const n = this.order.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("size", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("kind", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("phase", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("flare", new THREE.BufferAttribute(new Float32Array(n), 1));
    if (this.stars) {
      this.scene.remove(this.stars);
      this.stars.geometry.dispose();
    }
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  // ---------------------------------------------------------------- links

  private curve(a: THREE.Vector3, b: THREE.Vector3, lift: number): THREE.QuadraticBezierCurve3 {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const d = a.distanceTo(b);
    mid.multiplyScalar(0.82);
    mid.y += d * lift;
    return new THREE.QuadraticBezierCurve3(a, mid, b);
  }

  private segs(
    items: { a: THREE.Vector3; b: THREE.Vector3; color: THREE.Color; speed: number; strength: number; dash: number; lift: number; straight?: boolean }[],
    steps = 26,
  ): THREE.BufferGeometry {
    const total = items.length * steps * 2;
    const pos = new Float32Array(total * 3);
    const t = new Float32Array(total);
    const col = new Float32Array(total * 3);
    const speed = new Float32Array(total);
    const strength = new Float32Array(total);
    const dash = new Float32Array(total);
    let i = 0;
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    for (const it of items) {
      const c = it.straight ? null : this.curve(it.a, it.b, it.lift);
      for (let s = 0; s < steps; s++) {
        const u0 = s / steps;
        const u1 = (s + 1) / steps;
        if (c) {
          c.getPoint(u0, p0);
          c.getPoint(u1, p1);
        } else {
          p0.lerpVectors(it.a, it.b, u0);
          p1.lerpVectors(it.a, it.b, u1);
        }
        for (const [p, u] of [[p0, u0], [p1, u1]] as const) {
          pos.set([p.x, p.y, p.z], i * 3);
          t[i] = u;
          col.set([it.color.r, it.color.g, it.color.b], i * 3);
          speed[i] = it.speed;
          strength[i] = it.strength;
          dash[i] = it.dash;
          i++;
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("t", new THREE.BufferAttribute(t, 1));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("speed", new THREE.BufferAttribute(speed, 1));
    g.setAttribute("strength", new THREE.BufferAttribute(strength, 1));
    g.setAttribute("dash", new THREE.BufferAttribute(dash, 1));
    return g;
  }

  private rebuildLinks() {
    const g = this.data;
    if (!g) return;
    const white = new THREE.Color("#ffffff");
    const deps = g.deps
      .map((d) => {
        const a = this.nodes.get(d.source);
        const b = this.nodes.get(d.target);
        if (!a || !b) return null;
        const hot = this.focus ? this.focus.has(d.source) && this.focus.has(d.target) : true;
        const eff = this.effects.get(d.source);
        let color = new THREE.Color(teamColor(a.team)).lerp(white, 0.35);
        let strength = hot ? (this.focus ? 0.95 : 0.42) : 0.08;
        if (d.dangling) {
          color = new THREE.Color("#ff4d2e");
          strength = 1.3;
        } else if (eff && (this.effects.has(d.target) || this.holeId === d.target)) {
          color = new THREE.Color(EFFECT_COLOR[eff]);
          strength = 1.25;
        } else if (this.effects.size) {
          strength *= 0.35;
        }
        return {
          a: a.pos, b: b.pos, color, strength, lift: 0.16,
          speed: d.dangling ? 0.9 : d.kind === "sync" ? 0.32 : d.kind === "async" ? 0.17 : 0.09,
          dash: d.kind === "sync" ? 0 : d.kind === "async" ? 1 : 2,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (this.links) {
      this.scene.remove(this.links);
      this.links.geometry.dispose();
    }
    this.links = new THREE.LineSegments(this.segs(deps), this.linkMat);
    this.links.frustumCulled = false;
    this.scene.add(this.links);

    // constellations: the strongest collaboration ties (minimum spanning forest), per team or all
    const cons = (g.constellations ?? [])
      .map((e) => {
        const a = this.nodes.get(e.a);
        const b = this.nodes.get(e.b);
        if (!a || !b || a.kind !== "person" || b.kind !== "person") return null;
        const team = a.team === b.team ? a.team : null;
        const show = this.constellationTeam === "all" || (this.constellationTeam && (a.team === this.constellationTeam || b.team === this.constellationTeam));
        if (!show) return null;
        const hidden = !team;
        return {
          a: a.pos, b: b.pos, straight: true, lift: 0, dash: hidden ? 1 : 0, speed: 0.05,
          color: hidden ? new THREE.Color("#ffb547") : new THREE.Color(teamColor(team)).lerp(white, 0.5),
          strength: this.focus ? (this.focus.has(a.id) || this.focus.has(b.id) ? 0.8 : 0.08) : hidden ? 0.7 : 0.38,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (this.constellation) {
      this.scene.remove(this.constellation);
      this.constellation.geometry.dispose();
    }
    this.constellation = new THREE.LineSegments(this.segs(cons, 2), this.constMat);
    this.constellation.frustumCulled = false;
    this.scene.add(this.constellation);

    // knowledge and usage lines for the focused entity, and the evidence path of an answer
    const extra: Parameters<Cosmos["segs"]>[0] = [];
    if (this.knowsFor) {
      for (const k of g.knows) {
        if (k.source !== this.knowsFor && k.target !== this.knowsFor) continue;
        const a = this.nodes.get(k.source);
        const b = this.nodes.get(k.target);
        if (a && b) extra.push({ a: a.pos, b: b.pos, color: new THREE.Color("#ffb547"), speed: 0.25, strength: 0.9, dash: 0, lift: 0.08 });
      }
      for (const u of g.uses) {
        if (u.source !== this.knowsFor && u.target !== this.knowsFor) continue;
        const a = this.nodes.get(u.source);
        const b = this.nodes.get(u.target);
        if (a && b) extra.push({ a: a.pos, b: b.pos, color: new THREE.Color("#d9d2c3"), speed: 0.12, strength: 0.5, dash: 1, lift: 0.05 });
      }
    }
    for (let i = 0; i + 1 < this.evidence.length; i++) {
      const a = this.nodes.get(this.evidence[i]);
      const b = this.nodes.get(this.evidence[i + 1]);
      if (a && b) extra.push({ a: a.pos, b: b.pos, color: new THREE.Color("#ffb547"), speed: 0.4, strength: 1.2, dash: 0, lift: 0.1 });
    }
    if (this.extra) {
      this.scene.remove(this.extra);
      this.extra.geometry.dispose();
    }
    this.extra = new THREE.LineSegments(this.segs(extra), this.extraMat);
    this.extra.frustumCulled = false;
    this.scene.add(this.extra);
  }

  // ---------------------------------------------------------------- styling

  private applyStyle() {
    for (const n of this.nodes.values()) {
      if (n.dying) continue;
      const eff = this.effects.get(n.id);
      if (eff) n.colTo.set(EFFECT_COLOR[eff]);
      else n.colTo.copy(n.base);
      const dim = this.focus && !this.focus.has(n.id) && !eff;
      const baseAlpha = n.kind === "team" ? 0 : n.kind === "former" ? 0.45 : n.kind === "customer" ? 0.8 : 1;
      n.alphaTo = this.holeId === n.id ? 0 : dim ? baseAlpha * 0.16 : baseAlpha;
      n.flareTo = this.selected === n.id ? 0.55 : this.hover === n.id ? 0.4 : eff === "break" ? 0.5 : 0;
    }
    for (const m of this.nebulae) {
      const team = m.userData.team as string | undefined;
      const mat = m.material as THREE.ShaderMaterial;
      if (!team || !mat.uniforms.uAlpha) continue;
      const dim = this.focus || this.effects.size ? 0.06 : 0.16;
      mat.uniforms.uAlpha.value = this.constellationTeam === team ? 0.28 : dim;
    }
  }

  setFocus(ids: string[] | null) {
    this.focus = ids && ids.length ? new Set(ids) : null;
    this.applyStyle();
    this.rebuildLinks();
  }

  setEffects(effects: Record<string, Effect> | null) {
    this.effects = new Map(Object.entries(effects ?? {}));
    this.applyStyle();
    this.rebuildLinks();
  }

  setConstellations(team: string | "all" | null) {
    this.constellationTeam = team;
    this.constMat.uniforms.uReveal.value = 0;
    this.applyStyle();
    this.rebuildLinks();
  }

  setKnowsFor(id: string | null) {
    this.knowsFor = id;
    this.extraMat.uniforms.uReveal.value = 0;
    this.rebuildLinks();
  }

  /** Draw the path behind an answer: the cited entities, joined in order. */
  setEvidence(ids: string[]) {
    this.evidence = ids.filter((id) => this.nodes.has(id));
    this.extraMat.uniforms.uReveal.value = 0;
    this.rebuildLinks();
    this.evidence.forEach((id, i) => this.later(i * 180, () => this.flash(id, "#ffb547")));
  }

  select(id: string | null, fly = true) {
    this.selected = id;
    this.applyStyle();
    if (id && fly) this.flyTo(id);
  }

  // ---------------------------------------------------------------- effects

  private ring(at: THREE.Vector3, color: string, scale: number, dur: number) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: S.RING_VERT, fragmentShader: S.RING_FRAG, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uColor: { value: new THREE.Color(color) }, uProgress: { value: 0 } },
      }),
    );
    m.position.copy(at);
    m.rotation.x = -Math.PI / 2;
    m.scale.setScalar(scale * 2);
    this.scene.add(m);
    this.rings.push({ mesh: m, start: this.clock.elapsedTime, dur, scale });
  }

  flash(id: string, color = "#ffffff") {
    const n = this.nodes.get(id);
    if (!n) return;
    n.flare = 2.2;
    this.ring(n.pos.clone(), color, 9, 1.1);
  }

  private later(ms: number, run: () => void) {
    this.schedule.push({ at: this.clock.elapsedTime + ms / 1000, run });
  }

  /** The blast radius, travelling out from the roots one hop at a time along the dependency paths. */
  blast(roots: string[], hits: { uid: string; effect: Effect; depth: number; path: string[] }[], opts: { hop?: number } = {}) {
    const hop = opts.hop ?? 750;
    this.effects = new Map();
    this.applyStyle();
    this.rebuildLinks();
    for (const r of roots) {
      const n = this.nodes.get(r);
      if (!n) continue;
      this.ring(n.pos.clone(), "#ff4d2e", 26, 2.2);
      this.later(120, () => this.ring(n.pos.clone(), "#ffb547", 40, 2.8));
    }
    const sorted = [...hits].sort((a, b) => a.depth - b.depth);
    for (const h of sorted) {
      this.later(h.depth * hop, () => {
        const path = h.path.slice().reverse(); // root first
        const pts = path.map((u) => this.nodes.get(u)?.pos).filter((p): p is THREE.Vector3 => !!p);
        if (pts.length >= 2) this.trail(pts.slice(-2), EFFECT_COLOR[h.effect], hop / 1000);
        this.effects.set(h.uid, h.effect);
        const n = this.nodes.get(h.uid);
        if (n) {
          n.flare = 2.6;
          this.ring(n.pos.clone(), EFFECT_COLOR[h.effect], h.effect === "break" ? 16 : 11, 1.5);
        }
        this.applyStyle();
      });
    }
    const end = (sorted.at(-1)?.depth ?? 0) * hop + 400;
    this.later(end, () => this.rebuildLinks());
  }

  private trail(pts: THREE.Vector3[], color: string, dur: number) {
    const items = [];
    for (let i = 0; i + 1 < pts.length; i++)
      items.push({ a: pts[i], b: pts[i + 1], color: new THREE.Color(color), speed: 1.2, strength: 1.6, dash: 0, lift: 0.16 });
    const mat = new THREE.ShaderMaterial({
      vertexShader: S.LINK_VERT, fragmentShader: S.LINK_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, uniforms: { uTime: { value: 0 }, uReveal: { value: 0 } },
    });
    const lines = new THREE.LineSegments(this.segs(items, 40), mat);
    lines.frustumCulled = false;
    this.scene.add(lines);
    this.trails.push({ lines, start: this.clock.elapsedTime, dur: Math.max(0.35, dur), keep: true });
  }

  clearBlast() {
    for (const t of this.trails) {
      this.scene.remove(t.lines);
      t.lines.geometry.dispose();
    }
    this.trails = [];
    this.schedule = [];
    this.setEffects(null);
  }

  /** A retired or failing service collapses into a black hole: accretion disk, photon ring, lensing. */
  blackHole(id: string | null) {
    if (this.hole) {
      this.scene.remove(this.hole);
      this.hole = null;
      this.holeMats = [];
      this.lens.uniforms.uStrength.value = 0;
    }
    this.holeId = id;
    this.applyStyle();
    const n = id ? this.nodes.get(id) : null;
    if (!n) return;
    const group = new THREE.Group();
    group.position.copy(n.pos);
    const shadow = new THREE.Mesh(new THREE.SphereGeometry(2.6, 32, 32), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    group.add(shadow);
    const diskMat = new THREE.ShaderMaterial({
      vertexShader: S.NEBULA_VERT, fragmentShader: S.DISK_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { uTime: { value: 0 }, uIn: { value: 0.28 } },
    });
    const disk = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), diskMat);
    disk.rotation.x = -Math.PI / 2 + 0.32;
    group.add(disk);
    const photonMat = new THREE.ShaderMaterial({
      vertexShader: S.NEBULA_VERT, fragmentShader: S.PHOTON_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, uniforms: { uTime: { value: 0 } },
    });
    const photon = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), photonMat);
    photon.userData.billboard = true;
    group.add(photon);
    group.scale.setScalar(0.01);
    group.userData.born = this.clock.elapsedTime;
    this.scene.add(group);
    this.hole = group;
    this.holeMats = [diskMat, photonMat];
    this.ring(n.pos.clone(), "#ff4d2e", 30, 2.6);
  }

  /** Hyperspace: stars stretch into streaks, the view punches in, and settles. */
  warp(ms = 1600) {
    if (this.opts.reducedMotion) return;
    this.warpT = { start: this.clock.elapsedTime, dur: ms / 1000 };
  }

  flyTo(target: string | [number, number, number], dist?: number) {
    let p: THREE.Vector3;
    let kind: Kind | null = null;
    if (typeof target === "string") {
      const n = this.nodes.get(target);
      if (!n) return;
      p = n.to.clone();
      kind = n.kind;
    } else p = new THREE.Vector3(...target);
    const d = dist ?? (kind === "team" ? 85 : kind === "customer" ? 70 : 55);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    dir.y = Math.max(dir.y, 0.35);
    dir.normalize();
    const to = p.clone().add(dir.multiplyScalar(d));
    this.flight = { from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo: p, start: this.clock.elapsedTime,
                    dur: this.opts.reducedMotion ? 0.01 : 1.5 };
  }

  home() {
    this.flight = { from: this.camera.position.clone(), to: new THREE.Vector3(0, 125, 205), tFrom: this.controls.target.clone(),
                    tTo: new THREE.Vector3(0, 0, 0), start: this.clock.elapsedTime, dur: this.opts.reducedMotion ? 0.01 : 1.6 };
  }

  setAutoRotate(on: boolean) {
    this.controls.autoRotate = on && !this.opts.reducedMotion;
  }

  info(id: string): NodeInfo | null {
    const n = this.nodes.get(id);
    return n ? { id: n.id, kind: n.kind, label: n.label, team: n.team, color: n.color, meta: n.meta } : null;
  }

  // ---------------------------------------------------------------- input

  private screen(p: THREE.Vector3): [number, number, boolean] {
    const v = p.clone().project(this.camera);
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    return [(v.x * 0.5 + 0.5) * w, (-v.y * 0.5 + 0.5) * h, v.z < 1];
  }

  private pick(x: number, y: number): Node | null {
    let best: Node | null = null;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      if (n.kind === "team" || n.dying || n.alpha < 0.3) continue;
      const [sx, sy, front] = this.screen(n.pos);
      if (!front) continue;
      const dist = this.camera.position.distanceTo(n.pos);
      const r = Math.max(10, (n.size * 300) / dist) + 4;
      const d = Math.hypot(sx - x, sy - y);
      if (d < r && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private onMove = (e: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = e.clientX - rect.left;
    this.pointer.y = e.clientY - rect.top;
    this.pointer.inside = true;
    const n = this.pick(this.pointer.x, this.pointer.y);
    const id = n?.id ?? null;
    if (id !== this.hover) {
      this.hover = id;
      this.renderer.domElement.style.cursor = id ? "pointer" : "grab";
      this.applyStyle();
    }
    this.onHover(n ? this.info(n.id) : null, this.pointer.x, this.pointer.y);
  };

  private onDown = (e: PointerEvent) => {
    this.pointer.down = performance.now();
    this.pointer.downX = e.clientX;
    this.pointer.downY = e.clientY;
    this.flight = null;
  };

  private onUp = (e: PointerEvent) => {
    const moved = Math.hypot(e.clientX - this.pointer.downX, e.clientY - this.pointer.downY);
    if (moved > 5 || performance.now() - this.pointer.down > 600) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const n = this.pick(e.clientX - rect.left, e.clientY - rect.top);
    this.onSelect(n ? this.info(n.id) : null);
  };

  private onLeave = () => {
    this.pointer.inside = false;
    if (this.hover) {
      this.hover = null;
      this.applyStyle();
    }
    this.onHover(null, 0, 0);
  };

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.lens.uniforms.uAspect.value = w / h;
  }

  // ---------------------------------------------------------------- labels

  private label(n: Node, x: number, y: number, show: boolean, strong: boolean) {
    let el = this.labelEls.get(n.id);
    if (!show) {
      if (el) el.style.opacity = "0";
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.textContent = n.label;
      const team = n.kind === "team";
      el.style.cssText = [
        "position:absolute;left:0;top:0;white-space:nowrap;transition:opacity .35s cubic-bezier(.22,1,.36,1);will-change:transform;",
        team
          ? "font-family:var(--font-serif);font-style:italic;font-size:22px;letter-spacing:-0.01em;color:rgba(236,232,220,.55);"
          : n.kind === "service" || n.kind === "retired"
            ? "font-family:var(--font-geist-mono);font-size:10.5px;letter-spacing:.02em;color:rgba(236,232,220,.86);"
            : "font-family:var(--font-geist);font-size:11px;color:rgba(236,232,220,.78);",
        "text-shadow:0 0 12px rgba(4,5,10,.95),0 0 3px rgba(4,5,10,.95);",
      ].join("");
      this.labels.appendChild(el);
      this.labelEls.set(n.id, el);
    }
    if (el.textContent !== n.label) el.textContent = n.label;
    const dx = n.kind === "team" ? -40 : 9;
    const dy = n.kind === "team" ? -18 : -7;
    el.style.transform = `translate(${(x + dx).toFixed(1)}px, ${(y + dy).toFixed(1)}px)`;
    const eff = this.effects.get(n.id);
    el.style.color = eff ? EFFECT_COLOR[eff] : n.kind === "team" ? "rgba(236,232,220,.5)" : strong ? "#ffb547" : "";
    el.style.opacity = strong ? "1" : n.kind === "team" ? "0.9" : "0.8";
  }

  // ---------------------------------------------------------------- frame

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;

    for (let i = this.schedule.length - 1; i >= 0; i--) {
      if (this.schedule[i].at <= time) {
        const s = this.schedule[i];
        this.schedule.splice(i, 1);
        s.run();
      }
    }

    if (this.flight) {
      const k = Math.min(1, (time - this.flight.start) / this.flight.dur);
      const e = easeInOut(k);
      this.camera.position.lerpVectors(this.flight.from, this.flight.to, e);
      this.controls.target.lerpVectors(this.flight.tFrom, this.flight.tTo, e);
      if (k >= 1) this.flight = null;
    }
    this.controls.update();

    // warp: zoom blur + fov punch, rising then settling
    let w = 0;
    if (this.warpT) {
      const k = (time - this.warpT.start) / this.warpT.dur;
      if (k >= 1) this.warpT = null;
      else w = Math.sin(Math.min(1, k) * Math.PI);
    }
    this.warpPass.uniforms.uStrength.value = w;
    this.skyMat.uniforms.uWarp.value = w;
    const fov = 52 + w * 30;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // nodes ease toward their targets
    const pos = this.stars.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.stars.geometry.getAttribute("color") as THREE.BufferAttribute;
    const size = this.stars.geometry.getAttribute("size") as THREE.BufferAttribute;
    const alpha = this.stars.geometry.getAttribute("alpha") as THREE.BufferAttribute;
    const kind = this.stars.geometry.getAttribute("kind") as THREE.BufferAttribute;
    const phase = this.stars.geometry.getAttribute("phase") as THREE.BufferAttribute;
    const flare = this.stars.geometry.getAttribute("flare") as THREE.BufferAttribute;
    const kPos = 1 - Math.pow(0.0015, dt);
    const kFast = 1 - Math.pow(0.0004, dt);
    let anyMoving = false;
    const dead: string[] = [];
    this.order.forEach((id, i) => {
      const n = this.nodes.get(id)!;
      if (n.pos.distanceToSquared(n.to) > 0.0004) {
        n.pos.lerp(n.to, kPos);
        anyMoving = true;
      }
      n.size += (n.sizeTo - n.size) * kFast;
      n.alpha += (n.alphaTo - n.alpha) * kFast;
      n.col.lerp(n.colTo, kFast);
      const pulse = this.effects.get(id) === "break" ? 0.25 + 0.25 * Math.sin(time * 6 + n.phase * 6) : 0;
      n.flare += (n.flareTo + pulse - n.flare) * kFast;
      if (n.dying && n.alpha < 0.01) dead.push(id);
      pos.setXYZ(i, n.pos.x, n.pos.y, n.pos.z);
      col.setXYZ(i, n.col.r, n.col.g, n.col.b);
      size.setX(i, n.size);
      alpha.setX(i, n.alpha);
      kind.setX(i, KIND_CODE[n.kind]);
      phase.setX(i, n.phase);
      flare.setX(i, n.flare);
    });
    for (const a of [pos, col, size, alpha, kind, phase, flare]) a.needsUpdate = true;
    if (dead.length) {
      for (const id of dead) {
        this.nodes.delete(id);
        const el = this.labelEls.get(id);
        if (el) {
          el.remove();
          this.labelEls.delete(id);
        }
      }
      this.rebuildStars();
      this.rebuildLinks();
    } else if (anyMoving || this.moving) {
      this.rebuildLinks();
      this.moving = anyMoving;
    }

    // materials
    for (const m of [this.starMat, this.linkMat, this.constMat, this.extraMat, this.skyMat, this.dustMat]) m.uniforms.uTime.value = time;
    for (const m of [this.constMat, this.extraMat]) m.uniforms.uReveal.value = Math.min(1.01, m.uniforms.uReveal.value + dt * 0.9);
    for (const m of this.nebulae) {
      if (m.userData.billboard) m.quaternion.copy(this.camera.quaternion);
      const mat = m.material as THREE.ShaderMaterial;
      if (mat.uniforms?.uTime) mat.uniforms.uTime.value = time;
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      const k = (time - r.start) / r.dur;
      if (k >= 1) {
        this.scene.remove(r.mesh);
        r.mesh.geometry.dispose();
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      ((r.mesh.material as THREE.ShaderMaterial).uniforms.uProgress.value = easeOut(k));
    }
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const tr = this.trails[i];
      const mat = tr.lines.material as THREE.ShaderMaterial;
      mat.uniforms.uTime.value = time;
      mat.uniforms.uReveal.value = Math.min(1.01, (time - tr.start) / tr.dur);
    }
    if (this.hole) {
      const born = this.hole.userData.born as number;
      const k = Math.min(1, (time - born) / 1.8);
      this.hole.scale.setScalar(easeOut(k));
      for (const m of this.holeMats) m.uniforms.uTime.value = time;
      this.hole.children.forEach((c) => c.userData.billboard && c.quaternion.copy(this.camera.quaternion));
      const [sx, sy, front] = this.screen(this.hole.position);
      const w0 = this.host.clientWidth;
      const h0 = this.host.clientHeight;
      const dist = this.camera.position.distanceTo(this.hole.position);
      this.lens.uniforms.uCenter.value.set(sx / w0, 1 - sy / h0);
      this.lens.uniforms.uRadius.value = Math.min(0.2, (9 / dist) * 1.2);
      this.lens.uniforms.uStrength.value = front ? easeOut(k) : 0;
    }

    // labels: teams always; important services; whatever is focused, hovered, selected or hit. Greedy by
    // priority, so a label never sits on top of a more important one.
    const camD = this.camera.position.distanceTo(this.controls.target);
    const cands: { n: Node; x: number; y: number; pri: number; strong: boolean }[] = [];
    for (const n of this.nodes.values()) {
      if (n.dying) {
        this.label(n, 0, 0, false, false);
        continue;
      }
      const [x, y, front] = this.screen(n.pos);
      const inView = front && x > -50 && y > -20 && x < this.host.clientWidth + 50 && y < this.host.clientHeight + 20;
      const strong = n.id === this.selected || n.id === this.hover || this.evidence.includes(n.id);
      const meta = n.meta as { tier?: number; rank?: number };
      const important =
        n.kind === "team" ? !this.focus && !this.effects.size :
        this.effects.has(n.id) || this.holeId === n.id ||
        (this.focus ? this.focus.has(n.id) && (n.kind !== "person" || this.focus.size < 24) :
          n.kind === "service" && ((meta.tier === 1 && camD < 300) || camD < 140)) ||
        (n.kind === "person" && camD < 70) || (n.kind === "customer" && camD < 90 && !this.focus);
      if (inView && (strong || important) && (n.alpha > 0.2 || n.kind === "team")) {
        const pri = (strong ? 100 : 0) + (this.effects.has(n.id) ? 40 : 0) + (n.kind === "team" ? 30 : 0) +
          (n.kind === "service" ? 20 - (meta.tier ?? 3) * 3 + (meta.rank ?? 0) * 100 : 0);
        cands.push({ n, x, y, pri, strong });
      } else this.label(n, x, y, false, false);
    }
    cands.sort((a, b) => b.pri - a.pri);
    const boxes: [number, number, number, number][] = [];
    for (const c of cands) {
      const w = c.n.kind === "team" ? c.n.label.length * 10 : c.n.label.length * 6.6 + 10;
      const h = c.n.kind === "team" ? 24 : 14;
      const bx = c.x + (c.n.kind === "team" ? -40 : 9);
      const by = c.y + (c.n.kind === "team" ? -18 : -7);
      const hit = boxes.some(([x0, y0, w0, h0]) => bx < x0 + w0 && bx + w > x0 && by < y0 + h0 && by + h > y0);
      if (hit && !c.strong) {
        this.label(c.n, c.x, c.y, false, false);
        continue;
      }
      boxes.push([bx, by, w, h]);
      this.label(c.n, c.x, c.y, true, c.strong);
    }

    this.composer.render();
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointerup", this.onUp);
    el.removeEventListener("pointerleave", this.onLeave);
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    this.composer.dispose();
    this.renderer.dispose();
    el.remove();
    this.labels.remove();
  }
}

export { R_HALO, formerPos, teamPos };
