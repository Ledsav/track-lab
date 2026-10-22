// Write sitemap.xml from experiences/registry.js, so a new experience is listed without anyone remembering to.
// Runs in the deploy workflow; run it locally after adding a page outside the registry.
//   node scripts/sitemap.mjs
//   node scripts/sitemap.mjs --list http://localhost:8080/track-lab/   print the pages instead (the link check crawls them)
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { experiences } from '../experiences/registry.js';

const list = process.argv.indexOf('--list');
const SITE = list > -1 ? process.argv[list + 1] : 'https://www.albertovaldesrey.com/track-lab/';
const today = new Date().toISOString().slice(0, 10);
const urls = [
  { loc:SITE, lastmod:today },
  ...experiences.map(e => ({ loc:`${SITE}experiences/${e.slug}/`, lastmod:today })),
  { loc:`${SITE}privacy.html`, lastmod:today },
];
if (list > -1) { console.log(urls.map(u => u.loc).join(' ')); process.exit(0); }
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;
await writeFile(fileURLToPath(new URL('../sitemap.xml', import.meta.url)), xml);
console.log(`sitemap.xml: ${urls.length} URLs`);
