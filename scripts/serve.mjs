// Zero-dependency static server for local development.
// Camera access needs a secure context; http://localhost counts as one.
//   node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const TYPES = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.mp4':'video/mp4', '.woff2':'font/woff2', '.ico':'image/x-icon',
};

createServer(async (req, res) => {
  try {
    // like GitHub Pages: the site also answers under /track-lab/ (pages using <base href="/track-lab/"> work locally)
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/track-lab(?=\/|$)/, '') || '/');
    let file = join(ROOT, path);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const s = await stat(file).catch(() => null);
    if (s?.isDirectory()) {
      if (!req.url.split('?')[0].endsWith('/')) { res.writeHead(301, { Location: req.url.replace(/(\?|$)/, '/$1') }).end(); return; }
      file = join(file, 'index.html');
    }
    const body = await readFile(file);
    const headers = { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    // byte ranges, like GitHub Pages: browsers need them to read an audio file's length and to seek in it
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? +range[1] : Math.max(0, body.length - +range[2]);
      const end = range[1] && range[2] ? Math.min(+range[2], body.length - 1) : body.length - 1;
      if (start >= body.length || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
      res.end(body.subarray(start, end + 1)); return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(body);
  } catch {
    // like GitHub Pages: missing pages get the custom 404 page, with a 404 status
    const page = await readFile(join(ROOT, '404.html')).catch(() => null);
    if (page) res.writeHead(404, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' }).end(page);
    else res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`Track Lab → http://localhost:${PORT}/`));
