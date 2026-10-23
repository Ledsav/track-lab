/* =============================================================================
   Spells: what a cast sigil turns into, and the ink splash of a ring that failed.
   -----------------------------------------------------------------------------
   new Spell(signs, c, R, { reduce, lines, dur }) then update(dt) every frame and
     renderUnder(ctx)  on the paper, under the ink: watercolour, scorch, storm clouds
     renderOver(ctx)   above the ink: flames, light, petals, rain, rainbow
   The page is light parchment, so effects are painted rather than glowing: watercolour multiplies
   into the paper, flames and gold are opaque paint, only light itself brightens (screen).
   R is the sigil radius: every size and speed scales with it. lines = the sigil's strokes,
   so fire can run along them. Two different signs combine (COMBOS); the same sign twice is
   a greater version of it.
   ============================================================================= */
import { TAU, clamp, lerp, ease, rand, mulberry } from '../../shared/js/math.js';

export const ELEMENTS = {
  water: { name:'Water', ink:'#2b6cb0', rgb:'86,156,226' },
  fire:  { name:'Fire',  ink:'#c2451d', rgb:'255,138,58' },
  wind:  { name:'Wind',  ink:'#3d8660', rgb:'150,214,170' },
  light: { name:'Light', ink:'#b07f26', rgb:'255,212,120' },
};
const COMBOS = { 'water+wind':'Storm', 'fire+wind':'Firestorm', 'light+water':'Rainbow', 'fire+water':'Steam', 'fire+light':'Sunburst', 'light+wind':'Aurora' };
export const spellKey = signs => signs.length > 1 && signs[0] !== signs[1] ? [...signs].sort().join('+') : signs[0];
export function spellName(signs) {
  const k = spellKey(signs);
  return COMBOS[k] || (signs.length > 1 ? 'Greater ' : '') + ELEMENTS[signs[0]].name;
}

const BLUES = ['38,112,214', '24,78,176', '40,146,200', '80,150,232'], PETALS = ['243,198,207', '232,163,181', '250,226,214', '143,191,138'];
const RAINBOW = ['224,83,60', '236,154,58', '233,210,90', '98,179,106', '79,143,216', '122,98,194'];
const BOLT_TIMES = [.55, 1.35, 2.1];        // storm lightning (the sound schedules its thunder on the same beats)
export { BOLT_TIMES };

/** A blot's outline: radius multipliers round the circle, a couple of slow waves and some grain. */
function wobbly(r, n = 28) { const p1 = r()*TAU, p2 = r()*TAU; return Array.from({ length:n }, (_, i) => { const a = i/n*TAU; return 1 + .13*Math.sin(2*a + p1) + .08*Math.sin(5*a + p2) + (r() - .5)*.08; }); }
function blobPath(ctx, x, y, r, edge) {
  const n = edge.length, P = edge.map((e, i) => ({ x:x + Math.cos(i/n*TAU)*r*e, y:y + Math.sin(i/n*TAU)*r*e }));
  const mid = i => ({ x:(P[i % n].x + P[(i + 1) % n].x)/2, y:(P[i % n].y + P[(i + 1) % n].y)/2 });
  ctx.beginPath(); ctx.moveTo(mid(0).x, mid(0).y);
  for (let i = 1; i <= n; i++) { const m = mid(i); ctx.quadraticCurveTo(P[i % n].x, P[i % n].y, m.x, m.y); }   // smooth through the midpoints
  ctx.closePath();
}

export class Spell {
  constructor(signs, c, R, o = {}) {
    this.signs = signs; this.key = spellKey(signs); this.name = spellName(signs);
    this.c = c; this.R = R; this.reduce = !!o.reduce; this.lines = (o.lines || []).filter(l => l.length);
    this.has = Object.fromEntries(Object.keys(ELEMENTS).map(k => [k, signs.includes(k)]));
    this.power = signs.length > 1 && signs[0] === signs[1] ? 1.45 : 1;
    this.t = 0; this.dur = o.dur || 3.8; this.p = []; this.flash = 0; this.acc = {};
    const r = this.rng = mulberry((Math.random()*1e9) | 0), k = this.key;
    const ph = [r()*TAU, r()*TAU, r()*TAU];                                    // the scorch's edge: a few slow waves plus a little grain
    this.edge = Array.from({ length:96 }, (_, i) => { const a = i/96*TAU; return 1 + .22*Math.sin(3*a + ph[0]) + .13*Math.sin(5*a + ph[1]) + .07*Math.sin(11*a + ph[2]) + (r() - .5)*.06; });
    this.blots = []; this.tendrils = []; this.streaks = []; this.bolts = [];
    if (this.has.water && k !== 'fire+water') for (let i = 0; i < 7*this.power; i++) {
      const a = r()*TAU, d = R*(.75 + r()*.6);
      this.blots.push({ x:c.x + Math.cos(a)*d, y:c.y + Math.sin(a)*d, r:R*(.35 + r()*.35), col:BLUES[i % 4], delay:r()*.35, a:.36, edge:wobbly(r) });
    }
    if (k === 'water+wind') for (let i = 0; i < 6; i++)                      // storm clouds gather above the ring
      this.blots.push({ x:c.x + (r() - .5)*R*2.8, y:c.y - R*(1.5 + r()*.5), r:R*(.4 + r()*.3), col:'70,80,100', delay:r()*.25, a:.26, edge:wobbly(r) });
    if (this.has.water && k !== 'fire+water') for (let i = 0; i < 5*this.power; i++)
      this.tendrils.push({ a0:r()*TAU, dir:r() < .5 ? -1 : 1, len:1 + r()*.6, w:R*(.07 + r()*.04), delay:r()*.3, drip:0 });
    if (this.has.wind) for (let i = 0; i < 10*this.power; i++)
      this.streaks.push({ a0:r()*TAU, r0:R*(.9 + r()*.4), len:.9 + r()*.7, delay:r()*.6, bristles:Array.from({ length:6 }, () => [(r() - .5)*.08, .35 + r()*.6]) });
    if (k === 'water+wind') for (const bt of BOLT_TIMES) this.bolts.push({ t:bt, pts:null });
  }

  get done() { return this.t > this.dur && !this.p.length; }
  /** 0→1 as the spell blooms, 1 while it holds, back to 0 as it ends. */
  get env() { return ease(this.t/.35)*clamp((this.dur - this.t)/.9, 0, 1); }

  /** Fractional emission: rate per second → whole particles this frame. */
  emit(name, rate, dt) { this.acc[name] = (this.acc[name] || 0) + rate*dt; const n = Math.floor(this.acc[name]); this.acc[name] -= n; return n; }
  ringPoint(a, k = 1) { return { x:this.c.x + Math.cos(a)*this.R*k, y:this.c.y + Math.sin(a)*this.R*k }; }
  linePoint() { const l = this.lines[(this.rng()*this.lines.length) | 0]; return l[(this.rng()*l.length) | 0]; }

  update(dt) {
    this.t += dt;
    const { c, R, t, has, key, power } = this, live = t < this.dur - .7;
    const add = q => this.p.push({ vx:0, vy:0, g:0, rot:0, vr:0, swirl:0, out:0, drag:1, ...q, max:q.life });
    if (live && (has.fire && key !== 'fire+water' || key === 'fire+water' && t < 1.2)) {
      for (let i = this.emit('flame', 150*power, dt); i--;) {
        const p = this.lines.length && this.rng() < .35 ? this.linePoint() : this.ringPoint(rand(0, TAU));
        const storm = key === 'fire+wind';
        add({ k:'flame', x:p.x, y:p.y, vx:rand(-.15, .15)*R, vy:-rand(.5, 1)*R, g:-.5*R, life:rand(.4, .8), s:R*rand(.045, .09), ph:rand(0, TAU),
              swirl:storm ? R*2.6 : 0, out:storm ? R*.5 : 0, drag:storm ? .5 : 1 });
      }
      for (let i = this.emit('ember', 26*power, dt); i--;) {
        const p = this.ringPoint(rand(0, TAU), rand(.8, 1.1));
        add({ k:'ember', x:p.x, y:p.y, vx:rand(-.2, .2)*R, vy:-rand(.25, .6)*R, life:rand(1.1, 2.2), s:R*rand(.012, .022), ph:rand(0, TAU),
              swirl:key === 'fire+wind' ? R*1.8 : 0, out:key === 'fire+wind' ? R*.4 : 0, drag:key === 'fire+wind' ? .6 : 1 });
      }
    }
    if (has.wind && key !== 'fire+wind') {
      const burst = t < dt*1.5 ? 40*power : 0, rate = t < 2.4 ? 26*power : 0;
      for (let i = burst + this.emit('petal', rate, dt); i-- > 0;) {
        const a = rand(0, TAU), p = this.ringPoint(a, rand(.3, 1));
        const col = key === 'light+wind' ? (this.rng() < .6 ? '255,224,150' : '255,247,226') : key === 'water+wind' ? PETALS[3] : PETALS[(this.rng()*PETALS.length) | 0];
        add({ k:'petal', x:p.x, y:p.y, vx:-Math.sin(a)*R*.7, vy:Math.cos(a)*R*.7, life:rand(1.8, 3), s:R*rand(.06, .1), rot:rand(0, TAU), vr:rand(-6, 6),
              swirl:R*1.5, out:R*.32, drag:.7, col });
      }
    }
    if (has.light) for (let i = this.emit('mote', (t < 2.6 ? 34 : 0)*power, dt); i--;) {
      const a = rand(0, TAU), d = R*Math.sqrt(this.rng())*1.8;
      add({ k:'mote', x:c.x + Math.cos(a)*d, y:c.y + Math.sin(a)*d, vx:rand(-.05, .05)*R, vy:-rand(.05, .22)*R, life:rand(1.2, 2.4), s:R*rand(.012, .026), ph:rand(0, TAU) });
    }
    if (key === 'water+wind' && live) for (let i = this.emit('rain', 170, dt); i--;)
      add({ k:'rain', x:c.x + rand(-2.3, 2)*R, y:c.y - R*rand(1.6, 2.4), vx:R*.7, vy:R*rand(4.2, 5.2), life:.9, s:R*.13 });
    if (key === 'fire+water' && t < 2.8) for (let i = this.emit('cloud', 24, dt); i--;) {
      const p = this.ringPoint(rand(Math.PI*1.05, Math.PI*1.95), rand(.6, 1));
      add({ k:'cloud', x:p.x, y:p.y, vx:rand(-.1, .1)*R, vy:-rand(.35, .6)*R, life:rand(1.4, 2.2), s:R*rand(.2, .3) });
    }
    // water drips off the tendril heads
    for (const td of this.tendrils) {
      const h = ease((t - td.delay)/1.5);
      if (h > 0 && h < 1 && this.emit('drip' + td.a0, 9, dt)) {
        const p = this.tendrilAt(td, h);
        add({ k:'drop', x:p.x, y:p.y, vx:rand(-.2, .2)*R, vy:rand(-.4, 0)*R, g:1.6*R, life:rand(.7, 1.2), s:R*rand(.025, .04) });
      }
    }
    for (const b of this.bolts) if (!b.pts && t >= b.t) { b.pts = this.boltPath(); this.flash = this.reduce ? 0 : .35; }
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
  boltPath() {
    const { c, R } = this, r = this.rng, end = this.ringPoint(rand(Math.PI*1.15, Math.PI*1.85));
    let x = c.x + (r() - .5)*R*2.2, y = c.y - R*2.3; const pts = [{ x, y }];
    for (let i = 1; i <= 9; i++) { const k = i/9; x = lerp(pts[0].x, end.x, k) + (i < 9 ? (r() - .5)*R*.35 : 0); y = lerp(pts[0].y, end.y, k); pts.push({ x, y }); }
    return pts;
  }

  /** On the paper, under the ink. */
  renderUnder(ctx) {
    const { c, R, t, has, key } = this, env = this.env;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    for (const b of this.blots) {                                  // watercolour: pale middle, darker pooled edge
      const g = ease((t - b.delay)/.9); if (g <= 0) continue;
      const r = b.r*g, a = b.a*clamp((this.dur - t)/1.1, 0, 1);
      const gr = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r*1.15);
      gr.addColorStop(0, `rgba(${b.col},${a*.4})`); gr.addColorStop(.75, `rgba(${b.col},${a*.8})`); gr.addColorStop(1, `rgba(${b.col},${a})`);
      ctx.fillStyle = gr; blobPath(ctx, b.x, b.y, r, b.edge); ctx.fill();
      ctx.strokeStyle = `rgba(${b.col},${a*.7})`; ctx.lineWidth = Math.max(1, this.R*.008); ctx.stroke();   // pigment pools at the drying edge
    }
    if (has.fire && key !== 'fire+water') {                        // scorched paper with a ragged edge
      const grow = ease(t/1.1)*(.6 + .4*this.power), a = clamp((this.dur + .6 - t)/1.2, 0, 1);
      const gr = ctx.createRadialGradient(c.x, c.y, R*.7, c.x, c.y, R*(1 + .55*grow));
      gr.addColorStop(0, 'rgba(60,30,12,0)'); gr.addColorStop(.22, `rgba(52,26,10,${.6*a})`); gr.addColorStop(.6, `rgba(110,62,26,${.3*a})`); gr.addColorStop(1, `rgba(150,95,45,${.1*a})`);
      ctx.fillStyle = gr; ctx.beginPath(); this.edgePath(ctx, grow); ctx.arc(c.x, c.y, R*.78, 0, TAU, true); ctx.fill();
    }
    ctx.restore();
  }

  edgePath(ctx, grow) {
    const n = this.edge.length;
    for (let i = 0; i <= n; i++) {
      const a = i/n*TAU, d = this.R*(1 + .48*grow*this.edge[i % n]);
      const x = this.c.x + Math.cos(a)*d, y = this.c.y + Math.sin(a)*d;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  /** Above the ink. */
  renderOver(ctx) {
    const { c, R, t, has, key } = this, env = this.env, glow = this.reduce ? .55 : 1;
    ctx.save();
    // the cast itself: a ring of the element's colour blooming out of the drawing
    if (t < .6) {
      const k = ease(t/.6), rgb = ELEMENTS[this.signs[0]].rgb;
      ctx.strokeStyle = `rgba(${rgb},${(1 - k)*.7})`; ctx.lineWidth = R*.05*(1 - k) + 1;
      ctx.beginPath(); ctx.arc(c.x, c.y, R*(1 + k*1.1), 0, TAU); ctx.stroke();
    }
    if (has.light) {
      const big = key === 'fire+light' ? 1.4 : key === 'light+water' ? .55 : 1, rgb = key === 'fire+light' ? '214,120,40' : '200,146,52';
      const n = 14, spin = t*.25;
      for (let i = 0; i < n; i++) {                                 // gilded rays, long and short in turn
        const a = spin + i*TAU/n, len = R*(i % 2 ? 1.5 : 2.4)*big*ease(t/.6)*this.power, w = .05;
        const gr = ctx.createRadialGradient(c.x, c.y, R*.2, c.x, c.y, len);
        gr.addColorStop(0, `rgba(${rgb},${.4*env})`); gr.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = gr; ctx.beginPath(); ctx.moveTo(c.x, c.y);
        ctx.lineTo(c.x + Math.cos(a - w)*len, c.y + Math.sin(a - w)*len); ctx.lineTo(c.x + Math.cos(a + w)*len, c.y + Math.sin(a + w)*len); ctx.fill();
      }
      ctx.globalCompositeOperation = 'screen';                       // the light itself: the page brightens around the sigil
      const bloom = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R*1.5*big);
      bloom.addColorStop(0, `rgba(255,246,214,${.85*env*glow})`); bloom.addColorStop(.5, `rgba(255,232,170,${.4*env*glow})`); bloom.addColorStop(1, 'rgba(255,232,170,0)');
      ctx.fillStyle = bloom; ctx.beginPath(); ctx.arc(c.x, c.y, R*1.5*big, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    if (has.fire && key !== 'fire+water') {                         // the burn line glowing along the scorch
      const grow = ease(t/1.1)*(.6 + .4*this.power), a = clamp((2.6 - t)/1.2, 0, 1)*glow;
      if (a > 0) {                                                   // the burning edge of the paper: a thin ember line
        ctx.strokeStyle = `rgba(228,96,32,${.75*a})`; ctx.lineWidth = Math.max(1, R*.012); ctx.lineJoin = 'round';
        ctx.beginPath(); this.edgePath(ctx, grow); ctx.stroke();
      }
      const fl = .5 + .5*Math.sin(t*23)*Math.sin(t*7);              // heat: the paper warms to orange around the ring
      const g = ctx.createRadialGradient(c.x, c.y, R*.5, c.x, c.y, R*1.8);
      g.addColorStop(0, `rgba(255,160,80,${(.35 + .1*fl)*env})`); g.addColorStop(1, 'rgba(255,160,80,0)');
      ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, R*1.8, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    if (has.water && key !== 'fire+water') for (let k = 0; k < 3; k++) {     // ripples spreading out from the ring
      const f = (t*.55 + k/3) % 1, a = (1 - f)*.55*env;
      ctx.strokeStyle = `rgba(43,108,176,${a})`; ctx.lineWidth = Math.max(1, R*.012*(1 - f) + .5);
      ctx.beginPath(); ctx.arc(c.x, c.y, R*(1.05 + f*1.1), 0, TAU); ctx.stroke();
    }
    for (const td of this.tendrils) this.drawTendril(ctx, td);
    for (const s of this.streaks) this.drawStreak(ctx, s);
    if (key === 'light+water') this.drawRainbow(ctx);
    if (key === 'light+wind') this.drawAurora(ctx);
    for (const q of this.p) this.drawParticle(ctx, q);
    for (const b of this.bolts) if (b.pts && t - b.t < .28) this.drawBolt(ctx, b.pts, 1 - (t - b.t)/.28);
    ctx.restore();
  }

  drawTendril(ctx, td) {
    const t = this.t, head = ease((t - td.delay)/1.5), tail = Math.max(0, head - .5), fade = clamp((this.dur - t)/1, 0, 1);
    if (head <= 0 || fade <= 0) return;
    ctx.lineCap = 'round';
    for (const [col, k, off] of [['43,108,176', 1, 0], ['200,230,255', .3, -.3]]) {   // body, then a highlight along it
      ctx.strokeStyle = `rgba(${col},${.8*fade})`;
      let prev = null;
      for (let s = tail; s <= head + 1e-6; s += .02) {
        const p = this.tendrilAt(td, s), u = (s - tail)/((head - tail) || 1), w = td.w*k*Math.sin(Math.PI*clamp(u, .05, 1))*(.4 + .6*u);
        if (prev) { ctx.lineWidth = Math.max(.8, w); ctx.beginPath(); ctx.moveTo(prev.x + off*w, prev.y + off*w); ctx.lineTo(p.x + off*w, p.y + off*w); ctx.stroke(); }
        prev = p;
      }
    }
  }

  /** Dry-brush streak: five thin bristle arcs spiralling outwards. */
  drawStreak(ctx, s) {
    const g = ease((this.t - s.delay)/1.6); if (g <= 0 || g >= 1) return;
    const { c, R } = this, r = s.r0 + R*.75*g, a0 = s.a0 + g*2.4, col = this.key === 'fire+wind' ? '190,80,30' : this.key === 'light+wind' ? '176,132,50' : '52,110,80';
    ctx.lineCap = 'round';
    for (const [dr, a] of s.bristles) {
      ctx.strokeStyle = `rgba(${col},${a*Math.sin(Math.PI*g)})`; ctx.lineWidth = Math.max(1.2, R*.02);
      ctx.beginPath(); ctx.arc(c.x, c.y, r*(1 + dr), a0, a0 + s.len*(.6 + .4*g)); ctx.stroke();
    }
  }

  drawRainbow(ctx) {
    const { c, R, t } = this, sweep = ease((t - .3)/1.2), fade = clamp((this.dur - t)/1, 0, 1); if (sweep <= 0) return;
    ctx.lineCap = 'butt';
    RAINBOW.forEach((col, i) => {
      ctx.strokeStyle = `rgba(${col},${.55*fade})`; ctx.lineWidth = R*.085;
      ctx.beginPath(); ctx.arc(c.x, c.y + R*.1, R*(1.72 - i*.085), Math.PI, Math.PI + Math.PI*sweep); ctx.stroke();
    });
  }

  drawAurora(ctx) {
    const { c, R, t } = this, env = this.env*(this.reduce ? .6 : 1);
    ctx.globalCompositeOperation = 'multiply';
    for (let k = 0; k < 3; k++) for (let x = -2.2; x <= 2.2; x += .05) {
      const y = c.y - R*(.95 + k*.15) + Math.sin(x*2.1 + t*1.3 + k*1.7)*R*.16, h = R*(.65 + .25*Math.sin(x*3 + t*2 + k));
      const g = ctx.createLinearGradient(0, y, 0, y - h);
      g.addColorStop(0, 'rgba(70,180,130,0)'); g.addColorStop(.25, `rgba(70,180,130,${.34*env})`); g.addColorStop(1, 'rgba(150,110,220,0)');   // soft at the foot, fading up into violet
      ctx.fillStyle = g; ctx.fillRect(c.x + x*R, y - h, R*.05, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  drawBolt(ctx, pts, a) {
    ctx.lineJoin = 'round';
    for (const [w, col] of [[this.R*.07, `rgba(200,225,255,${.55*a})`], [this.R*.02, `rgba(40,60,120,${.95*a})`]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  drawParticle(ctx, q) {
    const age = 1 - q.life/q.max, R = this.R;
    if (q.k === 'flame') {                                         // a flickering tongue: crooked tip, red root, a yellow tongue inside
      const s = q.s*(1 - age*.5), a = Math.min(1, (1 - age)*1.5)*.85, lean = clamp(q.vx/(R*1.2), -.6, .6), w = Math.sin(this.t*17 + q.ph)*.3;
      ctx.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(lean*.6);
      const tongue = (k, col0, col1, al) => {
        const g = ctx.createLinearGradient(0, -s*2.6*k, 0, s*.7*k);
        g.addColorStop(0, `rgba(${col0},${al})`); g.addColorStop(1, `rgba(${col1},${al*.75})`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(s*w*1.3*k, -s*2.6*k);
        ctx.bezierCurveTo(s*(.75 + w*.3)*k, -s*1.1*k, s*.72*k, s*.3*k, 0, s*.7*k);
        ctx.bezierCurveTo(-s*.68*k, s*.3*k, -s*(.8 - w*.3)*k, -s*.95*k, s*w*1.3*k, -s*2.6*k); ctx.fill();
      };
      tongue(1, '240,140,50', '170,40,16', a); tongue(.55, '255,222,120', '246,150,50', a);
      ctx.restore();
    } else if (q.k === 'ember' || q.k === 'mote') {
      const tw = .55 + .45*Math.sin(this.t*9 + q.ph), a = Math.sin(Math.PI*clamp(1 - age, 0, 1))*tw;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = q.k === 'ember' ? `rgba(222,88,28,${a})` : `rgba(196,142,48,${a})`;          // embers, gold-leaf flecks
      ctx.beginPath(); ctx.arc(q.x + (q.k === 'ember' ? Math.sin(this.t*4 + q.ph)*R*.03 : 0), q.y, q.s, 0, TAU); ctx.fill();
      if (q.k === 'mote') { ctx.fillStyle = `rgba(255,248,220,${a*.8})`; ctx.beginPath(); ctx.arc(q.x - q.s*.3, q.y - q.s*.3, q.s*.4, 0, TAU); ctx.fill(); }
    } else if (q.k === 'petal') {
      const a = Math.min(1, q.life/.6);
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = `rgba(${q.col},${.9*a})`;
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.rot); ctx.scale(1, .55 + .45*Math.abs(Math.sin(q.rot*.7)));   // turning in the air
      ctx.beginPath(); ctx.moveTo(-q.s, 0); ctx.quadraticCurveTo(0, -q.s*.8, q.s, 0); ctx.quadraticCurveTo(0, q.s*.8, -q.s, 0); ctx.fill();
      ctx.strokeStyle = `rgba(120,70,80,${.25*a})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-q.s*.8, 0); ctx.lineTo(q.s*.8, 0); ctx.stroke();
      ctx.restore();
    } else if (q.k === 'drop') {
      const ang = Math.atan2(q.vy, q.vx), a = Math.min(1, q.life/.3);
      ctx.globalCompositeOperation = 'source-over';
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
      ctx.globalCompositeOperation = 'source-over';
      const sh = ctx.createRadialGradient(q.x, q.y + s*.25, 0, q.x, q.y + s*.25, s*1.05);
      sh.addColorStop(0, `rgba(120,130,150,${a*.5})`); sh.addColorStop(1, 'rgba(120,130,150,0)');
      ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(q.x, q.y + s*.25, s*1.05, 0, TAU); ctx.fill();
      const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, s);
      g.addColorStop(0, `rgba(255,255,255,${a*1.6})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x, q.y, s, 0, TAU); ctx.fill();
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
      for (const s of b.sats) {                                    // spray: drops stretched along the way they flew
        ctx.beginPath(); ctx.ellipse(b.x + Math.cos(s.a)*s.d*grow, b.y + Math.sin(s.a)*s.d*grow, s.s*s.k, s.s, s.a, 0, TAU); ctx.fill();
      }
      if (b.drip) { const l = b.drip*ease(this.t/1.2); ctx.lineWidth = b.s*.45; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x, b.y + l); ctx.stroke(); ctx.beginPath(); ctx.arc(b.x, b.y + l, b.s*.3, 0, TAU); ctx.fill(); }
    }
    ctx.restore();
  }
}
