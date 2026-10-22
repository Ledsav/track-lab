// Scaffold a new experience from experiences/_template and register it on the hub.
//   node scripts/new-experience.mjs <slug> "<Title>" [tracker]
//   npm run new -- air-drums "Air Drums" hands
import { cp, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const [slug, title = slug, tracker = 'hands'] = process.argv.slice(2);

if (!slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
  console.error('Usage: node scripts/new-experience.mjs <kebab-case-slug> "<Title>" [tracker]');
  process.exit(1);
}
const src = join(ROOT, 'experiences', '_template'), dest = join(ROOT, 'experiences', slug);
if (await access(dest).then(() => true, () => false)) { console.error(`experiences/${slug} already exists`); process.exit(1); }

await cp(src, dest, { recursive: true });
for (const f of await readdir(dest)) {
  const p = join(dest, f), text = await readFile(p, 'utf8');
  if (text.includes('__TITLE__')) await writeFile(p, text.replaceAll('__TITLE__', title));
}

const registry = join(ROOT, 'experiences', 'registry.js');
const reg = await readFile(registry, 'utf8'), end = reg.lastIndexOf('];');
const entry = `  {
    slug: '${slug}',
    title: ${JSON.stringify(title)},
    blurb: 'TODO: one or two sentences about what it does.',
    tracker: '${tracker}',
    tags: [],
    cover: { glyph: '${title.trim()[0]?.toUpperCase() || '◎'}', colors: ['#3a3f4a', '#d6ff3d', '#111318'] },
    added: '${new Date().toISOString().slice(0, 10)}',
  },
`;
await writeFile(registry, reg.slice(0, end) + entry + reg.slice(end));

console.log(`Created experiences/${slug}/ and registered it in experiences/registry.js`);
console.log(`Run "npm run dev" and open http://localhost:5173/experiences/${slug}/`);
