/* =============================================================================
   FRAME IT
   -----------------------------------------------------------------------------
   An instant camera made of your fingers. Two L-shaped hands make a director's frame;
   inside it the world turns into another lens; a middle-finger click switches lens;
   pinching both hands takes a polaroid.

   1. Config       every tunable number in one place
   2. Sound        WebAudio synth: shutter, film advance, lens boot / switch, printer motor, lens hum
   3. Gestures     landmarks → hand reading (L, pinch, middle finger)
   4. Frame        four-fingertip quad with smoothing + history, snap and click detectors
   5. Panel        lens dial, viewfinder readouts, hint, settings sheet
   6. App          tracking, main loop, render order

   Render: mirrored camera → warm grade → lens clipped into the quad → brackets and
   label → shutter blades → flash. Film grain and viewfinder marks are CSS overlays.
   ============================================================================= */
import { clamp, lerp, ease, dist, mulberry } from '../../shared/js/math.js';
import { $, isPhone, toggleFullscreen, canFullscreen } from '../../shared/js/dom.js';
import { startHands, drawSkeleton, drawMirroredVideo, toMirrored } from '../../shared/js/hands.js';
import { LENSES, LensView } from './lenses.js';
import { orderQuad, quadArea, capturePhoto, makeCard, toBlob } from './photo.js';
import { Roll } from './roll.js';

/* ============================== 1. CONFIG ============================== */
const CONFIG = {
  tracker: { options:{ maxNumHands:2, minDetectionConfidence:.6, minTrackingConfidence:.6 } },
  gesture: {
    extendRatio:1.1,           // tip this much farther from the wrist than the PIP joint = finger extended
    thumbOut:.5,               // thumb tip ↔ index knuckle, × hand size: above = thumb stuck out
    lMinAngle:35,              // degrees between thumb and index for an L
    pinch:.3,                  // thumb tip ↔ index tip, × hand size: below = pinched
    smooth:.5,                 // frame corner smoothing (1 = raw)
    openFrames:3,              // consecutive frame readings before the lens opens
    graceMs:180,               // the lens stays open this long after the frame is lost
    minArea:.01,               // smallest frame, as a share of the screen
    snapWindowMs:380,          // both pinches must land within this window
    snapAfterFrameMs:600,      // …and within this long of a real frame
    snapLagMs:160,             // photo uses the frame from this long before the pinch (fingers were still open)
    historyMs:900,
    clickMaxMs:650, clickCooldownMs:450,
  },
  lens:  { width:480, photoWidth:1100, boot:.4, switch:.32 },
  photo: { size:640, roll:12, cooldown:.7 },
  shutter: .2,
};

/* ============================== 2. SOUND ============================== */
/** getLevels() → { master, sfx }. Must be init() from a click. */
function createSound(getLevels) {
  let ac = null, master, sfx, noiseBuf, hum;
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
  function update(open) {
    if (!ac) return;
    const t = ac.currentTime, v = getLevels();
    master.gain.setTargetAtTime(v.master, t, .05); sfx.gain.setTargetAtTime(v.sfx, t, .05);
    hum.gain.setTargetAtTime(.05*open, t, .12);
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
  return { init, update, shot:name => { if (ac && shots[name]) shots[name](); } };
}

/* ============================== 3. GESTURES ============================== */
/**
 * One hand → { pts, size, center, thumb, index, L, pinch, middle, note }.
 * L: index straight + thumb stuck out at an angle to it (the corner of a director's frame).
 */
function readHand(lm, W, H) {
  const G = CONFIG.gesture, pts = toMirrored(lm, W, H), size = dist(pts[0], pts[9]) || 1;
  const ext = (tip, pip) => dist(pts[tip], pts[0]) > dist(pts[pip], pts[0])*G.extendRatio;
  const index = ext(8, 6), middle = ext(12, 10);
  const thumb = dist(pts[4], pts[5])/size, gap = dist(pts[4], pts[8])/size;
  const tv = { x:pts[4].x - pts[2].x, y:pts[4].y - pts[2].y }, iv = { x:pts[8].x - pts[5].x, y:pts[8].y - pts[5].y };
  const cos = (tv.x*iv.x + tv.y*iv.y)/((Math.hypot(tv.x, tv.y)*Math.hypot(iv.x, iv.y)) || 1), ang = Math.acos(clamp(cos, -1, 1))*180/Math.PI;
  const L = index && thumb > G.thumbOut && ang > G.lMinAngle;
  const unit = v => { const l = Math.hypot(v.x, v.y) || 1; return { x:v.x/l, y:v.y/l }; };
  return { pts, size, center:pts[9], L, pinch:gap < G.pinch, middle,
           vtx:{ x:(pts[2].x + pts[5].x)/2, y:(pts[2].y + pts[5].y)/2 },     // the corner of the L, where thumb meets index
           thumbDir:unit(tv), indexDir:unit(iv),
           note:`i${+index} t${thumb.toFixed(2)} a${ang | 0} gap${gap.toFixed(2)} m${+middle}` };
}

/**
 * Director's frame from two L hands: the L corners are two opposite corners; the other two are where
 * one hand's index line crosses the other hand's thumb line (pairing whichever edges are most
 * perpendicular). If the lines are nearly parallel or cross far away, fall back to an upright box.
 */
function frameQuad(a, b) {
  const cross = (u, v) => u.x*v.y - u.y*v.x;
  const meet = (p, d, q, e) => {
    const den = cross(d, e); if (Math.abs(den) < .25) return null;
    const t = cross({ x:q.x - p.x, y:q.y - p.y }, e)/den;
    return { x:p.x + d.x*t, y:p.y + d.y*t };
  };
  const straight = Math.abs(cross(a.indexDir, b.thumbDir)) + Math.abs(cross(a.thumbDir, b.indexDir));
  const swapped = Math.abs(cross(a.indexDir, b.indexDir)) + Math.abs(cross(a.thumbDir, b.thumbDir));
  const [e1, e2] = straight >= swapped ? [b.thumbDir, b.indexDir] : [b.indexDir, b.thumbDir];
  let c1 = meet(a.vtx, a.indexDir, b.vtx, e1), c2 = meet(a.vtx, a.thumbDir, b.vtx, e2);
  const span = dist(a.vtx, b.vtx), near = p => p && dist(p, a.vtx) < span*1.4 && dist(p, b.vtx) < span*1.4;
  if (!near(c1) || !near(c2)) { c1 = { x:a.vtx.x, y:b.vtx.y }; c2 = { x:b.vtx.x, y:a.vtx.y }; }
  return orderQuad([a.vtx, c1, b.vtx, c2]);
}

/* ============================== 4. FRAME ============================== */
/** The lens: the director's frame between two L hands, smoothed, with a short history for snaps. */
class FrameTracker {
  constructor() { this.open = false; this.count = 0; this.lastSeen = -1e9; this.quad = null; this.history = []; }
  update(hands, t, W, H) {
    const G = CONFIG.gesture, Ls = hands.filter(h => h.L);
    let q = null;
    if (Ls.length >= 2) {
      q = frameQuad(Ls[0], Ls[1]);
      if (quadArea(q)/(W*H) < G.minArea) q = null;
    }
    if (q) {
      if (this.quad && this.open) q = q.map((p, i) => ({ x:lerp(this.quad[i].x, p.x, G.smooth), y:lerp(this.quad[i].y, p.y, G.smooth) }));
      this.quad = q; this.lastSeen = t; this.count++;
      if (this.count >= G.openFrames) this.open = true;
      this.history.push({ t, quad:q.map(p => ({ ...p })) });
    } else {
      this.count = 0;
      if (this.open && t - this.lastSeen > G.graceMs) this.open = false;
    }
    while (this.history.length && t - this.history[0].t > G.historyMs) this.history.shift();
  }
  /** The frame as it was `lag` ms before t (the fingers were still open), or null. */
  quadBefore(t, lag) {
    let best = null;
    for (const e of this.history) if (e.t <= t - lag) best = e;
    return (best || this.history[0] || {}).quad || null;
  }
}

/** Snap = both hands pinch within a short window, right after a real frame. Hands are told apart by screen side. */
class SnapDetector {
  constructor() { this.prev = [false, false]; this.at = [-1e9, -1e9]; this.lastSnap = -1e9; }
  update(hands, t, W, frame) {
    const G = CONFIG.gesture, now = [false, false];
    for (const h of hands) { const s = h.center.x < W/2 ? 0 : 1; now[s] = now[s] || h.pinch; }
    for (const s of [0, 1]) { if (now[s] && !this.prev[s]) this.at[s] = t; this.prev[s] = now[s]; }
    const both = Math.abs(this.at[0] - this.at[1]) < G.snapWindowMs && Math.max(...this.at) === t;
    if (both && t - frame.lastSeen < G.snapAfterFrameMs && t - this.lastSnap > 600) { this.lastSnap = t; this.at = [-1e9, -1e9]; return true; }
    return false;
  }
}

/** Middle-finger click (straighten then curl again, quickly) while framing. Returns -1 (left hand), 1 (right) or 0. */
class ClickDetector {
  constructor() { this.state = [false, false]; this.stable = [0, 0]; this.upAt = [-1e9, -1e9]; this.last = -1e9; }
  update(hands, t, W, frameOpen) {
    const G = CONFIG.gesture; let click = 0;
    for (const s of [0, 1]) {
      const h = hands.find(x => (x.center.x < W/2 ? 0 : 1) === s);
      if (!h) { this.stable[s] = 0; continue; }
      if (h.middle === this.state[s]) { this.stable[s] = 0; continue; }
      if (++this.stable[s] < 2) continue;                                   // two readings in a row: ignore flicker
      this.state[s] = h.middle; this.stable[s] = 0;
      if (h.middle) this.upAt[s] = t;
      else if (frameOpen && t - this.upAt[s] < G.clickMaxMs && t - this.last > G.clickCooldownMs) { this.last = t; click = s ? 1 : -1; }
    }
    return click;
  }
}

/* ============================== 5. PANEL ============================== */
const SETTINGS_KEY = 'track-lab:frame-it:settings';
const SAVED = ['vol', 'mute', 'sfxVol', 'grain', 'reduce', 'skel'];

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
  levels() { return { master:$('mute').checked ? 0 : $('vol').value/100, sfx:$('sfxVol').value/100 }; }
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
    this.frameT = new FrameTracker(); this.snaps = new SnapDetector(); this.clicks = new ClickDetector();
    this.hands = []; this.pending = null; this.running = false; this.lastT = 0; this.t = 0;
    this.lensIdx = 0; this.openA = 0; this.bootT = 0; this.switchT = 0; this.shutterT = 0; this.flash = 0; this.cooldown = 0;
    this.exposures = 0; this.lastFramed = -1e9; this.wasOpen = false; this.drawQuad = null;
    this.ctl = this.panel.controls();
    this.panel.setLens(0); this.panel.setExposures(0); this.panel.setHint(true);

    $('start').addEventListener('click', () => this.start());
    $('prevLens').addEventListener('click', () => this.switchLens(-1));
    $('nextLens').addEventListener('click', () => this.switchLens(1));
    $('lensDots').addEventListener('click', e => { const i = e.target.dataset && e.target.dataset.i; if (i != null) this.switchLens(+i - this.lensIdx); });
    addEventListener('keydown', e => {
      if (e.target.closest && e.target.closest('input, select, textarea')) return;
      if (e.key === 'ArrowRight') this.switchLens(1);
      else if (e.key === 'ArrowLeft') this.switchLens(-1);
      else if (e.key === ' ' && this.running) { e.preventDefault(); this.snap(this.frameT.open ? this.frameT.quad : null); }
    });
  }

  async start() {
    this.sound.init();
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
    const F = this.frameT;
    F.update(this.hands, t, W, H);
    const click = this.clicks.update(this.hands, t, W, F.open);
    if (click) this.switchLens(click);
    if (this.snaps.update(this.hands, t, W, F)) this.snap(F.quadBefore(t, CONFIG.gesture.snapLagMs));
    this.panel.setDebug(this.hands.map((h, i) => `H${i + 1} ${h.L ? 'L' : '·'} ${h.note}`).join('   ') || 'no hands');
  }

  update(dt) {
    const F = this.frameT;
    if (F.open && !this.wasOpen) { this.bootT = CONFIG.lens.boot; this.sound.shot('boot'); }
    this.wasOpen = F.open;
    if (F.open) { this.lastFramed = this.t; this.drawQuad = F.quad; }
    this.openA = clamp(this.openA + (F.open ? dt/.12 : -dt/.18), 0, 1);
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
    }

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
