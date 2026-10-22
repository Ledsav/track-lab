/* =============================================================================
   Hand tracking (MediaPipe Tasks Vision HandLandmarker, runs fully in the browser)
   -----------------------------------------------------------------------------
   const tracking = await startHands({ video, onResults });
   Opens the front camera into `video` and runs the tracker on every new camera
   frame. onResults(res, t) gets the classic MediaPipe Hands shape plus a
   performance.now() stamp, so callers don't care which runtime is underneath:
     res.multiHandLandmarks       21 normalized {x,y,z} per hand (image space, unmirrored)
     res.multiHandWorldLandmarks  21 points in metres, hand-centred
     res.multiHandedness          [{ label:'Left'|'Right', score }]  (assumes a mirrored image,
                                  so with this unmirrored input the label is inverted)
   Landmark indices: 0 wrist · 4 thumb tip · 8 index tip · 12 middle · 16 ring · 20 pinky.
   Shares its runtime with face / segmentation in vision.js (one MediaPipe per page).
   ============================================================================= */
import { matches } from './dom.js';
import { createHandLandmarker } from './vision.js';

export const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

export const CAMERA_SIZES = { landscape:{ width:1280, height:720 } };

/**
 * Open the camera at its full field of view. Phones crop the sensor to honour a width/height
 * request whose shape differs from it (a 720×1280 ask turned into a zoomed-in strip), so on phones
 * take the camera's own default shape first, then only scale that same shape up to ~1280 px.
 * Laptops get 1280×720, which is their webcams' native shape.
 */
export async function openCamera(size) {
  if (size || !matches('(pointer: coarse)'))            // touch devices: phones and tablets
    return navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:'user', width:{ ideal:(size || CAMERA_SIZES.landscape).width }, height:{ ideal:(size || CAMERA_SIZES.landscape).height } } });
  const stream = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:'user', resizeMode:{ ideal:'none' } } });
  const track = stream.getVideoTracks()[0], s = track.getSettings ? track.getSettings() : {};
  const long = Math.max(s.width || 0, s.height || 0);
  if (long && long < 1280 && track.applyConstraints) {
    const k = 1280 / long, shape = s.width / s.height;
    try {
      await track.applyConstraints({ width:{ ideal:Math.round(s.width*k) }, height:{ ideal:Math.round(s.height*k) }, resizeMode:{ ideal:'none' } });
      const n = track.getSettings();
      if (Math.abs(n.width / n.height - shape) > .02)                     // it cropped after all: back to the full view
        await track.applyConstraints({ width:{ ideal:s.width }, height:{ ideal:s.height } });
    } catch (e) { /* keep the default size */ }
  }
  return stream;
}

/**
 * Open the camera, load the hand model and track every new frame.
 * @param {object}   o
 * @param {HTMLVideoElement} o.video
 * @param {Function} o.onResults  (res, t) => void
 * @param {object}  [o.options]   { maxNumHands, minDetectionConfidence, minTrackingConfidence } (classic names)
 * @param {{width,height}} [o.size]  exact camera request; by default see openCamera()
 */
export async function startHands({ video, onResults, options = {}, size }) {
  const stream = await openCamera(size);
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  const o = { maxNumHands:2, minDetectionConfidence:.6, minTrackingConfidence:.6, ...options };
  const tracker = await createHandLandmarker({ numHands:o.maxNumHands, minHandDetectionConfidence:o.minDetectionConfidence,
                                               minHandPresenceConfidence:o.minDetectionConfidence, minTrackingConfidence:o.minTrackingConfidence });
  let stopped = false, lastFrame = -1;
  // rAF, not requestVideoFrameCallback: that one may never fire for a display:none <video>
  const next = () => requestAnimationFrame(tick);
  function tick() {
    if (stopped) return;
    if (video.readyState >= 2 && video.currentTime !== lastFrame) {      // only new camera frames
      lastFrame = video.currentTime;
      const t = performance.now(), r = tracker.detectForVideo(video, t);
      onResults({
        multiHandLandmarks: r.landmarks || [],
        multiHandWorldLandmarks: r.worldLandmarks || [],
        multiHandedness: (r.handedness || r.handednesses || []).map(c => ({ label:c[0] && c[0].categoryName, score:c[0] && c[0].score })),
      }, t);
    }
    next();
  }
  next();
  return { tracker, stream, stop() { stopped = true; stream.getTracks().forEach(t => t.stop()); tracker.close(); } };
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
