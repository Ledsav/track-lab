/* =============================================================================
   Hand tracking (MediaPipe Hands, runs fully in the browser)
   -----------------------------------------------------------------------------
   const tracking = await startHands({ video, onResults });
   onResults(res, t) receives MediaPipe's raw result plus a performance.now() stamp:
     res.multiHandLandmarks       21 normalized {x,y,z} per hand (image space, unmirrored)
     res.multiHandWorldLandmarks  21 points in metres, hand-centred
     res.multiHandedness          [{ label:'Left'|'Right', score }]  (inverted, the input isn't mirrored)
   Landmark indices: 0 wrist · 4 thumb tip · 8 index tip · 12 middle · 16 ring · 20 pinky.
   ============================================================================= */
import { loadScript, isMobile, isPortrait } from './dom.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/';
export const HANDS_BASE  = CDN + 'hands@0.4.1675469240/';
const CAMERA_SRC = CDN + 'camera_utils@0.3.1675466862/camera_utils.js';

export const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

export const CAMERA_SIZES = { landscape:{ width:1280, height:720 }, portrait:{ width:720, height:1280 } };

/**
 * Load MediaPipe, open the camera and start feeding frames to the tracker.
 * @param {object}   o
 * @param {HTMLVideoElement} o.video
 * @param {Function} o.onResults  (res, t) => void
 * @param {object}  [o.options]   MediaPipe Hands options (merged over the defaults)
 * @param {number}  [o.mobileComplexity=0]  modelComplexity used on phones / tablets
 * @param {{width,height}} [o.size]  camera request; defaults to landscape / portrait by orientation
 */
export async function startHands({ video, onResults, options = {}, mobileComplexity = 0, size }) {
  await Promise.all([loadScript(CAMERA_SRC), loadScript(HANDS_BASE + 'hands.js')]);
  const opts = { maxNumHands:2, modelComplexity:1, minDetectionConfidence:.6, minTrackingConfidence:.6, ...options };
  if (isMobile()) opts.modelComplexity = mobileComplexity;
  const cam = size || (isPortrait() ? CAMERA_SIZES.portrait : CAMERA_SIZES.landscape);

  const tracker = new window.Hands({ locateFile: f => HANDS_BASE + f });
  tracker.setOptions(opts);
  tracker.onResults(res => onResults(res, performance.now()));
  const camera = new window.Camera(video, { onFrame: async () => { await tracker.send({ image:video }); }, width:cam.width, height:cam.height });
  await camera.start();
  return { tracker, camera, stop() { camera.stop(); tracker.close(); } };
}

/** Normalized landmarks → mirrored canvas pixels (what the user sees, selfie view). */
export const toMirrored = (lm, W, H) => lm.map(p => ({ x:(1-p.x)*W, y:p.y*H }));

/** Faint hand skeleton for debugging. hands: [{ pts:[{x,y}×21] }] in canvas pixels. */
export function drawSkeleton(ctx, hands, color = '#e8e6e1', alpha = .28) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.fillStyle = color;
  for (const h of hands) {
    ctx.beginPath(); HAND_CONNECTIONS.forEach(([a,b]) => { ctx.moveTo(h.pts[a].x,h.pts[a].y); ctx.lineTo(h.pts[b].x,h.pts[b].y); }); ctx.stroke();
    h.pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x,p.y,2,0,6.3); ctx.fill(); });
  }
  ctx.restore();
}

/** Draw the camera image mirrored, filling W×H. */
export function drawMirroredVideo(ctx, img, W, H) {
  ctx.save(); ctx.translate(W,0); ctx.scale(-1,1); ctx.drawImage(img, 0, 0, W, H); ctx.restore();
}
