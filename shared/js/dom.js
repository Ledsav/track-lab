/* DOM / device helpers shared by every experience. */

export const $ = id => document.getElementById(id);

export const matches = q => typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
export const isPhone = () => matches('(max-width: 760px)');
export const isPortrait = () => window.innerHeight > window.innerWidth;
/** Touch device or small screen: use the lighter tracking models. */
export const isMobile = () => matches('(pointer: coarse)') || Math.min(window.innerWidth, window.innerHeight) < 700;

/** Canvas letter-spacing where supported (Chrome/Edge); harmless elsewhere. */
export function spacing(ctx, px) { if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px'; }

/** Load a classic <script> once; resolves when it has run. */
const loaded = new Map();
export function loadScript(src) {
  if (!loaded.has(src)) loaded.set(src, new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous'; s.onload = resolve;
    s.onerror = () => { loaded.delete(src); reject(new Error('Failed to load ' + src)); };
    document.head.appendChild(s);
  }));
  return loaded.get(src);
}

export function toggleFullscreen() {
  const d = document, root = d.documentElement;
  if (!(d.fullscreenElement || d.webkitFullscreenElement)) (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
  else (d.exitFullscreen || d.webkitExitFullscreen).call(d);
}
export const canFullscreen = () => { const r = document.documentElement; return !!(r && (r.requestFullscreen || r.webkitRequestFullscreen)); };
