/* =============================================================================
   __TITLE__
   -----------------------------------------------------------------------------
   Starter: mirrored camera, hand skeleton, and a glowing trail behind each
   index fingertip. Replace update() / render() with your own idea.
   ============================================================================= */
import { clamp, prune } from '../../shared/js/math.js';
import { $ } from '../../shared/js/dom.js';
import { startHands, toMirrored, drawMirroredVideo, drawSkeleton } from '../../shared/js/hands.js';

const canvas = $('canvas'), ctx = canvas.getContext('2d'), video = $('video');
let hands = [], pending = null, lastT = 0;
const trails = [];                                   // { x, y, life }

$('start').addEventListener('click', async () => {
  $('start').disabled = true; $('err').textContent = '';
  try {
    await startHands({ video, onResults:res => { pending = res; } });
    document.body.classList.add('running');
    lastT = performance.now(); requestAnimationFrame(frame);
  } catch (e) {
    $('err').textContent = 'Could not start: ' + (e.message || e);
    $('start').disabled = false;
  }
});

function frame(now) {
  requestAnimationFrame(frame);
  if (!video.videoWidth) return;
  const W = video.videoWidth, H = video.videoHeight;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const dt = clamp((now - lastT)/1000, .001, .05); lastT = now;

  if (pending) {
    hands = (pending.multiHandLandmarks || []).map(lm => ({ pts:toMirrored(lm, W, H) }));
    pending = null;
  }
  update(dt);
  render(W, H);
}

function update(dt) {
  for (const h of hands) trails.push({ x:h.pts[8].x, y:h.pts[8].y, life:1 });
  for (const p of trails) p.life -= dt*1.5;
  prune(trails, p => p.life > 0);
}

function render(W, H) {
  drawMirroredVideo(ctx, video, W, H);
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const p of trails) {
    ctx.fillStyle = `rgba(214,255,61,${p.life*.6})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4 + 10*p.life, 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();
  drawSkeleton(ctx, hands, '#e8e6e1', .5);
}
