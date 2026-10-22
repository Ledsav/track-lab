import { experiences } from '../experiences/registry.js';
import { HAND_CONNECTIONS } from '../shared/js/hands.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

/* ---------- cards ---------- */
function renderGrid() {
  $('grid').innerHTML = experiences.map((e, i) => {
    const [a, b, c = b] = e.cover?.colors || ['#333', '#111'];
    const wash = `radial-gradient(circle at 25% 35%, ${a}, transparent 55%), radial-gradient(circle at 75% 65%, ${b}, transparent 55%), radial-gradient(circle at 50% 50%, ${c}, #000 75%)`;
    return `<li><a class="card" href="experiences/${esc(e.slug)}/">
      <div class="cover">
        <div class="wash" style="background:${esc(wash)}"></div>
        <div class="glyph">${esc(e.cover?.glyph || '◎')}</div>
        <div class="frame"></div>
        <span class="tracker">◉ ${esc(e.tracker)}</span>
        <span class="idx">${String(i + 1).padStart(2, '0')}</span>
      </div>
      <div class="body">
        <h3>${esc(e.title)}</h3>
        <p>${esc(e.blurb)}</p>
        <div class="foot">
          <div class="tags">${(e.tags || []).map(t => `<span>${esc(t)}</span>`).join('')}</div>
          <span class="go">Enter →</span>
        </div>
      </div>
    </a></li>`;
  }).join('');
  const n = experiences.length;
  $('count').textContent = `${String(n).padStart(2, '0')} / live`;
  const latest = experiences.map(e => e.added).filter(Boolean).sort().pop();
  $('meta').textContent = `${n} experience${n === 1 ? '' : 's'}${latest ? ' · updated ' + latest : ''}`;
}

/* ---------- hero: a synthetic hand, drawn the way the tracker sees one ---------- */
// rest pose in a unit box (x right, y down), wrist at the bottom
const REST = [
  [0,.95], [-.22,.82],[-.36,.66],[-.46,.52],[-.55,.40],          // thumb
  [-.16,.48],[-.2,.28],[-.22,.15],[-.24,.03],                    // index
  [0,.45],[0,.22],[0,.08],[0,-.05],                              // middle
  [.15,.47],[.18,.27],[.2,.14],[.22,.03],                        // ring
  [.28,.53],[.34,.38],[.37,.28],[.4,.19],                        // pinky
];
const FINGERS = [[1,2,3,4],[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];

function startHero() {
  const cv = $('heroCanvas'), ctx = cv.getContext('2d');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, t = 0, last = performance.now(), frames = 0, fpsT = 0;
  const trail = [];

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = cv.clientWidth; H = cv.clientHeight; cv.width = W*dpr; cv.height = H*dpr;
  }
  function pose(time) {
    const narrow = W < 700, s = Math.min(W, H)*(narrow ? .62 : .78);
    const cx = W*(narrow ? .62 : .72) + Math.sin(time*.31)*s*.06, cy = H*(narrow ? .42 : .48) + Math.cos(time*.23)*s*.04, rot = Math.sin(time*.4)*.18 - .12;
    const curl = FINGERS.map((_, f) => .5 + .5*Math.sin(time*1.1 - f*.7));   // a slow wave through the fingers
    return REST.map(([x, y], i) => {
      const f = FINGERS.findIndex(g => g.includes(i)), k = f < 0 ? 0 : FINGERS[f].indexOf(i) + 1;
      if (f >= 0) { const base = REST[FINGERS[f][0]]; const c = curl[f]*.22*k/4; x = lerp(x, base[0], c); y = lerp(y, base[1], c*1.4); }
      const rx = x*Math.cos(rot) - (y - .45)*Math.sin(rot), ry = x*Math.sin(rot) + (y - .45)*Math.cos(rot);
      return { x:cx + rx*s, y:cy + ry*s };
    });
  }
  const lerp = (a, b, k) => a + (b - a)*k;

  function draw(now) {
    const dt = Math.min(.05, (now - last)/1000); last = now; t += dt;
    frames++; fpsT += dt; if (fpsT > .5) { $('fps').textContent = Math.round(frames/fpsT); frames = 0; fpsT = 0; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);

    // faint measurement grid
    ctx.strokeStyle = 'rgba(232,230,225,.035)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = (W % 48)/2; x < W; x += 48) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, H); }
    for (let y = (H % 48)/2; y < H; y += 48) { ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); }
    ctx.stroke();

    const p = pose(t);
    // index fingertip trail
    trail.push({ x:p[8].x, y:p[8].y }); if (trail.length > 48) trail.shift();
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      const k = i/trail.length; ctx.strokeStyle = `rgba(214,255,61,${k*.55})`; ctx.lineWidth = 1 + k*2.5;
      ctx.beginPath(); ctx.moveTo(trail[i-1].x, trail[i-1].y); ctx.lineTo(trail[i].x, trail[i].y); ctx.stroke();
    }
    // bones + joints
    ctx.strokeStyle = 'rgba(232,230,225,.32)'; ctx.lineWidth = 1.2; ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) { ctx.moveTo(p[a].x, p[a].y); ctx.lineTo(p[b].x, p[b].y); }
    ctx.stroke();
    p.forEach((q, i) => {
      const tip = i % 4 === 0 && i > 0;
      ctx.fillStyle = i === 8 ? '#d6ff3d' : tip ? '#e8e6e1' : 'rgba(232,230,225,.6)';
      ctx.beginPath(); ctx.arc(q.x, q.y, i === 8 ? 4 : tip ? 3 : 2, 0, Math.PI*2); ctx.fill();
    });
    // bounding box brackets + label
    const xs = p.map(q => q.x), ys = p.map(q => q.y), pad = 22;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad, L = 16;
    ctx.strokeStyle = 'rgba(232,230,225,.5)'; ctx.lineWidth = 1; ctx.beginPath();
    [[x0,y0,1,1],[x1,y0,-1,1],[x0,y1,1,-1],[x1,y1,-1,-1]].forEach(([x,y,sx,sy]) => { ctx.moveTo(x + sx*L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy*L); });
    ctx.stroke();
    ctx.font = '500 10.5px "JetBrains Mono", ui-monospace, monospace'; ctx.fillStyle = 'rgba(232,230,225,.6)';
    ctx.fillText(`HAND 0.9${Math.floor(6 + 3*Math.abs(Math.sin(t*.7)))}`, x0, y0 - 8);
    ctx.fillStyle = 'rgba(214,255,61,.8)';
    ctx.fillText(`idx ${Math.round(p[8].x)},${Math.round(p[8].y)}`, p[8].x + 10, p[8].y - 8);

    if (!still) requestAnimationFrame(draw);
  }
  resize(); window.addEventListener('resize', resize);
  requestAnimationFrame(draw);
}

renderGrid();
startHero();
