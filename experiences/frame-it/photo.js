/* =============================================================================
   PHOTO: finger frame → straightened square → polaroid card
   -----------------------------------------------------------------------------
   capturePhoto() straightens the finger frame into a square photo (one transform,
   centre-cropped so nothing gets stretched). makeCard() lays the photo on
   instant-film paper with a marker caption, date and the Track Lab mark.
   ============================================================================= */

/** Order 4 points as [top-left, top-right, bottom-right, bottom-left] (clockwise on screen). */
export function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0)/4, cy = pts.reduce((s, p) => s + p.y, 0)/4;
  const q = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let first = 0;
  q.forEach((p, i) => { if (p.x + p.y < q[first].x + q[first].y) first = i; });
  return [...q.slice(first), ...q.slice(0, first)];
}
export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p.x*n.y - n.x*p.y; }
  return Math.abs(a)/2;
}

/**
 * Straighten the frame (in img pixel coords, [TL, TR, BR, BL]) into a size×size photo.
 * The frame is averaged into a parallelogram and mapped with one transform (no seams); a wide or
 * tall frame is cropped to its centred square rather than stretched.
 */
export function capturePhoto(img, quad, size = 640) {
  const [TL, TR, BR, BL] = quad;
  const c = { x:(TL.x + TR.x + BR.x + BL.x)/4, y:(TL.y + TR.y + BR.y + BL.y)/4 };
  let u = { x:(TR.x - TL.x + BR.x - BL.x)/2, y:(TR.y - TL.y + BR.y - BL.y)/2 };   // frame's "across" edge
  let v = { x:(BL.x - TL.x + BR.x - TR.x)/2, y:(BL.y - TL.y + BR.y - TR.y)/2 };   // frame's "down" edge
  // keep the photo upright whatever corner the list starts at: "across" is the more horizontal edge, pointing right,
  // "down" points down (otherwise a frame tilted near 45° could come out rotated 90°)
  if (Math.abs(v.x) > Math.abs(u.x)) [u, v] = [v, u];
  if (u.x < 0) u = { x:-u.x, y:-u.y };
  if (v.y < 0) v = { x:-v.x, y:-v.y };
  const lu = Math.hypot(u.x, u.y) || 1, lv = Math.hypot(v.x, v.y) || 1, side = Math.min(lu, lv);
  u = { x:u.x*side/lu, y:u.y*side/lu }; v = { x:v.x*side/lv, y:v.y*side/lv };
  const o = { x:c.x - (u.x + v.x)/2, y:c.y - (u.y + v.y)/2 }, det = u.x*v.y - u.y*v.x || 1;
  const a = size*v.y/det, cc = -size*v.x/det, b = -size*u.y/det, d = size*u.x/det;   // dest = size·[u v]⁻¹·(src − o)
  const out = document.createElement('canvas'); out.width = out.height = size;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#1c1a17'; ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(a, b, cc, d, -(a*o.x + cc*o.y), -(b*o.x + d*o.y));
  ctx.drawImage(img, 0, 0);
  return out;
}

const MARK = new Path2D('M40 40h84v28H68v56H40zM216 216h-84v-28h56v-56h28z');   // Track Lab "Lock-on"
export const CARD = { w:720, h:870, pad:40, img:640 };

/** Polaroid card canvas: photo + film treatment + caption. */
export async function makeCard(photo, { caption, date = new Date() }) {
  if (document.fonts) { try { await document.fonts.load('48px "Caveat"', caption); await document.fonts.load('18px "IBM Plex Mono"'); } catch { /* fallback fonts */ } }
  const { w, h, pad, img } = CARD, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const paper = g.createLinearGradient(0, 0, w, h); paper.addColorStop(0, '#f8f4ea'); paper.addColorStop(1, '#ece4d2');   // instant-film paper
  g.fillStyle = paper; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2200; i++) { g.fillStyle = `rgba(80,60,30,${Math.random()*.05})`; g.fillRect(Math.random()*w, Math.random()*h, 1.2, 1.2); }
  g.fillStyle = '#1c1a17'; g.fillRect(pad - 1, pad - 1, img + 2, img + 2);
  g.drawImage(photo, pad, pad, img, img);
  g.save(); g.beginPath(); g.rect(pad, pad, img, img); g.clip();                // film look: warm, soft vignette, grain
  g.globalCompositeOperation = 'soft-light'; g.fillStyle = 'rgba(255,190,120,.22)'; g.fillRect(pad, pad, img, img);
  g.globalCompositeOperation = 'multiply';
  const v = g.createRadialGradient(pad + img/2, pad + img/2, img*.35, pad + img/2, pad + img/2, img*.75);
  v.addColorStop(0, 'rgba(255,255,255,0)'); v.addColorStop(1, 'rgba(90,60,40,.45)'); g.fillStyle = v; g.fillRect(pad, pad, img, img);
  g.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 4000; i++) { const l = Math.random() < .5 ? 255 : 0; g.fillStyle = `rgba(${l},${l},${l},${Math.random()*.06})`; g.fillRect(pad + Math.random()*img, pad + Math.random()*img, 1.5, 1.5); }
  g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 2; g.strokeRect(pad + 1, pad + 1, img - 2, img - 2);   // inner edge shadow
  g.restore();
  const base = pad + img + 92;
  g.fillStyle = '#2b2622'; g.font = '52px "Caveat", "Segoe Print", cursive'; g.textBaseline = 'alphabetic';
  g.fillText(caption, pad + 10, base);
  g.font = '17px "IBM Plex Mono", ui-monospace, monospace'; g.fillStyle = 'rgba(43,38,34,.55)'; g.textAlign = 'right';
  const dd = String(date.getDate()).padStart(2, '0'), mm = String(date.getMonth() + 1).padStart(2, '0'), yy = String(date.getFullYear()).slice(2);
  g.fillText(`${dd}.${mm}.${yy}  track lab`, w - pad - 46, base - 2);
  g.save(); g.translate(w - pad - 32, base - 26); g.scale(32/256, 32/256);
  g.fillStyle = 'rgba(43,38,34,.7)'; g.fill(MARK); g.fillStyle = '#c9a227'; g.beginPath(); g.arc(148, 108, 26, 0, Math.PI*2); g.fill();
  g.restore();
  return c;
}

export const toBlob = (canvas, type = 'image/jpeg', q = .92) => new Promise(r => canvas.toBlob(r, type, q));
