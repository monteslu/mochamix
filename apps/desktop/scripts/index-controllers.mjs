/**
 * Build a JSON index of the bundled Mixxx controller mappings (name + file) so the
 * picker doesn't parse 144 XMLs at launch. Run at build time.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'resources', 'controllers');
const files = readdirSync(dir).filter((f) => f.endsWith('.midi.xml'));
const index = [];
for (const file of files) {
  const xml = readFileSync(join(dir, file), 'utf8');
  // <info><name>…</name> (cheap regex; full parse happens on load)
  const name = (/<name>([^<]+)<\/name>/i.exec(xml)?.[1] ?? file.replace(/\.midi\.xml$/, '')).trim();
  const author = (/<author>([^<]*)<\/author>/i.exec(xml)?.[1] ?? '').trim();
  index.push({ file, name, author });
}
index.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 0));
console.log(`indexed ${index.length} controller mappings → resources/controllers/index.json`);
