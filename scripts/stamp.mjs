// Cache-busting for deploys: append ?v=<version> to every relative module import and
// to local script / style / asset URLs in HTML, so a browser can never mix files from
// two deploys (GitHub Pages caches each file for 10 minutes, independently).
// Runs on the CI copy only; source files in git stay unstamped.
//   node scripts/stamp.mjs <version> [root]
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

const [version, root = '.'] = process.argv.slice(2);
if (!version) { console.error('Usage: node scripts/stamp.mjs <version> [root]'); process.exit(1); }
const SKIP = new Set(['.git', '.github', '.claude', 'node_modules', 'scripts']);
const v = `?v=${version}`;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes:true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

let files = 0, refs = 0;
for await (const file of walk(resolve(root))) {
  const ext = extname(file);
  if (ext !== '.js' && ext !== '.html') continue;
  const src = await readFile(file, 'utf8');
  const count = () => (refs++, '');
  let out = ext === '.js'
    // import … from './x.js' / export … from '../y.js'
    ? src.replace(/(\bfrom\s*['"])(\.{1,2}\/[^'"?]+\.js)(['"])/g, (m, a, p, b) => a + p + v + b + count())
    // src="main.js", href="style.css", src="bgm.mp3" … (not links to pages, not absolute URLs)
    : src.replace(/(\b(?:src|href)=")((?![a-z]+:|\/\/|#)[^"?]+\.(?:js|css|svg|mp3|json))(")/g, (m, a, p, b) => a + p + v + b + count());
  if (out !== src) { await writeFile(file, out); files++; }
}
console.log(`stamped ${refs} reference(s) in ${files} file(s) with ${v}`);
