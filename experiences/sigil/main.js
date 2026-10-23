/* =============================================================================
   SIGIL
   -----------------------------------------------------------------------------
   Draw magic in the air. Pinch thumb and index to put an ink nib on the page; draw a
   circle and it snaps into a ring; draw a sign inside (wave = water, triangle = fire,
   spiral = wind, star = light); open your palm and push to cast. Two signs combine.
   Apprentice mode: trace sigils over a gold guide and get graded.

   1. Config       every tunable number in one place
   2. Sound        WebAudio synth: nib scratch, ring chime, sign bells, charge drone, spells
   3. Gestures     landmarks → hand reading → pen (pinch) and palm (charge, push, wipe)
   4. Sigil        the ring (snapped, still hand-inked) and the signs inside it
   5. Panel        mode switch, lessons, grimoire, toasts, result card, settings
   6. App          tracking, stroke handling, cast, main loop, render order

   Geometry and sign recognition: glyphs.js · ink: ink.js · spells: spells.js · lessons: lessons.js
   ============================================================================= */
import { TAU, clamp, lerp, ease, dist } from '../../shared/js/math.js';
import { $, toggleFullscreen, canFullscreen, matches } from '../../shared/js/dom.js';
import { startHands, drawSkeleton, drawMirroredVideo, toMirrored } from '../../shared/js/hands.js';
import { SIGN_IDS, signPath, fitRing, recognize, resample, pathLength, placeSign } from './glyphs.js';
import { Stroke, drawInk, makePaper } from './ink.js';
import { ELEMENTS, Spell, Splash, spellKey, BOLT_TIMES } from './spells.js';
import { LESSONS, Apprentice } from './lessons.js';

/* ============================== 1. CONFIG ============================== */
const CONFIG = {
  tracker: { options:{ maxNumHands:2, minDetectionConfidence:.6, minTrackingConfidence:.6 } },
  view: { wholeBelow:.8 },     // show the whole camera picture when filling the screen would keep less than 80% of its shape
  pen: {
    pinchOn:.32, pinchOff:.5,  // thumb–index tip gap, × hand size: below = nib down, above = nib up (× the sensitivity setting)
    downReadings:2, upReadings:2,   // consecutive readings to put the nib down / lift it
    lostMs:220,                // a drawing hand lost this long lifts the nib
    nib:.0085,                 // × u: line width at a medium speed (slow is wider, fast thinner)
    minStep:.003,              // × u: closer points are skipped
    speedRef:2.6,              // × u per second: the speed at which the line is at its thinnest-but-one
    euro:{ minCutoff:1.4, beta:.006, dCutoff:1.2 },   // nib smoothing (One Euro filter)
  },
  palm: {
    chargeMs:650,              // an open palm held still this long charges the sigil fully
    stillSpeed:1.6,            // hand-lengths per second: slower counts as held still
    push:.12,                  // once charged, the hand growing this much (moving toward the camera) casts
    autoCastMs:1100,           // …or holding it charged this long casts anyway
    penGraceMs:500,            // a hand that was drawing this recently can't charge (it's just letting go)
    wipeSpeed:3.2,             // sideways palm swipe faster than this (hand-lengths / s)…
    wipeTravel:.3,             // …across this share of the page clears it
  },
  ring: {
    minR:.08,                  // × u: smallest ring
    maxSd:.17, minSweep:320, maxGap:.5,   // roundness (radius spread / r), degrees travelled, start–end gap / r
    trySweep:220, trySd:.35,   // a stroke this circle-ish that fails the above is a ring that fizzled
    keepWobble:.3,             // share of the hand's wobble the snapped ring keeps
    snap:.35, decor:.75,       // seconds: stroke → ring morph, then the gold inner ring drawing itself
    width:.0075,               // × u: ring line width
  },
  sign: { inside:.7, minSize:.22, max:2 },   // share of points inside the ring; smallest sign (× r); signs per ring
  doodle: { life:10 },         // seconds a stray stroke stays on the page
  spell: { dur:3.8, title:2.6 },
  colors: { ink:'#1d2340', gold:'#c8963e', paper:'#efe3c8' },
};

/* ============================== 2. SOUND ============================== */
/** getLevels() → { master, sfx }. init() from a click. Continuous: nib scratch, charge drone; the rest are one-shots. */
function createSound(getLevels) {
  let ac = null, master, sfx, noiseBuf, scratch, scratchF, drone, droneF;
  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ac = new AC();
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    const lv = getLevels();
    master = ac.createGain(); master.gain.value = lv.master; master.connect(comp); comp.connect(ac.destination);
    sfx = ac.createGain(); sfx.gain.value = lv.sfx; sfx.connect(master);
    const len = ac.sampleRate*2; noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random()*2 - 1;
    // the nib on paper: looping noise, band-passed, loudness follows the pen speed
    const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    scratchF = ac.createBiquadFilter(); scratchF.type = 'bandpass'; scratchF.frequency.value = 2600; scratchF.Q.value = .9;
    scratch = ac.createGain(); scratch.gain.value = 0; src.connect(scratchF); scratchF.connect(scratch); scratch.connect(sfx); src.start();
    // the charge: a low fifth opening up through a filter as the palm charges
    droneF = ac.createBiquadFilter(); droneF.type = 'lowpass'; droneF.frequency.value = 300; droneF.Q.value = 3;
    drone = ac.createGain(); drone.gain.value = 0; droneF.connect(drone); drone.connect(sfx);
    for (const [type, f] of [['sine', 196], ['triangle', 294.7], ['sine', 392.4]]) { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; o.connect(droneF); o.start(); }
  }
  function update(scr, charge) {
    if (!ac) return;
    const t = ac.currentTime, v = getLevels();
    master.gain.setTargetAtTime(v.master, t, .05); sfx.gain.setTargetAtTime(v.sfx, t, .05);
    scratch.gain.setTargetAtTime(.2*scr, t, .03); scratchF.frequency.setTargetAtTime(2200 + 2000*scr, t, .05);
    drone.gain.setTargetAtTime(.1*charge, t, .08); droneF.frequency.setTargetAtTime(300 + 2600*charge*charge, t, .08);
  }
  function noise(dur, o = {}) {
    const { f0 = 2000, f1 = 200, q = 1, type = 'bandpass', gain = .5, attack = .003, delay = 0 } = o;
    const t = ac.currentTime + delay, src = ac.createBufferSource(); src.buffer = noiseBuf;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f0, t); fl.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ac.createGain(); g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    src.connect(fl); fl.connect(g); g.connect(sfx); src.start(t, Math.random()); src.stop(t + dur + .05);
  }
  function tone(type, f0, f1, dur, o = {}) {
    const { gain = .4, attack = .003, delay = 0 } = o;
    const t = ac.currentTime + delay, osc = ac.createOscillator(); osc.type = type;
    osc.frequency.setValueAtTime(f0, t); osc.frequency.exponentialRampToValueAtTime(Math.max(15, f1), t + dur);
    const g = ac.createGain(); g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    osc.connect(g); g.connect(sfx); osc.start(t); osc.stop(t + dur + .05);
  }
  /** A small bell: inharmonic partials, each fading at its own rate. */
  const bell = (f, o = {}) => { const { gain = .12, delay = 0, decay = 1 } = o; [[1, 1, 1.6], [2.76, .45, 1], [5.4, .2, .55], [8.9, .08, .3]].forEach(([m, g, d]) => tone('sine', f*m, f*m, d*decay, { gain:gain*g, delay })); };
  const PITCH = { water:784, fire:880, wind:698.5, light:1046.5 };
  const shots = {
    chime:  () => { bell(659.3, { gain:.13 }); bell(987.8, { gain:.07, delay:.09 }); noise(.5, { type:'highpass', f0:6000, f1:9000, gain:.04 }); },
    sign:   id => {
      bell(PITCH[id], { gain:.11 });
      if (id === 'water') for (let i = 0; i < 3; i++) tone('sine', 500 + i*180, 1300 + i*200, .07, { gain:.05, delay:.06 + i*.07 });
      if (id === 'fire') for (let i = 0; i < 5; i++) noise(.02, { type:'highpass', f0:3000, f1:2500, gain:.08, delay:.03 + i*.05 });
      if (id === 'wind') noise(.5, { f0:600, f1:1800, q:2, gain:.08 });
      if (id === 'light') for (let i = 0; i < 4; i++) tone('sine', 2093 + i*523, 2093 + i*523, .2, { gain:.03, delay:.05 + i*.06 });
    },
    fizzle: () => { noise(.35, { type:'lowpass', f0:1400, f1:200, gain:.3 }); tone('sine', 320, 90, .3, { gain:.12 }); },
    smudge: () => noise(.25, { f0:900, f1:400, q:1.5, gain:.14 }),
    wipe:   () => { noise(.4, { f0:1500, f1:500, q:1, gain:.22 }); noise(.25, { type:'highpass', f0:5000, f1:3000, gain:.06, delay:.05 }); },
    page:   () => { noise(.3, { type:'highpass', f0:3500, f1:1800, gain:.1 }); noise(.18, { f0:700, f1:500, q:2, gain:.08, delay:.12 }); },
    star:   n => bell(880*Math.pow(1.26, n), { gain:.12 }),
    cast:   key => {
      tone('sine', 150, 55, .6, { gain:.32 }); noise(.7, { type:'lowpass', f0:300, f1:3200, gain:.18 });
      const has = id => key.includes(id);
      if (has('water')) { noise(1.8, { type:'lowpass', f0:500, f1:1800, gain:.16, attack:.2 }); for (let i = 0; i < 9; i++) tone('sine', 380 + Math.random()*300, 1100 + Math.random()*600, .06, { gain:.05, delay:.2 + Math.random()*1.6 }); }
      if (has('fire')) { noise(2.2, { type:'lowpass', f0:420, f1:520, gain:.22, attack:.15 }); for (let i = 0; i < 28; i++) noise(.018, { type:'highpass', f0:2800 + Math.random()*2000, f1:2200, gain:.05 + Math.random()*.08, delay:Math.random()*2.6 }); }
      if (has('wind')) { noise(1.2, { f0:350, f1:1500, q:2.5, gain:.2, attack:.25 }); noise(1.4, { f0:1500, f1:450, q:2.5, gain:.16, delay:1.1 }); }
      if (has('light')) { [1046.5, 1318.5, 1568].forEach((f, i) => bell(f, { gain:.09, delay:i*.07, decay:1.8 })); for (let i = 0; i < 10; i++) tone('sine', 2000 + Math.random()*2400, 2600 + Math.random()*1400, .12, { gain:.025, delay:.2 + Math.random()*2 }); }
      if (key === 'water+wind') for (const bt of BOLT_TIMES) { noise(.06, { type:'highpass', f0:4000, f1:2000, gain:.25, delay:bt }); noise(2, { type:'lowpass', f0:160, f1:60, gain:.4, attack:.05, delay:bt + .05 }); }
      if (key === 'fire+water') noise(2.2, { type:'highpass', f0:5000, f1:3500, gain:.12, attack:.3 });   // the hiss of steam
    },
  };
  return { init, update, shot:(name, arg) => { if (ac && shots[name]) shots[name](arg); } };
}

/* ============================== 3. GESTURES ============================== */
/** One Euro filter (Casiez et al.): smooth when slow, responsive when fast. t in seconds. */
class OneEuro {
  constructor({ minCutoff, beta, dCutoff }) { Object.assign(this, { minCutoff, beta, dCutoff }); this.reset(); }
  reset() { this.x = null; this.dx = 0; this.t = 0; }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(1e-3, t - this.t), a = c => 1/(1 + 1/(TAU*c*dt)); this.t = t;
    this.dx += a(this.dCutoff)*((v - this.x)/dt - this.dx);
    this.x += a(this.minCutoff + this.beta*Math.abs(this.dx))*(v - this.x);
    return this.x;
  }
}

/**
 * One hand → { pts, size, center, pinch, nib, open, note }.
 * pinch = thumb–index tip gap × hand size; nib = the point between those tips (steadier than either tip);
 * open = all four fingers out, thumb out and fingers spread: a palm shown to the camera.
 */
function readHand(lm, W, H) {
  const pts = toMirrored(lm, W, H), size = dist(pts[0], pts[9]) || 1;
  const ext = (tip, pip) => dist(pts[tip], pts[0]) > dist(pts[pip], pts[0])*1.1;
  const fingers = [ext(8, 6), ext(12, 10), ext(16, 14), ext(20, 18)];
  const pinch = dist(pts[4], pts[8])/size, thumb = dist(pts[4], pts[5])/size, spread = dist(pts[8], pts[20])/size;
  const open = fingers.every(Boolean) && thumb > .45 && spread > .7 && pinch > .6;
  return { pts, size, pinch, open,
           center:{ x:(pts[0].x + pts[9].x)/2, y:(pts[0].y + pts[9].y)/2 },
           nib:{ x:(pts[4].x + pts[8].x)/2, y:(pts[4].y + pts[8].y)/2 },
           note:`f${fingers.map(Number).join('')} p${pinch.toFixed(2)} t${thumb.toFixed(2)} s${spread.toFixed(2)}${open ? ' OPEN' : ''}` };
}
const nearest = (hands, p, max) => { let best = null, bd = max; for (const h of hands) { const d = dist(h.nib, p); if (d < bd) { bd = d; best = h; } } return best; };

/** The nib: a pinch puts it down, opening lifts it. Follows the same hand while down. update() → 'down' | 'move' | 'up' | null. */
class Pen {
  constructor() { this.down = false; this.hand = null; this.downN = 0; this.upN = 0; this.raw = null; this.pos = null; this.lastSeen = -1e9; this.lastT = -1e9; this.fx = new OneEuro(CONFIG.pen.euro); this.fy = new OneEuro(CONFIG.pen.euro); }
  update(hands, t, sens) {
    const P = CONFIG.pen, on = P.pinchOn*sens, off = P.pinchOff*sens;
    const h = this.down || this.downN ? nearest(hands, this.raw, Infinity) : hands.filter(x => x.pinch < on).sort((a, b) => a.pinch - b.pinch)[0] || null;
    const same = h && (!this.raw || dist(h.nib, this.raw) < h.size*1.5) ? h : null;
    if (!this.down) {
      this.hand = null;
      if (same && same.pinch < on) {
        this.raw = same.nib;
        if (++this.downN >= P.downReadings) {
          this.down = true; this.downN = this.upN = 0; this.hand = same; this.lastSeen = this.lastT = t;
          this.fx.reset(); this.fy.reset(); this.pos = { x:this.fx.filter(same.nib.x, t/1000), y:this.fy.filter(same.nib.y, t/1000) };
          return 'down';
        }
      } else { this.downN = 0; this.raw = null; }
      return null;
    }
    if (!same) { if (t - this.lastSeen > P.lostMs) return this.lift(); return null; }
    this.hand = same; this.raw = same.nib; this.lastSeen = this.lastT = t;
    if (same.pinch > off) { if (++this.upN >= P.upReadings) return this.lift(); return null; }   // fingers parting: don't draw the gap opening
    this.upN = 0;
    this.pos = { x:this.fx.filter(same.nib.x, t/1000), y:this.fy.filter(same.nib.y, t/1000) };
    return 'move';
  }
  lift() { this.down = false; this.hand = null; this.raw = null; this.upN = this.downN = 0; return 'up'; }
}

/**
 * An open palm: held still it charges the sigil, then a push toward the camera (the hand grows on screen) casts.
 * A push that starts a little before the charge is full still counts.
 * A fast sideways swipe wipes the page. Latches after a cast until the palm closes or leaves.
 */
class Palm {
  constructor() { this.prev = null; this.vx = 0; this.speed = 0; this.size = 0; this.size0 = 0; this.chargeT = null; this.fullT = null; this.latched = false; this.wipeT = null; this.lastWipe = -1e9; this.hand = null; this.charge = 0; }
  update(hands, pen, t, ready, W) {
    const P = CONFIG.palm, out = { cast:false, wipe:false };
    const open = hands.filter(h => h !== pen.hand && h.open);
    let h = this.prev ? open.find(x => dist(x.center, this.prev.c) < x.size*2) : null;
    if (!h) h = open[0] || null;
    if (!h) { this.prev = this.hand = null; this.latched = false; this.chargeT = this.fullT = null; this.charge = 0; this.speed = 0; return out; }
    if (this.prev && t > this.prev.t) {
      const dt = (t - this.prev.t)/1000, vx = (h.center.x - this.prev.c.x)/h.size/dt, vy = (h.center.y - this.prev.c.y)/h.size/dt;
      this.vx = this.vx*.4 + vx*.6; this.speed = this.speed*.5 + .5*Math.hypot(vx, vy);
      if (Math.abs(this.vx) > P.wipeSpeed) {
        if (this.wipeT === null || Math.sign(this.vx) !== this.wipeDir) { this.wipeT = t; this.wipeX = this.prev.c.x; this.wipeDir = Math.sign(this.vx); }
        if (Math.abs(h.center.x - this.wipeX) > P.wipeTravel*W && t - this.lastWipe > 1000) { out.wipe = true; this.lastWipe = t; this.wipeT = null; }
      } else this.wipeT = null;
    }
    this.size = this.prev ? this.size*.6 + h.size*.4 : h.size;
    this.prev = { c:{ ...h.center }, t }; this.hand = h;
    if (!ready || this.latched || out.wipe || t - pen.lastT < P.penGraceMs) { this.chargeT = this.fullT = null; this.charge = 0; return out; }
    const still = this.speed < P.stillSpeed;
    if (this.chargeT === null) { if (still) { this.chargeT = t; this.size0 = this.size; } }   // the push is measured from the hand's size when charging began
    else if (!still && this.charge < 1) this.chargeT = null;            // moved before it charged: start again
    this.charge = this.chargeT === null ? 0 : clamp((t - this.chargeT)/P.chargeMs, 0, 1);
    if (this.charge >= 1) {
      if (this.fullT === null) this.fullT = t;
      if (this.size > this.size0*(1 + P.push) || t - this.fullT > P.autoCastMs) { out.cast = true; this.latched = true; this.charge = 0; this.chargeT = this.fullT = null; }
    }
    return out;
  }
}

/* ============================== 4. SIGIL ============================== */
const mix = (a, b, k) => { const p = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16)); const A = p(a), B = p(b); return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i], k))).join(',')})`; };

/** A ring and the signs inside it. The ring keeps a little of the hand's wobble so it still looks inked. */
class Sigil {
  /** at = { c, R } to snap onto (the Apprentice guide), otherwise the drawn circle. */
  constructor(fit, pts, t, at) {
    this.c = at ? at.c : fit.c; this.r = at ? at.R : fit.r;
    const w = fit.wobble, n = w.length;
    this.wobble = w.map((_, i) => (w[(i + n - 2) % n] + w[(i + n - 1) % n] + w[i] + w[(i + 1) % n] + w[(i + 2) % n])/5);
    this.from = resample(pts, 96); this.fromC = fit.c;
    this.born = t; this.signs = []; this.state = 'open'; this.alpha = 1; this.castT = 0; this.phase = Math.random()*TAU;
  }
  get ready() { return this.state === 'open' && this.signs.length > 0; }
  radiusAt(a) {
    const n = this.wobble.length, f = (((a % TAU) + TAU) % TAU)/TAU*n, i = Math.floor(f) % n, k = f - Math.floor(f);
    return this.r*(1 + (this.wobble[i]*(1 - k) + this.wobble[(i + 1) % n]*k)*CONFIG.ring.keepWobble);
  }
  /** Ring outline with nib widths (a broad nib: thicker on two sides). snap 0..1 morphs from the drawn stroke. */
  ringPoints(u, snap = 1, n = 96) {
    const pts = [], base = u*CONFIG.ring.width;
    for (let i = 0; i <= n; i++) {
      const a = i/n*TAU, w = base*(1 + .45*Math.sin(2*a + this.phase));
      let x = this.c.x + Math.cos(a)*this.radiusAt(a), y = this.c.y + Math.sin(a)*this.radiusAt(a);
      if (snap < 1) {                                                    // from the stroke's point at the same angle around its own centre
        const f = this.from[i % n], fa = Math.atan2(f.y - this.fromC.y, f.x - this.fromC.x);
        const tx = this.c.x + Math.cos(fa)*this.radiusAt(fa), ty = this.c.y + Math.sin(fa)*this.radiusAt(fa);
        x = lerp(f.x, tx, snap); y = lerp(f.y, ty, snap);
      }
      pts.push({ x, y, w });
    }
    return pts;
  }
}

/* ============================== 5. PANEL ============================== */
const SETTINGS_KEY = 'track-lab:sigil:settings';
const SAVED = ['vol', 'sfxVol', 'mute', 'wash', 'sens', 'reduce', 'skel'];
const signSvg = id => { const p = signPath(id).filter((_, i) => i % 3 === 0).map(q => `${(q.x*15 + 20).toFixed(1)},${(q.y*15 + 20).toFixed(1)}`).join(' '); return `<svg viewBox="0 0 40 40" aria-hidden="true"><polyline points="${p}"/></svg>`; };

class Panel {
  constructor() {
    this.app = $('app'); this.toastT = 0;
    if (matches('(prefers-reduced-motion: reduce)')) $('reduce').checked = true;
    this.restore();
    for (const id of SAVED) { $(id).addEventListener('input', () => this.save()); $(id).addEventListener('change', () => this.save()); }
    $('setBtn').addEventListener('click', () => this.toggleSheet());
    $('sheetClose').addEventListener('click', () => this.toggleSheet(false));
    if (canFullscreen()) $('fsBtn').addEventListener('click', toggleFullscreen); else $('fsBtn').hidden = true;
    $('grimoire').innerHTML = SIGN_IDS.map(id => `<li data-id="${id}" style="--el:${ELEMENTS[id].ink}">${signSvg(id)}<span>${ELEMENTS[id].name}</span></li>`).join('');
  }
  restore() {
    let s = {}; try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* defaults */ }
    for (const id of SAVED) if (id in s) { const el = $(id); if (el.type === 'checkbox') el.checked = !!s[id]; else el.value = s[id]; }
  }
  save() {
    const s = {}; for (const id of SAVED) { const el = $(id); s[id] = el.type === 'checkbox' ? el.checked : el.value; }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
  }
  toggleSheet(force) { const on = force ?? !this.app.classList.contains('sheet-open'); this.app.classList.toggle('sheet-open', on); }
  levels() { return { master:$('mute').checked ? 0 : $('vol').value/100, sfx:$('sfxVol').value/100 }; }
  controls() { return { reduce:$('reduce').checked, skeleton:$('skel').checked, wash:$('wash').value/100, sens:lerp(.8, 1.3, $('sens').value/100) }; }
  setMode(mode) {
    this.app.classList.toggle('apprentice', mode === 'apprentice');
    $('modeFree').setAttribute('aria-pressed', mode === 'free'); $('modeLesson').setAttribute('aria-pressed', mode === 'apprentice');
  }
  setLesson(i, best) {
    const L = LESSONS[i];
    $('lessonName').textContent = `${i + 1}. ${L.title}`;
    $('lessonStars').innerHTML = [1, 2, 3].map(k => `<i class="${k <= (best || 0) ? 'on' : ''}">★</i>`).join('');
    $('lessonStars').setAttribute('aria-label', `best: ${best || 0} of 3 stars`);
  }
  /** Highlight the signs the current sigil holds (used) or the lesson needs (need). */
  setGrimoire(need, used) {
    const key = [...need].join() + '|' + [...used].join(); if (key === this.gKey) return; this.gKey = key;
    for (const li of $('grimoire').children) { li.classList.toggle('need', need.has(li.dataset.id)); li.classList.toggle('used', used.has(li.dataset.id)); }
  }
  toast(text, ms = 2600) {
    const el = $('toast'); el.textContent = text; el.classList.add('on');
    clearTimeout(this.toastT); this.toastT = setTimeout(() => el.classList.remove('on'), ms);
  }
  setHint(show) { this.app.classList.toggle('hint-on', show); }
  setCasting(on) { this.app.classList.toggle('charged', on); }
  showResult(r, onStar) {
    $('resTitle').textContent = r.title;
    $('resAcc').textContent = Math.round(r.acc*100) + '%';
    $('resTime').textContent = r.time.toFixed(1) + ' s' + (r.slow ? ' (over par)' : '');
    $('resNote').textContent = r.isBest ? 'A new best for this lesson.' : r.stars === 3 ? 'Flawless.' : r.acc < .5 ? 'Stay closer to the gold guide.' : 'Trace a little more carefully for the next star.';
    const stars = $('resStars'); stars.innerHTML = [1, 2, 3].map(() => '<i>★</i>').join(''); stars.setAttribute('aria-label', `${r.stars} of 3 stars`);
    clearTimeout(this.toastT); $('toast').classList.remove('on');
    $('result').hidden = false; requestAnimationFrame(() => $('result').classList.add('on'));
    [...stars.children].forEach((el, k) => { if (k < r.stars) setTimeout(() => { el.classList.add('on'); onStar(k); }, 350 + k*260); });
  }
  hideResult() { $('result').classList.remove('on'); $('result').hidden = true; }
  get resultShown() { return !$('result').hidden; }
  setDebug(text) { const d = $('debug'); if (d.textContent !== text) d.textContent = text; }
  setError(text) { $('err').textContent = text; }
  showStage() { this.app.classList.add('running'); }
}

/* ============================== 6. APP ============================== */
class App {
  constructor() {
    this.canvas = $('canvas'); this.ctx = this.canvas.getContext('2d'); this.video = $('video');
    this.panel = new Panel();
    this.sound = createSound(() => this.panel.levels());
    this.apprentice = new Apprentice();
    this.pen = new Pen(); this.palm = new Palm(); this.palmOut = { cast:false, wipe:false };
    this.hands = []; this.pending = null; this.running = false; this.noCamera = false; this.lastT = 0; this.t = 0;
    this.active = null; this.mouse = false; this.doodles = []; this.smudges = []; this.splashes = []; this.spells = []; this.sigil = null; this.fading = [];
    this.title = null; this.flash = 0; this.mode = 'free'; this.ringsMade = 0; this.lessonCast = false;
    this.paper = makePaper(); this.paperPat = null; this.W = 1280; this.H = 720;
    this.ctl = this.panel.controls();
    this.panel.setMode('free'); this.panel.setLesson(0, this.apprentice.best[0]); this.panel.setHint(true);

    $('start').addEventListener('click', () => this.start());
    $('noCam').addEventListener('click', () => this.start(true));
    $('modeFree').addEventListener('click', () => this.setMode('free'));
    $('modeLesson').addEventListener('click', () => this.setMode('apprentice'));
    $('prevLesson').addEventListener('click', () => this.goLesson(this.apprentice.i - 1));
    $('nextLesson').addEventListener('click', () => this.goLesson(this.apprentice.i + 1));
    $('clearBtn').addEventListener('click', () => this.wipe());
    $('resAgain').addEventListener('click', () => this.goLesson(this.apprentice.i));
    $('resNext').addEventListener('click', () => this.goLesson(this.apprentice.i + 1));
    this.bindPointer();
    addEventListener('keydown', e => {
      if (e.target.closest && e.target.closest('input, select, textarea, button, a')) return;
      if (e.key === ' ' && this.running) { e.preventDefault(); this.cast(); }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && this.running) this.wipe();
      else if (e.key === 'Escape') this.panel.toggleSheet(false);
      else if (this.mode === 'apprentice' && e.key === 'ArrowRight') this.goLesson(this.apprentice.i + 1);
      else if (this.mode === 'apprentice' && e.key === 'ArrowLeft') this.goLesson(this.apprentice.i - 1);
    });
  }

  get u() { return Math.min(this.W, this.H); }

  /** Start the camera and tracker (or, with noCamera, just the page: draw with a mouse or a finger). */
  async start(noCamera = false) {
    this.sound.init();
    $('start').disabled = true; $('start').textContent = 'Uncapping…'; this.panel.setError('');
    if (document.fonts) { document.fonts.load('italic 600 48px "Cormorant Garamond"'); document.fonts.load('48px "IM Fell English"'); }
    try {
      if (noCamera) { this.noCamera = true; this.resizePage(); addEventListener('resize', () => this.resizePage()); }
      else this.tracking = await startHands({ video:this.video, options:CONFIG.tracker.options, onResults:(res, t) => { this.pending = { res, t }; } });
      this.panel.showStage();
      if (!this.running) { this.running = true; this.lastT = performance.now(); requestAnimationFrame(this.frame); }
    } catch (e) {
      this.panel.setError('Could not start the camera: ' + (e.message || e) + '. Allow camera access and try again, or draw with your mouse instead.');
      $('start').disabled = false; $('start').textContent = 'Uncap the ink';
    }
  }
  resizePage() { const k = 1280/Math.max(innerWidth, innerHeight); this.pageSize = [Math.round(innerWidth*k), Math.round(innerHeight*k)]; }

  frame = now => {
    requestAnimationFrame(this.frame);
    const v = this.video;
    if (!this.noCamera && !v.videoWidth) return;
    const [W, H] = this.noCamera ? this.pageSize : [v.videoWidth, v.videoHeight];
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this.W = W; this.H = H; this.fitCamera(W, H);
    const dt = clamp((now - this.lastT)/1000, .001, .05); this.lastT = now; this.t += dt;
    this.ctl = this.panel.controls();
    if (this.pending) { this.ingest(this.pending, W, H); this.pending = null; }
    this.update(dt);
    this.render(W, H);
  };

  /* ---------- input ---------- */
  ingest({ res, t }, W, H) {
    this.hands = (res.multiHandLandmarks || []).map(lm => readHand(lm, W, H));
    if (!this.mouse) {
      const ev = this.pen.update(this.hands, t, this.ctl.sens);
      if (ev === 'down') this.penDown(this.pen.pos); else if (ev === 'move') this.penMove(this.pen.pos); else if (ev === 'up') this.penUp();
    }
    this.palmOut = this.palm.update(this.hands, this.pen, t, this.canCharge, W);
    if (this.palmOut.wipe) this.wipe();
    if (this.palmOut.cast) this.cast();
    this.panel.setDebug(this.hands.map((h, i) => `H${i + 1} ${h.note}`).join('   ') || 'no hands');
  }

  bindPointer() {
    const stage = document.querySelector('.stage');
    stage.addEventListener('pointerdown', e => {
      if (!this.running || this.pen.down || e.button > 0) return;
      this.panel.toggleSheet(false);
      stage.setPointerCapture(e.pointerId); this.mouse = true; this.penDown(this.toCanvas(e));
    });
    stage.addEventListener('pointermove', e => { if (this.mouse) this.penMove(this.toCanvas(e)); });
    const up = () => { if (this.mouse) { this.mouse = false; this.penUp(); } };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  }
  /** Screen → canvas pixels (the canvas is object-fit: cover, or contain when the whole picture is shown). */
  toCanvas(e) {
    const r = this.canvas.getBoundingClientRect(), W = this.canvas.width, H = this.canvas.height;
    const s = (this.whole ? Math.min : Math.max)(r.width/W, r.height/H), ox = r.left + (r.width - W*s)/2, oy = r.top + (r.height - H*s)/2;
    return { x:(e.clientX - ox)/s, y:(e.clientY - oy)/s };
  }

  penDown(p) {
    if (this.panel.resultShown) return;
    const P = CONFIG.pen, u = this.u;
    this.active = new Stroke(u*P.nib, u*P.minStep, u*P.speedRef); this.active.add(p.x, p.y, this.t);
    if (this.mode === 'apprentice' && this.apprentice.t0 === null) this.apprentice.t0 = this.t;
  }
  penMove(p) { if (this.active) this.active.add(p.x, p.y, this.t); }
  penUp() { const s = this.active; this.active = null; if (s) this.finish(s.pts); }

  /* ---------- what a finished stroke is ---------- */
  finish(pts) {
    const u = this.u, R = CONFIG.ring, S = CONFIG.sign, sig = this.sigil && this.sigil.state === 'open' ? this.sigil : null, lesson = this.mode === 'apprentice';
    if (pathLength(pts) < u*.035) { if (lesson) this.smudge(pts); else this.doodles.push({ pts, born:this.t }); return; }
    const fit = fitRing(pts);
    const ringOk = fit.r >= u*R.minR && fit.sd <= R.maxSd && fit.sweep >= R.minSweep && fit.gap <= R.maxGap;
    if (sig && this.insideShare(pts, sig) >= S.inside) return this.addSign(sig, pts);
    if (ringOk) return this.addRing(fit, pts);
    const rec = recognize(pts);
    if (rec.ok) { this.smudge(pts); this.panel.toast(lesson ? 'Trace the circle first, then the signs inside it.' : 'First a circle, then the sign inside it.'); return; }
    if (fit.sweep >= R.trySweep && fit.r >= u*R.minR && fit.sd < R.trySd) {
      this.splashes.push(new Splash(pts, u)); this.smudges.push({ pts, t0:this.t }); this.sound.shot('fizzle');
      this.panel.toast(fit.gap > R.maxGap ? 'The circle has to close.' : 'Rounder. The circle has to be round.');
      return;
    }
    if (lesson) this.smudge(pts); else this.doodles.push({ pts, born:this.t });
  }
  insideShare(pts, sig) { let k = 0; for (const p of pts) if (dist(p, sig.c) < sig.r*1.08) k++; return k/pts.length; }

  addRing(fit, pts) {
    let at = null;
    if (this.mode === 'apprentice') {
      if (this.apprentice.ringAcc !== null && this.sigil) { this.smudge(pts); this.panel.toast('This lesson has its circle. Now the signs.'); return; }
      const g = this.apprentice.guide(this.W, this.H);
      if (dist(fit.c, g.c) > g.R*.55 || Math.abs(fit.r/g.R - 1) > .45) { this.smudge(pts); this.panel.toast('Trace the gold circle.'); return; }
      this.apprentice.scoreRing(pts, g); at = g;
    }
    if (this.sigil) this.retire(this.sigil);
    this.sigil = new Sigil(fit, pts, this.t, at); this.ringsMade++;
    this.sound.shot('chime');
  }

  addSign(sig, pts) {
    const S = CONFIG.sign, xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    if (sig.signs.length >= S.max) { this.smudge(pts); this.panel.toast('A circle holds two signs at most. Cast it, or wipe the page.'); return; }
    if (Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < sig.r*S.minSize) { this.smudge(pts); this.panel.toast('Draw the sign bigger.'); return; }
    const rec = recognize(pts);
    if (!rec.ok) { this.smudge(pts); this.panel.toast('That sign didn’t take. Try a wave, a triangle, a spiral or a star.'); return; }
    if (this.mode === 'apprentice') {
      const slot = this.apprentice.slotFor(rec.id, pts);
      if (!slot) { this.smudge(pts); this.panel.toast(`That’s ${ELEMENTS[rec.id].name}. This lesson needs ${this.apprentice.slots.filter(s => s.acc === null).map(s => ELEMENTS[s.id].name).join(' and ')}.`); return; }
      this.apprentice.scoreSign(slot, pts);
      if (this.apprentice.complete) this.panel.toast('Now open your palm and push to cast.', 3500);
    }
    sig.signs.push({ id:rec.id, pts, t:this.t });
    this.sound.shot('sign', rec.id);
  }

  smudge(pts) { this.smudges.push({ pts, t0:this.t }); this.sound.shot('smudge'); }
  retire(sig) { if (sig.state === 'open') { sig.state = 'retired'; this.fading.push(sig); } }

  get canCharge() {
    if (this.mode === 'apprentice') return this.panel.resultShown || !!(this.sigil && this.sigil.ready && this.apprentice.complete);
    return !!(this.sigil && this.sigil.ready);
  }

  /** Open palm + push (or space): the sigil comes alive. In a finished lesson it moves on to the next one. */
  cast() {
    if (this.mode === 'apprentice' && this.panel.resultShown) return this.goLesson(this.apprentice.i + 1);
    const s = this.sigil;
    if (!s || s.state !== 'open') return;
    if (!s.signs.length) { this.panel.toast('Draw a sign inside the circle first.'); return; }
    if (this.mode === 'apprentice' && !this.apprentice.complete) { this.panel.toast('Finish tracing the sigil first.'); return; }
    s.state = 'cast'; s.castT = this.t;
    const ids = s.signs.map(g => g.id), u = this.u;
    const spell = new Spell(ids, s.c, s.r, { reduce:this.ctl.reduce, dur:CONFIG.spell.dur, lines:[s.ringPoints(u), ...s.signs.map(g => g.pts)] });
    this.spells.push(spell); this.sound.shot('cast', spellKey(ids));
    const above = s.c.y - s.r*1.4 > u*.14;
    this.title = { text:spell.name, t0:this.t, x:s.c.x, y:above ? s.c.y - s.r*1.4 : s.c.y + s.r*1.55 };
    if (this.mode === 'apprentice') { this.apprentice.finish(this.t - this.apprentice.t0); this.lessonCast = true; }
  }

  /** Clear the page (palm swipe, the clear button or Backspace). In a lesson it starts the lesson again. */
  wipe() {
    if (this.mode === 'apprentice' && this.panel.resultShown) return;
    const had = this.doodles.length || this.sigil || this.active;
    for (const d of this.doodles) this.smudges.push({ pts:d.pts, t0:this.t });
    this.doodles = [];
    if (this.sigil && this.sigil.state === 'open') { this.retire(this.sigil); this.sigil = null; }
    if (this.mode === 'apprentice') { this.apprentice.reset(); this.sigil = null; }
    if (had) { this.sound.shot('wipe'); this.panel.toast('Page wiped clean.', 1400); }
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode; this.panel.setMode(mode);
    this.clearPage();
    if (mode === 'apprentice') this.goLesson(this.apprentice.i);
    else { this.panel.hideResult(); this.panel.setHint(this.ringsMade === 0); }
  }
  goLesson(i) {
    this.apprentice.go(i); this.clearPage(); this.panel.hideResult(); this.lessonCast = false;
    this.panel.setLesson(this.apprentice.i, this.apprentice.best[this.apprentice.i]);
    this.sound.shot('page');
  }
  clearPage() {
    for (const d of this.doodles) this.smudges.push({ pts:d.pts, t0:this.t });
    this.doodles = []; this.active = null; if (this.sigil) this.retire(this.sigil); this.sigil = null;
  }

  /* ---------- per frame ---------- */
  update(dt) {
    const t = this.t;
    for (const sp of this.spells) sp.update(dt);
    this.spells = this.spells.filter(sp => !sp.done);
    for (const s of this.splashes) s.update(dt);
    this.splashes = this.splashes.filter(s => !s.done);
    this.smudges = this.smudges.filter(s => t - s.t0 < .6);
    this.doodles = this.doodles.filter(d => t - d.born < CONFIG.doodle.life + 1.5);
    const s = this.sigil;
    if (s && s.state === 'cast' && t - s.castT > CONFIG.spell.dur*.7) { s.alpha -= dt/.8; if (s.alpha <= 0) this.sigil = null; }
    for (const f of this.fading) f.alpha -= dt/.5;
    this.fading = this.fading.filter(f => f.alpha > 0);
    this.flash = Math.max(...this.spells.map(sp => sp.flash), 0);
    if (this.title && t - this.title.t0 > CONFIG.spell.title) this.title = null;
    // a cast lesson shows its grade once the spell has played out
    if (this.mode === 'apprentice' && this.lessonCast && !this.spells.some(sp => sp.t < sp.dur) && !this.panel.resultShown) {
      this.lessonCast = false;
      this.panel.showResult(this.apprentice.result, k => this.sound.shot('star', k));
      this.panel.setLesson(this.apprentice.i, this.apprentice.best[this.apprentice.i]);
    }
    const speed = this.active && this.active.pts.length > 1 ? this.active.speed/(this.u*CONFIG.pen.speedRef) : 0;
    this.sound.update(this.active ? clamp(.25 + speed, 0, 1) : 0, this.palm.charge);
    this.panel.setCasting(this.palm.charge >= 1);
    this.panel.setHint(this.mode === 'free' && this.ringsMade === 0 && !this.active);
    const need = new Set(this.mode === 'apprentice' ? this.apprentice.lesson.signs : []);
    this.panel.setGrimoire(need, new Set(s ? s.signs.map(g => g.id) : []));
  }

  /** Fill the screen unless that would cut off much of the camera; then show the whole picture. */
  fitCamera(W, H) {
    const r = this.canvas.getBoundingClientRect(), a = W/H, b = r.width/r.height;
    const whole = r.width > 0 && Math.min(a, b)/Math.max(a, b) < CONFIG.view.wholeBelow;
    if (whole !== this.whole) { this.whole = whole; this.canvas.classList.toggle('whole', whole); }
  }

  render(W, H) {
    const ctx = this.ctx, u = this.u, t = this.t, ink = CONFIG.colors.ink;
    // 0. the page: the camera washed into parchment
    this.page(ctx, W, H, u);
    // 1. under the ink: watercolour, scorch, clouds
    for (const sp of this.spells) sp.renderUnder(ctx);
    // 2. the Apprentice guide, doodles, smudges, sigils, the stroke being drawn
    if (this.mode === 'apprentice' && !this.panel.resultShown) this.drawGuide(ctx, u, t);
    for (const d of this.doodles) drawInk(ctx, d.pts, { color:ink, alpha:clamp((d.born + CONFIG.doodle.life + 1.5 - t)/1.5, 0, 1), wet:.4 });
    for (const s of this.smudges) { const k = (t - s.t0)/.6; drawInk(ctx, s.pts, { color:ink, alpha:(1 - k)*.8, scale:1 + k*1.8 }); }
    for (const f of this.fading) this.drawSigil(ctx, f, u, t);
    if (this.sigil) this.drawSigil(ctx, this.sigil, u, t);
    if (this.active) drawInk(ctx, this.active.pts, { color:ink, wet:.6 });
    for (const s of this.splashes) s.render(ctx, ink);
    // 3. above the ink: the spells themselves, the charge, the nibs
    for (const sp of this.spells) sp.renderOver(ctx);
    this.drawCharge(ctx, u, t);
    this.drawNibs(ctx, u);
    if (this.title) this.drawTitle(ctx, u, t);
    // 4. lightning flash, tracking skeleton
    if (this.flash > 0) { ctx.fillStyle = `rgba(240,246,255,${this.flash})`; ctx.fillRect(0, 0, W, H); }
    if (this.ctl.skeleton) drawSkeleton(ctx, this.hands, CONFIG.colors.ink, .5);
  }

  page(ctx, W, H, u) {
    if (this.noCamera) { ctx.fillStyle = CONFIG.colors.paper; ctx.fillRect(0, 0, W, H); }
    else {
      drawMirroredVideo(ctx, this.video, W, H);
      ctx.save();
      ctx.globalCompositeOperation = 'saturation'; ctx.globalAlpha = .88; ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, W, H);   // drain the colour…
      ctx.globalCompositeOperation = 'color'; ctx.globalAlpha = .5; ctx.fillStyle = '#9a7444'; ctx.fillRect(0, 0, W, H);          // …sepia…
      ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = lerp(.92, .25, this.ctl.wash); ctx.fillStyle = CONFIG.colors.paper; ctx.fillRect(0, 0, W, H);   // …and wash it into the page
      ctx.restore();
    }
    ctx.save(); ctx.globalCompositeOperation = 'multiply';
    if (!this.paperPat) this.paperPat = ctx.createPattern(this.paper, 'repeat');
    ctx.fillStyle = this.paperPat; ctx.fillRect(0, 0, W, H);
    const vg = ctx.createRadialGradient(W/2, H/2, u*.45, W/2, H/2, Math.hypot(W, H)*.62);
    vg.addColorStop(0, 'rgba(255,255,255,0)'); vg.addColorStop(1, 'rgba(150,108,60,.5)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  drawGuide(ctx, u, t) {
    const g = this.apprentice.guide(this.W, this.H), gold = CONFIG.colors.gold, a = .75 + .2*Math.sin(t*3);
    ctx.save(); ctx.strokeStyle = gold; ctx.fillStyle = gold; ctx.lineWidth = Math.max(2, u*.006); ctx.lineCap = 'round';
    ctx.setLineDash([u*.002, u*.016]); ctx.globalAlpha = a;
    const fs = Math.max(12, u*.03); ctx.font = `italic 600 ${fs}px "Cormorant Garamond", Georgia, serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (this.apprentice.ringAcc === null) {
      ctx.beginPath(); ctx.arc(g.c.x, g.c.y, g.R, 0, TAU); ctx.stroke();
      ctx.fillText('1', g.c.x - g.R*.78, g.c.y - g.R*.78);
    }
    g.slots.forEach((s, k) => {
      if (s.acc !== null) return;
      const p = placeSign(s.id, s.c, s.s);
      ctx.beginPath(); p.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.stroke();
      ctx.fillText(String(k + 2), s.c.x - s.s*1.05, s.c.y - s.s*1.05);
    });
    ctx.restore();
  }

  drawSigil(ctx, s, u, t) {
    const R = CONFIG.ring, ink = CONFIG.colors.ink, gold = CONFIG.colors.gold, age = t - s.born;
    const snap = ease(age/R.snap), decor = ease((age - R.snap)/R.decor);
    const tint = s.state === 'cast' ? ease((t - s.castT)/.4) : 0, el = s.signs.length ? ELEMENTS[s.signs[0].id] : null;
    const color = el && tint ? mix(ink, el.ink, tint) : ink;
    ctx.save(); ctx.globalAlpha = clamp(s.alpha, 0, 1);
    // recognized signs: the paper glows pale around them (screen), and their ink takes on the element's colour
    ctx.globalCompositeOperation = 'screen';
    for (const g of s.signs) drawInk(ctx, g.pts, { color:'#fff8e6', alpha:.5 + .12*Math.sin(t*4 + g.t), scale:3.6 });
    ctx.globalCompositeOperation = 'source-over';
    drawInk(ctx, s.ringPoints(u, snap), { color, wet:.5 });
    if (decor > 0) {                                                    // the gold inner ring draws itself, then the ticks appear
      ctx.strokeStyle = gold; ctx.fillStyle = gold; ctx.lineWidth = Math.max(1, u*.0022); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(s.c.x, s.c.y, s.r*.87, -Math.PI/2, -Math.PI/2 + TAU*decor); ctx.stroke();
      for (let k = 0; k < 12; k++) if (decor > k/12) {
        const a = -Math.PI/2 + k*TAU/12, r0 = s.r*.88, r1 = s.r*(k % 3 ? .93 : .96);
        ctx.beginPath(); ctx.moveTo(s.c.x + Math.cos(a)*r0, s.c.y + Math.sin(a)*r0); ctx.lineTo(s.c.x + Math.cos(a)*r1, s.c.y + Math.sin(a)*r1); ctx.stroke();
      }
      for (let k = 0; k < 4; k++) if (decor > .5 + k/8) {
        const a = Math.PI/4 + k*Math.PI/2, d = s.r*1.09, x = s.c.x + Math.cos(a)*d, y = s.c.y + Math.sin(a)*d, z = u*.006;
        ctx.beginPath(); ctx.moveTo(x, y - z); ctx.lineTo(x + z*.6, y); ctx.lineTo(x, y + z); ctx.lineTo(x - z*.6, y); ctx.closePath(); ctx.fill();
      }
    }
    for (const g of s.signs) drawInk(ctx, g.pts, { color:mix(ink, ELEMENTS[g.id].ink, .55 + .45*tint), wet:.4 });
    if (s.signs.length && s.state !== 'cast') {                         // the signs' names, small, under the ring
      const fs = Math.max(12, u*.03);
      ctx.font = `italic 600 ${fs}px "Cormorant Garamond", Georgia, serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = ink; ctx.globalAlpha *= .8;
      ctx.fillText(s.signs.map(g => ELEMENTS[g.id].name).join('  ·  '), s.c.x, s.c.y + s.r*1.16);
    }
    ctx.restore();
  }

  /** The palm charging: a gold arc filling round the sigil, motes streaming from the palm into it. */
  drawCharge(ctx, u, t) {
    const ch = this.palm.charge, h = this.palm.hand; if (ch <= 0 || !h) return;
    const gold = CONFIG.colors.gold, s = this.sigil && this.sigil.ready ? this.sigil : null;
    ctx.save(); ctx.lineCap = 'round';
    if (s) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(s.c.x, s.c.y, s.r*.7, s.c.x, s.c.y, s.r*1.35);
      g.addColorStop(0, 'rgba(255,214,130,0)'); g.addColorStop(.5, `rgba(255,214,130,${.28*ch})`); g.addColorStop(1, 'rgba(255,214,130,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.c.x, s.c.y, s.r*1.35, 0, TAU); ctx.fill();
      for (let k = 0; k < 14; k++) {                                     // motes flowing palm → sigil
        const f = (k/14 + t*.9) % 1, x = lerp(h.center.x, s.c.x, f), y = lerp(h.center.y, s.c.y, f) - Math.sin(f*Math.PI)*u*.05;
        ctx.fillStyle = `rgba(255,220,140,${.8*ch*Math.sin(f*Math.PI)})`; ctx.beginPath(); ctx.arc(x, y, u*.005, 0, TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = gold; ctx.lineWidth = Math.max(2, u*.006);
      ctx.beginPath(); ctx.arc(s.c.x, s.c.y, s.r*1.17, -Math.PI/2, -Math.PI/2 + TAU*ch); ctx.stroke();
    }
    const pulse = ch >= 1 ? 1 + .12*Math.sin(t*14) : 1;                 // charged: the palm ring throbs, waiting for the push
    ctx.strokeStyle = gold; ctx.lineWidth = Math.max(2, u*.005); ctx.globalAlpha = .85;
    ctx.beginPath(); ctx.arc(h.center.x, h.center.y, h.size*.75*pulse, -Math.PI/2, -Math.PI/2 + TAU*ch); ctx.stroke();
    if (ch >= 1) {
      const fs = Math.max(13, u*.032); ctx.font = `italic 600 ${fs}px "Cormorant Garamond", Georgia, serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = CONFIG.colors.ink; ctx.fillText(this.panel.resultShown ? 'push for the next lesson' : 'push!', h.center.x, h.center.y - h.size*1.05);
    }
    ctx.restore();
  }

  /** Where each hand's nib is: an ink drop when drawing, a gold ring that tightens as the pinch closes. */
  drawNibs(ctx, u) {
    const sens = this.ctl.sens, P = CONFIG.pen;
    ctx.save(); ctx.lineWidth = Math.max(1.5, u*.003);
    for (const h of this.hands) {
      if (h === this.palm.hand && this.palm.charge > 0) continue;
      if (h === this.pen.hand && this.pen.down && this.pen.pos) {
        const p = this.pen.pos;
        ctx.fillStyle = CONFIG.colors.ink; ctx.beginPath(); ctx.arc(p.x, p.y, u*.006, 0, TAU); ctx.fill();
        ctx.strokeStyle = CONFIG.colors.gold; ctx.beginPath(); ctx.arc(p.x, p.y, u*.013, 0, TAU); ctx.stroke();
      } else {
        const k = clamp((h.pinch - P.pinchOn*sens)/(1 - P.pinchOn*sens), 0, 1);
        ctx.strokeStyle = `rgba(200,150,62,${.85 - .45*k})`;
        ctx.beginPath(); ctx.arc(h.nib.x, h.nib.y, u*(.01 + .02*k), 0, TAU); ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawTitle(ctx, u, t) {
    const T = this.title, k = t - T.t0, a = ease(k/.3)*clamp((CONFIG.spell.title - k)/.6, 0, 1); if (a <= 0) return;
    const fs = Math.max(26, u*.085);
    ctx.save(); ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `italic 600 ${fs}px "Cormorant Garamond", Georgia, serif`;
    ctx.fillStyle = 'rgba(239,227,200,.85)'; ctx.fillText(T.text, T.x + 1.5, T.y + 1.5);       // a paper-coloured halo keeps it readable over effects
    ctx.fillStyle = CONFIG.colors.ink; ctx.fillText(T.text, T.x, T.y);
    const w = ctx.measureText(T.text).width*.6*ease(k/.6), y = T.y + fs*.62;   // a gold flourish drawn under the word
    ctx.strokeStyle = CONFIG.colors.gold; ctx.lineWidth = Math.max(1.5, u*.003); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(T.x - w, y); ctx.bezierCurveTo(T.x - w*.3, y + fs*.18, T.x + w*.3, y - fs*.18, T.x + w, y); ctx.stroke();
    ctx.restore();
  }
}

window.sigil = new App();   // handle for poking at it from the console
