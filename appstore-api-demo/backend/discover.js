// ---------------------------------------------------------------------------
// discover.js
// ---------------------------------------------------------------------------
// Lists the configured app targets (from apps.json / .env fallback) with their
// name and latest version state. Runs on server startup and standalone:
//   node discover.js
// ---------------------------------------------------------------------------

require("dotenv").config();

const targets = require("./targets");
const appstore = require("./appstore");

async function discoverAll() {
  const list = targets.all();
  if (list.length === 0) {
    console.log("[discover] No targets — add backend/apps.json or set ISSUER_ID/KEY_ID/APP_ID in .env.");
    return;
  }
  console.log(`[discover] ${list.length} app target(s):`);
  for (const t of list) {
    try {
      const app = await appstore.getApp(t);
      let latest = null;
      try {
        latest = await appstore.getLatestVersion(t);
      } catch (e) {
        // ignore per-app version failure
      }
      console.log(
        `  [${t.id}] ${app.name} (appId ${t.appId})` +
          (latest ? ` — v${latest.versionString} ${latest.state}` : "")
      );
    } catch (err) {
      const detail = err.response ? `Apple ${err.response.status}` : err.message;
      console.log(`  [${t.id}] ${t.name} (appId ${t.appId}) — error: ${detail}`);
    }
  }
}

if (require.main === module) {
  discoverAll().catch((err) => {
    console.error(`[discover] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { discoverAll };
