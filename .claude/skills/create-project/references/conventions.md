# Track Lab conventions

## Files

```
experiences/<slug>/
  index.html     page shell: stage (video + canvas), start overlay, topbar with back link, panel
  style.css      page styles (or only additions on top of shared/css/experience.css)
  main.js        the app, as an ES module
  <system>.js    big subsystems split out (game modes, voice, level data…)
  assets…        audio / images next to the page; keep each file < 5 MB
brand/<slug>/    logo marks (mark.svg, mark-mono.svg)
```

No build step, no npm dependencies at runtime. Tracking comes only from `shared/js/hands.js` and
`shared/js/vision.js` (MediaPipe Tasks Vision via jsDelivr, exact version). Never add another MediaPipe
build (e.g. the legacy `@mediapipe/hands` scripts): two runtimes on one page abort every frame. Everything must work from `file`-less static hosting under `/track-lab/`,
so use relative URLs only (`../../shared/js/…`), never root-absolute ones.

## Code shape (see `experiences/cursed-hands/main.js`)

1. **Config**: every tunable number, with a comment saying what it does and its unit.
2. **Utilities**: import from `shared/js/math.js` and `dom.js`; a local `Clock` if needed.
3. **Sound**: `createSound(getLevels)` with buses: loops/hits → effects; voice → voice; music → master.
4. **Draw**: stateless painters. Sizes scale with `u = min(W, H)`.
5. **Effects**: particles, waves, titles, shake / flash / impact / tint, with a reduce-flashes path.
6. **Gestures**: landmarks → per-hand reading → debounced poses (EMA + hysteresis) → detectors.
7. **Mechanics**: one class per technique / tool: `update(dt, input)` mutates, `render*` only draws, `status()` feeds the panel.
8. **Panel**: cards + HUD chips + settings, persisted.
9. **App**: tracker start from a click, render loop, layer order written out in `render()`.

Mechanics talk to other systems through a `world` object (`{ fx, sound, voice, game }`), not imports,
so a mode can be bolted on without touching every technique.

## UX rules

- Start from an explicit click (camera + audio permissions). Show a clear error with a fix if it fails.
- Mirror the camera (selfie view); handedness labels from MediaPipe are inverted for mirrored input.
- Show how to do each gesture in the panel, with a live state and charge bar per gesture.
- A visible "back to lab" link (the brand in the topbar).
- Settings: master volume, mute, per-bus toggles + volumes, reduce flashes, fill screen, skeleton.
- Big screens open the panel by default; phones use a bottom sheet and a stage tap closes it.
- `prefers-reduced-motion` and the reduce-flashes toggle must remove white / inverted frames.

## Registry entry

```js
{
  slug: 'air-drums',
  title: 'Air Drums',
  blurb: 'One or two sentences about what you do.',
  tracker: 'hands',                 // hands | face | pose
  tags: ['music', 'gestures'],
  cover: { glyph: '鼓', colors: ['#…', '#…', '#…'], logo: 'brand/air-drums/mark.svg' },
  added: 'YYYY-MM-DD',
}
```
