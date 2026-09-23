// ---------------------------------------------------------------------------
// gameCenter.js
// ---------------------------------------------------------------------------
// Detects the black-hat ASO trick where someone injects keywords into an app's
// App-Store-indexed Game Center metadata (leaderboard / achievement localized
// titles) to make it rank for keywords that aren't in the visible listing.
//
// What we can read via the public API is the LIVE (published) footprint:
//   * whether Game Center is enabled,
//   * the account's Game Center groups (these linger as a trace long after the
//     keyword objects are deleted — the durable fingerprint),
//   * live leaderboards / achievements + their localized names (the keywords
//     themselves, IF they're currently published).
//
// Draft submissions ("Draft Submissions (N)" in the web UI) are NOT exposed by
// Apple's public API, so a scheme that stays purely in drafts can't be read
// here — only its leftover empty group is visible. See getFootprint()'s caveat.
// ---------------------------------------------------------------------------

const { authedRequest } = require("./appstore");

// Strict GET — throws on any error. We deliberately do NOT swallow errors here:
// a transient proxy/network hiccup must fail the whole footprint (returned as
// { error }) rather than masquerade as "Game Center empty / disabled", which
// would look like a real change and raise a false alarm.
async function get(target, url, params) {
  return authedRequest(target, { method: "get", url, params });
}

// Localized names of one leaderboard/achievement (the actual indexed strings).
async function localizedNames(target, kind, id) {
  const rel = kind === "lb" ? "gameCenterLeaderboards" : "gameCenterAchievements";
  const d = await get(target, `/v1/${rel}/${id}/localizations`, { limit: 200 });
  return (d && d.data ? d.data : [])
    .map((x) => (x.attributes || {}).name)
    .filter(Boolean);
}

// Pull leaderboards/achievements from a list endpoint into a Map(id -> object).
async function collectInto(target, url, map, kind) {
  const d = await get(target, url, { limit: 200 });
  for (const it of (d && d.data ? d.data : [])) {
    if (map.has(it.id)) continue;
    map.set(it.id, {
      id: it.id,
      ref: (it.attributes || {}).referenceName || "",
      vendor: (it.attributes || {}).vendorIdentifier || "",
      kind,
    });
  }
}

/**
 * The current LIVE Game Center footprint for one target. Returns
 *   { enabled, groups:[refName], leaderboards:[{ref,names}], achievements:[...] }
 * on success, or { error } if we couldn't read it reliably (transient failure).
 * A genuine "Game Center not set up" is a 404 on the detail -> { enabled:false }.
 */
async function getFootprint(target) {
  // Enabled? A 404 means genuinely not set up; any other failure is unknown.
  let detResp;
  try {
    detResp = await get(target, `/v1/apps/${target.appId}/gameCenterDetail`);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      return { enabled: false, groups: [], leaderboards: [], achievements: [] };
    }
    return { error: e.response ? `Apple ${e.response.status}` : e.message };
  }

  // From here on, any read failure invalidates the whole footprint (-> error),
  // so we never emit a partial one that would diff as a false change.
  try {
    const detId = detResp && detResp.data && detResp.data.id;
    if (!detId) {
      return { enabled: false, groups: [], leaderboards: [], achievements: [] };
    }

    const grpResp = await get(target, `/v1/gameCenterGroups`, { limit: 200 });
    const groupObjs = (grpResp && grpResp.data ? grpResp.data : []).map((g) => ({
      id: g.id,
      ref: (g.attributes || {}).referenceName || g.id,
    }));
    const groups = groupObjs.map((g) => g.ref).sort();

    const lbMap = new Map();
    const achMap = new Map();
    await collectInto(target, `/v1/gameCenterDetails/${detId}/gameCenterLeaderboards`, lbMap, "lb");
    await collectInto(target, `/v1/gameCenterDetails/${detId}/gameCenterAchievements`, achMap, "ach");
    for (const g of groupObjs) {
      await collectInto(target, `/v1/gameCenterGroups/${g.id}/gameCenterLeaderboards`, lbMap, "lb");
      await collectInto(target, `/v1/gameCenterGroups/${g.id}/gameCenterAchievements`, achMap, "ach");
    }

    const leaderboards = [];
    for (const o of lbMap.values()) {
      leaderboards.push({ ref: o.ref, vendor: o.vendor, names: await localizedNames(target, "lb", o.id) });
    }
    const achievements = [];
    for (const o of achMap.values()) {
      achievements.push({ ref: o.ref, vendor: o.vendor, names: await localizedNames(target, "ach", o.id) });
    }

    return { enabled: true, groups, leaderboards, achievements };
  } catch (e) {
    return { error: e.response ? `Apple ${e.response.status}` : e.message };
  }
}

// A stable signature of the footprint; any change flags a manipulation event.
function signature(fp) {
  if (!fp || fp.error) return null; // unknown -> carry previous forward
  const lb = fp.leaderboards
    .map((x) => `${x.ref}[${x.names.join("/")}]`)
    .sort()
    .join(",");
  const ach = fp.achievements
    .map((x) => `${x.ref}[${x.names.join("/")}]`)
    .sort()
    .join(",");
  return `gc:${fp.enabled ? 1 : 0}|grp:${fp.groups.join("+")}|lb:${lb}|ach:${ach}`;
}

module.exports = { getFootprint, signature };
