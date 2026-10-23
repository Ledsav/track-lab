/* =============================================================================
   Apprentice mode: trace a sigil over a gold guide, get graded, cast it.
   -----------------------------------------------------------------------------
   Each lesson is a ring plus one or two signs at fixed spots. Every traced part gets an
   accuracy (how close the ink stayed to the guide); the grade is their mean, one star off
   for going over the par time. Best grades are kept per browser.
   ============================================================================= */
import { clamp, dist, TAU } from '../../shared/js/math.js';
import { placeSign, traceError } from './glyphs.js';

export const LESSONS = [
  { title:'First light', signs:['light'], par:12 },
  { title:'Still water', signs:['water'], par:12 },
  { title:'Kindling', signs:['fire'], par:12 },
  { title:'A breath of wind', signs:['wind'], par:12 },
  { title:'Rainbow', signs:['light', 'water'], par:18 },
  { title:'Steam', signs:['fire', 'water'], par:18 },
  { title:'Storm', signs:['water', 'wind'], par:18 },
  { title:'Firestorm', signs:['fire', 'wind'], par:18 },
];
const KEY = 'track-lab:sigil:apprentice';
const GRADE = { three:.72, two:.5 };             // mean accuracy for 3 and 2 stars
const TOL = { ring:.2, sign:.42 };               // trace error that scores 0, as a share of the ring radius / sign half-size

export class Apprentice {
  constructor() {
    this.i = 0; this.best = {};
    try { this.best = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* first visit or private mode */ }
    this.reset();
  }
  get lesson() { return LESSONS[this.i]; }
  reset() { this.slots = null; this.ringAcc = null; this.t0 = null; this.result = null; }
  go(i) { this.i = (i + LESSONS.length) % LESSONS.length; this.reset(); }

  /** The guide for a W×H page: ring centre and radius, and one slot per sign. */
  guide(W, H) {
    const u = Math.min(W, H), c = { x:W/2, y:H*.5 }, R = u*.3, ids = this.lesson.signs;
    const spots = ids.length === 1 ? [{ x:c.x, y:c.y, s:R*.5 }] : [{ x:c.x - R*.42, y:c.y, s:R*.32 }, { x:c.x + R*.42, y:c.y, s:R*.32 }];
    if (!this.slots) this.slots = ids.map((id, k) => ({ id, c:{ x:spots[k].x, y:spots[k].y }, s:spots[k].s, acc:null }));
    return { c, R, slots:this.slots };
  }

  /** Accuracy 0..1 of a traced ring against the guide circle. */
  scoreRing(pts, g) {
    const circle = Array.from({ length:97 }, (_, k) => ({ x:g.c.x + Math.cos(k/96*TAU)*g.R, y:g.c.y + Math.sin(k/96*TAU)*g.R }));
    return this.ringAcc = clamp(1 - traceError(pts, circle)/(TOL.ring*g.R), 0, 1);
  }
  /** The free slot a recognized sign belongs to (same sign, nearest), or null. */
  slotFor(id, pts) {
    let best = null, bd = Infinity; const m = pts[pts.length >> 1];
    for (const s of this.slots || []) if (s.acc === null && s.id === id) { const d = dist(s.c, m); if (d < bd) { bd = d; best = s; } }
    return best;
  }
  scoreSign(slot, pts) { return slot.acc = clamp(1 - traceError(pts, placeSign(slot.id, slot.c, slot.s))/(TOL.sign*slot.s), 0, 1); }
  get complete() { return this.ringAcc !== null && this.slots && this.slots.every(s => s.acc !== null); }

  /** Grade the finished sigil; time in seconds. Keeps the best. */
  finish(time) {
    const accs = [this.ringAcc, ...this.slots.map(s => s.acc)], acc = accs.reduce((a, b) => a + b, 0)/accs.length;
    let stars = acc >= GRADE.three ? 3 : acc >= GRADE.two ? 2 : 1;
    const slow = time > this.lesson.par; if (slow) stars = Math.max(1, stars - 1);
    const prev = this.best[this.i] || 0, isBest = stars > prev;
    if (isBest) { this.best[this.i] = stars; try { localStorage.setItem(KEY, JSON.stringify(this.best)); } catch { /* private mode */ } }
    return this.result = { stars, acc, time, slow, isBest, title:this.lesson.title };
  }
}
