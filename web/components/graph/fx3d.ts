// Atmosphere and effects for the 3D company map: a starfield behind everything, the odd shooting star on carbon,
// and shockwaves (a glowing shell that expands from a node) for when something stops working. All of it is
// decoration on top of the data: nothing here is clickable, and it all stays still under reduced motion.

import * as THREE from "three";
import type { Theme } from "@/lib/theme";

// ---------------------------------------------------------------- starfield

const STAR_VERT = /* glsl */ `
  attribute float size;
  attribute float phase;
  attribute vec3 tint;
  uniform float uTime;
  uniform float uPx;
  varying vec3 vTint;
  varying float vTw;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // every star twinkles at its own pace; a few barely at all
    float speed = 0.35 + fract(phase * 3.71) * 1.6;
    float tw = 0.62 + 0.38 * sin(uTime * speed + phase);
    vTw = tw;
    vTint = tint;
    gl_PointSize = size * uPx * (0.8 + 0.35 * tw);
  }
`;

const STAR_FRAG = /* glsl */ `
  uniform float uAlpha;
  varying vec3 vTint;
  varying float vTw;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    // a bright core with a soft falloff, so a big star reads as a glint rather than a disc
    float core = smoothstep(0.5, 0.0, r);
    float a = pow(core, 2.4) * vTw * uAlpha;
    gl_FragColor = vec4(vTint, a);
  }
`;

export interface Starfield {
  object: THREE.Points;
  tick: (seconds: number) => void;
  dispose: () => void;
}

/** A sphere of stars well beyond the graph. Seeded, so the sky is the same on every visit and every screen. */
export function starfield(theme: Theme, radius: number, pixelRatio: number): Starfield {
  const dark = theme === "dark";
  const n = dark ? 2400 : 700;
  const pos = new Float32Array(n * 3);
  const tint = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const phase = new Float32Array(n);
  let seed = 20261015;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const ink = new THREE.Color("#5c554a");
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const r = radius * (9 + rnd() * 9);
    const q = Math.sqrt(1 - u * u);
    pos.set([q * Math.cos(th) * r, u * r, q * Math.sin(th) * r], i * 3);
    const big = rnd() < 0.035;
    size[i] = big ? 2.6 + rnd() * 1.8 : 0.9 + rnd() * 1.3;
    phase[i] = rnd() * Math.PI * 2;
    if (dark) {
      // mostly white, some cool blue, a few warm: the spread of a real night sky
      const t = rnd();
      const c = t < 0.16 ? [0.68, 0.79, 1] : t < 0.26 ? [1, 0.84, 0.66] : [1, 0.98, 0.94];
      const b = big ? 1 : 0.32 + rnd() * 0.55;
      tint.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
    } else tint.set([ink.r, ink.g, ink.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("tint", new THREE.BufferAttribute(tint, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    uniforms: { uTime: { value: 0 }, uPx: { value: pixelRatio }, uAlpha: { value: dark ? 1 : 0.32 } },
    transparent: true,
    depthWrite: false,
    blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const object = new THREE.Points(geo, mat);
  object.renderOrder = -10;
  object.frustumCulled = false;
  return {
    object,
    tick: (s) => (mat.uniforms.uTime.value = s),
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

// ---------------------------------------------------------------- shooting stars

export interface Meteors {
  object: THREE.Group;
  tick: (seconds: number, dt: number, camera: THREE.Camera) => void;
  /** a streak is crossing the sky right now */
  live: () => boolean;
  dispose: () => void;
}

/** Now and then a streak crosses the sky behind the map: carbon only, never more than one at a time. */
export function meteors(radius: number): Meteors {
  const SEG = 24;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(SEG * 3);
  const col = new Float32Array(SEG * 3);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  line.visible = false;
  const group = new THREE.Group();
  group.add(line);

  // the first one comes a few seconds after the map opens
  let next = -1;
  let live: { born: number; dur: number; a: THREE.Vector3; dir: THREE.Vector3; len: number } | null = null;
  const tmp = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();

  return {
    object: group,
    tick: (s, _dt, camera) => {
      if (next < 0) next = s + 3 + Math.random() * 5;
      if (!live && s > next) {
        // start somewhere in the upper half of what the camera sees, far behind the graph, heading down and across
        camera.getWorldDirection(fwd);
        right.setFromMatrixColumn(camera.matrixWorld, 0);
        up.setFromMatrixColumn(camera.matrixWorld, 1);
        const d = radius * 12;
        const a = camera.position.clone().addScaledVector(fwd, d);
        a.addScaledVector(right, (Math.random() - 0.5) * d * 1.1).addScaledVector(up, d * (0.15 + Math.random() * 0.35));
        const side = Math.random() < 0.5 ? -1 : 1;
        const dir = right.clone().multiplyScalar(side).addScaledVector(up, -0.45 - Math.random() * 0.3).normalize();
        live = { born: s, dur: 0.9 + Math.random() * 0.5, a, dir, len: d * (0.32 + Math.random() * 0.2) };
        line.visible = true;
      }
      if (!live) return;
      const t = (s - live.born) / live.dur;
      if (t >= 1) {
        live = null;
        line.visible = false;
        next = s + 7 + Math.random() * 12;
        return;
      }
      // the head runs ahead of a fading tail; the whole streak brightens in and out
      const head = live.len * Math.min(1, t * 1.25);
      const tail = Math.max(0, head - live.len * 0.38);
      const env = Math.sin(Math.PI * t);
      for (let i = 0; i < SEG; i++) {
        const f = i / (SEG - 1);
        tmp.copy(live.a).addScaledVector(live.dir, tail + (head - tail) * f);
        pos.set([tmp.x, tmp.y, tmp.z], i * 3);
        const b = Math.pow(f, 2.2) * env;
        col.set([b * 0.92, b * 0.95, b], i * 3);
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
    live: () => live !== null,
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

// ---------------------------------------------------------------- shockwaves

const SHOCK_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const SHOCK_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    // bright at the rim, clear in the middle: reads as a ring from any angle
    float rim = 1.0 - abs(dot(vN, vV));
    float a = pow(rim, 4.5) * 1.3 * uAlpha;
    gl_FragColor = vec4(uColor, a);
  }
`;

interface Shock {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  at: number;
  dur: number;
  to: number;
  peak: number;
}

export interface Shockwaves {
  object: THREE.Group;
  /** a shell grows from `where` to `radius` over `ms`, starting after `delay` ms */
  fire: (where: { x: number; y: number; z: number }, radius: number, color: string, opts?: { ms?: number; delay?: number; peak?: number }) => void;
  tick: (now: number) => void;
  /** a shell is waiting to start or still growing */
  live: () => boolean;
  clear: () => void;
  dispose: () => void;
}

export function shockwaves(theme: Theme): Shockwaves {
  const geo = new THREE.SphereGeometry(1, 48, 32);
  const group = new THREE.Group();
  const live: Shock[] = [];
  const drop = (s: Shock) => {
    group.remove(s.mesh);
    s.mesh.material.dispose();
  };
  return {
    object: group,
    fire: (where, radius, color, opts = {}) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: SHOCK_VERT,
        fragmentShader: SHOCK_FRAG,
        uniforms: { uColor: { value: new THREE.Color(color) }, uAlpha: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: theme === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(where.x, where.y, where.z);
      mesh.scale.setScalar(0.001);
      mesh.renderOrder = 3;
      group.add(mesh);
      live.push({ mesh, at: performance.now() + (opts.delay ?? 0), dur: opts.ms ?? 1400, to: radius, peak: opts.peak ?? (theme === "dark" ? 0.9 : 0.55) });
    },
    tick: (now) => {
      for (let i = live.length - 1; i >= 0; i--) {
        const s = live[i];
        const t = (now - s.at) / s.dur;
        if (t < 0) continue;
        if (t >= 1) {
          drop(s);
          live.splice(i, 1);
          continue;
        }
        const grow = 1 - Math.pow(1 - t, 3);
        s.mesh.scale.setScalar(Math.max(0.001, s.to * grow));
        s.mesh.material.uniforms.uAlpha.value = s.peak * Math.min(1, t * 8) * (1 - t) * (1 - t);
      }
    },
    live: () => live.length > 0,
    clear: () => {
      for (const s of live) drop(s);
      live.length = 0;
    },
    dispose: () => {
      for (const s of live) drop(s);
      live.length = 0;
      geo.dispose();
    },
  };
}
