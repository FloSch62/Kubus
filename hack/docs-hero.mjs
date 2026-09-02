// Generates the animated isometric cube field behind the docs landing page hero.
// Output: overrides/partials/kubus-hero-bg.html (included by overrides/partials/kubus-hero.html).
//
// Every cube is its own small element so the browser can animate transform and
// opacity on the compositor without repainting; the grid and the links are one
// static SVG, and the packets move with plain transforms. Keyframes hold literal
// values on purpose: var() inside keyframes forces a style recalc every frame.
// Usage: node hack/docs-hero.mjs
import { writeFileSync } from 'node:fs';

const W = 1600;
const H = 560;
const OUT = 'overrides/partials/kubus-hero-bg.html';

// Deterministic PRNG so the field is stable between runs.
let seed = 20260902;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (lo, hi) => lo + rand() * (hi - lo);

// Logo palette, cyan on the left running to violet on the right.
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const c = (x, y) => Math.round(x + (y - x) * t);
  return `#${[c(r1, r2), c(g1, g2), c(b1, b2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};
const faces = (t) => ({
  top: mix('#38c6fc', '#bd5bf1', t),
  left: mix('#1a6cea', '#3c2bce', t),
  right: mix('#1556ce', '#5a28d8', t),
});

const fmt = (n) => Number(n.toFixed(1));

// Cube geometry: hexagon silhouette of circumradius a, three faces meeting at the centre.
const cube = (a) => {
  const w = fmt(a * 0.8660254);
  const h = fmt(a * 0.5);
  return {
    top: `0,${-a} ${w},${-h} 0,0 ${-w},${-h}`,
    left: `${-w},${-h} 0,0 0,${a} ${-w},${h}`,
    right: `0,0 ${w},${-h} ${w},${h} 0,${a}`,
  };
};

// Text sits in the middle of the band; keep the mid and near layers out of it.
const inText = (x, y) => ((x - W / 2) / 420) ** 2 + ((y - 245) / 165) ** 2 < 1;

const layers = [
  { name: 'far', a: 12, pitch: 2.9, keep: 0.24, alpha: 0.3, wire: true },
  { name: 'mid', a: 20, pitch: 2.7, keep: 0.22, alpha: 0.5, wire: false },
  { name: 'near', a: 31, pitch: 2.6, keep: 0.2, alpha: 0.78, wire: false },
];

const cubes = [];
for (const L of layers) {
  const px = L.a * 1.7320508 * L.pitch;
  const py = L.a * 1.5 * L.pitch;
  const cols = Math.ceil(W / px) + 2;
  const rows = Math.ceil(H / py) + 2;
  for (let j = -1; j < rows; j++) {
    for (let i = -1; i < cols; i++) {
      if (rand() > L.keep) continue;
      const cx = i * px + (j % 2 ? px / 2 : 0) + between(-L.a * 0.5, L.a * 0.5);
      const cy = j * py + between(-L.a * 0.4, L.a * 0.4);
      if (cx < -L.a || cx > W + L.a || cy < -L.a || cy > H + L.a) continue;
      if (L.name !== 'far' && inText(cx, cy)) continue;
      cubes.push({ ...L, cx, cy });
    }
  }
}

// Links between neighbouring cubes in the two front layers, like a small topology map.
const front = cubes.filter((c) => c.name !== 'far');
const links = [];
const linked = new Set();
for (const c of front) {
  if (links.length >= 14 || linked.has(c)) continue;
  let best = null;
  let bestD = Infinity;
  for (const o of front) {
    if (o === c || linked.has(o)) continue;
    const d = Math.hypot(o.cx - c.cx, o.cy - c.cy);
    const minD = (c.a + o.a) * 1.6;
    const maxD = (c.a + o.a) * 4.5;
    if (d > minD && d < maxD && d < bestD) {
      best = o;
      bestD = d;
    }
  }
  if (best) {
    links.push([c, best]);
    linked.add(c);
    linked.add(best);
  }
}

const pct = (v, total) => ((v / total) * 100).toFixed(2);

let out = '';
// Cube geometry, referenced by every instance below.
out += `<svg class="kubus-hero__defs" width="0" height="0" aria-hidden="true" focusable="false">\n  <defs>\n`;
for (const L of layers) {
  const g = cube(L.a);
  out += `    <g id="kb-${L.name}">\n`;
  if (L.wire) {
    out += `      <polygon points="${g.top}" style="fill:var(--ft);stroke:var(--ft)" fill-opacity="0.14"/>\n`;
    out += `      <polygon points="${g.left}" style="fill:var(--fl);stroke:var(--fl)" fill-opacity="0.14"/>\n`;
    out += `      <polygon points="${g.right}" style="fill:var(--fr);stroke:var(--fr)" fill-opacity="0.14"/>\n`;
  } else {
    out += `      <polygon points="${g.top}" style="fill:var(--ft)"/>\n`;
    out += `      <polygon points="${g.left}" style="fill:var(--fl)"/>\n`;
    out += `      <polygon points="${g.right}" style="fill:var(--fr)"/>\n`;
  }
  out += `    </g>\n`;
}
out += `  </defs>\n</svg>\n`;

// The scene keeps a fixed 1600x560 aspect ratio and is scaled to cover the hero (see extra.css),
// so percentage positions here and the static SVG's viewBox line up.
out += `<div class="kubus-hero__scene">\n`;
out += `  <svg class="kubus-hero__static" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">\n`;
out += `    <defs>\n`;
out += `      <pattern id="kb-iso" width="${fmt(31 * 1.7320508)}" height="31" patternUnits="userSpaceOnUse">\n`;
out += `        <path d="M0 15.5 L${fmt(31 * 0.8660254)} 0 L${fmt(31 * 1.7320508)} 15.5 M0 15.5 L${fmt(31 * 0.8660254)} 31 L${fmt(31 * 1.7320508)} 15.5" fill="none" stroke="#8fb5ff" stroke-width="0.6"/>\n`;
out += `      </pattern>\n`;
out += `      <radialGradient id="kb-fade" cx="50%" cy="45%" r="70%">\n`;
out += `        <stop offset="0" stop-color="#fff" stop-opacity="0.1"/>\n`;
out += `        <stop offset="0.55" stop-color="#fff" stop-opacity="0.7"/>\n`;
out += `        <stop offset="1" stop-color="#fff" stop-opacity="1"/>\n`;
out += `      </radialGradient>\n`;
out += `      <mask id="kb-edge"><rect width="${W}" height="${H}" fill="url(#kb-fade)"/></mask>\n`;
out += `    </defs>\n`;
out += `    <rect class="kubus-hero__grid" width="${W}" height="${H}" fill="url(#kb-iso)" mask="url(#kb-edge)"/>\n`;
out += `    <g class="kubus-hero__links">\n`;
for (const [a, b] of links) {
  out += `      <line x1="${fmt(a.cx)}" y1="${fmt(a.cy)}" x2="${fmt(b.cx)}" y2="${fmt(b.cy)}" vector-effect="non-scaling-stroke"/>\n`;
}
out += `    </g>\n`;
out += `  </svg>\n`;

for (const L of layers) {
  const box = 2 * L.a + 2; // one unit of padding for the wireframe stroke
  out += `  <div class="kubus-hero__layer kubus-hero__layer--${L.name}">\n`;
  for (const c of cubes.filter((c) => c.name === L.name)) {
    const t = Math.min(1, Math.max(0, (c.cx / W) * 0.85 + (c.cy / H) * 0.15));
    const f = faces(t);
    // One animation per cube (rise and light up together). The delay follows the diagonal
    // position so the pulse sweeps across the field as a wave; periods differ slightly so
    // the field slowly loses lockstep.
    const period = between(11, 13.5).toFixed(1);
    const wave = (-((c.cx + c.cy * 0.7) / (W + H * 0.7)) * 12 - between(0, 0.6)).toFixed(2);
    out += `    <i class="kb-cube" style="left:${pct(c.cx, W)}%;top:${pct(c.cy, H)}%;--t:${period}s;--d:${wave}s">`;
    out += `<svg viewBox="${-L.a - 1} ${-L.a - 1} ${box} ${box}" style="opacity:${c.alpha};--ft:${f.top};--fl:${f.left};--fr:${f.right}"><use xlink:href="#kb-${L.name}"/></svg></i>\n`;
  }
  out += `  </div>\n`;
}

// A small packet travels along each link, like traffic between the two cubes.
out += `  <div class="kubus-hero__packets">\n`;
for (const [a, b] of links) {
  const t = between(3.5, 6.5).toFixed(1);
  const d = -between(0, 6).toFixed(1);
  out += `    <i class="kb-packet" style="left:${pct(a.cx, W)}%;top:${pct(a.cy, H)}%;--dx:${fmt(b.cx - a.cx)};--dy:${fmt(b.cy - a.cy)};--t:${t}s;--d:${d}s"></i>\n`;
}
out += `  </div>\n`;
out += `</div>\n`;

writeFileSync(OUT, out);
console.log(`${OUT}: ${cubes.length} cubes, ${links.length} links, ${(out.length / 1024).toFixed(1)} KiB`);
