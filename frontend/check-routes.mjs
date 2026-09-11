/* Every API path the interface calls, matched against the routes the server
 * actually registers.
 *
 * The interface calling a path the server does not serve parses perfectly,
 * builds, ships, and fails as a 404 the first time a shopkeeper presses the
 * button. Nothing catches it: not the bundler, not a type checker, not a test
 * that stubs the server.
 *
 * It found one on the day it was written. The Parties screen had offered
 * "Delete party" since it shipped — a red confirmation dialog and everything —
 * against a DELETE route that was never registered. Anybody who tried to
 * remove a customer entered by mistake got "Cannot DELETE /api/parties/12".
 *
 *   node check-routes.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* `new URL(import.meta.url).pathname` gives "/C:/shop/desktop/frontend" on
   Windows — a leading slash before the drive letter — and every path built
   from it then fails to resolve. `fileURLToPath` is the one that knows about
   drive letters, and Windows is where start.bat runs. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BE = path.join(HERE, '..', 'backend');
const FE = path.join(HERE, 'src');

/* ── what the server serves ─────────────────────────────────────────────── */
const mounts = [];
const server = fs.readFileSync(path.join(BE, 'server.js'), 'utf8');
for (const m of server.matchAll(/app\.use\("(\/api[^"]*)",\s*require\("([^"]+)"\)(\.router)?\)/g)) {
  mounts.push({ base: m[1], file: m[2] });
}

const routes = [];

/* Routes hung directly on the app rather than on a mounted router — /api/health
   is one, and reading only the routers reported it missing for ever. */
for (const m of server.matchAll(/app\.(get|post|put|delete)\("(\/api[^"]*)"/g)) {
  routes.push({ method: m[1].toUpperCase(), path: m[2] });
}

for (const mt of mounts) {
  const f = path.join(BE, mt.file.replace(/^\.\//, '')) + '.js';
  if (!fs.existsSync(f)) { console.log(`?? mount ${mt.base} -> ${mt.file} (file not found)`); continue; }
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
    routes.push({ method: m[1].toUpperCase(), path: (mt.base + m[2]).replace(/\/$/, '') || mt.base });
  }
  /* Routes a module hands to a helper file: `require("./overview.routes").attach(router, …)`.
     Without following these, /api/sales/overview and half a dozen like it look
     unserved — which is a false alarm about a route that has existed since the
     screen above it did. */
  for (const m of src.matchAll(/require\("(\.\/[\w.]+)"\)\.attach\(/g)) {
    const hf = path.join(path.dirname(f), m[1]) + '.js';
    if (!fs.existsSync(hf)) continue;
    for (const h of fs.readFileSync(hf, 'utf8').matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
      routes.push({ method: h[1].toUpperCase(), path: (mt.base + h[2]).replace(/\/$/, '') || mt.base });
    }
  }

  /* Routes registered through a helper rather than literally. `masters(name,
     table)` in settings.routes.js registers GET and POST for each — read as
     literals they look missing, and six false alarms is how a checker gets
     ignored. */
  for (const m of src.matchAll(/^masters\("([^"]+)"/gm)) {
    routes.push({ method: 'GET', path: `${mt.base}/${m[1]}` });
    routes.push({ method: 'POST', path: `${mt.base}/${m[1]}` });
  }

  /* Some modules attach extra routes from a helper (pos/admin.routes). */
  for (const m of src.matchAll(/attach\(router/g)) {
    const helper = /require\("(\.\/[a-z.]*admin[a-z.]*)"\)/.exec(src);
    if (helper) {
      const hf = path.join(path.dirname(f), helper[1]) + '.js';
      if (fs.existsSync(hf)) {
        for (const h of fs.readFileSync(hf, 'utf8').matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
          routes.push({ method: h[1].toUpperCase(), path: (mt.base + h[2]).replace(/\/$/, '') || mt.base });
        }
      }
    }
  }
}

/* `X` is where a `${...}` stood. It matches any single segment, because what
   it held is not knowable here — `/system/cloud/${which}` is a real call to a
   real pair of routes. Being strict about it produced permanent false alarms,
   and a checker with permanent noise is one nobody reads. */
function matches(routePath, callPath) {
  const a = routePath.split('/').filter(Boolean);
  const b = callPath.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || b[i] === 'X' || seg === b[i]);
}

/* ── what the interface calls ───────────────────────────────────────────── */
const calls = new Map();
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(jsx|js)$/.test(e.name)) continue;
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/api\.(get|post|put|delete)\(\s*(["`])([^"`]*)/g)) {
      let call = m[3];
      if (!call.startsWith('/')) continue;
      /* A nested template — `/x${a ? `?${b}` : ""}` — cannot be read by a
         regex, and the half of it this catches is a prefix, not a path.
         Reported as missing it was a permanent false alarm on a route that
         exists, and a checker that cries wolf is one nobody reads. The
         literal head is still checked, by prefix, which is the part worth
         checking: a typo lives there, not in the interpolation. */
      const nested = call.includes('${') && !call.endsWith('}') ? call.slice(0, call.indexOf('${')) : null;
      if (nested !== null) {
        /* A query string is not part of the path, and the head of one is not
           part of anything. */
        const head = nested.split('?')[0].replace(/\/$/, '');
        const full = head.startsWith('/api') ? head : `/api${head}`;
        const ok = routes.some((r) => r.path === full || r.path.startsWith(`${full}/`));
        if (!ok) {
          const key = `PREFIX-${m[1].toUpperCase()} ${full}`;
          if (!calls.has(key)) calls.set(key, new Set());
          calls.get(key).add(path.relative(FE, p));
        }
        continue;
      }
      /* `${...}` becomes a wildcard segment; a query string is not part of the path. */
      call = call.split('?')[0].replace(/\$\{[^}]*\}/g, 'X').replace(/\/$/, '') || '/';
      const key = `${m[1].toUpperCase()} ${call}`;
      if (!calls.has(key)) calls.set(key, new Set());
      calls.get(key).add(path.relative(FE, p));
    }
    /* Raw fetch()es to /api, which bypass the client. */
    for (const m of src.matchAll(/fetch\(\s*[`"](\/api[^"`?]+)/g)) {
      /* A path that is entirely an interpolation — fetch(`/api${url}`) — says
         nothing that can be checked, so it is not reported as missing. */
      if (/\/api\$\{/.test(m[1])) continue;
      const call = m[1].replace(/\$\{[^}]*\}/g, 'X').replace(/\/$/, '');
      const key = `FETCH ${call}`;
      if (!calls.has(key)) calls.set(key, new Set());
      calls.get(key).add(path.relative(FE, p));
    }
  }
};
walk(FE);

let bad = 0;
for (const [key, where] of [...calls].sort()) {
  const [method, callPath] = key.split(' ');
  const full = callPath.startsWith('/api') ? callPath : `/api${callPath}`;
  /* A PREFIX entry has already been decided above; it is only in the map when
     it failed, so it is reported as-is. */
  if (method.startsWith('PREFIX-')) {
    bad++;
    console.log(`MISSING  ${method.slice(7).padEnd(6)} ${callPath}… (nothing is served under this)\n         called from ${[...where].join(', ')}`);
    continue;
  }
  const hit = routes.some((r) =>
    (method === 'FETCH' || r.method === method) && matches(r.path, full));
  if (!hit) { bad++; console.log(`MISSING  ${method.padEnd(6)} ${full}\n         called from ${[...where].join(', ')}`); }
}
console.log(`\n${routes.length} routes registered, ${calls.size} distinct calls, ${bad} with no server route`);
