/* =============================================================================
   VOICE: Japanese call-outs for each technique
   -----------------------------------------------------------------------------
   Every line has a lead-in when you start charging and the name when it lands:
     領域展開 … 無量空処      術式順転 … 蒼      術式反転 … 赫      虚式 … 茈

   Source per line, first that works:
     1. a recorded clip at voice/<key>.mp3 (drop your own in, they get reverb + weight)
     2. the browser's Japanese speech synthesis (Edge's neural voices sound best)
   Text is fed as kana so every engine reads it right.
   ============================================================================= */

export const LINES = {
  domainStart: { kana:'りょういきてんかい', kanji:'領域展開' },
  domainName:  { kana:'むりょうくうしょ',   kanji:'無量空処' },
  blueStart:   { kana:'じゅつしきじゅんてん', kanji:'術式順転' },
  blueFire:    { kana:'あお',             kanji:'蒼' },
  redStart:    { kana:'じゅつしきはんてん', kanji:'術式反転' },
  redFire:     { kana:'あか',             kanji:'赫' },
  purpleStart: { kana:'きょしき',          kanji:'虚式' },
  purpleFire:  { kana:'むらさき',          kanji:'茈' },
};

const SAME_LINE_GAP = 2500;            // ms before the same line may repeat
const PREFERRED = /keita|otoya|ichiro|daichi|naoki|male|男/i;

/**
 * @param o.sound     the sound engine (decode / playVoice)
 * @param o.getLevel  () => 0..1 voice loudness (already includes master / mute)
 * @param o.getVoiceName () => saved voice name or ''
 */
export function createVoice({ sound, getLevel, getVoiceName }) {
  const synth = window.speechSynthesis || null;
  const clips = {}, last = {};
  let voices = [], busyUntil = 0, busyPriority = 0, clipsTried = false;
  const listeners = new Set();

  function refresh() {
    voices = synth ? synth.getVoices().filter(v => /^ja(-|_|$)/i.test(v.lang)) : [];
    listeners.forEach(fn => fn(voices));
  }
  if (synth) { refresh(); synth.addEventListener?.('voiceschanged', refresh); }

  function pick() {
    const want = getVoiceName();
    return voices.find(v => v.name === want) || voices.find(v => PREFERRED.test(v.name) && /natural|neural|online/i.test(v.name))
      || voices.find(v => PREFERRED.test(v.name)) || voices.find(v => /natural|neural|online|google/i.test(v.name)) || voices[0] || null;
  }

  /** Call from a click: unlocks speech on iOS and loads any recorded clips. */
  async function init() {
    if (synth) { const u = new SpeechSynthesisUtterance(''); u.volume = 0; synth.speak(u); }
    if (clipsTried || !sound.ready) return;
    clipsTried = true;
    await Promise.all(Object.keys(LINES).map(async key => {
      try {
        const r = await fetch(`voice/${key}.mp3`);
        if (r.ok) clips[key] = await sound.decode(await r.arrayBuffer());
      } catch { /* no clip: speech synthesis covers it */ }
    }));
  }

  /** priority: a higher one interrupts a lower one that is still speaking. */
  function say(key, { priority = 1, force = false } = {}) {
    const line = LINES[key], level = getLevel(), now = performance.now();
    if (!line || level <= 0) return;
    if (!force && last[key] && now - last[key] < SAME_LINE_GAP) return;
    if (!force && now < busyUntil && priority <= busyPriority) return;
    last[key] = now;
    if (clips[key]) {
      const dur = sound.playVoice(clips[key]);
      busyUntil = now + dur*1000; busyPriority = priority;
      return;
    }
    const v = pick(); if (!synth || !v) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(line.kana);
    u.voice = v; u.lang = v.lang; u.volume = Math.min(1, level); u.rate = .92; u.pitch = .75;
    synth.speak(u);
    busyUntil = now + 180*line.kana.length + 300; busyPriority = priority;
  }

  return {
    init, say,
    get voices() { return voices; },
    get hasJapanese() { return voices.length > 0 || Object.keys(clips).length > 0; },
    current() { return pick(); },
    onVoices(fn) { listeners.add(fn); fn(voices); },
  };
}
