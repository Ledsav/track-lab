# Track Lab

Motion-tracking experiences that run entirely in the browser. Point a camera at yourself and play.
Video never leaves your device: tracking runs locally with [MediaPipe](https://ai.google.dev/edge/mediapipe).

**Live:** https://www.albertovaldesrey.com/track-lab/

| # | Experience | Tracks | What it does |
|---|---|---|---|
| 01 | [Cursed Hands](experiences/cursed-hands/) | hands + face | Jujutsu Kaisen hand seals with Japanese voice lines, an exorcism wave mode, and Gojo face filters (eyes, hair) |

## Structure

```
track-lab/
├── index.html                 hub: gallery of experiences
├── assets/                    hub-only styles and script
├── brand/<slug>/              logos: mark.svg (colour), mark-mono.svg; track-lab/ also has favicon.svg
├── experiences/
│   ├── registry.js            list of experiences the hub renders (one entry each)
│   ├── _template/             starter copied by `npm run new`
│   └── cursed-hands/          one folder per experience, self-contained
│       ├── index.html
│       ├── style.css
│       ├── main.js        techniques, effects, panel, app loop
│       ├── curses.js      exorcism mode: curse designs + wave logic
│       ├── voice.js       Japanese call-outs (recorded clips or speech synthesis)
│       ├── face-fx.js     optional face filters: glowing recoloured eyes, dyed hair
│       └── bgm.mp3
├── shared/
│   ├── js/hands.js            MediaPipe Hands loader, camera start, skeleton / mirrored video drawing
│   ├── js/vision.js           on-demand face landmarks (irises, lids) + hair/skin/clothes segmentation
│   ├── js/math.js             clamp, lerp, ease, V3, seeded random, prune…
│   ├── js/dom.js              $, device checks, loadScript, fullscreen
│   └── css/experience.css     optional chrome: full-screen stage, start overlay, back link
├── .claude/skills/create-project/   skill: brainstorm → build → test → logo → ship a new experience
└── scripts/
    ├── serve.mjs              zero-dependency dev server
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

GitHub Pages serves the `main` branch from the repository root. Push and it's live.
