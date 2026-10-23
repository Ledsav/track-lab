/* =============================================================================
   Spells: what a cast sigil turns into, and the ink splash of a ring that failed.
   -----------------------------------------------------------------------------
   A cast plays in four beats:
     ignite   (t < 0)        the ink lights up along the drawing, a bright head racing round it
     burst    (t ≈ 0)        a shockwave bends the page, the element bursts out, the camera shakes
     sustain                 the element: fire, water, wind, light, or a combination
     dissolve (last second)  the sigil comes apart into embers, drops, petals or gold
   new Spell(signs, c, R, { power, reduce, lines }) then every frame:
     update(dt)
     renderUnder(ctx)        on the paper, under the ink: watercolour, scorch, smoke, storm dark
     distort(ctx, buf)       bends the page already drawn (buf = a copy of it): shockwave, heat
                             haze, twisting wind, water ripples
     renderOver(ctx)         above the ink: flames, light, petals, rain, rainbow
     renderGlow(g)           bright shapes into a small glow layer the app blurs up and screens on
   The page is light parchment, so most of it is painted (watercolour multiplies, flames are opaque
   paint); light and heat glow through the glow layer. R is the sigil radius and power (≈ 0.5–2.2,
   from how big and full the sigil was drawn) scales how much there is, how far it reaches, how long
   it lasts and how hard it hits. The same sign twice counts as more power.
   ============================================================================= */
import { TAU, clamp, lerp, ease, rand, mulberry } from '../../shared/js/math.js';

export const ELEMENTS = {
  water: { name:'Water', ink:'#2b6cb0', rgb:'86,156,226', hot:'170,220,255' },
  fire:  { name:'Fire',  ink:'#c2451d', rgb:'255,138,58', hot:'255,170,70' },
  wind:  { name:'Wind',  ink:'#3d8660', rgb:'150,214,170', hot:'190,245,205' },
  light: { name:'Light', ink:'#b07f26', rgb:'255,212,120', hot:'255,226,150' },
};
const COMBOS = { 'water+wind':'Storm', 'fire+wind':'Firestorm', 'light+water':'Rainbow', 'fire+water':'Steam', 'fire+light':'Sunburst', 'light+wind':'Aurora' };
export const spellKey = signs => signs.length > 1 && signs[0] !== signs[1] ? [...signs].sort().join('+') : signs[0];
export function spellName(signs) {
  const k = spellKey(signs);
  return COMBOS[k] || (signs.length > 1 ? 'Twin ' : '') + ELEMENTS[signs[0]].name;
}
/** A word for how strong a cast is, put before its name ('' for an ordinary one). */
export const powerTier = P => P < .85 ? 'Faint' : P < 1.35 ? '' : P < 1.75 ? 'Mighty' : 'Grand';

const BLUES = ['38,112,214', '24,78,176', '40,146,200', '80,150,232'], PETALS = ['243,198,207', '232,163,181', '250,226,214', '143,191,138'];
const RAINBOW = ['224,83,60', '236,154,58', '233,210,90', '98,179,106', '79,143,216', '122,98,194'];
export const BOLT_TIMES = [.45, 1.2, 1.9, 2.6];   // storm lightning, seconds after the burst (the sound schedules thunder on them)
export const IGNITE = .45;                       // seconds of ignition before the burst
const MAX_PARTICLES = 1400;

/** A blot's outline: radius multipliers round the circle, a couple of slow waves and some grain. */
function wobbly(r, n = 28) { const p1 = r()*TAU, p2 = r()*TAU; return Array.from({ length:n }, (_, i) => { const a = i/n*TAU; return 1 + .13*Math.sin(2*a + p1) + .08*Math.sin(5*a + p2) + (r() - .5)*.08; }); }
function blobPath(ctx, x, y, r, edge) {
  const n = edge.length, P = edge.map((e, i) => ({ x:x + Math.cos(i/n*TAU)*r*e, y:y + Math.sin(i/n*TAU)*r*e }));
  const mid = i => ({ x:(P[i % n].x + P[(i + 1) % n].x)/2, y:(P[i % n].y + P[(i + 1) % n].y)/2 });
  ctx.beginPath(); ctx.moveTo(mid(0).x, mid(0).y);
  for (let i = 1; i <= n; i++) { const m = mid(i); ctx.quadraticCurveTo(P[i % n].x, P[i % n].y, m.x, m.y); }   // smooth through the midpoints
  ctx.closePath();
}
const annulus = (ctx, c, r0, r1) => { ctx.beginPath(); ctx.arc(c.x, c.y, r1, 0, TAU); ctx.arc(c.x, c.y, Math.max(0, r0), 0, TAU, true); };
/** A four-point glint: a long thin cross with a soft middle. */
function glint(ctx, x, y, s, col, a) {
  ctx.fillStyle = `rgba(${col},${a})`; ctx.beginPath();
  ctx.moveTo(x, y - s); ctx.lineTo(x + s*.14, y - s*.14); ctx.lineTo(x + s, y); ctx.lineTo(x + s*.14, y + s*.14);
  ctx.lineTo(x, y + s); ctx.lineTo(x - s*.14, y + s*.14); ctx.lineTo(x - s, y); ctx.lineTo(x - s*.14, y - s*.14); ctx.closePath(); ctx.fill();
}

/* Pre-rendered sprites: a gradient per particle per frame is what makes canvas effects slow. */
const sprites = new Map();
function sprite(key, w, h, draw) { let c = sprites.get(key); if (!c) { c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); sprites.set(key, c); } return c; }
/** A soft round dot of one colour, 64 px: scale it to any size. */
const softDot = col => sprite('dot' + col, 64, 64, g => { const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, `rgba(${col},1)`); gr.addColorStop(1, `rgba(${col},0)`); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); });
const dot = (ctx, img, x, y, r, a) => { if (a <= 0) return; ctx.globalAlpha = a; ctx.drawImage(img, x - r, y - r, r*2, r*2); ctx.globalAlpha = 1; };
/** A flame tongue at one of FLICKER lean-and-sway frames, drawn at s = 20 with its root at (24, 58). */
const FLICKER = 7;
const flameFrame = i => sprite('flame' + i, 48, 76, g => {
  const s = 20, w = -.3 + .6*i/(FLICKER - 1); g.translate(24, 58);
  const tongue = (k, col0, col1, al) => {
    const gr = g.createLinearGradient(0, -s*2.6*k, 0, s*.7*k);
    gr.addColorStop(0, `rgba(${col0},${al})`); gr.addColorStop(1, `rgba(${col1},${al*.75})`);
    g.fillStyle = gr; g.beginPath(); g.moveTo(s*w*1.3*k, -s*2.6*k);
    g.bezierCurveTo(s*(.75 + w*.3)*k, -s*1.1*k, s*.72*k, s*.3*k, 0, s*.7*k);
    g.bezierCurveTo(-s*.68*k, s*.3*k, -s*(.8 - w*.3)*k, -s*.95*k, s*w*1.3*k, -s*2.6*k); g.fill();
  };
  tongue(1, '240,140,50', '170,40,16', 1); tongue(.55, '255,222,120', '246,150,50', 1);
});

export class Spell {
  constructor(signs, c, R, o = {}) {
    this.signs = signs; this.key = spellKey(signs); this.name = spellName(signs);
    this.c = c; this.R = R; this.reduce = !!o.reduce; this.lines = (o.lines || []).filter(l => l.length > 1);
    this.has = Object.fromEntries(Object.keys(ELEMENTS).map(k => [k, signs.includes(k)]));
    const twin = signs.length > 1 && signs[0] === signs[1];
    this.P = clamp((o.power ?? 1)*(twin ? 1.3 : 1), .4, 2.6);
    this.reach = .75 + .5*this.P;                      // how far the effect spreads, in ring radii
    this.dur = 3.1 + .9*this.P;                        // seconds after the burst
    this.t = -IGNITE; this.p = []; this.flash = 0; this.acc = {}; this.burst = false; this.boltShake = 0;
    this.el = ELEMENTS[signs[0]];
    const r = this.rng = mulberry((Math.random()*1e9) | 0), k = this.key, P = this.P;
    const ph = [r()*TAU, r()*TAU, r()*TAU];                                    // the scorch's edge: a few slow waves plus a little grain
    this.edge = Array.from({ length:96 }, (_, i) => { const a = i/96*TAU; return 1 + .22*Math.sin(3*a + ph[0]) + .13*Math.sin(5*a + ph[1]) + .07*Math.sin(11*a + ph[2]) + (r() - .5)*.06; });
    this.blots = []; this.tendrils = []; this.streaks = []; this.bolts = [];
    this.lineLens = this.lines.map(l => { let s = 0; for (let i = 1; i < l.length; i++) s += Math.hypot(l[i].x - l[i - 1].x, l[i].y - l[i - 1].y); return s; });
    const water = this.has.water && k !== 'fire+water';
    if (water) for (let i = 0; i < Math.round(3 + 2.5*P); i++) {
      const a = r()*TAU, d = R*(.85 + r()*.45*this.reach);
      this.blots.push({ x:c.x + Math.cos(a)*d, y:c.y + Math.sin(a)*d, r:R*(.24 + r()*.22)*Math.sqrt(P), col:BLUES[i % 4], delay:r()*.5, a:.24, edge:wobbly(r), drift:{ x:Math.cos(a)*R*.12, y:Math.sin(a)*R*.12 } });
    }
    if (k === 'water+wind') for (let i = 0; i < 7; i++)                      // storm clouds gather above the ring
      this.blots.push({ x:c.x + (r() - .5)*R*3*this.reach, y:c.y - R*(1.4 + r()*.6), r:R*(.45 + r()*.35), col:'62,70,92', delay:r()*.25, a:.3, edge:wobbly(r) });
    if (water) for (let i = 0; i < Math.round(4 + 4*P); i++)
      this.tendrils.push({ a0:r()*TAU, dir:r() < .5 ? -1 : 1, len:(.8 + r()*.6)*this.reach, w:R*(.06 + r()*.04)*Math.sqrt(P), delay:r()*.3 });
    if (this.has.wind) for (let i = 0; i < Math.round(6 + 5*P); i++)
      this.streaks.push({ a0:r()*TAU, r0:R*(.9 + r()*.4), len:.9 + r()*.8, delay:i < 4 ? r()*.4 : r()*(this.dur - 1.8), grow:.6 + .5*this.reach, bristles:Array.from({ length:6 }, () => [(r() - .5)*.08, .35 + r()*.6]) });
    if (k === 'water+wind') for (const bt of BOLT_TIMES.slice(0, P > 1.5 ? 4 : 3)) this.bolts.push({ t:bt, pts:null });
  }

  get done() { return this.t > this.dur && !this.p.length; }
  /** 0→1 as the spell blooms, 1 while it holds, back to 0 as it ends. */
  get env() { return this.t <= 0 ? 0 : ease(this.t/.35)*clamp((this.dur - this.t)/.9, 0, 1); }
  /** Screen shake right now, in canvas pixels. */
  get shake() { const t = this.t, hit = t >= 0 && t < .5 ? this.R*.045*this.P*(1 - t/.5)**2 : 0; return Math.max(hit, this.boltShake); }
  /** True while distort() has something to do. */
  get distorting() { return this.t > 0 && this.t < this.dur; }

  /** Fractional emission: rate per second → whole particles this frame. */
  emit(name, rate, dt) { this.acc[name] = (this.acc[name] || 0) + rate*dt; const n = Math.floor(this.acc[name]); this.acc[name] -= n; return n; }
  ringPoint(a, k = 1) { return { x:this.c.x + Math.cos(a)*this.R*k, y:this.c.y + Math.sin(a)*this.R*k }; }
  linePoint() { const l = this.lines[(this.rng()*this.lines.length) | 0]; return l[(this.rng()*l.length) | 0]; }
  add(q) { if (this.p.length < MAX_PARTICLES) this.p.push({ vx:0, vy:0, g:0, rot:0, vr:0, swirl:0, out:0, drag:1, ph:Math.random()*TAU, ...q, max:q.life }); }

  /** The burst: everything that happens in the instant the spell goes off. */
  doBurst() {
    const { R, P, has, key } = this, n = k => Math.round(k*P), sq = Math.sqrt(P);
    if (has.fire && key !== 'fire+water') {
      for (let i = n(26); i--;) {                                         // flame jets thrown out of the ring
        const a = rand(0, TAU), p = this.ringPoint(a), v = R*rand(1.8, 3.2)*sq;
        this.add({ k:'flame', x:p.x, y:p.y, vx:Math.cos(a)*v, vy:Math.sin(a)*v - R*.3, drag:.08, g:-.7*R, life:rand(.5, .9), s:R*rand(.07, .12) });
      }
      for (let i = n(44); i--;) { const a = rand(0, TAU), p = this.ringPoint(a), v = R*rand(3, 6.5)*sq; this.add({ k:'spark', x:p.x, y:p.y, vx:Math.cos(a)*v, vy:Math.sin(a)*v, drag:.15, g:R*.9, life:rand(.35, .8), s:R*.012 }); }
    }
    if (has.water && key !== 'fire+water') for (let i = n(54); i--;) {    // a crown of water thrown up off the ring
      const a = rand(0, TAU), p = this.ringPoint(a);
      this.add({ k:'drop', x:p.x, y:p.y, vx:Math.cos(a)*R*rand(.5, 1.4)*sq, vy:-R*rand(1.4, 3)*sq, g:3.2*R, life:rand(.9, 1.5), s:R*rand(.022, .045), trail:true });
    }
    if (has.wind) for (let i = n(30); i--;) {                              // gusts whipping round
      const a = rand(0, TAU), p = this.ringPoint(a, rand(.9, 1.2)), v = R*rand(2.5, 4)*sq;
      this.add({ k:'gust', x:p.x, y:p.y, vx:-Math.sin(a)*v, vy:Math.cos(a)*v, swirl:R*2.6, out:R*.4, drag:.45, life:rand(.5, .9), s:R*.012 });
    }
    if (has.light) for (let i = n(26); i--;) {                             // glints flung out and twinkling
      const a = rand(0, TAU), p = this.ringPoint(a, rand(.2, 1)), v = R*rand(.8, 2.4)*sq;
      this.add({ k:'glint', x:p.x, y:p.y, vx:Math.cos(a)*v, vy:Math.sin(a)*v, drag:.2, life:rand(.8, 1.5), s:R*rand(.05, .1) });
    }
  }

  update(dt) {
    this.t += dt;
    const { c, R, t, has, key, P } = this, live = t > 0 && t < this.dur - .7, add = q => this.add(q);
    if (t >= 0 && !this.burst) { this.burst = true; this.doBurst(); }
    if (live && (has.fire && key !== 'fire+water' || key === 'fire+water' && t < 1.2)) {
      const storm = key === 'fire+wind';
      for (let i = this.emit('flame', 120*P, dt); i--;) {
        const p = this.lines.length && this.rng() < .35 ? this.linePoint() : this.ringPoint(rand(0, TAU));
        add({ k:'flame', x:p.x, y:p.y, vx:rand(-.15, .15)*R, vy:-rand(.5, 1)*R, g:-.5*R, life:rand(.4, .8), s:R*rand(.045, .09)*(.8 + .2*P),
              swirl:storm ? R*2.6 : 0, out:storm ? R*.5 : 0, drag:storm ? .5 : 1 });
      }
      for (let i = this.emit('ember', 30*P, dt); i--;) {
        const p = this.ringPoint(rand(0, TAU), rand(.8, 1.1));
        add({ k:'ember', x:p.x, y:p.y, vx:rand(-.2, .2)*R, vy:-rand(.3, .7)*R, life:rand(1.1, 2.2), s:R*rand(.012, .022),
              swirl:storm ? R*1.8 : 0, out:storm ? R*.4 : 0, drag:storm ? .6 : 1 });
      }
      if (key !== 'fire+water') for (let i = this.emit('smoke', 9*P, dt); i--;) {
        const p = this.ringPoint(rand(Math.PI*1.1, Math.PI*1.9), rand(.7, 1.1));
        add({ k:'smoke', x:p.x, y:p.y, vx:rand(-.1, .1)*R, vy:-rand(.3, .55)*R, life:rand(1.6, 2.6), s:R*rand(.18, .28), swirl:storm ? R*.8 : 0 });
      }
    }
    if (has.wind && key !== 'fire+wind') {
      const burst = t >= 0 && t < dt*1.5 ? Math.round(40*P) : 0, rate = live && t < 2.6 ? 24*P : 0;
      for (let i = burst + this.emit('petal', rate, dt); i-- > 0;) {
        const a = rand(0, TAU), p = this.ringPoint(a, rand(.3, 1));
        const col = key === 'light+wind' ? (this.rng() < .6 ? '255,224,150' : '255,247,226') : key === 'water+wind' ? PETALS[3] : PETALS[(this.rng()*PETALS.length) | 0];
        add({ k:'petal', x:p.x, y:p.y, vx:-Math.sin(a)*R*.7, vy:Math.cos(a)*R*.7, life:rand(1.8, 3), s:R*rand(.06, .1), rot:rand(0, TAU), vr:rand(-6, 6),
              swirl:R*1.5*Math.sqrt(P), out:R*.32*this.reach, drag:.7, col });
      }
    }
    if (has.wind && live) for (let i = this.emit('gust', 16*P, dt); i--;) {   // gusts keep whipping round while the wind holds
      const a = rand(0, TAU), p = this.ringPoint(a, rand(.9, 1.4)*this.reach*.8), v = R*rand(2, 3.2);
      add({ k:'gust', x:p.x, y:p.y, vx:-Math.sin(a)*v, vy:Math.cos(a)*v, swirl:R*2.2, out:R*.25, drag:.5, life:rand(.5, .9), s:R*.011 });
    }
    if (has.light && live) {
      for (let i = this.emit('mote', (t < 2.6 ? 30 : 0)*P, dt); i--;) {
        const a = rand(0, TAU), d = R*Math.sqrt(this.rng())*1.6*this.reach;
        add({ k:'mote', x:c.x + Math.cos(a)*d, y:c.y + Math.sin(a)*d, vx:rand(-.05, .05)*R, vy:-rand(.05, .22)*R, life:rand(1.2, 2.4), s:R*rand(.012, .026) });
      }
      for (let i = this.emit('twinkle', 9*P, dt); i--;) {                // glints that flare and vanish in place
        const a = rand(0, TAU), d = R*Math.sqrt(this.rng())*1.5*this.reach;
        add({ k:'glint', x:c.x + Math.cos(a)*d, y:c.y + Math.sin(a)*d, life:rand(.35, .7), s:R*rand(.04, .08) });
      }
    }
    if (key === 'water+wind' && live) for (let i = this.emit('rain', 150*P, dt); i--;)
      add({ k:'rain', x:c.x + rand(-2.3, 2)*R*this.reach, y:c.y - R*rand(1.6, 2.4), vx:R*.8, vy:R*rand(4.2, 5.2), life:.9, s:R*.14 });
    if (key === 'fire+water' && t > 0 && t < 2.8) for (let i = this.emit('cloud', 22*P, dt); i--;) {
      const p = this.ringPoint(rand(Math.PI*1.05, Math.PI*1.95), rand(.6, 1));
      add({ k:'cloud', x:p.x, y:p.y, vx:rand(-.1, .1)*R, vy:-rand(.35, .6)*R, life:rand(1.4, 2.2), s:R*rand(.2, .3) });
    }
    for (const td of this.tendrils) {                                     // water drips off the tendril heads
      const h = ease((t - td.delay)/1.5);
      if (h > 0 && h < 1 && this.emit('drip' + td.a0, 9, dt)) {
        const p = this.tendrilAt(td, h);
        add({ k:'drop', x:p.x, y:p.y, vx:rand(-.2, .2)*R, vy:rand(-.4, 0)*R, g:1.6*R, life:rand(.7, 1.2), s:R*rand(.025, .04) });
      }
    }
    // dissolve: in the last second the drawing itself comes apart
    if (t > this.dur - 1.3 && t < this.dur - .3 && this.lines.length) for (let i = this.emit('flake', 70*Math.sqrt(P), dt); i--;) {
      const p = this.linePoint(), kind = this.has.fire ? 'ember' : this.has.light ? 'mote' : 'flake';
      add({ k:kind, x:p.x, y:p.y, vx:rand(-.2, .2)*R, vy:-rand(.2, .6)*R, vr:rand(-5, 5), rot:rand(0, TAU), life:rand(.7, 1.3), s:kind === 'flake' ? R*rand(.015, .03) : R*rand(.012, .022), col:this.el.rgb });
    }
    this.boltShake = Math.max(0, this.boltShake - dt*R*.3);
    for (const b of this.bolts) if (!b.pts && t >= b.t) { b.pts = this.boltPath(); this.flash = this.reduce ? 0 : .3; this.boltShake = R*.035; }
    this.flash = Math.max(0, this.flash - dt*2.5);

    for (const q of this.p) {
      if (q.swirl || q.out) {
        const dx = q.x - c.x, dy = q.y - c.y, d = Math.hypot(dx, dy) || 1;
        q.vx += (-dy/d*q.swirl + dx/d*q.out)*dt; q.vy += (dx/d*q.swirl + dy/d*q.out)*dt;
      }
      if (q.drag !== 1) { const k = Math.pow(q.drag, dt); q.vx *= k; q.vy *= k; }
      q.vy += q.g*dt; q.x += q.vx*dt; q.y += q.vy*dt; q.rot += q.vr*dt; q.life -= dt;
    }
    let j = 0; for (const q of this.p) if (q.life > 0 && this.t < this.dur + 2) this.p[j++] = q; this.p.length = j;
  }

  tendrilAt(td, s) { const a = td.a0 + td.dir*s*2.6, d = this.R*(1 + s*td.len*1.1); return { x:this.c.x + Math.cos(a)*d, y:this.c.y + Math.sin(a)*d }; }
  /** A jagged bolt from above down to the ring, with a branch or two forking off it. */
  boltPath() {
    const { R } = this, r = this.rng, end = this.ringPoint(rand(Math.PI*1.15, Math.PI*1.85));
    const jag = (a, b, n, amp) => { const pts = [a]; for (let i = 1; i < n; i++) { const k = i/n; pts.push({ x:lerp(a.x, b.x, k) + (r() - .5)*amp, y:lerp(a.y, b.y, k) + (r() - .5)*amp*.3 }); } pts.push(b); return pts; };
    const main = jag({ x:this.c.x + (r() - .5)*R*2.4, y:this.c.y - R*2.5 }, end, 12, R*.4), branches = [];
    for (let k = 0; k < 2; k++) { const s = main[3 + ((r()*6) | 0)]; branches.push(jag(s, { x:s.x + (r() - .5)*R*1.4, y:s.y + R*(.4 + r()*.5) }, 5, R*.25)); }
    return [main, ...branches];
  }

  /** The drawing lit up to a share k of each stroke's length (the ignition). Returns the head points. */
  litPath(ctx, k) {
    const heads = [];
    this.lines.forEach((l, li) => {
      const target = this.lineLens[li]*k; let s = 0;
      ctx.moveTo(l[0].x, l[0].y);
      for (let i = 1; i < l.length; i++) {
        const d = Math.hypot(l[i].x - l[i - 1].x, l[i].y - l[i - 1].y);
        if (s + d >= target) { const f = (target - s)/(d || 1), h = { x:lerp(l[i - 1].x, l[i].x, f), y:lerp(l[i - 1].y, l[i].y, f) }; ctx.lineTo(h.x, h.y); heads.push(h); return; }
        ctx.lineTo(l[i].x, l[i].y); s += d;
      }
    });
    return heads;
  }

  /* ---------- on the paper, under the ink ---------- */
  renderUnder(ctx) {
    const { c, R, t, has, key } = this, env = this.env;
    if (t <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    // the page dims around the cast so its light reads (less for light itself)
    const dim = (has.light && key !== 'water+wind' ? .12 : .3)*env*Math.min(1, this.P), far = R*(2.2 + this.reach);
    const dg = ctx.createRadialGradient(c.x, c.y, R*.8, c.x, c.y, far*1.6);
    dg.addColorStop(0, 'rgba(255,255,255,0)'); dg.addColorStop(1, `rgba(${key === 'water+wind' ? '50,60,85' : '70,52,40'},${dim})`);
    ctx.fillStyle = dg; ctx.fillRect(c.x - far*1.6, c.y - far*1.6, far*3.2, far*3.2);
    if (key === 'water+wind') {                                           // storm: the sky goes dark around the sigil
      const sg = ctx.createRadialGradient(c.x, c.y - R, 0, c.x, c.y - R, R*3*this.reach);
      sg.addColorStop(0, `rgba(70,82,110,${.45*env})`); sg.addColorStop(1, 'rgba(70,82,110,0)');
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(c.x, c.y - R, R*3*this.reach, 0, TAU); ctx.fill();
    }
    for (const b of this.blots) {                                         // watercolour: pale middle, darker pooled edge
      const g = ease((t - b.delay)/.9); if (g <= 0) continue;
      const r = b.r*(g + .25*clamp(t - b.delay - .9, 0, 2)), a = b.a*clamp((this.dur - t)/1.1, 0, 1);   // keeps bleeding slowly into the paper
      const bx = b.x + (b.drift ? b.drift.x*g : 0), by = b.y + (b.drift ? b.drift.y*g : 0);
      const gr = ctx.createRadialGradient(bx, by, 0, bx, by, r*1.15);
      gr.addColorStop(0, `rgba(${b.col},${a*.4})`); gr.addColorStop(.75, `rgba(${b.col},${a*.8})`); gr.addColorStop(1, `rgba(${b.col},${a})`);
      ctx.fillStyle = gr; blobPath(ctx, bx, by, r, b.edge); ctx.fill();
      ctx.strokeStyle = `rgba(${b.col},${a*.7})`; ctx.lineWidth = Math.max(1, R*.008); ctx.stroke();   // pigment pools at the drying edge
    }
    if (has.fire && key !== 'fire+water') {                               // scorched paper with a ragged edge
      const grow = this.scorch, a = clamp((this.dur + .6 - t)/1.2, 0, 1);
      const gr = ctx.createRadialGradient(c.x, c.y, R*.7, c.x, c.y, R*(1 + .55*grow));
      gr.addColorStop(0, 'rgba(60,30,12,0)'); gr.addColorStop(.22, `rgba(52,26,10,${.6*a})`); gr.addColorStop(.6, `rgba(110,62,26,${.3*a})`); gr.addColorStop(1, `rgba(150,95,45,${.1*a})`);
      ctx.fillStyle = gr; ctx.beginPath(); this.edgePath(ctx, grow); ctx.arc(c.x, c.y, R*.78, 0, TAU, true); ctx.fill();
    }
    for (const q of this.p) if (q.k === 'smoke') {                       // soot rising off the burn
      const age = 1 - q.life/q.max, s = q.s*(1 + age*1.8), a = .22*Math.sin(Math.PI*clamp(1 - age, 0, 1));
      dot(ctx, softDot('80,66,58'), q.x, q.y, s, a);
    }
    ctx.restore();
  }

  get scorch() { return ease(this.t/1.1)*(.5 + .35*this.P); }
  edgePath(ctx, grow) {
    const n = this.edge.length;
    for (let i = 0; i <= n; i++) {
      const a = i/n*TAU, d = this.R*(1 + .48*grow*this.edge[i % n]);
      const x = this.c.x + Math.cos(a)*d, y = this.c.y + Math.sin(a)*d;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  /* ---------- bending the page ---------- */
  distort(ctx, buf) {
    const { c, R, t, P, has, key } = this, env = this.env;
    ctx.save();
    if (t < .7) {                                                         // the shockwave: a magnifying band racing outwards
      const k = t/.7, r = R*(1 + ease(k)*(1.3 + .9*P));
      this.lens(ctx, buf, c, r - R*(.12 + .08*P), r + R*(.12 + .08*P), .09*(1 - k)*Math.min(1.7, P));
    }
    if (has.water && key !== 'fire+water') for (let i = 0; i < 2; i++) {  // ripples: gentle bands of refraction
      const f = (t*.5 + i/2) % 1, r = R*(1.1 + f*1.4*this.reach);
      this.lens(ctx, buf, c, r - R*.08, r + R*.08, .03*env*(1 - f)*Math.min(1.5, P));
    }
    if (has.wind) {                                                       // the sigil turns as one piece and the page around it twists, then unwinds
      const N = 10, R0 = R*1.12, Rw = R*(1.6 + .8*this.reach), turn = .4*Math.min(1.9, P)*Math.sin(Math.PI*clamp(t/(this.dur*.95), 0, 1));
      const spin = (r0, r1, a) => {                                      // only the square round this band, not the whole page
        if (Math.abs(a) < .003) return;
        const x = Math.max(0, c.x - r1*1.05), y = Math.max(0, c.y - r1*1.05), w = Math.min(buf.width, c.x + r1*1.05) - x, h = Math.min(buf.height, c.y + r1*1.05) - y;
        if (w <= 0 || h <= 0) return;
        ctx.save(); annulus(ctx, c, r0, r1); ctx.clip(); ctx.translate(c.x, c.y); ctx.rotate(a); ctx.translate(-c.x, -c.y); ctx.drawImage(buf, x, y, w, h, x, y, w, h); ctx.restore();
      };
      spin(0, R0, turn);
      for (let i = 0; i < N; i++) spin(R0 + (Rw - R0)*i/N, R0 + (Rw - R0)*(i + 1)/N, turn*Math.pow(1 - (i + .5)/N, 1.6));
    }
    if (has.fire || key === 'fire+water') {                               // heat haze shimmering above the fire
      const amp = R*.012*Math.min(1.8, P)*env, x0 = Math.max(0, c.x - R*1.4), w = Math.min(buf.width - x0, R*2.8);
      const y0 = Math.max(0, c.y - R*(1.3 + 1.5*this.reach)), y1 = Math.min(buf.height, c.y - R*.75);   // the air above the ring; the drawing itself stays readable
      if (amp > .3 && w > 0) for (let y = y0; y < y1; y += 2) {
        const fall = clamp((y - y0)/(R*.6), 0, 1)*clamp((y1 - y)/(R*.35), 0, 1);
        const dx = (Math.sin(y*.07 + t*8) + .5*Math.sin(y*.023 - t*4.5))*amp*fall;
        ctx.drawImage(buf, x0, y, w, 2, x0 + dx, y, w, 2);
      }
    }
    ctx.restore();
  }
  /** Redraw an annulus of the page magnified by (1 + k) about the centre: a band of refraction. */
  lens(ctx, buf, c, r0, r1, k) {
    if (Math.abs(k) < .002) return;
    const x = Math.max(0, c.x - r1), y = Math.max(0, c.y - r1), w = Math.min(buf.width, c.x + r1) - x, h = Math.min(buf.height, c.y + r1) - y;
    if (w <= 0 || h <= 0) return;
    ctx.save(); annulus(ctx, c, r0, r1); ctx.clip();
    ctx.translate(c.x, c.y); ctx.scale(1 + k, 1 + k); ctx.translate(-c.x, -c.y); ctx.drawImage(buf, x, y, w, h, x, y, w, h);
    ctx.restore();
  }

  /* ---------- above the ink ---------- */
  renderOver(ctx) {
    const { c, R, t, has, key, P } = this, env = this.env, glow = this.reduce ? .45 : 1;
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (t < .15) {                                                        // ignition: the strokes light up in the element's colour
      const k = ease(clamp((t + IGNITE)/IGNITE, 0, 1));
      ctx.strokeStyle = this.el.ink; ctx.lineWidth = R*.032; ctx.globalAlpha = t < 0 ? 1 : 1 - t/.15;
      ctx.beginPath(); const heads = this.litPath(ctx, k); ctx.stroke();
      ctx.globalAlpha = 1; for (const h of heads) glint(ctx, h.x, h.y, R*.09, this.el.hot, .95);
    }
    if (t >= 0 && t < .6) {                                               // two shock rings painted over the bent page
      for (const [delay, w] of [[0, .035], [.08, .015]]) {
        const k = clamp((t - delay)/.6, 0, 1); if (k <= 0) continue;
        ctx.strokeStyle = `rgba(${this.el.rgb},${(1 - k)*.8})`; ctx.lineWidth = R*w*(1 - k) + 1;
        ctx.beginPath(); ctx.arc(c.x, c.y, R*(1 + ease(k)*(1.3 + .9*P)), 0, TAU); ctx.stroke();
      }
    }
    if (t <= 0) { ctx.restore(); return; }
    if (has.light) {
      const big = (key === 'fire+light' ? 1.4 : key === 'light+water' ? .55 : 1)*this.reach, rgb = key === 'fire+light' ? '206,110,32' : '186,128,36';
      const L = R*2.1*big, grow = ease(t/.6);                            // gilded rays, long and short in turn: drawn once, then turned
      if (!this.rays) this.rays = sprite('rays' + rgb, 512, 512, g => {
        for (let i = 0; i < 16; i++) {
          const a = i*TAU/16, len = 256*(i % 2 ? 1.3/2.1 : 1), w = .045;
          const gr = g.createRadialGradient(256, 256, 256*.1, 256, 256, len);
          gr.addColorStop(0, `rgba(${rgb},.5)`); gr.addColorStop(1, `rgba(${rgb},0)`);
          g.fillStyle = gr; g.beginPath(); g.moveTo(256, 256);
          g.lineTo(256 + Math.cos(a - w)*len, 256 + Math.sin(a - w)*len); g.lineTo(256 + Math.cos(a + w)*len, 256 + Math.sin(a + w)*len); g.fill();
        }
      });
      ctx.save(); ctx.globalAlpha = env; ctx.translate(c.x, c.y); ctx.rotate(t*.25); ctx.drawImage(this.rays, -L*grow, -L*grow, L*2*grow, L*2*grow); ctx.restore();
      ctx.globalCompositeOperation = 'screen';                            // the light itself: the page brightens around the sigil
      const bloom = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R*1.4*big);
      bloom.addColorStop(0, `rgba(255,246,214,${.6*env*glow})`); bloom.addColorStop(.4, `rgba(255,226,150,${.28*env*glow})`); bloom.addColorStop(1, 'rgba(255,226,150,0)');
      ctx.fillStyle = bloom; ctx.beginPath(); ctx.arc(c.x, c.y, R*.9*big, 0, TAU); ctx.fill();
      if (P > 1.1 && key !== 'light+water') {                             // a strong cast sends a column of light up the page
        const w = R*(.35 + .25*P), a = env*clamp((P - 1.1)/.6, 0, 1)*.4*glow;
        const col = ctx.createLinearGradient(0, c.y, 0, 0);
        col.addColorStop(0, `rgba(255,240,200,${a})`); col.addColorStop(1, 'rgba(255,240,200,0)');
        ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(c.x - w*.5, c.y); ctx.lineTo(c.x - w, 0); ctx.lineTo(c.x + w, 0); ctx.lineTo(c.x + w*.5, c.y); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    if (has.fire && key !== 'fire+water') {
      const grow = this.scorch, a = clamp((2.6 - t)/1.2, 0, 1)*glow;
      if (a > 0) { ctx.strokeStyle = `rgba(228,96,32,${.75*a})`; ctx.lineWidth = Math.max(1, R*.012); ctx.beginPath(); this.edgePath(ctx, grow); ctx.stroke(); }   // the burning edge
      const fl = .5 + .5*Math.sin(t*23)*Math.sin(t*7);                   // heat: the paper warms to orange around the ring
      const g = ctx.createRadialGradient(c.x, c.y, R*.5, c.x, c.y, R*1.8*this.reach);
      g.addColorStop(0, `rgba(255,160,80,${(.35 + .1*fl)*env})`); g.addColorStop(1, 'rgba(255,160,80,0)');
      ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, R*1.8*this.reach, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    if (has.water && key !== 'fire+water') {
      for (let k = 0; k < 3; k++) {                                       // ripple lines spreading out from the ring
        const f = (t*.55 + k/3) % 1, a = (1 - f)*.55*env;
        ctx.strokeStyle = `rgba(43,108,176,${a})`; ctx.lineWidth = Math.max(1, R*.012*(1 - f) + .5);
        ctx.beginPath(); ctx.arc(c.x, c.y, R*(1.05 + f*1.1*this.reach), 0, TAU); ctx.stroke();
      }
      ctx.save(); ctx.beginPath(); ctx.arc(c.x, c.y, R*.92, 0, TAU); ctx.clip();   // caustics: light dancing through water inside the ring
      ctx.globalCompositeOperation = 'screen'; ctx.lineWidth = R*.022;
      for (let k = 0; k < 7; k++) {
        ctx.strokeStyle = `rgba(210,238,255,${.32*env})`; ctx.beginPath();
        for (let x = -1; x <= 1.001; x += .05) {
          const y = -1 + (k + .5)/3.5 + Math.sin(x*5 + t*2.2 + k*1.3)*.08 + Math.sin(x*11 - t*3.1 + k)*.03;
          const px = c.x + x*R, py = c.y + y*R*.95; x > -1 ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    for (const td of this.tendrils) this.drawTendril(ctx, td);
    for (const s of this.streaks) this.drawStreak(ctx, s);
    if (key === 'light+water') this.drawRainbow(ctx);
    if (key === 'light+wind') this.drawAurora(ctx);
    for (const q of this.p) if (q.k !== 'smoke') this.drawParticle(ctx, q);
    for (const b of this.bolts) if (b.pts && t - b.t < .3) this.drawBolt(ctx, b.pts, 1 - (t - b.t)/.3);
    if (t < .3) {                                                         // the burst flash, in the element's light
      const a = (1 - t/.3)*.5*glow, rr = R*(1 + .5*P);
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rr);
      g.addColorStop(0, `rgba(${this.el.hot},${a})`); g.addColorStop(1, `rgba(${this.el.hot},0)`);
      ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, rr, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  /* ---------- the glow layer (the app blurs it up and screens it over the page) ---------- */
  renderGlow(g) {
    const { c, R, t, has, key, P } = this, env = this.env, k = this.reduce ? .5 : 1;
    g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'round'; g.lineJoin = 'round';
    const blob = (x, y, r, col, a) => dot(g, softDot(col), x, y, r, Math.min(1, a));
    if (t < .4) {                                                         // the lit drawing and its racing head
      const kk = ease(clamp((t + IGNITE)/IGNITE, 0, 1)), a = t < 0 ? .9 : .9*(1 - t/.4);
      g.strokeStyle = `rgba(${this.el.hot},${a*k*.8})`; g.lineWidth = R*.12; g.beginPath(); const heads = this.litPath(g, kk); g.stroke();
      for (const h of heads) blob(h.x, h.y, R*.35, this.el.hot, a*k);
    }
    if (t >= 0 && t < .4) blob(c.x, c.y, R*(1 + .6*P)*ease(t/.12 + .3), this.el.hot, .8*(1 - t/.4)*k);   // the burst core
    if (t > 0) {
      if (has.light) blob(c.x, c.y, R*1.4*this.reach, '255,200,110', .32*env*k);
      if (has.fire && key !== 'fire+water') {
        blob(c.x, c.y, R*1.5, '255,130,40', (.3 + .1*Math.sin(t*19))*env*k);
        g.strokeStyle = `rgba(255,120,30,${.6*clamp((2.6 - t)/1.2, 0, 1)*k})`; g.lineWidth = R*.08; g.beginPath(); this.edgePath(g, this.scorch); g.stroke();
      }
      for (const q of this.p) {
        const age = 1 - q.life/q.max;
        if (q.k === 'flame') blob(q.x, q.y - q.s, q.s*3, '255,140,40', .28*(1 - age)*k);
        else if (q.k === 'ember' || q.k === 'spark') blob(q.x, q.y, R*.07, '255,150,50', .5*(1 - age)*k);
        else if (q.k === 'glint' || q.k === 'mote') blob(q.x, q.y, q.s*3, '255,226,160', .45*Math.sin(Math.PI*clamp(1 - age, 0, 1))*k);
      }
      for (const b of this.bolts) if (b.pts && t - b.t < .3) {
        const a = (1 - (t - b.t)/.3)*k; g.strokeStyle = `rgba(170,200,255,${.8*a})`; g.lineWidth = R*.18;
        for (const l of b.pts) { g.beginPath(); l.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.stroke(); }
      }
      if (key === 'light+wind') blob(c.x, c.y - R*1.3, R*2.2, '90,220,150', .25*env*k);
    }
    g.restore();
  }

  drawTendril(ctx, td) {
    const t = this.t, head = ease((t - td.delay)/1.5), tail = Math.max(0, head - .5), fade = clamp((this.dur - t)/1, 0, 1);
    if (head <= 0 || fade <= 0) return;
    for (const [col, k, off] of [['43,108,176', 1, 0], ['205,232,255', .3, -.3]]) {   // body, then a highlight along it
      ctx.strokeStyle = `rgba(${col},${.85*fade})`;
      let prev = null;
      for (let s = tail; s <= head + 1e-6; s += .02) {
        const p = this.tendrilAt(td, s), u = (s - tail)/((head - tail) || 1), w = td.w*k*Math.sin(Math.PI*clamp(u, .05, 1))*(.4 + .6*u);
        if (prev) { ctx.lineWidth = Math.max(.8, w); ctx.beginPath(); ctx.moveTo(prev.x + off*w, prev.y + off*w); ctx.lineTo(p.x + off*w, p.y + off*w); ctx.stroke(); }
        prev = p;
      }
    }
  }

  /** Dry-brush streak: six thin bristle arcs spiralling outwards. */
  drawStreak(ctx, s) {
    const g = ease((this.t - s.delay)/1.6); if (g <= 0 || g >= 1) return;
    const { c, R } = this, r = s.r0 + R*s.grow*g, a0 = s.a0 + g*2.4, col = this.key === 'fire+wind' ? '190,80,30' : this.key === 'light+wind' ? '176,132,50' : '52,110,80';
    for (const [dr, a] of s.bristles) {
      ctx.strokeStyle = `rgba(${col},${a*Math.sin(Math.PI*g)})`; ctx.lineWidth = Math.max(1.2, R*.02);
      ctx.beginPath(); ctx.arc(c.x, c.y, r*(1 + dr), a0, a0 + s.len*(.6 + .4*g)); ctx.stroke();
    }
  }

  drawRainbow(ctx) {
    const { c, R, t } = this, sweep = ease((t - .3)/1.2), fade = clamp((this.dur - t)/1, 0, 1), big = Math.sqrt(this.P); if (sweep <= 0) return;
    ctx.lineCap = 'butt';
    RAINBOW.forEach((col, i) => {
      ctx.strokeStyle = `rgba(${col},${.55*fade})`; ctx.lineWidth = R*.085*big;
      ctx.beginPath(); ctx.arc(c.x, c.y + R*.1, R*(1.72 - i*.085)*big, Math.PI, Math.PI + Math.PI*sweep); ctx.stroke();
    });
    ctx.lineCap = 'round';
  }

  drawAurora(ctx) {
    const { c, R, t } = this, env = this.env*(this.reduce ? .6 : 1), span = 2.2*this.reach;
    ctx.globalCompositeOperation = 'multiply';
    for (let k = 0; k < 3; k++) for (let x = -span; x <= span; x += .05) {
      const y = c.y - R*(.95 + k*.15) + Math.sin(x*2.1 + t*1.3 + k*1.7)*R*.16, h = R*(.65 + .25*Math.sin(x*3 + t*2 + k))*this.reach;
      const g = ctx.createLinearGradient(0, y, 0, y - h);
      g.addColorStop(0, 'rgba(70,180,130,0)'); g.addColorStop(.25, `rgba(70,180,130,${.34*env})`); g.addColorStop(1, 'rgba(150,110,220,0)');   // soft at the foot, fading up into violet
      ctx.fillStyle = g; ctx.fillRect(c.x + x*R, y - h, R*.05, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  drawBolt(ctx, lines, a) {
    lines.forEach((l, i) => {
      for (const [w, col] of [[this.R*(i ? .04 : .07), `rgba(210,230,255,${.6*a})`], [this.R*(i ? .01 : .022), `rgba(30,45,100,${.95*a})`]]) {
        ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); l.forEach((p, j) => j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
      }
    });
  }

  drawParticle(ctx, q) {
    const age = 1 - q.life/q.max, R = this.R;
    if (q.k === 'flame') {                                                // a flickering tongue: crooked tip, red root, a yellow tongue inside
      const s = q.s*(1 - age*.5), a = Math.min(1, (1 - age)*1.5)*.85, lean = clamp(q.vx/(R*1.2), -.6, .6);
      const f = Math.round((Math.sin(this.t*17 + q.ph)*.5 + .5)*(FLICKER - 1)), k = s/20;
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = a;
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(lean*.6); ctx.scale(k, k); ctx.drawImage(flameFrame(f), -24, -58); ctx.restore();
      ctx.globalAlpha = 1;
    } else if (q.k === 'ember' || q.k === 'spark') {                     // hot bits, smeared along the way they're flying
      const a = Math.sin(Math.PI*clamp(1 - age, 0, 1))*(q.k === 'spark' ? 1 : .55 + .45*Math.sin(this.t*9 + q.ph));
      const sp = Math.hypot(q.vx, q.vy), l = Math.min(R*.18, sp*.035 + q.s);
      ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = q.k === 'spark' ? `rgba(255,170,60,${a})` : `rgba(222,88,28,${a})`; ctx.lineWidth = q.s*1.6;
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.vx/(sp || 1)*l, q.y - q.vy/(sp || 1)*l); ctx.stroke();
    } else if (q.k === 'mote') {
      const a = Math.sin(Math.PI*clamp(1 - age, 0, 1))*(.55 + .45*Math.sin(this.t*9 + q.ph));
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = `rgba(196,142,48,${a})`;   // gold-leaf flecks catching the light
      ctx.beginPath(); ctx.arc(q.x, q.y, q.s, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(255,248,220,${a*.8})`; ctx.beginPath(); ctx.arc(q.x - q.s*.3, q.y - q.s*.3, q.s*.4, 0, TAU); ctx.fill();
    } else if (q.k === 'glint') {
      const a = Math.sin(Math.PI*clamp(1 - age, 0, 1)), s = q.s*(.6 + .4*a);
      ctx.globalCompositeOperation = 'source-over'; glint(ctx, q.x, q.y, s*1.1, '190,138,44', a*.6);
      ctx.globalCompositeOperation = 'screen'; glint(ctx, q.x, q.y, s, '255,250,230', a);
    } else if (q.k === 'gust') {
      const a = Math.sin(Math.PI*clamp(1 - age, 0, 1))*.7, sp = Math.hypot(q.vx, q.vy) || 1, l = R*.35;
      ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = `rgba(52,110,80,${a})`; ctx.lineWidth = q.s*1.4;
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.quadraticCurveTo(q.x - q.vx/sp*l*.5 + q.vy/sp*l*.12, q.y - q.vy/sp*l*.5 - q.vx/sp*l*.12, q.x - q.vx/sp*l, q.y - q.vy/sp*l); ctx.stroke();
    } else if (q.k === 'petal') {
      const a = Math.min(1, q.life/.6);
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = `rgba(${q.col},${.9*a})`;
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.rot); ctx.scale(1, .55 + .45*Math.abs(Math.sin(q.rot*.7)));   // turning in the air
      ctx.beginPath(); ctx.moveTo(-q.s, 0); ctx.quadraticCurveTo(0, -q.s*.8, q.s, 0); ctx.quadraticCurveTo(0, q.s*.8, -q.s, 0); ctx.fill();
      ctx.strokeStyle = `rgba(120,70,80,${.25*a})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-q.s*.8, 0); ctx.lineTo(q.s*.8, 0); ctx.stroke();
      ctx.restore();
    } else if (q.k === 'flake') {                                         // a fleck of the sigil's ink, tinted, tumbling away
      const a = Math.min(1, q.life/.4)*.85, w = q.s*Math.abs(Math.cos(q.rot));
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = `rgba(${q.col},${a})`;
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.rot*.3); ctx.fillRect(-w, -q.s*.5, w*2, q.s); ctx.restore();
    } else if (q.k === 'drop') {
      const ang = Math.atan2(q.vy, q.vx), a = Math.min(1, q.life/.3);
      ctx.globalCompositeOperation = 'source-over';
      if (q.trail) { const sp = Math.hypot(q.vx, q.vy) || 1, l = Math.min(R*.25, sp*.05); ctx.strokeStyle = `rgba(52,118,186,${.35*a})`; ctx.lineWidth = q.s*.8; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.vx/sp*l, q.y - q.vy/sp*l); ctx.stroke(); }
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(ang);
      ctx.fillStyle = `rgba(52,118,186,${.85*a})`; ctx.beginPath(); ctx.moveTo(q.s*1.8, 0); ctx.quadraticCurveTo(0, -q.s, -q.s, 0); ctx.quadraticCurveTo(0, q.s, q.s*1.8, 0); ctx.fill();
      ctx.fillStyle = `rgba(230,245,255,${.8*a})`; ctx.beginPath(); ctx.arc(-q.s*.2, -q.s*.3, q.s*.28, 0, TAU); ctx.fill();
      ctx.restore();
    } else if (q.k === 'rain') {
      ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = `rgba(52,78,120,${.5*Math.min(1, q.life/.2)})`; ctx.lineWidth = Math.max(1, R*.01);
      const l = Math.hypot(q.vx, q.vy) || 1;
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.vx/l*q.s, q.y - q.vy/l*q.s); ctx.stroke();
    } else if (q.k === 'cloud') {
      const s = q.s*(1 + age*1.4), a = .5*Math.sin(Math.PI*clamp(1 - age, 0, 1));
      ctx.globalCompositeOperation = 'multiply'; dot(ctx, softDot('120,130,150'), q.x, q.y + s*.25, s*1.05, a*.5);   // a soft grey underside…
      ctx.globalCompositeOperation = 'source-over'; dot(ctx, softDot('255,255,255'), q.x, q.y, s, Math.min(1, a*1.6));   // …under the white
    }
  }
}

/** The ink splash of a ring that didn't close: blots, satellite drops and drips along the stroke. */
export class Splash {
  constructor(pts, u) {
    const r = mulberry((Math.random()*1e9) | 0); this.t = 0; this.life = 1.7;
    this.blots = Array.from({ length:9 }, () => {
      const p = pts[(r()*pts.length) | 0], s = u*(.006 + r()*.016);
      return { x:p.x + (r() - .5)*u*.02, y:p.y + (r() - .5)*u*.02, s, edge:wobbly(r, 16),
               sats:Array.from({ length:4 + ((r()*4) | 0) }, () => ({ a:r()*TAU, d:s*(1.5 + r()*3), s:s*(.1 + r()*.22), k:1.5 + r()*2 })),
               drip:r() < .4 ? s*(2 + r()*5) : 0 };
    });
  }
  get done() { return this.t > this.life; }
  update(dt) { this.t += dt; }
  render(ctx, ink) {
    const grow = ease(this.t/.12), a = clamp((this.life - this.t)/.6, 0, 1);
    ctx.save(); ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.globalAlpha = .85*a; ctx.lineCap = 'round';
    for (const b of this.blots) {
      blobPath(ctx, b.x, b.y, b.s*grow, b.edge); ctx.fill();
      for (const s of b.sats) {                                           // spray: drops stretched along the way they flew
        ctx.beginPath(); ctx.ellipse(b.x + Math.cos(s.a)*s.d*grow, b.y + Math.sin(s.a)*s.d*grow, s.s*s.k, s.s, s.a, 0, TAU); ctx.fill();
      }
      if (b.drip) { const l = b.drip*ease(this.t/1.2); ctx.lineWidth = b.s*.45; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x, b.y + l); ctx.stroke(); ctx.beginPath(); ctx.arc(b.x, b.y + l, b.s*.3, 0, TAU); ctx.fill(); }
    }
    ctx.restore();
  }
}
