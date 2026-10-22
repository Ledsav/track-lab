# Testing an experience without a camera

The browser pane denies camera access, and while the app window is hidden it pauses
`requestAnimationFrame` and screenshots time out. These snippets work around all three.
Run them with the browser `javascript_tool` on the experience page. `app` is the debug handle
(`window.<camelSlug>`, e.g. `window.cursedHands`).

## 1. Fake camera + manual frame stepping

```js
const app = window.cursedHands;
const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
const g = c.getContext('2d');
g.fillStyle = '#2a2622'; g.fillRect(0, 0, 1280, 720);            // stand-in "room"
g.fillStyle = '#6b5a4c'; g.beginPath(); g.ellipse(640, 330, 120, 160, 0, 0, 6.3); g.fill();   // stand-in "person"
const v = document.getElementById('video');
v.srcObject = c.captureStream(30); await v.play();
app.sound.init(); app.panel.showStage(); app.running = true; app.lastT = performance.now();
// rAF is paused in a hidden pane: step frames yourself
window.step = async sec => { const end = performance.now() + sec*1000;
  while (performance.now() < end) { app.frame(performance.now()); await new Promise(r => setTimeout(r, 16)); } };
await step(1);
```

## 2. Force gestures

Pose state lives in `app.poses.state[<name>]`. Hold one on with an interval while stepping
(the tracker would otherwise decay it):

```js
const B = app.poses.state.blue;
const hold = setInterval(() => Object.assign(B, { on:true, sig:1, seen:true, pos:{ x:600, y:400 }, size:100, dir:{ x:0, y:-1 } }), 2);
await step(.8); clearInterval(hold);
```

Fire things directly when you only need the consequence (e.g. `app.red.onImpact(x, y, { r:30 }, { u:720 })`),
and drive game state through the game object (`app.game.start()`, `spawn(kind)`, set `lives`, `z`…).

## 3. Look at the canvas

Screenshots fail while the window is hidden, so export the canvas to a file through a tiny local sink.
Write this to the scratchpad and run it in the background with `node sink.cjs <scratchpad-dir>`:

```js
const http = require('http'), fs = require('fs'), path = require('path'), dir = process.argv[2];
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method !== 'POST') return res.end('ok');
  const chunks = []; req.on('data', c => chunks.push(c));
  req.on('end', () => { fs.writeFileSync(path.join(dir, path.basename(req.url) || 'shot.jpg'), Buffer.concat(chunks)); res.end('saved'); });
}).listen(5190, '127.0.0.1');
```

Then in the page:

```js
window.snap = async (name, crop = [0, 0, 1280, 720]) => {
  const src = document.getElementById('canvas'), c = document.createElement('canvas');
  c.width = crop[2]; c.height = crop[3];
  c.getContext('2d').drawImage(src, ...crop, 0, 0, crop[2], crop[3]);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .85));
  return (await fetch('http://127.0.0.1:5190/' + name, { method:'POST', body:blob })).text();
};
await step(.3); await snap('check.jpg');
```

Read the JPEG from the scratchpad and actually look at it. Stop the sink when done.

## 4. Clean up

`localStorage.clear()` in the pane after testing settings, so test values don't linger.

## 5. Test the real camera path too

Driving the canvas directly skips camera start and the tracker runtime, which is where
integration bugs live (e.g. two MediaPipe runtimes on one page aborting every frame).
Hand the app a fake camera and use the real start button:

```js
navigator.mediaDevices.getUserMedia = async () => fakeCanvas.captureStream(30);
await app.start();                       // real startHands(): camera + HandLandmarker
```

A hidden pane does not fire `requestVideoFrameCallback`, so the tracker loop won't run by itself;
call it directly to prove it works next to other models: `app.tracking.tracker.detectForVideo(video, performance.now())`.
Then read the console for errors *and* `read_network_requests` for 404s. Console logs persist across
reloads in the pane, so check timestamps before blaming the current load.
