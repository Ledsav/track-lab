/* =============================================================================
   Sigil geometry: the four signs, the ring test, and a small $1-style recognizer.
   -----------------------------------------------------------------------------
   Strokes arrive in canvas pixels (mirrored: what the user sees). Templates live in
   unit space (about -1..1, y down). Recognition: resample → centre → scale to unit RMS
   radius → best rotation within a window → mean point distance → score 0..1.
   Signs (all original, loosely alchemical):
     water  a wave, two or three crests        fire   a triangle pointing up
     wind   a spiral, either way round          light  a five-pointed star in one stroke
   ============================================================================= */
import { TAU, dist } from '../../shared/js/math.js';

export const SIGN_IDS = ['water', 'fire', 'wind', 'light'];
const N = 64;                       // points per resampled stroke

/* ---------- canonical drawings (the guide, the grimoire and the templates) ---------- */
const wave = (periods, phase = 1, n = 96) => Array.from({ length:n }, (_, i) => { const t = i/(n - 1); return { x:-1 + 2*t, y:-phase*.32*Math.sin(t*TAU*periods) }; });
const spiral = (turns, dir = 1, n = 120) => Array.from({ length:n }, (_, i) => { const s = i/(n - 1), r = .1 + .9*s, a = dir*s*turns*TAU; return { x:r*Math.cos(a), y:r*Math.sin(a) }; });
function polygon(vs, start = 0, dir = 1, n = 96) {
  const order = vs.map((_, k) => vs[((start + dir*k) % vs.length + vs.length) % vs.length]); order.push(order[0]);
  const out = [], per = Math.ceil(n/(order.length - 1));
  for (let k = 0; k < order.length - 1; k++) for (let i = 0; i < per; i++) { const a = order[k], b = order[k + 1], t = i/per; out.push({ x:a.x + (b.x - a.x)*t, y:a.y + (b.y - a.y)*t }); }
  out.push(order[order.length - 1]); return out;
}
const TRIANGLE = [{ x:0, y:-1 }, { x:.92, y:.64 }, { x:-.92, y:.64 }];
const STAR = [0, 2, 4, 1, 3].map(k => { const a = (-90 + k*72)*Math.PI/180; return { x:Math.cos(a), y:Math.sin(a) }; });   // drawn order: every other point

/** The sign as it is shown: unit space, centred, y down. */
export function signPath(id) {
  if (id === 'water') return wave(2);
  if (id === 'fire') return polygon(TRIANGLE);
  if (id === 'wind') return spiral(2.25, -1).reverse();      // drawn from the outside in, counter-clockwise
  return polygon(STAR);
}

/* ---------- stroke maths ---------- */
export function pathLength(p) { let L = 0; for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]); return L; }
export function centroid(p) { let x = 0, y = 0; for (const q of p) { x += q.x; y += q.y; } return { x:x/p.length, y:y/p.length }; }

/** n points evenly spaced along the path. */
export function resample(pts, n = N) {
  if (pts.length < 2) return Array.from({ length:n }, () => ({ ...(pts[0] || { x:0, y:0 }) }));
  const I = pathLength(pts)/(n - 1), out = [{ x:pts[0].x, y:pts[0].y }];
  let D = 0, prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    let cur = pts[i], d = dist(prev, cur);
    while (D + d >= I && d > 0 && out.length < n) {
      const t = (I - D)/d, q = { x:prev.x + t*(cur.x - prev.x), y:prev.y + t*(cur.y - prev.y) };
      out.push(q); prev = q; d = dist(prev, cur); D = 0;
    }
    D += d; prev = cur;
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out;
}

/** Centre on the centroid and scale to unit RMS radius (keeps the aspect: a wave stays flat). */
function normalize(pts) {
  const p = resample(pts), c = centroid(p);
  let s = 0; for (const q of p) s += (q.x - c.x)**2 + (q.y - c.y)**2;
  const k = 1/(Math.sqrt(s/p.length) || 1);
  return p.map(q => ({ x:(q.x - c.x)*k, y:(q.y - c.y)*k }));
}
const rotate = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return p.map(q => ({ x:q.x*c - q.y*s, y:q.x*s + q.y*c })); };
const meanDist = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += dist(a[i], b[i]); return d/a.length; };

/** Smallest distance over rotations in [lo, hi] (golden-section search, as in $1). */
function bestRotation(c, t, lo, hi) {
  const phi = (Math.sqrt(5) - 1)/2;
  let a = lo, b = hi, x1 = phi*a + (1 - phi)*b, x2 = (1 - phi)*a + phi*b;
  let f1 = meanDist(rotate(c, x1), t), f2 = meanDist(rotate(c, x2), t);
  while (Math.abs(b - a) > .035) {
    if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = phi*a + (1 - phi)*b; f1 = meanDist(rotate(c, x1), t); }
    else { a = x1; x1 = x2; f1 = f2; x2 = (1 - phi)*a + phi*b; f2 = meanDist(rotate(c, x2), t); }
  }
  return Math.min(f1, f2);
}

/* ---------- templates: every way round a person might draw each sign ---------- */
const TEMPLATES = [];
const add = (id, pts, spin = false) => { TEMPLATES.push({ id, pts:normalize(pts), spin }); TEMPLATES.push({ id, pts:normalize([...pts].reverse()), spin }); };
for (const periods of [1, 1.5, 2, 2.5]) for (const phase of [1, -1]) add('water', wave(periods, phase));
for (let s = 0; s < 3; s++) for (const dir of [1, -1]) add('fire', polygon(TRIANGLE, s, dir));
for (const turns of [1.5, 2.25, 3]) for (const dir of [1, -1]) add('wind', spiral(turns, dir), true);
for (let s = 0; s < 5; s++) for (const dir of [1, -1]) add('light', polygon(STAR, s, dir));

/**
 * Shape facts that templates alone blur: sweep (degrees wound around the centre: star ≈ 720, spiral ≥ 540,
 * triangle / circle ≈ 360, wave small), sd (radius spread: round ≈ 0), aspect (thin / long side) and
 * turns (crests and troughs across the long axis: a wave has two or more, a check mark one, a line none).
 */
function features(pts) {
  const { sd, sweep } = fitRing(pts), p = resample(pts), c = centroid(p);
  let xx = 0, yy = 0, xy = 0; for (const q of p) { const x = q.x - c.x, y = q.y - c.y; xx += x*x; yy += y*y; xy += x*y; }
  const th = Math.atan2(2*xy, xx - yy)/2, ux = Math.cos(th), uy = Math.sin(th);
  const ab = p.map(q => ({ a:(q.x - c.x)*ux + (q.y - c.y)*uy, b:-(q.x - c.x)*uy + (q.y - c.y)*ux }));
  const lo = Math.min(...ab.map(v => v.a)), hi = Math.max(...ab.map(v => v.a)), lo2 = Math.min(...ab.map(v => v.b)), hi2 = Math.max(...ab.map(v => v.b));
  // crests and troughs: direction reversals across the axis that move at least a quarter of the stroke's thickness
  const step = (hi2 - lo2)*.25; let turns = 0, dir = 0, top = ab[0].b, bottom = ab[0].b;
  for (const { b } of ab) {
    if (dir >= 0) { top = Math.max(top, b); if (top - b > step) { if (dir > 0) turns++; dir = -1; bottom = b; } }
    if (dir <= 0) { bottom = Math.min(bottom, b); if (b - bottom > step) { if (dir < 0) turns++; dir = 1; top = b; } }
  }
  return { sd, sweep, aspect:(hi2 - lo2)/((hi - lo) || 1), turns };
}
/** Lowest score that counts, per sign (the star is the hardest to draw in the air). Checked by recognize(). */
export const MIN_SCORE = { water:.72, fire:.74, wind:.68, light:.62 };
const GATES = {
  water: f => f.sweep < 300 && f.aspect > .14 && f.turns >= 2,
  fire:  f => f.sd > .12 && f.sweep > 280 && f.sweep < 470,
  wind:  f => f.sweep > 420,
  light: f => f.sd > .2 && f.sweep > 540,
};

/**
 * Best sign for a stroke: { id, score, margin, ok }, or id null when no sign's shape fits. score 1 = perfect;
 * ok = good enough to cast; margin = how far ahead of the next sign. Spirals may start at any angle (searched all the way round);
 * the rest within ±maxTilt degrees.
 */
export function recognize(pts, maxTilt = 35) {
  const f = features(pts), c = normalize(pts), best = {}, tilt = maxTilt*Math.PI/180;
  for (const t of TEMPLATES) {
    if (!GATES[t.id](f)) continue;
    let d;
    if (t.spin) { d = Infinity; for (let k = 0; k < 12; k++) { const a = k*TAU/12; d = Math.min(d, bestRotation(c, t.pts, a - TAU/24, a + TAU/24)); } }
    else d = bestRotation(c, t.pts, -tilt, tilt);
    if (!(t.id in best) || d < best[t.id]) best[t.id] = d;
  }
  const ranked = Object.entries(best).sort((a, b) => a[1] - b[1]), score = d => Math.max(0, 1 - d/1.1);
  if (!ranked.length) return { id:null, score:0, margin:0, ok:false, f };
  const id = ranked[0][0], sc = score(ranked[0][1]);
  return { id, score:sc, margin:sc - (ranked[1] ? score(ranked[1][1]) : 0), ok:sc >= MIN_SCORE[id], f };
}

/**
 * How ring-like a stroke is: centre and radius, sd = spread of the radius (share of r), gap = start-to-end
 * distance (share of r), sweep = degrees travelled around the centre, wobble = the drawn radius per angle
 * bin (share of r), kept so the snapped ring still looks hand-inked.
 */
export function fitRing(pts, bins = 48) {
  const p = resample(pts, 96), c = centroid(p);
  const rs = p.map(q => dist(q, c)), r = rs.reduce((s, v) => s + v, 0)/rs.length;
  const sd = Math.sqrt(rs.reduce((s, v) => s + (v - r)**2, 0)/rs.length)/(r || 1);
  let sweep = 0;
  for (let i = 1; i < p.length; i++) {
    let d = Math.atan2(p[i].y - c.y, p[i].x - c.x) - Math.atan2(p[i - 1].y - c.y, p[i - 1].x - c.x);
    if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
    sweep += d;
  }
  const sum = new Array(bins).fill(0), cnt = new Array(bins).fill(0);
  p.forEach((q, i) => { const a = (Math.atan2(q.y - c.y, q.x - c.x) + TAU) % TAU, b = Math.floor(a/TAU*bins) % bins; sum[b] += (rs[i] - r)/(r || 1); cnt[b]++; });
  const wobble = sum.map((s, i) => cnt[i] ? s/cnt[i] : 0);
  return { c, r, sd, gap:dist(p[0], p[p.length - 1])/(r || 1), sweep:Math.abs(sweep)*180/Math.PI, wobble };
}

/** Points of a sign placed on the page: centre c, half-size s (pixels). */
export const placeSign = (id, c, s) => signPath(id).map(q => ({ x:c.x + q.x*s, y:c.y + q.y*s }));

/** Mean distance from each drawn point to the nearest point of a target path, in pixels. */
export function traceError(drawn, target) {
  const d = resample(drawn, 48), t = resample(target, 96);
  let e = 0; for (const q of d) { let m = Infinity; for (const p of t) m = Math.min(m, (p.x - q.x)**2 + (p.y - q.y)**2); e += Math.sqrt(m); }
  // …and the other way, so tracing half the shape doesn't score as a perfect trace
  let f = 0; for (const p of resample(target, 48)) { let m = Infinity; for (const q of d) m = Math.min(m, (p.x - q.x)**2 + (p.y - q.y)**2); f += Math.sqrt(m); }
  return (e + f)/(2*48);
}
