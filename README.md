# Track Lab

Motion-tracking experiences that run entirely in the browser. Point a camera at yourself and play.
Video never leaves your device: tracking runs locally with [MediaPipe](https://ai.google.dev/edge/mediapipe).

**Live:** https://www.albertovaldesrey.com/track-lab/

| # | Experience | Tracks | What it does |
|---|---|---|---|
| 01 | [Cursed Hands](experiences/cursed-hands/) | hands + face | Jujutsu Kaisen hand seals with Japanese voice lines, an exorcism wave mode, and Gojo face filters (eyes, hair) |
| 02 | [Frame It](experiences/frame-it/) | hands | An instant camera made of your fingers: hold your hands like a camera to see the world through five lenses, press a finger like a shutter to print a polaroid |
| 03 | [Sigil](experiences/sigil/) | hands | Draw magic in the air: pinch to ink a circle, draw a sign inside it (wave, triangle, spiral, star), then open your palm and push to cast water, fire, wind or light. Two signs combine; Apprentice mode grades your tracing |

## Structure

```
track-lab/
├── index.html                 hub: gallery of experiences
├── assets/                    hub-only styles and script
├── brand/<slug>/              logos: mark.svg (colour), mark-mono.svg; track-lab/ also has favicon.svg
├── experiences/
│   ├── registry.js            list of experiences the hub renders (one entry each)
│   ├── _template/             starter copied by `npm run new`
│   ├── cursed-hands/          one folder per experience, self-contained
│   │   ├── index.html
│   │   ├── style.css
│   │   ├── main.js        techniques, effects, panel, app loop
│   │   ├── curses.js      exorcism mode: curse designs + wave logic
│   │   ├── voice.js       Japanese call-outs (recorded clips or speech synthesis)
│   │   ├── face-fx.js     optional face filters: glowing recoloured eyes, dyed hair
│   │   └── bgm.mp3
│   ├── frame-it/
│   │   ├── main.js        gestures (camera grip, tilt dial, shutter press), frame tracking, render
│   │   ├── lenses.js      Inverted, X-Ray, Thermal, Manga Ink, Prism
│   │   ├── photo.js       straighten the frame into a photo, polaroid card
│   │   ├── roll.js        photo roll, viewer, polaroid printer
│   │   └── music/         CC0 lo-fi by TAD (sources in music/README.md)
│   └── sigil/
│       ├── main.js        pen (pinch) and palm (charge, push, wipe) gestures, sigil, panel, render
│       ├── glyphs.js      ring test and sign recognition ($1-style templates + shape checks)
│       ├── ink.js         nib strokes and the parchment texture
│       ├── spells.js      the four elements, their combinations, the ink splash of a failed ring
│       └── lessons.js     Apprentice mode: lessons, tracing accuracy, grades
├── shared/
│   ├── js/hands.js            camera start + hand tracking (Tasks Vision), skeleton / mirrored video drawing
│   ├── js/vision.js           on-demand face landmarks (irises, lids) + hair/skin/clothes segmentation
│   ├── js/math.js             clamp, lerp, ease, V3, seeded random, prune…
│   ├── js/dom.js              $, device checks, loadScript, fullscreen
│   └── css/experience.css     optional chrome: full-screen stage, start overlay, back link
├── .claude/skills/create-project/   skill: brainstorm → build → test → logo → ship a new experience
└── scripts/
    ├── serve.mjs              zero-dependency dev server
    ├── stamp.mjs              cache-busting step used by the deploy workflow
    └── new-experience.mjs     scaffolds an experience and registers it
```

No build step. Everything is plain ES modules served as static files, so GitHub Pages hosts the repo as-is.
`.nojekyll` is there so Pages serves folders that start with `_` (like `_template`).

## Develop

```bash
npm run dev
```

Opens on http://localhost:5173/. The camera needs a secure context, and `localhost` counts as one.

## Add an experience

```bash
npm run new -- air-drums "Air Drums" hands
```

This copies `experiences/_template` (camera, hand skeleton, fingertip trail) to `experiences/air-drums/`
and appends an entry to `experiences/registry.js`. Fill in the `blurb`, `tags` and `cover` there, then build the idea in `main.js`.

Each experience is a standalone page. Use whatever you want from `shared/`, or nothing at all.

## Deploy

Push to `main` and `.github/workflows/pages.yml` deploys it. On the way it runs `scripts/stamp.mjs`,
which adds `?v=<commit>` to every local module / script / style URL, so a browser can never mix
cached files from two deploys (Pages caches each file for 10 minutes). Source files stay unstamped.
