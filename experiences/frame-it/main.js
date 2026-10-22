/* =============================================================================
   FRAME IT
   -----------------------------------------------------------------------------
   An instant camera made of your fingers. Two L-shaped hands make a director's frame;
   inside it the world turns into another lens; tilting the frame like a dial switches
   lens; pinching one hand (the other keeps its corner) takes a polaroid.

   1. Config       every tunable number in one place
   2. Sound        WebAudio synth: shutter, film advance, lens boot / switch, printer motor, lens hum
   3. Gestures     landmarks → hand reading (L, thumb–index gap)
   4. Frame        director's-frame quad with smoothing, one-hand snap, tilt dial
   5. Panel        lens dial, viewfinder readouts, hint, settings sheet
   6. App          tracking, main loop, render order

   Render: mirrored camera → warm grade → lens clipped into the quad → brackets and
   label → shutter blades → flash. Film grain and viewfinder marks are CSS overlays.
   ============================================================================= */
import { clamp, lerp, ease, dist, mulberry } from '../../shared/js/math.js';
import { $, isPhone, toggleFullscreen, canFullscreen } from '../../shared/js/dom.js';
import { startHands, drawSkeleton, drawMirroredVideo, toMirrored } from '../../shared/js/hands.js';
import { LENSES, LensView } from './lenses.js';
import { quadArea, capturePhoto, makeCard, toBlob } from './photo.js';
import { Roll } from './roll.js';

/* ============================== 1. CONFIG ============================== */
const CONFIG = {
  tracker: { options:{ maxNumHands:2, minDetectionConfidence:.6, minTrackingConfidence:.6 } },
  gesture: {
    extendRatio:1.1,           // tip this much farther from the wrist than the PIP joint = finger extended
    thumbOut:.5,               // thumb tip ↔ index knuckle, × hand size: above = thumb stuck out
    lMinAngle:35,              // degrees between thumb and index for an L
    pinch:.3,                  // thumb tip ↔ index tip, × hand size: below = pinched (fires the shutter)
    pinchStart:.75,            // …the shutter ring starts filling when the gap drops below this
    smooth:.5,                 // frame corner smoothing (1 = raw)
    openFrames:3,              // consecutive frame readings before the lens opens
    graceMs:180,               // the lens stays open this long after the frame is lost
    minArea:.01,               // smallest frame, as a share of the screen
    snapArmMs:1200,            // a pinch can fire this long after the frame was last whole (pinching breaks the L early)
    otherLMs:350,              // …as long as the other hand still made its L this recently (it keeps its corner)
    stillSpeed:2.2,            // hand speed (hand-lengths / s) above which hands are "moving away": no snaps
    tiltTurn:22,               // degrees of frame tilt that turn the dial one lens (clockwise = next)
    tiltLevel:10,              // back within this of level to arm the next turn
    tiltSteadyMs:300,          // the frame must be up this long before tilting counts
  },
  lens:  { width:480, photoWidth:1100, boot:.4, switch:.32 },
  music: {                     // CC0 lo-fi by TAD (see music/README.md), shuffled, looping through the list
    tracks:['music/a-cup-of-tea.mp3', 'music/cat-caffe.mp3', 'music/morning-rain.mp3'],
    fadeIn:2.5,                // seconds to fade in when the film loads
    duck:{ shutter:[.55, .9], motor:[.5, 3.8] },   // [how much quieter, for how long (s)] under camera sounds
  },
  photo: { size:640, roll:12, cooldown:.7 },
  shutter: .2,
};

/* ============================== 2. SOUND ============================== */
/** getLevels() → { master, sfx, music }. Must be init() from a click. Music → duck → music bus → master. */
function createSound(getLevels) {
  let ac = null, master, sfx, noiseBuf, hum, musicEl = null, musicBus, duckGain, order = [], track = 0;
  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ac = new AC();
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 5;
    const lv = getLevels();
    master = ac.createGain(); master.gain.value = lv.master; master.connect(comp); comp.connect(ac.destination);
    sfx = ac.createGain(); sfx.gain.value = lv.sfx; sfx.connect(master);
    const len = ac.sampleRate*2; noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random()*2 - 1;
    // the lens hum: a low electrical tone that swells while a frame is open
    hum = ac.createGain(); hum.gain.value = 0; hum.connect(sfx);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500; lp.connect(hum);
    for (const [type, f, g] of [['sine', 98, .6], ['triangle', 196.5, .25]]) { const o = ac.createOscillator(), og = ac.createGain(); o.type = type; o.frequency.value = f; og.gain.value = g; o.connect(og); og.connect(lp); o.start(); }
  }
  /** Start the playlist (shuffled, then round and round), fading in. Call from the same click as init(). */
  function startMusic(tracks) {
    if (!ac || musicEl) return;
    order = [...tracks].sort(() => Math.random() - .5); track = 0;
    musicEl = new Audio(); musicEl.preload = 'auto'; musicEl.src = order[0];
    const src = ac.createMediaElementSource(musicEl);
    duckGain = ac.createGain(); musicBus = ac.createGain(); musicBus.gain.value = 0;
    src.connect(duckGain); duckGain.connect(musicBus); musicBus.connect(master);
    musicEl.addEventListener('ended', () => { track = (track + 1) % order.length; musicEl.src = order[track]; musicEl.play().catch(() => {}); });
    musicBus.gain.setTargetAtTime(getLevels().music, ac.currentTime, CONFIG.music.fadeIn/3);
    if (getLevels().music > 0) musicEl.play().catch(() => {});
  }
  /** Pull the music down by amount (0..1) for secs, then let it swell back. */
  function duck(amount, secs) {
    if (!duckGain) return;
    const t = ac.currentTime; duckGain.gain.cancelScheduledValues(t);
    duckGain.gain.setTargetAtTime(1 - amount, t, .04); duckGain.gain.setTargetAtTime(1, t + secs, .45);
  }
  function update(open) {
    if (!ac) return;
    const t = ac.currentTime, v = getLevels();
    master.gain.setTargetAtTime(v.master, t, .05); sfx.gain.setTargetAtTime(v.sfx, t, .05);
    hum.gain.setTargetAtTime(.05*open, t, .12);
    if (musicEl) {
      if (t > CONFIG.music.fadeIn) musicBus.gain.setTargetAtTime(v.music, t, .25);
      if (v.music > 0 && musicEl.paused) musicEl.play().catch(() => {});      // switched back on
      else if (v.music === 0 && !musicEl.paused && musicBus.gain.value < .01) musicEl.pause();   // off: stop decoding once silent
    }
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
  const shots = {
    boot:    () => { tone('sine', 420, 980, .16, { gain:.12 }); noise(.05, { type:'highpass', f0:5000, f1:4000, gain:.12, delay:.14 }); },
    switch:  () => { noise(.03, { type:'highpass', f0:4000, f1:3000, gain:.25 }); noise(.03, { type:'highpass', f0:3000, f1:2500, gain:.2, delay:.06 }); noise(.22, { f0:900, f1:5000, q:4, gain:.1 }); },
    shutter: () => { noise(.035, { type:'highpass', f0:6000, f1:3000, gain:.6 }); tone('square', 1800, 600, .02, { gain:.15 }); noise(.05, { f0:2500, f1:900, q:2, gain:.45, delay:.07 }); },   // blade + mirror slap
    advance: () => { for (let i = 0; i < 6; i++) noise(.025, { type:'highpass', f0:2600, f1:2200, gain:.18, delay:i*.055 }); noise(.4, { f0:700, f1:1100, q:3, gain:.12 }); },
    motor:   () => { tone('sawtooth', 62, 66, 1.6, { gain:.06, attack:.05 }); noise(1.6, { f0:1100, f1:1300, q:4, gain:.12, attack:.06 }); for (let i = 0; i < 12; i++) noise(.02, { type:'highpass', f0:3200, f1:3000, gain:.08, delay:i*.12 }); },
    done:    () => { tone('sine', 1320, 1320, .12, { gain:.08 }); tone('sine', 1760, 1760, .14, { gain:.06, delay:.08 }); },
  };
  return {
    init, update, startMusic,
    shot:name => { if (!ac || !shots[name]) return; shots[name](); const d = CONFIG.music.duck[name]; if (d) duck(...d); },
    get music() { return musicEl ? { src:musicEl.src.split('/').pop(), paused:musicEl.paused, time:musicEl.currentTime, bus:musicBus.gain.value, duck:duckGain.gain.value } : null; },
  };
}

/* ============================== 3. GESTURES ============================== */
/**
 * One hand → { pts, size, center, L, gap, thumbTip, indexTip, vtx, thumbDir, indexDir, note }.
 * L: index straight + thumb stuck out at an angle to it (the corner of a director's frame).
 */
function readHand(lm, W, H) {
  const G = CONFIG.gesture, pts = toMirrored(lm, W, H), size = dist(pts[0], pts[9]) || 1;
  const ext = (tip, pip) => dist(pts[tip], pts[0]) > dist(pts[pip], pts[0])*G.extendRatio;
  const index = ext(8, 6);
  const thumb = dist(pts[4], pts[5])/size, gap = dist(pts[4], pts[8])/size;
  const tv = { x:pts[4].x - pts[2].x, y:pts[4].y - pts[2].y }, iv = { x:pts[8].x - pts[5].x, y:pts[8].y - pts[5].y };
  const cos = (tv.x*iv.x + tv.y*iv.y)/((Math.hypot(tv.x, tv.y)*Math.hypot(iv.x, iv.y)) || 1), ang = Math.acos(clamp(cos, -1, 1))*180/Math.PI;
  const L = index && thumb > G.thumbOut && ang > G.lMinAngle;
  const unit = v => { const l = Math.hypot(v.x, v.y) || 1; return { x:v.x/l, y:v.y/l }; };
  return { pts, size, center:pts[9], L, gap, thumbTip:pts[4], indexTip:pts[8],
           vtx:{ x:(pts[2].x + pts[5].x)/2, y:(pts[2].y + pts[5].y)/2 },     // the corner of the L, where thumb meets index
           thumbDir:unit(tv), indexDir:unit(iv),
           note:`i${+index} t${thumb.toFixed(2)} a${ang | 0} gap${gap.toFixed(2)}` };
}

/**
 * The frame two L hands enclose, however they're held: corners diagonal (director's frame) or both at
 * the bottom like holding a camera, index fingers up and thumbs along the bottom.
 * Its tilt is the average direction of the two index fingers (modulo 90°, so up/down/sideways agree; thumbs
 * rotate when you pinch, so they don't steer it);
 * its extent is the box, in that tilted frame, around both L corners and both index fingertips. Thumbs
 * are left out (they move when you pinch to take the photo) unless the box would otherwise be flat,
 * e.g. a hold with thumbs pointing up and index fingers sideways.
 * Returns [TL, TR, BR, BL] in the frame's own axes.
 */
function frameQuad(a, b) {
  let cx = 0, sy = 0;
  for (const d of [a.indexDir, b.indexDir]) { const k = Math.atan2(d.y, d.x)*4; cx += Math.cos(k); sy += Math.sin(k); }
  const th = Math.atan2(sy, cx)/4, c = Math.cos(th), s = Math.sin(th);
  const toLocal = p => ({ x:p.x*c + p.y*s, y:-p.x*s + p.y*c });
  let local = [a.vtx, a.indexTip, b.vtx, b.indexTip].map(toLocal);
  const ext = pts => [Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y))];
  const [w, h] = ext(local);
  if (Math.min(w, h) < Math.max(w, h)*.3) local = local.concat([a.thumbTip, b.thumbTip].map(toLocal));
  const xs = local.map(p => p.x), ys = local.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const back = (x, y) => ({ x:x*c - y*s, y:x*s + y*c });
  return [back(x0, y0), back(x1, y0), back(x1, y1), back(x0, y1)];
}

/* ============================== 4. FRAME ============================== */
/** The lens: the director's frame between two L hands, smoothed. */
class FrameTracker {
  constructor() { this.open = false; this.openSince = 0; this.lastOpen = -1e9; this.count = 0; this.lastSeen = -1e9; this.quad = null; }
  update(hands, t, W, H) {
    const G = CONFIG.gesture, Ls = hands.filter(h => h.L);
    let q = null;
    if (Ls.length >= 2) {
      q = frameQuad(Ls[0], Ls[1]);
      if (quadArea(q)/(W*H) < G.minArea) q = null;
    }
    if (q) {
      if (this.quad && this.open) {
        // smooth each corner toward the *nearest* old corner, not the same list slot: list order
        // starts at the top-left-most corner, which changes hands when the frame tilts past ~45°
        const used = new Set();
        q = q.map(p => {
          let best = 0, bd = Infinity;
          this.quad.forEach((o, i) => { const d = (o.x - p.x)**2 + (o.y - p.y)**2; if (!used.has(i) && d < bd) { bd = d; best = i; } });
          used.add(best); const o = this.quad[best];
          return { x:lerp(o.x, p.x, G.smooth), y:lerp(o.y, p.y, G.smooth) };
        });
      }
      this.quad = q; this.lastSeen = t; this.count++;
      if (this.count >= G.openFrames && !this.open) { this.open = true; this.openSince = t; }
      if (this.open) this.lastOpen = t;
    } else {
      this.count = 0;
      if (this.open && t - this.lastSeen > G.graceMs) this.open = false;
    }
  }
}

/**
 * Which hand is which: with two hands, the left one of the pair is side 0 and the right one side 1,
 * wherever they are on screen (a small frame off to one side has both hands in the same screen half).
 * With one hand, fall back to the screen half it's in.
 */
function sided(hands, W) {
  if (hands.length >= 2) { const [a, b] = [...hands].sort((x, y) => x.center.x - y.center.x); return [a, b]; }
  const out = [null, null]; for (const h of hands) out[h.center.x < W/2 ? 0 : 1] = h; return out;
}

/** Hand speed per side, in hand-lengths per second (smoothed). Fast = the hands are going somewhere, not posing. */
class Motion {
  constructor() { this.prev = [null, null]; this.speed = [0, 0]; }
  update(sides, t) {
    sides.forEach((h, s) => {
      const p = this.prev[s];
      if (h && p && t > p.t) this.speed[s] = this.speed[s]*.5 + .5*(dist(h.center, p.c)/h.size)/((t - p.t)/1000);
      else if (!h) this.speed[s] = 0;
      this.prev[s] = h ? { c:{ ...h.center }, t } : null;
    });
  }
  still() { return Math.max(...this.speed) < CONFIG.gesture.stillSpeed; }
}

/**
 * Snap = pinch ONE hand while the other keeps its corner. Pinching breaks that hand's L long before
 * the fingers meet, so the frame is allowed to have been whole up to snapArmMs ago, as long as the
 * other hand is still an L and nothing is moving away. progress[side] (0..1) drives the shutter ring.
 */
class SnapDetector {
  constructor() { this.prev = [false, false]; this.lastL = [-1e9, -1e9]; this.progress = [0, 0]; this.latched = [false, false]; this.lastSnap = -1e9; }
  update(sides, t, frame, motion) {
    const G = CONFIG.gesture, armed = t - frame.lastOpen < G.snapArmMs;
    let fire = false;
    for (const s of [0, 1]) if (sides[s] && sides[s].L) this.lastL[s] = t;
    for (const s of [0, 1]) {
      const h = sides[s], framing = armed && t - this.lastL[1 - s] < G.otherLMs;
      if (!h || h.gap > G.pinchStart) this.latched[s] = false;              // fingers opened again: ready for the next shot
      this.progress[s] = h && framing && !this.latched[s] ? clamp((G.pinchStart - h.gap)/(G.pinchStart - G.pinch), 0, 1) : 0;
      const now = !!(h && h.gap < G.pinch);
      if (now && !this.prev[s] && framing && !this.latched[s] && motion.still() && t - this.lastSnap > 700) { fire = true; this.latched[s] = true; }
      this.prev[s] = now;
    }
    if (fire) { this.lastSnap = t; this.progress = [0, 0]; }
    return fire;
  }
  get pinching() { return Math.max(...this.progress) > .05; }
}

/** Frame tilt in degrees from its more-horizontal edge: 0 = level, + = clockwise on screen. */
function frameTilt(q) {
  let u = { x:(q[1].x - q[0].x + q[2].x - q[3].x)/2, y:(q[1].y - q[0].y + q[2].y - q[3].y)/2 };
  const v = { x:(q[3].x - q[0].x + q[2].x - q[1].x)/2, y:(q[3].y - q[0].y + q[2].y - q[1].y)/2 };
  if (Math.abs(v.x) > Math.abs(u.x)) u = v;
  if (u.x < 0) u = { x:-u.x, y:-u.y };
  return Math.atan2(u.y, u.x)*180/Math.PI;
}

/**
 * Lens dial: tilt the frame past tiltTurn degrees to turn one lens (clockwise = next), then bring it
 * back near level to arm the next turn. A frame that opens already tilted has to be levelled first.
 * Returns -1, 0 or 1.
 */
class TiltDial {
  constructor() { this.armed = false; this.angle = 0; this.wasOpen = false; }
  update(frame, t) {
    const G = CONFIG.gesture;
    if (!frame.open || !frame.quad) { this.wasOpen = false; return 0; }
    const a = this.angle = frameTilt(frame.quad);
    if (!this.wasOpen) { this.wasOpen = true; this.armed = Math.abs(a) < G.tiltTurn - 8; }
    if (Math.abs(a) < G.tiltLevel) { this.armed = true; return 0; }
    if (this.armed && t - frame.openSince > G.tiltSteadyMs && Math.abs(a) >= G.tiltTurn) { this.armed = false; return a > 0 ? 1 : -1; }
    return 0;
  }
}

/* ============================== 5. PANEL ============================== */
const SETTINGS_KEY = 'track-lab:frame-it:settings';
const SAVED = ['vol', 'mute', 'sfxVol', 'music', 'musicVol', 'grain', 'reduce', 'skel'];

class Panel {
  constructor() {
    this.app = $('app'); this.restore();
    for (const id of SAVED) { $(id).addEventListener('input', () => this.save()); $(id).addEventListener('change', () => this.save()); }
    const syncGrain = () => this.app.style.setProperty('--grain', (+$('grain').value/100).toFixed(2));
    $('grain').addEventListener('input', syncGrain); syncGrain();
    $('setBtn').addEventListener('click', () => this.toggleSheet());
    $('sheetClose').addEventListener('click', () => this.toggleSheet(false));
    if (canFullscreen()) $('fsBtn').addEventListener('click', toggleFullscreen); else $('fsBtn').hidden = true;
    $('lensDots').innerHTML = LENSES.map((l, i) => `<button type="button" data-i="${i}" title="${l.name}" aria-label="${l.name} lens"></button>`).join('');
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
  levels() { return { master:$('mute').checked ? 0 : $('vol').value/100, sfx:$('sfxVol').value/100, music:$('music').checked ? $('musicVol').value/100 : 0 }; }
  controls() { return { reduce:$('reduce').checked, skeleton:$('skel').checked }; }
  setLens(i) {
    const l = LENSES[i], name = $('lensName');
    if (name.textContent !== l.name) { name.textContent = l.name; $('finderLens').textContent = l.name.toUpperCase(); }
    [...$('lensDots').children].forEach((b, k) => b.classList.toggle('on', k === i));
  }
  setExposures(n) { $('exp').textContent = `EXP ${String(n).padStart(2, '0')}`; }
  setFraming(open) { this.app.classList.toggle('framing', open); }
  setHint(show) { this.app.classList.toggle('hint-on', show); }
  setDebug(text) { const d = $('debug'); if (d.textContent !== text) d.textContent = text; }
  setError(text) { $('err').textContent = text; }
  showStage() { this.app.classList.add('running'); }
}

/* ============================== 6. APP ============================== */
const quadPath = (ctx, q) => { ctx.beginPath(); q.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); };

class App {
  constructor() {
    this.canvas = $('canvas'); this.ctx = this.canvas.getContext('2d'); this.video = $('video');
    this.panel = new Panel();
    this.sound = createSound(() => this.panel.levels());
    this.roll = new Roll({ sound:this.sound, max:CONFIG.photo.roll });
    this.lens = new LensView(CONFIG.lens.width); this.photoLens = new LensView(CONFIG.lens.photoWidth);
    this.frameT = new FrameTracker(); this.snaps = new SnapDetector(); this.dial = new TiltDial(); this.motion = new Motion();
    this.sides = [null, null]; this.holding = false; this.cleanQuad = null;
    this.hands = []; this.pending = null; this.running = false; this.lastT = 0; this.t = 0;
    this.lensIdx = 0; this.openA = 0; this.bootT = 0; this.switchT = 0; this.shutterT = 0; this.flash = 0; this.cooldown = 0;
    this.exposures = 0; this.lastFramed = -1e9; this.wasOpen = false; this.drawQuad = null;
    this.ctl = this.panel.controls();
    this.panel.setLens(0); this.panel.setExposures(0); this.panel.setHint(true);

    $('start').addEventListener('click', () => this.start());
    $('prevLens').addEventListener('click', () => this.switchLens(-1));
    $('nextLens').addEventListener('click', () => this.switchLens(1));
    $('lensDots').addEventListener('click', e => { const i = e.target.dataset && e.target.dataset.i; if (i != null) this.switchLens(+i - this.lensIdx); });
    // after a mouse/touch click, drop focus so the space bar goes back to taking photos (keyboard users keep focus)
    document.querySelector('.dial').addEventListener('click', e => { if (e.detail > 0 && e.target.blur) e.target.blur(); });
    addEventListener('keydown', e => {
      if (e.target.closest && e.target.closest('input, select, textarea, button, a')) return;   // they handle their own keys
      if (e.key === 'ArrowRight') this.switchLens(1);
      else if (e.key === 'ArrowLeft') this.switchLens(-1);
      else if (e.key === ' ' && this.running) { e.preventDefault(); this.snap(this.frameT.open ? this.frameT.quad : null); }
    });
  }

  async start() {
    this.sound.init(); this.sound.startMusic(CONFIG.music.tracks);
    $('start').disabled = true; $('start').textContent = 'Loading film…'; this.panel.setError('');
    try {
      if (document.fonts) { document.fonts.load('48px "Caveat"', 'Inverted'); document.fonts.load('16px "IBM Plex Mono"'); }
      this.tracking = await startHands({ video:this.video, options:CONFIG.tracker.options, onResults:(res, t) => { this.pending = { res, t }; } });
      this.panel.showStage();
      if (!this.running) { this.running = true; this.lastT = performance.now(); requestAnimationFrame(this.frame); }
    } catch (e) {
      this.panel.setError('Could not start the camera: ' + (e.message || e) + '. Allow camera access and try again.');
      $('start').disabled = false; $('start').textContent = 'Load film';
    }
  }

  frame = now => {
    requestAnimationFrame(this.frame);
    const v = this.video; if (!v.videoWidth) return;
    const W = v.videoWidth, H = v.videoHeight;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const dt = clamp((now - this.lastT)/1000, .001, .05); this.lastT = now; this.t += dt;
    this.ctl = this.panel.controls();
    if (this.pending) { this.ingest(this.pending, W, H); this.pending = null; }
    this.update(dt);
    this.render(W, H);
  };

  ingest({ res, t }, W, H) {
    this.hands = (res.multiHandLandmarks || []).map(lm => readHand(lm, W, H));
    const F = this.frameT, sides = this.sides = sided(this.hands, W);
    F.update(this.hands, t, W, H);
    this.motion.update(sides, t);
    if (!this.snaps.pinching && F.open) this.cleanQuad = F.quad.map(p => ({ ...p }));   // the frame before any pinch moved a thumb
    const turn = this.snaps.pinching ? 0 : this.dial.update(F, t);
    if (turn) this.switchLens(turn);
    if (this.snaps.update(sides, t, F, this.motion)) this.snap(this.cleanQuad || F.quad);
    // keep the lens up, and still, while a pinch closes, including the moment where the pinching hand
    // has stopped being an L but the ring hasn't started yet (the other hand still holds its corner)
    const cornerHeld = sides.some(h => h && h.L);
    this.holding = this.snaps.pinching || (!F.open && cornerHeld && t - F.lastOpen < 450);
    this.panel.setDebug(this.hands.map((h, i) => `H${i + 1} ${h.L ? 'L' : '·'} ${h.note}`).join('   ') || 'no hands');
  }

  update(dt) {
    const F = this.frameT, shown = F.open || this.holding;
    if (shown && !this.wasOpen) { this.bootT = CONFIG.lens.boot; this.sound.shot('boot'); }
    this.wasOpen = shown;
    if (F.open) this.lastFramed = this.t;
    if (this.holding && this.cleanQuad) this.drawQuad = this.cleanQuad; else if (F.open) this.drawQuad = F.quad;
    this.openA = clamp(this.openA + (shown ? dt/.12 : -dt/.18), 0, 1);
    for (const k of ['bootT', 'switchT', 'shutterT', 'cooldown']) this[k] = Math.max(0, this[k] - dt);
    this.flash = Math.max(0, this.flash - dt*4);
    this.sound.update(this.openA);
    this.panel.setFraming(F.open);
    this.panel.setHint(!this.roll.photos.length && this.t - this.lastFramed > 3);
  }

  switchLens(d) {
    if (!d) return;
    this.lensIdx = (this.lensIdx + d + LENSES.length) % LENSES.length;
    this.switchT = CONFIG.lens.switch; this.sound.shot('switch'); this.panel.setLens(this.lensIdx);
  }

  /** Take a polaroid of `quad` (or, from the keyboard with no frame, a centred square). */
  async snap(quad) {
    if (this.cooldown > 0 || !this.video.videoWidth) return;
    this.cooldown = CONFIG.photo.cooldown;
    const W = this.video.videoWidth, H = this.video.videoHeight, u = Math.min(W, H);
    if (!quad) { const s = u*.62, x = (W - s)/2, y = (H - s)/2; quad = [{ x, y }, { x:x + s, y }, { x:x + s, y:y + s }, { x, y:y + s }]; }
    const lens = LENSES[this.lensIdx];
    this.shutterT = CONFIG.shutter; this.flash = 1; this.drawQuad = quad; this.exposures++;
    this.sound.shot('shutter'); setTimeout(() => this.sound.shot('advance'), 260);
    this.panel.setExposures(this.exposures);
    const src = this.photoLens.render(this.video, W, H, lens.id, this.t), k = src.width/W;
    const photo = capturePhoto(src, quad.map(p => ({ x:p.x*k, y:p.y*k })), CONFIG.photo.size);
    const card = await makeCard(photo, { caption:lens.name });
    // encode synchronously so the polaroid lands right after the flash; the shareable file is built only on demand
    this.roll.add({ url:card.toDataURL('image/jpeg', .92), getBlob:() => toBlob(card), caption:lens.name, time:Date.now() }, this.clientRect(quad));
  }

  /** Canvas coords → the on-screen rect (the canvas is object-fit: cover). */
  clientRect(q) {
    const r = this.canvas.getBoundingClientRect(), W = this.canvas.width, H = this.canvas.height;
    const s = Math.max(r.width/W, r.height/H), ox = r.left + (r.width - W*s)/2, oy = r.top + (r.height - H*s)/2;
    const xs = q.map(p => ox + p.x*s), ys = q.map(p => oy + p.y*s);
    const left = Math.min(...xs), top = Math.min(...ys);
    return { left, top, width:Math.max(...xs) - left, height:Math.max(...ys) - top };
  }

  render(W, H) {
    const ctx = this.ctx, u = Math.min(W, H), q = this.drawQuad, lens = LENSES[this.lensIdx];
    // 0. the world: mirrored camera, warmed like expired film
    drawMirroredVideo(ctx, this.video, W, H);
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = 'rgba(255,186,120,.38)'; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'multiply';
    const vg = ctx.createRadialGradient(W/2, H/2, u*.4, W/2, H/2, Math.hypot(W, H)*.6);
    vg.addColorStop(0, 'rgba(255,255,255,0)'); vg.addColorStop(1, 'rgba(70,45,25,.55)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // 1. the lens, clipped into the finger frame
    if (q && (this.openA > 0 || this.shutterT > 0)) {
      const lensImg = this.lens.render(this.video, W, H, lens.id, this.t);
      const boot = this.bootT > 0 ? 1 - this.bootT/CONFIG.lens.boot : 1;
      ctx.save(); quadPath(ctx, q); ctx.clip();
      ctx.globalAlpha = Math.max(this.openA, this.shutterT > 0 ? 1 : 0)*(boot < 1 && Math.random() < .35 ? .25 : 1);   // boot flicker
      ctx.drawImage(lensImg, 0, 0, W, H);
      ctx.globalAlpha = 1;
      if (this.switchT > 0) this.glitch(ctx, q, lensImg, W, H);
      if (this.shutterT > 0) this.blades(ctx, q);
      ctx.restore();
      this.brackets(ctx, q, u, boot, lens);
      if (this.frameT.open && !this.holding) this.gauge(ctx, q, u);
    }
    this.shutterRings(ctx, u);

    // 2. flash, skeleton
    if (this.flash > 0) { ctx.fillStyle = `rgba(255,248,235,${this.flash*(this.ctl.reduce ? .2 : .85)})`; ctx.fillRect(0, 0, W, H); }
    if (this.ctl.skeleton) drawSkeleton(ctx, this.hands, '#fff6e4', .5);
  }

  /** Corner brackets + thin edges + the lens tag at the top-left corner. Brackets snap in while booting. */
  brackets(ctx, q, u, boot, lens) {
    const a = this.openA, grow = 1 + .25*(1 - ease(boot)), cx = q.reduce((s, p) => s + p.x, 0)/4, cy = q.reduce((s, p) => s + p.y, 0)/4;
    const Q = q.map(p => ({ x:cx + (p.x - cx)*grow, y:cy + (p.y - cy)*grow }));
    ctx.save(); ctx.globalAlpha = a; ctx.lineCap = 'round'; ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 6;
    ctx.strokeStyle = 'rgba(255,246,228,.35)'; ctx.lineWidth = Math.max(1, u*.0015); quadPath(ctx, Q); ctx.stroke();
    ctx.strokeStyle = '#fff6e4'; ctx.lineWidth = Math.max(2, u*.006);
    for (let i = 0; i < 4; i++) {
      const p = Q[i], n = Q[(i + 1) % 4], b = Q[(i + 3) % 4], len = Math.min(dist(p, n), dist(p, b))*.2;
      const to = (o) => { const l = dist(p, o) || 1; return { x:p.x + (o.x - p.x)/l*len, y:p.y + (o.y - p.y)/l*len }; };
      const s1 = to(n), s2 = to(b);
      ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(p.x, p.y); ctx.lineTo(s2.x, s2.y); ctx.stroke();
    }
    const fs = Math.max(11, u*.022), tl = Q[0];
    ctx.shadowBlur = 0; ctx.font = `500 ${fs}px "IBM Plex Mono", ui-monospace, monospace`; ctx.textBaseline = 'bottom';
    const label = `${lens.kanji}  ${lens.name.toUpperCase()}`, tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(28,26,23,.72)'; ctx.fillRect(tl.x, tl.y - fs*1.7, tw + fs*1.6, fs*1.45);
    ctx.fillStyle = '#d2402a'; ctx.beginPath(); ctx.arc(tl.x + fs*.55, tl.y - fs*.98, fs*.22, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#fff6e4'; ctx.fillText(label, tl.x + fs*1.0, tl.y - fs*.45);
    ctx.restore();
  }

  /** Tilt gauge above the frame: a needle shows the tilt, the ticks at ±tiltTurn are the next / previous lens. */
  gauge(ctx, q, u) {
    const G = CONFIG.gesture, cx = q.reduce((s, p) => s + p.x, 0)/4, cy = q.reduce((s, p) => s + p.y, 0)/4;
    let top = null;
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], m = { x:(a.x + b.x)/2, y:(a.y + b.y)/2 }; if (!top || m.y < top.y) top = m; }
    const n = Math.hypot(top.x - cx, top.y - cy) || 1, R = u*.065, p = { x:top.x + (top.x - cx)/n*R*1.25, y:top.y + (top.y - cy)/n*R*1.25 };
    const rad = d => (-90 + d)*Math.PI/180, span = G.tiltTurn + 14, a = this.dial.angle, armed = this.dial.armed;
    const lensAt = d => LENSES[(this.lensIdx + d + LENSES.length) % LENSES.length];
    ctx.save(); ctx.globalAlpha = this.openA*.95; ctx.lineCap = 'round'; ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4;
    ctx.strokeStyle = 'rgba(255,246,228,.45)'; ctx.lineWidth = Math.max(1.5, u*.003);
    ctx.beginPath(); ctx.arc(p.x, p.y, R, rad(-span), rad(span)); ctx.stroke();
    const fs = Math.max(13, u*.03); ctx.font = '600 ' + fs + 'px "Fraunces", Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const side of [-1, 1]) {                                          // the two turn points, labelled with the lens they lead to
      const d = side*G.tiltTurn, hot = side*a >= G.tiltTurn*.6 && armed;
      ctx.strokeStyle = hot ? '#d2402a' : 'rgba(255,246,228,.85)'; ctx.lineWidth = Math.max(2, u*.005);
      ctx.beginPath(); ctx.moveTo(p.x + Math.cos(rad(d))*R*.82, p.y + Math.sin(rad(d))*R*.82); ctx.lineTo(p.x + Math.cos(rad(d))*R*1.18, p.y + Math.sin(rad(d))*R*1.18); ctx.stroke();
      ctx.fillStyle = hot ? '#ffd9cf' : 'rgba(255,246,228,.75)';
      ctx.fillText(lensAt(side).kanji, p.x + Math.cos(rad(d))*R*1.62, p.y + Math.sin(rad(d))*R*1.62);
    }
    const na = clamp(a, -span, span);                                      // the needle: cream when armed, amber while waiting to be levelled
    ctx.strokeStyle = armed ? '#fff6e4' : '#e8a33a'; ctx.lineWidth = Math.max(2, u*.006);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.cos(rad(na))*R*1.05, p.y + Math.sin(rad(na))*R*1.05); ctx.stroke();
    ctx.fillStyle = armed ? '#fff6e4' : '#e8a33a'; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(2.5, u*.006), 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  /** Shutter ring at a pinching hand: fills as thumb and index close, like half-pressing a shutter button. */
  shutterRings(ctx, u) {
    const pr = this.snaps.progress;
    this.sides.forEach((h, s) => {
      if (!h || pr[s] < .08) return;
      const c = { x:(h.thumbTip.x + h.indexTip.x)/2, y:(h.thumbTip.y + h.indexTip.y)/2 }, R = Math.max(u*.035, h.size*.42);
      ctx.save(); ctx.lineCap = 'round'; ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 5;
      ctx.strokeStyle = 'rgba(255,246,228,.4)'; ctx.lineWidth = Math.max(2, u*.006); ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, Math.PI*2); ctx.stroke();
      ctx.strokeStyle = '#d2402a'; ctx.lineWidth = Math.max(3, u*.01);
      ctx.beginPath(); ctx.arc(c.x, c.y, R, -Math.PI/2, -Math.PI/2 + pr[s]*Math.PI*2); ctx.stroke();
      ctx.fillStyle = 'rgba(210,64,42,' + (.25 + .6*pr[s]) + ')'; ctx.beginPath(); ctx.arc(c.x, c.y, R*.32*(.6 + .4*pr[s]), 0, Math.PI*2); ctx.fill();
      ctx.restore();
    });
  }

  /** Lens switch: torn horizontal slices and static inside the frame. */
  glitch(ctx, q, img, W, H) {
    const r = mulberry(Math.floor(this.t*30)), ys = q.map(p => p.y), y0 = Math.min(...ys), y1 = Math.max(...ys), k = img.width/W, amt = this.switchT/CONFIG.lens.switch;
    for (let i = 0; i < 7; i++) {
      const y = y0 + r()*(y1 - y0), h = (y1 - y0)*(.02 + r()*.07), off = (r() - .5)*W*.08*amt;
      ctx.drawImage(img, 0, y*k, img.width, h*k, off, y, W, h);
      if (r() < .4) { ctx.fillStyle = `rgba(255,246,228,${.5*amt})`; ctx.fillRect(0, y, W, Math.max(1, h*.15)); }
    }
  }

  /** Shutter: two dark blades meet in the middle of the frame and part again. */
  blades(ctx, q) {
    const p = 1 - this.shutterT/CONFIG.shutter, c = Math.sin(p*Math.PI), ys = q.map(v => v.y), xs = q.map(v => v.x);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), half = (y1 - y0)/2*c;
    ctx.fillStyle = '#14120f'; ctx.fillRect(x0, y0, x1 - x0, half); ctx.fillRect(x0, y1 - half, x1 - x0, half);
  }
}

window.frameIt = new App();   // handle for poking at it from the console
