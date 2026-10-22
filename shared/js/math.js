/* Small math helpers shared by every experience. */

export const TAU = Math.PI*2;
export const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
export const lerp = (a,b,t) => a + (b-a)*t;
export const rand = (a,b) => a + Math.random()*(b-a);
/** Ease-out cubic, input clamped to 0..1. */
export const ease = t => 1 - Math.pow(1 - clamp(t,0,1), 3);
export const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);

export const V3 = {
  sub:   (a,b) => ({ x:a.x-b.x, y:a.y-b.y, z:a.z-b.z }),
  dot:   (a,b) => a.x*b.x + a.y*b.y + a.z*b.z,
  cross: (a,b) => ({ x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x }),
  len:   a => Math.hypot(a.x, a.y, a.z),
  dist:  (a,b) => Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z),
  norm:  a => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x:a.x/l, y:a.y/l, z:a.z/l }; },
};

/** Seeded PRNG: returns a function yielding 0..1. Re-seed per frame for "on twos" flicker. */
export function mulberry(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

/** In-place filter (no per-frame allocation, no splice-in-loop). */
export function prune(arr, keep) { let j = 0; for (let i = 0; i < arr.length; i++) if (keep(arr[i])) arr[j++] = arr[i]; arr.length = j; }
