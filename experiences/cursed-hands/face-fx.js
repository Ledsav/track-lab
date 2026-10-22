/* =============================================================================
   FACE FX: recoloured glowing eyes and dyed hair (both optional, off by default)
   -----------------------------------------------------------------------------
   Eyes: face landmarks give each iris (centre + rim) and the eyelid outline. The
   iris is recoloured inside the lids (so blinks still hide it), given fibres and a
   sparkle, and a glow that escapes the eye so it reads from across the room.
   Hair: the multiclass segmenter marks hair pixels; that mask is mirrored into a
   low-res canvas, scaled up (soft edges for free) and used to tint the camera
   image with a 'color' blend (keeps light and shade), plus 'screen' for pale colours.
   Models load the first time a toggle is switched on.
   ============================================================================= */
import { clamp, lerp } from '../../shared/js/math.js';
import { isMobile } from '../../shared/js/dom.js';
import { createFaceLandmarker, createSegmenter, SEGMENT, EYES } from '../../shared/js/vision.js';

const CFG = {
  faceHz: 30, hairHz: 15, hairHzMobile: 8,
  maskW: 320,                  // hair mask resolution (upscaled with smoothing)
  smooth: .55,                 // iris position smoothing (0 = frozen, 1 = raw)
};
const rgbOf = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const luma = ([r, g, b]) => (.2126*r + .7152*g + .0722*b)/255;

/** opts (from the panel) = { eyes, eyeColor, glow, hair, hairColor } */
export class FaceFX {
  constructor() {
    this.face = null; this.seg = null; this.loading = {}; this.error = '';
    this.eyes = null; this.faceSeen = false; this.lastFace = -1; this.lastHair = -1;
    this.mask = document.createElement('canvas'); this.maskCtx = this.mask.getContext('2d', { willReadFrequently:true }); this.maskImg = null;
    this.tint = document.createElement('canvas'); this.tintKey = ''; this.maskVersion = 0; this.hasMask = false;
  }

  /** Short status for the panel. */
  status(o) {
    if (this.error) return this.error;
    if (this.loading.face || this.loading.seg) return 'Loading face models… (first time only)';
    if (o.eyes && this.face && !this.faceSeen) return 'No face found: look at the camera.';
    return '';
  }

  async ensure(kind) {
    if (this[kind] || this.loading[kind]) return;
    this.loading[kind] = true; this.error = '';
    try { this[kind] = kind === 'face' ? await createFaceLandmarker() : await createSegmenter(); }
    catch (e) { this.error = `Could not load the ${kind === 'face' ? 'face' : 'hair'} model (${e.message || e}).`; }
    finally { this.loading[kind] = false; }
  }

  update(video, now, W, H, o) {
    const ready = video.readyState >= 2, t = now/1000;
    if (o.eyes) this.ensure('face'); else { this.eyes = null; this.faceSeen = false; }
    if (o.hair) this.ensure('seg'); else this.hasMask = false;
    if (o.eyes && this.face && ready && t - this.lastFace >= 1/CFG.faceHz) {
      this.lastFace = t;
      try { this.readEyes(this.face.detectForVideo(video, now), W, H); } catch (e) { this.error = 'Face tracking failed: ' + (e.message || e); }
    }
    const hz = isMobile() ? CFG.hairHzMobile : CFG.hairHz;
    if (o.hair && this.seg && ready && t - this.lastHair >= 1/hz) {
      this.lastHair = t;
      try { this.seg.segmentForVideo(video, now, res => this.readMask(res)); } catch (e) { this.error = 'Hair tracking failed: ' + (e.message || e); }
    }
  }

  readEyes(res, W, H) {
    const lm = res.faceLandmarks && res.faceLandmarks[0];
    this.faceSeen = !!(lm && lm.length >= 478);
    if (!this.faceSeen) { this.eyes = null; return; }
    const P = i => ({ x:(1 - lm[i].x)*W, y:lm[i].y*H });                 // mirrored, like the video
    const next = EYES.map(e => {
      const c = P(e.iris), r = e.rim.map(P).reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0)/4;
      return { c, r, lids:e.lids.map(P) };
    });
    const k = this.eyes ? CFG.smooth : 1;
    this.eyes = next.map((e, i) => {
      const p = this.eyes && this.eyes[i];
      return p ? { c:{ x:lerp(p.c.x, e.c.x, k), y:lerp(p.c.y, e.c.y, k) }, r:lerp(p.r, e.r, k), lids:e.lids } : e;
    });
  }

  readMask(res) {
    const m = res.categoryMask; if (!m) return;
    const mw = m.width, mh = m.height, data = m.getAsUint8Array();
    const tw = CFG.maskW, th = Math.max(1, Math.round(tw*mh/mw));
    if (this.mask.width !== tw || this.mask.height !== th) {
      this.mask.width = tw; this.mask.height = th; this.maskImg = this.maskCtx.createImageData(tw, th);
    }
    const d = this.maskImg.data, sx = mw/tw, sy = mh/th;
    for (let y = 0; y < th; y++) {
      const row = Math.floor(y*sy)*mw;
      for (let x = 0; x < tw; x++) {
        const i = (y*tw + (tw - 1 - x))*4;                                   // mirrored, like the video
        d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = data[row + Math.floor(x*sx)] === SEGMENT.hair ? 255 : 0;
      }
    }
    this.maskCtx.putImageData(this.maskImg, 0, 0);
    this.hasMask = true; this.maskVersion++;
  }

  /** Dye the hair on the backdrop (after the grade, so the colour survives it). */
  renderHair(ctx, W, H, o) {
    if (!o.hair || !this.hasMask) return;
    const key = `${this.maskVersion}|${o.hairColor}|${W}x${H}`;
    if (key !== this.tintKey) {                                              // rebuild only when the mask or colour changes
      this.tintKey = key;
      if (this.tint.width !== W || this.tint.height !== H) { this.tint.width = W; this.tint.height = H; }
      const g = this.tint.getContext('2d');
      g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, W, H);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(this.mask, 0, 0, W, H);
      g.globalCompositeOperation = 'source-in'; g.fillStyle = o.hairColor; g.fillRect(0, 0, W, H);
    }
    const L = luma(rgbOf(o.hairColor));
    ctx.save();
    ctx.globalCompositeOperation = 'color'; ctx.globalAlpha = .92; ctx.drawImage(this.tint, 0, 0);
    if (L > .55) { ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = clamp((L - .45)*1.7, 0, .85); ctx.drawImage(this.tint, 0, 0); }   // pale / white hair: lift it
    else { ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = .45; ctx.drawImage(this.tint, 0, 0); }
    ctx.restore();
  }

  /** Recoloured, glowing irises (on the main canvas, so the glow stays bright). */
  renderEyes(ctx, o, time) {
    if (!o.eyes || !this.eyes) return;
    const [r0, g0, b0] = rgbOf(o.eyeColor), col = a => `rgba(${r0},${g0},${b0},${a})`;
    const lite = a => `rgba(${Math.min(255, r0 + 110)},${Math.min(255, g0 + 110)},${Math.min(255, b0 + 110)},${a})`;
    for (const e of this.eyes) {
      const { c } = e, R = e.r*1.08;
      const ys = e.lids.map(p => p.y), open = (Math.max(...ys) - Math.min(...ys))/(R*2);
      if (R < 1 || open < .18) continue;                                     // closed / too small: nothing to show
      ctx.save();
      ctx.beginPath(); e.lids.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.clip();
      ctx.globalCompositeOperation = 'color'; ctx.fillStyle = col(1);          // recolour, keep the real iris shading
      ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, Math.PI*2); ctx.fill();
      ctx.globalCompositeOperation = 'screen';                                 // luminous ring, dark pupil stays dark
      let g = ctx.createRadialGradient(c.x, c.y, R*.28, c.x, c.y, R);
      g.addColorStop(0, col(0)); g.addColorStop(.35, lite(.85)); g.addColorStop(.75, col(.75)); g.addColorStop(1, col(.2));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = lite(.55); ctx.lineWidth = Math.max(.5, R*.05);       // iris fibres, slowly turning
      ctx.beginPath();
      for (let k = 0; k < 14; k++) { const a = k/14*Math.PI*2 + time*.15; ctx.moveTo(c.x + Math.cos(a)*R*.42, c.y + Math.sin(a)*R*.42); ctx.lineTo(c.x + Math.cos(a)*R*.92, c.y + Math.sin(a)*R*.92); }
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.beginPath(); ctx.arc(c.x - R*.32, c.y - R*.34, Math.max(.8, R*.14), 0, Math.PI*2); ctx.fill();
      ctx.restore();
      if (o.glow > 0) {                                                        // glow that escapes the lids
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R*5);
        g.addColorStop(0, col(.5*o.glow)); g.addColorStop(.25, col(.18*o.glow)); g.addColorStop(1, col(0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, R*5, 0, Math.PI*2); ctx.fill();
        ctx.restore();
      }
    }
  }
}
