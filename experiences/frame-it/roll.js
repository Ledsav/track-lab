/* =============================================================================
   ROLL: the polaroids you took, the big viewer, and the printer
   -----------------------------------------------------------------------------
   Photos live only in memory (data URLs) and vanish on reload: nothing uploads.
   Save ejects a print from the slot at the top, develops it from grey-blue to full
   colour like instant film, then downloads it. Prints queue one at a time.
   ============================================================================= */
import { $ } from '../../shared/js/dom.js';

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** iPhone / iPad (iPadOS reports as a Mac with touch). Safari there opens downloaded images instead of saving them. */
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const fileOf = photo => new File([photo.blob], fileName(photo), { type:photo.blob.type });

export class Roll {
  /** sound: { shot(name) }, max: photos kept */
  constructor({ sound, max = 12 }) {
    this.sound = sound; this.max = max; this.photos = []; this.current = null; this.queue = Promise.resolve();
    this.strip = $('roll'); this.viewer = $('viewer'); this.viewerImg = $('viewerImg');
    $('vClose').addEventListener('click', () => this.close());
    $('vSave').addEventListener('click', () => this.current && this.save(this.current));
    $('vShare').addEventListener('click', () => this.current && this.share(this.current));
    $('vDelete').addEventListener('click', () => this.current && this.remove(this.current));
    this.viewer.addEventListener('click', e => { if (e.target === this.viewer) this.close(); });
    addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });
    $('vShare').hidden = !navigator.share;
  }

  /** photo = { url (data URL), getBlob(), caption, time }. from = client rect the photo flies in from. */
  add(photo, from) {
    photo.blob = null; photo.getBlob().then(b => { photo.blob = b; });   // ready before anyone taps Share / Save
    this.photos.unshift(photo);
    const el = document.createElement('button');
    el.className = 'pol'; el.type = 'button'; el.title = `${photo.caption}: open`;
    el.innerHTML = `<img src="${photo.url}" alt="Photo through the ${photo.caption} lens">`;
    el.addEventListener('click', () => this.open(photo));
    photo.el = el;
    this.strip.prepend(el);
    while (this.photos.length > this.max) this.drop(this.photos[this.photos.length - 1]);
    this.strip.classList.toggle('has', this.photos.length > 0);
    if (from && !reduced()) {                                               // fly from the frame into its slot (FLIP)
      const to = el.getBoundingClientRect(), s = Math.max(.2, from.width/to.width);
      const dx = from.left + from.width/2 - (to.left + to.width/2), dy = from.top + from.height/2 - (to.top + to.height/2);
      el.animate([
        { transform:`translate(${dx}px, ${dy}px) scale(${s}) rotate(-6deg)`, opacity:.9 },
        { transform:`translate(${dx*.25}px, ${dy*.35}px) scale(${1 + (s - 1)*.25}) rotate(4deg)`, opacity:1, offset:.6 },
        { transform:'none', opacity:1 },
      ], { duration:650, easing:'cubic-bezier(.2,.8,.2,1)' });
    }
  }
  drop(photo) {
    this.photos = this.photos.filter(p => p !== photo);
    photo.el?.remove();
    this.strip.classList.toggle('has', this.photos.length > 0);
  }

  open(photo) {
    this.current = photo; this.viewerImg.src = photo.url; this.viewer.hidden = false;
    requestAnimationFrame(() => this.viewer.classList.add('on'));
  }
  close() {
    if (this.viewer.hidden) return;
    this.viewer.classList.remove('on'); this.current = null;
    setTimeout(() => { if (!this.current) this.viewer.hidden = true; }, 220);
  }
  remove(photo) { this.close(); this.drop(photo); }

  /**
   * Save: on iPhone, open the share sheet ("Save Image") straight from the tap (it needs the tap's
   * user activation, so the file is already built) while the print plays; elsewhere, print then download.
   */
  save(photo) {
    if (isIOS() && photo.blob && navigator.canShare && navigator.canShare({ files:[fileOf(photo)] })) {
      navigator.share({ files:[fileOf(photo)], title:'Frame It' }).catch(() => {});
      return this.print(photo, { download:false });
    }
    return this.print(photo);
  }

  async share(photo) {
    if (!photo.blob) photo.blob = await photo.getBlob();
    const file = fileOf(photo);
    try {
      if (navigator.canShare && navigator.canShare({ files:[file] })) await navigator.share({ files:[file], title:'Frame It' });
      else this.print(photo);
    } catch { /* share sheet dismissed */ }
  }

  /** Eject, develop, download. Queued so prints never overlap. */
  print(photo, opts = {}) {
    this.close();
    this.queue = this.queue.then(() => this.runPrint(photo, opts));
    return this.queue;
  }
  async runPrint(photo, { download:dl = true } = {}) {
    const printer = $('printer'), print = $('print'), img = $('printImg'), quick = reduced();
    img.src = photo.url; img.classList.remove('developed');
    printer.classList.add('on'); print.getAnimations().forEach(a => a.cancel());
    this.sound.shot('motor');
    const eject = print.animate([                                           // motor-driven: pauses and lurches, not one smooth glide
      { transform:'translateY(-102%)' }, { transform:'translateY(-64%)', offset:.32 }, { transform:'translateY(-60%)', offset:.42 },
      { transform:'translateY(-22%)', offset:.78 }, { transform:'translateY(-18%)', offset:.86 }, { transform:'translateY(0)' },
    ], { duration:quick ? 300 : 1500, easing:'linear', fill:'forwards' });
    await done(eject, quick ? 300 : 1500);
    img.classList.add('developed');                                         // CSS transition: grey-blue → full colour
    await wait(quick ? 200 : 2300);
    if (dl) download(photo);
    this.sound.shot('done');
    await wait(900);
    const out = print.animate([{ transform:'translateY(0)', opacity:1 }, { transform:'translateY(14px) rotate(2deg)', opacity:0 }], { duration:350, easing:'ease-in', fill:'forwards' });
    await done(out, 350);
    printer.classList.remove('on'); out.cancel(); eject.cancel();
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));
/** An animation's end, or its duration + a margin if the tab stops rendering (hidden / backgrounded). */
const done = (anim, ms) => Promise.race([anim.finished.catch(() => {}), wait(ms + 250)]);
const fileName = p => `frame-it-${p.caption.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date(p.time).toISOString().slice(0, 19).replace(/[:T]/g, '')}.jpg`;
function download(photo) {
  const a = document.createElement('a'); a.href = photo.url; a.download = fileName(photo);
  document.body.appendChild(a); a.click(); a.remove();
}
