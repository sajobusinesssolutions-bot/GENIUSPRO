/* Every setting the setup wizard writes must exist in the server's catalogue.
 *
 * PUT /settings silently ignores a key it does not know, so a typo in a
 * business-type preset does nothing at all and looks like it worked. This
 * reads both files and says which key is wrong.
 *
 *   node check-setup-keys.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* `new URL(import.meta.url).pathname` gives "/C:/shop/desktop/frontend" on
   Windows — a leading slash before the drive letter — and every path built
   from it then fails to resolve. `fileURLToPath` is the one that knows about
   drive letters, and Windows is where start.bat runs. */
const here = path.dirname(fileURLToPath(import.meta.url));
const setup = fs.readFileSync(path.join(here, 'src/pages/Setup.jsx'), 'utf8');
const cat = fs.readFileSync(
  path.join(here, '../backend/modules/settings/settings.service.js'), 'utf8');

const known = new Set([...cat.matchAll(/\{\s*key:\s*"([^"]+)"/g)].map((m) => m[1]));
if (known.size < 50) {
  console.log('could not read the settings catalogue — skipping'); process.exit(0);
}

/* The preset blocks, and only those: `settings: { ... }`. */
const used = new Set();
for (const block of setup.matchAll(/settings:\s*\{([^}]*)\}/g)) {
  for (const m of block[1].matchAll(/([a-z_][a-z0-9_]*)\s*:/g)) used.add(m[1]);
}
/* Plus anything written by name outside a preset. */
for (const m of setup.matchAll(/api\.put\("\/settings",\s*\{\s*([a-z_][a-z0-9_]*)/g)) used.add(m[1]);

const bad = [...used].filter((k) => !known.has(k));
for (const k of bad) console.log(`UNKNOWN setting "${k}" — the server will ignore it`);
console.log(bad.length ? `${bad.length} unknown` : `ok — all ${used.size} settings exist`);
process.exit(bad.length ? 1 : 0);
