/**
 * control-coverage.mjs — audit Mixxx control-key coverage.
 *
 * Every Mixxx mapping (res/controllers) drives the deck/master via named ControlObjects
 * referenced by (group, key) strings — directly in the .midi.xml `<key>` of non-script
 * controls, and in the device scripts via engine.getValue/setValue/... + midi-components
 * inKey/outKey. This is the COMMON INTERFACE: support every key the mappings use and the
 * controllers' DJ features all work.
 *
 * This tool enumerates every distinct control key the bundled mappings reference, counts
 * how many mappings use each (impact), and marks whether our engine IMPLEMENTS behavior
 * for it (vs. the bus merely storing the value with nothing reacting). Output is a
 * ranked gap list — the burndown for "better than Mixxx".
 *
 * Usage: node scripts/control-coverage.mjs [--all]   (--all shows implemented too)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CTRL = join(here, '../apps/desktop/resources/controllers');
const ENGINE = join(here, '../packages/audio-engine/src');

// --- 1. Extract every control key each mapping references -------------------------
// key → Set of mapping basenames that use it.
const usage = new Map();
const note = (key, file) => {
  if (!key || key.length > 64) return;
  if (!usage.has(key)) usage.set(key, new Set());
  usage.get(key).add(file);
};

// Normalize indexed/group keys to a FAMILY so e.g. hotcue_1_activate, hotcue_2_activate
// collapse to hotcue_N_activate (one behavior to implement covers all N).
const family = (k) =>
  k
    .replace(/hotcue_\d+/g, 'hotcue_N')
    .replace(/beatloop_[\d.]+/g, 'beatloop_X')
    .replace(/beatjump_[\d.]+/g, 'beatjump_X')
    .replace(/_\d+(_|$)/g, '_N$1');

const files = readdirSync(CTRL);
for (const f of files) {
  if (f.endsWith('.midi.xml')) {
    const xml = readFileSync(join(CTRL, f), 'utf8');
    // direct <key>name</key> on a control (skip script-prefixed dotted keys)
    for (const m of xml.matchAll(/<key>([^<]+)<\/key>/g)) {
      const k = m[1].trim();
      if (!k.includes('.') && !k.includes('[')) note(family(k), f);
    }
  } else if (f.endsWith('.js')) {
    const js = readFileSync(join(CTRL, f), 'utf8');
    // engine.getValue/setValue/getParameter/setParameter/makeConnection(group, "key"
    for (const m of js.matchAll(
      /engine\.(?:get|set)(?:Value|Parameter)\([^,]+,\s*["']([a-zA-Z][a-zA-Z0-9_]*)["']/g,
    )) {
      note(family(m[1]), f);
    }
    for (const m of js.matchAll(/engine\.makeConnection\([^,]+,\s*["']([a-zA-Z][a-zA-Z0-9_]*)["']/g)) {
      note(family(m[1]), f);
    }
    // midi-components inKey/outKey/key: "name"
    for (const m of js.matchAll(/(?:inKey|outKey|key)\s*[:=]\s*["']([a-zA-Z][a-zA-Z0-9_]*)["']/g)) {
      note(family(m[1]), f);
    }
  }
}

// --- 2. What does our engine IMPLEMENT behavior for? -----------------------------
// A control is "implemented" if some engine source SUBSCRIBES to it (reacts), not just
// if the bus defines it. Heuristic: the key string (or its family stem) appears in an
// engine control/worklet/sync file outside of keys.ts/standard-controls.ts/tests.
const engineSrc = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      engineSrc.push(readFileSync(p, 'utf8'));
    }
  }
};
walk(ENGINE);
// Also count the renderer controls (some live there) + control-bus consumers.
walk(join(here, '../apps/desktop/src/renderer'));
const haystack = engineSrc.join('\n');

// Map a control family back to a stem to search for in engine code.
const implemented = (fam) => {
  const stem = fam
    .replace(/_N(_|$)/g, '$1')
    .replace(/hotcue_N/, 'hotcue')
    .replace(/beatloop_X/, 'beatloop')
    .replace(/beatjump_X/, 'beatjump')
    .replace(/_$/, '');
  // camelCase variant our DeckKeys often use (sync_enabled → syncEnabled)
  const camel = stem.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return haystack.includes(`"${stem}"`) || haystack.includes(`'${stem}'`) ||
    new RegExp(`\\b${camel}\\b`).test(haystack) ||
    haystack.includes(stem);
};

// --- 3. Report -------------------------------------------------------------------
const showAll = process.argv.includes('--all');
const rows = [...usage.entries()]
  .map(([key, set]) => ({ key, count: set.size, impl: implemented(key) }))
  .sort((a, b) => b.count - a.count);

const missing = rows.filter((r) => !r.impl);
const done = rows.filter((r) => r.impl);

console.log(`\nControl-key coverage across ${files.filter((f) => f.endsWith('.midi.xml')).length} mappings`);
console.log(`  distinct control families referenced: ${rows.length}`);
console.log(`  implemented: ${done.length}   MISSING: ${missing.length}\n`);
console.log('MISSING (ranked by how many mappings use them):');
console.log('  uses  control');
for (const r of missing) console.log(`  ${String(r.count).padStart(4)}  ${r.key}`);
if (showAll) {
  console.log('\nIMPLEMENTED:');
  for (const r of done) console.log(`  ${String(r.count).padStart(4)}  ${r.key}`);
}
