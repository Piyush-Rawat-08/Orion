// GLSL for the sky. Everything additive is drawn without depth writes so glows stack the way light does.

export const NOISE = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return v;
  }
`;

// ------------------------------------------------------------------ entity stars
// kind: 0 service, 1 person, 2 customer, 3 retired service, 4 former person, 5 team core
export const STAR_VERT = /* glsl */ `
  attribute float size;
  attribute vec3 color;
  attribute float alpha;
  attribute float kind;
  attribute float phase;
  attribute float flare;
  uniform float uTime;
  uniform float uPx;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vKind;
  varying float vFlare;
  varying float vPhase;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float tw = 0.86 + 0.14 * sin(uTime * (0.7 + fract(phase * 7.13) * 1.9) + phase * 6.2831);
    float s = size * (1.0 + flare * 1.1) * tw;
    gl_PointSize = clamp(s * uPx * (820.0 / -mv.z), 0.0, 260.0);
    vColor = color;
    vAlpha = alpha;
    vKind = kind;
    vFlare = flare;
    vPhase = phase;
  }
`;

export const STAR_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vKind;
  varying float vFlare;
  varying float vPhase;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p);
    if (r > 0.5) discard;
    float core = exp(-r * r * 140.0);
    float halo = exp(-r * r * 16.0) * 0.5;
    float a;
    vec3 col = mix(vColor, vec3(1.0, 0.98, 0.94), core * 0.85);
    if (vKind < 0.5 || vKind > 4.5) {
      // services and team cores: diffraction spikes, slowly turning
      float ang = uTime * 0.05 + vPhase;
      mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
      vec2 q = rot * p;
      float sx = exp(-abs(q.y) * 70.0) * exp(-abs(q.x) * 5.0);
      float sy = exp(-abs(q.x) * 70.0) * exp(-abs(q.y) * 5.0);
      a = core + halo + (sx + sy) * 0.55;
    } else if (vKind > 2.5 && vKind < 3.5) {
      // a retired service: a cooling remnant shell
      float ring = smoothstep(0.30, 0.35, r) * smoothstep(0.45, 0.39, r);
      a = ring * 0.7 + core * 0.25;
      col = vColor;
    } else if (vKind > 3.5) {
      // someone who left: a faint ghost
      a = (core * 0.5 + halo * 0.6);
    } else if (vKind > 1.5) {
      // customers: soft, distant clusters
      a = halo * 1.3 + core * 0.6;
    } else {
      a = core * 1.1 + halo * 0.8;
    }
    gl_FragColor = vec4(col * (1.0 + vFlare * 1.8), clamp(a * vAlpha, 0.0, 1.0));
  }
`;

// ------------------------------------------------------------------ dust and background stars
export const DUST_VERT = /* glsl */ `
  attribute float size;
  attribute vec3 color;
  attribute float phase;
  uniform float uTime;
  uniform float uPx;
  uniform float uFade;
  varying vec3 vColor;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float tw = 0.75 + 0.25 * sin(uTime * (0.4 + fract(phase * 3.7)) + phase * 6.2831);
    gl_PointSize = max(1.0, size * uPx * (260.0 / -mv.z));
    vColor = color;
    vA = tw * uFade;
  }
`;

export const DUST_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vA;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    float a = exp(-r * r * 22.0) * vA;
    gl_FragColor = vec4(vColor, a);
  }
`;

export const SKY_VERT = /* glsl */ `
  attribute float size;
  attribute vec3 color;
  attribute float phase;
  uniform float uTime;
  uniform float uPx;
  uniform float uWarp;
  varying vec3 vColor;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float tw = 0.55 + 0.45 * sin(uTime * (0.3 + fract(phase * 5.3) * 1.4) + phase * 6.2831);
    gl_PointSize = size * uPx * (1.0 + uWarp * 2.5);
    vColor = color;
    vA = tw;
  }
`;

export const SKY_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vA;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    float a = pow(smoothstep(0.5, 0.0, r), 2.2) * vA;
    gl_FragColor = vec4(vColor, a);
  }
`;

// ------------------------------------------------------------------ nebulae (billboards)
export const NEBULA_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const NEBULA_FRAG = /* glsl */ `
  ${NOISE}
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uSeed;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p);
    vec2 q = p * 1.9 + vec2(uSeed, uSeed * 0.37);
    float n = fbm(q + vec2(uTime * 0.006, -uTime * 0.004));
    float m = fbm(q * 2.1 - n * 1.3);
    float shape = smoothstep(1.0, 0.15, d) * pow(clamp(n * 0.6 + m * 0.6, 0.0, 1.0), 2.4);
    vec3 col = mix(uColor * 0.55, uColor * 1.25 + 0.08, m);
    gl_FragColor = vec4(col, shape * uAlpha);
  }
`;

// ------------------------------------------------------------------ filaments (dependencies, constellations)
export const LINK_VERT = /* glsl */ `
  attribute float t;
  attribute vec3 color;
  attribute float speed;
  attribute float strength;
  attribute float dash;
  varying float vT;
  varying vec3 vColor;
  varying float vSpeed;
  varying float vStrength;
  varying float vDash;
  void main() {
    vT = t; vColor = color; vSpeed = speed; vStrength = strength; vDash = dash;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const LINK_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uReveal;
  varying float vT;
  varying vec3 vColor;
  varying float vSpeed;
  varying float vStrength;
  varying float vDash;
  void main() {
    if (vT > uReveal) discard;
    float base = 0.16;
    if (vDash > 0.5 && vDash < 1.5) base *= step(0.45, fract(vT * 16.0));
    if (vDash > 1.5) base *= step(0.78, fract(vT * 28.0));
    float head = fract(vT * 1.0 - uTime * vSpeed);
    float pulse = smoothstep(0.80, 0.99, head) * (1.0 - smoothstep(0.99, 1.0, head));
    float a = (base + pulse * 1.1) * vStrength;
    gl_FragColor = vec4(vColor * (1.0 + pulse * 1.5), a);
  }
`;

// ------------------------------------------------------------------ shockwave (flat ring in the galactic plane)
export const RING_VERT = NEBULA_VERT;
export const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uProgress;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p);
    float r = uProgress;
    float w = 0.05 + 0.08 * (1.0 - uProgress);
    float ring = smoothstep(r - w, r, d) * smoothstep(r + w * 0.4, r, d);
    float fill = smoothstep(r, 0.0, d) * 0.12 * (1.0 - uProgress);
    float a = (ring + fill) * (1.0 - uProgress) * 1.4;
    gl_FragColor = vec4(uColor * (1.4 - uProgress * 0.5), a);
  }
`;

// ------------------------------------------------------------------ black hole accretion disk
export const DISK_FRAG = /* glsl */ `
  ${NOISE}
  uniform float uTime;
  uniform float uIn;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r < uIn || r > 1.0) discard;
    float ang = atan(p.y, p.x);
    float t = (r - uIn) / (1.0 - uIn);
    float swirl = fbm(vec2(ang * 3.0 + uTime * (1.6 - t) * 1.4 - t * 6.0, t * 7.0));
    float streak = fbm(vec2(ang * 8.0 - uTime * 2.2, t * 22.0));
    float heat = pow(1.0 - t, 2.2);
    vec3 hot = vec3(1.0, 0.93, 0.82);
    vec3 warm = vec3(1.0, 0.55, 0.18);
    vec3 cool = vec3(0.75, 0.16, 0.06);
    vec3 col = mix(cool, warm, smoothstep(0.0, 0.6, heat));
    col = mix(col, hot, smoothstep(0.55, 1.0, heat));
    // one side brighter, as light from matter moving toward you is
    float doppler = 0.65 + 0.55 * cos(ang - 0.6);
    float a = smoothstep(1.0, 0.75, r) * smoothstep(uIn, uIn + 0.06, r) * (0.35 + swirl * 0.9 + streak * 0.35);
    gl_FragColor = vec4(col * doppler * (0.9 + heat * 1.8), clamp(a, 0.0, 1.0));
  }
`;

export const PHOTON_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p);
    float ring = exp(-pow((d - 0.62) * 26.0, 2.0));
    float glow = exp(-pow((d - 0.62) * 6.0, 2.0)) * 0.35;
    float flick = 0.9 + 0.1 * sin(uTime * 3.0 + atan(p.y, p.x) * 5.0);
    gl_FragColor = vec4(vec3(1.0, 0.86, 0.66) * flick, (ring + glow));
  }
`;

// ------------------------------------------------------------------ post: gravitational lensing and hyperspace
export const PASS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export const LENS_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uCenter;
  uniform float uRadius;
  uniform float uStrength;
  uniform float uAspect;
  varying vec2 vUv;
  void main() {
    vec2 d = vUv - uCenter;
    d.x *= uAspect;
    float dist = length(d);
    vec2 uv = vUv;
    if (uStrength > 0.0) {
      float bend = uStrength * uRadius * uRadius / max(dist * dist, 1e-4);
      vec2 dir = normalize(d);
      dir.x /= uAspect;
      uv = vUv - dir * min(bend, 0.25) * 0.12;
    }
    vec4 c = texture2D(tDiffuse, uv);
    float shadow = smoothstep(uRadius * 0.55, uRadius * 0.4, dist) * uStrength;
    gl_FragColor = vec4(c.rgb * (1.0 - shadow), 1.0);
  }
`;

export const WARP_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    if (uStrength <= 0.001) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
    vec2 c = vec2(0.5);
    vec2 d = vUv - c;
    vec4 acc = vec4(0.0);
    for (int i = 0; i < 28; i++) {
      float s = 1.0 - uStrength * 0.45 * float(i) / 28.0;
      acc += texture2D(tDiffuse, c + d * s);
    }
    vec4 col = acc / 28.0;
    float tint = uStrength * smoothstep(0.1, 0.7, length(d));
    gl_FragColor = vec4(col.rgb + vec3(0.25, 0.32, 0.55) * tint * 0.35, 1.0);
  }
`;
