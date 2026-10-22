/* =============================================================================
   CURSED HANDS
   -----------------------------------------------------------------------------
   1. Config       every tunable number in one place
   2. Utilities    math helpers + shared animation clock
   3. Sound        WebAudio synth: continuous loops + one-shot hits
   4. Draw         stateless painters: grade, colour wash, crackle, orbs, prompts
   5. Effects      particles, shockwaves, title flashes, shake / flash / impact / tint
   6. Gestures     landmarks → hand reading, pose debouncing, flick detectors
   7. Techniques   DomainExpansion, Blue, Red, HollowPurple (state + render)
   8. Panel        drawer / bottom sheet, HUD chips, badge, debug
   9. App          tracking, main loop (requestAnimationFrame), layer order

   Rendering: every frame the graded camera image + the Domain are drawn into an
   off-screen "backdrop" canvas. The main canvas starts from that backdrop, so the
   Blue lens / gravity well can sample it (they warp whatever is behind them,
   including the void) instead of punching raw video through.
   All canvas sizes scale with u = min(W, H), so portrait phones look right too.
   ============================================================================= */
import { TAU, clamp, lerp, rand, ease, dist, V3, mulberry, prune } from '../../shared/js/math.js';
import { $, matches, isPhone, spacing, toggleFullscreen, canFullscreen } from '../../shared/js/dom.js';
import { startHands, drawSkeleton, drawMirroredVideo } from '../../shared/js/hands.js';
import { CurseWaves } from './curses.js';
import { createVoice, LINES } from './voice.js';
import { FaceFX } from './face-fx.js';

/* ============================== 1. CONFIG ============================== */
const CONFIG = {
  tracker: {                   // camera size: shared default (1280×720, portrait on phones held upright)
    options: { maxNumHands:2, minDetectionConfidence:.6, minTrackingConfidence:.6 },
  },
  gesture: {
    extendRatio:1.12,          // tip must be this much farther from wrist than PIP to count as extended
    curlRatio:.95,
    domainMaxSep:.10,          // index/middle sideways separation below this = crossed (Domain)
    pinchDist:.35,             // default for the Pinch slider: thumb tip ↔ index tip/nail, × hand size
    palmMinNorm:.04,           // min |palm normal| to trust the Blue/Red orientation
    poseKeep:.6, poseOn:.7, poseOff:.3,   // EMA + hysteresis
    posSmoothing:.55,
    flick:     { windowMs:120, minSpeed:3.2, minGrowth:1.4 },
    openFlick: { historyMs:500, maxAgeMs:450, minOpen:.3, minTipSpeed:3.5, dropoutMs:260 },   // see OpenFlickDetector; minOpen = slider default
  },
  ready: .35,                  // charge fraction after which a flick fires
  domain: { chargeTime:1.2, collapseTime:.7, stars:260 },
  orb:    { chargeTime:1.4, decayTime:.5, mergeChargeTime:.5, cooldown:.8, firedFlash:.55,
            float:.55 },        // default for the Orb distance slider: how far past the fingertip the orb floats, × hand size (~5 cm)
  // projectiles travel a fixed share of the screen diagonal (so they always land on-screen)
  // and grow as they fly, reading as "coming at the camera"
  blue:   { flight:.42, reach:.30, growth:1.45, wellLife:1.4, collapse:.28, maxWells:2 },
  red:    { flight:.24, reach:.38, growth:1.6 },
  purple: { flickGrace:.65, handChargeTime:1.6, mergeChargeTime:.9, decayTime:.4, cooldown:3, beamDuration:1.6, joinDist:1.1, breakDist:1.8 },   // the fired sphere travels for beamDuration
  fx:     { maxParticles:1100 },
  colors: {
    blue:   { c1:'140,200,255', c2:'40,90,255',  wash:'40,95,255'  },
    red:    { c1:'255,120,120', c2:'225,15,40',  wash:'215,10,35'  },
    purple: { c1:'215,160,255', c2:'130,50,230', wash:'120,40,225' },
  },
  fonts: {
    serif: '"Shippori Mincho","Yu Mincho","Hiragino Mincho ProN",serif',   // kanji title cards
    latin: '"Oswald","Arial Narrow",sans-serif',                            // small caps labels
  },
};
const COL = CONFIG.colors, READY = CONFIG.ready, SERIF = CONFIG.fonts.serif, LATIN = CONFIG.fonts.latin;

/* ============================== 2. UTILITIES ============================== */
/* math / DOM / tracking helpers come from shared/js */
/** Shared animation clock (seconds since start), advanced once per rendered frame. */
const Clock = { t:0 };

/* ============================== 3. SOUND ============================== */
/**
 * Fully synthesized audio. Must be init() from a user gesture.
 * getLevels() → { master, sfx, voice } each 0..1. Routing:
 *   loops + hits → sfx bus ─┐
 *   voice clips → voice bus ├→ master → compressor → out
 *   music (attachMedia)  ───┘
 */
function createSound(getLevels) {
  let ac = null, master, sfx, voiceBus, reverb, noiseBuf; const loops = {};

  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ac = new AC();
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6;
    const lv = getLevels();
    master = ac.createGain(); master.gain.value = lv.master; master.connect(comp); comp.connect(ac.destination);
    sfx = ac.createGain(); sfx.gain.value = lv.sfx; sfx.connect(master);
    voiceBus = ac.createGain(); voiceBus.gain.value = lv.voice; voiceBus.connect(master);
    const len = ac.sampleRate*2; noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random()*2 - 1;
    buildLoops();
    buildReverb();
  }

  /** A big dark hall for the voice: decaying stereo noise as the impulse response. */
  function buildReverb() {
    const len = Math.floor(ac.sampleRate*2.4), ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random()*2 - 1)*Math.pow(1 - i/len, 3.2); }
    reverb = ac.createConvolver(); reverb.buffer = ir;
    const wet = ac.createGain(); wet.gain.value = .45; reverb.connect(wet); wet.connect(voiceBus);
  }

  function buildLoops() {
    const osc = (type, f) => { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; };
    const out = () => { const g = ac.createGain(); g.gain.value = 0; g.connect(sfx); return g; };
    const lp  = (f, q) => { const n = ac.createBiquadFilter(); n.type = 'lowpass'; n.frequency.value = f; n.Q.value = q || 1; return n; };
    { // BLUE: airy rising hum
      const g = out(), f = lp(800,4), o1 = osc('sine',220), o2 = osc('triangle',221.5), o3 = osc('sine',440), g3 = ac.createGain(); g3.gain.value = .3;
      o1.connect(f); o2.connect(f); o3.connect(g3); g3.connect(f); f.connect(g);
      loops.blue = { g, f, oscs:[o1,o2,o3] };
    }
    { // RED: pulsing saw + crackle
      const g = out(), f = lp(700,6), o1 = osc('sawtooth',73), o2 = osc('square',73.6), trem = ac.createGain(); trem.gain.value = .6;
      const lfo = osc('square',13), lg = ac.createGain(); lg.gain.value = .4; lfo.connect(lg); lg.connect(trem.gain);
      o1.connect(f); o2.connect(f); f.connect(trem); trem.connect(g);
      const n = ac.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
      const nb = ac.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 3200; nb.Q.value = 1.2;
      const ng = ac.createGain(); ng.gain.value = .12; n.connect(nb); nb.connect(ng); ng.connect(trem); n.start();
      loops.red = { g, f, oscs:[o1,o2] };
    }
    { // PURPLE: detuned drone that climbs
      const g = out(), f = lp(400,3), os = [osc('sawtooth',110), osc('sawtooth',110.9), osc('sawtooth',109.2)], sub = osc('sine',55), sg = ac.createGain(); sg.gain.value = .9;
      os.forEach(o => o.connect(f)); sub.connect(sg); sg.connect(g); f.connect(g);
      loops.purple = { g, f, oscs:os, sub };
    }
    { // DOMAIN: beating sub drone + shimmer
      const g = out(), a = osc('sine',48), b = osc('sine',48.8), c = osc('triangle',196), f = lp(900,1);
      const lfo = osc('sine',.3), lg = ac.createGain(); lg.gain.value = 120; lfo.connect(lg); lg.connect(f.frequency);
      a.connect(g); b.connect(g); c.connect(f); f.connect(g);
      loops.domain = { g, f };
    }
  }

  /** levels: { blue, red, purple, domain } each 0..1 */
  function update(lv) {
    if (!ac) return;
    const t = ac.currentTime, s = (param, v, tc) => param.setTargetAtTime(v, t, tc || .06);
    const v = getLevels();
    s(master.gain, v.master, .05); s(sfx.gain, v.sfx, .05); s(voiceBus.gain, v.voice, .05);
    let L = loops.blue;   s(L.g.gain, .2*lv.blue, .08);   s(L.f.frequency, 500 + 2600*lv.blue);
    s(L.oscs[0].frequency, 200 + 380*lv.blue); s(L.oscs[1].frequency, 201.5 + 380*lv.blue); s(L.oscs[2].frequency, 400 + 760*lv.blue);
    L = loops.red;        s(L.g.gain, .16*lv.red, .08);   s(L.f.frequency, 500 + 2200*lv.red);
    s(L.oscs[0].frequency, 65 + 45*lv.red); s(L.oscs[1].frequency, 65.6 + 45*lv.red);
    L = loops.purple;     s(L.g.gain, .26*lv.purple, .1); s(L.f.frequency, 300 + 3200*lv.purple);
    s(L.oscs[0].frequency, 100 + 150*lv.purple); s(L.oscs[1].frequency, 100.9 + 150*lv.purple); s(L.oscs[2].frequency, 99.2 + 150*lv.purple);
    s(L.sub.frequency, 50 + 25*lv.purple);
    L = loops.domain;     s(L.g.gain, .24*lv.domain, .15);
  }

  function noise(dur, o = {}) {
    const { f0 = 2000, f1 = 200, q = 1, type = 'bandpass', gain = .5, attack = .005, delay = 0 } = o;
    const t = ac.currentTime + delay, src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f0, t); fl.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ac.createGain(); g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    src.connect(fl); fl.connect(g); g.connect(sfx); src.start(t, Math.random()); src.stop(t + dur + .05);
  }
  function tone(type, f0, f1, dur, o = {}) {
    const { gain = .5, attack = .005, delay = 0 } = o;
    const t = ac.currentTime + delay, osc = ac.createOscillator(); osc.type = type;
    osc.frequency.setValueAtTime(f0, t); osc.frequency.exponentialRampToValueAtTime(Math.max(15, f1), t + dur);
    const g = ac.createGain(); g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    osc.connect(g); g.connect(sfx); osc.start(t); osc.stop(t + dur + .05);
  }
  const shots = {
    ready:       () => { tone('sine',1320,1320,.28,{gain:.18}); tone('sine',1980,1980,.22,{gain:.1,delay:.05}); },
    blueFire:    () => { noise(.5,{f0:400,f1:5000,q:2,gain:.5}); tone('sine',900,180,.45,{gain:.35}); tone('triangle',300,1200,.25,{gain:.15}); },
    redFire:     () => { noise(.25,{type:'lowpass',f0:5000,f1:300,gain:.7}); tone('sine',160,40,.35,{gain:.7}); tone('sawtooth',900,90,.2,{gain:.25}); },
    redHit:      () => { noise(.8,{type:'lowpass',f0:3500,f1:120,gain:.9}); tone('sine',90,28,.7,{gain:.9}); noise(.3,{type:'highpass',f0:4000,f1:6000,gain:.25}); },
    wellOpen:    () => { noise(.9,{f0:6000,f1:300,q:3,gain:.35}); tone('sine',1400,90,1.0,{gain:.25}); },
    wellBoom:    () => { tone('sine',110,30,.9,{gain:.8}); noise(.6,{type:'lowpass',f0:2500,f1:150,gain:.6}); noise(.5,{f0:200,f1:8000,q:1.5,gain:.3}); },
    purpleFire:  () => { tone('sine',80,25,2.2,{gain:1}); noise(2.2,{type:'lowpass',f0:6000,f1:150,gain:.9}); tone('sawtooth',150,1800,.5,{gain:.3}); noise(.6,{type:'highpass',f0:1500,f1:9000,gain:.4}); tone('sine',3000,3000,1.2,{gain:.08}); },
    domainStart: () => { tone('sine',60,120,1.2,{gain:.4}); noise(1.2,{f0:300,f1:3000,q:2,gain:.25}); },
    domainBoom:  () => { tone('sine',70,25,1.6,{gain:1}); noise(1.4,{type:'lowpass',f0:4000,f1:100,gain:.8}); tone('sine',440,438,1.6,{gain:.12}); tone('sine',660,657,1.4,{gain:.08}); },
    // exorcism mode
    curseSpawn:  () => { tone('sawtooth',95,55,.7,{gain:.1,attack:.08}); noise(.7,{type:'lowpass',f0:700,f1:180,gain:.14,attack:.1}); },
    bossRoar:    () => { noise(1.6,{f0:320,f1:110,q:2.5,gain:.8,attack:.15}); tone('sawtooth',72,44,1.6,{gain:.35,attack:.12}); tone('square',110,70,1.2,{gain:.08,attack:.2}); },
    curseHit:    () => { noise(.12,{type:'highpass',f0:2400,f1:900,gain:.3}); tone('square',240,110,.1,{gain:.08}); },
    curseDie:    () => { noise(.55,{f0:1600,f1:140,q:1.5,gain:.4}); tone('sine',320,60,.45,{gain:.3}); tone('sine',1568,1568,.5,{gain:.07,delay:.06}); tone('sine',2349,2349,.4,{gain:.04,delay:.1}); },
    hurt:        () => { tone('sawtooth',130,38,.55,{gain:.45}); noise(.45,{type:'lowpass',f0:1400,f1:90,gain:.7}); },
    waveStart:   () => { tone('sine',196,195,2.4,{gain:.32,attack:.01}); tone('sine',196*2.76,196*2.75,1.6,{gain:.12}); tone('sine',196*5.4,196*5.38,.9,{gain:.05}); noise(1.2,{f0:200,f1:1800,q:5,gain:.08}); },
    waveClear:   () => { [784,988,1175,1568].forEach((f,i) => tone('sine',f,f,.6,{gain:.09,delay:i*.07})); },
    gameOver:    () => { tone('sine',150,36,2.4,{gain:.6}); noise(2.2,{type:'lowpass',f0:900,f1:60,gain:.5}); tone('sine',233,231,2,{gain:.1,delay:.2}); },
  };
  function shot(name) { if (ac && shots[name]) shots[name](); }

  /** Route an <audio> element through the mix (master volume + compressor). Returns its gain node, or null. */
  function attachMedia(el) {
    if (!ac) return null;
    const src = ac.createMediaElementSource(el), g = ac.createGain();
    g.gain.value = 0; src.connect(g); g.connect(master);
    return { gain:g, ac };
  }

  /** Decode a fetched clip (ArrayBuffer → AudioBuffer). */
  function decode(ab) { return ac ? new Promise((res, rej) => ac.decodeAudioData(ab, res, rej)) : Promise.reject(new Error('no audio')); }
  /** Play a voice clip: slightly slowed for weight, dry + hall reverb, on the voice bus. Returns its duration (s). */
  function playVoice(buf, rate = .94) {
    if (!ac) return 0;
    const src = ac.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    src.connect(voiceBus); src.connect(reverb); src.start();
    return buf.duration/rate;
  }

  return { init, update, shot, attachMedia, decode, playVoice, get ready() { return !!ac; } };
}



/* ============================== 4. DRAW ============================== */
/** Stateless painters. Time-based animation reads Clock.t. */
const Draw = (() => {
  const video = drawMirroredVideo, skeleton = drawSkeleton;
  /** Cinematic grade: pull saturation down, cool and darken slightly. */
  function grade(ctx, W, H) {
    ctx.save();
    ctx.globalCompositeOperation = 'saturation'; ctx.globalAlpha = .45; ctx.fillStyle = '#808080'; ctx.fillRect(0,0,W,H);
    ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 1; ctx.fillStyle = '#b4bfd4'; ctx.fillRect(0,0,W,H);
    ctx.restore();
  }
  const scaleRgb = (rgb, f) => rgb.split(',').map(v => Math.round(+v*f)).join(',');
  /**
   * Whole-frame colour wash, like the anime bathing the scene in the technique's colour:
   * recolour (keeps luminance) → darken the edges in that hue → bloom from the source.
   */
  function wash(ctx, W, H, rgb, a, x, y) {
    a = clamp(a, 0, 1); if (a <= 0) return;
    const diag = Math.hypot(W,H);
    ctx.save();
    ctx.globalCompositeOperation = 'color'; ctx.globalAlpha = a*.85; ctx.fillStyle = `rgb(${rgb})`; ctx.fillRect(-60,-60,W+120,H+120);
    ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = a*.7;
    let g = ctx.createRadialGradient(x,y,0,x,y,diag*.75);
    g.addColorStop(0,'#fff'); g.addColorStop(.35,`rgb(${scaleRgb(rgb,.9)})`); g.addColorStop(1,`rgb(${scaleRgb(rgb,.18)})`);
    ctx.fillStyle = g; ctx.fillRect(-60,-60,W+120,H+120);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a*.4;
    g = ctx.createRadialGradient(x,y,0,x,y,diag*.4);
    g.addColorStop(0,`rgba(${rgb},.9)`); g.addColorStop(1,`rgba(${rgb},0)`);
    ctx.fillStyle = g; ctx.fillRect(-60,-60,W+120,H+120);
    ctx.restore();
  }
  function glow(ctx, x, y, r, col, alpha = 1) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(x,y,0,x,y,r*2.6);
    g.addColorStop(0, 'rgba(255,255,255,.85)'); g.addColorStop(.16, `rgba(${col.c1},.75)`);
    g.addColorStop(.45, `rgba(${col.c2},.28)`); g.addColorStop(1, `rgba(${col.c2},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x,y,r*2.6,0,TAU); ctx.fill();
    ctx.restore();
  }
  /**
   * Cursed-energy crackle: thin white electric filaments curling around a point, with a
   * coloured halo and scattered spark droplets. Re-seeded 14×/s so it flickers like cel animation.
   */
  function crackle(ctx, x, y, R, n, rgb, amt, seed = 1) {
    if (amt <= 0 || R <= 0) return;
    const rnd = mulberry(Math.floor(Clock.t*14)*7919 + seed*131);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      // each filament curls around the source: smooth drift in angle and radius, tiny electric kinks
      let ang = rnd()*TAU, rr = R*(.4 + rnd()*.6), curl = (rnd() - .5)*.3;
      const sgn = rnd() < .5 ? -1 : 1, segs = 10 + Math.floor(rnd()*8), step = (.35 + rnd()*.6)/segs, kink = R*.018;
      const al = amt*(.45 + rnd()*.55), pts = [];
      for (let j = 0; j <= segs; j++) {
        pts.push([x + Math.cos(ang)*rr + (rnd() - .5)*kink, y + Math.sin(ang)*rr*.9 + (rnd() - .5)*kink]);
        ang += sgn*step*TAU*.25; curl += (rnd() - .5)*.12; rr *= 1 + curl*.08;
      }
      ctx.beginPath(); pts.forEach(([px,py], j) => j ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
      ctx.strokeStyle = `rgba(${rgb},${.3*al})`; ctx.lineWidth = Math.max(2, R*.025); ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${.95*al})`; ctx.lineWidth = Math.max(.7, R*.006); ctx.stroke();
      const drops = 1 + Math.floor(rnd()*3);                          // spark droplets along the thread
      for (let k = 0; k < drops; k++) {
        const [px, py] = pts[Math.floor(rnd()*pts.length)];
        ctx.fillStyle = `rgba(255,255,255,${al*.9})`; ctx.beginPath();
        ctx.arc(px + (rnd() - .5)*R*.12, py + (rnd() - .5)*R*.12, .7 + rnd()*Math.min(3, R*.015), 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
  }
  /** Soft halo + two thin rotating arcs: shared by all three spheres. */
  function halo(ctx, x, y, r, rgbIn, rgbOut, size, alpha) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(x,y,r*.6,x,y,r*size);
    g.addColorStop(0,`rgba(${rgbIn},.55)`); g.addColorStop(.3,`rgba(${rgbOut},.22)`); g.addColorStop(1,`rgba(${rgbOut},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x,y,r*size,0,TAU); ctx.fill(); ctx.restore();
  }
  function rimAndArcs(ctx, x, y, r, rimRgb, arcRgb, spin, alpha) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alpha;
    ctx.strokeStyle = `rgba(${rimRgb},.18)`; ctx.lineWidth = r*.5; ctx.beginPath(); ctx.arc(x,y,r*1.02,0,TAU); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';                     // solid rim keeps its own hue over the colour wash
    ctx.strokeStyle = `rgba(${rimRgb},.95)`; ctx.lineWidth = Math.max(1.5, r*.12); ctx.beginPath(); ctx.arc(x,y,r*1.01,0,TAU); ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(${arcRgb},.9)`; ctx.lineWidth = Math.max(1, r*.045);
    const a = Clock.t*spin;
    ctx.beginPath(); ctx.arc(x,y,r*1.3,a,a+1.3); ctx.stroke();
    ctx.beginPath(); ctx.arc(x,y,r*1.3,a+Math.PI,a+Math.PI+.8); ctx.stroke();
    ctx.restore();
  }

  /* ---- RED 赫: small, dense, dark crimson sphere with a burning rim ---- */
  function redOrb(ctx, x, y, r, pw, alpha = 1) {
    halo(ctx, x, y, r, '255,50,70', '200,10,30', 3.6, alpha);
    ctx.save(); ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(x - r*.3, y - r*.35, r*.05, x, y, r);
    g.addColorStop(0,'#ff7a80'); g.addColorStop(.4,'#b10a1c'); g.addColorStop(1,'#3d0006');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); ctx.restore();
    rimAndArcs(ctx, x, y, r, '255,70,85', '255,225,225', 3, alpha);
    ctx.save(); ctx.globalAlpha = alpha*.7; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x - r*.35, y - r*.38, r*.1, 0, Math.PI*2); ctx.fill(); ctx.restore();
  }
  /* ---- BLUE 蒼: bright compressed point, space bending in around it ---- */
  function blueOrb(ctx, x, y, r, pw, alpha = 1) {
    const t = Clock.t;
    ctx.save(); ctx.globalAlpha = alpha*.75;                          // dark lensing ring
    const d = ctx.createRadialGradient(x,y,r*.9,x,y,r*2.8);
    d.addColorStop(0,'rgba(0,6,30,.6)'); d.addColorStop(1,'rgba(0,6,30,0)');
    ctx.fillStyle = d; ctx.beginPath(); ctx.arc(x,y,r*2.8,0,Math.PI*2); ctx.fill(); ctx.restore();
    halo(ctx, x, y, r, '120,190,255', '30,80,255', 3.4, alpha);
    ctx.save(); ctx.translate(x,y); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alpha;   // inward spiral
    const spin = t*(3 + 5*pw), lw = clamp(r/30, .8, 1.6);
    for (let a = 0; a < 3; a++) {
      let px = 0, py = 0;
      for (let i = 0; i <= 22; i++) {
        const u = i/22, rad = r*(2.8 - 1.7*u), ang = a*2.094 - spin + u*4.2;
        const nx = Math.cos(ang)*rad, ny = Math.sin(ang)*rad*.9;
        if (i) { ctx.strokeStyle = `rgba(170,215,255,${.04 + .6*u})`; ctx.lineWidth = (.4 + 1.8*u)*lw; ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(nx,ny); ctx.stroke(); }
        px = nx; py = ny;
      }
    }
    ctx.restore();
    ctx.save(); ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(x - r*.2, y - r*.25, r*.05, x, y, r);
    g.addColorStop(0,'#ffffff'); g.addColorStop(.3,'#a8d6ff'); g.addColorStop(.75,'#2e6cff'); g.addColorStop(1,'#0a1e78');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); ctx.restore();
    rimAndArcs(ctx, x, y, r, '80,140,255', '225,238,255', -2.6, alpha);
  }
  /* ---- PURPLE 茈: a massive sphere of imaginary mass, white-hot heart ---- */
  function purpleOrb(ctx, x, y, r, pw, alpha = 1) {
    const t = Clock.t;
    halo(ctx, x, y, r, '190,120,255', '110,30,220', 3.2, alpha);
    ctx.save(); ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(x - r*.15, y - r*.2, r*.02, x, y, r);
    g.addColorStop(0,'#ffffff'); g.addColorStop(.2,'#ecd4ff'); g.addColorStop(.55,'#9a4cff'); g.addColorStop(.88,'#3c0b88'); g.addColorStop(1,'#1a0340');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); ctx.restore();
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alpha;             // swirling surface
    ctx.translate(x,y); ctx.rotate(t*.9);
    for (let i = 0; i < 5; i++) {
      ctx.strokeStyle = `rgba(230,200,255,${.12 + .06*i})`; ctx.lineWidth = Math.max(1, r*.025);
      ctx.beginPath(); ctx.ellipse(0,0,r*(.55 + .09*i),r*(.25 + .05*i),i*.6,0,Math.PI*1.2); ctx.stroke();
    }
    ctx.restore();
    rimAndArcs(ctx, x, y, r, '215,165,255', '255,245,255', 2, alpha);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alpha;             // slow ripples
    for (let i = 0; i < 2; i++) {
      const ph = (t*.5 + i/2) % 1;
      ctx.strokeStyle = `rgba(205,160,255,${(1-ph)*.4})`; ctx.lineWidth = 1 + (1-ph)*1.5;
      ctx.beginPath(); ctx.arc(x,y,r*(1.4 + ph*2.6),0,Math.PI*2); ctx.stroke();
    }
    ctx.restore();
  }

  /** Focus lines, re-seeded at 12 fps ("on twos"). */
  function speedLines(ctx, cx, cy, W, H, amt, color, count) {
    if (amt <= 0) return;
    const rnd = mulberry(Math.floor(Clock.t*12)*9973 + 11), diag = Math.hypot(W,H);
    ctx.save(); ctx.globalAlpha = clamp(amt,0,1); ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const a = rnd()*TAU, r0 = diag*(.16 + rnd()*.22), r1 = diag*(.62 + rnd()*.3), w = diag*(.0015 + rnd()*.006);
      const c = Math.cos(a), s = Math.sin(a);
      ctx.beginPath(); ctx.moveTo(cx+c*r0, cy+s*r0); ctx.lineTo(cx+c*r1-s*w, cy+s*r1+c*w); ctx.lineTo(cx+c*r1+s*w, cy+s*r1-c*w); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  /** Minimal charge readout: thin arc, a tick at READY, small caps label. o = { x, y, r } */
  function chargePrompt(ctx, o, charge, rgb, u) {
    const ready = charge > READY, R = o.r*2.3, fs = Math.max(11, u*(ready ? .022 : .018));
    ctx.save();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.beginPath(); ctx.arc(o.x,o.y,R,0,TAU); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = ready ? '#fff' : `rgba(${rgb},.95)`; ctx.shadowColor = `rgb(${rgb})`; ctx.shadowBlur = ready ? 12 : 0;
    ctx.beginPath(); ctx.arc(o.x,o.y,R,-Math.PI/2,-Math.PI/2 + charge*TAU); ctx.stroke(); ctx.shadowBlur = 0;
    const a = -Math.PI/2 + READY*TAU;
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.beginPath();
    ctx.moveTo(o.x+Math.cos(a)*(R-6), o.y+Math.sin(a)*(R-6)); ctx.lineTo(o.x+Math.cos(a)*(R+6), o.y+Math.sin(a)*(R+6)); ctx.stroke();
    ctx.font = `500 ${fs}px ${LATIN}`; spacing(ctx, fs*.4); ctx.textAlign = 'center';
    ctx.fillStyle = ready ? '#fff' : `rgba(${rgb},.9)`; ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 6;
    ctx.fillText(ready ? 'FLICK' : 'HOLD', o.x, o.y - R - 12);
    ctx.restore();
  }
  function vignette(ctx, W, H) {
    const vg = ctx.createRadialGradient(W/2, H/2, Math.min(W,H)*.35, W/2, H/2, Math.hypot(W,H)*.58);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.7)');
    ctx.fillStyle = vg; ctx.fillRect(0,0,W,H);
  }

  return { video, grade, wash, glow, crackle, redOrb, blueOrb, purpleOrb, speedLines, chargePrompt, vignette, skeleton };
})();

/* ============================== 5. EFFECTS ============================== */
/** Owns every short-lived visual and the screen-level shake / flash / impact frame / colour tint. */
class Effects {
  constructor() {
    this.particles = []; this.waves = []; this.titles = []; this.blasts = [];
    this.shake = 0; this.flash = 0; this.impact = 0; this.impactAt = { x:0, y:0 };
    this.tint = { rgb:'255,255,255', a:0, x:0, y:0 };
    this.reduceFlashes = false;
  }
  /** p = { x, y, vx, vy, life, max, col, size, target?, streak?, drag? } — target: any live {x,y,r}; streak: tail in seconds of velocity */
  spawn(p) { if (this.particles.length < CONFIG.fx.maxParticles) this.particles.push(p); }
  burst(x, y, rgb, n, smin, smax, o = {}) {
    for (let k = 0; k < n; k++) {
      const a = rand(0,6.28), s = rand(smin,smax), life = o.life || rand(.4,.8);
      this.spawn({ x, y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, life, max:life, col:rgb, size:rand(1,2.6), streak:o.streak ?? .05, drag:o.drag ?? .9 });
    }
  }
  /** Rising cursed-energy wisps around a point. */
  wisps(x, y, r, rgb, n) {
    for (let k = 0; k < n; k++) {
      const life = rand(.4,.8);
      this.spawn({ x:x + rand(-1,1)*r*.8, y:y + rand(-1,1)*r*.8, vx:rand(-25,25), vy:-rand(70,190), life, max:life, col:rgb, size:rand(.8,2), streak:.09 });
    }
  }
  wave(x, y, col, max, o = {}) { this.waves.push({ x, y, t:o.delay ? -o.delay : 0, col, max, life:o.life || .6, rev:!!o.rev, width:o.width || 6 }); }
  /** Kanji title flash (e.g. 蒼 / 赫 / 茈). */
  title(text, x, y, color, size, o = {}) { this.titles.push({ text, sub:o.sub || '', x, y, color, size, t:0, life:o.life || 1.2 }); }
  /** Radial shock blast. o: { rgb, edge, life, scale } */
  blast(x, y, o = {}) {
    this.blasts.push({ x, y, t:0, life:o.life || .75, scale:o.scale || 1.25, rgb:o.rgb || '190,120,255', edge:o.edge || '235,205,255' });
  }
  kick({ shake = 0, flash = 0, impact = 0, at = null, tint = null } = {}) {
    this.shake = Math.max(this.shake, shake);
    this.flash = Math.max(this.flash, flash);
    if (impact > 0) { this.impact = Math.max(this.impact, impact); if (at) this.impactAt = { x:at.x, y:at.y }; }
    if (tint && tint.a >= this.tint.a) this.tint = { rgb:tint.rgb, a:tint.a, x:(at || this.impactAt).x, y:(at || this.impactAt).y };
  }

  update(dt) {
    for (const p of this.particles) {
      p.life -= dt;
      if (p.target) {
        const dx = p.target.x - p.x, dy = p.target.y - p.y;
        p.vx += dx*9*dt; p.vy += dy*9*dt; p.vx *= .93; p.vy *= .93;
        if (Math.hypot(dx,dy) < p.target.r*.5) p.life = 0;
      } else if (p.drag) { const d = Math.pow(p.drag, dt*60); p.vx *= d; p.vy *= d; }
      p.x += p.vx*dt; p.y += p.vy*dt;
    }
    prune(this.particles, p => p.life > 0);
    for (const w of this.waves)  w.t += dt;  prune(this.waves,  w => w.t <= w.life);
    for (const s of this.titles) s.t += dt;  prune(this.titles, s => s.t < s.life);
    for (const b of this.blasts) b.t += dt;  prune(this.blasts, b => b.t < b.life);
    this.shake  = Math.max(0, this.shake - dt*2.2);
    this.flash  = Math.max(0, this.flash - dt*3.5);
    this.impact = Math.max(0, this.impact - dt);
    this.tint.a = Math.max(0, this.tint.a - dt*1.4);
  }

  applyShake(ctx, k) {
    if (this.shake > 0) ctx.translate((Math.random()-.5)*this.shake*24*k, (Math.random()-.5)*this.shake*24*k);
  }
  drawTint(ctx, W, H) { if (this.tint.a > 0) Draw.wash(ctx, W, H, this.tint.rgb, this.tint.a, this.tint.x, this.tint.y); }
  drawParticles(ctx) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    for (const p of this.particles) {
      const a = clamp(p.life/p.max,0,1);
      ctx.globalAlpha = a;
      if (p.streak) {
        ctx.strokeStyle = `rgb(${p.col})`; ctx.lineWidth = p.size;
        ctx.beginPath(); ctx.moveTo(p.x - p.vx*p.streak, p.y - p.vy*p.streak); ctx.lineTo(p.x, p.y); ctx.stroke();
      } else {
        ctx.fillStyle = `rgb(${p.col})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
      }
    }
    ctx.restore();
  }
  drawWaves(ctx) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const w of this.waves) {
      if (w.t < 0) continue;
      const p = w.t/w.life, rad = w.max*(w.rev ? 1 - ease(p) : ease(p));
      ctx.strokeStyle = `rgba(${w.col},${(w.rev ? p : 1-p)*.9})`; ctx.lineWidth = w.width*(1-p) + 1;
      ctx.beginPath(); ctx.arc(w.x, w.y, Math.max(1,rad), 0, Math.PI*2); ctx.stroke();
    }
    ctx.restore();
  }
  drawBlasts(ctx, W, H) {
    const diag = Math.hypot(W,H);
    for (const b of this.blasts) {
      const p = b.t/b.life, R = diag*b.scale*ease(p);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(b.x,b.y,R*.5,b.x,b.y,R);
      g.addColorStop(0,`rgba(${b.rgb},0)`); g.addColorStop(.8,`rgba(${b.rgb},${.4*(1-p)})`); g.addColorStop(1,`rgba(${b.edge},${.65*(1-p)})`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x,b.y,R,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle = `rgba(${b.edge},${1-p})`; ctx.lineWidth = 10*(1-p) + 1; ctx.beginPath(); ctx.arc(b.x,b.y,R,0,Math.PI*2); ctx.stroke();
      if (p < .3) {
        const c = ctx.createRadialGradient(b.x,b.y,0,b.x,b.y,diag*.25);
        c.addColorStop(0,`rgba(255,255,255,${(1 - p/.3)*.9})`); c.addColorStop(1,'rgba(255,255,255,0)');
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc(b.x,b.y,diag*.25,0,Math.PI*2); ctx.fill();
      }
      ctx.restore();
    }
  }
  /** Kanji titles: fade in with a slow push-in, soft coloured glow, no bounce. */
  drawTitles(ctx, W, H) {
    for (const s of this.titles) {
      const p = s.t/s.life, a = p < .1 ? p/.1 : p > .6 ? (1-p)/.4 : 1, sc = 1.12 - .12*ease(Math.min(1, p/.35));
      const x = clamp(s.x, s.size, W - s.size), y = clamp(s.y, s.size, H - s.size*.3);
      ctx.save(); ctx.globalAlpha = clamp(a,0,1); ctx.translate(x, y); ctx.scale(sc, sc);
      ctx.textAlign = 'center'; ctx.font = `800 ${s.size}px ${SERIF}`;
      ctx.shadowColor = s.color; ctx.shadowBlur = s.size*.35;
      ctx.lineWidth = Math.max(1, s.size*.03); ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(s.text, 0, 0);
      ctx.fillStyle = '#fff'; ctx.fillText(s.text, 0, 0);
      if (s.sub) { ctx.shadowBlur = 8; const fs = Math.max(11, s.size*.13); ctx.font = `400 ${fs}px ${LATIN}`; spacing(ctx, fs*.5); ctx.fillText(s.sub, 0, s.size*.34); }
      ctx.restore();
    }
  }
  /** White flash + anime impact frame: colours inverted to monochrome, black focus lines. */
  drawScreen(ctx, W, H) {
    if (this.reduceFlashes) {
      if (this.impact > 0) Draw.speedLines(ctx, this.impactAt.x, this.impactAt.y, W, H, .35, '#000', 90);
      return;
    }
    if (this.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${.35*this.flash})`; ctx.fillRect(-60,-60,W+120,H+120); }
    if (this.impact > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = '#fff'; ctx.fillRect(-60,-60,W+120,H+120);
      ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = '#808080'; ctx.fillRect(-60,-60,W+120,H+120);
      ctx.restore();
      Draw.speedLines(ctx, this.impactAt.x, this.impactAt.y, W, H, 1, '#000', 150);
    }
  }
}

/* ============================== 6. GESTURES ============================== */
/**
 * Turn one hand's landmarks into a reading.
 *
 * Domain / Blue / Red use the original 2D image-space tests (they were reliable).
 * Hollow Purple uses 3D world landmarks (metres, hand-centred), so it reads the same whatever
 * way the palm faces: a loaded finger-flick = thumb tip touching the index tip / nail joint
 * (`pinch` below `pinchDist` × hand size) with the middle finger open.
 *
 * @param lm     normalized image landmarks
 * @param world  world landmarks (or null → falls back to normalized x/y/z)
 * @returns {{pose, note, size, dir, tip, center, pts, isRight, pinch, loaded}}
 */
function readHand(lm, world, W, H, isRight, opts) {
  const G = CONFIG.gesture;
  const raw = lm.map(p => ({ x:p.x*W, y:p.y*H }));                    // unmirrored 2D (geometry)
  const pts = lm.map(p => ({ x:(1-p.x)*W, y:p.y*H }));                // mirrored 2D (drawing)
  const size = dist(raw[0], raw[9]) || 1;

  // --- 2D finger states (original tests) ---
  const ext2 = (tip, pip) => dist(raw[tip], raw[0]) > dist(raw[pip], raw[0])*G.extendRatio;
  const idx = ext2(8,6), mid = ext2(12,10), rng = ext2(16,14), pky = ext2(20,18);

  // --- 3D loaded-flick test (Hollow Purple) ---
  const w = world && world.length === 21 ? world : lm.map(p => ({ x:p.x*W, y:p.y*H, z:(p.z || 0)*W }));
  const size3 = V3.dist(w[0], w[9]) || 1e-6;
  const pinch = Math.min(V3.dist(w[4], w[8]), V3.dist(w[4], w[7])) / size3;   // thumb tip ↔ index tip or nail joint
  const mid3 = V3.dist(w[12], w[0]) > V3.dist(w[10], w[0])*G.extendRatio;     // middle open (rules out a fist)
  const loaded = mid3 && pinch < opts.pinchDist;

  let pose = 'none', note = `pinch${pinch.toFixed(2)} m${+mid3} | i${+idx}m${+mid}r${+rng}p${+pky}`;
  const ax = raw[9].x - raw[5].x, ay = raw[9].y - raw[5].y, al = Math.hypot(ax,ay) || 1;
  if (idx && mid && !rng && !pky) {                                  // Domain: crossed index + middle
    const sep = ((raw[12].x-raw[8].x)*ax/al + (raw[12].y-raw[8].y)*ay/al) / size;
    note += ' sep' + sep.toFixed(2);
    if (sep < G.domainMaxSep) pose = 'domain';
  }
  if (pose === 'none' && loaded) {
    pose = 'purple'; note += ' ★FLICK';
  } else if (pose === 'none' && idx && !mid && !rng && !pky) {        // Blue / Red: index only
    const v1 = { x:raw[5].x-raw[0].x, y:raw[5].y-raw[0].y }, v2 = { x:raw[17].x-raw[0].x, y:raw[17].y-raw[0].y };
    const norm = (v1.x*v2.y - v1.y*v2.x) / (size*size);
    note += ' palm' + norm.toFixed(2);
    if (Math.abs(norm) > G.palmMinNorm) {
      let facingCam = isRight ? norm < 0 : norm > 0;
      if (opts.swap) facingCam = !facingCam;
      pose = facingCam ? 'blue' : 'red';
    }
  }

  const isP = pose === 'purple';
  const a0 = isP ? pts[0] : pts[5], a1 = isP ? pts[9] : pts[8];      // purple aims along the hand
  const dl = Math.hypot(a1.x-a0.x, a1.y-a0.y) || 1;
  const tip = isP ? { x:(pts[4].x + pts[8].x)/2, y:(pts[4].y + pts[8].y)/2 } : pts[8];   // purple: the thumb–index circle
  return { pose, note, size, dir:{ x:(a1.x-a0.x)/dl, y:(a1.y-a0.y)/dl }, tip, center:pts[9], pts, isRight, pinch, loaded };
}
/** Debounces each pose (EMA + hysteresis) and keeps a smoothed position/size/direction. */
class PoseTracker {
  constructor(names) {
    this.state = {};
    for (const n of names) this.state[n] = { on:false, hand:null, pos:{x:0,y:0}, size:80, dir:{x:0,y:-1}, sig:0, seen:false };
  }
  ingest(hands) {
    const G = CONFIG.gesture, found = {};
    for (const h of hands) if (h.pose !== 'none' && !found[h.pose]) found[h.pose] = h;
    for (const [name, s] of Object.entries(this.state)) {
      const h = found[name] || null;
      s.hand = h;
      s.sig = s.sig*G.poseKeep + (h ? 1 - G.poseKeep : 0);
      s.on = s.on ? s.sig > G.poseOff : s.sig > G.poseOn;
      if (!s.on) s.seen = false;
      if (h) {
        const p = name === 'domain' ? h.center : h.tip;
        if (!s.seen) { s.pos = { x:p.x, y:p.y }; s.seen = true; }
        else { s.pos.x += (p.x - s.pos.x)*G.posSmoothing; s.pos.y += (p.y - s.pos.y)*G.posSmoothing; }
        s.size = h.size;
        const dx = s.dir.x + (h.dir.x - s.dir.x)*G.posSmoothing, dy = s.dir.y + (h.dir.y - s.dir.y)*G.posSmoothing, dl = Math.hypot(dx, dy) || 1;
        s.dir = { x:dx/dl, y:dy/dl };
      }
    }
  }
}

/** Fast fingertip snap: tip speed or apparent-size growth between consecutive readings. */
class FlickDetector {
  constructor() { this.prev = {}; }
  check(key, hand, t) {
    const F = CONFIG.gesture.flick, pv = this.prev[key];
    if (!hand) { this.prev[key] = null; return false; }
    let flick = false;
    if (pv && t - pv.t < F.windowMs && t > pv.t) {
      const sec = (t - pv.t)/1000;
      const speed  = dist(hand.tip, pv.tip)/sec/hand.size;
      const growth = (hand.size - pv.size)/sec/pv.size;
      flick = speed > F.minSpeed || growth > F.minGrowth;
    }
    this.prev[key] = { tip:{ x:hand.tip.x, y:hand.tip.y }, size:hand.size, t };
    return flick;
  }
}

/**
 * The Hollow Purple release. Follows the hand nearest the charging orb (left/right labels flip
 * during fast motion, so they can't be trusted) and fires on the first of:
 *   open    – thumb–index gap opens by `minOpen` × hand size from its tightest point while loaded
 *   snap    – index tip whips away from the thumb faster than `minTipSpeed` hand sizes / s
 *   dropout – tracking loses the hand right after a loaded frame (a real flick often blurs out)
 * `sens` (0..1, the panel slider) scales both thresholds: higher = easier to trigger.
 * Returns { dir, why } or null.
 */
class OpenFlickDetector {
  constructor() { this.hist = []; this.missing = 0; }
  update(hands, t, anchor, sens = .5) {
    const O = CONFIG.gesture.openFlick, scale = 1.6 - 1.2*clamp(sens, 0, 1);   // sens .5 → ×1.0
    while (this.hist.length && t - this.hist[0].t > O.historyMs) this.hist.shift();
    const h = hands.length ? hands.reduce((a, b) => dist(a.center, anchor) <= dist(b.center, anchor) ? a : b) : null;
    const last = this.hist[this.hist.length - 1];
    if (!h) {
      this.missing++;
      if (this.missing === 2 && last && last.loaded && t - last.t < O.dropoutMs) { this.hist.length = 0; return { dir:last.dir, why:'dropout' }; }
      return null;
    }
    this.missing = 0;
    const gap = dist(h.pts[4], h.pts[8]) / h.size;                       // 2D thumb–index gap, for the snap speed
    this.hist.push({ pinch:h.pinch, loaded:h.loaded, gap, dir:h.dir, t });
    if (h.loaded) return null;
    const armed = this.hist.filter(e => e.loaded && t - e.t <= O.maxAgeMs);
    if (!armed.length) return null;
    const tightest = Math.min(...armed.map(e => e.pinch));
    if (h.pinch - tightest > O.minOpen*scale) { this.hist.length = 0; return { dir:h.dir, why:'open' }; }
    if (last && t > last.t && t - last.t < 150 && (gap - last.gap)/((t - last.t)/1000) > O.minTipSpeed*scale) { this.hist.length = 0; return { dir:h.dir, why:'snap' }; }
    return null;
  }
}

/* ============================== 7. TECHNIQUES ==============================
   Each technique: update(dt, input, …) mutates its own state and pushes to
   world.fx / world.sound; render* methods only draw; status() feeds the panel.
   input = { W, H, u, k, poses, flicks:{blue,red}, openFlick }   (u = min(W,H), k = u/720)
   scene = { video, bg, W, H, u }   (bg = this frame's backdrop canvas)
   ========================================================================== */

/* ---------- Unlimited Void 無量空処 ----------
   Opens as white paint splashes with black ink flung across them, spreading from the
   caster's hand; inside is deep space around a black hole with a burning accretion ring
   and swirling light. */
class DomainExpansion {
  constructor(world) {
    this.world = world; this.charge = 0; this.prevCharge = 0; this.on = false;
    this.origin = { x:0, y:0 }; this.splats = []; this.stars = []; this.streams = []; this.nebula = null;
  }
  resize(W, H) {
    const diag = Math.hypot(W,H);
    this.stars = Array.from({ length:CONFIG.domain.stars }, () => ({ x:rand(0,W), y:rand(0,H), s:rand(.4,1.8), ph:rand(0,TAU), v:rand(.6,2.2) }));
    this.streams = Array.from({ length:70 }, () => this.newStream(true));
    // deep-space nebula, painted once per size
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0,0,W,H); g.globalCompositeOperation = 'lighter';
    [['20,45,110',.55],['30,80,120',.35],['60,40,130',.3],['110,150,220',.14],['15,30,70',.5],['80,110,170',.16],['140,160,210',.08]].forEach(([rgb,a]) => {
      const x = rand(.05,.95)*W, y = rand(.05,.95)*H, r = rand(.2,.55)*diag, gr = g.createRadialGradient(x,y,0,x,y,r);
      gr.addColorStop(0,`rgba(${rgb},${a})`); gr.addColorStop(1,`rgba(${rgb},0)`); g.fillStyle = gr; g.fillRect(0,0,W,H);
    });
    for (let i = 0; i < 700; i++) { g.fillStyle = `rgba(215,228,255,${rand(.05,.5)})`; const s = rand(.5,1.5); g.fillRect(rand(0,W), rand(0,H), s, s); }
    this.nebula = c;
    // ink splats, laid out around the cast point (offsets are relative to it)
    const smooth = a => a.map((v,i) => (a[(i+a.length-1)%a.length] + v*2 + a[(i+1)%a.length])/4);
    this.splats = Array.from({ length:18 }, (_, i) => {
      const ang = i/18*TAU + rand(-.2,.2), d = rand(.05,.8)*diag*.55;
      return { dx:Math.cos(ang)*d, dy:Math.sin(ang)*d, r:rand(.09,.2)*diag, delay:d/(diag*.55)*.42 + rand(0,.08),
               prof:smooth(smooth(Array.from({ length:26 }, () => rand(.7,1.2)))),
               drops:Array.from({ length:7 }, () => ({ a:rand(0,TAU), d:rand(1.05,1.7), r:rand(.03,.12) })) };
    });
  }
  newStream(any) { return { ang:rand(0,TAU), rad:any ? rand(1.1,4.5) : rand(3.5,5), w:rand(.5,1.1), v:rand(.3,.9), len:rand(.12,.45) }; }
  grow(b) { return ease(clamp((this.charge - b.delay)/.5, 0, 1)); }
  blobPath(ctx, b, s) {
    const cx = this.origin.x + b.dx, cy = this.origin.y + b.dy, n = b.prof.length, R = b.r*s;
    for (let i = 0; i <= n; i++) {
      const a = i/n*TAU, rr = R*b.prof[i % n], x = cx + Math.cos(a)*rr, y = cy + Math.sin(a)*rr;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    for (const d of b.drops) { const x = cx + Math.cos(d.a)*R*d.d, y = cy + Math.sin(d.a)*R*d.d, r = R*d.r*1.4; ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); }
  }

  update(dt, input) {
    const D = CONFIG.domain, pose = input.poses.domain, { fx, sound } = this.world;
    this.on = pose.on;
    if (this.charge === 0 && pose.on) this.origin = { x:pose.pos.x, y:pose.pos.y };   // the void opens from where it was cast
    this.charge = clamp(this.charge + (pose.on ? dt/D.chargeTime : -dt/D.collapseTime), 0, 1);
    if (this.charge > .05 && this.prevCharge <= .05 && pose.on) { sound.shot('domainStart'); this.world.voice.say('domainStart'); }
    if (this.charge >= 1 && this.prevCharge < 1) { sound.shot('domainBoom'); fx.kick({ flash:.5 }); this.world.voice.say('domainName', { priority:3 }); }
    this.prevCharge = this.charge;
    if (this.charge <= 0) return;
    for (const s of this.stars) s.ph += s.v*dt;
    for (const s of this.streams) {
      s.ang += s.w*dt*(1.6/s.rad); s.rad -= s.v*dt*.6;
      if (s.rad < 1.02) Object.assign(s, this.newStream(false));
    }
  }

  renderBackdrop(ctx, { video, W, H, u }) {
    if (this.charge <= 0) return;
    const e = ease(this.charge), o = this.origin, diag = Math.hypot(W,H), opening = this.charge < 1;
    const vp = { x:lerp(o.x, W/2, e), y:lerp(o.y, H*.45, e) };
    this.vp = vp; this.holeR = u*.17*(.55 + .45*e);
    if (opening) {                                                   // white paint, slightly ahead of the void
      ctx.save(); ctx.fillStyle = '#f2f4fb'; ctx.beginPath();
      for (const b of this.splats) { const g = this.grow(b); if (g > 0) this.blobPath(ctx, b, g*1.12 + .04); }
      ctx.fill(); ctx.restore();
    }
    ctx.save(); ctx.beginPath();
    if (opening) {
      for (const b of this.splats) { const g = this.grow(b); if (g > 0) this.blobPath(ctx, b, g); }
      const fc = diag*1.3*ease(clamp((this.charge - .6)/.4, 0, 1));
      if (fc > 0) { ctx.moveTo(o.x + fc, o.y); ctx.arc(o.x, o.y, fc, 0, TAU); }
    } else ctx.rect(0, 0, W, H);
    ctx.clip();
    this.drawVoid(ctx, video, W, H, u, vp, e);
    ctx.restore();
    if (opening) {                                                   // black ink flung across the white
      ctx.save(); ctx.fillStyle = '#04050a';
      for (const b of this.splats) {
        const g = this.grow(b); if (g <= 0 || g >= 1) continue;
        const cx = o.x + b.dx, cy = o.y + b.dy, R = b.r*g;
        for (const d of b.drops) {
          const x = cx + Math.cos(d.a + 1)*R*d.d*1.3, y = cy + Math.sin(d.a + 1)*R*d.d*1.3;
          ctx.beginPath(); ctx.arc(x, y, R*d.r*(1.2 - g*.4), 0, TAU); ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  drawVoid(ctx, video, W, H, u, vp, e) {
    ctx.fillStyle = '#02040c'; ctx.fillRect(0,0,W,H);
    // the caster, a faint grey ghost suspended in the void
    ctx.globalAlpha = .14; ctx.globalCompositeOperation = 'screen'; Draw.video(ctx, video, W, H);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = '#808080'; ctx.fillRect(0,0,W,H);
    ctx.globalCompositeOperation = 'lighter';
    ctx.save(); ctx.translate(vp.x, vp.y); ctx.rotate(Clock.t*.015); ctx.scale(1.3, 1.3); ctx.drawImage(this.nebula, -W/2, -H/2, W, H); ctx.restore();
    ctx.fillStyle = '#fff';
    for (const s of this.stars) { ctx.globalAlpha = .25 + .75*(.5 + .5*Math.sin(s.ph)); ctx.fillRect(s.x, s.y, s.s, s.s); }
    ctx.globalAlpha = 1;

    const R = u*.17*(.55 + .45*e);
    // gravitational lensing glow
    let g = ctx.createRadialGradient(vp.x, vp.y, R*.95, vp.x, vp.y, R*3.2);
    g.addColorStop(0,'rgba(205,220,255,.5)'); g.addColorStop(.12,'rgba(160,185,255,.22)'); g.addColorStop(1,'rgba(120,150,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(vp.x, vp.y, R*3.2, 0, TAU); ctx.fill();
    // swirling wisps of light + streams falling in (slightly tilted disc)
    ctx.save(); ctx.translate(vp.x, vp.y); ctx.scale(1, .82); ctx.lineCap = 'round';
    const rnd = mulberry(77);
    for (let i = 0; i < 36; i++) {
      const rr = R*(1.04 + rnd()*1.15), sp = .18 + rnd()*.45, a0 = rnd()*TAU + Clock.t*sp*(R/rr)*1.6, span = .4 + rnd()*1.9;
      const lw = R*(.008 + rnd()*.06), c = rnd(), col = c < .18 ? '255,236,210' : c < .6 ? '215,228,255' : '150,180,255', al = .05 + rnd()*.3;
      ctx.strokeStyle = `rgba(${col},${al*.35})`; ctx.lineWidth = lw*3; ctx.beginPath(); ctx.arc(0,0,rr,a0,a0+span); ctx.stroke();
      ctx.strokeStyle = `rgba(${col},${al})`; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(0,0,rr,a0,a0+span); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(235,242,255,.5)'; ctx.lineWidth = 1;
    for (const s of this.streams) { ctx.beginPath(); ctx.arc(0,0,s.rad*R,s.ang,s.ang + s.len); ctx.stroke(); }
    // accretion ring: cool at the top, burning gold at the bottom
    g = ctx.createLinearGradient(0,-R,0,R);
    g.addColorStop(0,'rgba(180,205,255,.55)'); g.addColorStop(.5,'rgba(255,255,255,.75)'); g.addColorStop(1,'rgba(255,222,165,1)');
    ctx.strokeStyle = g;
    ctx.globalAlpha = .18; ctx.lineWidth = R*.28; ctx.beginPath(); ctx.arc(0,0,R*1.04,0,TAU); ctx.stroke();
    ctx.globalAlpha = 1;   ctx.lineWidth = R*.07; ctx.beginPath(); ctx.arc(0,0,R*1.03,0,TAU); ctx.stroke();
    ctx.restore();
    // event horizon
    ctx.globalCompositeOperation = 'source-over';
    g = ctx.createRadialGradient(vp.x, vp.y, 0, vp.x, vp.y, R*1.01);
    g.addColorStop(0,'#000'); g.addColorStop(.9,'#000'); g.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(vp.x, vp.y, R*1.01, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(vp.x, vp.y, R*.99, Math.PI*1.05, Math.PI*1.95); ctx.stroke();   // photon ring highlight
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Title card centred on the black hole (so no crop can cut it off): 領域展開 above, 無量空処 across it, English below. */
  renderBanner(ctx, W, H, u) {
    const a = clamp((this.charge - .6)/.4, 0, 1);
    if (a <= 0 || !this.vp) return;
    const { x:cx, y:cy } = this.vp, R = this.holeR;
    const small = u*.042, big = Math.min(u*.12, W*.8/4.6), fs = Math.max(11, u*.027);
    ctx.save(); ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
    // letter-spacing adds a trailing gap, so nudge each line right by half of it to keep it optically centred
    ctx.font = `600 ${small}px ${SERIF}`; spacing(ctx, small*.8); ctx.shadowColor = 'rgba(0,0,0,.95)'; ctx.shadowBlur = 12;
    const y1 = cy - R*1.45;
    ctx.fillText('領域展開', cx + small*.4, y1);
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(cx - small*6.5, y1); ctx.lineTo(cx - small*3.6, y1); ctx.moveTo(cx + small*3.6, y1); ctx.lineTo(cx + small*6.5, y1); ctx.stroke();
    ctx.font = `800 ${big}px ${SERIF}`; spacing(ctx, big*.12); ctx.shadowColor = '#8fa6ff'; ctx.shadowBlur = big*.4;
    ctx.fillText('無量空処', cx + big*.06, cy);
    ctx.font = `400 ${fs}px ${LATIN}`; spacing(ctx, fs*.5); ctx.shadowColor = 'rgba(0,0,0,1)'; ctx.shadowBlur = 10; ctx.fillStyle = '#fff';
    ctx.fillText('DOMAIN EXPANSION · UNLIMITED VOID', cx + fs*.27, cy + R*1.5);
    ctx.restore();
  }
  status() {
    const text = this.on ? (this.charge >= 1 ? 'Active' : 'Casting…') : (this.charge > 0 ? 'Collapsing…' : 'Idle');
    return { pct:this.charge, text, active:this.charge > 0 };
  }
}

/* ---------- Blue / Red share the charge → flick → projectile lifecycle ---------- */
class OrbTechnique {
  /** spec: { color, drawOrb, cfg, fireSound, kanji, titleColor, wobble, trailRgb, seed } */
  constructor(kind, world, spec) {
    this.kind = kind; this.world = world; this.spec = spec;
    this.charge = 0; this.prevCharge = 0; this.cooldown = 0; this.flashT = 0;
    this.on = false; this.merging = false;
    this.orb = { x:0, y:0, r:10, dir:{ x:0, y:-1 }, visible:false };   // live object: also a particle target
    this.projectiles = [];
  }
  get ready() { return this.charge > READY; }
  reset() { this.charge = 0; }

  update(dt, input, merge) {
    const O = CONFIG.orb, pose = input.poses[this.kind];
    this.on = pose.on; this.merging = merge.active;
    if (merge.active) this.charge = Math.min(1, this.charge + dt/O.mergeChargeTime);
    else this.charge = clamp(this.charge + (pose.on ? dt/O.chargeTime : -dt/O.decayTime), 0, 1);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.flashT = Math.max(0, this.flashT - dt);

    if (this.charge > .05 && this.prevCharge <= .05 && pose.on && !merge.active) this.world.voice.say(this.kind + 'Start');
    this.float = input.orbFloat ?? CONFIG.orb.float;
    if (input.flicks[this.kind] && pose.hand && !merge.active && this.ready && this.cooldown <= 0) this.fire(pose.hand, input);
    this.updateProjectiles(dt, input);
    this.updateExtra(dt, input);
    this.layoutOrb(pose, merge);
    this.emitParticles();

    if (this.ready && this.prevCharge <= READY && pose.on && !merge.active) this.world.sound.shot('ready');
    this.prevCharge = this.charge;
  }

  layoutOrb(pose, merge) {
    const o = this.orb, grow = .12 + .24*ease(this.charge);
    if (merge.active) {
      o.x = pose.pos.x + (merge.mid.x - pose.pos.x)*merge.pull;
      o.y = pose.pos.y + (merge.mid.y - pose.pos.y)*merge.pull;
      o.r = merge.avgSize*grow*merge.shrink; o.visible = true;
    } else if (pose.on && this.charge > .02) {
      const f = pose.size*this.float;                                    // float ahead of the fingertip, along the index
      o.x = pose.pos.x + pose.dir.x*f; o.y = pose.pos.y + pose.dir.y*f; o.dir = pose.dir;
      o.r = pose.size*grow*(1 + .04*Math.sin(Clock.t*this.spec.wobble)); o.visible = true;
    } else o.visible = false;
  }

  /** Launch toward the flick direction; lands a fixed distance away, always inside the frame. */
  fire(hand, input) {
    const s = this.spec, C = s.cfg, { fx, sound } = this.world, { W, H, u } = input;
    const r0 = hand.size*(.12 + .24*ease(this.charge)), reach = C.reach*Math.hypot(W,H), m = .1;
    const o = this.orb.visible ? this.orb : hand.tip;                    // launch from where the orb was floating
    const ex = clamp(o.x + hand.dir.x*reach, W*m, W*(1-m)), ey = clamp(o.y + hand.dir.y*reach, H*m, H*(1-m));
    this.projectiles.push({ sx:o.x, sy:o.y, ex, ey, x:o.x, y:o.y, r0, r:r0, t:0, dur:C.flight, trail:[] });
    this.world.voice.say(s.voiceFire, { priority:2, force:true });
    this.cooldown = CONFIG.orb.cooldown; this.charge = 0; this.flashT = CONFIG.orb.firedFlash;
    sound.shot(s.fireSound);
    fx.kick({ shake:.3, impact:.045, at:hand.tip, tint:{ rgb:s.color.wash, a:.7 } });
    fx.title(s.kanji, hand.tip.x, hand.tip.y - r0*4, s.titleColor, u*.09, { life:.9 });
  }

  updateProjectiles(dt, input) {
    const fx = this.world.fx, C = this.spec.cfg;
    for (const p of this.projectiles) {
      p.t += dt;
      const u = Math.min(1, p.t/p.dur), e = this.flightCurve(u);
      p.trail.push({ x:p.x, y:p.y, r:p.r }); if (p.trail.length > 12) p.trail.shift();
      p.x = lerp(p.sx, p.ex, e); p.y = lerp(p.sy, p.ey, e); p.r = p.r0*lerp(1, C.growth, u);
      for (let k = 0; k < 3; k++) {
        const a = rand(0,6.28), sp = rand(30,120);
        fx.spawn({ x:p.x, y:p.y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp, life:.35, max:.35, col:this.spec.trailRgb, size:rand(1,2.2), streak:.06 });
      }
      if (u >= 1 || (u > .15 && this.world.game.hitTest(p.x, p.y, p.r*1.6))) { this.onImpact(p.x, p.y, p, input); p.dead = true; }   // curses in the way take it early
    }
    prune(this.projectiles, p => !p.dead);
  }

  /* hooks for subclasses */
  flightCurve(u) { return u; }
  updateExtra() {}
  onImpact() {}
  emitParticles() {}
  idleText() { return this.cooldown > 0 ? 'Cooldown' : 'Idle'; }
  isBusy() { return false; }

  /* rendering */
  renderBackdrop() {}
  /** The whole scene takes on the technique's colour while it charges. */
  renderWash(ctx, W, H) {
    const o = this.orb;
    if (o.visible && !this.merging && this.charge > .03) Draw.wash(ctx, W, H, this.spec.color.wash, .8*ease(this.charge), o.x, o.y);
  }
  renderOrb(ctx) {
    const o = this.orb; if (!o.visible) return;
    Draw.crackle(ctx, o.x, o.y, o.r*(2.4 + 1.6*this.charge), Math.round(5 + 10*this.charge), this.spec.color.c2, .35 + .65*this.charge, this.spec.seed);
    this.spec.drawOrb(ctx, o.x, o.y, o.r, this.charge);
  }
  renderPrompt(ctx, u) { if (this.orb.visible && !this.merging) Draw.chargePrompt(ctx, this.orb, this.charge, this.spec.color.c1, u); }
  renderProjectiles(ctx) {
    for (const p of this.projectiles) {
      p.trail.forEach((t,i) => Draw.glow(ctx, t.x, t.y, t.r*.5*(i/p.trail.length), this.spec.color, .5*(i/p.trail.length)));
      Draw.crackle(ctx, p.x, p.y, p.r*2.4, 7, this.spec.color.c2, .8, this.spec.seed + 3);
      this.spec.drawOrb(ctx, p.x, p.y, p.r, 1);
    }
  }
  status() {
    const text = this.flashT > 0 ? 'Fired' : this.merging ? 'Merging'
      : this.on ? (this.ready ? 'Ready — flick' : 'Charging…') : this.idleText();
    return { pct:this.flashT > 0 ? 1 : this.charge, text, active:this.on || this.flashT > 0 || this.isBusy() };
  }
}

/* ---------- Blue 蒼: attraction. Lands, drags everything into a well, collapses, then detonates ---------- */
class Blue extends OrbTechnique {
  constructor(world) {
    super('blue', world, { color:COL.blue, drawOrb:Draw.blueOrb, cfg:CONFIG.blue, fireSound:'blueFire', voiceFire:'blueFire', kanji:'蒼', titleColor:'#4f8cff',
                           wobble:18, trailRgb:'120,180,255', seed:2 });
    this.wells = [];
  }
  flightCurve(u) { return ease(u); }                                  // decelerates into place
  onImpact(x, y, p) {
    const B = CONFIG.blue;
    if (this.wells.length >= B.maxWells) this.wells[0].t = this.wells[0].life;
    this.wells.push({ x, y, r:p.r*1.1, t:0, life:B.wellLife });
    this.world.sound.shot('wellOpen');
    this.world.fx.wave(x, y, COL.blue.c1, p.r*8, { rev:true, life:.45 });
  }
  updateExtra(dt) {
    const { fx } = this.world, B = CONFIG.blue;
    for (const g of this.wells) {
      g.t += dt;
      if (g.t >= g.life) { this.detonate(g); continue; }
      const c = clamp((g.t - (g.life - B.collapse))/B.collapse, 0, 1);
      this.world.game.pull(g.x, g.y, g.r*14, 2.2, dt);                  // drags curses in and holds them
      this.world.game.damageCircle(g.x, g.y, g.r*2.5, 2*dt);
      for (let k = 0; k < 4 + 6*c; k++) {                             // pull harder as it collapses
        const a = rand(0,6.28), rr = g.r*rand(3,8);
        fx.spawn({ x:g.x+Math.cos(a)*rr, y:g.y+Math.sin(a)*rr, vx:0, vy:0, life:.8, max:.8, col:'140,200,255', size:rand(.8,2), target:g, streak:.05 });
      }
    }
    prune(this.wells, g => g.t < g.life);
  }
  /** The collapse releases everything at once. */
  detonate(g) {
    const { fx, sound } = this.world, R = g.r;
    sound.shot('wellBoom');
    fx.blast(g.x, g.y, { rgb:'50,110,255', edge:'205,230,255', life:.7, scale:.6 });
    this.world.game.damageCircle(g.x, g.y, Math.max(R*9, Math.min(this.world.game.env.W, this.world.game.env.H)*.16), 3);
    for (let i = 0; i < 3; i++) fx.wave(g.x, g.y, i ? COL.blue.c2 : '220,235,255', R*(10 + i*6), { delay:i*.06, life:.7, width:8 });
    fx.burst(g.x, g.y, '160,210,255', 80, 250, 1000, { streak:.05, drag:.88 });
    fx.burst(g.x, g.y, '255,255,255', 24, 80, 380, { streak:0, drag:.9 });
    fx.kick({ shake:.75, flash:.5, impact:.07, at:g, tint:{ rgb:COL.blue.wash, a:.9 } });
  }
  emitParticles() {
    const o = this.orb; if (!o.visible) return;
    for (let i = 0; i < 3; i++) {
      const a = rand(0,6.28), rr = o.r*rand(2.5,5);
      this.world.fx.spawn({ x:o.x+Math.cos(a)*rr, y:o.y+Math.sin(a)*rr, vx:0, vy:0, life:.7, max:.7, col:'130,190,255', size:rand(.8,2), target:o, streak:.04 });
    }
  }
  isBusy() { return this.wells.length > 0; }
  idleText() { return this.wells.length ? 'Gravity well' : super.idleText(); }

  /** Well: warps the backdrop behind it (lens), shrinks and brightens as it collapses. */
  renderWells(ctx, { bg, W, H }) {
    const B = CONFIG.blue;
    for (const g of this.wells) {
      const c = clamp((g.t - (g.life - B.collapse))/B.collapse, 0, 1), open = Math.min(1, g.t/.15);
      const r = g.r*(1 - .6*ease(c))*open, z = 1.35 + .7*c;
      ctx.save(); ctx.beginPath(); ctx.arc(g.x, g.y, g.r*3*open, 0, Math.PI*2); ctx.clip();
      ctx.translate(g.x, g.y); ctx.scale(z, z); ctx.translate(-g.x, -g.y); ctx.drawImage(bg, 0, 0, W, H); ctx.restore();
      Draw.wash(ctx, W, H, COL.blue.wash, .55 + .3*c, g.x, g.y);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const ph = (Clock.t*(1 + 2*c) + i/3) % 1;
        ctx.strokeStyle = `rgba(150,205,255,${ph*.55})`; ctx.lineWidth = 1 + ph*2;
        ctx.beginPath(); ctx.arc(g.x, g.y, g.r*(6 - 4.8*ph), 0, Math.PI*2); ctx.stroke();
      }
      ctx.restore();
      Draw.crackle(ctx, g.x, g.y, g.r*(2.2 + 1.2*c), 9 + Math.round(8*c), COL.blue.c2, .7 + .3*c, 21);
      Draw.blueOrb(ctx, g.x, g.y, r, 1, 1);
    }
  }
  /** Lens inside the charging orb (samples the backdrop, so it also works inside the Domain). */
  renderBackdrop(ctx, { bg, W, H }) {
    const o = this.orb;
    if (!o.visible || this.charge <= .3) return;
    ctx.save(); ctx.beginPath(); ctx.arc(o.x, o.y, o.r*2.4, 0, Math.PI*2); ctx.clip();
    const z = 1 + .6*this.charge; ctx.translate(o.x, o.y); ctx.scale(z,z); ctx.translate(-o.x, -o.y);
    ctx.drawImage(bg, 0, 0, W, H); ctx.restore();
  }
}

/* ---------- Red 赫: repulsion. Fast, straight, detonates on impact ---------- */
class Red extends OrbTechnique {
  constructor(world) {
    super('red', world, { color:COL.red, drawOrb:Draw.redOrb, cfg:CONFIG.red, fireSound:'redFire', voiceFire:'redFire', kanji:'赫', titleColor:'#e0303a',
                          wobble:22, trailRgb:'255,80,70', seed:5 });
  }
  flightCurve(u) { return u*u; }                                       // accelerates into the hit
  onImpact(x, y, p, input) {
    const { fx, sound } = this.world, R = p.r;
    sound.shot('redHit');
    fx.blast(x, y, { rgb:'255,40,40', edge:'255,210,200', life:.6, scale:.65 });
    this.world.game.damageCircle(x, y, Math.max(R*7, input.u*.14), 4, { push:.35 });
    for (let i = 0; i < 3; i++) fx.wave(x, y, i ? COL.red.c2 : '255,230,220', R*(8 + i*5), { delay:i*.05, life:.55, width:9 });
    fx.burst(x, y, '255,110,100', 90, 300, 1200, { streak:.045, drag:.87 });
    fx.burst(x, y, '255,225,215', 30, 60, 300, { streak:0, drag:.92, life:.9 });
    fx.kick({ shake:.9, flash:.45, impact:.08, at:{ x, y }, tint:{ rgb:COL.red.wash, a:1 } });
  }
  emitParticles() {
    const o = this.orb; if (!o.visible || this.merging) return;
    for (let i = 0; i < 2; i++) {
      const a = rand(0,6.28), s = rand(90,260);
      this.world.fx.spawn({ x:o.x, y:o.y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, life:.4, max:.4, col:'255,100,100', size:rand(.8,1.8), streak:.05 });
    }
  }
}

/* ---------- Hollow Purple 茈: one-hand loaded flick (release to fire) or Blue+Red merge (auto-fire) ----------
   Fires a colossal sphere that travels forward, erasing a trench behind it. */
class HollowPurple {
  constructor(world) {
    this.world = world; this.charge = 0; this.prevCharge = 0; this.cooldown = 0;
    this.beam = null; this.pinch = false; this.sinceHeld = 99;
    this.orb = { x:0, y:0, r:10 };                       // live particle target
    this.hold = { x:0, y:0, size:80, dir:{ x:0, y:-1 } };
    this.merge = { active:false, avgSize:80, distU:99, mid:{ x:0, y:0 }, pull:0, shrink:1 };
  }
  get idle() { return this.cooldown <= 0 && !this.beam; }
  /** One-hand sign held, or just released (the flick itself breaks the sign, so keep it armed briefly). */
  get handMode() { return this.pinch || (!this.merge.active && this.sinceHeld < CONFIG.purple.flickGrace && this.charge > 0); }

  /** Two-hand geometry; computed first so Blue/Red can pull their orbs together. */
  computeMerge(input) {
    const b = input.poses.blue, r = input.poses.red, active = b.on && r.on;
    const avgSize = (b.size + r.size)/2;
    const distU = active ? dist(b.pos, r.pos)/avgSize : 99;
    const mid = { x:(b.pos.x + r.pos.x)/2, y:(b.pos.y + r.pos.y)/2 };
    const pull = this.charge > .03 ? .45 + .55*this.charge : clamp((2.6 - distU)/2.6, 0, 1)*.4;
    return this.merge = { active, avgSize, distU, mid, pull, shrink:1 - this.charge*.8 };
  }

  update(dt, input, blue, red) {
    const P = CONFIG.purple, merge = this.merge, pose = input.poses.purple, { fx } = this.world;
    this.pinch = pose.on && !merge.active;
    this.sinceHeld = this.pinch ? 0 : this.sinceHeld + dt;
    if (this.pinch) this.hold = { x:pose.pos.x, y:pose.pos.y, size:pose.size, dir:pose.dir };
    else if (merge.active) this.hold = { x:merge.mid.x, y:merge.mid.y, size:merge.avgSize, dir:pose.dir };
    this.cooldown = Math.max(0, this.cooldown - dt);

    if (this.pinch && this.idle) this.charge += dt/P.handChargeTime;
    else if (this.handMode && this.idle) { /* grace window: hold the charge while the flick lands */ }
    else if (merge.active && this.idle) {
      if (merge.distU < P.joinDist) this.charge += dt/P.mergeChargeTime;
      else if (merge.distU > P.breakDist) this.charge -= dt/P.decayTime;
    } else this.charge -= dt/P.decayTime;
    this.charge = clamp(this.charge, 0, 1);

    // two-hand merge auto-fires once fully joined
    if (this.charge >= 1 && merge.active) {
      const d1 = input.poses.blue.dir, d2 = input.poses.red.dir;
      let dx = d1.x + d2.x, dy = d1.y + d2.y; const dl = Math.hypot(dx,dy);
      if (dl < .3) { dx = 0; dy = -1; } else { dx /= dl; dy /= dl; }
      this.fire({ x:dx, y:dy }, input);
      blue.reset(); red.reset();
    }
    // one-hand sign fires on the flick release
    if (this.handMode && this.idle && this.charge > READY && input.openFlick) this.fire(input.openFlick.dir, input);

    if (this.charge > .05 && this.prevCharge <= .05 && (this.pinch || merge.active)) this.world.voice.say('purpleStart');
    this.updateBeam(dt, input);
    this.prevCharge = this.charge;

    this.layoutOrb();
    if ((merge.active || this.handMode) && this.charge > .03) {
      const o = this.orb;
      for (let i = 0; i < 4; i++) {
        const a = rand(0,6.28), rr = o.r*rand(2,4);
        fx.spawn({ x:o.x+Math.cos(a)*rr, y:o.y+Math.sin(a)*rr, vx:0, vy:0, life:.6, max:.6, col:'205,140,255', size:rand(.8,2), target:o, streak:.04 });
      }
    }
  }

  layoutOrb() {
    const o = this.orb, m = this.merge, wob = 1 + .04*Math.sin(Clock.t*40);
    if (m.active && this.charge > .03) { o.x = m.mid.x; o.y = m.mid.y; o.r = m.avgSize*(.25 + .45*ease(this.charge))*wob; }
    if (this.handMode) { o.x = this.hold.x; o.y = this.hold.y; o.r = this.hold.size*(.16 + .4*ease(this.charge))*wob; }
  }

  fire(dir, input) {
    const { fx, sound } = this.world, { x, y } = this.hold, size = Math.max(this.hold.size*.6, input.u*.08);
    this.beam = { x, y, px:x, py:y, dir, size, R:size, travel:0, t:0 };
    this.charge = 0; this.cooldown = CONFIG.purple.cooldown;
    fx.kick({ shake:1, flash:1, impact:.12, at:{ x, y }, tint:{ rgb:COL.purple.wash, a:1 } });
    fx.blast(x, y, { rgb:'170,100,255', edge:'235,205,255', life:.8, scale:1.25 }); sound.shot('purpleFire');
    for (let i = 0; i < 4; i++) fx.wave(x, y, COL.purple.c1, size*(8 + i*3), { delay:i*.08, life:.9 });
    fx.title('茈', input.W/2, input.H*.5, '#a060ff', input.u*.26, { sub:'HOLLOW PURPLE', life:1.6 });
    this.world.voice.say('purpleFire', { priority:3, force:true });
    this.world.game.damageCircle(x, y, size*3, 99);
  }

  /** The sphere rolls forward, growing, tearing debris off the edges of its trench. */
  updateBeam(dt, input) {
    const b = this.beam; if (!b) return;
    const D = CONFIG.purple.beamDuration;
    b.t += dt;
    if (b.t > D) { this.beam = null; return; }
    b.travel = Math.hypot(input.W, input.H)*1.4*Math.pow(Math.min(1, b.t/(D*.9)), 1.8);
    b.px = b.x + b.dir.x*b.travel; b.py = b.y + b.dir.y*b.travel;
    b.R = b.size*(.9 + .9*Math.min(1, b.t/.35));
    this.world.game.damageSegment(b.x, b.y, b.px, b.py, b.R, 99);   // nothing survives the trench
    const nx = -b.dir.y, ny = b.dir.x;
    for (let k = 0; k < 6; k++) {
      const side = Math.random() < .5 ? -1 : 1, s = rand(150,650), along = rand(-.3,.3);
      this.world.fx.spawn({ x:b.px + nx*side*b.R*.9, y:b.py + ny*side*b.R*.9, vx:(nx*side + b.dir.x*along)*s, vy:(ny*side + b.dir.y*along)*s,
                            life:.55, max:.55, col:k % 3 ? '215,170,255' : '255,255,255', size:rand(1,2.6), streak:.05, drag:.9 });
    }
  }

  /* rendering */
  renderWash(ctx, W, H) {
    if (this.charge > .03) Draw.wash(ctx, W, H, COL.purple.wash, .85*ease(this.charge), this.hold.x, this.hold.y);
    if (this.beam) Draw.wash(ctx, W, H, COL.purple.wash, 1 - this.beam.t/CONFIG.purple.beamDuration, this.beam.px, this.beam.py);
  }
  renderSpeedLines(ctx, W, H) {
    if ((this.merge.active || this.handMode) && this.charge > .03) Draw.speedLines(ctx, this.hold.x, this.hold.y, W, H, .16*this.charge, '#efe2ff', 60);
  }
  renderOrb(ctx) {
    const show = this.merge.active ? this.charge > .03 : this.handMode;
    if (!show) return;
    const o = this.orb;
    Draw.crackle(ctx, o.x, o.y, o.r*(2.2 + 1.2*this.charge), Math.round(6 + 12*this.charge), COL.purple.c2, .4 + .6*this.charge, 9);
    Draw.purpleOrb(ctx, o.x, o.y, o.r, Math.max(.15, this.charge));
  }
  renderPrompt(ctx, u) {
    if (!this.handMode || !this.idle) return;
    Draw.chargePrompt(ctx, { x:this.hold.x, y:this.hold.y, r:this.hold.size*1.1 }, this.charge, COL.purple.c1, u);
  }
  renderBeam(ctx) {
    const b = this.beam; if (!b) return;
    const p = b.t/CONFIG.purple.beamDuration, fade = p > .8 ? (1 - p)/.2 : 1, R = b.R;
    ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(Math.atan2(b.dir.y, b.dir.x)); ctx.globalAlpha = fade;
    const g = ctx.createLinearGradient(0,-R,0,R);                     // erased trench: dark core, burning violet edges
    g.addColorStop(0,'rgba(160,90,255,0)'); g.addColorStop(.07,'rgba(215,170,255,.9)'); g.addColorStop(.18,'rgba(45,8,90,.94)');
    g.addColorStop(.5,'rgba(6,0,16,.97)'); g.addColorStop(.82,'rgba(45,8,90,.94)'); g.addColorStop(.93,'rgba(215,170,255,.9)'); g.addColorStop(1,'rgba(160,90,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, -R*.95, b.travel, R*1.9);
    ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = 'rgba(230,200,255,.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0,-R*.84); ctx.lineTo(b.travel,-R*.84); ctx.moveTo(0,R*.84); ctx.lineTo(b.travel,R*.84); ctx.stroke();
    ctx.restore();
    Draw.crackle(ctx, b.px, b.py, R*1.5, 16, COL.purple.c2, fade, 13);
    Draw.purpleOrb(ctx, b.px, b.py, R, 1, fade);
  }
  status() {
    const P = CONFIG.purple;
    const text = this.beam ? 'Firing' : this.cooldown > 0 ? 'Cooldown'
      : this.handMode ? (this.charge > READY ? 'Ready — flick' : 'Charging…')
      : this.merge.active ? (this.merge.distU < P.joinDist ? 'Merging…' : 'Bring tips together') : 'Idle';
    return { pct:this.beam ? 1 : this.charge, text, active:this.handMode || this.merge.active || !!this.beam };
  }
}

/* ---------- Background music ----------
   Plays the embedded track in a loop through the sound engine (so it follows the master
   volume / mute, and works on iOS where <audio>.volume is read-only). Fades in on start and
   ducks under the big moments so the hits land. */
class Music {
  constructor(el, sound) { this.el = el; this.sound = sound; this.node = null; this.target = -1; }
  start() {
    if (!this.el || !this.el.src) return;
    if (!this.node) this.node = this.sound.attachMedia(this.el);
    const p = this.el.play(); if (p && p.catch) p.catch(() => {});
  }
  /** level 0..1 from the panel; duck 0..1 = how much to pull the music down right now. */
  update(level, duck) {
    const target = Math.round(level*(1 - .7*clamp(duck, 0, 1))*100)/100;
    if (target === this.target) return;
    this.target = target;
    if (this.node) this.node.gain.gain.setTargetAtTime(target, this.node.ac.currentTime, this.el.currentTime < 1 ? 1.2 : .35);
    else if (this.el) this.el.volume = target;                        // fallback when WebAudio is unavailable
  }
}

/* ============================== 8. PANEL ============================== */
const TECHS = {
  domain: { jp:'無量空処', chip:'領域', en:'Void',   color:'#b8c6ff', how:'Cross index + middle fingers and hold. The void opens around you.' },
  blue:   { jp:'蒼', chip:'蒼', en:'Blue',   color:'#4f8cff', how:'1. Index finger only, <b>palm toward</b> the camera<br>2. Hold until the ring passes the tick<br>3. <b>Flick</b> forward: it lands, drags everything in, then detonates' },
  red:    { jp:'赫', chip:'赫', en:'Red',    color:'#e0303a', how:'1. Index finger only, <b>back of hand toward</b> the camera<br>2. Hold until the ring passes the tick<br>3. <b>Flick</b> forward: it detonates on impact' },
  purple: { jp:'茈', chip:'茈', en:'Purple', color:'#9b5cff', how:'1. <b>Load a finger-flick</b>: curl your index against your thumb, other fingers open, palm up toward the camera<br>2. Hold until the ring passes the tick<br>3. <b>Flick</b> the index out to fire<br><i>Alternative:</i> Blue in one hand + Red in the other, tips together.' },
};

/** Settings that survive a reload (per browser). Checkboxes store checked, everything else its value. */
const SETTINGS_KEY = 'track-lab:cursed-hands:settings';
const SAVED = ['vol','mute','music','musicVol','sfx','sfxVol','voice','voiceVol','reduce','fill','skel','swap','orbFloat','pinchThresh','flickSens',
               'eyesOn','eyeColor','eyeGlow','hairOn','hairColor'];
/** Face presets: Gojo = white hair + glowing blue Six Eyes. */
const FACE_PRESETS = { gojo:{ eyesOn:true, eyeColor:'#3ec8ff', eyeGlow:'0.8', hairOn:true, hairColor:'#f2f4f8' }, off:{ eyesOn:false, hairOn:false } };

class Panel {
  constructor(techs) {
    this.app = $('app'); this.cards = {}; this.chips = {};
    for (const [key, t] of Object.entries(techs)) {
      const el = document.createElement('div');
      el.className = 'tech'; el.style.setProperty('--c', t.color);
      el.innerHTML = `<div class="row"><span class="name"><span class="jp">${t.jp}</span><span class="en">${key === 'domain' ? 'Unlimited Void' : key === 'purple' ? 'Hollow Purple' : t.en}</span></span><span class="state">Idle</span></div>
                      <div class="how">${t.how}</div><div class="bar"><i></i></div>`;
      $('techs').appendChild(el);
      this.cards[key] = { el, state:el.querySelector('.state'), bar:el.querySelector('.bar > i') };
      const chip = document.createElement('div');
      chip.className = 'chip'; chip.style.setProperty('--c', t.color);
      chip.innerHTML = `<span class="k">${t.chip}</span><span class="l">${t.en}</span><span class="b"><i></i></span>`;
      $('hud').appendChild(chip);
      this.chips[key] = { el:chip, bar:chip.querySelector('.b > i') };
    }
    this.restore();
    for (const id of ['pinchThresh','flickSens','orbFloat']) {
      const el = $(id), out = $(id + 'Val'), show = () => out.textContent = parseFloat(el.value).toFixed(2);
      el.addEventListener('input', show); show();
    }
    for (const id of SAVED) $(id).addEventListener('change', () => this.save());
    for (const id of ['vol','musicVol','sfxVol','voiceVol','orbFloat','eyeColor','eyeGlow','hairColor']) $(id).addEventListener('input', () => this.save());
    for (const [btn, key] of [['gojoBtn', 'gojo'], ['faceOffBtn', 'off']]) $(btn).addEventListener('click', () => {
      for (const [id, v] of Object.entries(FACE_PRESETS[key])) { const el = $(id); if (el.type === 'checkbox') el.checked = v; else el.value = v; }
      this.save();
    });
    const syncFill = () => this.app.classList.toggle('fill', $('fill').checked);
    $('fill').addEventListener('change', syncFill); syncFill();
    this.button = $('start');
    $('panelBtn').addEventListener('click', () => this.togglePanel());
    const syncMusicBtn = () => $('musicBtn').classList.toggle('off', !$('music').checked);
    $('musicBtn').addEventListener('click', () => { $('music').checked = !$('music').checked; syncMusicBtn(); this.save(); });
    $('music').addEventListener('change', syncMusicBtn); syncMusicBtn();
    $('canvas').addEventListener('click', () => { if (isPhone()) this.togglePanel(false); });   // tap the stage to close the sheet
    if (canFullscreen()) $('fsBtn').addEventListener('click', toggleFullscreen);
    else $('fsBtn').style.display = 'none';                           // e.g. iPhone Safari
    if (matches('(min-width: 1100px)')) this.togglePanel(true);       // big screens start with the drawer open
  }
  restore() {
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* blocked storage: defaults */ }
    for (const id of SAVED) {
      const el = $(id); if (!el || !(id in saved)) continue;
      if (el.type === 'checkbox') el.checked = !!saved[id]; else el.value = saved[id];
    }
    this.savedVoice = saved.voiceSel || '';
  }
  save() {
    const out = {};
    for (const id of SAVED) { const el = $(id); out[id] = el.type === 'checkbox' ? el.checked : el.value; }
    if ($('voiceSel').value) this.savedVoice = $('voiceSel').value;
    out.voiceSel = this.savedVoice;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(out)); } catch { /* private mode */ }
  }
  /** Fill the voice picker with the browser's Japanese voices. */
  setVoices(voices, current) {
    const sel = $('voiceSel'), hint = $('voiceHint'), esc = t => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    sel.innerHTML = voices.map(v => `<option value="${esc(v.name)}">${esc(v.name.replace(/^(Microsoft|Google) /, '').replace(/ - Japanese.*| \(Japan\)/, ''))}</option>`).join('');
    sel.disabled = !voices.length;
    if (current) sel.value = current.name;
    hint.textContent = voices.length ? '' : 'No Japanese voice in this browser. Edge has the best ones; on Windows you can also add Japanese under Settings › Time & language › Speech.';
  }
  togglePanel(force) { const open = force ?? !this.app.classList.contains('panel-open'); this.app.classList.toggle('panel-open', open); }
  controls() {
    return { swap:$('swap').checked, pinchDist:parseFloat($('pinchThresh').value), flickSens:parseFloat($('flickSens').value),
             orbFloat:parseFloat($('orbFloat').value), reduce:$('reduce').checked, skeleton:$('skel').checked, fill:$('fill').checked,
             face:{ eyes:$('eyesOn').checked, eyeColor:$('eyeColor').value, glow:parseFloat($('eyeGlow').value), hair:$('hairOn').checked, hairColor:$('hairColor').value } };
  }
  master() { return $('mute').checked ? 0 : $('vol').value/100; }
  levels() {
    return { master:this.master(), sfx:$('sfx').checked ? $('sfxVol').value/100 : 0, voice:$('voice').checked ? $('voiceVol').value/100 : 0 };
  }
  /** Speech synthesis bypasses WebAudio, so it gets master × voice directly. */
  voiceLevel() { const l = this.levels(); return l.master*l.voice; }
  musicLevel() { return $('music').checked ? $('musicVol').value/100 : 0; }
  setCard(key, { pct, text, active }) {
    const c = this.cards[key], h = this.chips[key], w = (clamp(pct,0,1)*100).toFixed(0) + '%';
    c.bar.style.width = w; h.bar.style.width = w;
    if (c.state.textContent !== text) c.state.textContent = text;
    c.el.classList.toggle('on', !!active); h.el.classList.toggle('on', !!active);
  }
  /** Exorcism HUD + game-over card. */
  setGame(g) {
    const playing = g.state === 'countdown' || g.state === 'wave' || g.state === 'intermission';
    this.app.classList.toggle('gaming', playing);
    this.app.classList.toggle('game-over', g.state === 'over');
    $('waveBtn').classList.toggle('on', playing);
    const txt = (id, v) => { const el = $(id); v = String(v); if (el.textContent !== v) el.textContent = v; };
    txt('best', g.best.toLocaleString());
    txt('gameBtn', playing ? 'Stop waves' : 'Start waves');
    if (playing) {
      txt('gWave', g.wave || '—'); txt('gScore', g.score.toLocaleString());
      txt('gCombo', g.combo > 1 ? `${g.combo} chain${g.mult > 1 ? ' ×' + g.mult : ''}` : '');
      txt('gLives', '●'.repeat(g.lives) + '○'.repeat(Math.max(0, g.maxLives - g.lives)));
      txt('gVoid', g.voidLeft > 0 ? `void ${g.voidLeft.toFixed(1)}s` : '');
    }
    if (g.state === 'over') {
      txt('oScore', g.score.toLocaleString()); txt('oWave', g.wave); txt('oKills', g.kills);
      txt('oBest', g.newBest ? 'New best!' : `Best ${g.best.toLocaleString()}`);
    }
  }
  setFaceHint(text) { const h = $('faceHint'); if (h.textContent !== text) h.textContent = text; }
  setBadge(text) { const b = $('badge'); if (b.textContent !== text) b.textContent = text; }
  setDebug(html) { $('debug').innerHTML = html; }
  setError(text) { $('err').textContent = text; }
  setButton(text, disabled) { this.button.textContent = text; this.button.disabled = disabled; }
  showStage() { $('ph').style.display = 'none'; this.app.classList.add('running'); $('rec').style.display = 'flex'; }
}

/* ============================== 9. APP ============================== */
class App {
  constructor() {
    this.canvas = $('canvas'); this.ctx = this.canvas.getContext('2d'); this.video = $('video');
    this.bg = document.createElement('canvas'); this.bgCtx = this.bg.getContext('2d');   // per-frame backdrop
    this.panel = new Panel(TECHS);
    this.sound = createSound(() => this.panel.levels());
    this.music = new Music($('bgm'), this.sound);
    this.fx = new Effects();
    this.faceFx = new FaceFX();
    this.voice = createVoice({ sound:this.sound, getLevel:() => this.panel.voiceLevel(), getVoiceName:() => this.panel.savedVoice });
    this.voice.onVoices(v => this.panel.setVoices(v, this.voice.current()));

    const world = { fx:this.fx, sound:this.sound, voice:this.voice, game:null };
    this.game = world.game = new CurseWaves(world);
    this.domain = new DomainExpansion(world);
    this.blue   = new Blue(world);
    this.red    = new Red(world);
    this.purple = new HollowPurple(world);

    this.poses = new PoseTracker(['blue','red','domain','purple']);
    this.flicks = new FlickDetector();
    this.openFlicks = new OpenFlickDetector();

    this.hands = []; this.pending = null; this.running = false; this.lastT = 0; this.ctl = this.panel.controls();
    this.panel.button.addEventListener('click', () => this.start());
    for (const id of ['startWaves', 'gameBtn', 'waveBtn', 'againBtn']) $(id).addEventListener('click', () => this.toggleWaves(id === 'againBtn'));
    $('freeBtn').addEventListener('click', () => { this.game.stop(); this.panel.setGame(this.game.hud()); });
    $('voiceSel').addEventListener('change', async () => { this.panel.save(); this.sound.init(); await this.voice.init(); this.voice.say('domainStart', { force:true, priority:9 }); });
    $('voiceTest').addEventListener('click', async () => {
      this.sound.init(); await this.voice.init();
      const keys = Object.keys(LINES); this.testIdx = ((this.testIdx ?? -1) + 1) % keys.length;
      this.voice.say(keys[this.testIdx], { force:true, priority:9 });
    });
    this.panel.setGame(this.game.hud());
  }

  /** Start / stop exorcism mode (starts the camera first if needed). */
  async toggleWaves(restart = false) {
    if (this.game.active && !restart) { this.game.stop(); this.panel.setGame(this.game.hud()); return; }
    if (!this.running) { await this.start(); if (!this.running) return; }
    this.game.start();
    if (isPhone()) this.panel.togglePanel(false);
  }

  async start() {
    this.sound.init();                                     // audio must be created from a click
    this.music.start();
    this.voice.init();
    this.panel.setButton('Starting…', true); this.panel.setError('');
    try {
      if (document.fonts) { document.fonts.load(`800 40px ${SERIF}`, '無量空処領域展開蒼赫茈'); document.fonts.load(`500 20px ${LATIN}`, 'FLICK HOLD'); }
      this.tracking = await startHands({ video:this.video, options:CONFIG.tracker.options,
                         onResults:(res, t) => { this.pending = { res, t }; } });
      this.panel.showStage(); this.panel.setButton('Camera running', true);
      if (!this.running) { this.running = true; this.lastT = performance.now(); requestAnimationFrame(this.frame); }
    } catch (e) {
      this.panel.setError('Could not start: ' + (e.message || e) + '. Open this page in Chrome, Edge or Safari and allow camera access.');
      this.panel.setButton('Start camera', false);
    }
  }

  /** Render loop runs at display rate; tracking results are folded in whenever one arrives. */
  frame = (now) => {
    requestAnimationFrame(this.frame);
    const v = this.video; if (!v.videoWidth) return;
    const W = v.videoWidth, H = v.videoHeight, u = Math.min(W, H);
    if (this.canvas.width !== W || this.canvas.height !== H || this.bg.width !== W || !this.domain.nebula) {
      this.canvas.width = this.bg.width = W; this.canvas.height = this.bg.height = H; this.domain.resize(W, H);
    }
    const dt = clamp((now - this.lastT)/1000, .001, .05); this.lastT = now; Clock.t += dt;
    this.ctl = this.panel.controls();
    this.fx.reduceFlashes = this.ctl.reduce;

    const input = { W, H, u, k:u/720, poses:this.poses.state, flicks:{ blue:false, red:false }, openFlick:null, orbFloat:this.ctl.orbFloat };
    if (this.pending) { this.ingest(this.pending, input); this.pending = null; }
    this.faceFx.update(v, now, W, H, this.ctl.face);

    this.update(dt, input);
    this.render(W, H, u);
    this.updatePanel();
  };

  ingest({ res, t }, input) {
    const opts = this.ctl;
    // the tracker input isn't mirrored, so its handedness label is inverted
    this.hands = (res.multiHandLandmarks || []).map((lm, i) => {
      const lbl = res.multiHandedness && res.multiHandedness[i] && res.multiHandedness[i].label;
      const world = res.multiHandWorldLandmarks && res.multiHandWorldLandmarks[i];
      return readHand(lm, world, input.W, input.H, lbl === 'Left', opts);
    });
    this.poses.ingest(this.hands);
    const P = this.poses.state, merging = P.blue.on && P.red.on;
    input.flicks.blue = this.flicks.check('blue', merging ? null : P.blue.hand, t);
    input.flicks.red  = this.flicks.check('red',  merging ? null : P.red.hand,  t);
    input.openFlick = this.openFlicks.update(this.hands, t, this.purple.hold, this.ctl.flickSens);
    if (input.openFlick) this.lastFlick = input.openFlick.why;
  }

  update(dt, input) {
    const merge = this.purple.computeMerge(input);
    this.domain.update(dt, input);
    this.blue.update(dt, input, merge);
    this.red.update(dt, input, merge);
    this.purple.update(dt, input, this.blue, this.red);
    const focus = this.hands[0] ? this.hands[0].center : { x:input.W/2, y:input.H*.45 };
    this.game.update(dt, { W:input.W, H:input.H, u:input.u, focus, domainOpen:this.domain.charge >= 1 });
    this.fx.update(dt);

    const chargingPurple = this.purple.charge > .05;
    const level = t => (!merge.active && t.on && !chargingPurple) ? t.charge : 0;
    this.sound.update({ blue:level(this.blue), red:level(this.red), purple:this.purple.charge, domain:this.domain.charge });
    this.music.update(this.panel.musicLevel(), Math.max(this.domain.charge, this.purple.beam ? 1 : this.purple.charge*.6, this.game.state === 'over' ? .6 : 0));
  }

  render(W, H, u) {
    const scene = { video:this.video, bg:this.bg, W, H, u };

    // 0. backdrop: graded camera + the Domain (sampled later by the Blue lens / well)
    const b = this.bgCtx;
    Draw.video(b, this.video, W, H); Draw.grade(b, W, H);
    this.faceFx.renderHair(b, W, H, this.ctl.face);        // dyed after the grade so the colour survives it
    this.domain.renderBackdrop(b, scene);

    const { ctx } = this;
    ctx.save();
    this.fx.applyShake(ctx, u/720);
    ctx.clearRect(-60, -60, W+120, H+120);
    ctx.drawImage(this.bg, 0, 0);

    // 1. the world bends and takes on the technique's colour
    this.blue.renderWells(ctx, scene);
    this.blue.renderBackdrop(ctx, scene);
    this.game.render(ctx);                                 // curses sit in the world, so the washes colour them too
    this.red.renderWash(ctx, W, H); this.blue.renderWash(ctx, W, H); this.purple.renderWash(ctx, W, H);
    this.fx.drawTint(ctx, W, H);
    this.faceFx.renderEyes(ctx, this.ctl.face, Clock.t);  // glowing eyes sit above the washes
    this.purple.renderSpeedLines(ctx, W, H);
    this.fx.drawParticles(ctx);

    // 2. orbs + prompts
    this.blue.renderOrb(ctx); this.red.renderOrb(ctx); this.purple.renderOrb(ctx);
    this.purple.renderPrompt(ctx, u); this.blue.renderPrompt(ctx, u); this.red.renderPrompt(ctx, u);

    // 3. attacks + overlays
    this.blue.renderProjectiles(ctx); this.red.renderProjectiles(ctx);
    this.fx.drawWaves(ctx);
    this.purple.renderBeam(ctx);
    this.fx.drawBlasts(ctx, W, H);
    Draw.vignette(ctx, W, H);
    this.domain.renderBanner(ctx, W, H, u);
    this.fx.drawTitles(ctx, W, H);
    this.game.renderOverlay(ctx, W, H);
    this.fx.drawScreen(ctx, W, H);
    if (this.ctl.skeleton) Draw.skeleton(ctx, this.hands);
    ctx.restore();
  }

  updatePanel() {
    const { panel, domain, blue, red, purple } = this;
    panel.setCard('domain', domain.status());
    panel.setCard('blue', blue.status());
    panel.setCard('red', red.status());
    panel.setCard('purple', purple.status());

    let badge = '—';
    if (purple.beam) badge = '茈 Hollow Purple';
    else if (purple.charge > .03) badge = '茈 Charging';
    else if (domain.charge > .5) badge = '領域展開 Unlimited Void';
    else if (red.flashT > 0) badge = '赫 Red';
    else if (blue.flashT > 0 || blue.wells.length) badge = '蒼 Blue';
    else if (blue.on) badge = blue.ready ? '蒼 Blue — flick' : '蒼 Blue';
    else if (red.on) badge = red.ready ? '赫 Red — flick' : '赫 Red';
    else if (domain.charge > 0) badge = '領域展開 Casting';
    panel.setBadge(badge);
    panel.setGame(this.game.hud());
    panel.setFaceHint(this.faceFx.status(this.ctl.face));

    panel.setDebug(this.hands.length
      ? this.hands.map((h,i) => `H${i+1} ${h.isRight ? 'R' : 'L'}: <b style="color:${h.pose === 'purple' ? '#c7a8ff' : '#e8e6e1'}">${h.pose}</b> ${h.note}`).join('<br>')
      : 'no hand') + (this.lastFlick ? `<br>last flick: ${this.lastFlick}` : '');
  }
}

window.cursedHands = new App();   // handle for poking at it from the console
