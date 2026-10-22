/* =============================================================================
   EXORCISM: curse waves
   -----------------------------------------------------------------------------
   Cursed spirits drift out of the dark and come at the camera. Each one has a
   depth z (1 = far, 0 = in your face); its screen size follows a simple
   perspective 1/(1 + 3z), so it swells fast in the last second. At z = 0 it hits you.

   The techniques reach this module through world.game (no-ops when not playing):
     hitTest(x, y, r)                   projectile proximity: Blue / Red detonate early
     damageCircle(x, y, r, dmg, {push}) Red blast (push = knocked back in depth), Blue collapse
     damageSegment(x0, y0, x1, y1, r, dmg)  Hollow Purple's trench
     pull(x, y, radius, k, dt)          Blue's gravity well drags curses in and holds them
   Unlimited Void (domain fully open) paralyses every curse and drains it for
   CFG.voidSureHit seconds per cast.
   ============================================================================= */
import { TAU, clamp, lerp, rand, mulberry, prune } from '../../shared/js/math.js';

const CFG = {
  lives: 5,
  comboWindow: 2.5,            // s between kills to keep the chain
  voidSureHit: 5, voidDps: 1.4,
  countdown: 2.4, intermission: 3,
  perspective: 3,              // screen scale = 1/(1 + perspective·z)
  serif: '"Shippori Mincho","Yu Mincho","Hiragino Mincho ProN",serif',
  latin: '"Oswald","Arial Narrow",sans-serif',
};
const BEST_KEY = 'track-lab:cursed-hands:best';

/** size = radius at z = 0, as a share of min(W, H). speed = depth per second. */
export const CURSES = {
  fly:    { kanji:'蠅頭',   en:'Fly Head',       hp:1,  score:50,   size:.075, speed:.17, wander:1,   swarm:2, draw:drawFly },
  arms:   { kanji:'腕塊',   en:'Arm Knot',       hp:3,  score:120,  size:.13,  speed:.11, wander:.45, draw:drawArms },
  split:  { kanji:'裂口',   en:'Split Face',     hp:5,  score:180,  size:.15,  speed:.09, wander:.3,  draw:drawSplit },
  bearer: { kanji:'指持ち', en:'Finger Bearer',  hp:26, score:1500, size:.23,  speed:.04, wander:.15, boss:true, damage:2, draw:drawBearer },
};

const KN = '〇一二三四五六七八九';
const kanjiNum = n => n < 10 ? KN[n] : (n >= 20 ? KN[Math.floor(n/10)] : '') + '十' + (n % 10 ? KN[n % 10] : '');
const loadBest = () => { try { return +localStorage.getItem(BEST_KEY) || 0; } catch { return 0; } };
const saveBest = v => { try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* private mode */ } };
function segDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx*dx + dy*dy || 1, t = clamp(((px - x0)*dx + (py - y0)*dy)/l2, 0, 1);
  return Math.hypot(px - (x0 + dx*t), py - (y0 + dy*t));
}

export class CurseWaves {
  constructor(world) {
    this.world = world; this.best = loadBest(); this.state = 'idle'; this.t = 0;
    this.env = { W:1280, H:720, u:720, focus:{ x:640, y:330 } };
    this.reset();
  }
  /** countdown | wave | intermission: the game is on. idle / over: free play. */
  get active() { return this.state === 'countdown' || this.state === 'wave' || this.state === 'intermission'; }

  reset() {
    this.curses = []; this.popups = []; this.queue = [];
    this.wave = 0; this.score = 0; this.kills = 0; this.lives = CFG.lives;
    this.combo = 0; this.comboT = 0; this.timer = 0; this.spawnT = 0;
    this.voidLeft = 0; this.prevVoid = false; this.voidOn = false; this.hurtT = 0; this.hitSfxT = 0;
  }
  start() { this.reset(); this.state = 'countdown'; this.timer = CFG.countdown; }
  stop()  { this.state = 'idle'; this.curses = []; }

  /* ---------- waves ---------- */
  plan(n) {
    const q = [], count = 3 + n*2;
    for (let i = 0; i < count; i++) {
      const r = Math.random();
      q.push(n >= 3 && r < Math.min(.35, .12 + n*.03) ? 'split' : n >= 2 && r < .55 ? 'arms' : 'fly');
    }
    if (n % 5 === 0) q.splice(2, 0, 'bearer');
    return q;
  }
  beginWave(n) {
    const { W, H, u } = this.env, { fx, sound } = this.world;
    this.wave = n; this.queue = this.plan(n); this.spawnT = .8; this.state = 'wave';
    this.interval = Math.max(.55, 2.1 - n*.13); this.speedMul = 1 + (n - 1)*.07; this.hpMul = 1 + Math.floor((n - 1)/5)*.5;
    sound.shot('waveStart');
    fx.title(`第${kanjiNum(n)}波`, W/2, H*.42, '#c21f2a', u*.15, { sub:`WAVE ${n}`, life:1.8 });
  }
  clearWave() {
    const { W, H, u } = this.env, { fx, sound } = this.world;
    this.state = 'intermission'; this.timer = CFG.intermission;
    if (this.wave % 5 === 0 && this.lives < CFG.lives) this.lives++;          // a boss wave gives a life back
    sound.shot('waveClear');
    fx.title('祓除', W/2, H*.42, '#9b5cff', u*.13, { sub:'WAVE CLEARED', life:1.6 });
  }
  gameOver() {
    this.state = 'over';
    if (this.score > this.best) { this.best = this.score; saveBest(this.best); this.newBest = true; } else this.newBest = false;
    this.world.sound.shot('gameOver');
    this.world.fx.kick({ shake:1, flash:.6 });
  }

  spawn(kind) {
    const T = CURSES[kind], { W, H, u } = this.env, { fx, sound } = this.world, n = T.swarm || 1;
    const ax = rand(.14, .86)*W, ay = rand(.18, .68)*H;
    for (let i = 0; i < n; i++) {
      const hp = T.hp*this.hpMul;
      this.curses.push({ kind, T, ax:ax + (n > 1 ? rand(-1, 1)*u*.08 : 0), ay:ay + (n > 1 ? rand(-1, 1)*u*.06 : 0), z:1 + i*.05,
        hp, max:hp, seed:Math.floor(rand(1, 1e5)), ph:rand(0, TAU), flash:0, stun:0, dying:0, x:ax, y:ay, R:1, speedMul:this.speedMul });
    }
    sound.shot(T.boss ? 'bossRoar' : 'curseSpawn');
    fx.wave(ax, ay, '150,70,210', u*.14, { rev:true, life:.5 });
    if (T.boss) { fx.title(T.kanji, W/2, H*.28, '#ff7a2a', u*.12, { sub:T.en.toUpperCase(), life:1.8 }); fx.kick({ shake:.5 }); }
  }

  /* ---------- per frame ---------- */
  /** env = { W, H, u, focus:{x,y}, domainOpen } */
  update(dt, env) {
    this.env = env; this.t += dt;
    for (const p of this.popups) { p.t += dt; p.y -= dt*env.u*.09; }
    prune(this.popups, p => p.t < p.life);
    this.hurtT = Math.max(0, this.hurtT - dt); this.hitSfxT -= dt;
    if (!this.active) { for (const c of this.curses) this.updateCurse(c, dt, false); prune(this.curses, c => !c.gone); return; }

    this.comboT -= dt; if (this.comboT <= 0) this.combo = 0;
    if (env.domainOpen && !this.prevVoid) this.voidLeft = CFG.voidSureHit;      // a fresh cast re-arms the sure-hit
    this.prevVoid = env.domainOpen;
    this.voidOn = env.domainOpen && this.voidLeft > 0;
    if (this.voidOn) this.voidLeft -= dt;

    if (this.state === 'countdown' || this.state === 'intermission') {
      this.timer -= dt;
      if (this.timer <= 0) this.beginWave(this.wave + 1);
    } else if (this.state === 'wave') {
      this.spawnT -= dt;
      if (this.spawnT <= 0 && this.queue.length) { this.spawn(this.queue.shift()); this.spawnT = this.interval; }
      if (!this.queue.length && !this.curses.some(c => !c.dying)) this.clearWave();
    }
    for (const c of this.curses) this.updateCurse(c, dt, this.voidOn);
    prune(this.curses, c => !c.gone);
  }

  updateCurse(c, dt, voidOn) {
    const { W, H, u } = this.env;
    c.flash = Math.max(0, c.flash - dt*5);
    if (c.dying) { c.dying += dt; if (c.dying > .4) c.gone = true; return; }
    if (voidOn) { c.stun = Math.max(c.stun, .25); this.hit(c, CFG.voidDps*dt, true); if (c.dying) return; }
    c.stun = Math.max(0, c.stun - dt);
    if (!c.stun && this.active) c.z -= c.T.speed*c.speedMul*dt;
    c.z = Math.min(c.z, 1.25);
    const near = 1 - clamp(c.z, 0, 1), w = c.T.wander*u*.05, t = this.t;
    let x = lerp(c.ax, W/2, near*.3) + Math.sin(t*1.3 + c.ph)*w*(1 + near);
    let y = lerp(c.ay, H*.45, near*.3) + Math.cos(t*1.1 + c.ph*1.7)*w*.6*(1 + near);
    if (c.kind === 'fly') { x += Math.sin(t*7 + c.ph*3)*w*.5; y += Math.sin(t*9 + c.ph)*w*.3; }   // buzzing
    c.x = x; c.y = y;
    c.R = u*c.T.size/(1 + CFG.perspective*Math.max(0, c.z));
    if (c.z <= 0) this.strike(c);
  }

  strike(c) {
    const { fx, sound } = this.world;
    c.gone = true; this.combo = 0; this.hurtT = .7;
    this.lives -= c.T.damage || 1;
    sound.shot('hurt');
    fx.kick({ shake:1.1, flash:.25, impact:.06, at:{ x:c.x, y:c.y }, tint:{ rgb:'150,0,25', a:1 } });
    if (this.lives <= 0) { this.lives = 0; this.gameOver(); }
  }

  hit(c, dmg, quiet = false) {
    if (c.dying || c.gone) return;
    c.hp -= dmg;
    if (!quiet) { c.flash = 1; if (this.hitSfxT <= 0) { this.world.sound.shot('curseHit'); this.hitSfxT = .06; } }
    if (c.hp <= 0) this.kill(c);
  }

  kill(c) {
    const { fx, sound } = this.world, T = c.T, { u } = this.env;
    c.dying = .001; this.kills++; this.combo++; this.comboT = CFG.comboWindow;
    const mult = Math.min(4, 1 + Math.floor((this.combo - 1)/3)*.5), clutch = c.z < .15 ? 1.5 : 1;
    const pts = Math.round(T.score*mult*clutch);
    this.score += pts;
    this.popups.push({ x:c.x, y:c.y - c.R, text:`+${pts}`, sub:clutch > 1 ? 'CLUTCH' : mult > 1 ? `×${mult}` : '', t:0, life:1.1, size:T.boss ? u*.07 : u*.04 });
    fx.burst(c.x, c.y, '170,90,255', T.boss ? 140 : 34, 80, 520, { streak:.04 });
    fx.burst(c.x, c.y, '255,255,255', T.boss ? 30 : 10, 40, 220, { streak:0 });
    fx.wave(c.x, c.y, '205,160,255', c.R*3, { life:.5 });
    sound.shot('curseDie');
    if (T.boss) { fx.kick({ shake:.9, flash:.6, impact:.08, at:c }); fx.title('祓', c.x, c.y, '#ff7a2a', u*.2, { sub:'EXORCISED', life:1.4 }); }
  }

  /* ---------- API for the techniques ---------- */
  alive() { return this.active ? this.curses.filter(c => !c.dying) : []; }
  hitTest(x, y, r) { return this.alive().some(c => Math.hypot(c.x - x, c.y - y) < r + c.R*.8); }
  damageCircle(x, y, r, dmg, { push = 0 } = {}) {
    let n = 0;
    for (const c of this.alive()) {
      const d = Math.hypot(c.x - x, c.y - y), reach = r + c.R*.8;
      if (d < reach) { this.hit(c, dmg); if (push) c.z += push*(1 - d/reach); n++; }
    }
    return n;
  }
  damageSegment(x0, y0, x1, y1, r, dmg) {
    let n = 0;
    for (const c of this.alive()) if (segDist(c.x, c.y, x0, y0, x1, y1) < r + c.R*.8) { this.hit(c, dmg); n++; }
    return n;
  }
  pull(x, y, radius, k, dt) {
    for (const c of this.alive()) {
      if (Math.hypot(c.x - x, c.y - y) > radius) continue;
      c.ax += (x - c.x)*k*dt; c.ay += (y - c.y)*k*dt; c.stun = Math.max(c.stun, .15);
    }
  }

  hud() {
    return { state:this.state, wave:this.wave, score:this.score, best:this.best, newBest:this.newBest, lives:this.lives, maxLives:CFG.lives,
             combo:this.combo, mult:Math.min(4, 1 + Math.floor(Math.max(0, this.combo - 1)/3)*.5), kills:this.kills,
             voidLeft:this.voidOn ? this.voidLeft : 0 };
  }

  /* ---------- rendering ---------- */
  /** Curses, far ones first. Drawn before the technique washes so they get bathed in the colour too. */
  render(ctx) {
    if (!this.curses.length) return;
    const list = [...this.curses].sort((a, b) => b.z - a.z), focus = this.env.focus;
    for (const c of list) {
      const k = c.dying ? 1 - c.dying/.4 : 1;
      ctx.save(); ctx.translate(c.x, c.y);
      if (c.dying) { ctx.globalAlpha = clamp(k, 0, 1); const s = 1 + (1 - k)*.6; ctx.scale(s, s*.85); }
      else if (c.stun > 0) ctx.translate(rand(-1, 1)*c.R*.03, rand(-1, 1)*c.R*.03);
      aura(ctx, c.R, this.t + c.ph, c.seed);
      const look = { x:clamp((focus.x - c.x)/(c.R*6), -1, 1), y:clamp((focus.y - c.y)/(c.R*6), -1, 1) };
      if (c.flash > 0 && 'filter' in ctx) ctx.filter = `brightness(${1 + 2.5*c.flash}) saturate(${1 - .8*c.flash})`;   // hit: the silhouette flashes white
      c.T.draw(ctx, c.R, this.t + c.ph, look, c);
      ctx.restore();
      if (c.dying) continue;
      if (this.voidOn) voidStatic(ctx, c, this.t);
      if (c.z < .3) {                                                   // about to hit: pulsing warning ring
        const a = (1 - c.z/.3)*(.55 + .45*Math.sin(this.t*22));
        ctx.save(); ctx.strokeStyle = `rgba(255,40,60,${a})`; ctx.lineWidth = Math.max(2, c.R*.05);
        ctx.setLineDash([c.R*.12, c.R*.08]); ctx.beginPath(); ctx.arc(c.x, c.y, c.R*1.45, this.t*2, this.t*2 + TAU); ctx.stroke(); ctx.restore();
      }
      if (c.T.boss) {
        const w = c.R*1.6, y = c.y + c.R*1.35;
        ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(c.x - w/2, y, w, 5);
        ctx.fillStyle = '#ff7a2a'; ctx.shadowColor = '#ff7a2a'; ctx.shadowBlur = 8; ctx.fillRect(c.x - w/2, y, w*clamp(c.hp/c.max, 0, 1), 5); ctx.restore();
      }
    }
  }
  /** Score popups + the red edge when you get hit. Drawn on top of everything. */
  renderOverlay(ctx, W, H) {
    if (this.hurtT > 0) {
      const g = ctx.createRadialGradient(W/2, H/2, Math.min(W, H)*.3, W/2, H/2, Math.hypot(W, H)*.6);
      g.addColorStop(0, 'rgba(160,0,20,0)'); g.addColorStop(1, `rgba(160,0,20,${.75*this.hurtT/.7})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    for (const p of this.popups) {
      const a = p.t < .1 ? p.t/.1 : 1 - Math.max(0, (p.t - .5)/(p.life - .5));
      ctx.save(); ctx.globalAlpha = clamp(a, 0, 1); ctx.textAlign = 'center';
      ctx.font = `500 ${p.size}px ${CFG.latin}`; ctx.fillStyle = '#fff'; ctx.shadowColor = '#a060ff'; ctx.shadowBlur = 14;
      ctx.fillText(p.text, p.x, p.y);
      if (p.sub) { ctx.font = `500 ${p.size*.45}px ${CFG.latin}`; ctx.fillStyle = '#e6d2ff'; ctx.fillText(p.sub, p.x, p.y + p.size*.6); }
      ctx.restore();
    }
  }
}

/* =============================================================================
   CURSE DESIGNS: body horror
   Drawn around (0, 0) in units of R. Asymmetric silhouettes, limbs built from
   tapered bones, too many eyes and mouths. Ink outlines "boil" (re-jittered 8×/s,
   like hand-redrawn animation frames), one cel shadow with manga hatching.
   `look` (−1..1) aims the pupils at your hand.
   ============================================================================= */
const INK = '#0b0809';
const SKIN = { pale:'#c4b8a6', mid:'#a29282', shade:'#5c4c47', dark:'#2b2027', deep:'#140c11', bone:'#cdbb9c', boneShade:'#7d6a58' };
const rrect = (ctx, x, y, w, h, r) => ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
const add = (p, a, len) => [p[0] + Math.cos(a)*len, p[1] + Math.sin(a)*len];

/** Smooth path through points (quadratic through midpoints). */
function smooth(ctx, pts, closed = true) {
  const n = pts.length, mid = (a, b) => [(a[0] + b[0])/2, (a[1] + b[1])/2];
  ctx.beginPath();
  if (closed) {
    const s = mid(pts[n - 1], pts[0]); ctx.moveTo(s[0], s[1]);
    for (let i = 0; i < n; i++) { const q = mid(pts[i], pts[(i + 1) % n]); ctx.quadraticCurveTo(pts[i][0], pts[i][1], q[0], q[1]); }
    ctx.closePath();
  } else {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n - 1; i++) { const q = mid(pts[i], pts[i + 1]); ctx.quadraticCurveTo(pts[i][0], pts[i][1], q[0], q[1]); }
    ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
  }
}
/** Hand-drawn boil: outline points jitter a little, re-seeded 8×/s. */
function boil(pts, amt, t, seed) {
  const r = mulberry(seed*31 + Math.floor(t*8));
  return pts.map(([x, y]) => [x + (r() - .5)*amt, y + (r() - .5)*amt]);
}
/** Outline of a tapered limb along a centre line; widths per point, rounded tip. */
function taper(pts, w) {
  const n = pts.length, L = [], Rt = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const nx = -dy/l*w[i]/2, ny = dx/l*w[i]/2;
    L.push([pts[i][0] + nx, pts[i][1] + ny]); Rt.push([pts[i][0] - nx, pts[i][1] - ny]);
  }
  const e = pts[n - 1], d = pts[n - 2], dl = Math.hypot(e[0] - d[0], e[1] - d[1]) || 1;
  return [...L, [e[0] + (e[0] - d[0])/dl*w[n - 1]*.55, e[1] + (e[1] - d[1])/dl*w[n - 1]*.55], ...Rt.reverse()];
}
/** Lumpy organic outline: seeded radius profile, stretched, with an optional bulge. */
function lump(seed, R, { sx = 1, sy = 1, cx = 0, cy = 0, n = 20, bulge = null, t = 0 } = {}) {
  const r = mulberry(seed), prof = Array.from({ length:n }, () => .84 + r()*.3);
  return prof.map((v, i) => {
    const a = i/n*TAU; let rad = v*(1 + .025*Math.sin(t*2.5 + i*1.7));
    if (bulge) rad *= 1 + bulge[1]*Math.max(0, Math.cos(a - bulge[0]))**2;
    return [cx*R + Math.cos(a)*rad*R*sx, cy*R + Math.sin(a)*rad*R*sy];
  });
}
/** Fill + cel shadow (+ hatching) + heavy boiling ink line with a rough second pass. */
function inked(ctx, pts, R, t, seed, { fill, shade, hatch = 0, lw = .045, rough = true } = {}) {
  const p = boil(pts, R*.018, t, seed);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const w = x1 - x0, h = y1 - y0;
  ctx.save();
  smooth(ctx, p); ctx.fillStyle = fill; ctx.fill();
  if (shade) {
    ctx.save(); ctx.clip();
    ctx.fillStyle = shade; ctx.beginPath(); ctx.ellipse(x0 + w*.82, y0 + h*.86, w*.78, h*.68, -.3, 0, TAU); ctx.fill();
    if (hatch) {
      ctx.strokeStyle = 'rgba(11,8,9,.42)'; ctx.lineWidth = Math.max(.7, R*.012); ctx.lineCap = 'round';
      const r = mulberry(seed + 99);
      for (let i = 0; i < hatch; i++) {
        const hx = x0 + w*(.5 + r()*.45), hy = y0 + h*(.5 + r()*.42), l = Math.min(w, h)*(.08 + r()*.08);
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - l*.7, hy + l); ctx.stroke();
      }
    }
    ctx.restore();
  }
  ctx.strokeStyle = INK; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.3, R*lw);
  smooth(ctx, p); ctx.stroke();
  if (rough) { ctx.globalAlpha *= .55; ctx.lineWidth = Math.max(.7, R*lw*.35); smooth(ctx, boil(pts, R*.035, t, seed + 5)); ctx.stroke(); }
  ctx.restore();
}
/** Jointed chain from a base point: segs = [[turn, length], …]. */
function chain(base, ang, segs) {
  const pts = [base]; let p = base;
  for (const [da, len] of segs) { ang += da; p = add(p, ang, len); pts.push(p); }
  return pts;
}
/** Long-fingered hand. curl 0 = spread, 1 = clawing. side flips which way the fingers curl. */
function hand(ctx, at, ang, s, curl, t, seed, { fill = SKIN.mid, shade = SKIN.shade, side = 1, nails = true } = {}) {
  const spread = [-.55, -.2, .15, .48];
  spread.forEach((sp, i) => {
    const base = add(at, ang + sp, s*.22), bend = side*curl*.75;
    const pts = chain(base, ang + sp*1.3, [[0, s*.42*(i === 1 || i === 2 ? 1.1 : .9)], [bend, s*.3], [bend, s*.22]]);
    inked(ctx, taper(pts, [s*.17, s*.145, s*.12, s*.08]), s, t, seed + i, { fill, shade, lw:.045 });
    if (nails) { const tip = pts[3]; ctx.fillStyle = '#5e4642'; ctx.beginPath(); ctx.arc(tip[0], tip[1], s*.045, 0, TAU); ctx.fill(); }
  });
  const thumb = chain(add(at, ang - side*1.3, s*.14), ang - side*1.0, [[0, s*.3], [side*curl*.6, s*.22]]);
  inked(ctx, taper(thumb, [s*.18, s*.14, s*.09]), s, t, seed + 9, { fill, shade, lw:.045 });
  inked(ctx, lump(seed + 3, s*.32, { cx:at[0]/(s*.32), cy:at[1]/(s*.32), n:9, t }), s, t, seed + 4, { fill, shade, lw:.045 });
}
/** Two-bone arm (shoulder → elbow → wrist) ending in a hand. */
function arm(ctx, sh, el, wr, w, R, t, seed, o = {}) {
  inked(ctx, taper([sh, el, wr], [w, w*.72, w*.5]), R, t, seed, { fill:o.fill || SKIN.mid, shade:o.shade || SKIN.shade, hatch:3 });
  const a = Math.atan2(wr[1] - el[1], wr[0] - el[0]);
  hand(ctx, wr, a, o.hand || R*.4, o.curl ?? .4, t, seed + 20, { fill:o.fill || SKIN.mid, shade:o.shade || SKIN.shade, side:o.side || 1 });
}
/** Sunken, bloodshot eye. iris colour, blink 0..1, slit pupil option. */
function eye(ctx, x, y, r, look, iris, blink = 0, { slit = false, seed = 1, glow = false } = {}) {
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = 'rgba(30,12,18,.55)'; ctx.beginPath(); ctx.ellipse(0, r*.08, r*1.28, r*1.05, 0, 0, TAU); ctx.fill();   // socket
  ctx.scale(1, Math.max(.05, 1 - blink));
  ctx.fillStyle = '#e4d8b8'; ctx.beginPath(); ctx.ellipse(0, 0, r, r*.8, 0, 0, TAU); ctx.fill();
  ctx.save(); ctx.clip();
  const rnd = mulberry(seed);
  ctx.strokeStyle = 'rgba(170,20,30,.65)'; ctx.lineWidth = Math.max(.6, r*.05);   // veins creeping in from the rim
  for (let i = 0; i < 7; i++) {
    const a = rnd()*TAU; let px = Math.cos(a)*r, py = Math.sin(a)*r*.8;
    ctx.beginPath(); ctx.moveTo(px, py);
    for (let k = 0; k < 3; k++) { px *= .78; py *= .78; px += (rnd() - .5)*r*.25; py += (rnd() - .5)*r*.25; ctx.lineTo(px, py); }
    ctx.stroke();
  }
  const px = look.x*r*.38, py = look.y*r*.28;
  if (glow) { ctx.fillStyle = iris; ctx.shadowColor = iris; ctx.shadowBlur = r*.8; }
  ctx.fillStyle = iris; ctx.beginPath(); ctx.arc(px, py, r*.42, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
  ctx.fillStyle = '#000'; ctx.beginPath();
  if (slit) ctx.ellipse(px, py, r*.08, r*.36, 0, 0, TAU); else ctx.arc(px, py, r*.16, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(px - r*.14, py - r*.15, r*.07, 0, TAU); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1, r*.13); ctx.beginPath(); ctx.ellipse(0, 0, r, r*.8, 0, 0, TAU); ctx.stroke();
  ctx.restore();
}
const blinkAt = (t, ph) => Math.pow(Math.max(0, Math.sin(t*.7 + ph*5)), 40);
/** A gash of a mouth: lens between two smooth lips, dark inside, teeth on both edges. */
function gash(ctx, c0, c1, open, R, t, seed, { inside = '#3a0610', nTeeth = 7, toothH = .12, glow = null } = {}) {
  const mx = (c0[0] + c1[0])/2, my = (c0[1] + c1[1])/2, dx = c1[0] - c0[0], dy = c1[1] - c0[1], l = Math.hypot(dx, dy) || 1;
  const nx = -dy/l, ny = dx/l, o = open*R;
  const top = [c0, [mx - nx*o, my - ny*o], c1], bot = [c1, [mx + nx*o, my + ny*o], c0];
  const path = () => { ctx.beginPath(); ctx.moveTo(c0[0], c0[1]); ctx.quadraticCurveTo(top[1][0], top[1][1], c1[0], c1[1]); ctx.quadraticCurveTo(bot[1][0], bot[1][1], c0[0], c0[1]); ctx.closePath(); };
  ctx.save();
  path(); ctx.fillStyle = inside; ctx.fill();
  ctx.save(); ctx.clip();
  if (glow) { const g = ctx.createRadialGradient(mx, my, 0, mx, my, l*.5); g.addColorStop(0, glow); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(mx - l, my - l, l*2, l*2); }
  const q = (p0, p1, p2, k) => [(1 - k)**2*p0[0] + 2*(1 - k)*k*p1[0] + k*k*p2[0], (1 - k)**2*p0[1] + 2*(1 - k)*k*p1[1] + k*k*p2[1]];
  const r = mulberry(seed);
  ctx.fillStyle = '#e2d8be'; ctx.strokeStyle = INK; ctx.lineWidth = Math.max(.7, R*.012);
  for (const [edge, sgn] of [[top, 1], [bot, -1]]) {
    for (let i = 0; i < nTeeth; i++) {
      const k = (i + .5)/nTeeth, p = q(edge[0], edge[1], edge[2], k), len = R*toothH*(.55 + r()*.7)*Math.sin(Math.PI*k), w = l/nTeeth*.85;
      ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(Math.atan2(ny*sgn, nx*sgn) - Math.PI/2);
      ctx.beginPath(); rrect(ctx, -w/2, -len*.2, w, len, w*.4); ctx.fill(); ctx.stroke(); ctx.restore();
    }
  }
  ctx.restore();
  path(); ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.2, R*.035); ctx.stroke();
  ctx.restore();
}

/** Dark smoke + licking purple-black flames, re-seeded at 10 fps ("on twos"). */
function aura(ctx, R, t, seed) {
  const rnd = mulberry(Math.floor(t*10)*131 + seed);
  ctx.save();
  const g = ctx.createRadialGradient(0, 0, R*.3, 0, 0, R*1.9);
  g.addColorStop(0, 'rgba(12,0,20,.55)'); g.addColorStop(1, 'rgba(12,0,20,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R*1.9, 0, TAU); ctx.fill();
  for (let i = 0; i < 10; i++) {
    const a = rnd()*TAU, len = R*(.35 + rnd()*.7), bx = Math.cos(a)*R*.75, by = Math.sin(a)*R*.7;
    const tx = bx + Math.cos(a)*len*.5 + (rnd() - .5)*R*.3, ty = by + Math.sin(a)*len*.3 - len*.75, side = R*.1;
    ctx.fillStyle = `rgba(${rnd() < .3 ? '70,10,90' : '30,0,45'},.55)`; ctx.beginPath();
    ctx.moveTo(bx - Math.sin(a)*side, by + Math.cos(a)*side);
    ctx.quadraticCurveTo((bx + tx)/2 + side, (by + ty)/2, tx, ty);
    ctx.quadraticCurveTo((bx + tx)/2 - side, (by + ty)/2, bx + Math.sin(a)*side, by - Math.cos(a)*side);
    ctx.fill();
  }
  ctx.restore();
}

/* ---- 蠅頭 Fly Head: a bloated human-ish head on insect legs, one huge bloodshot eye, torn wings ---- */
function drawFly(ctx, R, t, look, c) {
  const s = c.seed, flap = Math.sin(t*46 + c.ph)*.5;
  for (const side of [-1, 1]) {                                          // torn, veined wings
    ctx.save(); ctx.translate(side*R*.2, -R*.5); ctx.rotate(side*(-.4 + flap*.7));
    const wing = [[0, 0], [side*.45, -.38], [side*.95, -.36], [side*1.12, -.12], [side*.9, -.02], [side*1.02, .14], [side*.62, .18], [side*.5, .06], [side*.3, .14]].map(([x, y]) => [x*R, y*R]);
    smooth(ctx, wing); ctx.fillStyle = 'rgba(196,204,186,.3)'; ctx.fill();
    ctx.strokeStyle = 'rgba(11,8,9,.75)'; ctx.lineWidth = Math.max(.8, R*.02); ctx.stroke();
    ctx.beginPath(); for (const k of [2, 3, 5]) { ctx.moveTo(0, 0); ctx.lineTo(wing[k][0]*.85, wing[k][1]*.85); } ctx.stroke();
    ctx.restore();
  }
  for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {             // jointed insect legs ending in little fingers
    const tw = Math.sin(t*11 + i*2.1 + side)*R*.05;
    const hip = [side*R*.28, R*(.25 + i*.1)], knee = [side*R*(.78 + i*.06), R*(-.08 + i*.2) + tw], foot = [side*R*(.92 + i*.08), R*(.8 + i*.12)];
    inked(ctx, taper([hip, knee, foot], [R*.1, R*.07, R*.035]), R, t, s + i*7 + (side > 0 ? 3 : 0), { fill:SKIN.dark, lw:.035, rough:false });
  }
  const head = lump(s, R*.72, { sx:1.05, sy:.92, bulge:[3.6, .25], t });
  inked(ctx, head, R, t, s, { fill:'#aaa58c', shade:'#5d5947', hatch:5 });
  eye(ctx, -R*.17, -R*.1, R*.36, look, '#b39d22', blinkAt(t, c.ph), { seed:s + 1 });
  eye(ctx, R*.4, -R*.34, R*.1, look, '#b39d22', blinkAt(t, c.ph + 2), { seed:s + 2 });
  gash(ctx, [-R*.38, R*.34], [R*.42, R*.24], .05 + .05*Math.abs(Math.sin(t*3)), R, t, s + 3, { nTeeth:6, toothH:.07 });
}

/* ---- 腕塊 Arm Knot: a hunched lump of flesh that is mostly human arms, grabbing at you ---- */
function drawArms(ctx, R, t, look, c) {
  const s = c.seed;
  const ARMS = [[-.42, -.12, -2.55, 1], [-.18, -.38, -1.95, 1], [.22, -.36, -1.2, -1], [.48, -.05, -.6, -1], [-.45, .35, 2.6, -1]];
  ARMS.forEach(([rx, ry, a, side], i) => {
    const sway = Math.sin(t*1.7 + i*1.9)*.22, sh = [rx*R, ry*R];
    const el = add(sh, a + sway*.4, R*.55), wr = add(el, a - side*.55 + sway, R*.48);
    arm(ctx, sh, el, wr, R*.25, R, t, s + i*13, { hand:R*.46, curl:.45 + .45*Math.sin(t*2.4 + i*1.3), side });
  });
  const body = lump(s + 1, R*.62, { sx:1.15, sy:.85, cy:.28, bulge:[2.2, .2], t });
  inked(ctx, body, R, t, s + 1, { fill:SKIN.pale, shade:SKIN.shade, hatch:8 });
  eye(ctx, -R*.28, R*.08, R*.15, look, '#9fb43a', blinkAt(t, 1), { seed:s + 5 });
  eye(ctx, R*.03, -R*.02, R*.22, look, '#c9861c', blinkAt(t, 2), { seed:s + 6 });
  eye(ctx, R*.32, R*.12, R*.11, look, '#9fb43a', blinkAt(t, 3), { seed:s + 7 });
  eye(ctx, R*.15, R*.33, R*.07, look, '#c9861c', blinkAt(t, 4), { seed:s + 8 });
  gash(ctx, [-R*.12, R*.3], [-R*.1, R*.62], .05 + .06*(.5 + .5*Math.sin(t*2.2)), R, t, s + 9, { nTeeth:5, toothH:.06 });   // vertical mouth
}

/* ---- 裂口 Split Face: an emaciated figure on a bent neck; its face is one vertical mouth, eyes sewn shut ---- */
function drawSplit(ctx, R, t, look, c) {
  const s = c.seed, sway = Math.sin(t*1.1 + c.ph)*.07;
  for (const side of [-1, 1]) {                                          // long hanging arms
    const sh = [side*R*.27, -R*.1], el = [side*R*(.6 + .04*Math.sin(t*1.3 + side)), R*.34], wr = [side*R*.5, R*.8];
    arm(ctx, sh, el, wr, R*.17, R, t, s + (side > 0 ? 40 : 50), { fill:SKIN.pale, hand:R*.42, curl:.25 + .2*Math.sin(t*1.8 + side), side:-side });
  }
  const torso = [[-.3, -.2], [-.05, -.26], [.3, -.22], [.25, .18], [.16, .52], [.22, .96], [-.2, 1.0], [-.15, .55], [-.24, .18]].map(([x, y]) => [x*R, y*R]);
  inked(ctx, torso, R, t, s, { fill:SKIN.pale, shade:SKIN.shade, hatch:4 });
  ctx.save(); ctx.strokeStyle = 'rgba(11,8,9,.55)'; ctx.lineWidth = Math.max(.8, R*.018); ctx.lineCap = 'round';   // ribs
  for (let i = 0; i < 4; i++) { const y = R*(-.02 + i*.12); ctx.beginPath(); ctx.moveTo(-R*.2, y); ctx.quadraticCurveTo(0, y + R*.06, R*.19, y - R*.01); ctx.stroke(); }
  ctx.restore();
  const hx = R*(.2 + sway), hy = -R*.8;
  inked(ctx, taper([[0, -R*.18], [R*.08, -R*.42], [hx - R*.04, hy + R*.24]], [R*.16, R*.12, R*.12]), R, t, s + 2, { fill:SKIN.pale, shade:SKIN.shade });
  const head = lump(s + 3, R*.4, { sx:.9, sy:1.1, cx:hx/(R*.4), cy:hy/(R*.4), n:16, t });
  inked(ctx, head, R, t, s + 3, { fill:SKIN.pale, shade:SKIN.shade, hatch:3 });
  ctx.save(); ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1, R*.022); ctx.lineCap = 'round';   // sewn-shut eyes
  for (const side of [-1, 1]) {
    const ex = hx + side*R*.19, ey = hy - R*.1;
    ctx.beginPath(); ctx.moveTo(ex - R*.08, ey); ctx.quadraticCurveTo(ex, ey + R*.04, ex + R*.08, ey); ctx.stroke();
    for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(ex + k*R*.05 - R*.015, ey - R*.04); ctx.lineTo(ex + k*R*.05 + R*.015, ey + R*.06); ctx.stroke(); }
  }
  ctx.restore();
  gash(ctx, [hx + R*.01, hy - R*.38], [hx - R*.02, hy + R*.34], .1 + .12*(.5 + .5*Math.sin(t*1.9)), R, t, s + 4, { nTeeth:8, toothH:.09 });
  ctx.save(); ctx.strokeStyle = 'rgba(210,220,230,.55)'; ctx.lineWidth = Math.max(.8, R*.015);   // drool
  const d = (t*.5) % 1; ctx.beginPath(); ctx.moveTo(hx, hy + R*.34); ctx.lineTo(hx + R*.01, hy + R*.34 + R*.4*d); ctx.stroke(); ctx.restore();
}

/* ---- 指持ち Finger Bearer: the boss. A hunched mass with fingers for spines, a jaw across its body, eyes clustered off-centre ---- */
function drawBearer(ctx, R, t, look, c) {
  const s = c.seed, pulse = .55 + .45*Math.sin(t*3);
  for (let i = 0; i < 6; i++) {                                          // fingers growing out of its back
    const a = -2.55 + i*.38, root = [Math.cos(a)*R*.7, Math.sin(a)*R*.55 + R*.05], sway = Math.sin(t*1.4 + i)*.08;
    const pts = chain(root, a + sway, [[0, R*.32], [.25 + sway, R*.26], [.3, R*.18]]);
    inked(ctx, taper(pts, [R*.14, R*.12, R*.1, R*.07]), R, t, s + i*5, { fill:SKIN.bone, shade:SKIN.boneShade, lw:.035 });
    const tip = pts[3]; ctx.fillStyle = '#7e625c'; ctx.beginPath(); ctx.arc(tip[0], tip[1], R*.035, 0, TAU); ctx.fill();
  }
  const sw = Math.sin(t*1.5)*.12;
  arm(ctx, [-R*.62, -R*.02], [-R*1.02, -R*.38], [-R*(1.08 + sw*.3), -R*(.78 + sw*.2)], R*.26, R, t, s + 60,   // raised claw
      { fill:SKIN.dark, shade:SKIN.deep, hand:R*.55, curl:.6 + .3*Math.sin(t*2), side:1 });
  arm(ctx, [R*.6, R*.18], [R*.98, R*.45], [R*1.04, R*.86], R*.26, R, t, s + 70,                                 // planted arm
      { fill:SKIN.dark, shade:SKIN.deep, hand:R*.5, curl:.15, side:-1 });
  const body = lump(s + 1, R*.9, { sx:1.0, sy:.84, cy:.12, bulge:[-.9, .15], t });
  inked(ctx, body, R, t, s + 1, { fill:SKIN.dark, shade:SKIN.deep, hatch:10, lw:.04 });
  const r = mulberry(s + 11);                                            // glowing cracks
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    let x = (r() - .5)*R*1.1, y = (r() - .3)*R*1.0; const pts = [[x, y]];
    for (let j = 0; j < 4; j++) { x += (r() - .5)*R*.3; y += (r() - .3)*R*.25; pts.push([x, y]); }
    for (const [w, al] of [[R*.05, .22], [R*.016, .85]]) {
      ctx.strokeStyle = `rgba(255,${w > R*.03 ? 90 : 160},40,${al*pulse})`; ctx.lineWidth = Math.max(1, w);
      ctx.beginPath(); pts.forEach(([px, py], k) => k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.stroke();
    }
  }
  ctx.restore();
  eye(ctx, -R*.32, -R*.28, R*.17, look, '#ff6a1a', blinkAt(t, 1), { seed:s + 21, glow:true });
  eye(ctx, -R*.06, -R*.42, R*.12, look, '#ff8a1a', blinkAt(t, 2), { seed:s + 22, glow:true });
  eye(ctx, R*.2, -R*.24, R*.21, look, '#ff6a1a', blinkAt(t, 3), { seed:s + 23, glow:true, slit:true });
  eye(ctx, -R*.5, -R*.02, R*.08, look, '#ffa21a', blinkAt(t, 4), { seed:s + 24, glow:true });
  gash(ctx, [-R*.58, R*.3], [R*.6, R*.22], .14 + .14*(.5 + .5*Math.sin(t*1.3)), R, t, s + 30,
       { nTeeth:11, toothH:.16, inside:'#1a0402', glow:`rgba(255,110,30,${.7*pulse})` });
}

/** Inside Unlimited Void: the curse is frozen, flooded with information. Horizontal glitch slices. */
function voidStatic(ctx, c, t) {
  const rnd = mulberry(Math.floor(t*14)*97 + c.seed);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) {
    const y = c.y + (rnd() - .5)*c.R*1.8, w = c.R*(.6 + rnd()*1.4), x = c.x + (rnd() - .5)*c.R*.8 - w/2;
    ctx.fillStyle = `rgba(${rnd() < .5 ? '180,200,255' : '255,255,255'},${.25 + rnd()*.35})`;
    ctx.fillRect(x, y, w, Math.max(1, c.R*.02 + rnd()*c.R*.03));
  }
  ctx.restore();
}

