// ---------------------------------------------------------------------------
// audit.js  —  manual, selective change auditor
// ---------------------------------------------------------------------------
// Snapshots the auditable state of the app target(s) you name, diffs it against
// the previous snapshot, and appends every change to audit.log. Run it whenever
// you want to see what changed in an account since you last checked — e.g.
// before and after you give someone access.
//
// IMPORTANT: this shows WHAT changed, not "which pages someone browsed" — App
// Store Connect provides no per-user browsing/activity log (Apple limitation).
// API-created objects do carry the API key id (e.g. "Started by API user ...")
// visible in the web UI, but that attribution isn't exposed for most changes.
//
// Usage:
//   node audit.js <id|name>       audit one target (by id "2" or name substring)
//   node audit.js all             audit every target
//
// First run for a target just captures a baseline (no diffs yet). Each later run
// reports what changed since the previous run and updates the baseline.
//
// State:  audit-snapshots/<id>.json   (last snapshot per target)
// Log:    audit.log                   (append-only human-readable change log)
// ---------------------------------------------------------------------------

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const targets = require("./targets");
const { buildSnapshot, diff } = require("./auditor");

const SNAP_DIR = path.join(__dirname, "audit-snapshots");
const LOG_FILE = path.join(__dirname, "audit.log");

function trunc(v, n = 100) {
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function resolveTargets(arg) {
  const all = targets.all();
  if (arg === "all") return all;
  // by exact id first, then case-insensitive name substring
  const byId = all.find((t) => t.id === arg);
  if (byId) return [byId];
  const byName = all.filter((t) => t.name.toLowerCase().includes(arg.toLowerCase()));
  return byName;
}

function loadSnap(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SNAP_DIR, `${id}.json`), "utf8"));
  } catch (e) {
    return null;
  }
}

function saveSnap(id, flat) {
  if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(path.join(SNAP_DIR, `${id}.json`), JSON.stringify(flat, null, 2));
}

function appendLog(lines) {
  fs.appendFileSync(LOG_FILE, lines.join("\n") + "\n");
}

async function auditOne(t, stamp) {
  process.stdout.write(`\n[${t.id}] ${t.name} — snapshotting... `);
  let now;
  try {
    now = await buildSnapshot(t);
  } catch (e) {
    console.log(`FAILED (${e.response ? "Apple " + e.response.status : e.message})`);
    appendLog([`=== ${stamp} | [${t.id}] ${t.name} ===`, `  ! snapshot failed: ${e.message}`, ""]);
    return;
  }
  const prev = loadSnap(t.id);
  const header = `=== ${stamp} | [${t.id}] ${t.name} ===`;

  if (!prev) {
    console.log(`baseline captured (${Object.keys(now).length} fields).`);
    appendLog([header, `  baseline captured — ${Object.keys(now).length} fields tracked`, ""]);
    saveSnap(t.id, now);
    return;
  }

  const changes = diff(prev, now);
  if (changes.length === 0) {
    console.log("no changes.");
    appendLog([header, "  no changes", ""]);
    saveSnap(t.id, now);
    return;
  }

  console.log(`${changes.length} change(s):`);
  const lines = [header];
  for (const c of changes) {
    let line;
    if (c.t === "+") line = `  + ${c.k} = "${trunc(c.to)}"`;
    else if (c.t === "-") line = `  - ${c.k}  (was "${trunc(c.from)}")`;
    else line = `  ~ ${c.k}: "${trunc(c.from)}" -> "${trunc(c.to)}"`;
    console.log(line);
    lines.push(line);
  }
  lines.push("");
  appendLog(lines);
  saveSnap(t.id, now);
}

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.log("Usage: node audit.js <id|name|all>");
    console.log("Targets:");
    targets.list().forEach((t) => console.log(`  [${t.id}] ${t.name} (${t.appId})`));
    process.exit(1);
  }
  const list = resolveTargets(arg);
  if (list.length === 0) {
    console.log(`No target matches "${arg}". Run: node audit.js  (to list targets)`);
    process.exit(1);
  }
  const stamp = new Date().toISOString();
  for (const t of list) await auditOne(t, stamp);
  console.log(`\nLogged to ${LOG_FILE}`);
})().catch((e) => {
  console.error("Audit error:", e.message);
  process.exit(1);
});
