#!/usr/bin/env bash
# release.sh — clean build + integrity check + zip.
#
# Exists because a partial dist/ is indistinguishable from a good one at a
# glance, and the failure it causes lands on the user, not on us: the browser
# holds an index.html naming chunks the server no longer has, and pages die
# with "Failed to fetch dynamically imported module". Wipe, build, verify.

set -euo pipefail
cd "$(dirname "$0")"

# --since <previous-release.zip> also emits a delta update zip.
SINCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    *) echo "unknown argument: $1"; exit 1 ;;
  esac
done
ROOT="$PWD"
VERSION="$(node -p "require('./package.json').version")"

echo "▸ Releasing v${VERSION}"

# ── 1. Version agreement ──────────────────────────────────────────────
# Three files carry the version. If they disagree, the About box and the
# login screen lie about what is actually running.
for f in ./backend/version.json ./backend/package.json; do
  V="$(node -p "require('$f').version" 2>/dev/null || echo MISSING)"
  if [ "$V" != "$VERSION" ]; then
    echo "✖ version mismatch: package.json=${VERSION}  ${f}=${V}"
    exit 1
  fi
done

# ── 2. Backend syntax gate ────────────────────────────────────────────
echo "▸ Checking backend syntax"
find backend -name "*.js" -not -path "*/node_modules/*" -print0 \
  | xargs -0 -n1 node --check

# ── 3. Clean build ────────────────────────────────────────────────────
echo "▸ Wiping dist"
rm -rf frontend/dist

echo "▸ Building frontend"
cd frontend
npm install --no-audit --no-fund --silent
npm run build
cd "$ROOT"

# ── 4. Integrity check ────────────────────────────────────────────────
# Every chunk index.html references must exist on disk. This is the exact
# check that would have caught the stale-build failure before shipping.
echo "▸ Verifying build integrity"
node - <<'NODE'
const fs = require("fs"), path = require("path");
const dist = path.join(process.cwd(), "frontend", "dist");
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");

const referenced = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m => m[1]);
if (!referenced.length) { console.error("✖ index.html references no assets"); process.exit(1); }

let missing = 0;
for (const ref of referenced) {
  const file = path.join(dist, ref.replace(/^\//, ""));
  if (!fs.existsSync(file)) { console.error(`✖ missing: ${ref}`); missing++; }
}

const chunks = fs.readdirSync(path.join(dist, "assets")).filter(f => f.endsWith(".js"));
/* Only pages App.jsx loads lazily get their own chunk. Pages imported
   statically as tabs (Estimates, CreditNotes, Challans live inside Invoices)
   are correctly folded into their parent's chunk, so read the expectation
   off the source of truth rather than off the directory listing. */
const app = fs.readFileSync(path.join(process.cwd(), "frontend", "src", "App.jsx"), "utf8");
const pages = [...app.matchAll(/import\(\s*["']\.\/pages\/([A-Za-z0-9_]+)\.jsx["']\s*\)/g)].map(m => m[1]);
if (!pages.length) { console.error("✖ found no lazy page imports in App.jsx"); process.exit(1); }
for (const name of pages) {
  if (!chunks.some(c => c.startsWith(name + "-"))) {
    console.error(`✖ no chunk emitted for lazy page: ${name}`);
    missing++;
  }
}

if (missing) { console.error(`✖ ${missing} problem(s) — not packaging`); process.exit(1); }
console.log(`✓ ${referenced.length} referenced asset(s) present, ${pages.length} page chunks emitted`);
NODE

# ── 5. Package ────────────────────────────────────────────────────────
STAGE="$(mktemp -d)"
PKG="${STAGE}/genius-pos"
echo "▸ Staging"
mkdir -p "$PKG"
# Dotfiles are listed explicitly: globs like *.md never match .env.example or
# .gitignore, so an earlier version of this script silently shipped a setup zip
# without the config template a fresh install needs.
DOTFILES=""
for d in .env.example .gitignore .npmrc; do [ -e "$d" ] && DOTFILES="$DOTFILES $d"; done

# backend/data holds the live database; it is created on first run and must
# never travel inside a release.
tar -c --exclude=node_modules --exclude='*.db' --exclude='*.db-journal' \
       --exclude='*.db-wal' --exclude='*.db-shm' --exclude=.git \
       --exclude='backend/data' --exclude='updates' \
       backend frontend electron package.json render.yaml *.md *.txt *.bat release.sh $DOTFILES \
  | tar -x -C "$PKG"

SETUP="${ROOT}/genius-pos-setup-v${VERSION//./_}.zip"
rm -f "$SETUP"
( cd "$STAGE" && zip -qr "$SETUP" genius-pos )

# ── 5b. Delta update zip ──────────────────────────────────────────────
# A full setup zip is the wrong thing to hand someone who already has the app:
# it is large, and it rewrites hundreds of files that did not change, so every
# one of them is a chance to break something. `--since <previous.zip>` emits a
# second archive holding only what actually differs.
#
# backend/package.json and backend/version.json are always included: the
# updater reads the target version out of package.json and refuses any zip
# without it, so a delta that happened not to touch it would be rejected.
UPDATE=""
if [ -n "${SINCE:-}" ]; then
  if [ ! -f "$SINCE" ]; then echo "✖ --since file not found: $SINCE"; exit 1; fi
  echo "▸ Diffing against $(basename "$SINCE")"
  PREV="$(mktemp -d)"
  unzip -qo "$SINCE" -d "$PREV"
  PREV_ROOT="$(find "$PREV" -maxdepth 2 -type d -name backend | head -1 | xargs dirname)"
  DELTA="$(mktemp -d)"

  node - "$PKG" "$PREV_ROOT" "$DELTA/genius-pos" <<'NODE'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [neu, old, out] = process.argv.slice(2);
const ALWAYS = ["backend/package.json", "backend/version.json"];

const hash = (p) => crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");
const walk = (dir, base = dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(full, base, acc); }
    else acc.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return acc;
};

let changed = 0, added = 0;
for (const rel of walk(neu)) {
  const a = path.join(neu, rel), b = path.join(old, rel);
  const isNew = !fs.existsSync(b);
  const differs = isNew || hash(a) !== hash(b);
  if (!differs && !ALWAYS.includes(rel)) continue;
  if (isNew) added++; else if (differs) changed++;
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(a, dest);
}
console.log(`  ${changed} changed, ${added} new`);
NODE

  UPDATE="${ROOT}/genius-pos-update-v${VERSION//./_}.zip"
  rm -f "$UPDATE"
  ( cd "$DELTA" && zip -qr "$UPDATE" genius-pos )
  rm -rf "$PREV" "$DELTA"
fi

rm -rf "$STAGE"

# ── 6. Final assertions on the artefacts ──────────────────────────────
# Listed once into a variable: `unzip -l | grep -q` makes grep exit on the
# first match, which SIGPIPEs unzip, which under `set -o pipefail` fails the
# whole pipeline and reports a perfectly good zip as broken.
LISTING="$(unzip -l "$SETUP")"
case "$LISTING" in
  *frontend/dist/index.html*) ;;
  *) echo "✖ setup zip has no built frontend"; exit 1 ;;
esac
case "$LISTING" in
  *node_modules*) echo "✖ setup zip contains node_modules"; exit 1 ;;
esac
for want in .env.example package.json backend/version.json; do
  case "$LISTING" in
    *"$want"*) ;;
    *) echo "✖ setup zip is missing $want"; exit 1 ;;
  esac
done
echo "✓ ${SETUP}"
echo "  $(printf '%s\n' "$LISTING" | tail -1)"

if [ -n "$UPDATE" ]; then
  ULIST="$(unzip -l "$UPDATE")"
  # The updater rejects any zip without this file, so fail here rather than
  # letting the customer discover it.
  case "$ULIST" in
    *backend/package.json*) ;;
    *) echo "✖ update zip lacks backend/package.json — the updater would reject it"; exit 1 ;;
  esac
  echo "✓ ${UPDATE}"
  echo "  $(printf '%s\n' "$ULIST" | tail -1)"
fi
