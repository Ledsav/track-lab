/* =============================================================================
   LENSES
   -----------------------------------------------------------------------------
   Each lens turns the mirrored camera image into a different world, rendered into
   one offscreen canvas at a reduced width (the app scales it up and clips it into
   the finger frame). Composite-op lenses run anywhere; pixel lenses (Thermal,
   Manga Ink) work on the small canvas so they stay cheap.
   ============================================================================= */
import { mulberry } from '../../shared/js/math.js';

export const LENSES = [
  { id:'invert',  name:'Inverted',  kanji:'反' },
  { id:'xray',    name:'X-Ray',     kanji:'透' },
  { id:'thermal', name:'Thermal',   kanji:'熱' },
  { id:'ink',     name:'Manga Ink', kanji:'墨' },
  { id:'prism',   name:'Prism',     kanji:'虹' },
];

/** 256-entry RGB lookup from colour stops [[0..1, '#rrggbb'], …]. */
function lut(stops) {
  const out = new Uint8ClampedArray(256*3), rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  for (let i = 0; i < 256; i++) {
    const t = i/255; let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1], u = Math.min(1, Math.max(0, (t - t0)/(t1 - t0 || 1)));
    const a = rgb(c0), b = rgb(c1);
    for (let j = 0; j < 3; j++) out[i*3 + j] = a[j] + (b[j] - a[j])*u;
  }
  return out;
}
const THERMAL = lut([[0, '#05030f'], [.22, '#2a0a6b'], [.42, '#a3155f'], [.6, '#ff4b1f'], [.8, '#ffb21a'], [1, '#fffbe0']]);
const PAPER = [244, 239, 228], INK = [20, 18, 16];

const canvas = (w = 1, h = 1) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

export class LensView {
  constructor(width = 480) {
    this.width = width;
    this.c = canvas(); this.g = this.c.getContext('2d', { willReadFrequently:true });
    this.tmp = canvas(); this.t = this.tmp.getContext('2d');
    this.ch = [canvas(), canvas(), canvas()];                              // prism channels
  }
  size(W, H) {
    const w = this.width, h = Math.round(w*H/W);
    for (const c of [this.c, this.tmp, ...this.ch]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return [w, h];
  }
  mirrored(g, video, w, h) { g.save(); g.setTransform(-1, 0, 0, 1, w, 0); g.drawImage(video, 0, 0, w, h); g.restore(); }

  /** Render lens `id` for this camera frame. Returns the lens canvas (mirrored, like the stage). */
  render(video, W, H, id, time) {
    const [w, h] = this.size(W, H), g = this.g;
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    this.mirrored(g, video, w, h);
    this[id](g, w, h, time);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    return this.c;
  }

  /* ---- Inverted: the Magic Lens look ---- */
  invert(g, w, h) {
    g.globalCompositeOperation = 'difference'; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'soft-light'; g.fillStyle = 'rgba(120,200,255,.35)'; g.fillRect(0, 0, w, h);   // a cold cast, like a film negative
  }

  /* ---- X-Ray: inverted, desaturated, blue phosphor, scanlines and a sweeping band ---- */
  xray(g, w, h, time) {
    g.globalCompositeOperation = 'difference'; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'saturation'; g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'multiply'; g.fillStyle = '#8fd4ff'; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'screen'; g.fillStyle = '#071a3a'; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over'; g.fillStyle = 'rgba(0,10,25,.22)';
    for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
    const by = ((time*.35) % 1.3 - .15)*h, band = g.createLinearGradient(0, by - h*.12, 0, by + h*.12);
    band.addColorStop(0, 'rgba(150,230,255,0)'); band.addColorStop(.5, 'rgba(150,230,255,.28)'); band.addColorStop(1, 'rgba(150,230,255,0)');
    g.globalCompositeOperation = 'lighter'; g.fillStyle = band; g.fillRect(0, by - h*.12, w, h*.24);
  }

  /* ---- Thermal: luminance through a heat palette, softened like a cheap sensor ---- */
  thermal(g, w, h) {
    const t = this.t, hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);   // half-res pass blurs it
    t.clearRect(0, 0, w, h); t.drawImage(this.c, 0, 0, hw, hh);
    g.imageSmoothingEnabled = true; g.drawImage(this.tmp, 0, 0, hw, hh, 0, 0, w, h);
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i]*54 + d[i + 1]*183 + d[i + 2]*19) >> 8, k = l*3;
      d[i] = THERMAL[k]; d[i + 1] = THERMAL[k + 1]; d[i + 2] = THERMAL[k + 2];
    }
    g.putImageData(img, 0, 0);
  }

  /* ---- Manga Ink: Sobel edges as ink lines, tones as screentone dots and hatching ---- */
  ink(g, w, h) {
    const img = g.getImageData(0, 0, w, h), d = img.data, L = new Float32Array(w*h);
    let sum = 0;
    for (let i = 0, p = 0; p < L.length; i += 4, p++) { L[p] = (d[i]*.2126 + d[i + 1]*.7152 + d[i + 2]*.0722)/255; sum += L[p]; }
    const mean = sum/L.length, hi = Math.min(.8, mean + .12), mid = Math.max(.12, mean - .1), lo = Math.max(.06, mean - .26);   // adapt to the room's exposure
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y*w + x, i = p*4;
      let ink = false;
      if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        const a = L[p - w - 1], b = L[p - w], c = L[p - w + 1], e = L[p - 1], f = L[p + 1], gg = L[p + w - 1], hh = L[p + w], ii = L[p + w + 1];
        const gx = (c + 2*f + ii) - (a + 2*e + gg), gy = (gg + 2*hh + ii) - (a + 2*b + c);
        ink = gx*gx + gy*gy > .09;
      }
      const l = L[p];
      if (!ink) {
        if (l > hi) ink = false;
        else if (l > mid) ink = (x & 3) < 2 && (y & 3) < 2 && ((x >> 2) + (y >> 2)) % 2 === 0;   // screentone dots
        else if (l > lo) ink = (x + y) % 4 === 0;                                                // hatching
        else ink = true;
      }
      const c = ink ? INK : PAPER;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
    }
    g.putImageData(img, 0, 0);
  }

  /* ---- Prism: RGB channels split apart, slices torn sideways "on twos", a rainbow sheen ---- */
  prism(g, w, h, time) {
    const cols = ['#ff0000', '#00ff00', '#0000ff'];
    this.ch.forEach((c, k) => {
      const x = c.getContext('2d');
      x.globalCompositeOperation = 'source-over'; x.drawImage(this.c, 0, 0);
      x.globalCompositeOperation = 'multiply'; x.fillStyle = cols[k]; x.fillRect(0, 0, w, h);
    });
    const dx = w*(.012 + .008*Math.sin(time*3));
    g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(this.ch[0], -dx, 0); g.drawImage(this.ch[1], 0, dx*.3); g.drawImage(this.ch[2], dx, 0);
    const t = this.t; t.globalCompositeOperation = 'copy'; t.drawImage(this.c, 0, 0); t.globalCompositeOperation = 'source-over';
    g.globalCompositeOperation = 'source-over';
    const r = mulberry(Math.floor(time*12)*7919);
    for (let k = 0; k < 5; k++) {
      const y = Math.floor(r()*h), sh = Math.max(2, Math.floor(r()*h*.08)), off = (r() - .5)*w*.12;
      g.drawImage(this.tmp, 0, y, w, sh, off, y, w, sh);
    }
    const s = g.createLinearGradient(0, 0, w, h), o = (time*.2) % 1;
    ['#ff3b6b', '#ffd23b', '#3bff9e', '#3bb0ff', '#c13bff'].forEach((c, k) => s.addColorStop((k/4*.9 + o) % 1, c));
    g.globalCompositeOperation = 'soft-light'; g.globalAlpha = .45; g.fillStyle = s; g.fillRect(0, 0, w, h);
  }
}
