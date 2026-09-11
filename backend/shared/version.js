/**
 * version.js — the one place that knows what is running.
 *
 * The version was being reported from four places that had drifted apart:
 * /api/health returned a hard-coded "1.0.0", /system/info and the updater both
 * read backend/package.json, and version.json carried a third answer. The
 * update screen and the About box can therefore each state a different
 * version, which is precisely the failure the blueprint warns about.
 *
 * version.json is authoritative for the release notes. The NUMBER comes from
 * package.json, because that is what electron-builder stamps into the
 * installer and what the release workflow checks the git tag against — with
 * the number kept in a second file as well, the two drifted, and a build
 * calling itself 1.42.0 shipped inside an installer called 1.43.0.
 *
 * Read once — it cannot change without a restart, and a per-request disk read
 * to answer "what am I" is waste.
 */
const path = require("path");

let cached = null;

function load() {
  if (cached) return cached;
  try {
    cached = { ...require(path.join(__dirname, "..", "version.json")) };
  } catch {
    /* Missing manifest is a packaging fault, not a reason to fail a request. */
    cached = { version: "0.0.0", released: null, notes: [] };
  }
  /* The number is whatever the installer will call itself. */
  try {
    const pkg = require(path.join(__dirname, "..", "..", "package.json"));
    if (pkg && pkg.version) cached.version = pkg.version;
  } catch { /* running from somewhere without the root package — keep the manifest's */ }
  if (!Array.isArray(cached.notes)) cached.notes = [];
  return cached;
}

module.exports = {
  version: () => load().version,
  released: () => load().released,
  notes: () => load().notes,
  manifest: () => ({ ...load() }),
};
