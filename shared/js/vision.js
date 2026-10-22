/* =============================================================================
   Hand / face landmarks + body-part segmentation (MediaPipe Tasks Vision)
   -----------------------------------------------------------------------------
   The one MediaPipe runtime of the lab: never mix it with the legacy
   @mediapipe/hands scripts, both are Emscripten builds fighting over a global
   `Module` ("Aborted(Module.arguments has been replaced…)" every frame).
   Loaded on demand (dynamic import), so pages that never switch these on pay nothing.
     const face = await createFaceLandmarker();  face.detectForVideo(video, now)
       → { faceLandmarks:[ [478 × {x,y,z}] ] }  normalized, unmirrored; 468–477 are the irises
     const seg = await createSegmenter();        seg.segmentForVideo(video, now, res => …)
       → res.categoryMask: MPMask, one SEGMENT class per pixel (valid only inside the callback)
   Both run in VIDEO mode: timestamps must keep increasing per task.
   ============================================================================= */

const VERSION = '0.10.14';
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
export const MODELS = {
  hand:       'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  face:      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  multiclass: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};
/** Classes of the multiclass selfie model. */
export const SEGMENT = { background:0, hair:1, bodySkin:2, faceSkin:3, clothes:4, other:5 };
/** Iris centre + 4 rim points, and the eyelid outline, for each eye (face-mesh indices). */
export const EYES = [
  { iris:468, rim:[469, 470, 471, 472], lids:[33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7] },
  { iris:473, rim:[474, 475, 476, 477], lids:[362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382] },
];

let vision = null;
function load() {
  vision ||= (async () => {
    const mod = await import(`${BASE}/vision_bundle.mjs`);
    return { mod, files:await mod.FilesetResolver.forVisionTasks(`${BASE}/wasm`) };
  })().catch(e => { vision = null; throw e; });
  return vision;
}
/** GPU when the browser allows it, CPU otherwise. */
async function create(kind, options) {
  const { mod, files } = await load(), Task = mod[kind];
  try { return await Task.createFromOptions(files, { ...options, baseOptions:{ ...options.baseOptions, delegate:'GPU' } }); }
  catch { return Task.createFromOptions(files, { ...options, baseOptions:{ ...options.baseOptions, delegate:'CPU' } }); }
}

export const createHandLandmarker = (o = {}) =>
  create('HandLandmarker', { baseOptions:{ modelAssetPath:MODELS.hand }, runningMode:'VIDEO', numHands:2, ...o });
export const createFaceLandmarker = (o = {}) =>
  create('FaceLandmarker', { baseOptions:{ modelAssetPath:MODELS.face }, runningMode:'VIDEO', numFaces:1, ...o });
export const createSegmenter = (o = {}) =>
  create('ImageSegmenter', { baseOptions:{ modelAssetPath:MODELS.multiclass }, runningMode:'VIDEO', outputCategoryMask:true, outputConfidenceMasks:false, ...o });
