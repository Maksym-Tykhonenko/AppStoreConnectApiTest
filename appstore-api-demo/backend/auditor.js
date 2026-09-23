// ---------------------------------------------------------------------------
// auditor.js
// ---------------------------------------------------------------------------
// Change auditor for an App Store Connect account. It snapshots the auditable
// state of one target (app metadata, versions + localizations, App Info, review
// details, sale status, Game Center footprint, IAP / subscriptions, and the
// account's users) into a flat key -> value map, and diffs it against the last
// snapshot to report exactly WHAT changed since you last looked.
//
// Note: this records WHAT changed, not "who browsed which page" — App Store
// Connect exposes no per-user browsing/activity log (see audit.js header).
//
// Used selectively/manually via audit.js — it is NOT part of the live monitor.
// ---------------------------------------------------------------------------

const appstore = require("./appstore");
const gameCenter = require("./gameCenter");

// Strict GET — throws on any error. A snapshot must be all-or-nothing: if any
// section fails (e.g. a transient proxy hiccup), we abort the whole snapshot
// rather than save a partial one, which would diff as bogus removals next time.
async function raw(target, url, params) {
  return appstore.authedRequest(target, { method: "get", url, params });
}

/**
 * Flat snapshot of a target's auditable state: { key: stringValue }.
 * Missing/empty values are omitted so they surface cleanly as add/remove diffs.
 */
async function buildSnapshot(target) {
  const flat = {};
  const put = (k, v) => {
    if (v !== undefined && v !== null && v !== "") flat[k] = String(v);
  };

  // --- App core attributes -------------------------------------------------
  const app = await appstore.getApp(target);
  put("app.name", app.name);
  put("app.bundleId", app.bundleId);
  put("app.sku", app.sku);
  put("app.primaryLocale", app.primaryLocale);

  // --- Versions + localizations + review detail ----------------------------
  const versions = await appstore.listAppStoreVersions(target);
  for (const v of versions) {
    put(`version[${v.versionString}].state`, v.state);
    try {
      const locs = await appstore.getVersionLocalizationsById(target, v.id);
      for (const l of locs) {
        const a = l.attributes || {};
        const p = `version[${v.versionString}].loc[${l.locale}]`;
        put(`${p}.promotionalText`, a.promotionalText);
        put(`${p}.keywords`, a.keywords);
        put(`${p}.whatsNew`, a.whatsNew);
        put(`${p}.description`, a.description);
        put(`${p}.marketingUrl`, a.marketingUrl);
        put(`${p}.supportUrl`, a.supportUrl);
      }
    } catch (e) {}
    const rd = await raw(target, `/v1/appStoreVersions/${v.id}/appStoreReviewDetail`);
    const ra = (rd && rd.data && rd.data.attributes) || {};
    const rp = `version[${v.versionString}].review`;
    put(`${rp}.contactEmail`, ra.contactEmail);
    put(`${rp}.demoAccountName`, ra.demoAccountName);
    put(`${rp}.demoAccountRequired`, ra.demoAccountRequired);
    put(`${rp}.notes`, ra.notes);
  }

  // --- App Info localizations (name / subtitle / privacy) ------------------
  const infos = await raw(target, `/v1/apps/${target.appId}/appInfos`, { limit: 20 });
  for (const ai of (infos && infos.data ? infos.data : [])) {
    const locs = await raw(target, `/v1/appInfos/${ai.id}/appInfoLocalizations`, { limit: 200 });
    for (const l of (locs && locs.data ? locs.data : [])) {
      const a = l.attributes || {};
      const p = `appInfo[${a.locale}]`;
      put(`${p}.name`, a.name);
      put(`${p}.subtitle`, a.subtitle);
      put(`${p}.privacyPolicyUrl`, a.privacyPolicyUrl);
    }
  }

  // --- Sale status ---------------------------------------------------------
  try {
    const sale = await appstore.getSaleStatus(target);
    put("sale.forSale", sale.forSale);
  } catch (e) {}

  // --- Game Center footprint (keyword-injection surface) -------------------
  const fp = await gameCenter.getFootprint(target);
  if (fp.error) {
    // Couldn't read GC reliably — abort so we don't record a false change.
    throw new Error(`Game Center read failed: ${fp.error}`);
  }
  put("gc.enabled", fp.enabled);
  (fp.groups || []).forEach((g) => put(`gc.group[${g}]`, "present"));
  (fp.leaderboards || []).forEach((o) =>
    put(`gc.leaderboard[${o.ref}]`, o.names.join(" / ") || "(no name)"),
  );
  (fp.achievements || []).forEach((o) =>
    put(`gc.achievement[${o.ref}]`, o.names.join(" / ") || "(no name)"),
  );

  // --- In-app purchases ----------------------------------------------------
  const iap = await raw(target, `/v1/apps/${target.appId}/inAppPurchasesV2`, { limit: 200 });
  for (const p of (iap && iap.data ? iap.data : [])) {
    const a = p.attributes || {};
    put(`iap[${a.productId || p.id}].name`, a.name);
    put(`iap[${a.productId || p.id}].state`, a.state);
  }

  // --- Subscriptions -------------------------------------------------------
  const sgs = await raw(target, `/v1/apps/${target.appId}/subscriptionGroups`, { limit: 200 });
  for (const g of (sgs && sgs.data ? sgs.data : [])) {
    const subs = await raw(target, `/v1/subscriptionGroups/${g.id}/subscriptions`, { limit: 200 });
    for (const s of (subs && subs.data ? subs.data : [])) {
      const a = s.attributes || {};
      put(`sub[${a.productId || s.id}].name`, a.name);
      put(`sub[${a.productId || s.id}].state`, a.state);
    }
  }

  // --- Account users (access changes) --------------------------------------
  const users = await raw(target, `/v1/users`, { limit: 200 });
  for (const u of (users && users.data ? users.data : [])) {
    const a = u.attributes || {};
    put(`user[${a.username}]`, (a.roles || []).join("+") || "user");
  }

  return flat;
}

// Diff two flat snapshots -> [{ t:'+'|'-'|'~', k, from?, to? }] sorted by key.
function diff(oldFlat, newFlat) {
  const o = oldFlat || {};
  const n = newFlat || {};
  const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])].sort();
  const changes = [];
  for (const k of keys) {
    const a = o[k];
    const b = n[k];
    if (a === undefined && b !== undefined) changes.push({ t: "+", k, to: b });
    else if (a !== undefined && b === undefined) changes.push({ t: "-", k, from: a });
    else if (a !== b) changes.push({ t: "~", k, from: a, to: b });
  }
  return changes;
}

module.exports = { buildSnapshot, diff };
