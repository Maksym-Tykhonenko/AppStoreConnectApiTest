// ---------------------------------------------------------------------------
// targets.js
// ---------------------------------------------------------------------------
// The app targets this backend can work with. Each target is ONE app together
// with the developer-account credentials that reach it — because different apps
// live in different accounts.
//
// Configure them in backend/apps.json (array):
//   [
//     {
//       "name": "My Game",
//       "issuerId": "....",
//       "keyId": "ABC123DEFG",
//       "privateKeyPath": "./AuthKey_ABC123DEFG.p8",
//       "appId": "6776552645",
//       "proxyUrl": "",            // optional; else falls back to .env PROXY_URL
//       "screenshotsDir": "./screenshots"  // optional; else .env SCREENSHOTS_DIR
//     }
//   ]
//
// If apps.json is missing/empty, we fall back to a single target built from the
// old flat .env vars (ISSUER_ID / KEY_ID / PRIVATE_KEY_PATH / APP_ID) so
// existing setups keep working.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const APPS_FILE = path.resolve(__dirname, "apps.json");

function loadRaw() {
  if (fs.existsSync(APPS_FILE)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(APPS_FILE, "utf8"));
    } catch (e) {
      throw new Error(`apps.json is not valid JSON: ${e.message}`);
    }
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  }

  // Fallback: single target from .env.
  if (process.env.ISSUER_ID && process.env.KEY_ID) {
    return [
      {
        name: process.env.APP_ID ? `App ${process.env.APP_ID}` : "Default (.env)",
        issuerId: process.env.ISSUER_ID,
        keyId: process.env.KEY_ID,
        privateKeyPath: process.env.PRIVATE_KEY_PATH,
        appId: process.env.APP_ID,
      },
    ];
  }
  return [];
}

// Normalize + assign an id (index) + fill defaults from .env globals.
function normalize(list) {
  return list.map((t, i) => ({
    id: String(i),
    name: t.name || `App ${i + 1}`,
    issuerId: t.issuerId,
    keyId: t.keyId,
    privateKeyPath: t.privateKeyPath,
    appId: t.appId,
    proxyUrl: t.proxyUrl || process.env.PROXY_URL || "",
    screenshotsDir: t.screenshotsDir || process.env.SCREENSHOTS_DIR || "",
    // "Grey" apps are hands-off: polled once a day just for liveness. Default
    // false — poll every interval and report the whole group on any change.
    isGrey: !!t.isGrey,
    // Free-form Jira reference (e.g. a ticket number) shown in Telegram reports.
    jira: t.Jira || t.jira || "",
    // Base folder for A/B-test screenshots. Inside it, one subfolder per variant
    // named A / B / C (matched to "Treatment A/B/C" by the variant's last letter).
    screenshotsDirForAb: t.screenshotsDirForAb || "",
    // Per-app exception: suppress the "🚫 Removed from the App Store" line/alert
    // for this app (e.g. casino apps flagged CANNOT_SELL for known reasons).
    ignoreRemoved: !!t.ignoreRemoved,
    // Per-app exception: always show "🆕 Not published yet (first release)"
    // instead of "🚫 Removed" and never treat the app as removed — for a first
    // release whose version number isn't 1.0 / 1.0.0 (e.g. v1.1).
    notPublishedYet: !!t.notPublishedYet,
  }));
}

let cached = null;
function all() {
  if (!cached) cached = normalize(loadRaw());
  return cached;
}

// Public list (no secrets) for the app picker.
function list() {
  return all().map((t) => ({ id: t.id, name: t.name, appId: t.appId }));
}

// Full target (with credentials) by id — throws if unknown.
function get(id) {
  const t = all().find((x) => x.id === String(id));
  if (!t) throw new Error(`Unknown target id: ${id}`);
  return t;
}

module.exports = { all, list, get };
