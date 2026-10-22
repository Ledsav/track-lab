---
name: create-project
description: Create a new Track Lab experience end to end — brainstorm the idea with the user, scaffold it, build it on the shared tracking modules, design its logo, test it in the browser without a camera, register it on the hub and ship it. Use when the user wants a new motion-tracking experience, game or toy in Track Lab ("create project", "new experience", "add X to the lab").
---

# Create a Track Lab project

An experience is one self-contained page in `experiences/<slug>/` that turns camera tracking
(hands today; face / pose when someone adds them) into something people want to play with.
This skill takes an idea from a sentence to a live, registered, tested page.

Work through the phases in order and keep the task list updated. **Two checkpoints need the user:**
the spec (end of phase 1) and the logo direction (phase 5). Everything else, just do.

## 1. Brainstorm → spec (checkpoint)

If `superpowers:brainstorming` is available, use it; otherwise ask at most five questions in one
message. Pin down:

- **The fantasy**: one sentence. "You are Gojo", "you conduct an orchestra", "you are a puppeteer".
- **Tracker**: hands / face / pose. Check `shared/js/`: `hands.js` (hand landmarks, drives the camera) and
  `vision.js` (face landmarks with irises and eyelids, plus hair / skin / clothes segmentation, loaded on demand —
  see `cursed-hands/face-fx.js` for how to use it). Pose would mean adding it to `vision.js` (PoseLandmarker).
- **Core gestures**: 2–4 at most, each readable from 2D landmarks, each with a clear charge → release beat.
  Prefer gestures that don't fight each other (see the pose debouncing in `cursed-hands/main.js`, section 6).
- **Feedback**: what the screen and speakers do the instant a gesture registers. Juice is the product.
- **Optional mode**: a score / wave / challenge loop on top of free play (see `cursed-hands/curses.js`).
- **Look**: a reference (anime, film, game, art style) and 2–3 adjectives; palette of 2–3 colours.

Write the spec as a short block (title, slug, fantasy, tracker, gestures table, feedback, mode, look)
and **wait for the user's OK** before building.

## 2. Scaffold

```bash
npm run new -- <slug> "<Title>" <tracker>
```

This copies `experiences/_template/` and appends a registry entry. Fill the entry right away:
`blurb` (1–2 sentences, what you *do*), `tags`, `cover.colors` (the palette), `cover.glyph`.

## 3. Build

Read `references/conventions.md` before writing code. In short:

- Structure `main.js` like `cursed-hands/main.js`: numbered sections (Config, Sound, Draw, Effects,
  Gestures, Techniques/Mechanics, Panel, App). Every tunable number lives in `CONFIG`.
- Use `shared/js/` (`math.js`, `dom.js`, `hands.js`) — don't re-inline helpers. Split big subsystems
  into sibling modules (`curses.js`, `voice.js` pattern).
- Render loop at display rate; fold tracker results in when they arrive; scale everything by `u = min(W, H)`.
- Audio: synthesize with WebAudio, route through master / effects / voice / music buses, start from a click.
- Settings panel: master + per-bus volume, reduce flashes, show skeleton, any calibration sliders.
  Persist under `localStorage['track-lab:<slug>:settings']` in try/catch.
- Phones: portrait camera, bottom-sheet panel, nothing under the notch, lighter model on mobile.
- Keep `window.<camelSlug> = new App()` as a debug handle — testing depends on it.

Use the `frontend-design` skill for the page chrome and the `animate` skill for motion decisions.
Visual quality bar: if a drawn element reads as clip-art or an emoji, redo it — asymmetry, silhouette
and a reference beat round symmetric shapes.

## 4. Test (no camera needed)

The Claude browser pane blocks the camera and pauses `requestAnimationFrame` when hidden, so drive the
app by hand. Follow `references/testing.md`:

1. `node --check --input-type=module < file.js` for every module.
2. Start the dev server (`preview_start` with the `track-lab` launch config, or `npm run dev`).
3. Load the page, check the console is clean, then inject a fake camera stream, step frames manually,
   force poses / game states through the debug handle, and export canvas snapshots to look at.
4. Check: each gesture fires, each mode's win/lose path, settings persist, phone width (375 px) layout.

Say plainly what could not be tested (real hand tracking, audio output, speech voices).

## 5. Logo (checkpoint)

Run the `logo-design:logo-design` skill for the experience (fast track). Brief it with the spec's
fantasy, adjectives and palette, plus the lab context: dark hub, cards with a 16:10 cover, favicon use.
Show the concept sheet and **wait for the user's pick**. Then save the final marks as:

```
brand/<slug>/mark.svg          symbol, transparent, brand colours
brand/<slug>/mark-mono.svg     one colour (currentColor or white)
```

and set `cover.logo: 'brand/<slug>/mark.svg'` in the registry entry (the hub shows it on the card,
falling back to `cover.glyph`). Use it as the page favicon (`<link rel="icon" href="../../brand/<slug>/mark.svg">`).

## 6. Register & ship

- Registry entry complete (blurb, tags, cover, `added` date). Order = order on the hub.
- README: add a row to the experiences table and, if new modules were added, the structure tree.
- Load the hub, check the card renders and links.
- Commit with a message that says what the experience is. Push only when the user says to;
  GitHub Pages deploys `main` automatically to https://www.albertovaldesrey.com/track-lab/.
- After pushing, check `gh run list -R Ledsav/track-lab` and curl the live page once.
