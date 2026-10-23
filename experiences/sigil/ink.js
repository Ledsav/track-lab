/* =============================================================================
   Ink on parchment: nib strokes and the paper they sit on.
   -----------------------------------------------------------------------------
   Stroke   points with a nib width each: slow = a fat, wet line, fast = a thin one.
   drawInk  fills the stroke as a ribbon (two smooth edges, round pooled ends).
   makePaper  a tileable fibre-and-speckle texture, multiplied over the page.
   ============================================================================= */
import { TAU, clamp } from '../../shared/js/math.js';

export class Stroke {
  /** nib = width at a medium speed (px); minStep = closer points are skipped (px). */
  constructor(nib, minStep, speedRef) { this.pts = []; this.nib = nib; this.minStep = minStep; this.speedRef = speedRef; this.w = nib*1.15; this.speed = 0; }
  /** Add a point at time t (s). Returns false when it was too close to the last one. */
  add(x, y, t) {
    const p = this.pts[this.pts.length - 1];
    if (p) {
      const d = Math.hypot(x - p.x, y - p.y); if (d < this.minStep) return false;
      this.speed = d/Math.max(.008, t - p.t);
      const target = this.nib*clamp(1.35 - this.speed/this.speedRef, .45, 1.35);
      this.w += (target - this.w)*.35;
    }
    this.pts.push({ x, y, t, w:this.w });
    return true;
  }
}

/** Smooth line through points (quadratic curves through the midpoints). */
function smooth(ctx, P, start) {
  start ? ctx.moveTo(P[0].x, P[0].y) : ctx.lineTo(P[0].x, P[0].y);
  for (let i = 1; i < P.length - 1; i++) ctx.quadraticCurveTo(P[i].x, P[i].y, (P[i].x + P[i + 1].x)/2, (P[i].y + P[i + 1].y)/2);
  ctx.lineTo(P[P.length - 1].x, P[P.length - 1].y);
}

/** Add the stroke's outline to the current path. scale widens it (for the wet bleed underneath). */
export function inkPath(ctx, pts, scale = 1) {
  const n = pts.length; if (!n) return;
  const h0 = pts[0].w*scale/2;
  if (n === 1) { ctx.moveTo(pts[0].x + h0*1.2, pts[0].y); ctx.arc(pts[0].x, pts[0].y, h0*1.2, 0, TAU); return; }
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let nx = a.y - b.y, ny = b.x - a.x; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    const h = pts[i].w*scale/2;
    L.push({ x:pts[i].x + nx*h, y:pts[i].y + ny*h }); R.push({ x:pts[i].x - nx*h, y:pts[i].y - ny*h });
  }
  smooth(ctx, L, true); smooth(ctx, R.reverse(), false); ctx.closePath();
}
/** Round ends: ink pools a little where the nib lands. Filled on their own (in the ribbon's path they could cancel it out). */
function capsPath(ctx, pts, scale) {
  const a = pts[0], e = pts[pts.length - 1], ha = a.w*scale/2*1.15, he = e.w*scale/2;
  ctx.moveTo(a.x + ha, a.y); ctx.arc(a.x, a.y, ha, 0, TAU); ctx.moveTo(e.x + he, e.y); ctx.arc(e.x, e.y, he, 0, TAU);
}

/** Fill a stroke in ink. wet (0..1) adds a soft bleed into the paper underneath. */
export function drawInk(ctx, pts, { color, alpha = 1, wet = 0, scale = 1 } = {}) {
  if (!pts.length || alpha <= 0) return;
  ctx.save(); ctx.fillStyle = color;
  if (wet > 0) { ctx.globalAlpha = alpha*wet*.16; ctx.beginPath(); inkPath(ctx, pts, scale*2); ctx.fill(); }
  ctx.globalAlpha = alpha*.92; ctx.beginPath(); inkPath(ctx, pts, scale); ctx.fill();
  if (pts.length > 1) { ctx.beginPath(); capsPath(ctx, pts, scale); ctx.fill(); }
  ctx.restore();
}

/** Tileable paper: speckles, fibres and faint blotches, as a multiply texture (white = no change). */
export function makePaper(size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
  let seed = 9; const r = () => (seed = (seed*16807) % 2147483647)/2147483647;
  for (let i = 0; i < 9; i++) {                                         // blotches (drawn wrapped so the tile repeats cleanly)
    const x = r()*size, y = r()*size, s = size*(.15 + r()*.3), a = .05 + r()*.06;
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
      const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, s);
      gr.addColorStop(0, `rgba(170,130,80,${a})`); gr.addColorStop(1, 'rgba(170,130,80,0)'); g.fillStyle = gr; g.fillRect(x + dx - s, y + dy - s, s*2, s*2);
    }
  }
  g.lineWidth = .7;
  for (let i = 0; i < 160; i++) {                                       // fibres
    const x = r()*size, y = r()*size, a = r()*TAU, l = 4 + r()*14;
    g.strokeStyle = `rgba(120,90,50,${.06 + r()*.1})`; g.beginPath(); g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a + .6)*l*.5, y + Math.sin(a + .6)*l*.5, x + Math.cos(a)*l, y + Math.sin(a)*l); g.stroke();
  }
  for (let i = 0; i < 2200; i++) { g.fillStyle = `rgba(90,65,35,${r()*.12})`; g.fillRect(r()*size, r()*size, 1, 1); }   // speckles
  return c;
}
