// ---------------------------------------------------------------------------
// statusStore.js
// ---------------------------------------------------------------------------
// Remembers, per target, the last seen version state, a full "signature"
// (state + version + sale status) and the date we first saw the current state.
//
// Apple exposes no "state changed at" timestamp, so we record it ourselves: the
// monitor calls track() each poll; when the observed state differs from the
// stored one (or it's a brand-new target) we stamp "since" with now. track()
// also reports whether the full signature changed — that's the signal the
// monitor uses to decide whether to send a Telegram message at all.
//
// The monitor is the ONLY writer (track). Request handlers read with peekSince()
// so their frequent polling never "consumes" a change before the monitor sees
// it. State persists to status-state.json and survives restarts. track() is
// synchronous, so there are no read-modify-write races.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "status-state.json");
let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error(`[status-store] save failed: ${e.message}`);
  }
}

/**
 * Monitor-only. Record `state`/`sig` for `targetId`. Returns:
 *   since    ISO date the target has been in this STATE since — stamped now on
 *            a state change, seeded with seedDateIso on the first sighting,
 *   changed  true if `sig` differs from the last recorded one (something worth
 *            notifying about), also true on the first sighting,
 *   isNew    true if this target had no prior record.
 */
function track(targetId, state, seedDateIso, sig, version) {
  const store = load();
  const prev = store[targetId];
  let since;
  let changed;
  if (!prev) {
    since = seedDateIso || new Date().toISOString();
    changed = true;
  } else {
    since = prev.state !== state ? new Date().toISOString() : prev.since;
    changed = prev.sig !== sig;
  }
  store[targetId] = {
    state,
    version: version || (prev && prev.version) || "",
    since,
    sig,
    lastPolledAt: new Date().toISOString(),
  };
  persist();
  return { since, changed, isNew: !prev };
}

/** Read-only: the "since" date for a target, or null if never tracked yet. */
function peekSince(targetId) {
  const rec = load()[targetId];
  return rec ? rec.since : null;
}

/** Read-only: the full stored record (state/version/since/sig/lastPolledAt). */
function getRecord(targetId) {
  const rec = load()[targetId];
  return rec ? { ...rec } : null;
}

/** Stamp lastPolledAt without touching state/sig — used when a poll couldn't
 * determine anything (error) but we still want to hold the cadence. */
function markPolled(targetId) {
  const store = load();
  const rec = store[targetId] || {};
  rec.lastPolledAt = new Date().toISOString();
  store[targetId] = rec;
  persist();
}

module.exports = { track, peekSince, getRecord, markPolled };
