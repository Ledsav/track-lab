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
  eyes:   { kanji:'目玉',   en:'Eye Cluster',    hp:3,  score:120,  size:.13,  speed:.11, wander:.45, draw:drawEyes },
  mouth:  { kanji:'大口',   en:'Grinning Mouth', hp:5,  score:180,  size:.14,  speed:.09, wander:.3,  draw:drawMouth },
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
      q.push(n >= 3 && r < Math.min(.35, .12 + n*.03) ? 'mouth' : n >= 2 && r < .55 ? 'eyes' : 'fly');
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
      c.T.draw(ctx, c.R, this.t + c.ph, look, c);
      if (c.flash > 0) {
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = c.flash*.65; ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(0, 0, c.R*.9, 0, TAU); ctx.fill();
      }
      ctx.restore();
      if (c.dying) continue;
      if (this.voidOn) voidStatic(ctx, c, this.t);
      if (c.z < .3) {                                                   // about to hit: pulsing warning ring
        const a = (1 - c.z/.3)*(.55 + .45*Math.sin(this.t*22));
        ctx.save(); ctx.strokeStyle = `rgba(255,40,60,${a})`; ctx.lineWidth = Math.max(2, c.R*.05);
        ctx.beginPath(); ctx.arc(c.x, c.y, c.R*1.35, 0, TAU); ctx.stroke(); ctx.restore();
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
   CURSE DESIGNS
   All drawn around (0, 0) with radius R: thick ink outline, flat cel fills, one
   shadow tone, flickering cursed-energy smoke. `look` (−1..1) aims the pupils at your hand.
   ============================================================================= */
const INK = '#0c0a0b';
const lw = R => Math.max(1.5, R*.055);
const rrect = (ctx, x, y, w, h, r) => ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);

/** Dark smoke + licking purple-black flames, re-seeded at 10 fps ("on twos"). */
function aura(ctx, R, t, seed) {
  const rnd = mulberry(Math.floor(t*10)*131 + seed);
  ctx.save();
  const g = ctx.createRadialGradient(0, 0, R*.4, 0, 0, R*2);
  g.addColorStop(0, 'rgba(12,0,22,.6)'); g.addColorStop(1, 'rgba(12,0,22,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R*2, 0, TAU); ctx.fill();
  for (let i = 0; i < 9; i++) {
    const a = rnd()*TAU, len = R*(.35 + rnd()*.7), bx = Math.cos(a)*R*.8, by = Math.sin(a)*R*.8;
    const tx = bx + Math.cos(a)*len*.6 + (rnd() - .5)*R*.3, ty = by + Math.sin(a)*len*.4 - len*.7, side = R*.12;
    ctx.fillStyle = 'rgba(38,0,58,.6)'; ctx.beginPath();
    ctx.moveTo(bx - Math.sin(a)*side, by + Math.cos(a)*side);
    ctx.quadraticCurveTo((bx + tx)/2 + side, (by + ty)/2, tx, ty);
    ctx.quadraticCurveTo((bx + tx)/2 - side, (by + ty)/2, bx + Math.sin(a)*side, by - Math.cos(a)*side);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = 'rgba(150,60,230,.28)'; ctx.lineWidth = Math.max(1, R*.025);
  ctx.beginPath(); ctx.arc(0, 0, R*1.08, 0, TAU); ctx.stroke();
  ctx.restore();
}

/** Seeded lumpy outline, cached on the curse. */
function profile(c, n = 24) {
  if (!c.prof) { const r = mulberry(c.seed); const raw = Array.from({ length:n }, () => .82 + r()*.36); c.prof = raw.map((v, i) => (raw[(i + n - 1) % n] + v*2 + raw[(i + 1) % n])/4); }
  return c.prof;
}
function blobPath(ctx, R, prof, t, sx = 1, sy = 1) {
  const n = prof.length; ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = i/n*TAU, r = R*prof[i % n]*(1 + .035*Math.sin(t*3 + i*1.3));
    const x = Math.cos(a)*r*sx, y = Math.sin(a)*r*sy;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}
/** One eye: sclera, iris, pupil aimed by look; blink 0 (open) … 1 (shut). */
function eye(ctx, x, y, r, look, iris, blink = 0, slit = false) {
  ctx.save(); ctx.translate(x, y); ctx.scale(1, Math.max(.06, 1 - blink));
  ctx.fillStyle = '#f3ece0'; ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1, r*.14);
  ctx.beginPath(); ctx.ellipse(0, 0, r, r*.78, 0, 0, TAU); ctx.fill();
  ctx.save(); ctx.clip();
  const px = look.x*r*.35, py = look.y*r*.25;
  ctx.fillStyle = iris; ctx.beginPath(); ctx.arc(px, py, r*.55, 0, TAU); ctx.fill();
  ctx.fillStyle = '#000'; ctx.beginPath();
  slit ? ctx.ellipse(px, py, r*.12, r*.48, 0, 0, TAU) : ctx.arc(px, py, r*.26, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.arc(px - r*.18, py - r*.2, r*.11, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(120,20,30,.25)'; ctx.fillRect(-r, r*.35, r*2, r);                  // shadow on the lower lid
  ctx.restore();
  ctx.beginPath(); ctx.ellipse(0, 0, r, r*.78, 0, 0, TAU); ctx.stroke();
  ctx.restore();
}
const blinkAt = (t, ph) => Math.pow(Math.max(0, Math.sin(t*.8 + ph*5)), 40);

/* ---- 蠅頭 Fly Head: the weakest grade, buzzing in swarms ---- */
function drawFly(ctx, R, t, look) {
  const flap = Math.sin(t*55)*.55;
  ctx.save(); ctx.lineWidth = Math.max(1, R*.03);                       // wings, motion-blurred
  for (const side of [-1, 1]) for (const k of [0, .4]) {
    ctx.save(); ctx.translate(side*R*.35, -R*.5); ctx.rotate(side*(-.5 + flap + k));
    ctx.fillStyle = `rgba(205,215,235,${k ? .18 : .32})`; ctx.strokeStyle = `rgba(235,240,255,${k ? .2 : .5})`;
    ctx.beginPath(); ctx.ellipse(side*R*.55, 0, R*.7, R*.24, 0, 0, TAU); ctx.fill(); ctx.stroke(); ctx.restore();
  }
  ctx.restore();
  ctx.save(); ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.2, R*.06); ctx.lineCap = 'round';   // dangling legs
  for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
    const sw = Math.sin(t*9 + i*2)*R*.06;
    ctx.beginPath(); ctx.moveTo(side*R*.35, R*.45 + i*R*.08);
    ctx.lineTo(side*R*(.65 + i*.12), R*(.7 + i*.1) + sw); ctx.lineTo(side*R*(.6 + i*.12), R*(1 + i*.1) + sw); ctx.stroke();
  }
  ctx.restore();
  // head
  const g = ctx.createRadialGradient(-R*.25, -R*.3, R*.1, 0, 0, R);
  g.addColorStop(0, '#8e9a6c'); g.addColorStop(.6, '#5a6544'); g.addColorStop(1, '#2c3322');
  ctx.fillStyle = g; ctx.strokeStyle = INK; ctx.lineWidth = lw(R);
  ctx.beginPath(); ctx.ellipse(0, 0, R*.82, R*.72, 0, 0, TAU); ctx.fill(); ctx.stroke();
  // huge compound eyes
  for (const side of [-1, 1]) {
    const ex = side*R*.4, ey = -R*.12;
    const eg = ctx.createRadialGradient(ex - side*R*.1, ey - R*.12, R*.03, ex, ey, R*.42);
    eg.addColorStop(0, '#ff6b5e'); eg.addColorStop(.55, '#b3121f'); eg.addColorStop(1, '#4a0309');
    ctx.fillStyle = eg; ctx.beginPath(); ctx.ellipse(ex, ey, R*.36, R*.42, side*.25, 0, TAU); ctx.fill();
    ctx.save(); ctx.clip(); ctx.fillStyle = 'rgba(0,0,0,.35)';         // facets
    for (let fx = -3; fx <= 3; fx++) for (let fy = -3; fy <= 3; fy++) { ctx.beginPath(); ctx.arc(ex + fx*R*.1 + (fy % 2)*R*.05, ey + fy*R*.1, R*.018, 0, TAU); ctx.fill(); }
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.arc(ex + look.x*R*.12, ey + look.y*R*.1, R*.12, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = INK; ctx.lineWidth = lw(R)*.8; ctx.beginPath(); ctx.ellipse(ex, ey, R*.36, R*.42, side*.25, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.ellipse(ex - side*R*.12, ey - R*.2, R*.07, R*.04, -.5, 0, TAU); ctx.fill();
  }
  // mandibles
  const m = Math.sin(t*12)*.15;
  ctx.strokeStyle = INK; ctx.lineWidth = lw(R); ctx.lineCap = 'round';
  for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo(side*R*.12, R*.45); ctx.quadraticCurveTo(side*R*(.28 + m), R*.7, side*R*.05, R*.82); ctx.stroke(); }
  // bristles
  ctx.lineWidth = Math.max(1, R*.025);
  for (let i = -3; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(i*R*.1, -R*.68); ctx.lineTo(i*R*.14, -R*.9 - Math.abs(i)*R*.02); ctx.stroke(); }
}

/* ---- 目玉 Eye Cluster: a bloated lump of flesh covered in mismatched staring eyes ---- */
function drawEyes(ctx, R, t, look, c) {
  const prof = profile(c);
  blobPath(ctx, R, prof, t, 1, .92);
  const g = ctx.createRadialGradient(-R*.3, -R*.35, R*.1, 0, 0, R*1.05);
  g.addColorStop(0, '#eadcca'); g.addColorStop(.55, '#bba08a'); g.addColorStop(1, '#6a4f42');
  ctx.fillStyle = g; ctx.fill();
  ctx.save(); ctx.clip();
  ctx.fillStyle = 'rgba(70,30,40,.28)'; ctx.beginPath(); ctx.ellipse(R*.2, R*.55, R*1.1, R*.55, -.2, 0, TAU); ctx.fill();   // cel shadow
  const r = mulberry(c.seed + 7);                                       // veins
  ctx.strokeStyle = 'rgba(150,25,40,.55)'; ctx.lineWidth = Math.max(1, R*.018);
  for (let i = 0; i < 6; i++) {
    let x = (r() - .5)*R*1.6, y = (r() - .5)*R*1.6; ctx.beginPath(); ctx.moveTo(x, y);
    for (let j = 0; j < 4; j++) { x += (r() - .5)*R*.5; y += (r() - .5)*R*.5; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  ctx.restore();
  blobPath(ctx, R, prof, t, 1, .92); ctx.strokeStyle = INK; ctx.lineWidth = lw(R); ctx.stroke();
  if (!c.eyes) {                                                         // scatter eyes without overlaps, biggest first
    const er = mulberry(c.seed + 3); c.eyes = [{ x:0, y:-R*.05, r:.3, ph:er()*9, iris:'#c9b21a' }];
    for (let tries = 0; c.eyes.length < 8 && tries < 200; tries++) {
      const a = er()*TAU, d = er()*.68, e = { x:Math.cos(a)*d*R, y:Math.sin(a)*d*R*.85, r:.1 + er()*.13, ph:er()*9, iris:er() < .5 ? '#8fc23b' : '#d0661c' };
      if (c.eyes.every(o => Math.hypot(o.x - e.x, o.y - e.y) > (o.r + e.r)*R*1.15)) c.eyes.push(e);
    }
    c.eyes.forEach(e => { e.x /= R; e.y /= R; });                      // store in R units so they scale with depth
  }
  for (const e of c.eyes) eye(ctx, e.x*R, e.y*R, e.r*R, look, e.iris, blinkAt(t, e.ph));
  // stitched mouth
  ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1, R*.035);
  ctx.beginPath(); ctx.moveTo(-R*.35, R*.62); ctx.quadraticCurveTo(0, R*.72, R*.35, R*.6); ctx.stroke();
  for (let i = -3; i <= 3; i++) { const x = i*R*.1, y = R*.66 + (1 - (i/3.5)**2)*R*.04; ctx.beginPath(); ctx.moveTo(x - R*.03, y - R*.06); ctx.lineTo(x + R*.03, y + R*.06); ctx.stroke(); }
}

/* ---- 大口 Grinning Mouth: ink-black body that is mostly a grin of human teeth ---- */
function drawMouth(ctx, R, t, look, c) {
  const prof = profile(c);
  // horns
  ctx.fillStyle = '#d9cdb5'; ctx.strokeStyle = INK; ctx.lineWidth = lw(R)*.8;
  for (const side of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(side*R*.35, -R*.7); ctx.quadraticCurveTo(side*R*.75, -R*1.1, side*R*.55, -R*1.35);
    ctx.quadraticCurveTo(side*R*.55, -R*1.0, side*R*.15, -R*.78); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  blobPath(ctx, R, prof, t, 1.05, .95);
  const g = ctx.createRadialGradient(-R*.3, -R*.4, R*.1, 0, 0, R*1.1);
  g.addColorStop(0, '#4a3858'); g.addColorStop(.6, '#241b2e'); g.addColorStop(1, '#100b15');
  ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = lw(R); ctx.stroke();
  ctx.strokeStyle = 'rgba(170,110,230,.45)'; ctx.lineWidth = Math.max(1, R*.025);   // rim light
  ctx.beginPath(); ctx.arc(0, 0, R*.93, -2.6, -1.2); ctx.stroke();
  // slit eye
  eye(ctx, 0, -R*.45, R*.22, look, '#f2c822', blinkAt(t, c.ph), true);
  // the grin: corners up, chewing
  const open = .45 + .3*(.5 + .5*Math.sin(t*2.4)), w = R*1.3, h = R*.55*open;
  const top = u => -R*.02 + lerp(-h*.35, 0, 1 - u*u), bot = u => -R*.02 + lerp(-h*.35, h, 1 - u*u);
  const path = () => {
    ctx.beginPath();
    for (let i = 0; i <= 20; i++) { const u = i/10 - 1, x = u*w/2; i ? ctx.lineTo(x, top(u) + R*.15) : ctx.moveTo(x, top(u) + R*.15); }
    for (let i = 20; i >= 0; i--) { const u = i/10 - 1; ctx.lineTo(u*w/2, bot(u) + R*.15); }
    ctx.closePath();
  };
  path(); ctx.strokeStyle = '#9c2f3e'; ctx.lineWidth = R*.13; ctx.lineJoin = 'round'; ctx.stroke();   // lips
  ctx.fillStyle = '#3a0710'; ctx.fill();
  ctx.save(); ctx.clip();
  ctx.fillStyle = '#efe8d4'; ctx.strokeStyle = '#2a1a12'; ctx.lineWidth = Math.max(1, R*.015);
  for (let i = 0; i < 9; i++) {                                         // upper teeth hang down
    const u = (i + .5)/9*2 - 1, x = u*w/2, y = top(u) + R*.15, tw = w/10.5, th = R*.17*(1 - .4*u*u);
    ctx.beginPath(); rrect(ctx, x - tw/2, y - 2, tw, th, tw*.35); ctx.fill(); ctx.stroke();
  }
  for (let i = 0; i < 8; i++) {                                         // lower teeth rise up
    const u = (i + .5)/8*2 - 1, x = u*w/2, y = bot(u) + R*.15, tw = w/9.5, th = R*.15*(1 - .4*u*u);
    ctx.beginPath(); rrect(ctx, x - tw/2, y - th + 2, tw, th, tw*.35); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
  path(); ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1, R*.03); ctx.stroke();
  // drool
  const d = (t*.6) % 1;
  ctx.strokeStyle = 'rgba(220,230,240,.6)'; ctx.lineWidth = Math.max(1, R*.02);
  ctx.beginPath(); ctx.moveTo(R*.25, bot(.4) + R*.2); ctx.lineTo(R*.26, bot(.4) + R*.2 + R*.35*d); ctx.stroke();
}

/* ---- 指持ち Finger Bearer: the boss. A tall skull-like head crowned with fingers, cracks of fire ---- */
function drawBearer(ctx, R, t, look, c) {
  // crown of fingers
  for (let i = 0; i < 7; i++) {
    const a = -Math.PI/2 + (i - 3)*.32, len = R*(.55 + .12*Math.cos(i*1.7)), sway = Math.sin(t*1.5 + i)*.05;
    ctx.save(); ctx.translate(Math.cos(a)*R*.55, -R*.35 + Math.sin(a)*R*.62); ctx.rotate(a + Math.PI/2 + sway);
    const fw = R*.12;
    ctx.fillStyle = '#cdb89a'; ctx.strokeStyle = INK; ctx.lineWidth = lw(R)*.7;
    ctx.beginPath(); rrect(ctx, -fw/2, -len, fw, len, fw/2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#8a6f68'; ctx.beginPath(); ctx.ellipse(0, -len + fw*.55, fw*.32, fw*.42, 0, 0, TAU); ctx.fill();   // nail
    ctx.lineWidth = Math.max(1, R*.012);
    for (const k of [.35, .65]) { ctx.beginPath(); ctx.moveTo(-fw*.3, -len*k); ctx.lineTo(fw*.3, -len*k); ctx.stroke(); }   // knuckles
    ctx.restore();
  }
  // head
  ctx.beginPath(); ctx.ellipse(0, 0, R*.78, R*1.0, 0, 0, TAU);
  const g = ctx.createRadialGradient(-R*.3, -R*.4, R*.1, 0, 0, R*1.1);
  g.addColorStop(0, '#463648'); g.addColorStop(.6, '#241a28'); g.addColorStop(1, '#0d080f');
  ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = lw(R); ctx.stroke();
  // glowing cracks
  const r = mulberry(c.seed + 11), pulse = .55 + .45*Math.sin(t*3);
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    let x = (r() - .5)*R*1.1, y = (r() - .5)*R*1.6; const pts = [[x, y]];
    for (let j = 0; j < 4; j++) { x += (r() - .5)*R*.35; y += (r() - .3)*R*.3; pts.push([x, y]); }
    for (const [w, a] of [[R*.06, .25], [R*.018, .9]]) {
      ctx.strokeStyle = `rgba(255,${120 + 60*(w < R*.05)},40,${a*pulse})`; ctx.lineWidth = Math.max(1, w);
      ctx.beginPath(); pts.forEach(([px, py], k) => k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.stroke();
    }
  }
  ctx.restore();
  // four eyes down the seam
  eye(ctx, 0, -R*.45, R*.2, look, '#ff6a1a', blinkAt(t, 1));
  eye(ctx, -R*.32, -R*.12, R*.16, look, '#ff6a1a', blinkAt(t, 2));
  eye(ctx, R*.32, -R*.12, R*.16, look, '#ff6a1a', blinkAt(t, 3));
  eye(ctx, 0, R*.1, R*.12, look, '#ffb21a', blinkAt(t, 4), true);
  // jaw of long teeth, glowing throat
  const open = .3 + .25*(.5 + .5*Math.sin(t*1.3)), mw = R*.9, my = R*.5, mh = R*.4*open + R*.08;
  ctx.fillStyle = '#1a0402'; ctx.strokeStyle = INK; ctx.lineWidth = lw(R)*.8;
  ctx.beginPath(); ctx.ellipse(0, my, mw/2, mh, 0, 0, TAU); ctx.fill();
  ctx.save(); ctx.clip();
  const tg = ctx.createRadialGradient(0, my, 0, 0, my, mw/2);
  tg.addColorStop(0, `rgba(255,120,30,${.7*pulse})`); tg.addColorStop(1, 'rgba(255,60,0,0)');
  ctx.fillStyle = tg; ctx.fillRect(-mw/2, my - mh, mw, mh*2);
  ctx.fillStyle = '#e8dfc6'; ctx.strokeStyle = '#2a1a12'; ctx.lineWidth = Math.max(1, R*.012);
  for (let i = 0; i < 9; i++) {
    const x = (i/8 - .5)*mw*.92, tw = mw/12, th = R*.22*(1 - .5*Math.abs(i/8 - .5)*2);
    ctx.beginPath(); ctx.moveTo(x - tw/2, my - mh); ctx.lineTo(x + tw/2, my - mh); ctx.lineTo(x, my - mh + th); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - tw/2, my + mh); ctx.lineTo(x + tw/2, my + mh); ctx.lineTo(x, my + mh - th*.8); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = INK; ctx.lineWidth = lw(R)*.8; ctx.beginPath(); ctx.ellipse(0, my, mw/2, mh, 0, 0, TAU); ctx.stroke();
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

